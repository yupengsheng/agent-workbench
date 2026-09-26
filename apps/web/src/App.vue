<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type {
  AgentListResponse,
  AuthResponse,
  ModelConnectionListResponse,
  RunEventSummary,
  SessionSummary,
  WorkspaceListResponse,
} from '@agent-workbench/contracts';
import {
  getAgents,
  getCurrentUser,
  getHealth,
  getModelConnections,
  getWorkspaces,
  login,
  logout,
  getSessions,
} from './lib/api';
import ModelConnectionsPanel from './features/admin/ModelConnectionsPanel.vue';
import ModelInvocationLogsPanel from './features/admin/ModelInvocationLogsPanel.vue';
import AuditRecordsPanel from './features/admin/AuditRecordsPanel.vue';
import ChatPanel from './features/user/ChatPanel.vue';
import WorkbenchShell from './features/layout/WorkbenchShell.vue';
import RunInspector from './features/layout/RunInspector.vue';

type Route = 'user' | 'admin';
type LoadState = 'loading' | 'ready' | 'error';

const route = ref<Route>(window.location.pathname.startsWith('/admin') ? 'admin' : 'user');
const healthState = ref<'checking' | 'connected' | 'unavailable'>('checking');
const healthDetail = ref('正在检查服务连接');
const authState = ref<LoadState>('loading');
const authError = ref('');
const currentUser = ref<AuthResponse['user']>();
const workspaces = ref<WorkspaceListResponse['workspaces']>([]);
const selectedWorkspaceId = ref('');
const models = ref<ModelConnectionListResponse['connections']>([]);
const agents = ref<AgentListResponse['agents']>([]);
const sessions = ref<SessionSummary[]>([]);
const selectedSessionId = ref('');
const dataError = ref('');
const account = ref('');
const password = ref('');
const loginPending = ref(false);
const logoutPending = ref(false);
const chatResetKey = ref(0);
const auditRefreshKey = ref(0);
const inspector = ref({
  pending: false,
  runState: '',
  activeRunId: '',
  resolvedModelId: '',
  selectedModelId: '__jev__',
  events: [] as RunEventSummary[],
  error: '',
});

const selectedWorkspace = computed(() =>
  workspaces.value.find((workspace) => workspace.id === selectedWorkspaceId.value),
);

async function refreshHealth() {
  healthState.value = 'checking';
  healthDetail.value = '正在检查服务连接';
  try {
    const health = await getHealth();
    healthState.value = 'connected';
    healthDetail.value = `API ${health.apiVersion} · 连接正常`;
  } catch (error) {
    healthState.value = 'unavailable';
    healthDetail.value = error instanceof Error ? error.message : '服务暂时不可用';
  }
}

async function loadWorkspaceData(workspaceId: string) {
  if (!workspaceId) return;
  dataError.value = '';
  try {
    const [modelResponse, agentResponse] = await Promise.all([
      getModelConnections(workspaceId),
      getAgents(workspaceId),
    ]);
    models.value = modelResponse.connections;
    agents.value = agentResponse.agents;
  } catch (error) {
    dataError.value = error instanceof Error ? error.message : '工作空间数据加载失败';
  }
  try {
    const sessionResponse = await getSessions(workspaceId);
    sessions.value = sessionResponse.sessions;
    const stored = window.sessionStorage.getItem(`agent-workbench:session:${workspaceId}`);
    selectedSessionId.value =
      sessions.value.find((session) => session.id === stored)?.id ?? sessions.value[0]?.id ?? '';
  } catch {
    // Older API fixtures and installations may not expose the optional session index yet.
    // ChatPanel still restores the current session from workspace-scoped sessionStorage.
    sessions.value = [];
    selectedSessionId.value = '';
  }
}

function restoreWorkspaceSelection() {
  const saved = window.sessionStorage.getItem(`agent-workbench:workspace:${currentUser.value?.id}`);
  selectedWorkspaceId.value =
    workspaces.value.find((workspace) => workspace.id === saved)?.id ??
    workspaces.value[0]?.id ??
    '';
}

async function loadAuthenticatedState() {
  authState.value = 'loading';
  authError.value = '';
  try {
    const response = await getCurrentUser();
    currentUser.value = response.user;
    const workspaceResponse = await getWorkspaces();
    workspaces.value = workspaceResponse.workspaces;
    restoreWorkspaceSelection();
    authState.value = 'ready';
    await loadWorkspaceData(selectedWorkspaceId.value);
  } catch (error) {
    const status =
      error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    authState.value = 'error';
    authError.value =
      status === 401 ? '' : error instanceof Error ? error.message : '身份状态加载失败';
  }
}

