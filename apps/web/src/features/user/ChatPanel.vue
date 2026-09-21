<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { ChatMessageInput, ModelConnectionSummary } from '@agent-workbench/contracts';
import { chatWithModel, getSession } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  models: ModelConnectionSummary[];
}>();

const activeModels = computed(() =>
  props.models.filter((model) => model.status === 'active' && model.secretConfigured),
);
const selectedModelId = ref('');
const sessionId = ref('');
const messages = ref<ChatMessageInput[]>([]);
const draft = ref('');
const pending = ref(false);
const restoring = ref(false);
const error = ref('');
const transcript = ref<HTMLElement>();

watch(
  activeModels,
  (models) => {
    if (!models.some((model) => model.id === selectedModelId.value)) {
      selectedModelId.value = models[0]?.id ?? '';
    }
  },
  { immediate: true },
);

const selectedModel = computed(() =>
  activeModels.value.find((model) => model.id === selectedModelId.value),
);

const sessionStorageKey = computed(() => `agent-workbench:session:${props.workspaceId}`);

function isMessage(value: unknown): value is ChatMessageInput {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string' &&
    candidate.content.length > 0
  );
}

async function restoreSession() {
  if (!props.workspaceId) return;
  const storedSessionId = window.sessionStorage.getItem(sessionStorageKey.value);
  if (!storedSessionId) return;
  restoring.value = true;
  try {
    const detail = await getSession(props.workspaceId, storedSessionId);
    const latestRun = detail.runs.at(-1);
    const savedMessages = latestRun?.run.input.messages;
    const restored = Array.isArray(savedMessages) ? savedMessages.filter(isMessage) : [];
    const output = latestRun?.run.output?.message;
    if (isMessage(output) && output.role === 'assistant') restored.push(output);
    sessionId.value = detail.session.id;
    messages.value = restored;
    await scrollTranscript();
  } catch (requestError) {
    if (requestError instanceof Error && 'status' in requestError && requestError.status === 404) {
      window.sessionStorage.removeItem(sessionStorageKey.value);
    } else {
      error.value = '恢复对话失败，请刷新页面重试';
    }
  } finally {
    restoring.value = false;
  }
}

async function scrollTranscript() {
  await nextTick();
  if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
}

function clearConversation() {
  if (pending.value || restoring.value) return;
  messages.value = [];
  sessionId.value = '';
  window.sessionStorage.removeItem(sessionStorageKey.value);
  draft.value = '';
  error.value = '';
}

async function sendMessage() {
  const content = draft.value.trim();
  if (!content || pending.value || restoring.value) return;
  if (!selectedModelId.value) {
    error.value = '请先在管理员控制台配置并启用一个模型连接';
    return;
  }

  error.value = '';
  const userMessage: ChatMessageInput = { role: 'user', content };
  const history = [...messages.value, userMessage];
  messages.value.push(userMessage);
  draft.value = '';
  pending.value = true;
  await scrollTranscript();

  try {
    const response = await chatWithModel(props.workspaceId, {
      modelConnectionId: selectedModelId.value,
      messages: history,
      ...(sessionId.value ? { sessionId: sessionId.value } : {}),
      maxTokens: 1024,
    });
    sessionId.value = response.sessionId;
    window.sessionStorage.setItem(sessionStorageKey.value, response.sessionId);
    messages.value.push(response.message);
    await scrollTranscript();
  } catch (requestError) {
    error.value = requestError instanceof Error ? requestError.message : '对话请求失败，请稍后重试';
  } finally {
    pending.value = false;
  }
}

onMounted(() => {
  void restoreSession();
});
</script>

<template>
  <section class="chat-panel">
    <div class="chat-heading">
      <div>
        <p class="eyebrow">MODEL CHAT</p>
        <h3>和 AI 对话</h3>
        <p class="section-description">当前为同步对话，会话和每次运行记录保存在服务端。</p>
      </div>
      <button v-if="messages.length" type="button" class="quiet-button" @click="clearConversation">
        清空对话
      </button>
    </div>

    <div v-if="activeModels.length === 0" class="chat-empty">
      <strong>还没有可用模型</strong>
      <p>请先在管理员控制台配置模型 API Key，并启用至少一个模型连接。</p>
      <a href="/admin">前往模型配置</a>
    </div>

    <template v-else>
      <label class="chat-model-picker">
        使用模型
        <select v-model="selectedModelId" :disabled="pending || restoring">
          <option v-for="model in activeModels" :key="model.id" :value="model.id">
            {{ model.name }} · {{ model.modelIdentifier }}
          </option>
        </select>
      </label>

      <div ref="transcript" class="chat-transcript" aria-live="polite">
        <p v-if="restoring" role="status">正在恢复对话…</p>
        <div v-else-if="messages.length === 0" class="chat-welcome">
          <strong>从一个问题开始</strong>
          <p>可以让 AI 总结方案、解释代码，或帮助你拆解下一步工作。</p>
        </div>
        <article
          v-for="(message, index) in messages"
          :key="`${message.role}-${index}`"
          class="chat-message"
          :class="message.role"
        >
          <span class="message-author">{{ message.role === 'user' ? '你' : 'AI' }}</span>
          <p>{{ message.content }}</p>
        </article>
        <article v-if="pending" class="chat-message assistant pending-message">
          <span class="message-author">AI</span>
          <p>正在思考…</p>
        </article>
      </div>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <form class="chat-composer" @submit.prevent="sendMessage">
        <textarea
          v-model="draft"
          :disabled="pending || restoring"
          maxlength="16000"
          rows="4"
          placeholder="输入你的问题…（Ctrl/⌘ + Enter 发送）"
          @keydown.ctrl.enter.prevent="sendMessage"
          @keydown.meta.enter.prevent="sendMessage"
        ></textarea>
        <div class="chat-composer-footer">
          <span class="muted">{{ selectedModel?.name }} · 服务端调用 · 浏览器不会接触 API Key</span>
          <button
            class="compact-primary"
            type="submit"
            :disabled="pending || restoring || !draft.trim()"
          >
            {{ pending ? '发送中…' : '发送' }}
          </button>
        </div>
      </form>
    </template>
  </section>
</template>
