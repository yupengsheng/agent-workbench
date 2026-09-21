<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ChatMessageInput, ModelConnectionSummary } from '@agent-workbench/contracts';
import { chatWithModel } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  models: ModelConnectionSummary[];
}>();

const activeModels = computed(() =>
  props.models.filter((model) => model.status === 'active' && model.secretConfigured),
);
const selectedModelId = ref('');
const messages = ref<ChatMessageInput[]>([]);
const draft = ref('');
const pending = ref(false);
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

async function scrollTranscript() {
  await nextTick();
  if (transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
}

function clearConversation() {
  if (pending.value) return;
  messages.value = [];
  draft.value = '';
  error.value = '';
}

async function sendMessage() {
  const content = draft.value.trim();
  if (!content || pending.value) return;
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
      maxTokens: 1024,
    });
    messages.value.push(response.message);
    await scrollTranscript();
  } catch (requestError) {
    error.value = requestError instanceof Error ? requestError.message : '对话请求失败，请稍后重试';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="chat-panel">
    <div class="chat-heading">
      <div>
        <p class="eyebrow">MODEL CHAT</p>
        <h3>和 AI 对话</h3>
        <p class="section-description">当前为同步对话，消息只保存在本次浏览器会话中。</p>
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
        <select v-model="selectedModelId" :disabled="pending">
          <option v-for="model in activeModels" :key="model.id" :value="model.id">
            {{ model.name }} · {{ model.modelIdentifier }}
          </option>
        </select>
      </label>

      <div ref="transcript" class="chat-transcript" aria-live="polite">
        <div v-if="messages.length === 0" class="chat-welcome">
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
          :disabled="pending"
          maxlength="16000"
          rows="4"
          placeholder="输入你的问题…（Ctrl/⌘ + Enter 发送）"
          @keydown.ctrl.enter.prevent="sendMessage"
          @keydown.meta.enter.prevent="sendMessage"
        ></textarea>
        <div class="chat-composer-footer">
          <span class="muted"
            >{{ selectedModel?.name }} · 服务端调用 · 不会把 API Key 发送给模型</span
          >
          <button class="compact-primary" type="submit" :disabled="pending || !draft.trim()">
            {{ pending ? '发送中…' : '发送' }}
          </button>
        </div>
      </form>
    </template>
  </section>
</template>