async function submitLogin() {
  loginPending.value = true;
  authError.value = '';
  try {
    const response = await login(account.value, password.value);
    currentUser.value = response.user;
    const workspaceResponse = await getWorkspaces();
    workspaces.value = workspaceResponse.workspaces;
    restoreWorkspaceSelection();
    password.value = '';
    authState.value = 'ready';
    await loadWorkspaceData(selectedWorkspaceId.value);
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '登录失败';
  } finally {
    loginPending.value = false;
  }
}

async function submitLogout() {
  logoutPending.value = true;
  try {
    await logout();
    currentUser.value = undefined;
    workspaces.value = [];
    models.value = [];
    agents.value = [];
    sessions.value = [];
    selectedSessionId.value = '';
    authState.value = 'error';
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '退出失败';
  } finally {
    logoutPending.value = false;
  }
}

function setRoute(nextRoute: Route) {
  route.value = nextRoute;
  window.history.pushState({}, '', nextRoute === 'admin' ? '/admin' : '/app');
}

function startNewSession() {
  if (selectedWorkspaceId.value) {
    window.sessionStorage.removeItem(`agent-workbench:session:${selectedWorkspaceId.value}`);
  }
  selectedSessionId.value = '';
  chatResetKey.value += 1;
  inspector.value = {
    pending: false,
    runState: '',
    activeRunId: '',
    resolvedModelId: '',
    selectedModelId: '__jev__',
    events: [],
    error: '',
  };
}

function updateInspector(state: typeof inspector.value) {
  inspector.value = state;
}

async function selectSession(sessionId: string) {
  if (!sessionId || sessionId === selectedSessionId.value) return;
  selectedSessionId.value = sessionId;
  window.sessionStorage.setItem(`agent-workbench:session:${selectedWorkspaceId.value}`, sessionId);
  chatResetKey.value += 1;
}

async function refreshSessions(sessionId?: string) {
  if (!selectedWorkspaceId.value) return;
  try {
    const response = await getSessions(selectedWorkspaceId.value);
    sessions.value = response.sessions;
    const nextId = sessionId ?? selectedSessionId.value;
    selectedSessionId.value = sessions.value.some((session) => session.id === nextId)
      ? nextId
      : (sessions.value[0]?.id ?? '');
  } catch {
    // Keep the active chat usable when the session index is temporarily unavailable.
  }
}

async function refreshAdminData() {
  await loadWorkspaceData(selectedWorkspaceId.value);
  auditRefreshKey.value += 1;
}

async function selectWorkspace(workspaceId = selectedWorkspaceId.value) {
  selectedWorkspaceId.value = workspaceId;
  window.sessionStorage.setItem(
    `agent-workbench:workspace:${currentUser.value?.id}`,
    selectedWorkspaceId.value,
  );
  await loadWorkspaceData(selectedWorkspaceId.value);
}

onMounted(async () => {
  window.addEventListener('popstate', () => {
    route.value = window.location.pathname.startsWith('/admin') ? 'admin' : 'user';
  });
  await Promise.all([refreshHealth(), loadAuthenticatedState()]);
});
</script>

