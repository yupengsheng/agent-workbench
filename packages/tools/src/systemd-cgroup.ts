import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type CgroupMode = 'disabled' | 'optional' | 'required';

export interface SystemdCgroupOptions {
  mode: CgroupMode;
  memoryBytes: number;
  maxProcesses: number;
  systemdRunPath?: string;
  systemctlPath?: string;
}

export interface SystemdCgroupCommand {
  executable: string;
  args: string[];
  unitName: string;
  systemctlPath: string;
}

export interface CgroupUsageSample {
  cpuUsec: number;
  memoryPeakBytes: number;
  processes: number;
  memoryLimitHit: boolean;
}

const FIXED_ENV = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function systemdCgroupCommand(
  command: string,
  args: string[],
  options: SystemdCgroupOptions,
): Promise<SystemdCgroupCommand | undefined> {
  if (options.mode === 'disabled') return undefined;
  const systemdRunPath = options.systemdRunPath ?? '/usr/bin/systemd-run';
  const systemctlPath = options.systemctlPath ?? '/usr/bin/systemctl';
  if (!(await executable(systemdRunPath)) || !(await executable(systemctlPath))) {
    if (options.mode === 'required') throw new Error('cgroup_unavailable');
    return undefined;
  }
  const unitName = `agent-workbench-shell-${randomUUID()}`;
  return {
    executable: systemdRunPath,
    unitName,
    systemctlPath,
    args: [
      '--wait',
      '--pipe',
      '--quiet',
      `--unit=${unitName}`,
      '--property=CPUAccounting=yes',
      '--property=MemoryAccounting=yes',
      '--property=TasksAccounting=yes',
      `--property=MemoryMax=${options.memoryBytes}`,
      `--property=TasksMax=${options.maxProcesses}`,
      '--property=CPUQuota=100%',
      '--property=KillMode=control-group',
      `--setenv=PATH=${FIXED_ENV.PATH}`,
      `--setenv=LANG=${FIXED_ENV.LANG}`,
      command,
      ...args,
    ],
  };
}

function parseProperties(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function safeNumber(value: string | undefined): number {
  if (!value || value === '[not set]') return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function showUnit(systemctlPath: string, unitName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      systemctlPath,
      [
        'show',
        `${unitName}.service`,
        '--property=LoadState',
        '--property=CPUUsageNSec',
        '--property=MemoryCurrent',
        '--property=TasksCurrent',
        '--property=ControlGroup',
      ],
      { env: FIXED_ENV, timeout: 1000, maxBuffer: 8192 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

async function readFirstNumber(paths: string[]): Promise<number> {
  for (const path of paths) {
    try {
      const value = safeNumber((await readFile(path, 'utf8')).trim());
      if (value > 0) return value;
    } catch {
      // Controller paths differ between cgroup v1 distributions.
    }
  }
  return 0;
}

async function directCgroupUsage(controlGroup: string) {
  if (!controlGroup || controlGroup === '/') return undefined;
  const unified = `/sys/fs/cgroup${controlGroup}`;
  try {
    await access('/sys/fs/cgroup/cgroup.controllers');
    const [cpuStat, memoryPeakBytes, memoryCurrentBytes, processes, memoryEvents] =
      await Promise.all([
        readFile(`${unified}/cpu.stat`, 'utf8').catch(() => ''),
        readFirstNumber([`${unified}/memory.peak`]),
        readFirstNumber([`${unified}/memory.current`]),
        readFirstNumber([`${unified}/pids.current`]),
        readFile(`${unified}/memory.events`, 'utf8').catch(() => ''),
      ]);
    const cpuUsec = safeNumber(cpuStat.match(/^usage_usec\s+(\d+)$/m)?.[1]);
    const memoryEventValues = parseProperties(memoryEvents.replaceAll(' ', '='));
    return {
      cpuUsec,
      memoryPeakBytes: Math.max(memoryPeakBytes, memoryCurrentBytes),
      processes,
      memoryLimitHit:
        safeNumber(memoryEventValues.max) > 0 ||
        safeNumber(memoryEventValues.oom) > 0 ||
        safeNumber(memoryEventValues.oom_kill) > 0,
    };
  } catch {
    const suffix = controlGroup.startsWith('/') ? controlGroup : `/${controlGroup}`;
    const [cpuNs, memoryPeakBytes, memoryCurrentBytes, processes, failCount] = await Promise.all([
      readFirstNumber([
        `/sys/fs/cgroup/cpu,cpuacct${suffix}/cpuacct.usage`,
        `/sys/fs/cgroup/cpuacct${suffix}/cpuacct.usage`,
      ]),
      readFirstNumber([`/sys/fs/cgroup/memory${suffix}/memory.max_usage_in_bytes`]),
      readFirstNumber([`/sys/fs/cgroup/memory${suffix}/memory.usage_in_bytes`]),
      readFirstNumber([`/sys/fs/cgroup/pids${suffix}/pids.current`]),
      readFirstNumber([`/sys/fs/cgroup/memory${suffix}/memory.failcnt`]),
    ]);
    return {
      cpuUsec: Math.ceil(cpuNs / 1000),
      memoryPeakBytes: Math.max(memoryPeakBytes, memoryCurrentBytes),
      processes,
      memoryLimitHit: failCount > 0,
    };
  }
}

export async function sampleSystemdCgroup(
  systemctlPath: string,
  unitName: string,
): Promise<CgroupUsageSample | undefined> {
  try {
    const properties = parseProperties(await showUnit(systemctlPath, unitName));
    if (properties.LoadState !== 'loaded') return undefined;
    const direct = await directCgroupUsage(properties.ControlGroup ?? '');
    return {
      cpuUsec: Math.max(
        Math.ceil(safeNumber(properties.CPUUsageNSec) / 1000),
        direct?.cpuUsec ?? 0,
      ),
      memoryPeakBytes: Math.max(safeNumber(properties.MemoryCurrent), direct?.memoryPeakBytes ?? 0),
      processes: Math.max(safeNumber(properties.TasksCurrent), direct?.processes ?? 0),
      memoryLimitHit: direct?.memoryLimitHit ?? false,
    };
  } catch {
    return undefined;
  }
}

export function killSystemdCgroup(systemctlPath: string, unitName: string, signal: NodeJS.Signals) {
  const child = spawn(
    systemctlPath,
    ['kill', '--kill-who=all', `--signal=${signal}`, `${unitName}.service`],
    { env: FIXED_ENV, stdio: 'ignore' },
  );
  child.once('error', () => {});
  child.unref();
}

export function resetSystemdCgroup(systemctlPath: string, unitName: string) {
  const child = spawn(systemctlPath, ['reset-failed', `${unitName}.service`], {
    env: FIXED_ENV,
    stdio: 'ignore',
  });
  child.once('error', () => {});
  child.unref();
}

export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') {
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
