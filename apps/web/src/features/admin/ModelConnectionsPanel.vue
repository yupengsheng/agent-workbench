<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type {
  ModelConnectionInput,
  ModelConnectionStatus,
  ModelConnectionSummary,
} from '@agent-workbench/contracts';
import { createModelConnection, testModelConnection, updateModelConnection } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  models: ModelConnectionSummary[];
  canManage: boolean;
}>();

const emit = defineEmits<{
  changed: [];
}>();

type ProviderPreset = 'deepseek' | 'openai-compatible';

interface ModelForm {
  name: string;
  provider: ProviderPreset;
  modelIdentifier: string;
  secret: string;
  baseUrl: string;
  capabilities: Record<string, boolean>;
  status: ModelConnectionStatus;
}

const providerOptions: Array<{ value: ProviderPreset; label: string; description: string }> = [
  {
    value: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方 OpenAI-compatible API',
  },
  {
    value: 'openai-compatible',
    label: '自研 / OpenAI-compatible',
    description: '内部模型或兼容 OpenAI Chat Completions 的服务',
  },
];

const capabilityOptions = [
  { key: 'streaming', label: '流式输出' },
  { key: 'tools', label: '工具调用' },
  { key: 'shell', label: '受控 Shell（需沙箱）' },
  { key: 'web', label: '受控网页获取（需白名单）' },
  { key: 'vision', label: '视觉输入' },
  { key: 'json_mode', label: 'JSON 模式' },
];

function emptyForm(): ModelForm {
  return {
    name: '',
    provider: 'deepseek',
    modelIdentifier: 'deepseek-chat',
    secret: '',
    baseUrl: 'https://api.deepseek.com',
    capabilities: { streaming: true, tools: true },
    status: 'active',
  };
}

const draft = reactive<ModelForm>(emptyForm());
const editorOpen = ref(false);
const editingId = ref<string>();
const saving = ref(false);
const testingId = ref<string>();
const togglingId = ref<string>();
const formError = ref('');
const actionError = ref('');
const notice = ref('');

const editingModel = computed(() => props.models.find((model) => model.id === editingId.value));

function resetDraft() {
  Object.assign(draft, emptyForm());
}

function openCreate() {
  resetDraft();
  editingId.value = undefined;
  formError.value = '';
  actionError.value = '';
  notice.value = '';
  editorOpen.value = true;
}

function openEdit(model: ModelConnectionSummary) {
  Object.assign(draft, {
    name: model.name,
    provider: model.provider === 'deepseek' ? 'deepseek' : 'openai-compatible',
    modelIdentifier: model.modelIdentifier,
    secret: '',
    baseUrl: model.baseUrl,
    capabilities: { ...model.capabilities },
    status: model.status,
  });
  editingId.value = model.id;
  formError.value = '';
  actionError.value = '';
  notice.value = '';
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
  editingId.value = undefined;
  formError.value = '';
}

function selectProvider() {
  if (draft.provider === 'deepseek') {
    if (!draft.baseUrl || draft.baseUrl === 'https://api.openai.com/v1') {
      draft.baseUrl = 'https://api.deepseek.com';
    }
    if (!editingId.value && (!draft.modelIdentifier || draft.modelIdentifier === 'gpt-4o')) {
      draft.modelIdentifier = 'deepseek-chat';
    }
  } else {
    if (!draft.baseUrl || draft.baseUrl === 'https://api.deepseek.com') {
      draft.baseUrl = 'https://your-model.example.com/v1';
    }
    if (!editingId.value && (!draft.modelIdentifier || draft.modelIdentifier === 'deepseek-chat')) {
      draft.modelIdentifier = 'your-model';
    }
  }
}

function setCapability(key: string, enabled: boolean) {
  draft.capabilities = { ...draft.capabilities, [key]: enabled };
}

