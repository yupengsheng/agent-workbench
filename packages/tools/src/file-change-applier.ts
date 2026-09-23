import { constants as fsConstants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileChangePreview } from '@agent-workbench/contracts';

const MAX_FILE_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FileChangeApplyResult =
  | { status: 'applied' }
  | { status: 'failed'; code: string; message: string }
  | { status: 'unknown'; code: string; message: string };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function inside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return (
    value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith(sep))
  );
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function resolveWorkspaceFile(rootDirectory: string, workspaceId: string, value: string) {
  if (!UUID.test(workspaceId)) throw new Error('workspace_id_invalid');
  if (
    !value ||
    value.length > 512 ||
    value.startsWith('/') ||
    /[\x00-\x1f\x7f\\:]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('invalid_path');
  const root = await realpath(resolve(rootDirectory));
  const workspace = await realpath(resolve(root, workspaceId));
  if (!inside(root, workspace)) throw new Error('path_denied');
  const candidate = resolve(workspace, value);
  if (!inside(workspace, candidate)) throw new Error('path_denied');
  const candidateInfo = await lstat(candidate);
  if (candidateInfo.isSymbolicLink()) throw new Error('path_denied');
  if (!candidateInfo.isFile()) throw new Error('not_file');
  if (candidateInfo.nlink > 1) throw new Error('path_denied');
  const actual = await realpath(candidate);
  if (actual !== candidate || !inside(workspace, actual)) throw new Error('path_denied');
  return {
    path: actual,
    mode: candidateInfo.mode & 0o777,
    device: candidateInfo.dev,
    inode: candidateInfo.ino,
  };
}

/**
 * Apply one exact-content proposal. The caller must already hold a durable
 * approval/apply lease; this function never retries and treats write errors as
 * unknown because the rename may have happened before the error was observed.
 */
export async function applyFileChange(
  rootDirectory: string,
  workspaceId: string,
  preview: FileChangePreview,
  content: string,
  signal?: AbortSignal,
): Promise<FileChangeApplyResult> {
  if (signal?.aborted) return { status: 'unknown', code: 'cancelled', message: '写入被取消' };
  if (!preview.changed)
    return { status: 'failed', code: 'no_change', message: '提案没有实际文件变化' };
  if (bytes(content) > MAX_FILE_BYTES || /\u0000/.test(content))
    return { status: 'failed', code: 'invalid_content', message: '待写入内容不是受支持的文本文件' };
  if (sha256(content) !== preview.after.sha256 || bytes(content) !== preview.after.bytes)
    return { status: 'failed', code: 'proposal_content_mismatch', message: '提案内容摘要不匹配' };

  let target: { path: string; mode: number; device: number; inode: number };
  try {
    target = await resolveWorkspaceFile(rootDirectory, workspaceId, preview.path);
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : error instanceof Error
          ? error.message
          : 'path_denied';
    const messages: Record<string, string> = {
      workspace_id_invalid: '工作空间标识不合法',
      invalid_path: '文件路径不合法',
      path_denied: '文件路径超出工作区范围',
      not_file: '目标不是普通文件',
      ENOENT: '文件或工作区不存在',
    };
    return { status: 'failed', code, message: messages[code] ?? '无法定位目标文件' };
  }

  let current: string;
  let raw: Buffer;
  try {
    raw = await readFile(target.path);
  } catch {
    return { status: 'failed', code: 'read_failed', message: '无法读取目标文件' };
  }
  try {
    current = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return { status: 'failed', code: 'invalid_utf8', message: '目标文件不是有效的 UTF-8 文本' };
  }
  if (bytes(current) > MAX_FILE_BYTES || /\u0000/.test(current))
    return { status: 'failed', code: 'binary_file', message: '目标文件不是受支持的文本文件' };
  if (sha256(current) !== preview.before.sha256 || bytes(current) !== preview.before.bytes)
    return {
      status: 'failed',
      code: 'before_hash_mismatch',
      message: '目标文件在审批后已经发生变化',
    };
  if (signal?.aborted) return { status: 'unknown', code: 'cancelled', message: '写入被取消' };

  const temporary = join(dirname(target.path), `.agent-workbench-${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      target.mode || 0o600,
    );
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (signal?.aborted)
      return { status: 'unknown', code: 'cancelled', message: '写入被取消，结果需要人工核对' };
    const latest = await lstat(target.path);
    if (
      latest.isSymbolicLink() ||
      !latest.isFile() ||
      latest.nlink > 1 ||
      latest.dev !== target.device ||
      latest.ino !== target.inode
    )
      return {
        status: 'failed',
        code: 'before_hash_mismatch',
        message: '目标文件在审批后已经发生变化',
      };
    const latestText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await readFile(target.path),
    );
    if (sha256(latestText) !== preview.before.sha256 || bytes(latestText) !== preview.before.bytes)
      return {
        status: 'failed',
        code: 'before_hash_mismatch',
        message: '目标文件在审批后已经发生变化',
      };
    await rename(temporary, target.path);
    return { status: 'applied' };
  } catch (error) {
    return {
      status: 'unknown',
      code: 'write_unknown',
      message: error instanceof Error ? `写入结果不明：${error.message}` : '写入结果不明',
    };
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