<template>
  <div class="app-shell">
    <header v-if="authState !== 'ready'" class="topbar">
      <a class="brand" href="/app" aria-label="Agent Workbench 用户工作台"
        ><span class="brand-mark" aria-hidden="true">A</span
        ><span>Agent Workbench<small>私有化 Agent 工作台</small></span></a
      >
      <nav class="surface-nav" aria-label="入口切换">
        <button :class="{ active: route === 'user' }" @click="setRoute('user')">用户工作台</button
        ><button :class="{ active: route === 'admin' }" @click="setRoute('admin')">
          管理员控制台
        </button>
      </nav>
      <div class="topbar-actions">
        <span class="environment"
          ><span class="status-dot" :class="healthState" aria-hidden="true"></span
          >{{ healthDetail }}</span
        ><button
          v-if="currentUser"
          class="quiet-button"
          :disabled="logoutPending"
          @click="submitLogout"
        >
          退出
        </button>
      </div>
    </header>

    <main class="page-shell">
      <section v-if="authState !== 'ready'" class="auth-layout">
        <div class="hero-copy">
          <p class="eyebrow">PRIVATE AGENT WORKSPACE</p>
          <h1>让 Agent 在你的环境里工作。</h1>
          <p>
            用户工作台负责任务与产物，管理员控制台负责配置与治理，飞书等通道负责把受控任务带到协作场景。
          </p>
          <div class="surface-list">
            <span>01 · 用户工作台</span><span>02 · 管理员控制台</span><span>03 · 第三方通道</span>
          </div>
        </div>
        <form class="login-card" novalidate @submit.prevent="submitLogin">
          <p class="eyebrow">SECURE SIGN IN</p>
          <h2>登录工作台</h2>
          <p class="muted">
            使用本地账号进入 {{ route === 'admin' ? '管理员控制台' : '用户工作台' }}。
          </p>
          <label
            >账号<input
              v-model="account"
              type="text"
              name="account"
              autocomplete="username"
              required
              placeholder="admin 或 you@example.com" /></label
          ><label
            >密码<input
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              minlength="1"
          /></label>
          <p v-if="authError" class="form-error" role="alert">{{ authError }}</p>
          <button class="primary-button" type="submit" :disabled="loginPending">
            {{ loginPending ? '登录中…' : '登录' }}
          </button>
          <p class="form-hint">管理员账号由部署命令创建；生产环境请使用强密码。</p>
        </form>
      </section>

      <WorkbenchShell
        v-else
        :route="route"
        :current-user="currentUser"
        :workspaces="workspaces"
        :selected-workspace-id="selectedWorkspaceId"
        :selected-workspace="selectedWorkspace"
        :sessions="sessions"
        :active-session-id="selectedSessionId"
        :health-state="healthState"
        :health-detail="healthDetail"
        @navigate="setRoute"
        @logout="submitLogout"
        @workspace-change="selectWorkspace"
        @select-session="selectSession"
        @new-session="startNewSession"
      >
        <p v-if="dataError" class="form-error mao-page-error" role="alert">{{ dataError }}</p>
        <template v-if="route === 'admin'">
          <div class="mao-stat-strip">
            <article>
              <span>模型连接</span><strong>{{ models.length }}</strong
              ><small>服务端安全引用</small>
            </article>
            <article>
              <span>Agent</span><strong>{{ agents.length }}</strong
              ><small>可发布的工作流</small>
            </article>
            <article><span>通道</span><strong>0</strong><small>飞书适配器规划中</small></article>
          </div>
          <ModelConnectionsPanel
            :workspace-id="selectedWorkspaceId"
            :models="models"
            :can-manage="selectedWorkspace?.role === 'owner' || selectedWorkspace?.role === 'admin'"
            @changed="refreshAdminData"
          />
          <ModelInvocationLogsPanel
            :workspace-id="selectedWorkspaceId"
            :can-manage="selectedWorkspace?.role === 'owner' || selectedWorkspace?.role === 'admin'"
            :refresh-key="auditRefreshKey"
          />
          <AuditRecordsPanel
            :workspace-id="selectedWorkspaceId"
            :can-manage="selectedWorkspace?.role === 'owner' || selectedWorkspace?.role === 'admin'"
            :refresh-key="auditRefreshKey"
          />
        </template>
        <template v-else>
          <ChatPanel
            :key="`${currentUser?.id}:${selectedWorkspaceId}:${chatResetKey}`"
            :workspace-id="selectedWorkspaceId"
            :models="models"
            @inspector-update="updateInspector"
            @session-created="refreshSessions"
          />
          <div class="mao-stat-strip compact">
            <article>
              <span>可用模型</span
              ><strong>{{
                models.filter((model) => model.status === 'active' && model.secretConfigured).length
              }}</strong
              ><small>由管理员配置并启用</small>
            </article>
            <article>
              <span>可用 Agent</span><strong>{{ agents.length }}</strong
              ><small>可用于后续任务编排</small>
            </article>
            <article>
              <span>执行循环</span><strong>TAO</strong><small>Think · Act · Observe</small>
            </article>
          </div>
        </template>

        <template #inspector>
          <RunInspector
            v-if="route === 'user'"
            :models="models"
            :pending="inspector.pending"
            :run-state="inspector.runState"
            :active-run-id="inspector.activeRunId"
            :resolved-model-id="inspector.resolvedModelId"
            :selected-model-id="inspector.selectedModelId"
            :events="inspector.events"
            :error="inspector.error"
          />
          <div v-else class="mao-inspector admin-inspector">
            <div class="mao-inspector-header">
              <div>
                <span class="mao-kicker">GOVERNANCE</span>
                <h3>治理检查器</h3>
              </div>
              <span class="mao-live-pill live"><span class="mao-live-dot"></span>已开启</span>
            </div>
            <section class="mao-inspector-card">
              <div class="mao-card-label">工作空间</div>
              <strong>{{ selectedWorkspace?.name || '未选择' }}</strong
              ><small>{{ selectedWorkspace?.role || '无角色' }} · 受控配置</small>
            </section>
            <section class="mao-inspector-card">
              <div class="mao-card-label">密钥策略</div>
              <div class="mao-policy-row">
                <span>浏览器可见</span><strong class="is-disabled">否</strong>
              </div>
              <div class="mao-policy-row">
                <span>服务端加密</span><strong class="is-enabled">是</strong>
              </div>
              <div class="mao-policy-row">
                <span>审计事件</span><strong class="is-enabled">记录中</strong>
              </div>
            </section>
            <p class="mao-inspector-note">
              模型密钥只在服务端保存，测试调用和状态变更都会进入审计链路。
            </p>
          </div>
        </template>
      </WorkbenchShell>
    </main>
    <footer v-if="authState !== 'ready'">
      Agent Workbench · 用户工作台 · 管理员控制台 · 第三方通道
    </footer>
  </div>
</template>
