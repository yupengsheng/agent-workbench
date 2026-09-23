import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

export type ToolStatus = 'success' | 'error' | 'denied' | 'cancelled';

export interface ToolExecutionResult {
  status: ToolStatus;
  content: string;
  truncated?: boolean;
  errorCode?: string;
  /** Private Runner payload; never sent as the model observation. */
  fileChange?: Record<string, unknown>;
}

export interface ToolContext {
  workspaceId: string;
  signal?: AbortSignal;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ReadOnlyTool {
  readonly definition: ToolDefinition;
  execute(argumentsJson: string, context: ToolContext): Promise<ToolExecutionResult>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_MATCHES = 200;
const MAX_VISITED = 8_000;
const MAX_ANALYSIS_FILES = 500;
const MAX_ANALYSIS_SOURCES = 80;
const MAX_PROPOSED_FILE_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function makeResult(
  status: ToolStatus,
  value: Record<string, unknown>,
  extra: Partial<ToolExecutionResult> = {},
): ToolExecutionResult {
  const raw = stringify(value);
  if (raw.length <= MAX_OUTPUT_CHARS) return { status, content: raw, ...extra };
  const safe: Record<string, unknown> = { ...value, truncated: true };
  if (typeof safe.content === 'string') safe.content = safe.content.slice(0, MAX_OUTPUT_CHARS);
  if (Array.isArray(safe.matches)) {
    while (stringify(safe).length > MAX_OUTPUT_CHARS && safe.matches.length > 0) safe.matches.pop();
  }
  const safeContent = stringify(safe);
  return {
    status,
    content:
      safeContent.length <= MAX_OUTPUT_CHARS
        ? safeContent
        : stringify({ status: 'truncated', truncated: true }),
    truncated: true,
    ...extra,
  };
}

function errorResult(status: 'error' | 'denied' | 'cancelled', code: string, message: string) {
  return makeResult(status, { error: message, code }, { errorCode: code });
}

function parseObject(argumentsJson: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return (
    value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !value.startsWith(sep))
  );
}

function pathError(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return 'path 必须是非空字符串';
  if (value.length > 512 || value.includes('\0')) return 'path 长度或内容不合法';
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return '不允许绝对路径';
  return undefined;
}

function asInteger(value: unknown, fallback: number, min: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    return undefined;
  return value;
}

class PathPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PathPolicyError';
  }
}

function policyResult(error: unknown): ToolExecutionResult {
  if (error instanceof PathPolicyError) return errorResult('denied', error.code, error.message);
  return errorResult('error', 'tool_failed', '工具执行失败');
}

class WorkspacePathResolver {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
  }

  async workspaceDirectory(workspaceId: string): Promise<string> {
    if (!UUID.test(workspaceId))
      throw new PathPolicyError('workspace_id_invalid', '工作空间标识不合法');
    let rootReal: string;
    try {
      rootReal = await realpath(this.root);
    } catch {
      throw new PathPolicyError('workspace_missing', '工作区根目录不存在');
    }
    const directory = resolve(rootReal, workspaceId);
    if (!isInside(rootReal, directory))
      throw new PathPolicyError('path_denied', '工作区路径不合法');
    try {
      const real = await realpath(directory);
      if (!isInside(rootReal, real)) throw new PathPolicyError('path_denied', '工作区路径不合法');
      return real;
    } catch (error) {
      if (error instanceof PathPolicyError) throw error;
      throw new PathPolicyError('workspace_missing', '工作区目录不存在');
    }
  }

  async existingPath(workspaceId: string, value: unknown): Promise<string> {
    const invalid = pathError(value);
    if (invalid) throw new PathPolicyError('invalid_path', invalid);
    const workspace = await this.workspaceDirectory(workspaceId);
    const candidate = resolve(workspace, value as string);
    if (!isInside(workspace, candidate))
      throw new PathPolicyError('path_denied', '路径超出工作区范围');
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new PathPolicyError('not_found', '文件或目录不存在');
    }
    if (!isInside(workspace, real))
      throw new PathPolicyError('path_denied', '符号链接目标超出工作区范围');
    return real;
  }

  async directory(workspaceId: string, value: unknown): Promise<string> {
    const path = await this.existingPath(workspaceId, value === undefined ? '.' : value);
    if (!(await stat(path)).isDirectory())
      throw new PathPolicyError('not_directory', '搜索范围必须是目录');
    return path;
  }

  display(workspaceId: string, path: string): string {
    const workspace = resolve(this.root, workspaceId);
    return relative(workspace, path).split(sep).join('/') || '.';
  }
}

