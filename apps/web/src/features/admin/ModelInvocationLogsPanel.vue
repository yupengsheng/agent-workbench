<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AuditRecordSummary } from '@agent-workbench/contracts';
import { getAuditRecords } from '../../lib/api';

type KindFilter = 'all' | 'routing' | 'calls';
type StatusFilter = 'all' | 'success' | 'failed' | 'running' | 'cancelled';

interface RouteCandidate {
  id: string;
  provider: string;
  model: string;
  probability?: number;
  selected: boolean;
}

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
const kindFilter = ref<KindFilter>('all');
const statusFilter = ref<StatusFilter>('all');
let requestVersion = 0;

function value(record: AuditRecordSummary, key: string): string | undefined {
  const item = record.metadata[key];
  return typeof item === 'string' && item.length > 0 ? item : undefined;
}

function numberValue(record: AuditRecordSummary, key: string): number | undefined {
  const item = record.metadata[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : undefined;
}

function lifecycleKey(record: AuditRecordSummary) {
  return [
    record.resourceType,
    value(record, 'runId') ?? record.resourceId ?? record.id,
    record.resourceType === 'model_call' ? (numberValue(record, 'round') ?? 0) : 0,
  ].join(':');
}

const lifecycleRecords = computed(() => {
  const terminal = new Set(
    records.value
      .filter((record) => !record.action.endsWith('.started'))
      .map((record) => lifecycleKey(record)),
  );
  return records.value.filter(
    (record) => !record.action.endsWith('.started') || !terminal.has(lifecycleKey(record)),
  );
});

function recordStatus(record: AuditRecordSummary): Exclude<StatusFilter, 'all'> {
  if (record.action.endsWith('.completed')) return 'success';
  if (record.action.endsWith('.cancelled')) return 'cancelled';
  if (record.action.endsWith('.failed')) return 'failed';
  return 'running';
}

const visibleRecords = computed(() =>
  lifecycleRecords.value.filter((record) => {
    const kindMatches =
      kindFilter.value === 'all' ||
      (kindFilter.value === 'routing' && record.resourceType === 'model_routing') ||
      (kindFilter.value === 'calls' && record.resourceType === 'model_call');
    return (
      kindMatches && (statusFilter.value === 'all' || recordStatus(record) === statusFilter.value)
    );
  }),
);

function statusLabel(record: AuditRecordSummary) {
  return {
    success: '成功',
    failed: '失败',
    running: '进行中',
    cancelled: '已取消',
  }[recordStatus(record)];
}

function routeCandidates(record: AuditRecordSummary): RouteCandidate[] {
  const rawCandidates = record.metadata.candidates;
  if (!Array.isArray(rawCandidates)) return [];
  const rawProbabilities = record.metadata.probabilities;
  const probabilities =
    typeof rawProbabilities === 'object' &&
    rawProbabilities !== null &&
    !Array.isArray(rawProbabilities)
      ? (rawProbabilities as Record<string, unknown>)
      : {};
  const selectedId = value(record, 'selectedCandidateId');
  return rawCandidates
    .flatMap((candidate) => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
        return [];
      const item = candidate as Record<string, unknown>;
      if (
        typeof item.id !== 'string' ||
        typeof item.provider !== 'string' ||
        typeof item.model !== 'string'
      ) {
        return [];
      }
      const probability = probabilities[item.id];
      return [
        {
          id: item.id,
          provider: item.provider,
          model: item.model,
          ...(typeof probability === 'number' && Number.isFinite(probability)
            ? { probability }
            : {}),
          selected: item.id === selectedId,
        },
      ];
    })
    .sort((left, right) => (right.probability ?? -1) - (left.probability ?? -1));
}

function title(record: AuditRecordSummary) {
  if (record.resourceType === 'model_routing') return 'Jev 模型路由';
  return (
    [value(record, 'provider'), value(record, 'model')].filter(Boolean).join(' / ') || '模型调用'
  );
}

function formatDuration(value: number | undefined) {
  if (value === undefined) return '';
  return value < 1000 ? value + ' ms' : (value / 1000).toFixed(2) + ' s';
}