function buildInput(): ModelConnectionInput | undefined {
  const name = draft.name.trim();
  const modelIdentifier = draft.modelIdentifier.trim();
  const baseUrl = draft.baseUrl.trim();
  const secret = draft.secret.trim();
  if (!name || !modelIdentifier || !baseUrl) {
    formError.value = '名称、模型标识和 Base URL 不能为空';
    return undefined;
  }
  if (!editingId.value && !secret) {
    formError.value = '请填写模型 API Key；密钥会在服务端加密保存';
    return undefined;
  }
  return {
    name,
    provider: draft.provider,
    modelIdentifier,
    ...(secret ? { secret } : {}),
    baseUrl,
    capabilities: draft.capabilities,
  };
}

async function saveModel() {
  formError.value = '';
  notice.value = '';
  const input = buildInput();
  if (!input || !props.workspaceId) return;

  saving.value = true;
  try {
    if (editingId.value) {
      const update: Partial<ModelConnectionInput> & { status?: ModelConnectionStatus } = {
        name: input.name,
        modelIdentifier: input.modelIdentifier,
        baseUrl: input.baseUrl,
        capabilities: input.capabilities,
        status: draft.status,
      };
      if (input.secret) update.secret = input.secret;
      await updateModelConnection(props.workspaceId, editingId.value, update);
      notice.value = '模型连接已更新';
    } else {
      await createModelConnection(props.workspaceId, input);
      notice.value = '模型连接已创建';
    }
    closeEditor();
    emit('changed');
  } catch (error) {
    formError.value = error instanceof Error ? error.message : '模型连接保存失败';
  } finally {
    saving.value = false;
  }
}

async function testModel(model: ModelConnectionSummary) {
  actionError.value = '';
  notice.value = '';
  testingId.value = model.id;
  try {
    const result = await testModelConnection(props.workspaceId, model.id);
    notice.value = `连接测试成功：${result.model}`;
    emit('changed');
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '模型连接测试失败';
    emit('changed');
  } finally {
    testingId.value = undefined;
  }
}

async function toggleModel(model: ModelConnectionSummary) {
  actionError.value = '';
  notice.value = '';
  togglingId.value = model.id;
  try {
    await updateModelConnection(props.workspaceId, model.id, {
      status: model.status === 'active' ? 'disabled' : 'active',
    });
    notice.value = model.status === 'active' ? '模型连接已停用' : '模型连接已启用';
    emit('changed');
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '模型连接状态更新失败';
  } finally {
    togglingId.value = undefined;
  }
}

function providerLabel(provider: string) {
  return provider === 'deepseek' ? 'DeepSeek' : 'OpenAI-compatible';
}

function statusLabel(status: ModelConnectionStatus) {
  return status === 'active' ? '启用中' : '已停用';
}

function testStatusLabel(status: ModelConnectionSummary['lastTestStatus']) {
  return status === 'passed' ? '已验证' : status === 'failed' ? '测试失败' : '未测试';
}

