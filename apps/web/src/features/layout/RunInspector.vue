<script setup lang="ts">
import { computed } from 'vue';
import type { ModelConnectionSummary, RunEventSummary } from '@agent-workbench/contracts';

const props = defineProps<{
  models: ModelConnectionSummary[];
  pending: boolean;
  runState: string;
  activeRunId: string;
  resolvedModelId: string;
  selectedModelId: string;
  events: RunEventSummary[];
  error: string;
}>();

const resolvedModel = computed(() =>
  props.models.find((model) => model.id === props.resolvedModelId),
);
const selectedModel = computed(() =>
  props.models.find((model) => model.id === props.selectedModelId),
);

function eventLabel(event: RunEventSummary) {
  if (event.type === 'run.created') return '任务已创建';
  if (event.type === 'step.queued') return '模型步骤已排队';
  if (event.type === 'model.routed') return 'Jev 已完成模型选择';
  if (event.type === 'step.started' && typeof event.payload.toolName === 'string') {
    return `正在执行工具：${event.payload.toolName}`;
  }
  if (event.type === 'step.succeeded') return '工具步骤已完成';
  if (event.type === 'step.completed') return '模型步骤已完成';
  if (event.type === 'run.started') return '执行器已开始处理任务';
  if (event.type === 'run.succeeded') return '任务已完成';
  if (event.type === 'run.cancelled') return '任务已取消';
  if (event.type === 'run.cancel_requested') return '已请求停止任务';
  if (event.type === 'run.failed') return '任务失败';
  return event.type;
}
</script>

<template>
  <div class="mao-inspector">
    <div class="mao-inspector-header">
      <div>
        <span class="mao-kicker">INSPECTOR</span>
        <h3>任务检查器</h3>
      </div>
      <span class="mao-live-pill" :class="{ live: props.pending }">
        <span class="mao-live-dot" aria-hidden="true"></span>{{ props.pending ? '运行中' : '就绪' }}
      </span>
    </div>

    <section class="mao-inspector-card mao-run-summary">
      <div class="mao-card-label">当前运行</div>
      <strong>{{
        props.pending
          ? `执行中 · ${props.runState || '正在处理…'}`
          : props.activeRunId
            ? '最近一次任务'
            : '等待新任务'
      }}</strong>
      <small v-if="props.activeRunId">Run {{ props.activeRunId.slice(0, 8) }}</small>
      <small v-else>在中央对话区发送消息开始任务</small>
    </section>

    <section class="mao-inspector-card">
      <div class="mao-card-label">模型路由</div>
      <div class="mao-inspector-value">
        <span class="mao-model-glyph">✦</span>
        <span>
          <strong>{{
            props.resolvedModelId
              ? resolvedModel?.name || resolvedModel?.modelIdentifier
              : props.selectedModelId === '__jev__'
                ? 'Jev 自动选择'
                : selectedModel?.name || '尚未选择'
          }}</strong>
          <small>{{ props.resolvedModelId ? '本次实际使用模型' : '发送后由服务端执行' }}</small>
        </span>
      </div>
    </section>

    <section class="mao-inspector-card mao-event-card">
      <div class="mao-card-label">
        执行过程 <span v-if="props.events.length">{{ props.events.length }}</span>
      </div>
      <ol v-if="props.events.length" class="mao-event-list">
        <li v-for="event in props.events" :key="event.id">
          <span
            class="mao-event-marker"
            :class="{ current: event.type.includes('started') }"
            aria-hidden="true"
          ></span>
          <span>{{ eventLabel(event) }}</span>
        </li>
      </ol>
      <p v-else class="mao-inspector-note">发送消息后，Think–Act–Observe 过程会持续显示在这里。</p>
    </section>

    <section class="mao-inspector-card mao-policy-card">
      <div class="mao-card-label">运行策略</div>
      <div class="mao-policy-row"><span>执行环境</span><strong>服务端 Runner</strong></div>
      <div class="mao-policy-row"><span>工具权限</span><strong>只读工具</strong></div>
      <div class="mao-policy-row">
        <span>审计记录</span><strong class="is-enabled">已开启</strong>
      </div>
    </section>

    <p v-if="props.error" class="mao-inspector-error" role="alert">{{ props.error }}</p>
  </div>
</template>
