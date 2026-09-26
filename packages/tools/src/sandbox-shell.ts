import { constants as fsConstants } from 'node:fs';
import { access, lstat, readdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import {
  DEFAULT_SHELL_WORKSPACE_BYTES,
  MAX_SHELL_WORKSPACE_BYTES,
  type ShellCommandResourceUsage,
} from '@agent-workbench/contracts';
import {
  killProcessGroup,
  killSystemdCgroup,
  resetSystemdCgroup,
  sampleSystemdCgroup,
  systemdCgroupCommand,
  type CgroupMode,
} from './systemd-cgroup.js';

export interface SandboxShellOptions {
  /** Absolute path to bubblewrap. The default is intentionally fixed and fail-closed. */
  bubblewrapPath?: string;
  timeoutMs?: number;
  cpuSeconds?: number;
  memoryBytes?: number;
  maxProcesses?: number;
  maxOutputBytes?: number;
  workspaceQuotaBytes?: number;
  cgroupMode?: CgroupMode;
  systemdRunPath?: string;
  systemctlPath?: string;
}

export interface SandboxShellResult {
  status: 'success' | 'error' | 'cancelled';
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  resourceUsage?: ShellCommandResourceUsage;
  errorCode?: string;
}

interface WorkspaceUsage {
  bytes: number;
  files: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_CPU_SECONDS = 20;
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_PROCESSES = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 4_096;
const MAX_QUOTA_SCAN_ENTRIES = 200_000;
const RESOURCE_SAMPLE_MS = 100;
const WORKSPACE_SAMPLE_MS = 250;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) return fallback;
  return Math.min(value, maximum);
}

function shellPath(value: string): string[] {
  // Only fixed host paths are mounted. The command never receives the host's
  // environment, HOME, credential directories, or network namespace.
  return ['--ro-bind-try', value, value];
}

function commandInput(command: string): string | undefined {
  if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_COMMAND_LENGTH)
    return '命令不能为空且不能超过 4096 个字符';
  if (/\u0000/.test(command) || /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(command))
    return '命令包含不支持的控制字符';
  return undefined;
}

async function findBubblewrap(path?: string): Promise<string | undefined> {
  const candidate = path ?? process.env.AGENT_WORKBENCH_BWRAP_PATH ?? '/usr/bin/bwrap';
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

async function workspaceUsage(root: string, stopAfterBytes?: number): Promise<WorkspaceUsage> {
  const stack = [root];
  const hardLinks = new Set<string>();
  let bytes = 0;
  let files = 0;
  let visited = 0;
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > MAX_QUOTA_SCAN_ENTRIES) throw new Error('workspace_scan_limit');
      const path = resolve(directory, entry.name);
      let stats;
      try {
        stats = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (stats.isDirectory()) {
        stack.push(path);
        continue;
      }
      const inode = `${stats.dev}:${stats.ino}`;
      if (stats.nlink > 1 && hardLinks.has(inode)) continue;
      if (stats.nlink > 1) hardLinks.add(inode);
      files += 1;
      bytes += stats.size;
      if (stopAfterBytes !== undefined && bytes > stopAfterBytes) return { bytes, files };
    }
  }
  return { bytes, files };
}

function baseResult(
  status: SandboxShellResult['status'],
  errorCode: string,
  stderr: string,
): SandboxShellResult {
  return {
    status,
    exitCode: null,
    signal: status === 'cancelled' ? 'SIGTERM' : null,
    stdout: '',
    stderr,
    truncated: false,
    durationMs: 0,
    errorCode,
  };
}

/**
 * Run an explicit shell command inside bubblewrap. Production callers can
 * require a transient systemd cgroup; unavailable isolation fails closed.
 */
