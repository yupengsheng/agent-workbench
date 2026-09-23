export interface FileChangePreview {
  kind: 'file_change_proposal';
  version: 1;
  path: string;
  operation: 'update';
  changed: boolean;
  reason: string;
  before: { sha256: string; bytes: number };
  after: { sha256: string; bytes: number };
  patch: string;
  approvalRequired: true;
  approvalScope: 'single_file_exact_content';
}

export interface FileChangeProposal extends FileChangePreview {
  content: string;
}

export type FileChangeStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type FileChangeApplicationStatus =
  'not_started' | 'applying' | 'applied' | 'failed' | 'unknown';
export interface FileChangeSummary {
  id: string;
  runId: string;
  stepId: string;
  preview: FileChangePreview;
  digest: string;
  policyVersion: 'file-review-v1';
  status: FileChangeStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  applicationStatus: FileChangeApplicationStatus;
  applyErrorCode: string | null;
  applyErrorMessage: string | null;
  applied: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fingerprint(value: unknown): value is FileChangePreview['before'] {
  return (
    record(value) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.bytes <= 256 * 1024
  );
}

/** Validate the tool boundary before persisting or rendering an approval target. */
export function parseFileChangePreview(value: unknown): FileChangePreview | undefined {
  if (
    !record(value) ||
    value.kind !== 'file_change_proposal' ||
    value.version !== 1 ||
    value.operation !== 'update' ||
    typeof value.changed !== 'boolean' ||
    value.approvalRequired !== true ||
    value.approvalScope !== 'single_file_exact_content' ||
    typeof value.path !== 'string' ||
    !value.path ||
    value.path.length > 512 ||
    /[\x00-\x1f\x7f\\:]/.test(value.path) ||
    value.path.startsWith('/') ||
    value.path.split('/').some((part) => !part || part === '.' || part === '..') ||
    typeof value.reason !== 'string' ||
    !value.reason.trim() ||
    value.reason.length > 500 ||
    !fingerprint(value.before) ||
    !fingerprint(value.after) ||
    typeof value.patch !== 'string' ||
    value.patch.length > 32_000 ||
    (value.changed
      ? !value.patch || value.before.sha256 === value.after.sha256
      : value.patch !== '')
  )
    return undefined;
  return {
    kind: 'file_change_proposal',
    version: 1,
    path: value.path,
    operation: 'update',
    changed: value.changed,
    reason: value.reason,
    before: { sha256: value.before.sha256, bytes: value.before.bytes },
    after: { sha256: value.after.sha256, bytes: value.after.bytes },
    patch: value.patch,
    approvalRequired: true,
    approvalScope: 'single_file_exact_content',
  };
}

/** Validate the private exact-content payload used between the tool and Runner. */
export function parseFileChangeProposal(value: unknown): FileChangeProposal | undefined {
  if (!record(value) || typeof value.content !== 'string') return undefined;
  const contentBytes = new TextEncoder().encode(value.content).byteLength;
  if (contentBytes > 256 * 1024 || /\u0000/.test(value.content)) return undefined;
  const preview = parseFileChangePreview(value);
  if (!preview || contentBytes !== preview.after.bytes) return undefined;
  return { ...preview, content: value.content };
}
