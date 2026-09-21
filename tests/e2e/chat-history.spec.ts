import { expect, test } from '@playwright/test';

test('refresh restores history, clearing starts a new session, workspaces remain separate', async ({
  page,
}) => {
  const sessions = new Map<string, { session: { id: string }; runs: unknown[] }>();
  const submissions: Array<{ workspace: string; sessionId?: string }> = [];
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
    else if (path.endsWith('/chat')) {
      const input = request.postDataJSON();
      const workspace = path.split('/')[4]!;
      submissions.push({ workspace, sessionId: input.sessionId });
      const id = input.sessionId ?? `session-${sessions.size + 1}`;
      const message = { role: 'assistant', content: `answer for ${input.messages.at(-1).content}` };
      sessions.set(id, {
        session: { id },
        runs: [{ run: { input: { messages: input.messages }, output: { message } } }],
      });
      body = { sessionId: id, runId: 'run', stepId: 'step', message, usage: {} };
    } else if (path.includes('/sessions/')) {
      if (pauseRestore)
        await new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
      body = sessions.get(path.split('/').at(-1)!);
    } else throw new Error(`Unhandled fixture route ${path}`);
    await route.fulfill({ json: body });
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
});
