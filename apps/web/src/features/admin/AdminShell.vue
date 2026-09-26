<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AuthResponse, WorkspaceListResponse } from '@agent-workbench/contracts';
import { ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from '@lucide/vue';
import { adminNavigationGroups, adminSectionItem, type AdminSection } from './adminNavigation';

const props = defineProps<{
  activeSection: AdminSection;
  currentUser?: AuthResponse['user'] | undefined;
  workspaces: WorkspaceListResponse['workspaces'];
  selectedWorkspaceId: string;
  healthState: 'checking' | 'connected' | 'unavailable';
  healthDetail: string;
}>();

const emit = defineEmits<{
  navigate: [section: AdminSection];
  workspaceChange: [workspaceId: string];
  openWorkbench: [];
  logout: [];
}>();

const SIDEBAR_KEY = 'agent-workbench:admin-sidebar-collapsed';
const collapsed = ref(window.localStorage.getItem(SIDEBAR_KEY) === '1');
const drawerOpen = ref(false);
const tabs = ref<AdminSection[]>(['overview']);

const activeItem = computed(() => adminSectionItem(props.activeSection));
const initials = computed(() => {
  const value = props.currentUser?.displayName || props.currentUser?.email || 'A';
  return value.trim().slice(0, 1).toUpperCase();
});

watch(
  () => props.activeSection,
  (section) => {
    if (!tabs.value.includes(section)) tabs.value.push(section);
    drawerOpen.value = false;
    document.title = `${adminSectionItem(section).label} · Agent Workbench 管理后台`;
  },
  { immediate: true },
);

function toggleSidebar() {
  collapsed.value = !collapsed.value;
  window.localStorage.setItem(SIDEBAR_KEY, collapsed.value ? '1' : '0');
}

function navigate(section: AdminSection) {
  emit('navigate', section);
}

function closeTab(section: AdminSection) {
  if (section === 'overview') return;
  const index = tabs.value.indexOf(section);
  if (index < 0) return;
  tabs.value.splice(index, 1);
  if (props.activeSection === section) {
    navigate(tabs.value[Math.max(0, index - 1)] ?? 'overview');
  }
}

function handleTabKeydown(event: KeyboardEvent, index: number) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const target = (index + direction + tabs.value.length) % tabs.value.length;
  navigate(tabs.value[target]!);
}
</script>

