export interface ShellCommandProposal {
  kind: 'shell_command_proposal';
  version: 1;
  command: string;
  reason: string;
  approvalRequired: true;
  approvalScope: 'single_command_exact_text';
  sandbox: {
    network: 'disabled';
    workspaceAccess: 'read_write';
    timeoutMs: number;
    cpuSeconds: number;
    memoryBytes: number;
    maxProcesses: number;
    maxOutputBytes: number;
  };
}

export type ShellCommandStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ShellCommandExecutionStatus =
  'not_started' | 'executing' | 'succeeded' | 'failed' | 'unknown';

export interface ShellCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface ShellCommandSummary {
  id: string;
  runId: string;
  stepId: string;
  proposal: ShellCommandProposal;
  digest: string;
  policyVersion: 'shell-review-v1';
  status: ShellCommandStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  executionStatus: ShellCommandExecutionStatus;
  result: ShellCommandResult | null;
  executionErrorCode: string | null;
  executionErrorMessage: string | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/** Validate the exact command and limits before an approval target is persisted. */
export function parseShellCommandProposal(value: unknown): ShellCommandProposal | undefined {
  if (
    !record(value) ||
    value.kind !== 'shell_command_proposal' ||
    value.version !== 1 ||
    typeof value.command !== 'string' ||
    !value.command.trim() ||
    value.command.length > 4_096 ||
    /\u0000/.test(value.command) ||
    /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.command) ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 500 ||
    value.approvalRequired !== true ||
    value.approvalScope !== 'single_command_exact_text' ||
    !record(value.sandbox) ||
    value.sandbox.network !== 'disabled' ||
    value.sandbox.workspaceAccess !== 'read_write' ||
    !boundedInteger(value.sandbox.timeoutMs, 1, 120_000) ||
    !boundedInteger(value.sandbox.cpuSeconds, 1, 120) ||
    !boundedInteger(value.sandbox.memoryBytes, 1, 2 * 1024 ** 3) ||
    !boundedInteger(value.sandbox.maxProcesses, 1, 256) ||
    !boundedInteger(value.sandbox.maxOutputBytes, 1, 512 * 1024)
  )
    return undefined;
  return {
    kind: 'shell_command_proposal',
    version: 1,
    command: value.command,
    reason: value.reason.trim(),
    approvalRequired: true,
    approvalScope: 'single_command_exact_text',
    sandbox: {
      network: 'disabled',
      workspaceAccess: 'read_write',
      timeoutMs: value.sandbox.timeoutMs,
      cpuSeconds: value.sandbox.cpuSeconds,
      memoryBytes: value.sandbox.memoryBytes,
      maxProcesses: value.sandbox.maxProcesses,
      maxOutputBytes: value.sandbox.maxOutputBytes,
    },
  };
}
