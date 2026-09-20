// SPDX-License-Identifier: Apache-2.0
const [spec, tokens] = await Promise.all([
  fetch('/prototype/spec.json').then((r) => r.json()),
  fetch('/tokens.json').then((r) => r.json()),
]);
for (const [key, value] of Object.entries(tokens.colors)) {
  document.documentElement.style.setProperty(`--${key}`, value);
}
const screens = new Map(spec.screens.map((screen) => [screen.id, screen]));
const app = document.querySelector('#app');
const draft = {};
let current = screens.get(spec.start);
const escape = (value = '') =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

function badge(label) {
  const tone = /失败|拒/.test(label)
    ? 'danger'
    : /审批|过期|中断/.test(label)
      ? 'warning'
      : /完成|发布|正常/.test(label)
        ? 'success'
        : 'neutral';
  return `<span class="badge ${tone}"><span aria-hidden="true">●</span> ${escape(label)}</span>`;
}
function button(action) {
  return `<button type="button" class="button ${escape(action.variant)}" data-target="${escape(action.target)}" ${action.submit ? 'data-submit="true"' : ''} ${action.disabled ? 'disabled aria-disabled="true"' : ''}>${escape(action.label)}</button>`;
}
function notice(value) {
  return value
    ? `<div class="notice ${escape(value.tone)}"><span class="notice-symbol" aria-hidden="true">${value.tone === 'danger' ? '!' : 'i'}</span><p>${escape(value.text)}</p></div>`
    : '';
}
function fields(screen) {
  if (!screen.form) return '';
  return `<form id="screen-form" class="form-panel" aria-label="${escape(screen.title)}">${screen.form
    .map((field) => {
      const attr = `id="field-${escape(field.id)}" name="${escape(field.id)}" ${field.required ? 'required' : ''}`;
      let input;
      if (field.kind === 'readonly')
        input = `<div class="readonly" id="field-${escape(field.id)}">${escape(field.value)}</div>`;
      else if (field.kind === 'textarea')
        input = `<textarea ${attr} rows="3">${escape(field.value)}</textarea>`;
      else if (field.kind === 'select')
        input = `<select ${attr}>${field.options.map((option) => `<option ${field.value === option ? 'selected' : ''}>${escape(option)}</option>`).join('')}</select>`;
      else
        input = `<input ${attr} type="${field.id === 'endpoint' ? 'url' : 'text'}" value="${escape(field.value)}" autocomplete="off" />`;
      const label =
        field.kind === 'readonly'
          ? `<span class="field-label">${escape(field.label)}</span>`
          : `<label for="field-${escape(field.id)}">${escape(field.label)}${field.required ? '<span class="required"> *</span>' : ''}</label>`;
      return `<div class="field ${field.kind === 'textarea' || field.kind === 'readonly' ? 'wide' : ''}">${label}${input}</div>`;
    })
    .join('')}</form>`;
}
function cards(screen) {
  if (!screen.cards) return '';
  return `<section class="card-grid" aria-label="${screen.section === 'agents' ? 'Agent 列表' : '相关资源'}">${screen.cards
    .map((card) => {
      const inner = `<div class="card-top"><span class="resource-icon" aria-hidden="true">${card.download ? '▤' : '◇'}</span>${card.tag ? badge(card.tag) : ''}</div><h2>${escape(card.title)}</h2><p>${escape(card.body)}</p>`;
      if (card.target)
        return `<button type="button" class="resource-card interactive" data-target="${escape(card.target)}">${inner}<span class="card-link">打开 <span aria-hidden="true">↗</span></span></button>`;
      return `<article class="resource-card">${inner}${card.download ? `<button class="text-button" data-download="${escape(card.download)}">下载演示产物 ↓</button>` : ''}</article>`;
    })
    .join('')}</section>`;
}
function table(value) {
  if (!value) return '';
  return `<section class="table-panel"><div class="panel-heading"><h2>${escape(value.title)}</h2><span>${value.rows.length} 条记录</span></div><div class="table-scroll"><table><thead><tr>${value.columns.map((c) => `<th scope="col">${escape(c)}</th>`).join('')}</tr></thead><tbody>${value.rows.map((row) => `<tr>${row.cells.map((cell, i) => `<td>${i === 0 && row.target ? `<a href="#${escape(row.target)}">${escape(cell)}</a>` : escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}
function timeline(value) {
  if (!value) return '';
  return `<section class="timeline-panel"><div class="panel-heading"><h2>执行过程</h2><span>操作与来源可追溯</span></div><ol class="timeline">${value.map((item, index) => `<li class="${escape(item.state)}"><span class="step-marker" aria-hidden="true">${item.state === 'success' ? '✓' : index + 1}</span><div><h3>${item.target ? `<a href="#${escape(item.target)}">${escape(item.title)} ↗</a>` : escape(item.title)}</h3><p>${escape(item.body)}</p><span class="step-state">${{ success: '已完成', running: '进行中', pending: '等待执行', error: '失败' }[item.state] || '等待执行'}</span></div></li>`).join('')}</ol></section>`;
}
function context(value) {
  if (!value) return '';
  return `<aside class="context-panel"><h2>任务上下文</h2><dl>${value.map((item) => `<div><dt>${escape(item.label)}</dt><dd>${escape(item.value)}</dd></div>`).join('')}</dl><div class="context-foot">配置快照与操作记录<br />始终关联到本次任务</div></aside>`;
}
function code(value) {
  return value
    ? `<section class="code-panel"><h2>${escape(value.title)}</h2><pre><code>${escape(value.value)}</code></pre><p>${escape(value.caption)}</p></section>`
    : '';
}
function render(id) {
  const screen = screens.get(id) || screens.get(spec.start);
  if (screen.kind === 'overlay') {
    if (!document.querySelector('.app-shell')) render(spec.start);
    openOverlay(screen);
    return;
  }
  current = screen;
  const title = screen.id === 'running' && draft.goal ? draft.goal : screen.title;
  document.title = `${screen.title} · Agent Workbench 原型`;
  app.innerHTML = `<div class="review-bar"><span><strong>设计原型 v${escape(spec.version)}</strong> <span class="review-label">演示数据 · 不执行真实操作</span></span><div><a href="/exports/architecture.svg" target="_blank" rel="noopener">架构图 ↗</a><label for="scenario" class="sr-only">原型场景</label><select id="scenario" aria-label="原型场景">${spec.screens
    .filter((s) => s.kind !== 'overlay')
    .map(
      (s) =>
        `<option value="${escape(s.id)}" ${s.id === screen.id ? 'selected' : ''}>${escape(s.title)}</option>`,
    )
    .join('')}</select></div></div>
  <div class="app-shell"><aside class="sidebar"><a class="brand" href="#overview"><span class="brand-mark">A</span><span>Agent<br /><strong>Workbench</strong></span></a><div class="workspace-selector"><span class="workspace-icon">研</span><div>${escape(spec.workspace)}<small>私有部署 · 演示</small></div><span aria-hidden="true">⌄</span></div><div class="nav-caption">工作台</div><nav aria-label="主导航">${spec.nav.map((item) => `<a href="#${escape(item.target)}" ${item.target === screen.section ? 'aria-current="page" class="active"' : ''}><span class="nav-glyph" aria-hidden="true">${escape(item.glyph)}</span>${escape(item.label)}${item.target === 'approval' ? '<span class="nav-count">1</span>' : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><span class="avatar">Y</span><div>yupengsheng<small>空间管理员</small></div></div></aside>
  <div class="work-area"><header class="app-header"><div>${escape(spec.workspace)}<span class="breadcrumb-divider">/</span>${escape(spec.nav.find((n) => n.target === screen.section)?.label || '任务运行')}</div><span class="environment"><span aria-hidden="true">●</span> 服务端执行</span></header>
  <main id="main" tabindex="-1"><div class="page-heading"><div><div class="eyebrow">${escape(screen.eyebrow)}</div><div class="title-line"><h1>${escape(title)}</h1>${screen.status ? badge(screen.status) : ''}</div><p class="subtitle">${escape(screen.subtitle)}</p></div><div class="actions">${screen.actions.map(button).join('')}</div></div>
  ${notice(screen.notice)}${screen.metrics ? `<section class="metrics" aria-label="运行概况">${screen.metrics.map((m) => `<article><span>${escape(m.label)}</span><strong>${escape(m.value)}</strong><small>${escape(m.note)}</small></article>`).join('')}</section>` : ''}
  <div class="main-layout ${screen.context ? 'with-context' : ''}"><div class="content-stack">${code(screen.code)}${fields(screen)}${cards(screen)}${timeline(screen.timeline)}${table(screen.table)}</div>${context(screen.context)}</div>
  ${screen.scenarios ? `<section class="scenario-controls" aria-label="演示状态"><span>评审场景</span>${screen.scenarios.map(button).join('')}</section>` : ''}
  <footer class="page-footer"><span>Agent Workbench</span><span>先明确目标，再执行可追溯的操作。</span></footer></main></div></div>`;
  document
    .querySelector('#scenario')
    .addEventListener('change', (event) => navigate(event.target.value));
  document.querySelector('#screen-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const action = screen.actions.find((item) => item.submit);
    if (action) submitAndNavigate(action.target);
  });
}
function submitAndNavigate(target) {
  const form = document.querySelector('#screen-form');
  if (form && !form.reportValidity()) return;
  if (form && current.id === 'new-run')
    Object.assign(draft, Object.fromEntries(new FormData(form)));
  navigate(target);
}
function openOverlay(screen) {
  document.querySelector('dialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.innerHTML = `<div class="dialog-icon" aria-hidden="true">!</div><h2 id="dialog-title">${escape(screen.title)}</h2><p>${escape(screen.subtitle)}</p>${notice(screen.notice)}<div class="dialog-actions">${screen.actions.map(button).join('')}</div>`;
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (location.hash.slice(1) === screen.id) location.hash = current.id;
  });
  app.append(dialog);
  dialog.showModal();
}
function navigate(target) {
  const next = screens.get(target);
  if (!next) return;
  if (next.kind === 'overlay') {
    openOverlay(next);
    return;
  }
  document.querySelector('dialog')?.close();
  if (location.hash === `#${target}`) render(target);
  else location.hash = target;
}
app.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.target) {
    if (button.dataset.submit) submitAndNavigate(button.dataset.target);
    else navigate(button.dataset.target);
  }
  if (button.dataset.download && current.downloadContent) {
    const url = URL.createObjectURL(
      new Blob([current.downloadContent], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = button.dataset.download;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
window.addEventListener('hashchange', () => {
  if (location.hash === '#main') return;
  render(location.hash.slice(1) || spec.start);
  document.querySelector('#main')?.focus({ preventScroll: true });
});
render(location.hash.slice(1) || spec.start);