function formatDate(value: string | null) {
  if (!value) return '尚未测试';
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
</script>

<template>
  <section class="data-card model-console">
    <div class="section-heading">
      <div>
        <h3>模型连接</h3>
        <p class="section-description">
          配置 DeepSeek 或内部 OpenAI-compatible 模型，密钥只保存在服务端引用中。
        </p>
      </div>
      <button v-if="canManage" type="button" class="compact-primary" @click="openCreate">
        新增模型
      </button>
    </div>

    <p v-if="!canManage" class="notice">
      当前角色只有查看权限，模型配置由 workspace owner 或 admin 管理。
    </p>
    <p v-if="notice" class="success-message" role="status">{{ notice }}</p>
    <p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>

    <form v-if="editorOpen" class="model-editor" novalidate @submit.prevent="saveModel">
      <div class="editor-heading">
        <div>
          <p class="eyebrow">{{ editingId ? 'EDIT CONNECTION' : 'NEW CONNECTION' }}</p>
          <h4>{{ editingId ? '编辑模型连接' : '新增模型连接' }}</h4>
        </div>
        <span v-if="editingModel" class="status-badge" :class="editingModel.status">
          {{ statusLabel(editingModel.status) }}
        </span>
      </div>

      <div class="form-grid">
        <label>
          显示名称
          <input
            v-model="draft.name"
            type="text"
            maxlength="120"
            placeholder="例如：团队 DeepSeek"
          />
        </label>
        <label>
          提供方
          <select v-model="draft.provider" :disabled="Boolean(editingId)" @change="selectProvider">
            <option v-for="option in providerOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <small>{{
            providerOptions.find((option) => option.value === draft.provider)?.description
          }}</small>
        </label>
        <label>
          模型标识
          <input
            v-model="draft.modelIdentifier"
            type="text"
            maxlength="200"
            placeholder="deepseek-chat"
          />
        </label>
        <label>
          Base URL
          <input
            v-model="draft.baseUrl"
            type="url"
            maxlength="512"
            placeholder="https://api.deepseek.com"
          />
          <small>服务端会调用该地址的 <code>/chat/completions</code>。</small>
        </label>
        <label class="form-grid-wide">
          模型 API Key
          <input
            v-model="draft.secret"
            type="password"
            autocomplete="new-password"
            maxlength="4096"
            :placeholder="editingId ? '留空表示保持当前密钥' : '输入模型 API Key'"
          />
          <small
            >生产环境请通过 HTTPS 提交密钥；当前测试地址是 HTTP，请先配置
            HTTPS。服务端会用主密钥加密保存，编辑时留空表示保持当前密钥。</small
          >
        </label>
      </div>

      <fieldset class="capability-fieldset">
        <legend>能力声明</legend>
        <label v-for="option in capabilityOptions" :key="option.key" class="checkbox-label">
          <input
            type="checkbox"
            :checked="Boolean(draft.capabilities[option.key])"
            @change="setCapability(option.key, ($event.target as HTMLInputElement).checked)"
          />
          {{ option.label }}
        </label>
      </fieldset>

      <label v-if="editingId" class="checkbox-label status-toggle">
        <input v-model="draft.status" type="checkbox" true-value="active" false-value="disabled" />
        启用此连接
      </label>

      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <div class="editor-actions">
        <button type="button" @click="closeEditor">取消</button>
        <button type="submit" class="compact-primary" :disabled="saving">
          {{ saving ? '保存中…' : editingId ? '保存修改' : '创建连接' }}
        </button>
      </div>
    </form>

    <p v-if="models.length === 0 && !editorOpen" class="empty-state">
      当前工作空间还没有模型连接。新增后可以测试服务端密钥和模型连通性。
    </p>
    <div v-for="model in models" :key="model.id" class="data-row model-row">
      <div class="model-info">
        <div class="model-title-line">
          <strong>{{ model.name }}</strong>
          <span class="status-badge" :class="model.status">{{ statusLabel(model.status) }}</span>
        </div>
        <small>{{ providerLabel(model.provider) }} · {{ model.modelIdentifier }}</small>
        <small class="model-meta">
          {{ model.secretConfigured ? '服务端密钥已配置' : '未配置密钥' }} · {{ model.baseUrl }}
        </small>
        <small class="model-meta">
          最近测试：{{ testStatusLabel(model.lastTestStatus) }} ·
          {{ formatDate(model.lastTestedAt) }}
        </small>
      </div>
      <div v-if="canManage" class="row-actions">
        <button
          type="button"
          :disabled="Boolean(testingId || togglingId) || model.status !== 'active'"
          @click="testModel(model)"
        >
          {{ testingId === model.id ? '测试中…' : '测试连接' }}
        </button>
        <button type="button" :disabled="Boolean(testingId || togglingId)" @click="openEdit(model)">
          编辑
        </button>
        <button
          type="button"
          :disabled="Boolean(testingId || togglingId)"
          @click="toggleModel(model)"
        >
          {{ togglingId === model.id ? '处理中…' : model.status === 'active' ? '停用' : '启用' }}
        </button>
      </div>
    </div>
  </section>
</template>
