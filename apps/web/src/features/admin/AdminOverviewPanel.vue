<script setup lang="ts">
import { computed } from 'vue';
import type {
  AgentListResponse,
  ModelConnectionListResponse,
  SessionSummary,
} from '@agent-workbench/contracts';
import { ArrowRight, Bot, CircleGauge, Logs, Network, ShieldCheck } from '@lucide/vue';
import type { AdminSection } from './adminNavigation';

const props = defineProps<{
  models: ModelConnectionListResponse['connections'];
  agents: AgentListResponse['agents'];
  sessions: SessionSummary[];
}>();

const emit = defineEmits<{ open: [section: AdminSection] }>();

const activeModels = computed(
  () => props.models.filter((model) => model.status === 'active' && model.secretConfigured).length,
);
const publishedAgents = computed(
  () => props.agents.filter((agent) => agent.status === 'active' && agent.currentVersionId).length,
);

const entries: Array<{
  id: AdminSection;
  title: string;
  description: string;
  icon: typeof Bot;
}> = [
  { id: 'models', title: '模型管理', description: '连接、密钥、能力与可用状态', icon: Network },
  { id: 'agents', title: 'Agent 管理', description: 'Agent 草稿与已发布版本', icon: Bot },
  { id: 'llm-calls', title: '调用流水', description: 'Jev 路由、模型耗时与 Token', icon: Logs },
  {
    id: 'audit-logs',
    title: '审计日志',
    description: '配置、执行与审批操作记录',
    icon: ShieldCheck,
  },
];
</script>

<template>
  <div class="admin-overview-view">
    <section class="admin-summary-grid" aria-label="工作空间统计">
      <article>
        <span class="admin-summary-icon blue"><Network :size="19" aria-hidden="true" /></span>
        <div>
          <small>可用模型</small><strong>{{ activeModels }}</strong>
        </div>
      </article>
      <article>
        <span class="admin-summary-icon green"><Bot :size="19" aria-hidden="true" /></span>
        <div>
          <small>已发布 Agent</small><strong>{{ publishedAgents }}</strong>
        </div>
      </article>
      <article>
        <span class="admin-summary-icon orange"><CircleGauge :size="19" aria-hidden="true" /></span>
        <div>
          <small>历史会话</small><strong>{{ sessions.length }}</strong>
        </div>
      </article>
      <article>
        <span class="admin-summary-icon gray"><ShieldCheck :size="19" aria-hidden="true" /></span>
        <div><small>审计策略</small><strong class="text-value">已开启</strong></div>
      </article>
    </section>

    <section class="admin-page-card">
      <header class="admin-card-header">
        <div>
          <h2>管理入口</h2>
          <p>当前工作空间的能力、运行与安全配置</p>
        </div>
      </header>
      <div class="admin-entry-grid">
        <button
          v-for="entry in entries"
          :key="entry.id"
          type="button"
          @click="emit('open', entry.id)"
        >
          <span class="admin-entry-icon"
            ><component :is="entry.icon" :size="19" aria-hidden="true"
          /></span>
          <span class="admin-entry-copy"
            ><strong>{{ entry.title }}</strong
            ><small>{{ entry.description }}</small></span
          >
          <ArrowRight :size="16" aria-hidden="true" />
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin-overview-view {
  display: grid;
  gap: 16px;
}

.admin-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.admin-summary-grid article {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 14px;
  padding: 18px 20px;
  border: 1px solid var(--mao-border);
  border-radius: 4px;
  background: var(--mao-surface);
}

.admin-summary-grid article > div {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.admin-summary-grid small {
  color: var(--mao-muted);
  font-size: 12px;
}

.admin-summary-grid strong {
  color: var(--mao-ink);
  font-size: 25px;
  font-weight: 600;
}

.admin-summary-grid .text-value {
  font-size: 17px;
}

.admin-summary-icon,
.admin-entry-icon {
  display: grid;
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  place-items: center;
  border-radius: 6px;
  color: var(--mao-primary);
  background: var(--mao-primary-soft);
}

.admin-summary-icon.green {
  color: #248a42;
  background: rgba(52, 199, 89, 0.1);
}

.admin-summary-icon.orange {
  color: #b26a00;
  background: rgba(255, 159, 10, 0.12);
}

.admin-summary-icon.gray {
  color: #636366;
  background: #eeeeef;
}

.admin-page-card {
  border: 1px solid var(--mao-border);
  border-radius: 4px;
  background: var(--mao-surface);
}

.admin-card-header {
  padding: 17px 20px;
  border-bottom: 1px solid var(--mao-border);
}

.admin-card-header h2 {
  margin: 0;
  color: var(--mao-ink);
  font-size: 16px;
  font-weight: 600;
}

.admin-card-header p {
  margin: 5px 0 0;
  color: var(--mao-muted);
  font-size: 12px;
}

.admin-entry-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  padding: 8px;
}

.admin-entry-grid button {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  text-align: left;
}

.admin-entry-grid button:hover {
  background: var(--mao-canvas);
}

.admin-entry-grid button > svg {
  color: var(--mao-muted);
}

.admin-entry-icon {
  width: 34px;
  height: 34px;
  flex-basis: 34px;
}

.admin-entry-copy {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.admin-entry-copy strong {
  color: var(--mao-ink);
  font-size: 13px;
  font-weight: 600;
}

.admin-entry-copy small {
  overflow: hidden;
  color: var(--mao-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 1000px) {
  .admin-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 600px) {
  .admin-summary-grid,
  .admin-entry-grid {
    grid-template-columns: 1fr;
  }

  .admin-summary-grid {
    gap: 10px;
  }
}
</style>
