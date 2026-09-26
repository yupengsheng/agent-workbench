import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  'shell tool proposes an exact command without executing it',
  { skip: !hasBubblewrap },
  async () => {
    const root = await mkdtemp('/tmp/agent-workbench-shell-');
    const workspace = join(root, workspaceId);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, '.env'), 'DATABASE_URL=must-not-leak\n');
    try {
      const registry = createReadOnlyToolRegistry(root, { shell: { enabled: true } });
      assert.equal(
        registry.definitions().some((definition) => definition.function.name === 'run_shell'),
        false,
      );
      const result = await registry.execute(
        'propose_shell_command',
        JSON.stringify({
          command: 'printf safe > result.txt',
          reason: '验证审批前不执行命令',
        }),
        { workspaceId },
      );
      assert.equal(result.status, 'success');
      const proposal = JSON.parse(result.content);
      assert.equal(proposal.kind, 'shell_command_proposal');
      assert.equal(proposal.approvalRequired, true);
      assert.equal(proposal.sandbox.network, 'disabled');
      await assert.rejects(access(join(workspace, 'result.txt')));

      const executed = await executeSandboxedShell(
        workspace,
        'test ! -s .env; printf safe > result.txt; printf "uid=%s" "$(id -u)"',
        { timeoutMs: 5_000 },
      );
      assert.equal(executed.status, 'success');
      assert.match(executed.stdout, /uid=65532/);
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
