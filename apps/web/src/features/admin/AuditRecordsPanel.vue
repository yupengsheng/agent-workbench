<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RefreshCw } from '@lucide/vue';
import type { AuditRecordSummary } from '@agent-workbench/contracts';
import { getAuditRecords } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  canManage: boolean;
  refreshKey: number;
}>();

const records = ref<AuditRecordSummary[]>([]);
const nextOffset = ref<number | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
let requestVersion = 0;

const actionLabels: Record<string, string> = {
  'admin.initialized': '管理员已初始化',
  'workspace.created': '工作空间已创建',
  'model_connection.created': '模型连接已创建',
  'model_connection.updated': '模型连接已更新',
  'model_connection.tested': '模型连接已测试',
  'agent.created': 'Agent 已创建',
  'agent_version.created': 'Agent 版本已创建',
  'agent_version.published': 'Agent 版本已发布',
  'model_routing.started': 'Jev 模型路由已开始',
  'model_routing.completed': 'Jev 模型路由已完成',
  'model_routing.failed': 'Jev 模型路由失败',
  'model_routing.cancelled': 'Jev 模型路由已取消',
  'model_call.started': '模型调用已开始',
  'model_call.completed': '模型调用已完成',
  'model_call.failed': '模型调用失败',
  'model_call.cancelled': '模型调用已取消',
  'tool_call.started': '工具调用已开始',
  'tool_call.completed': '工具调用已完成',
  'tool_call.failed': '工具调用失败',
  'tool_call.cancelled': '工具调用已取消',
  'file_change.proposed': '文件变更已提议',
  'file_change.approved': '文件变更已批准',
  'file_change.rejected': '文件变更已拒绝',
  'file_change.applied': '文件变更已应用',
  'file_change.apply_failed': '文件变更应用失败',
  'file_change.apply_unknown': '文件变更结果待核对',
  'file_change.expired': '文件变更已过期',
  'shell_command.proposed': 'Shell 命令已提议',
  'shell_command.approved': 'Shell 命令已批准',
  'shell_command.rejected': 'Shell 命令已拒绝',
  'shell_command.succeeded': 'Shell 命令执行成功',
  'shell_command.failed': 'Shell 命令执行失败',
  'shell_command.unknown': 'Shell 命令结果待核对',
  'shell_command.expired': 'Shell 命令已过期',
};

const resourceLabels: Record<string, string> = {
  workspace: '工作空间',
  model_connection: '模型连接',
  agent: 'Agent',
  agent_version: 'Agent 版本',
  model_routing: '模型路由',
  model_call: '模型调用',
  tool_call: '工具调用',
  file_change: '文件变更',
  shell_command: 'Shell 命令',
};

const hasRecords = computed(() => records.value.length > 0);

function value(record: AuditRecordSummary, key: string): string | undefined {
  const item = record.metadata[key];
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

function numberValue(record: AuditRecordSummary, key: string): number | undefined {
  const item = record.metadata[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : undefined;
}

function detail(record: AuditRecordSummary): string {
  if (record.resourceType === 'model_call') {
    const round = numberValue(record, 'round');
    const provider = value(record, 'provider');
    const model = value(record, 'model');
    const usage = record.metadata.usage;
    const tokens =
      typeof usage === 'object' && usage !== null && !Array.isArray(usage)
        ? (usage as Record<string, unknown>).totalTokens
        : undefined;
    return [
      round ? `第 ${round} 轮` : '',
      provider && model ? `${provider} / ${model}` : '',
      typeof tokens === 'number' ? `${tokens} tokens` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (record.resourceType === 'tool_call') {
    return [value(record, 'toolName'), value(record, 'toolStatus') || value(record, 'stepStatus')]
      .filter(Boolean)
      .join(' · ');
  }
  if (record.resourceType === 'model_routing') {
    const confidence = numberValue(record, 'confidence');
    return [
      value(record, 'routerModel') || value(record, 'router'),
      confidence === undefined ? '' : `置信度 ${confidence.toFixed(2)}`,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return resourceLabels[record.resourceType] ?? record.resourceType;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function shortId(value: string | null) {
  return value ? value.slice(0, 8) : '系统';
}

async function load(reset: boolean) {
  const version = reset ? ++requestVersion : requestVersion;
  if (!props.workspaceId || !props.canManage) {
    records.value = [];
    nextOffset.value = null;
    return;
  }
  if (reset) loading.value = true;
  else loadingMore.value = true;
  error.value = '';
  try {
    const offset = reset ? 0 : (nextOffset.value ?? 0);
    const response = await getAuditRecords(props.workspaceId, 30, offset);
    if (version !== requestVersion) return;
    records.value = reset ? response.records : [...records.value, ...response.records];
    nextOffset.value = response.nextOffset;
  } catch (caught) {
    if (version === requestVersion)
      error.value = caught instanceof Error ? caught.message : '审计记录加载失败';
  } finally {
    if (version === requestVersion) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

watch(
  () => [props.workspaceId, props.canManage, props.refreshKey] as const,
  () => void load(true),
  { immediate: true },
);
</script>

<template>
  <section class="data-card audit-console" aria-labelledby="audit-records-title">
    <div class="section-heading">
      <div>
        <h3 id="audit-records-title">审计记录</h3>
        <p class="section-description">模型、工具、审批与配置操作的结构化记录。</p>
      </div>
      <button
        v-if="canManage"
        type="button"
        class="audit-refresh-button"
        aria-label="刷新审计记录"
        title="刷新审计记录"
        :disabled="loading"
        @click="load(true)"
      >
        <RefreshCw :size="16" aria-hidden="true" />
      </button>
    </div>

    <p v-if="!canManage" class="notice">只有 workspace owner 或 admin 可以查看审计记录。</p>
    <p v-else-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="empty-state" role="status">正在加载审计记录…</p>
    <p v-else-if="!hasRecords" class="empty-state">当前工作空间还没有审计记录。</p>

    <ol v-else class="audit-list">
      <li v-for="record in records" :key="record.id" class="audit-row">
        <span
          class="audit-state"
          :class="record.action.split('.').at(-1)"
          aria-hidden="true"
        ></span>
        <span class="audit-copy">
          <strong>{{ actionLabels[record.action] || record.action }}</strong>
          <small>{{
            detail(record) || resourceLabels[record.resourceType] || record.resourceType
          }}</small>
        </span>
        <span class="audit-meta">
          <time :datetime="record.createdAt">{{ formatDate(record.createdAt) }}</time>
          <small :title="record.actorUserId || '系统操作'"
            >操作人 {{ shortId(record.actorUserId) }}</small
          >
        </span>
      </li>
    </ol>

    <button
      v-if="nextOffset !== null"
      type="button"
      class="audit-load-more"
      :disabled="loadingMore"
      @click="load(false)"
    >
      {{ loadingMore ? '加载中…' : '加载更多' }}
    </button>
  </section>
</template>