<template>
  <div class="admin-layout-container" :class="{ 'is-collapsed': collapsed }">
    <button
      v-if="drawerOpen"
      type="button"
      class="admin-drawer-backdrop"
      aria-label="关闭导航"
      @click="drawerOpen = false"
    ></button>

    <aside class="admin-layout-aside" :class="{ 'drawer-open': drawerOpen }">
      <button type="button" class="admin-logo" @click="navigate('overview')">
        <span class="admin-logo-mark" aria-hidden="true">A</span>
        <span v-if="!collapsed" class="admin-logo-text">
          <strong>Agent Workbench</strong>
          <small>管理后台</small>
        </span>
      </button>

      <nav class="admin-side-menu" aria-label="管理员导航">
        <section v-for="group in adminNavigationGroups" :key="group.id" class="admin-menu-group">
          <div v-if="group.label && !collapsed" class="admin-menu-group-title">
            {{ group.label }}
          </div>
          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="admin-menu-item"
            :class="{ active: props.activeSection === item.id }"
            :aria-current="props.activeSection === item.id ? 'page' : undefined"
            :title="collapsed ? item.label : undefined"
            @click="navigate(item.id)"
          >
            <component :is="item.icon" :size="18" :stroke-width="1.8" aria-hidden="true" />
            <span v-if="!collapsed">{{ item.label }}</span>
          </button>
        </section>
      </nav>

      <div class="admin-sidebar-footer">
        <label v-if="!collapsed" class="admin-workspace-field">
          <span>工作空间</span>
          <select
            :value="props.selectedWorkspaceId"
            @change="emit('workspaceChange', ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="workspace in props.workspaces" :key="workspace.id" :value="workspace.id">
              {{ workspace.name }}
            </option>
          </select>
        </label>
        <button
          type="button"
          class="admin-workbench-link"
          :title="collapsed ? '返回工作台' : undefined"
          @click="emit('openWorkbench')"
        >
          <PanelLeftOpen :size="18" :stroke-width="1.8" aria-hidden="true" />
          <span v-if="!collapsed">返回工作台</span>
        </button>
      </div>
    </aside>

    <div class="admin-layout-body">
      <header class="admin-layout-header">
        <div class="admin-header-left">
          <button
            type="button"
            class="admin-menu-toggle mobile-only"
            aria-label="打开导航"
            title="打开导航"
            @click="drawerOpen = true"
          >
            <Menu :size="20" :stroke-width="1.8" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="admin-menu-toggle desktop-only"
            :aria-label="collapsed ? '展开菜单' : '收起菜单'"
            :title="collapsed ? '展开菜单' : '收起菜单'"
            @click="toggleSidebar"
          >
            <PanelLeftOpen v-if="collapsed" :size="20" :stroke-width="1.8" aria-hidden="true" />
            <PanelLeftClose v-else :size="20" :stroke-width="1.8" aria-hidden="true" />
          </button>
          <span class="admin-page-title">{{ activeItem.label }}</span>
        </div>

        <div class="admin-header-right">
          <span class="admin-health" :title="props.healthDetail">
            <span class="admin-health-dot" :class="props.healthState" aria-hidden="true"></span>
            <span>{{ props.healthState === 'connected' ? '服务正常' : props.healthDetail }}</span>
          </span>
          <span class="admin-user-info" :title="props.currentUser?.email">
            <span class="admin-avatar" aria-hidden="true">{{ initials }}</span>
            <span class="admin-username">{{ props.currentUser?.displayName || '管理员' }}</span>
            <ChevronDown :size="14" :stroke-width="1.8" aria-hidden="true" />
          </span>
          <button
            type="button"
            class="admin-header-icon"
            aria-label="退出登录"
            title="退出登录"
            @click="emit('logout')"
          >
            <LogOut :size="18" :stroke-width="1.8" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div class="admin-tab-bar" role="tablist" aria-label="页面标签">
        <button
          v-for="(section, index) in tabs"
          :key="section"
          type="button"
          role="tab"
          class="admin-tab-item"
          :class="{ active: props.activeSection === section }"
          :aria-selected="props.activeSection === section"
          :tabindex="props.activeSection === section ? 0 : -1"
          @click="navigate(section)"
          @keydown="handleTabKeydown($event, index)"
        >
          <span>{{ adminSectionItem(section).label }}</span>
          <span
            v-if="section !== 'overview'"
            class="admin-tab-close"
            role="button"
            :aria-label="`关闭${adminSectionItem(section).label}标签`"
            tabindex="0"
            @click.stop="closeTab(section)"
            @keydown.enter.stop.prevent="closeTab(section)"
            @keydown.space.stop.prevent="closeTab(section)"
          >
            <X :size="12" :stroke-width="2" aria-hidden="true" />
          </span>
        </button>
      </div>

      <main class="admin-layout-main">
        <div class="admin-layout-content">
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-layout-container {
  --admin-aside-width: 232px;
  display: grid;
  grid-template-columns: var(--admin-aside-width) minmax(0, 1fr);
  width: 100%;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  color: var(--mao-ink);
  background: var(--mao-canvas);
  transition: grid-template-columns 0.2s ease;
}

.admin-layout-container.is-collapsed {
  --admin-aside-width: 64px;
}

.admin-layout-aside {
  display: flex;
  min-width: 0;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--mao-border);
  background: var(--mao-surface);
  z-index: 20;
}

.admin-logo {
  display: flex;
  align-items: center;
  width: 100%;
  height: 56px;
  min-height: 56px;
  gap: 10px;
  padding: 0 16px;
  border: 0;
  border-radius: 0;
  color: var(--mao-ink);
  background: transparent;
  text-align: left;
}

.is-collapsed .admin-logo {
  justify-content: center;
  padding: 0;
}

.admin-logo-mark {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  place-items: center;
  border-radius: 7px;
  color: white;
  background: var(--mao-primary);
  font-size: 13px;
  font-weight: 700;
}

.admin-logo-text {
  display: grid;
  min-width: 0;
  line-height: 1.15;
}

.admin-logo-text strong {
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-logo-text small {
  color: var(--mao-muted);
  font-size: 11px;
}

.admin-side-menu {
  flex: 1;
  padding: 4px 0 14px;
  overflow-x: hidden;
  overflow-y: auto;
}

.admin-menu-group-title {
  padding: 16px 20px 6px;
  color: var(--mao-muted);
  font-size: 11px;
  line-height: 1;
}

.admin-menu-item,
.admin-workbench-link {
  display: flex;
  align-items: center;
  width: calc(100% - 16px);
  height: 44px;
  gap: 12px;
  margin: 0 8px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  color: var(--mao-ink);
  background: transparent;
  font-size: 14px;
  text-align: left;
}

.admin-menu-item:hover,
.admin-workbench-link:hover {
  background: var(--mao-canvas);
}

.admin-menu-item.active {
  color: var(--mao-primary);
  background: var(--mao-primary-soft);
}

.is-collapsed .admin-menu-item,
.is-collapsed .admin-workbench-link {
  justify-content: center;
  padding: 0;
}

.admin-sidebar-footer {
  display: grid;
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--mao-border);
}