export async function executeSandboxedShell(
  workspace: string,
  command: string,
  options: SandboxShellOptions = {},
  signal?: AbortSignal,
): Promise<SandboxShellResult> {
  const invalid = commandInput(command);
  if (invalid) return baseResult('error', 'invalid_command', invalid);
  if (signal?.aborted) return baseResult('cancelled', 'cancelled', '命令执行已取消');

  const bubblewrap = await findBubblewrap(options.bubblewrapPath);
  if (!bubblewrap) {
    return baseResult(
      'error',
      'sandbox_unavailable',
      '未找到 bubblewrap，已拒绝在主机 Shell 中执行',
    );
  }

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const cpuSeconds = positiveInteger(options.cpuSeconds, DEFAULT_CPU_SECONDS, 120);
  const memoryBytes = positiveInteger(options.memoryBytes, DEFAULT_MEMORY_BYTES, 2 * 1024 ** 3);
  const maxProcesses = positiveInteger(options.maxProcesses, DEFAULT_MAX_PROCESSES, 256);
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    512 * 1024,
  );
  const workspaceQuotaBytes = positiveInteger(
    options.workspaceQuotaBytes,
    DEFAULT_SHELL_WORKSPACE_BYTES,
    MAX_SHELL_WORKSPACE_BYTES,
  );
  let before: WorkspaceUsage;
  try {
    before = await workspaceUsage(workspace, workspaceQuotaBytes);
  } catch {
    return baseResult('error', 'workspace_quota_unavailable', '无法核对工作区磁盘用量，命令未执行');
  }
  if (before.bytes > workspaceQuotaBytes) {
    const result = baseResult(
      'error',
      'workspace_quota_exceeded',
      '工作区已超过磁盘配额，命令未执行',
    );
    result.resourceUsage = {
      cgroupEnforced: false,
      cpuUsec: 0,
      memoryPeakBytes: 0,
      processPeak: 0,
      workspaceBytesBefore: before.bytes,
      workspaceBytesAfter: before.bytes,
      workspaceQuotaBytes,
    };
    return result;
  }

  const memoryKb = Math.max(1, Math.ceil(memoryBytes / 1024));
  const diskBlocks = Math.max(1, Math.floor(workspaceQuotaBytes / 512));
  const mount: string[] = [
    '--die-with-parent',
    '--unshare-all',
    '--uid',
    '65532',
    '--gid',
    '65532',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    workspace,
    '/workspace',
    '--chdir',
    '/workspace',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'PATH',
    '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv',
    'LANG',
    'C.UTF-8',
  ];
  for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'])
    mount.push(...shellPath(path));
  // Hide common credential locations even though the workspace itself is writable.
  for (const path of [
    '/workspace/.env',
    '/workspace/.env.local',
    '/workspace/.env.production',
    '/workspace/.env.development',
    '/workspace/.aws',
    '/workspace/.ssh',
    '/workspace/.npmrc',
    '/workspace/.git-credentials',
  ]) {
    mount.push('--ro-bind', '/dev/null', path);
  }

  // ulimit remains defense in depth inside the namespace. Aggregate CPU,
  // memory, and process limits are enforced by the outer cgroup when required.
  const bootstrap =
    'ulimit -t "$1" 2>/dev/null || true; ' +
    'ulimit -v "$2" 2>/dev/null || true; ' +
    'ulimit -u "$3" 2>/dev/null || true; ' +
    'ulimit -f "$4" 2>/dev/null || exit 124; ' +
    'exec /bin/sh -c "$5"';
  const bubblewrapArgs = [
    ...mount,
    '--',
    '/bin/sh',
    '-c',
    bootstrap,
    'agent-workbench-sandbox',
    String(cpuSeconds),
    String(memoryKb),
    String(maxProcesses),
    String(diskBlocks),
    command,
  ];

  let cgroup;
  try {
    cgroup = await systemdCgroupCommand(bubblewrap, bubblewrapArgs, {
      mode: options.cgroupMode ?? 'disabled',
      memoryBytes,
      maxProcesses,
      ...(options.systemdRunPath ? { systemdRunPath: options.systemdRunPath } : {}),
      ...(options.systemctlPath ? { systemctlPath: options.systemctlPath } : {}),
    });
  } catch {
    const result = baseResult('error', 'cgroup_unavailable', '无法建立必需的 cgroup，命令未执行');
    result.resourceUsage = {
      cgroupEnforced: false,
      cpuUsec: 0,
      memoryPeakBytes: 0,
      processPeak: 0,
      workspaceBytesBefore: before.bytes,
      workspaceBytesAfter: before.bytes,
      workspaceQuotaBytes,
    };
    return result;
  }

  const startedAt = Date.now();
  return new Promise((resolveResult) => {
    const child = spawn(cgroup?.executable ?? bubblewrap, cgroup?.args ?? bubblewrapArgs, {
      cwd: '/',
      detached: true,
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let cpuExceeded = false;
    let diskExceeded = false;
    let quotaUnavailable = false;
    let settled = false;
    let cpuUsec = 0;
    let memoryPeakBytes = 0;
    let processPeak = 0;
    let memoryLimitHit = false;
    let workspaceBytesAfter = before.bytes;
    let resourceTimer: ReturnType<typeof setTimeout> | undefined;
    let workspaceTimer: ReturnType<typeof setTimeout> | undefined;
    let workspaceCheck: Promise<void> | undefined;

    const terminate = (terminationSignal: NodeJS.Signals = 'SIGKILL') => {
      if (cgroup) killSystemdCgroup(cgroup.systemctlPath, cgroup.unitName, terminationSignal);
      killProcessGroup(child, terminationSignal);
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled) return;
      const remaining = maxOutputBytes - outputBytes;
      const text = chunk.subarray(0, Math.max(0, remaining)).toString('utf8');
      if (target === 'stdout') stdout += text;
      else stderr += text;
      outputBytes += Math.min(chunk.byteLength, Math.max(0, remaining));
      if (chunk.byteLength > remaining) {
        truncated = true;
        terminate();
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));

    const recordResourceSample = async () => {
      if (!cgroup) return;
      const sample = await sampleSystemdCgroup(cgroup.systemctlPath, cgroup.unitName);
      if (sample) {
        cpuUsec = Math.max(cpuUsec, sample.cpuUsec);
        memoryPeakBytes = Math.max(memoryPeakBytes, sample.memoryPeakBytes);
        processPeak = Math.max(processPeak, sample.processes);
        memoryLimitHit ||= sample.memoryLimitHit;
        if (sample.cpuUsec >= cpuSeconds * 1_000_000) {
          cpuExceeded = true;
          terminate();
        }
      }
    };
    const sampleResources = async () => {
      if (settled || !cgroup) return;
      await recordResourceSample();
      if (!settled) resourceTimer = setTimeout(() => void sampleResources(), RESOURCE_SAMPLE_MS);
    };
    if (cgroup) void sampleResources();

    const sampleWorkspace = async () => {
      if (settled) return;
      workspaceCheck = (async () => {
        try {
          const usage = await workspaceUsage(workspace, workspaceQuotaBytes);
          workspaceBytesAfter = usage.bytes;
          if (usage.bytes > workspaceQuotaBytes) {
            diskExceeded = true;
            terminate();
          }
        } catch {
          quotaUnavailable = true;
          terminate();
        }
      })();
      await workspaceCheck;
      workspaceCheck = undefined;
      if (!settled && !diskExceeded && !quotaUnavailable) {
        workspaceTimer = setTimeout(() => void sampleWorkspace(), WORKSPACE_SAMPLE_MS);
      }
    };
    workspaceTimer = setTimeout(() => void sampleWorkspace(), WORKSPACE_SAMPLE_MS);

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      terminate('SIGTERM');
      setTimeout(() => terminate(), 500).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = async (
      exitCode: number | null,
      signalName: string | null,
      spawnFailed = false,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (resourceTimer) clearTimeout(resourceTimer);
      if (workspaceTimer) clearTimeout(workspaceTimer);
      signal?.removeEventListener('abort', onAbort);
      await workspaceCheck?.catch(() => {});
      await recordResourceSample();
      try {
        workspaceBytesAfter = (await workspaceUsage(workspace, workspaceQuotaBytes)).bytes;
        if (workspaceBytesAfter > workspaceQuotaBytes) diskExceeded = true;
      } catch {
        quotaUnavailable = true;
      }
      if (cgroup) resetSystemdCgroup(cgroup.systemctlPath, cgroup.unitName);
      const durationMs = Date.now() - startedAt;
      const cgroupStartupFailed =
        Boolean(cgroup) &&
        /Failed to (?:start transient|connect to bus)|Access denied|Interactive authentication required|Unknown assignment/i.test(
          stderr,
        );
      const memoryExceeded =
        Boolean(cgroup) &&
        (memoryLimitHit || (exitCode === 137 && memoryPeakBytes >= Math.floor(memoryBytes * 0.9)));
      const fileLimitExceeded = signalName === 'SIGXFSZ' || exitCode === 153;
      const errorCode = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timeout'
          : cpuExceeded
            ? 'cpu_limit'
            : diskExceeded || fileLimitExceeded
              ? 'disk_limit'
              : quotaUnavailable
                ? 'workspace_quota_unavailable'
                : truncated
                  ? 'output_limit'
                  : cgroupStartupFailed
                    ? 'cgroup_unavailable'
                    : memoryExceeded
                      ? 'memory_limit'
                      : spawnFailed
                        ? 'spawn_failed'
                        : exitCode === 0
                          ? undefined
                          : 'exit_nonzero';
      resolveResult({
        status: cancelled ? 'cancelled' : errorCode ? 'error' : 'success',
        exitCode,
        signal: signalName,
        stdout,
        stderr,
        truncated,
        durationMs,
        resourceUsage: {
          cgroupEnforced: Boolean(cgroup) && !cgroupStartupFailed,
          cpuUsec,
          memoryPeakBytes,
          processPeak,
          workspaceBytesBefore: before.bytes,
          workspaceBytesAfter,
          workspaceQuotaBytes,
        },
        ...(errorCode ? { errorCode } : {}),
      });
    };

    child.once('error', (error) => {
      stderr += error.message;
      void finish(child.exitCode, null, true);
    });
    child.once('close', (exitCode, signalName) => {
      void finish(exitCode, signalName);
    });
  });
}

export const sandboxDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  cpuSeconds: DEFAULT_CPU_SECONDS,
  memoryBytes: DEFAULT_MEMORY_BYTES,
  maxProcesses: DEFAULT_MAX_PROCESSES,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  workspaceBytes: DEFAULT_SHELL_WORKSPACE_BYTES,
  maxCommandLength: MAX_COMMAND_LENGTH,
} as const;

export async function resolveSandboxWorkspace(root: string, workspaceId: string): Promise<string> {
  if (!UUID.test(workspaceId)) throw new Error('workspace_id_invalid');
  const actualRoot = await realpath(resolve(root));
  const workspace = await realpath(resolve(actualRoot, workspaceId));
  const pathFromRoot = relative(actualRoot, workspace);
  if (
    pathFromRoot === '' ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`) ||
    pathFromRoot.startsWith(sep)
  ) {
    throw new Error('workspace_path_denied');
  }
  return workspace;
}