function detail(record: AuditRecordSummary) {
  const duration = formatDuration(numberValue(record, 'durationMs'));
  const errorCode = value(record, 'errorCode');
  if (record.resourceType === 'model_routing') {
    const confidence = numberValue(record, 'confidence');
    const selected = routeCandidates(record).find((candidate) => candidate.selected);
    return [
      value(record, 'routerModel') ?? value(record, 'router'),
      selected ? '选择 ' + selected.provider + ' / ' + selected.model : '',
      confidence === undefined ? '' : '置信度 ' + (confidence * 100).toFixed(1) + '%',
      duration,
      errorCode,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  const usage = record.metadata.usage;
  const usageRecord =
    typeof usage === 'object' && usage !== null && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : {};
  const totalTokens = usageRecord.totalTokens;
  const round = numberValue(record, 'round');
  return [
    round === undefined ? '' : '第 ' + round + ' 轮',
    typeof totalTokens === 'number' ? totalTokens + ' tokens' : '',
    duration,
    errorCode,
  ]
    .filter(Boolean)
    .join(' · ');
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function shortRun(record: AuditRecordSummary) {
  return (value(record, 'runId') ?? record.resourceId ?? '').slice(0, 8);
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
    const response = await getAuditRecords(props.workspaceId, 30, offset, 'model');
    if (version !== requestVersion) return;
    const modelRecords = response.records.filter((record) =>
      ['model_routing', 'model_call'].includes(record.resourceType),
    );
    records.value = reset ? modelRecords : [...records.value, ...modelRecords];
    nextOffset.value = response.nextOffset;
  } catch (caught) {
    if (version === requestVersion)
      error.value = caught instanceof Error ? caught.message : '模型调用日志加载失败';
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
  <section class="data-card model-log-console" aria-labelledby="model-log-title">
    <div class="section-heading model-log-heading">
      <div>
        <h3 id="model-log-title">模型调用日志</h3>
        <p class="section-description">Jev 路由决策与实际模型请求的状态、耗时和用量。</p>
      </div>
      <button
        v-if="canManage"
        type="button"
        class="audit-refresh-button"
        aria-label="刷新模型调用日志"
        title="刷新模型调用日志"
        :disabled="loading"
        @click="load(true)"
      >
        ↻
      </button>
    </div>

    <p v-if="!canManage" class="notice">只有 workspace owner 或 admin 可以查看模型日志。</p>
    <template v-else>
      <div class="model-log-toolbar">
        <div class="model-log-segments" role="group" aria-label="日志类型">
          <button :class="{ active: kindFilter === 'all' }" @click="kindFilter = 'all'">
            全部
          </button>
          <button :class="{ active: kindFilter === 'routing' }" @click="kindFilter = 'routing'">
            Jev 路由
          </button>
          <button :class="{ active: kindFilter === 'calls' }" @click="kindFilter = 'calls'">
            模型请求
          </button>
        </div>
        <select v-model="statusFilter" aria-label="调用状态">
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="failed">失败</option>
          <option value="running">进行中</option>
          <option value="cancelled">已取消</option>
        </select>
      </div>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-else-if="loading" class="empty-state" role="status">正在加载模型调用日志…</p>
      <p v-else-if="visibleRecords.length === 0" class="empty-state">当前筛选条件下没有记录。</p>

      <ol v-else class="model-log-list">
        <li v-for="record in visibleRecords" :key="record.id" class="model-log-row">
          <span class="audit-state" :class="recordStatus(record)" aria-hidden="true"></span>
          <div class="model-log-copy">
            <div class="model-log-title-line">
              <strong>{{ title(record) }}</strong>
              <span class="model-log-status" :class="recordStatus(record)">{{
                statusLabel(record)
              }}</span>
            </div>
            <p>{{ detail(record) }}</p>
            <details
              v-if="record.resourceType === 'model_routing' && routeCandidates(record).length > 0"
              class="route-candidates"
            >
              <summary>候选概率</summary>
              <ul>
                <li
                  v-for="candidate in routeCandidates(record)"
                  :key="candidate.id"
                  :class="{ selected: candidate.selected }"
                >
                  <span>{{ candidate.provider }} / {{ candidate.model }}</span>
                  <strong v-if="candidate.probability !== undefined"
                    >{{ (candidate.probability * 100).toFixed(1) }}%</strong
                  >
                  <small v-if="candidate.selected">已选择</small>
                </li>
              </ul>
            </details>
          </div>
          <div class="model-log-meta">
            <time :datetime="record.createdAt">{{ formatDate(record.createdAt) }}</time>
            <small>Run {{ shortRun(record) }}</small>
          </div>
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
    </template>
  </section>
</template>
