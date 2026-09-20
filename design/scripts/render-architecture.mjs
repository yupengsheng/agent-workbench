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
const edges = data.edges
  .map((edge) => {
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    const x1 = from.x + from.width;
    const y1 = from.y + from.height / 2;
    const x2 = to.x;
    const y2 = to.y + to.height / 2;
    return `<g><path d="M ${x1} ${y1} C ${x1 + 55} ${y1}, ${x2 - 55} ${y2}, ${x2} ${y2}" fill="none" stroke="#8EA0AD" stroke-width="1.5" marker-end="url(#arrow)"/><text x="${(x1 + x2) / 2 - 26}" y="${(y1 + y2) / 2 - 8}" fill="#546675" font-family="Inter, sans-serif" font-size="10">${escape(edge.label)}</text></g>`;
  })
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}" viewBox="0 0 ${data.width} ${data.height}"><defs><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="#8EA0AD"/></marker></defs><rect width="100%" height="100%" fill="#F4F6F8"/><text x="50" y="54" fill="#172B3A" font-family="Inter, sans-serif" font-size="28" font-weight="650">${escape(data.title)}</text><text x="52" y="88" fill="#546675" font-family="Inter, sans-serif" font-size="12">${escape(data.subtitle)}</text>${edges}${boxes}</svg>`;
await mkdir(resolve(root, 'exports'), { recursive: true });
await writeFile(resolve(root, 'exports/architecture.svg'), svg);
console.log('Rendered design/exports/architecture.svg');
