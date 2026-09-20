<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { getHealth } from './lib/api';

const state = ref<'checking' | 'connected' | 'unavailable'>('checking');
const detail = ref('正在检查服务连接');

async function refresh() {
  state.value = 'checking';
  detail.value = '正在检查服务连接';
  try {
    const health = await getHealth();
    state.value = 'connected';
    detail.value = `API ${health.apiVersion} · 连接正常`;
  } catch (error) {
    state.value = 'unavailable';
    detail.value = error instanceof Error ? error.message : '服务暂时不可用';
  }
}

onMounted(refresh);
</script>

<template>
  <div class="workspace">
    <header class="topbar">
      <a class="brand" href="/" aria-label="Agent Workbench 首页">
        <span class="brand-mark" aria-hidden="true">A</span>
        Agent Workbench
      </a>
      <span class="badge">开发预览</span>
    </header>

    <main>
      <p class="eyebrow">PRIVATE AGENT WORKSPACE</p>
      <h1>让 Agent 在你的环境里工作。</h1>
      <p class="intro">在一个工作台中配置智能体、执行任务，查看操作过程与交付结果。</p>

      <section class="connection" aria-labelledby="connection-title">
        <div>
          <h2 id="connection-title">服务连接</h2>
          <p role="status" aria-live="polite">
            <span class="status-dot" :class="state" aria-hidden="true"></span>
            {{ detail }}
          </p>
        </div>
        <button :disabled="state === 'checking'" @click="refresh">
          {{ state === 'checking' ? '检查中…' : '重新检查' }}
        </button>
      </section>

      <section class="modules" aria-label="计划中的核心能力">
        <article>
          <span class="module-number">01</span>
          <h2>配置 Agent</h2>
          <p>选择模型、定义职责，绑定工具与技能。</p>
          <span class="planned">待开发</span>
        </article>
        <article>
          <span class="module-number">02</span>
          <h2>执行任务</h2>
          <p>关联工作区，跟踪主任务和子任务的进展。</p>
          <span class="planned">待开发</span>
        </article>
        <article>
          <span class="module-number">03</span>
          <h2>审核与追溯</h2>
          <p>审批受控操作，查看调用记录和任务产物。</p>
          <span class="planned">待开发</span>
        </article>
      </section>

      <p class="notice">当前版本用于验证开发环境，模型接入与任务执行尚未开放。</p>
    </main>
    <footer>Agent Workbench · 私有化部署 · 多 Agent 协作</footer>
  </div>
</template>
