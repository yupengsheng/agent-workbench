import { expect, test } from '@playwright/test';

test('Jev automatic routing submits an allow-list-free routing request', async ({ page }) => {
  let chatRequest: Record<string, unknown> | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    if (path.endsWith('/health')) {
      body = { status: 'ok', service: 'agent-workbench-api', apiVersion: 'v1' };
    } else if (path.endsWith('/auth/me')) {
      body = { user: { id: 'user-1', email: 'fixture@example.test', displayName: 'Fixture' } };
    } else if (path === '/api/v1/workspaces') {
      body = { workspaces: [{ id: 'one', name: 'one', role: 'owner' }] };
    } else if (path.endsWith('/model-connections')) {
      body = {
        connections: [
          {
            id: 'model-one',
            name: 'Fixture model',
            modelIdentifier: 'fixture',
            status: 'active',
            secretConfigured: true,
          },
        ],
      };
    } else if (path.endsWith('/agents')) {
      body = { agents: [] };
    } else if (path.endsWith('/sessions')) {
      body = { sessions: [] };
    } else if (path.endsWith('/chat')) {
      chatRequest = request.postDataJSON() as Record<string, unknown>;
      body = { sessionId: 'session-1', runId: 'run-1', stepId: 'step-1', status: 'queued' };
    } else if (path.endsWith('/events')) {
      const event = {
        id: 'event-route',
        runId: 'run-1',
        sequence: 1,
        type: 'model.routed',
        stepId: null,
        payload: {
          selectedCandidateId: 'model-one',
          candidates: [{ id: 'model-one', provider: 'fixture', model: 'fixture' }],
        },
        createdAt: new Date().toISOString(),
      };
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `id: 1\nevent: run\ndata: ${JSON.stringify(event)}\n\nevent: end\ndata: {"status":"succeeded"}\n\n`,
      });
      return;
    } else if (path.includes('/runs/')) {
      body = {
        run: {
          id: 'run-1',
          modelConnectionId: 'model-one',
          status: 'succeeded',
          input: { messages: [{ role: 'user', content: '自动选择模型' }] },
          output: { message: { role: 'assistant', content: '已完成' } },
          cancelRequestedAt: null,
        },
        steps: [],
        events: [
          {
            id: 'event-route',
            type: 'model.routed',
            payload: {
              selectedCandidateId: 'model-one',
              candidates: [{ id: 'model-one', provider: 'fixture', model: 'fixture' }],
            },
          },
        ],
      };
    } else if (path.includes('/sessions/')) {
      body = {
        session: { id: 'session-1' },
        runs: [],
      };
    } else {
      throw new Error(`Unhandled fixture route ${path}`);
    }
    await route.fulfill({ json: body, status: path.endsWith('/chat') ? 202 : 200 });
  });

  await page.goto('/app');
  await page
    .locator('select')
    .filter({ has: page.locator('option[value="__jev__"]') })
    .selectOption('__jev__');
  await page.locator('textarea').fill('自动选择模型');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('已完成', { exact: true })).toBeVisible();
  expect(chatRequest?.modelConnectionId).toBeUndefined();
  expect(chatRequest?.routing).toEqual({ mode: 'jev' });
  await expect(page.getByText('本次使用：Fixture model', { exact: true })).toBeVisible();
  await expect(page.getByText('Jev 已选择 fixture/fixture', { exact: true })).toBeVisible();
});
