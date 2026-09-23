import { expect, test } from '@playwright/test';

test('refresh restores history, clearing starts a new session, workspaces remain separate', async ({
  page,
}) => {
  const sessions = new Map<string, { session: { id: string }; runs: unknown[] }>();
  const submissions: Array<{ workspace: string; sessionId?: string }> = [];
  const runs = new Map<
    string,
    {
      run: {
        id: string;
        status: string;
        input: { messages: unknown[] };
        output: unknown;
        cancelRequestedAt: string | null;
      };
      steps: never[];
      events: never[];
    }
  >();
  const answers = new Map<string, unknown>();
  let holdRun = false;
  let pauseRestore = false;
  let releaseRestore: (() => void) | undefined;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown;
    if (path.endsWith('/health'))
      body = { status: 'ok', service: 'agent-workbench-api', apiVersion: 'v1' };
    else if (path.endsWith('/auth/me'))
      body = { user: { id: 'user-1', email: 'fixture@example.test', displayName: 'Fixture' } };
    else if (path === '/api/v1/workspaces')
      body = { workspaces: ['one', 'two'].map((id) => ({ id, name: id, role: 'owner' })) };
    else if (path.endsWith('/model-connections'))
      body = {
        connections: [
          {
            id: path.includes('/one/') ? 'model-one' : 'model-two',
            name: 'Fixture model',
            modelIdentifier: 'fixture',
            status: 'active',
            secretConfigured: true,
          },
        ],
      };
    else if (path.endsWith('/agents')) body = { agents: [] };
    else if (path.endsWith('/sessions')) {
      body = {
        sessions: [...sessions.entries()].map(([id, value], index) => ({
          id,
          workspaceId: path.split('/')[4],
          title: `对话 ${index + 1}`,
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
      };
    } else if (path.endsWith('/chat')) {
      const input = request.postDataJSON();
      const workspace = path.split('/')[4]!;
      submissions.push({ workspace, sessionId: input.sessionId });
      const id = input.sessionId ?? `session-${sessions.size + 1}`;
      const message = { role: 'assistant', content: `answer for ${input.messages.at(-1).content}` };
      const runId = `run-${submissions.length}`;
      const detail = {
        run: {
          id: runId,
          status: 'queued',
          input: { messages: input.messages },
          output: null as unknown,
          cancelRequestedAt: null as string | null,
        },
        steps: [],
        events: [],
      };
      runs.set(runId, detail);
      answers.set(runId, message);
      sessions.set(id, { session: { id }, runs: [detail] });
      body = { sessionId: id, runId, stepId: 'step', status: 'queued' };
    } else if (path.includes('/runs/')) {
      const runId = path.split('/')[6]!;
      const detail = runs.get(runId)!;
      if (path.endsWith('/cancel')) {
        detail.run.cancelRequestedAt = new Date().toISOString();
      } else if (detail.run.cancelRequestedAt) {
        detail.run.status = 'cancelled';
      } else if (holdRun) {
        detail.run.status = 'running';
      } else {
        detail.run.status = 'succeeded';
        detail.run.output = { message: answers.get(runId) };
      }
      body = detail;
    } else if (path.includes('/sessions/')) {
      if (pauseRestore)
        await new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
      body = sessions.get(path.split('/').at(-1)!);
    } else throw new Error(`Unhandled fixture route ${path}`);
    await route.fulfill({ json: body, status: path.endsWith('/chat') ? 202 : 200 });
  });

  await page.goto('/app');
  await page.locator('textarea').fill('first question');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('answer for first question', { exact: true })).toBeVisible();
  expect(submissions[0]?.sessionId).toBeUndefined();

  pauseRestore = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('status')).toHaveText('正在恢复对话…');
  await expect(page.locator('textarea')).toBeDisabled();
  await expect.poll(() => Boolean(releaseRestore)).toBe(true);
  releaseRestore!();
  pauseRestore = false;
  await expect(page.getByText('answer for first question', { exact: true })).toBeVisible();
  await page.locator('textarea').fill('follow up');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('answer for follow up', { exact: true })).toBeVisible();
  expect(submissions[1]?.sessionId).toBe('session-1');

  await page.getByRole('button', { name: '清空对话' }).click();
  await page.locator('textarea').fill('new question');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('answer for new question', { exact: true })).toBeVisible();
  expect(submissions[2]?.sessionId).toBeUndefined();

  await page.locator('.workspace-picker select').selectOption('two');
  await expect(page.getByText('answer for new question', { exact: true })).toHaveCount(0);
  await page.locator('textarea').fill('other workspace');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('answer for other workspace', { exact: true })).toBeVisible();
  expect(submissions[3]).toEqual({ workspace: 'two', sessionId: undefined });
  holdRun = true;
  await page.locator('textarea').fill('background question');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('正在生成回复…', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.getByText('正在取消，等待执行器确认…', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('任务已取消');
  await expect(page.locator('textarea')).toBeEnabled();
});
