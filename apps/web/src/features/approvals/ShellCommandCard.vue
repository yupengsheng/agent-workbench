<script setup lang="ts">
import { ref } from 'vue';
import type { ShellCommandSummary } from '@agent-workbench/contracts';
import { decideShellCommand } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  command: ShellCommandSummary;
  canApprove: boolean;
}>();
const emit = defineEmits<{ changed: [command: ShellCommandSummary]; refresh: [] }>();
const saving = ref(false);
const error = ref('');

function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function statusLabel() {
  if (props.command.executionStatus === 'executing') return '执行中';
  if (props.command.executionStatus === 'succeeded') return '执行成功';
  if (props.command.executionStatus === 'failed') return '执行失败';
  if (props.command.executionStatus === 'unknown') return '执行结果待核对';
  return {
    pending: '待审阅',
    approved: '已批准 · 等待执行',
    rejected: '已拒绝',
    expired: '已过期',
  }[props.command.status];
}

async function decide(decision: 'approve' | 'reject') {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    emit('changed', await decideShellCommand(props.workspaceId, props.command, decision));
  } catch (requestError) {
    error.value = requestError instanceof Error ? requestError.message : '审批提交失败，请重试';
  } finally {
    saving.value = false;
    emit('refresh');
  }
}
</script>

<template>
  <article class="shell-command-card" aria-label="Shell 命令提案">
    <header>
      <strong>Shell 命令</strong>
      <span class="status-badge" :class="command.status">{{ statusLabel() }}</span>
    </header>
    <p>{{ command.proposal.reason }}</p>
    <pre aria-label="待执行命令"><code>{{ command.proposal.command }}</code></pre>
    <details class="command-policy">
      <summary>执行边界</summary>
      <p>网络：禁用 · 工作区：读写 · 超时：{{ command.proposal.sandbox.timeoutMs }} ms</p>
      <p>
        CPU：{{ command.proposal.sandbox.cpuSeconds }} 秒 · 内存：{{
          Math.round(command.proposal.sandbox.memoryBytes / 1024 / 1024)
        }}
        MiB · 进程：{{ command.proposal.sandbox.maxProcesses }}
      </p>
      <p>工作区磁盘配额：{{ formatBytes(command.proposal.sandbox.workspaceBytes) }}</p>
      <p>
        审批摘要：<code>{{ command.digest }}</code>
      </p>
      <p>审阅有效期：{{ new Date(command.expiresAt).toLocaleString('zh-CN') }}</p>
    </details>
    <template v-if="command.result">
      <p class="result-meta">
        退出码：{{ command.result.exitCode ?? '无' }} · 信号：{{ command.result.signal ?? '无' }} ·
        耗时：{{ command.result.durationMs }} ms
      </p>
      <div v-if="command.result.resourceUsage" class="resource-usage">
        <strong>资源用量</strong>
        <p>
          cgroup：{{ command.result.resourceUsage.cgroupEnforced ? '已强制隔离' : '未启用' }} ·
          CPU：{{ (command.result.resourceUsage.cpuUsec / 1000).toFixed(0) }} ms · 内存峰值：{{
            formatBytes(command.result.resourceUsage.memoryPeakBytes)
          }}
          · 进程峰值：{{ command.result.resourceUsage.processPeak }}
        </p>
        <p>
          工作区：{{ formatBytes(command.result.resourceUsage.workspaceBytesBefore) }} →
          {{ formatBytes(command.result.resourceUsage.workspaceBytesAfter) }} /
          {{ formatBytes(command.result.resourceUsage.workspaceQuotaBytes) }}
        </p>
      </div>
      <details v-if="command.result.stdout">
        <summary>标准输出</summary>
        <pre><code>{{ command.result.stdout }}</code></pre>
      </details>
      <details v-if="command.result.stderr">
        <summary>标准错误</summary>
        <pre><code>{{ command.result.stderr }}</code></pre>
      </details>
      <p v-if="command.result.truncated" class="muted">输出达到限制，执行已终止。</p>
    </template>
    <p v-if="command.executionErrorMessage" class="form-error" role="alert">
      {{ command.executionErrorMessage }}
    </p>
    <div v-if="command.status === 'pending'" class="editor-actions">
      <button type="button" :disabled="saving" @click="decide('reject')">拒绝命令</button>
      <button
        type="button"
        class="compact-primary"
        :disabled="saving || !canApprove"
        @click="decide('approve')"
      >
        批准并执行
      </button>
    </div>
    <p v-if="command.status === 'pending' && !canApprove" class="muted">
      任务成功完成后可批准命令。
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </article>
</template>

<style scoped>
.shell-command-card {
  padding: 16px;
  border: 1px solid var(--mao-border);
  border-radius: 8px;
  background: var(--mao-surface);
  margin: 12px 0;
  font-size: 13px;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
summary {
  cursor: pointer;
  padding: 8px 0;
}
pre {
  overflow: auto;
  max-height: 320px;
  padding: 12px;
  border-radius: 8px;
  background: var(--mao-canvas);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
pre code {
  font-size: 12px;
}
.command-policy,
.result-meta,
.resource-usage {
  color: var(--mao-muted);
  overflow-wrap: anywhere;
}
.resource-usage {
  padding: 10px 12px;
  border-left: 3px solid var(--mao-border);
  background: var(--mao-canvas);
}
.resource-usage p {
  margin: 4px 0 0;
}
.status-badge.approved {
  color: var(--mao-primary);
  background: var(--mao-primary-soft);
}
</style>
