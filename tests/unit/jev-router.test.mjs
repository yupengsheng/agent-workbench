import assert from 'node:assert/strict';
import test from 'node:test';
import { parseChatRequest } from '../../packages/contracts/dist/index.js';
import { ModelRouterError, TypeSafeJevModelRouter } from '../../packages/runtime/dist/index.js';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';

function candidates() {
  return [
    { id: firstId, provider: 'deepseek', model: 'deepseek-chat', capabilities: { tools: true } },
    { id: secondId, provider: 'openai', model: 'gpt-4o-mini', capabilities: { tools: false } },
  ];
}

test('chat contract accepts Jev routing without a fixed model', () => {
  const request = parseChatRequest({
    routing: { mode: 'jev', candidateModelConnectionIds: [firstId, secondId] },
    messages: [{ role: 'user', content: '分析这个问题' }],
  });
  assert.equal(request?.routing?.mode, 'jev');
  assert.equal(request?.modelConnectionId, undefined);
});

test('chat contract rejects fixed routing without a model or duplicate candidates', () => {
  assert.equal(
    parseChatRequest({ routing: { mode: 'fixed' }, messages: [{ role: 'user', content: 'x' }] }),
    undefined,
  );
  assert.equal(
    parseChatRequest({
      routing: { mode: 'jev', candidateModelConnectionIds: [firstId, firstId] },
      messages: [{ role: 'user', content: 'x' }],
    }),
    undefined,
  );
});

test('Jev router returns the selected candidate and probabilities', async () => {
  let body;
  const router = new TypeSafeJevModelRouter({
    apiKey: 'test-key',
    fetch: async (_input, init) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            selected_model: {
              type: 'choice',
              choice: firstId,
              confidence: 0.91,
              probabilities: { [firstId]: 0.91, [secondId]: 0.09 },
            },
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const decision = await router.choose('需要工具读取代码', candidates());
  assert.equal(decision.selectedId, firstId);
  assert.equal(decision.confidence, 0.91);
  assert.equal(decision.probabilities[secondId], 0.09);
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.questions.selected_model.type, 'choice');
});

test('Jev router rejects an unrecognized candidate returned by the service', async () => {
  const router = new TypeSafeJevModelRouter({
    apiKey: 'test-key',
    fetch: async () =>
      new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            selected_model: {
              type: 'choice',
              choice: 'not-authorized',
              confidence: 0.99,
              probabilities: { 'not-authorized': 1 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  await assert.rejects(
    router.choose('test', candidates()),
    (error) => error instanceof ModelRouterError && error.code === 'router_invalid_response',
  );
});

test('Jev router rejects an incomplete probability distribution', async () => {
  const router = new TypeSafeJevModelRouter({
    apiKey: 'test-key',
    fetch: async () =>
      new Response(
        JSON.stringify({
          model: 'jev-latest',
          answers: {
            selected_model: {
              type: 'choice',
              choice: firstId,
              confidence: 0.8,
              probabilities: { [firstId]: 0.8 },
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  await assert.rejects(
    router.choose('test', candidates()),
    (error) => error instanceof ModelRouterError && error.code === 'router_invalid_response',
  );
});