.admin-workspace-field {
  display: grid;
  gap: 6px;
  padding: 0 12px;
  color: var(--mao-muted);
  font-size: 11px;
}

.admin-workspace-field select {
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--mao-border);
  border-radius: 6px;
  color: var(--mao-ink);
  background: var(--mao-surface);
  font: inherit;
  font-size: 12px;
}

.admin-workbench-link {
  color: var(--mao-muted);
}

.admin-layout-body {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 56px 36px minmax(0, 1fr);
}

.admin-layout-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: 0 16px;
  border-bottom: 1px solid var(--mao-border);
  background: var(--mao-surface);
}

.admin-header-left,
.admin-header-right,
.admin-user-info,
.admin-health {
  display: flex;
  align-items: center;
}

.admin-header-left {
  min-width: 0;
  gap: 12px;
}

.admin-page-title {
  overflow: hidden;
  color: var(--mao-ink);
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-header-right {
  min-width: 0;
  gap: 14px;
}

.admin-menu-toggle,
.admin-header-icon {
  display: grid;
  width: 32px;
  height: 32px;
  padding: 0;
  place-items: center;
  border: 0;
  color: var(--mao-muted);
  background: transparent;
}

.admin-menu-toggle:hover,
.admin-header-icon:hover {
  color: var(--mao-ink);
  background: var(--mao-canvas);
}

.admin-health {
  gap: 6px;
  color: var(--mao-muted);
  font-size: 12px;
  white-space: nowrap;
}

.admin-health-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--mao-muted);
}

.admin-health-dot.connected {
  background: var(--mao-success);
}

.admin-health-dot.checking {
  background: var(--mao-warning);
}

.admin-health-dot.unavailable {
  background: var(--mao-danger);
}

.admin-user-info {
  min-width: 0;
  gap: 8px;
  color: var(--mao-muted);
  font-size: 13px;
}

.admin-avatar {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  place-items: center;
  border-radius: 50%;
  color: white;
  background: #7b8794;
  font-size: 12px;
  font-weight: 650;
}

.admin-username {
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-tab-bar {
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0 12px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--mao-border);
  background: var(--mao-surface);
  scrollbar-width: none;
}

.admin-tab-bar::-webkit-scrollbar {
  display: none;
}

.admin-tab-item {
  display: flex;
  align-items: center;
  height: 28px;
  flex: 0 0 auto;
  gap: 6px;
  margin: 0 2px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  color: var(--mao-muted);
  background: transparent;
  font-size: 13px;
  white-space: nowrap;
}

.admin-tab-item:hover {
  color: var(--mao-ink);
  background: var(--mao-canvas);
}

.admin-tab-item.active {
  color: var(--mao-primary);
  background: var(--mao-primary-soft);
}

.admin-tab-close {
  display: grid;
  width: 17px;
  height: 17px;
  place-items: center;
  border-radius: 50%;
}

.admin-tab-close:hover {
  color: var(--mao-ink);
  background: #d2d2d7;
}

.admin-layout-main {
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  background: var(--mao-canvas);
}

.admin-layout-content {
  height: 100%;
  padding: 20px;
  overflow-y: auto;
}

.mobile-only,
.admin-drawer-backdrop {
  display: none;
}

@media (max-width: 768px) {
  .admin-layout-container,
  .admin-layout-container.is-collapsed {
    display: block;
    --admin-aside-width: min(72vw, 300px);
  }

  .admin-layout-aside {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--admin-aside-width);
    transform: translateX(-100%);
    transition: transform 0.2s ease;
  }

  .admin-layout-aside.drawer-open {
    transform: translateX(0);
  }

  .admin-drawer-backdrop {
    position: fixed;
    inset: 0;
    display: block;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.28);
    z-index: 19;
  }

  .admin-layout-body {
    height: 100%;
    grid-template-rows: calc(56px + env(safe-area-inset-top)) minmax(0, 1fr);
  }

  .admin-layout-header {
    padding-top: env(safe-area-inset-top);
    padding-right: max(12px, env(safe-area-inset-right));
    padding-left: max(12px, env(safe-area-inset-left));
  }

  .admin-tab-bar,
  .desktop-only,
  .admin-health,
  .admin-username,
  .admin-user-info > svg {
    display: none;
  }

  .mobile-only {
    display: grid;
  }

  .admin-layout-content {
    padding: 12px;
    padding-right: max(12px, env(safe-area-inset-right));
    padding-bottom: max(12px, env(safe-area-inset-bottom));
    padding-left: max(12px, env(safe-area-inset-left));
  }
}
</style>
