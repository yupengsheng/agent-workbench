<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { AgentListResponse, ModelConnectionListResponse } from '@agent-workbench/contracts';
import { Bot, Plus, X } from '@lucide/vue';
import { createAgent } from '../../lib/api';

const props = defineProps<{
  workspaceId: string;
  agents: AgentListResponse['agents'];
  models: ModelConnectionListResponse['connections'];
  canManage: boolean;
}>();

const emit = defineEmits<{ changed: [] }>();

const editorOpen = ref(false);
const saving = ref(false);
const formError = ref('');
const notice = ref('');
const draft = reactive({
  name: '',
  slug: '',
  description: '',
  modelConnectionId: '',
  systemPrompt: '',
});

const activeModels = computed(() => props.models.filter((model) => model.status === 'active'));

function openEditor() {
  draft.name = '';
  draft.slug = '';
  draft.description = '';
  draft.modelConnectionId = activeModels.value[0]?.id ?? '';
  draft.systemPrompt = '';
  formError.value = '';
  notice.value = '';
  editorOpen.value = true;
}

function closeEditor() {
  if (!saving.value) editorOpen.value = false;
}

function makeSlug() {
  if (draft.slug || !draft.name) return;
  draft.slug = draft.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function saveAgent() {
  formError.value = '';
  notice.value = '';
  makeSlug();
  if (!draft.name.trim() || !draft.slug.trim()) {
    formError.value = '名称和标识不能为空';
    return;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(draft.slug)) {
    formError.value = '标识只能使用小写字母、数字和连字符';
    return;
  }

  saving.value = true;
  try {
    await createAgent(props.workspaceId, {
      name: draft.name.trim(),
      slug: draft.slug.trim(),
      description: draft.description.trim(),
      config: {
        ...(draft.modelConnectionId ? { modelConnectionId: draft.modelConnectionId } : {}),
        ...(draft.systemPrompt.trim() ? { systemPrompt: draft.systemPrompt.trim() } : {}),
      },
    });
    editorOpen.value = false;
    notice.value = 'Agent 草稿已创建';
    emit('changed');
  } catch (error) {
    formError.value = error instanceof Error ? error.message : 'Agent 创建失败';
  } finally {
    saving.value = false;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
</script>

<template>
  <section class="data-card agent-console">
    <div class="section-heading">
      <div>
        <h3>Agent 管理</h3>
        <p class="section-description">管理工作空间中的 Agent 配置与发布状态。</p>
      </div>
      <button v-if="canManage" type="button" class="compact-primary" @click="openEditor">
        <Plus :size="16" aria-hidden="true" />
        新增 Agent
      </button>
    </div>

    <p v-if="notice" class="success-message" role="status">{{ notice }}</p>
    <p v-if="!canManage" class="notice">当前角色只有查看权限。</p>

    <form
      v-if="editorOpen"
      class="model-editor agent-editor"
      novalidate
      @submit.prevent="saveAgent"
    >
      <div class="editor-heading">
        <div>
          <p class="eyebrow">NEW AGENT</p>
          <h4>新增 Agent</h4>
        </div>
        <button
          type="button"
          class="icon-close-button"
          aria-label="关闭"
          title="关闭"
          @click="closeEditor"
        >
          <X :size="17" aria-hidden="true" />
        </button>
      </div>
      <div class="form-grid">
        <label>
          名称
          <input
            v-model="draft.name"
            type="text"
            maxlength="120"
            placeholder="例如：代码助手"
            @blur="makeSlug"
          />
        </label>
        <label>
          标识
          <input v-model="draft.slug" type="text" maxlength="64" placeholder="coding-agent" />
        </label>
        <label class="form-grid-wide">
          描述
          <input
            v-model="draft.description"
            type="text"
            maxlength="1000"
            placeholder="Agent 的职责与使用范围"
          />
        </label>
        <label>
          默认模型
          <select v-model="draft.modelConnectionId">
            <option value="">不指定</option>
            <option v-for="model in activeModels" :key="model.id" :value="model.id">
              {{ model.name }} · {{ model.modelIdentifier }}
            </option>
          </select>
        </label>
        <label class="form-grid-wide">
          系统提示词
          <textarea
            v-model="draft.systemPrompt"
            rows="5"
            maxlength="12000"
            placeholder="定义 Agent 的职责、边界和输出要求"
          ></textarea>
        </label>
      </div>
      <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
      <div class="editor-actions">
        <button type="button" @click="closeEditor">取消</button>
        <button type="submit" class="compact-primary" :disabled="saving">
          {{ saving ? '创建中…' : '创建草稿' }}
        </button>
      </div>
    </form>

    <p v-if="agents.length === 0 && !editorOpen" class="empty-state">当前工作空间还没有 Agent。</p>
    <div v-else class="agent-table" role="table" aria-label="Agent 列表">
      <div class="agent-table-head" role="row">
        <span role="columnheader">名称</span>
        <span role="columnheader">标识</span>
        <span role="columnheader">发布状态</span>
        <span role="columnheader">更新时间</span>
      </div>
      <div v-for="agent in agents" :key="agent.id" class="agent-table-row" role="row">
        <span class="agent-name-cell" role="cell">
          <span class="agent-glyph"><Bot :size="16" aria-hidden="true" /></span>
          <span
            ><strong>{{ agent.name }}</strong
            ><small>{{ agent.description || '暂无描述' }}</small></span
          >
        </span>
        <code role="cell">{{ agent.slug }}</code>
        <span role="cell">
          <span class="status-badge" :class="agent.currentVersionId ? 'active' : 'disabled'">
            {{ agent.currentVersionId ? '已发布' : '草稿' }}
          </span>
        </span>
        <time role="cell" :datetime="agent.updatedAt">{{ formatDate(agent.updatedAt) }}</time>
      </div>
    </div>
  </section>
</template>

<style scoped>
.agent-console {
  border-radius: 4px;
}

.section-heading .compact-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.agent-editor textarea {
  display: block;
  width: 100%;
  margin-top: 7px;
  resize: vertical;
  border: 1px solid #cad5dd;
  border-radius: 7px;
  color: #1b2b39;
  background: white;
  font: inherit;
  line-height: 1.55;
  padding: 10px 11px;
}

.icon-close-button {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  border: 0;
  color: var(--mao-muted);
  background: transparent;
}

.agent-table {
  min-width: 680px;
}

.agent-table-head,
.agent-table-row {
  display: grid;
  grid-template-columns: minmax(220px, 1.5fr) minmax(130px, 0.8fr) 100px 155px;
  align-items: center;
  gap: 16px;
}

.agent-table-head {
  min-height: 42px;
  padding: 0 12px;
  border-top: 1px solid var(--mao-divider);
  border-bottom: 1px solid var(--mao-border);
  color: var(--mao-muted);
  background: #fafafa;
  font-size: 12px;
  font-weight: 500;
}

.agent-table-row {
  min-height: 66px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--mao-divider);
  color: var(--mao-muted);
  font-size: 12px;
}

.agent-table-row:last-child {
  border-bottom: 0;
}

.agent-name-cell {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 10px;
}

.agent-name-cell > span:last-child {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.agent-name-cell strong,
.agent-name-cell small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-name-cell strong {
  color: var(--mao-ink);
  font-size: 13px;
  font-weight: 600;
}

.agent-name-cell small {
  color: var(--mao-muted);
  font-size: 11px;
}

.agent-glyph {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  place-items: center;
  border-radius: 6px;
  color: var(--mao-primary);
  background: var(--mao-primary-soft);
}

.agent-table-row code {
  overflow: hidden;
  color: var(--mao-ink);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-table-row time {
  white-space: nowrap;
}

@media (max-width: 768px) {
  .agent-console {
    overflow-x: auto;
  }

  .agent-editor {
    min-width: 0;
  }

  .agent-table {
    min-width: 0;
  }

  .agent-table-head {
    display: none;
  }

  .agent-table-row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px 12px;
    padding: 14px 4px;
  }

  .agent-name-cell {
    grid-column: 1 / -1;
  }

  .agent-table-row code,
  .agent-table-row time {
    font-size: 10px;
  }
}
</style>
