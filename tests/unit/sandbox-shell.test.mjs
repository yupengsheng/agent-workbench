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
import {
  DEFAULT_SHELL_WORKSPACE_BYTES,
  parseShellCommandProposal,
} from '../../packages/contracts/dist/index.js';

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
      const registry = createReadOnlyToolRegistry(root, {
        shell: { enabled: true, workspaceQuotaBytes: 1024 * 1024 },
      });
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
      assert.equal(proposal.sandbox.workspaceBytes, 1024 * 1024);
      await assert.rejects(access(join(workspace, 'result.txt')));

      const executed = await executeSandboxedShell(
        workspace,
        'test ! -s .env; printf safe > result.txt; printf "uid=%s" "$(id -u)"',
        { timeoutMs: 5_000 },
      );
      assert.equal(executed.status, 'success');
      assert.match(executed.stdout, /uid=65532/);
      assert.equal(executed.resourceUsage.cgroupEnforced, false);
      assert.ok(executed.resourceUsage.workspaceBytesAfter >= 4);
      assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'safe');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'required cgroup fails closed before running the command',
  { skip: !hasBubblewrap },
  async () => {
    const root = await mkdtemp('/tmp/agent-workbench-shell-cgroup-');
    try {
      const result = await executeSandboxedShell(root, 'touch should-not-exist', {
        cgroupMode: 'required',
        systemdRunPath: '/definitely/missing/systemd-run',
      });
      assert.equal(result.status, 'error');
      assert.equal(result.errorCode, 'cgroup_unavailable');
      await assert.rejects(access(join(root, 'should-not-exist')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'workspace quota rejects an over-quota workspace before execution',
  { skip: !hasBubblewrap },
  async () => {
    const root = await mkdtemp('/tmp/agent-workbench-shell-quota-');
    await writeFile(join(root, 'existing.bin'), Buffer.alloc(32));
    try {
      const result = await executeSandboxedShell(root, 'touch should-not-exist', {
        workspaceQuotaBytes: 16,
      });
      assert.equal(result.status, 'error');
      assert.equal(result.errorCode, 'workspace_quota_exceeded');
      assert.ok(result.resourceUsage.workspaceBytesBefore > 16);
      await assert.rejects(access(join(root, 'should-not-exist')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'workspace quota reports disk_limit when a command exceeds total usage',
  { skip: !hasBubblewrap },
  async () => {
    const root = await mkdtemp('/tmp/agent-workbench-shell-disk-');
    try {
      const result = await executeSandboxedShell(
        root,
        'i=0; while [ "$i" -lt 200 ]; do printf 1234567890 > "file-$i"; i=$((i+1)); done',
        { workspaceQuotaBytes: 1024, timeoutMs: 5_000 },
      );
      assert.equal(result.status, 'error');
      assert.equal(result.errorCode, 'disk_limit');
      assert.ok(result.resourceUsage.workspaceBytesAfter > 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('legacy shell proposals receive the default workspace quota', () => {
  const proposal = parseShellCommandProposal({
    kind: 'shell_command_proposal',
    version: 1,
    command: 'npm test',
    reason: 'run tests',
    approvalRequired: true,
    approvalScope: 'single_command_exact_text',
    sandbox: {
      network: 'disabled',
      workspaceAccess: 'read_write',
      timeoutMs: 30_000,
      cpuSeconds: 20,
      memoryBytes: 512 * 1024 * 1024,
      maxProcesses: 64,
      maxOutputBytes: 64 * 1024,
    },
  });
  assert.equal(proposal.sandbox.workspaceBytes, DEFAULT_SHELL_WORKSPACE_BYTES);
});

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
  assert.equal(sandboxDefaults.workspaceBytes, DEFAULT_SHELL_WORKSPACE_BYTES);
});
