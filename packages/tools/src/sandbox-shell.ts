import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface SandboxShellOptions {
  /** Absolute path to bubblewrap. The default is intentionally fixed and fail-closed. */
  bubblewrapPath?: string;
  timeoutMs?: number;
  cpuSeconds?: number;
  memoryBytes?: number;
  maxProcesses?: number;
  maxOutputBytes?: number;
}

export interface SandboxShellResult {
  status: 'success' | 'error' | 'cancelled';
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  errorCode?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_CPU_SECONDS = 20;
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_PROCESSES = 64;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_COMMAND_LENGTH = 4_096;

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

function killGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGKILL') {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

/**
 * Run an explicit shell command inside bubblewrap. This function deliberately
 * refuses to fall back to the host shell: a missing sandbox is a policy error.
 */
export async function executeSandboxedShell(
  workspace: string,
  command: string,
  options: SandboxShellOptions = {},
  signal?: AbortSignal,
): Promise<SandboxShellResult> {
  const invalid = commandInput(command);
  if (invalid) {
    return {
      status: 'error',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: invalid,
      truncated: false,
      durationMs: 0,
      errorCode: 'invalid_command',
    };
  }
  if (signal?.aborted) {
    return {
      status: 'cancelled',
      exitCode: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '命令执行已取消',
      truncated: false,
      durationMs: 0,
      errorCode: 'cancelled',
    };
  }
  const bubblewrap = await findBubblewrap(options.bubblewrapPath);
  if (!bubblewrap) {
    return {
      status: 'error',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '未找到 bubblewrap，已拒绝在主机 Shell 中执行',
      truncated: false,
      durationMs: 0,
      errorCode: 'sandbox_unavailable',
    };
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
  const memoryKb = Math.max(1, Math.ceil(memoryBytes / 1024));
  const mount: string[] = [
    '--die-with-parent',
    '--new-session',
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
    mount.push('--tmpfs', path);
  }

  // ulimit is applied inside the user namespace and therefore remains a
  // defense in depth if a child process ignores the wall-clock timer.
  const bootstrap =
    'ulimit -t "$1" 2>/dev/null || true; ' +
    'ulimit -v "$2" 2>/dev/null || true; ' +
    'ulimit -u "$3" 2>/dev/null || true; ' +
    'exec /bin/sh -c "$4"';
  const args = [
    ...mount,
    '--',
    '/bin/sh',
    '-c',
    bootstrap,
    'agent-workbench-sandbox',
    String(cpuSeconds),
    String(memoryKb),
    String(maxProcesses),
    command,
  ];
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bubblewrap, args, {
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
    let settled = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      if (settled) return;
      const remaining = maxOutputBytes - outputBytes;
      const text = chunk.subarray(0, Math.max(0, remaining)).toString('utf8');
      if (target === 'stdout') stdout += text;
      else stderr += text;
      outputBytes += Math.min(chunk.byteLength, Math.max(0, remaining));
      if (chunk.byteLength > remaining) {
        truncated = true;
        killGroup(child);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child), 500).unref();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (errorCode?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - startedAt;
      const status = cancelled ? 'cancelled' : 'error';
      resolve({
        status,
        exitCode: child.exitCode,
        signal: null,
        stdout,
        stderr,
        truncated,
        durationMs,
        errorCode: errorCode ?? (cancelled ? 'cancelled' : timedOut ? 'timeout' : 'spawn_failed'),
      });
    };
    child.once('error', (error) => {
      stderr += error.message;
      finish('spawn_failed');
    });
    child.once('close', (exitCode, signalName) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const durationMs = Date.now() - startedAt;
      const errorCode = cancelled
        ? 'cancelled'
        : timedOut
          ? 'timeout'
          : truncated
            ? 'output_limit'
            : exitCode === 0
              ? undefined
              : 'exit_nonzero';
      resolve({
        status: cancelled || exitCode !== 0 ? (cancelled ? 'cancelled' : 'error') : 'success',
        exitCode,
        signal: signalName,
        stdout,
        stderr,
        truncated,
        durationMs,
        ...(errorCode ? { errorCode } : {}),
      });
    });
  });
}

export const sandboxDefaults = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  cpuSeconds: DEFAULT_CPU_SECONDS,
  memoryBytes: DEFAULT_MEMORY_BYTES,
  maxProcesses: DEFAULT_MAX_PROCESSES,
  maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
  maxCommandLength: MAX_COMMAND_LENGTH,
} as const;

export function defaultSandboxWorkspace(root: string, workspaceId: string): string {
  return join(root, workspaceId);
}