function checkCancelled(signal?: AbortSignal): ToolExecutionResult | undefined {
  return signal?.aborted ? errorResult('cancelled', 'cancelled', '工具执行已取消') : undefined;
}

async function readLimited(path: string, strictUtf8 = false) {
  const info = await stat(path);
  if (!info.isFile()) throw new PathPolicyError('not_file', '目标不是普通文件');
  const length = Math.min(info.size, MAX_FILE_BYTES + 1);
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, 0);
    let text: string;
    try {
      text = strictUtf8
        ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            buffer.subarray(0, Math.min(read.bytesRead, MAX_FILE_BYTES)),
          )
        : buffer.subarray(0, Math.min(read.bytesRead, MAX_FILE_BYTES)).toString('utf8');
    } catch {
      throw new PathPolicyError('invalid_utf8', '目标文件不是有效的 UTF-8 文本');
    }
    return {
      text,
      bytes: info.size,
      truncated: info.size > MAX_FILE_BYTES || read.bytesRead > MAX_FILE_BYTES,
    };
  } finally {
    await handle.close();
  }
}

function globToRegExp(pattern: string): RegExp {
  let output = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') index += 1;
        output += '.*';
      } else output += '[^/]*';
    } else if (char === '?') output += '[^/]';
    else {
      const value = char ?? '';
      output += /[\\^$+{}.()|[\]]/.test(value) ? `\\${value}` : value;
    }
  }
  return new RegExp(`${output}$`);
}

async function walk(
  directory: string,
  signal: AbortSignal | undefined,
  visit: (path: string, isDirectory: boolean) => Promise<boolean>,
) {
  const stack = [directory];
  let visited = 0;
  while (stack.length > 0) {
    if (signal?.aborted) return { visited, stopped: true };
    const current = stack.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (signal?.aborted) return { visited, stopped: true };
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.'))
        continue;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      visited += 1;
      if (visited > MAX_VISITED) return { visited, stopped: true };
      const isDirectory = entry.isDirectory();
      if (!(await visit(path, isDirectory))) return { visited, stopped: true };
      if (isDirectory) stack.push(path);
    }
  }
  return { visited, stopped: false };
}

function patternArg(args: Record<string, unknown>): string | undefined {
  if (typeof args.pattern !== 'string' || args.pattern.trim() === '' || args.pattern.length > 256)
    return undefined;
  const pattern = args.pattern.replaceAll('\\', '/');
  if (pattern.startsWith('/') || pattern.split('/').some((part) => part === '..')) return undefined;
  return pattern;
}

function fileExtension(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '(none)';
}

