import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createReadOnlyToolRegistry,
  executeSandboxedShell,
  sandboxDefaults,
} from '../../packages/tools/dist/index.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const hasBubblewrap = existsSync('/usr/bin/bwrap');

test('sandbox shell refuses to fall back to a host shell', async () => {
  const result = await executeSandboxedShell('/tmp', 'printf unsafe', {
    bubblewrapPath: '/definitely/missing/bwrap',
  });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, 'sandbox_unavailable');
});

test(
  'sandbox shell runs as an unprivileged, network-isolated process and writes only in the workspace',
  { skip: !hasBubblewrap },
  async () => {
    const root = await mkdtemp('/tmp/agent-workbench-shell-');
    const workspace = join(root, workspaceId);
    await (await import('node:fs/promises')).mkdir(workspace, { recursive: true });
    try {
      const registry = createReadOnlyToolRegistry(root, {
        shell: { enabled: true, timeoutMs: 5_000 },
      });
      const result = await registry.execute(
        'run_shell',
        JSON.stringify({ command: 'printf safe > result.txt; printf "uid=%s" "$(id -u)"' }),
        { workspaceId },
      );
      assert.equal(result.status, 'success');
      assert.match(result.content, /uid=65532/);
      assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'safe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'sandbox shell reports cancellation and enforces output limits',
  { skip: !hasBubblewrap },
  async () => {
    const root = await mkdtemp('/tmp/agent-workbench-shell-limit-');
    const controller = new AbortController();
    try {
      const pending = executeSandboxedShell(
        root,
        'sleep 5',
        { timeoutMs: 5_000 },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 50).unref();
      const cancelled = await pending;
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.errorCode, 'cancelled');

      const limited = await executeSandboxedShell(root, 'yes x', {
        timeoutMs: 5_000,
        maxOutputBytes: 128,
      });
      assert.equal(limited.status, 'error');
      assert.equal(limited.errorCode, 'output_limit');
      assert.equal(limited.truncated, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('sandbox defaults keep the execution budget finite', () => {
  assert.equal(sandboxDefaults.timeoutMs, 30_000);
  assert.equal(sandboxDefaults.maxProcesses, 64);
  assert.ok(sandboxDefaults.maxOutputBytes <= 64 * 1024);
});
