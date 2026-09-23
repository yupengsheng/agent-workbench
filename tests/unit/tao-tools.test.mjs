import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createReadOnlyToolRegistry } from '../../packages/tools/dist/index.js';
import { AgentLoopError, executeAgentLoop } from '../../packages/runtime/dist/index.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';

test('read-only tools enforce workspace boundaries and return structured observations', async () => {
  const root = await mkdtemp('/tmp/agent-workbench-tools-');
  const workspace = join(root, workspaceId);
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'hello.ts'), 'export const answer = 42;\n');
  await writeFile(join(workspace, 'src', 'main.ts'), 'import { answer } from "./hello";\n');
  await writeFile(join(workspace, 'package.json'), '{"scripts":{"test":"node test.js"}}\n');
  await writeFile(join(workspace, 'secret.txt'), 'do not leave workspace\n');
  await writeFile(join(root, 'secret.txt'), 'outside workspace\n');
  await symlink(join(root, 'secret.txt'), join(workspace, 'escape.txt'));
  const registry = createReadOnlyToolRegistry(root);

  const read = await registry.execute('read_file', JSON.stringify({ path: 'src/hello.ts' }), {
    workspaceId,
  });
  assert.equal(read.status, 'success');
  assert.match(read.content, /answer = 42/);

  const escaped = await registry.execute('read_file', JSON.stringify({ path: 'escape.txt' }), {
    workspaceId,
  });
  assert.equal(escaped.status, 'denied');

  const glob = await registry.execute('glob', JSON.stringify({ pattern: '**/*.ts' }), {
    workspaceId,
  });
  assert.equal(glob.status, 'success');
  assert.match(glob.content, /src\/hello\.ts/);

  const grep = await registry.execute('grep', JSON.stringify({ pattern: 'answer' }), {
    workspaceId,
  });
  assert.equal(grep.status, 'success');
  assert.match(grep.content, /hello\.ts/);

  const analysis = await registry.execute('analyze_workspace', '{}', { workspaceId });
  assert.equal(analysis.status, 'success');
  const report = JSON.parse(analysis.content);
  assert.equal(report.kind, 'workspace_analysis');
  assert.equal(report.summary.fileCount, 4);
  assert.equal(report.summary.languages['.ts'], 2);
  assert.deepEqual(
    report.sources.map((source) => source.path),
    ['package.json', 'src/main.ts'],
  );
  assert.match(report.citationInstruction, /sources\.path/);

  const proposalContent = 'export const answer = 43;\n';
  const proposal = await registry.execute(
    'propose_file_change',
    JSON.stringify({
      path: 'src/hello.ts',
      content: proposalContent,
      reason: '修复示例答案',
    }),
    { workspaceId },
  );
  assert.equal(proposal.status, 'success');
  const change = JSON.parse(proposal.content);
  assert.equal(change.kind, 'file_change_proposal');
  assert.equal(change.approvalRequired, true);
  assert.equal(change.path, 'src/hello.ts');
  assert.match(change.patch, /-export const answer = 42;/);
  assert.match(change.patch, /\+export const answer = 43;/);
  assert.notEqual(change.before.sha256, change.after.sha256);
  assert.equal(
    await readFile(join(workspace, 'src', 'hello.ts'), 'utf8'),
    'export const answer = 42;\n',
  );
});

test('TAO loop observes tool output and stops on a final model answer', async () => {
  const calls = [];
  let round = 0;
  const model = {
    provider: 'fixture',
    async complete(request) {
      calls.push(request);
      round += 1;
      if (round === 1) {
        return {
          provider: 'fixture',
          model: 'fixture-model',
          message: {
            role: 'assistant',
            content: null,
            toolCalls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          finishReason: 'tool_calls',
          usage: { totalTokens: 2 },
        };
      }
      assert.equal(request.messages.at(-1).role, 'tool');
      return {
        provider: 'fixture',
        model: 'fixture-model',
        message: { role: 'assistant', content: '已读取文件' },
        finishReason: 'stop',
        usage: { totalTokens: 3 },
      };
    },
  };
  const result = await executeAgentLoop(model, [{ role: 'user', content: '读取 a.txt' }], {
    tools: [
      { type: 'function', function: { name: 'read_file', description: 'read', parameters: {} } },
    ],
    executor: {
      async execute(call) {
        assert.equal(call.function.name, 'read_file');
        return { status: 'success', content: '{"content":"hello"}' };
      },
    },
  });
  assert.equal(result.message.content, '已读取文件');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.usage.totalTokens, 5);
  assert.equal(calls.length, 2);
});

test('TAO loop enforces round budget', async () => {
  const model = {
    provider: 'fixture',
    async complete() {
      return {
        provider: 'fixture',
        model: 'fixture',
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: crypto.randomUUID(), type: 'function', function: { name: 'x', arguments: '{}' } },
          ],
        },
        finishReason: 'tool_calls',
        usage: {},
      };
    },
  };
  await assert.rejects(
    executeAgentLoop(model, [{ role: 'user', content: 'loop' }], {
      tools: [],
      executor: { execute: async () => ({ status: 'success', content: '{}' }) },
      maxRounds: 1,
    }),
    (error) => error instanceof AgentLoopError && error.code === 'max_rounds',
  );
});

test('TAO loop enforces cumulative token budget', async () => {
  const model = {
    provider: 'fixture',
    async complete() {
      return {
        provider: 'fixture',
        model: 'fixture',
        message: { role: 'assistant', content: 'answer' },
        finishReason: 'stop',
        usage: { totalTokens: 11 },
      };
    },
  };
  await assert.rejects(
    executeAgentLoop(model, [{ role: 'user', content: 'budget' }], {
      tools: [],
      executor: { execute: async () => ({ status: 'success', content: '{}' }) },
      maxTotalTokens: 10,
    }),
    (error) => error instanceof AgentLoopError && error.code === 'max_tokens',
  );
});