function sourceReason(path: string): string | undefined {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (name === 'package.json') return '项目依赖与脚本入口';
  if (name === 'readme.md' || name === 'readme') return '项目说明与使用入口';
  if (name === 'tsconfig.json' || name === 'pyproject.toml' || name === 'go.mod') {
    return '语言与构建配置';
  }
  if (
    name === 'main.ts' ||
    name === 'main.js' ||
    name === 'index.ts' ||
    name === 'index.js' ||
    name === 'app.ts' ||
    name === 'app.js'
  ) {
    return '应用入口候选';
  }
  if (name === 'dockerfile' || name === 'compose.yaml' || name === 'docker-compose.yml') {
    return '部署与运行入口';
  }
  return undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class ReadOnlyToolRegistry {
  private readonly resolver: WorkspacePathResolver;
  private readonly tools: ReadOnlyTool[];

  constructor(rootDirectory: string) {
    this.resolver = new WorkspacePathResolver(rootDirectory);
    this.tools = [
      this.createReadFileTool(),
      this.createGlobTool(),
      this.createGrepTool(),
      this.createWorkspaceAnalysisTool(),
      this.createFileChangeProposalTool(),
    ];
  }

  definitions(): ToolDefinition[] {
    return this.tools.map((tool) => tool.definition);
  }

  async execute(
    name: string,
    argumentsJson: string,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.find((candidate) => candidate.definition.function.name === name);
    if (!tool) return errorResult('denied', 'unknown_tool', `未允许调用工具: ${name}`);
    return tool.execute(argumentsJson, context);
  }

  private createReadFileTool(): ReadOnlyTool {
    const resolver = this.resolver;
    return {
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取工作区内的 UTF-8 文本文件，可选按行截取。只读且结果有大小上限。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对于工作区根目录的文件路径' },
              startLine: { type: 'integer', minimum: 1 },
              endLine: { type: 'integer', minimum: 1 },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson, context) {
        const cancelled = checkCancelled(context.signal);
        if (cancelled) return cancelled;
        const args = parseObject(argumentsJson);
        if (!args) return errorResult('error', 'invalid_arguments', '工具参数必须是 JSON 对象');
        try {
          const path = await resolver.existingPath(context.workspaceId, args.path);
          const raw = await readLimited(path);
          if (/\u0000/.test(raw.text.slice(0, 8192)))
            return errorResult('denied', 'binary_file', '不支持读取二进制文件');
          const lines = raw.text.split(/\r?\n/);
          const start = asInteger(args.startLine, 1, 1, 100_000);
          const end = asInteger(args.endLine, lines.length, 1, 100_000);
          if (start === undefined || end === undefined || end < start)
            return errorResult('error', 'invalid_arguments', '行号范围不合法');
          const selected = lines.slice(start - 1, end).join('\n');
          const outputTruncated = raw.truncated || selected.length > MAX_OUTPUT_CHARS;
          return makeResult(
            'success',
            {
              path: resolver.display(context.workspaceId, path),
              content: selected.slice(0, MAX_OUTPUT_CHARS),
              startLine: start,
              endLine: Math.min(end, lines.length),
              totalLines: lines.length,
              bytes: raw.bytes,
              truncated: outputTruncated,
            },
            { truncated: outputTruncated },
          );
        } catch (error) {
          return policyResult(error);
        }
      },
    };
  }

  private createGlobTool(): ReadOnlyTool {
    const resolver = this.resolver;
    return {
      definition: {
        type: 'function',
        function: {
          name: 'glob',
          description: '在工作区内按 glob 模式查找文件路径，不跟随符号链接。',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: '例如 src/**/*.ts' },
              path: { type: 'string', description: '可选的相对目录' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson, context) {
        const cancelled = checkCancelled(context.signal);
        if (cancelled) return cancelled;
        const args = parseObject(argumentsJson);
        const pattern = args && patternArg(args);
        if (!args || !pattern)
          return errorResult('error', 'invalid_arguments', 'pattern 参数不合法');
        try {
          const root = await resolver.directory(context.workspaceId, args.path);
          const matcher = globToRegExp(pattern);
          const matches: string[] = [];
          const walked = await walk(root, context.signal, async (path, isDirectory) => {
            if (isDirectory) return true;
            const value = resolver.display(context.workspaceId, path);
            if (matcher.test(value)) matches.push(value);
            return matches.length < MAX_MATCHES;
          });
          const outputTruncated = matches.length >= MAX_MATCHES || walked.stopped;
          return makeResult(
            'success',
            { pattern, matches, truncated: outputTruncated },
            { truncated: outputTruncated },
          );
        } catch (error) {
          return context.signal?.aborted
            ? errorResult('cancelled', 'cancelled', '工具执行已取消')
            : policyResult(error);
        }
      },
    };
  }

  private createGrepTool(): ReadOnlyTool {
    const resolver = this.resolver;
    return {
      definition: {
        type: 'function',
        function: {
          name: 'grep',
          description: '在工作区文本文件中搜索正则表达式，返回文件、行号和匹配行。',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'JavaScript 正则表达式' },
              path: { type: 'string', description: '可选的相对文件或目录' },
              caseSensitive: { type: 'boolean' },
              maxResults: { type: 'integer', minimum: 1, maximum: 200 },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson, context) {
        const cancelled = checkCancelled(context.signal);
        if (cancelled) return cancelled;
        const args = parseObject(argumentsJson);
        if (
          !args ||
          typeof args.pattern !== 'string' ||
          args.pattern.length === 0 ||
          args.pattern.length > 512
        ) {
          return errorResult('error', 'invalid_arguments', 'pattern 参数不合法');
        }
        const maxResults = asInteger(args.maxResults, 100, 1, MAX_MATCHES);
        if (
          maxResults === undefined ||
          (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean')
        ) {
          return errorResult('error', 'invalid_arguments', 'grep 参数不合法');
        }
        let matcher: RegExp;
        try {
          matcher = new RegExp(args.pattern, args.caseSensitive === false ? 'gi' : 'g');
        } catch {
          return errorResult('error', 'invalid_pattern', 'pattern 不是有效的正则表达式');
        }
        try {
          const target = await resolver.existingPath(context.workspaceId, args.path ?? '.');
          const info = await stat(target);
          const matches: Array<Record<string, unknown>> = [];
          const visitFile = async (path: string) => {
            if (matches.length >= maxResults || context.signal?.aborted) return false;
            try {
              const raw = await readLimited(path);
              if (raw.truncated || /\u0000/.test(raw.text.slice(0, 8192))) return true;
              const lines = raw.text.split(/\r?\n/);
              for (
                let lineIndex = 0;
                lineIndex < lines.length && matches.length < maxResults;
                lineIndex += 1
              ) {
                matcher.lastIndex = 0;
                const line = lines[lineIndex] ?? '';
                const found = matcher.exec(line);
                if (found)
                  matches.push({
                    path: resolver.display(context.workspaceId, path),
                    line: lineIndex + 1,
                    column: found.index + 1,
                    text: line.slice(0, 1000),
                  });
              }
            } catch {
              // A single unreadable file should not abort a workspace search.
            }
            return matches.length < maxResults;
          };
          let stopped = false;
          if (info.isDirectory()) {
            const walked = await walk(target, context.signal, async (path, isDirectory) =>
              isDirectory ? true : visitFile(path),
            );
            stopped = walked.stopped;
          } else if (info.isFile()) await visitFile(target);
          else return errorResult('denied', 'not_searchable', '目标不是文件或目录');
          if (context.signal?.aborted)
            return errorResult('cancelled', 'cancelled', '工具执行已取消');
          const outputTruncated = matches.length >= maxResults || stopped;
          return makeResult(
            'success',
            { pattern: args.pattern, matches, truncated: outputTruncated },
            { truncated: outputTruncated },
          );
        } catch (error) {
          return policyResult(error);
        }
      },
    };
  }

  private createWorkspaceAnalysisTool(): ReadOnlyTool {
    const resolver = this.resolver;
    return {
      definition: {
        type: 'function',
        function: {
          name: 'analyze_workspace',
          description:
            '生成工作区代码目录分析摘要。返回文件统计、语言分布、入口候选和可引用的来源路径；只读，不读取文件正文。用户要求分析项目结构或生成目录报告时优先使用。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '可选的相对目录，默认工作区根目录' },
              maxFiles: { type: 'integer', minimum: 1, maximum: 500 },
            },
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson, context) {
        const cancelled = checkCancelled(context.signal);
        if (cancelled) return cancelled;
        const args = parseObject(argumentsJson);
        if (!args) return errorResult('error', 'invalid_arguments', '工具参数必须是 JSON 对象');
        const maxFiles = asInteger(args.maxFiles, MAX_ANALYSIS_FILES, 1, MAX_ANALYSIS_FILES);
        if (maxFiles === undefined)
          return errorResult('error', 'invalid_arguments', 'maxFiles 参数不合法');
        try {
          const root = await resolver.directory(context.workspaceId, args.path ?? '.');
          const files: Array<{ path: string; extension: string; bytes: number }> = [];
          const languageCounts = new Map<string, number>();
          const sourceCandidates: Array<{ path: string; reason: string }> = [];
          let directoryCount = 0;
          let totalBytes = 0;
          let stopped = false;
          const walked = await walk(root, context.signal, async (path, isDirectory) => {
            if (isDirectory) {
              directoryCount += 1;
              return true;
            }
            if (files.length >= maxFiles) return false;
            try {
              const info = await stat(path);
              if (!info.isFile()) return true;
              const displayPath = resolver.display(context.workspaceId, path);
              const extension = fileExtension(displayPath);
              files.push({ path: displayPath, extension, bytes: info.size });
              totalBytes += info.size;
              languageCounts.set(extension, (languageCounts.get(extension) ?? 0) + 1);
              const reason = sourceReason(displayPath);
              if (reason && sourceCandidates.length < MAX_ANALYSIS_SOURCES) {
                sourceCandidates.push({ path: displayPath, reason });
              }
              return true;
            } catch {
              return true;
            }
          });
          stopped = walked.stopped || files.length >= maxFiles;
          if (context.signal?.aborted)
            return errorResult('cancelled', 'cancelled', '工具执行已取消');
          files.sort((left, right) => left.path.localeCompare(right.path));
          sourceCandidates.sort((left, right) => left.path.localeCompare(right.path));
          const languages = Object.fromEntries(
            [...languageCounts.entries()].sort((left, right) => right[1] - left[1]),
          );
          return makeResult(
            'success',
            {
              kind: 'workspace_analysis',
              root: resolver.display(context.workspaceId, root),
              summary: {
                fileCount: files.length,
                directoryCount,
                totalBytes,
                languages,
                truncated: stopped,
              },
              files,
              sources: sourceCandidates,
              sourceCount: sourceCandidates.length,
              sourcesTruncated: sourceCandidates.length >= MAX_ANALYSIS_SOURCES,
              citationInstruction:
                '引用来源时使用 sources.path；报告中的结构性结论必须能回指到这些路径。',
            },
            { truncated: stopped },
          );
        } catch (error) {
          return context.signal?.aborted
            ? errorResult('cancelled', 'cancelled', '工具执行已取消')
            : policyResult(error);
        }
      },
    };
  }

  private createFileChangeProposalTool(): ReadOnlyTool {
    const resolver = this.resolver;
    return {
      definition: {
        type: 'function',
        function: {
          name: 'propose_file_change',
          description:
            '提出一个文件修改预览，返回统一 diff、前后 SHA-256 和审批要求。工具本身只读；批准后由 Runner 重新校验并单文件原子应用，不要在审批前宣称修改已应用。',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '相对于工作区根目录的现有文本文件路径' },
              content: { type: 'string', description: '修改后的完整 UTF-8 文本内容' },
              reason: { type: 'string', description: '本次修改的目的，最多 500 个字符' },
            },
            required: ['path', 'content', 'reason'],
            additionalProperties: false,
          },
        },
      },
      async execute(argumentsJson, context) {
        const cancelled = checkCancelled(context.signal);
        if (cancelled) return cancelled;
        const args = parseObject(argumentsJson);
        if (
          !args ||
          Object.keys(args).some((key) => !['path', 'content', 'reason'].includes(key)) ||
          typeof args.path !== 'string' ||
          /[\x00-\x1f\x7f\\:]/.test(args.path) ||
          typeof args.content !== 'string' ||
          typeof args.reason !== 'string' ||
          args.reason.trim() === '' ||
          args.reason.length > 500
        ) {
          return errorResult('error', 'invalid_arguments', 'path、content 和 reason 参数不合法');
        }
        const content = args.content;
        if (Buffer.from(content, 'utf8').toString('utf8') !== content)
          return errorResult('error', 'invalid_utf8', '修改内容必须是有效的 UTF-8 文本');
        if (Buffer.byteLength(content, 'utf8') > MAX_PROPOSED_FILE_BYTES)
          return errorResult('error', 'content_too_large', '待修改文件不能超过 256 KiB');
        if (/\u0000/.test(content))
          return errorResult('denied', 'binary_file', '不支持对二进制内容提出修改');
        try {
          const path = await resolver.existingPath(context.workspaceId, args.path);
          const raw = await readLimited(path, true);
          if (raw.truncated || raw.bytes > MAX_PROPOSED_FILE_BYTES || /\u0000/.test(raw.text))
            return errorResult('denied', 'binary_file', '不支持对二进制或超大文件提出修改');
          const displayPath = resolver.display(context.workspaceId, path);
          if (/[\x00-\x1f\x7f\\:]/.test(displayPath))
            return errorResult('denied', 'invalid_path', '文件路径不能用于差异预览');
          if (context.signal?.aborted)
            return errorResult('cancelled', 'cancelled', '工具执行已取消');
          const beforeHash = sha256(raw.text);
          const afterHash = sha256(content);
          const changed = beforeHash !== afterHash;
          const preview = {
            kind: 'file_change_proposal',
            version: 1,
            path: displayPath,
            operation: 'update',
            changed,
            reason: args.reason.trim(),
            before: { sha256: beforeHash, bytes: Buffer.byteLength(raw.text, 'utf8') },
            after: { sha256: afterHash, bytes: Buffer.byteLength(content, 'utf8') },
            patch: changed
              ? createTwoFilesPatch(
                  `a/${displayPath}`,
                  `b/${displayPath}`,
                  raw.text,
                  content,
                  '',
                  '',
                  { context: 3 },
                )
              : '',
            approvalRequired: true,
            approvalScope: 'single_file_exact_content',
            citation: { path: displayPath, beforeSha256: beforeHash, afterSha256: afterHash },
          };
          if (JSON.stringify(preview).length > MAX_OUTPUT_CHARS)
            return errorResult(
              'error',
              'preview_too_large',
              '完整变更预览超过 32,000 字符，请缩小修改范围',
            );
          return {
            ...makeResult('success', preview),
            fileChange: { ...preview, content },
          };
        } catch (error) {
          return context.signal?.aborted
            ? errorResult('cancelled', 'cancelled', '工具执行已取消')
            : policyResult(error);
        }
      },
    };
  }
}

export function createReadOnlyToolRegistry(
  rootDirectory = process.env.AGENT_WORKBENCH_WORKSPACE_ROOT ??
    join(process.cwd(), '.data', 'workspaces'),
) {
  return new ReadOnlyToolRegistry(rootDirectory);
}

export { applyFileChange, type FileChangeApplyResult } from './file-change-applier.js';
