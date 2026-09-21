<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type {
  AgentListResponse,
  AuthResponse,
  ModelConnectionListResponse,
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
} from './lib/api';

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
const dataError = ref('');
const account = ref('');
const password = ref('');
const loginPending = ref(false);
const logoutPending = ref(false);

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
}

async function loadAuthenticatedState() {
  authState.value = 'loading';
  authError.value = '';
  try {
    const response = await getCurrentUser();
    currentUser.value = response.user;
    const workspaceResponse = await getWorkspaces();
    workspaces.value = workspaceResponse.workspaces;
    selectedWorkspaceId.value = workspaceResponse.workspaces[0]?.id ?? '';
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
    selectedWorkspaceId.value = workspaceResponse.workspaces[0]?.id ?? '';
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

async function selectWorkspace() {
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
    <header class="topbar">
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

      <section v-else class="workspace-layout">
        <aside class="side-panel">
          <p class="eyebrow">{{ route === 'admin' ? 'ADMIN CONSOLE' : 'USER WORKSPACE' }}</p>
          <h1>{{ route === 'admin' ? '治理控制台' : '开始一个任务' }}</h1>
          <p class="muted">{{ currentUser?.displayName }} · {{ currentUser?.email }}</p>
          <label class="workspace-picker"
            >工作空间<select v-model="selectedWorkspaceId" @change="selectWorkspace">
              <option v-for="workspace in workspaces" :key="workspace.id" :value="workspace.id">
                {{ workspace.name }} · {{ workspace.role }}
              </option>
            </select></label
          >
          <div class="side-links">
            <a :class="{ selected: route === 'user' }" href="/app" @click.prevent="setRoute('user')"
              >任务与产物</a
            ><a
              :class="{ selected: route === 'admin' }"
              href="/admin"
              @click.prevent="setRoute('admin')"
              >配置与治理</a
            ><span>飞书通道 · 即将接入</span>
          </div>
        </aside>
        <div class="content-panel">
          <div class="content-heading">
            <div>
              <p class="eyebrow">{{ selectedWorkspace?.name ?? '未选择工作空间' }}</p>
              <h2>{{ route === 'admin' ? '模型与 Agent 配置' : '任务工作台' }}</h2>
            </div>
            <span class="role-badge">{{ selectedWorkspace?.role ?? '无工作空间' }}</span>
          </div>
          <p v-if="dataError" class="form-error" role="alert">{{ dataError }}</p>
          <template v-if="route === 'admin'"
            ><div class="stat-grid">
              <article>
                <span>模型连接</span><strong>{{ models.length }}</strong
                ><small>服务端引用，浏览器不接触密钥</small>
              </article>
              <article>
                <span>Agent</span><strong>{{ agents.length }}</strong
                ><small>草稿和发布版本由 API 管理</small>
              </article>
              <article>
                <span>第三方通道</span><strong>0</strong><small>Feishu 适配器规划中</small>
              </article>
            </div>
            <section class="data-card">
              <div class="section-heading">
                <h3>模型连接</h3>
                <span>DeepSeek 优先</span>
              </div>
              <p v-if="models.length === 0" class="empty-state">
                当前工作空间还没有模型连接，请先在 API 中登记 DeepSeek。
              </p>
              <div v-for="model in models" :key="model.id" class="data-row">
                <div>
                  <strong>{{ model.name }}</strong
                  ><small>{{ model.provider }} · {{ model.modelIdentifier }}</small>
                </div>
                <span class="status-badge" :class="model.lastTestStatus">{{
                  model.lastTestStatus === 'passed'
                    ? '已验证'
                    : model.lastTestStatus === 'failed'
                      ? '测试失败'
                      : '未测试'
                }}</span>
              </div>
            </section></template
          >
          <template v-else
            ><section class="run-launcher">
              <p class="eyebrow">THINK · ACT · OBSERVE</p>
              <h3>描述你想完成的目标</h3>
              <textarea
                placeholder="例如：分析当前工作区的认证模块并生成一份带来源的技术报告。"
                rows="5"
              ></textarea>
              <div class="launcher-footer">
                <span class="muted">只读任务 · 服务端执行 · 过程可追溯</span
                ><button class="primary-button" disabled>提交任务（M2）</button>
              </div>
            </section>
            <div class="stat-grid">
              <article>
                <span>可用 Agent</span><strong>{{ agents.length }}</strong
                ><small>从管理员发布的版本中选择</small>
              </article>
              <article>
                <span>待审批</span><strong>0</strong><small>受控动作将在 M3 开放</small>
              </article>
              <article>
                <span>通道通知</span><strong>—</strong><small>可从飞书接收结果</small>
              </article>
            </div></template
          >
        </div>
      </section>
    </main>
    <footer>Agent Workbench · 用户工作台 · 管理员控制台 · 第三方通道</footer>
  </div>
</template>
