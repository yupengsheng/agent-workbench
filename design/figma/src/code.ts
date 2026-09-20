/// <reference types="@figma/plugin-typings" />

import prototype from '../../prototype/spec.json';
import tokens from '../../tokens.json';
import architecture from '../../architecture.json';

type Screen = (typeof prototype.screens)[number];
type Action = (typeof prototype.screens)[number]['actions'][number];
type ColorName = keyof typeof tokens.colors;

const C = tokens.colors;
const FONT = { family: 'Inter', regular: 'Regular', semibold: 'Semi Bold' };
const FLOW = { width: 1200, height: 820, sidebar: 216, header: 64 };
const screenNodes = new Map<string, FrameNode>();
const actionNodes: Array<{ node: FrameNode; action: Action }> = [];

function color(name: ColorName): RGB {
  const hex = C[name].replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

function paint(name: ColorName): SolidPaint {
  return { type: 'SOLID', color: color(name) };
}

async function loadFonts() {
  await Promise.all([
    figma.loadFontAsync({ family: FONT.family, style: FONT.regular }),
    figma.loadFontAsync({ family: FONT.family, style: FONT.semibold }),
  ]);
}

function frame(
  parent: BaseNode & ChildrenMixin,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: ColorName,
  radius = 0,
): FrameNode {
  const node = figma.createFrame();
  node.name = name;
  node.resize(width, height);
  node.x = x;
  node.y = y;
  node.fills = [paint(fill)];
  node.cornerRadius = radius;
  node.clipsContent = false;
  parent.appendChild(node);
  return node;
}

function rect(
  parent: BaseNode & ChildrenMixin,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: ColorName,
  radius = 0,
): RectangleNode {
  const node = figma.createRectangle();
  node.name = 'Shape';
  node.resize(width, height);
  node.x = x;
  node.y = y;
  node.fills = [paint(fill)];
  node.cornerRadius = radius;
  parent.appendChild(node);
  return node;
}

async function text(
  parent: BaseNode & ChildrenMixin,
  value: string,
  x: number,
  y: number,
  size: number,
  fill: ColorName = 'ink',
  bold = false,
  width?: number,
): Promise<TextNode> {
  const node = figma.createText();
  node.name = value.slice(0, 40);
  node.fontName = { family: FONT.family, style: bold ? FONT.semibold : FONT.regular };
  node.fontSize = size;
  node.fills = [paint(fill)];
  node.characters = value;
  node.x = x;
  node.y = y;
  if (width) {
    node.resize(width, Math.max(20, node.height));
    node.textAutoResize = 'HEIGHT';
  } else {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
  }
  parent.appendChild(node);
  return node;
}

function statusFill(label: string): ColorName {
  if (/失败|拒|过期/.test(label)) return 'dangerSoft';
  if (/审批|中断/.test(label)) return 'warningSoft';
  if (/完成|发布|正常|运行中/.test(label)) return 'primarySoft';
  return 'blueSoft';
}

async function badge(parent: BaseNode & ChildrenMixin, label: string, x: number, y: number) {
  const width = Math.max(56, label.length * 12 + 18);
  frame(parent, `Status / ${label}`, x, y, width, 25, statusFill(label), 5);
  await text(parent, label, x + 9, y + 6, 10, /失败|拒/.test(label) ? 'danger' : 'primary', true);
}

async function button(
  parent: BaseNode & ChildrenMixin,
  action: Action,
  x: number,
  y: number,
  width = 122,
) {
  const fill: ColorName =
    action.variant === 'primary'
      ? 'primary'
      : action.variant === 'danger'
        ? 'dangerSoft'
        : 'surface';
  const ink: ColorName =
    action.variant === 'primary' ? 'surface' : action.variant === 'danger' ? 'danger' : 'ink';
  const node = frame(parent, `Button / ${action.label}`, x, y, width, 35, fill, 7);
  node.strokes = [
    paint(
      action.variant === 'primary' ? 'primary' : action.variant === 'danger' ? 'danger' : 'border',
    ),
  ];
  node.strokeWeight = 1;
  await text(node, action.label, 0, 9, 11, ink, true, width);
  actionNodes.push({ node, action });
  return node;
}

async function navItem(
  parent: BaseNode & ChildrenMixin,
  label: string,
  target: string,
  y: number,
  glyph: string,
  active: boolean,
) {
  const node = frame(
    parent,
    `Navigation / ${label}`,
    14,
    y,
    188,
    38,
    active ? 'primarySoft' : 'sidebar',
    7,
  );
  await text(node, glyph, 14, 9, 16, active ? 'primary' : 'muted', false);
  await text(node, label, 44, 11, 11, active ? 'primary' : 'muted', active, 128);
  if (target && screenNodes.has(target))
    actionNodes.push({ node, action: { label, target, variant: 'secondary' } });
}

async function createFoundations() {
  const page = figma.createPage();
  page.name = '00 Foundations';
  await figma.setCurrentPageAsync(page);
  const canvas = frame(page, 'Foundation / Design Tokens', 0, 0, 1160, 760, 'canvas', 0);
  await text(canvas, 'Agent Workbench', 48, 48, 30, 'ink', true);
  await text(canvas, '设计基础 · tokens · 可复用组件', 50, 92, 13, 'muted');
  await text(canvas, 'Color tokens', 50, 156, 16, 'ink', true);
  const swatches: Array<[string, ColorName]> = [
    ['Canvas', 'canvas'],
    ['Surface', 'surface'],
    ['Primary', 'primary'],
    ['Primary soft', 'primarySoft'],
    ['Warning', 'warning'],
    ['Danger', 'danger'],
  ];
  for (const [label, name] of swatches) {
    const i = swatches.findIndex((item) => item[0] === label);
    rect(canvas, 50 + i * 170, 198, 130, 62, name, 8);
    await text(canvas, label, 50 + i * 170, 272, 11, 'muted');
    await text(canvas, C[name], 50 + i * 170, 291, 10, 'muted');
  }
  await text(canvas, 'Component set', 50, 350, 16, 'ink', true);
  const componentNames = [
    'Button / Primary',
    'Button / Secondary',
    'Status / Running',
    'Status / Waiting',
    'Status / Failed',
    'Artifact Card',
  ];
  for (const [i, label] of componentNames.entries()) {
    const x = 50 + (i % 3) * 220;
    const y = 392 + Math.floor(i / 3) * 116;
    const component = figma.createComponent();
    component.name = label;
    component.resize(180, 72);
    component.x = x;
    component.y = y;
    component.fills = [paint('surface')];
    component.strokes = [paint('border')];
    component.strokeWeight = 1;
    component.cornerRadius = 8;
    page.appendChild(component);
    await text(component, label, 14, 14, 11, 'ink', true, 155);
    rect(
      component,
      14,
      40,
      label === 'Artifact Card' ? 120 : 90,
      15,
      label.includes('Failed')
        ? 'dangerSoft'
        : label.includes('Waiting')
          ? 'warningSoft'
          : label.includes('Running')
            ? 'primarySoft'
            : label.includes('Primary')
              ? 'primary'
              : 'surface',
      4,
    );
  }
  await text(
    canvas,
    '状态与动作必须由业务状态驱动；组件本身不拥有权限。',
    50,
    668,
    11,
    'muted',
    false,
    760,
  );
  return page;
}

async function createScreen(page: PageNode, screen: Screen, index: number) {
  const columns = 2;
  const gap = 100;
  const x = 40 + (index % columns) * (FLOW.width + gap);
  const y = 40 + Math.floor(index / columns) * (FLOW.height + 90);
  const root = frame(page, `Screen / ${screen.id}`, x, y, FLOW.width, FLOW.height, 'canvas', 0);
  screenNodes.set(screen.id, root);
  if (screen.kind === 'overlay') {
    root.fills = [paint('surface')];
    root.resize(480, 300);
    await text(root, screen.title, 34, 35, 21, 'ink', true, 410);
    await text(root, screen.subtitle, 34, 80, 12, 'muted', false, 410);
    if (screen.notice) {
      frame(
        root,
        'Notice',
        34,
        132,
        410,
        54,
        screen.notice.tone === 'danger' ? 'dangerSoft' : 'warningSoft',
        7,
      );
      await text(
        root,
        screen.notice.text,
        50,
        148,
        11,
        screen.notice.tone === 'danger' ? 'danger' : 'warning',
        false,
        375,
      );
    }
    for (const [i, action] of screen.actions.entries())
      await button(root, action, 34 + i * 145, 236, 130);
    return root;
  }
  rect(root, 0, 0, FLOW.sidebar, FLOW.height, 'sidebar');
  rect(root, FLOW.sidebar, 0, FLOW.width - FLOW.sidebar, FLOW.header, 'surface');
  rect(
    root,
    FLOW.sidebar,
    FLOW.header,
    FLOW.width - FLOW.sidebar,
    FLOW.height - FLOW.header,
    'canvas',
  );
  await text(root, 'A', 28, 29, 22, 'surface', true);
  await text(root, 'Agent Workbench', 73, 31, 12, 'ink', true);
  await text(root, '研 发 工 作 空 间', 27, 101, 10, 'muted', true);
  for (const [i, item] of prototype.nav.entries())
    await navItem(
      root,
      item.label,
      item.target === screen.section ? '' : item.target,
      132 + i * 42,
      item.glyph,
      item.target === screen.section,
    );
  await text(root, 'yupengsheng', 56, FLOW.height - 52, 10, 'ink', true);
  await text(root, '空间管理员', 56, FLOW.height - 35, 9, 'muted');
  await text(
    root,
    '研发工作空间 / ' +
      (prototype.nav.find((item) => item.target === screen.section)?.label || '任务运行'),
    FLOW.sidebar + 32,
    24,
    10,
    'muted',
  );
  await text(root, screen.eyebrow, FLOW.sidebar + 32, 102, 9, 'muted');
  await text(root, screen.title, FLOW.sidebar + 32, 126, 24, 'ink', true, 620);
  await text(root, screen.subtitle, FLOW.sidebar + 32, 168, 11, 'muted', false, 660);
  if (screen.status) await badge(root, screen.status, FLOW.sidebar + 32, 200);
  const buttonY = 120;
  for (const [i, action] of screen.actions.entries())
    await button(root, action, FLOW.width - 170 - i * 140, buttonY, 125);
  if (screen.metrics) {
    for (const [i, metric] of screen.metrics.entries()) {
      const m = frame(
        root,
        `Metric / ${metric.label}`,
        FLOW.sidebar + 32 + i * 205,
        236,
        185,
        82,
        'surface',
        8,
      );
      m.strokes = [paint('border')];
      m.strokeWeight = 1;
      await text(m, metric.label, 15, 14, 10, 'muted');
      await text(m, metric.value, 15, 36, 22, 'ink', true);
      await text(m, metric.note, 15, 65, 9, 'muted', false, 160);
    }
  }
  if (screen.notice) {
    const n = frame(
      root,
      'Notice',
      FLOW.sidebar + 32,
      236,
      690,
      48,
      screen.notice.tone === 'danger'
        ? 'dangerSoft'
        : screen.notice.tone === 'warning'
          ? 'warningSoft'
          : 'blueSoft',
      7,
    );
    await text(
      n,
      screen.notice.text,
      16,
      15,
      10,
      screen.notice.tone === 'danger'
        ? 'danger'
        : screen.notice.tone === 'warning'
          ? 'warning'
          : 'blue',
      false,
      650,
    );
  }
  const contentY = screen.metrics || screen.notice ? 345 : 236;
  if (screen.form) {
    const form = frame(root, 'Form', FLOW.sidebar + 32, contentY, 690, 330, 'surface', 8);
    form.strokes = [paint('border')];
    form.strokeWeight = 1;
    for (const [i, field] of screen.form.entries()) {
      const fx = i % 2 ? 365 : 20;
      const fy = 22 + Math.floor(i / 2) * 72;
      await text(form, field.label, fx, fy, 10, 'muted', true);
      frame(
        form,
        `Field / ${field.id}`,
        fx,
        fy + 22,
        300,
        field.kind === 'textarea' ? 58 : 31,
        field.kind === 'readonly' ? 'canvas' : 'surface',
        5,
      );
      await text(
        form,
        field.value,
        fx + 10,
        fy + 32,
        10,
        field.kind === 'readonly' ? 'muted' : 'ink',
        false,
        280,
      );
    }
  }
  if (screen.timeline) {
    const timelineBox = frame(
      root,
      'Execution Timeline',
      FLOW.sidebar + 32,
      contentY,
      690,
      Math.max(250, screen.timeline.length * 75 + 80),
      'surface',
      8,
    );
    timelineBox.strokes = [paint('border')];
    timelineBox.strokeWeight = 1;
    await text(timelineBox, '执行过程', 20, 20, 14, 'ink', true);
    for (const [i, item] of screen.timeline.entries()) {
      const ty = 60 + i * 72;
      rect(
        timelineBox,
        22,
        ty,
        22,
        22,
        item.state === 'success'
          ? 'primarySoft'
          : item.state === 'error'
            ? 'dangerSoft'
            : item.state === 'running'
              ? 'blueSoft'
              : 'canvas',
        11,
      );
      await text(
        timelineBox,
        item.state === 'success' ? '✓' : String(i + 1),
        29,
        ty + 5,
        9,
        item.state === 'error' ? 'danger' : 'primary',
        true,
      );
      await text(timelineBox, item.title, 60, ty + 2, 11, 'ink', true, 550);
      await text(timelineBox, item.body, 60, ty + 23, 9, 'muted', false, 550);
    }
  }
  if (screen.cards) {
    for (const [i, card] of screen.cards.entries()) {
      const cardRecord = card as unknown as { target?: unknown };
      const cardTarget = typeof cardRecord.target === 'string' ? cardRecord.target : undefined;
      const cx = FLOW.sidebar + 32 + (i % 2) * 350;
      const cy = contentY + Math.floor(i / 2) * 145;
      const cardNode = frame(root, `Card / ${card.title}`, cx, cy, 325, 120, 'surface', 8);
      cardNode.strokes = [paint('border')];
      cardNode.strokeWeight = 1;
      await text(cardNode, card.title, 17, 18, 12, 'ink', true, 285);
      await text(cardNode, card.body, 17, 47, 10, 'muted', false, 285);
      if (card.tag) await badge(cardNode, card.tag, 17, 88);
      if (cardTarget)
        actionNodes.push({
          node: cardNode,
          action: { label: card.title, target: cardTarget, variant: 'secondary' },
        });
    }
  }
  if (screen.table) {
    const table = frame(root, 'Data Table', FLOW.sidebar + 32, contentY, 690, 240, 'surface', 8);
    table.strokes = [paint('border')];
    table.strokeWeight = 1;
    await text(table, screen.table.title, 20, 20, 14, 'ink', true);
    for (const [i, col] of screen.table.columns.entries())
      await text(table, col, 20 + i * 150, 56, 9, 'muted', true);
    for (const [r, row] of screen.table.rows.slice(0, 3).entries())
      for (const [c, cell] of row.cells.entries())
        await text(
          table,
          cell,
          20 + c * 150,
          88 + r * 42,
          9,
          c === 0 ? 'ink' : 'muted',
          c === 0,
          135,
        );
  }
  if (screen.context) {
    const side = frame(root, 'Task Context', 940, contentY, 228, 360, 'surface', 8);
    side.strokes = [paint('border')];
    side.strokeWeight = 1;
    await text(side, '任务上下文', 18, 20, 13, 'ink', true);
    for (const [i, item] of screen.context.slice(0, 7).entries()) {
      await text(side, item.label, 18, 54 + i * 41, 9, 'muted', true);
      await text(side, item.value, 18, 70 + i * 41, 9, 'ink', false, 190);
    }
  }
  return root;
}

async function createPrototype() {
  const page = figma.createPage();
  page.name = '01 Prototype · Flows';
  await figma.setCurrentPageAsync(page);
  for (const [index, screen] of prototype.screens.entries())
    await createScreen(page, screen as Screen, index);
  for (const { node, action } of actionNodes) {
    const target = screenNodes.get(action.target);
    if (!target || node.id === target.id) continue;
    const targetIsOverlay = prototype.screens.some(
      (screen) => screen.id === action.target && screen.kind === 'overlay',
    );
    await node.setReactionsAsync([
      {
        trigger: { type: 'ON_CLICK' },
        actions: [
          {
            type: 'NODE',
            destinationId: target.id,
            navigation: targetIsOverlay ? 'OVERLAY' : 'NAVIGATE',
            transition: { type: 'DISSOLVE', easing: { type: 'EASE_IN_AND_OUT' }, duration: 0.16 },
          },
        ],
      },
    ]);
  }
  const start = screenNodes.get(prototype.start);
  if (start) {
    page.selection = [start];
    figma.viewport.scrollAndZoomIntoView([start]);
  }
  return page;
}

async function createArchitecture() {
  const page = figma.createPage();
  page.name = '02 Architecture';
  await figma.setCurrentPageAsync(page);
  const root = frame(page, 'Architecture / Agent Workbench', 0, 0, 1500, 940, 'canvas');
  await text(root, architecture.title, 50, 42, 28, 'ink', true);
  await text(root, architecture.subtitle, 52, 86, 12, 'muted');
  const nodes = new Map<string, FrameNode>();
  for (const item of architecture.nodes) {
    const node = frame(
      root,
      `Module / ${item.title}`,
      item.x,
      item.y + 120,
      item.width,
      item.height,
      item.group === 'sandbox'
        ? 'warningSoft'
        : item.group === 'storage'
          ? 'blueSoft'
          : item.group === 'execution'
            ? 'primarySoft'
            : 'surface',
      9,
    );
    node.strokes = [paint('border')];
    node.strokeWeight = 1;
    await text(node, item.title, 17, 17, 14, 'ink', true, item.width - 34);
    await text(node, item.description, 17, 50, 10, 'muted', false, item.width - 34);
    nodes.set(item.id, node);
  }
  for (const edge of architecture.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    const line = figma.createLine();
    line.name = `Edge / ${edge.label}`;
    line.x = from.x + from.width;
    line.y = from.y + from.height / 2;
    const length = Math.max(
      20,
      Math.sqrt(
        (to.x - (from.x + from.width)) ** 2 +
          (to.y + to.height / 2 - (from.y + from.height / 2)) ** 2,
      ),
    );
    line.resize(length, 0);
    line.rotation =
      Math.atan2(to.y + to.height / 2 - (from.y + from.height / 2), to.x - (from.x + from.width)) *
      (180 / Math.PI);
    line.strokes = [paint('muted')];
    line.strokeWeight = 1;
    root.appendChild(line);
    await text(root, edge.label, line.x + Math.min(100, length / 2), line.y - 16, 9, 'muted');
  }
  page.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
}

async function main() {
  await loadFonts();
  await createFoundations();
  await createPrototype();
  await createArchitecture();
  figma.notify('Agent Workbench 原型、组件和架构图已生成');
  figma.closePlugin('已生成 00 Foundations、01 Prototype · Flows、02 Architecture 三个页面');
}

void main().catch((error: unknown) => {
  console.error(error);
  figma.closePlugin(`生成失败：${error instanceof Error ? error.message : String(error)}`);
});
