import { mkdir, cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
await rm(publicRoot, { recursive: true, force: true });
await mkdir(resolve(publicRoot, 'prototype'), { recursive: true });
for (const [source, target] of [
  ['tokens.json', 'tokens.json'],
  ['prototype/spec.json', 'prototype/spec.json'],
  ['prototype/index.html', 'prototype/index.html'],
  ['prototype/app.mjs', 'prototype/app.mjs'],
  ['prototype/styles.css', 'prototype/styles.css'],
  ['architecture.json', 'architecture.json'],
  ['exports/architecture.svg', 'exports/architecture.svg'],
]) {
  await mkdir(dirname(resolve(publicRoot, target)), { recursive: true });
  await cp(resolve(root, source), resolve(publicRoot, target));
}
console.log('Synced design preview assets to design/public');
