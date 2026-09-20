import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(await readFile(resolve(root, 'architecture.json'), 'utf8'));
const colors = {
  client: '#EAF3F1',
  control: '#FFFFFF',
  storage: '#ECF3FC',
  execution: '#E6F3EC',
  security: '#FBEAEC',
  sandbox: '#FFF4DC',
  adapter: '#F1EFFB',
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char],
  );
const nodeMap = new Map(data.nodes.map((node) => [node.id, node]));
const boxes = data.nodes
  .map(
    (node) =>
      `<g><rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10" fill="${colors[node.group] || '#fff'}" stroke="#DCE3E8"/><text x="${node.x + 18}" y="${node.y + 28}" fill="#172B3A" font-family="Inter, sans-serif" font-size="15" font-weight="600">${escape(node.title)}</text><text x="${node.x + 18}" y="${node.y + 57}" fill="#546675" font-family="Inter, sans-serif" font-size="11">${escape(node.description)}</text></g>`,
  )
  .join('');
const anchor = (from, to) => {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const direction = dx >= 0 ? 1 : -1;
    return {
      from: { x: fromCenter.x + (direction * from.width) / 2, y: fromCenter.y },
      to: { x: toCenter.x - (direction * to.width) / 2, y: toCenter.y },
      horizontal: true,
      direction,
    };
  }
  const direction = dy >= 0 ? 1 : -1;
  return {
    from: { x: fromCenter.x, y: fromCenter.y + (direction * from.height) / 2 },
    to: { x: toCenter.x, y: toCenter.y - (direction * to.height) / 2 },
    horizontal: false,
    direction,
  };
};
const edges = data.edges
  .map((edge) => {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    const points = anchor(from, to);
    const distance = points.horizontal
      ? Math.abs(points.to.x - points.from.x)
      : Math.abs(points.to.y - points.from.y);
    const bend = Math.max(40, Math.min(110, distance * 0.35));
    const path = points.horizontal
      ? `M ${points.from.x} ${points.from.y} C ${points.from.x + points.direction * bend} ${points.from.y}, ${points.to.x - points.direction * bend} ${points.to.y}, ${points.to.x} ${points.to.y}`
      : `M ${points.from.x} ${points.from.y} C ${points.from.x} ${points.from.y + points.direction * bend}, ${points.to.x} ${points.to.y - points.direction * bend}, ${points.to.x} ${points.to.y}`;
    const labelX = points.horizontal
      ? (points.from.x + points.to.x) / 2
      : (points.from.x + points.to.x) / 2 + 8;
    const labelY = points.horizontal
      ? (points.from.y + points.to.y) / 2 - 8
      : (points.from.y + points.to.y) / 2;
    return `<g><path d="${path}" fill="none" stroke="#8EA0AD" stroke-width="1.5" marker-end="url(#arrow)"/><text x="${labelX}" y="${labelY}" text-anchor="middle" fill="#546675" font-family="Inter, sans-serif" font-size="10">${escape(edge.label)}</text></g>`;
  })
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}" viewBox="0 0 ${data.width} ${data.height}"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#8EA0AD"/></marker></defs><rect width="100%" height="100%" fill="#F4F6F8"/><text x="50" y="54" fill="#172B3A" font-family="Inter, sans-serif" font-size="28" font-weight="650">${escape(data.title)}</text><text x="52" y="88" fill="#546675" font-family="Inter, sans-serif" font-size="12">${escape(data.subtitle)}</text>${edges}${boxes}</svg>`;
await mkdir(resolve(root, 'exports'), { recursive: true });
await writeFile(resolve(root, 'exports/architecture.svg'), svg);
console.log('Rendered design/exports/architecture.svg');
