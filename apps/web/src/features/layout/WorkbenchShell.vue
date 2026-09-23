<script setup lang="ts">
import type {
  AuthResponse,
  SessionSummary,
  WorkspaceListResponse,
} from '@agent-workbench/contracts';

type Route = 'user' | 'admin';

const props = defineProps<{
  route: Route;
  currentUser?: AuthResponse['user'] | undefined;
  workspaces: WorkspaceListResponse['workspaces'];
  selectedWorkspaceId: string;
  selectedWorkspace?: WorkspaceListResponse['workspaces'][number] | undefined;
  sessions: SessionSummary[];
  activeSessionId: string;
  healthState: 'checking' | 'connected' | 'unavailable';
  healthDetail: string;
}>();

const emit = defineEmits<{
  navigate: [route: Route];
  logout: [];
  workspaceChange: [workspaceId: string];
  selectSession: [sessionId: string];
  newSession: [];
}>();

function formatSessionDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '最近更新';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}
</script>

<template>
  <div class="mao-shell">
    <header class="mao-topbar">
      <a class="mao-brand" href="/app" aria-label="Agent Workbench 用户工作台">
        <span class="mao-brand-mark" aria-hidden="true">A</span>
        <span class="mao-brand-copy">
          <strong>Agent Workbench</strong>
          <small>Private AI workspace</small>
        </span>
      </a>

      <nav class="mao-route-nav" aria-label="入口切换">
        <button
          type="button"
          :class="{ active: props.route === 'user' }"
          @click="emit('navigate', 'user')"
        >
          工作台
        </button>
        <button
          type="button"
          :class="{ active: props.route === 'admin' }"
          @click="emit('navigate', 'admin')"
        >
          管理
        </button>
      </nav>

      <div class="mao-topbar-actions">
        <span class="mao-health" :title="props.healthDetail">
          <span class="mao-health-dot" :class="props.healthState" aria-hidden="true"></span>
          {{
            props.healthState === 'connected'
              ? '服务正常'
              : props.healthState === 'checking'
                ? '连接中'
                : '服务异常'
          }}
        </span>
        <span class="mao-user-chip" :title="props.currentUser?.email">
          {{ props.currentUser?.displayName || props.currentUser?.email || '用户' }}
        </span>
        <button type="button" class="mao-icon-button" aria-label="退出登录" @click="emit('logout')">
          ↗
        </button>
      </div>
    </header>

    <div class="mao-layout">
      <aside class="mao-session-sidebar" aria-label="工作台导航">
        <div class="mao-sidebar-heading">
          <div>
            <span class="mao-kicker">{{ props.route === 'admin' ? 'ADMIN' : 'WORKSPACE' }}</span>
            <h1>{{ props.route === 'admin' ? '治理中心' : '任务' }}</h1>
          </div>
          <button
            type="button"
            class="mao-square-button"
            aria-label="新建任务"
            title="新建任务"
            @click="emit('newSession')"
          >
            +
          </button>
        </div>

        <label class="mao-workspace-select workspace-picker">
          <span>工作空间</span>
          <select
            :value="props.selectedWorkspaceId"
            @change="emit('workspaceChange', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="workspace in props.workspaces" :key="workspace.id" :value="workspace.id">
              {{ workspace.name }} · {{ workspace.role }}
            </option>
          </select>
        </label>

        <div class="mao-sidebar-section-label">
          <span>{{ props.route === 'admin' ? '配置' : '会话' }}</span>
          <span class="mao-sidebar-count">{{
            props.route === 'admin' ? '3' : props.sessions.length
          }}</span>
        </div>

        <nav v-if="props.route === 'user'" class="mao-session-list" aria-label="会话列表">
          <button
            type="button"
            class="mao-session-item new-session-item"
            @click="emit('newSession')"
          >
            <span class="mao-session-dot new" aria-hidden="true">+</span>
            <span class="mao-session-content">
              <strong>新建任务</strong>
              <small>开始一段新的对话</small>
            </span>
          </button>
          <button
            v-for="session in props.sessions"
            :key="session.id"
            type="button"
            class="mao-session-item"
            :class="{ active: session.id === props.activeSessionId }"
            @click="emit('selectSession', session.id)"
          >
            <span
              class="mao-session-dot"
              :class="{ running: session.id === props.activeSessionId }"
              aria-hidden="true"
            ></span>
            <span class="mao-session-content">
              <strong>{{ session.title || '新对话' }}</strong>
              <small>{{ formatSessionDate(session.updatedAt) }}</small>
            </span>
            <span class="mao-session-arrow" aria-hidden="true">›</span>
          </button>
          <div v-if="props.sessions.length === 0" class="mao-session-empty">暂无历史任务</div>
        </nav>
        <nav v-else class="mao-session-list" aria-label="管理员导航">
          <button type="button" class="mao-session-item active" @click="emit('navigate', 'admin')">
            <span class="mao-session-dot" aria-hidden="true"></span>
            <span class="mao-session-content">
              <strong>模型与 Agent</strong>
              <small>连接与治理</small>
            </span>
            <span class="mao-session-arrow" aria-hidden="true">›</span>
          </button>
        </nav>

        <div class="mao-sidebar-bottom">
          <div class="mao-sidebar-feature">
            <span class="mao-feature-icon" aria-hidden="true">⌘</span>
            <span><strong>Jev 路由</strong><small>自动选择合适模型</small></span>
            <span class="mao-feature-status">ON</span>
          </div>
          <div class="mao-sidebar-feature muted">
            <span class="mao-feature-icon" aria-hidden="true">⌁</span>
            <span><strong>飞书通道</strong><small>即将接入</small></span>
          </div>
        </div>
      </aside>

      <main class="mao-main-column">
        <div class="mao-main-toolbar">
          <div>
            <span class="mao-kicker">{{ props.selectedWorkspace?.name || 'WORKSPACE' }}</span>
            <h2>{{ props.route === 'admin' ? '模型与 Agent 配置' : '和 AI 一起工作' }}</h2>
          </div>
          <div class="mao-toolbar-actions">
            <span v-if="props.selectedWorkspace" class="mao-role-pill">{{
              props.selectedWorkspace.role
            }}</span>
            <button type="button" class="mao-toolbar-button" title="当前工作空间">⌄</button>
          </div>
        </div>
        <slot />
      </main>

      <aside class="mao-inspector-column" aria-label="任务检查器">
        <slot name="inspector">
          <div class="mao-inspector-empty">
            <span class="mao-inspector-empty-icon">◇</span>
            <strong>任务检查器</strong>
            <p>选择任务后，这里会显示模型路由、执行步骤和审计状态。</p>
          </div>
        </slot>
      </aside>
    </div>
  </div>
</template>
