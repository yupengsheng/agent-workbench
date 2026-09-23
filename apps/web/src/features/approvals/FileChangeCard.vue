<script setup lang="ts">
import { ref } from 'vue';
import type { FileChangeSummary } from '@agent-workbench/contracts';
import { decideFileChange } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  change: FileChangeSummary;
  canApprove: boolean;
}>();
const emit = defineEmits<{ changed: [change: FileChangeSummary]; refresh: [] }>();
const saving = ref(false);
const error = ref('');
const statusLabels = {
  pending: '待审阅',
  approved: '已批准 · 等待应用',
  rejected: '已拒绝',
  expired: '已过期',
};

function statusLabel() {
  if (props.change.applicationStatus === 'applied') return '已应用';
  if (props.change.applicationStatus === 'failed') return '应用失败';
  if (props.change.applicationStatus === 'unknown') return '应用结果待核对';
  return statusLabels[props.change.status];
}

async function decide(decision: 'approve' | 'reject') {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    emit('changed', await decideFileChange(props.workspaceId, props.change, decision));
  } catch (requestError) {
    error.value = requestError instanceof Error ? requestError.message : '审批提交失败，请重试';
  } finally {
    saving.value = false;
    // A timed-out request may have committed. Re-read state before retrying.
    emit('refresh');
  }
}
</script>

<template>
  <article class="file-change-card" aria-label="文件变更提案">
    <header>
      <strong>{{ change.preview.path }}</strong>
      <span class="status-badge" :class="change.status">{{ statusLabel() }}</span>
    </header>
    <p>{{ change.preview.reason }}</p>
    <details open>
      <summary>查看完整差异</summary>
      <pre aria-label="文件差异"><code>{{ change.preview.patch }}</code></pre>
    </details>
    <details class="file-change-fingerprint">
      <summary>版本校验信息</summary>
      <p>
        修改前 SHA-256：<code>{{ change.preview.before.sha256 }}</code>
      </p>
      <p>
        修改后 SHA-256：<code>{{ change.preview.after.sha256 }}</code>
      </p>
      <p>
        提案摘要：<code>{{ change.digest }}</code>
      </p>
      <p>审阅有效期：{{ new Date(change.expiresAt).toLocaleString('zh-CN') }}</p>
    </details>
    <p v-if="change.applicationStatus === 'not_started'" class="muted">
      批准已记录，Runner 将在重新校验文件后应用提案。
    </p>
    <p v-else-if="change.applicationStatus === 'applying'" class="muted">正在应用提案…</p>
    <p v-else-if="change.applicationStatus === 'applied'" class="muted">文件已按审批内容应用。</p>
    <p v-else-if="change.applyErrorMessage" class="form-error" role="alert">
      {{ change.applyErrorMessage }}
    </p>
    <div v-if="change.status === 'pending'" class="editor-actions">
      <button type="button" :disabled="saving" @click="decide('reject')">拒绝提案</button>
      <button
        type="button"
        class="compact-primary"
        :disabled="saving || !canApprove"
        @click="decide('approve')"
      >
        批准提案
      </button>
    </div>
    <p v-if="change.status === 'pending' && !canApprove" class="muted">
      任务成功完成后可批准提案。
    </p>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </article>
</template>

<style scoped>
.file-change-card {
  padding: 16px;
  border: 1px solid var(--mao-border);
  border-radius: 10px;
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
header strong {
  overflow-wrap: anywhere;
  min-width: 0;
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
  white-space: pre;
}
pre code {
  font-size: 12px;
}
.file-change-fingerprint {
  color: var(--mao-muted);
  overflow-wrap: anywhere;
}
.status-badge.approved {
  color: var(--mao-primary);
  background: var(--mao-primary-soft);
}
</style>
