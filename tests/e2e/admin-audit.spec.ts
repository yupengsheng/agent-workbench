import { expect, test } from '@playwright/test';

test('admin audit renders friendly structured summaries without raw metadata', async ({ page }) => {
  let auditRequests = 0;
  const rawPromptMarker = 'raw-prompt-must-not-render';
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/health')) {
      return route.fulfill({
        json: { status: 'ok', service: 'agent-workbench-api', apiVersion: 'v1' },
      });
    }
    if (path.endsWith('/auth/me')) {
      return route.fulfill({
        json: { user: { id: 'user-1', email: 'admin@example.test', displayName: 'Admin' } },
      });
    }
    if (path === '/api/v1/workspaces') {
      return route.fulfill({
        json: { workspaces: [{ id: 'workspace-1', name: '研发空间', role: 'owner' }] },
      });
    }
    if (path.endsWith('/model-connections')) {
      return route.fulfill({ json: { connections: [] } });
    }
    if (path.endsWith('/agents')) return route.fulfill({ json: { agents: [] } });
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [] } });
    if (path.endsWith('/audit-records')) {
      auditRequests += 1;
      return route.fulfill({
        json: {
          records: [
            {
              id: 'audit-1',
              action: 'model_call.completed',
              resourceType: 'model_call',
              resourceId: 'run-1',
              actorUserId: '12345678-1234-4234-8234-123456789abc',
              metadata: {
                runId: 'run-1',
                round: 2,
                provider: 'deepseek',
                model: 'deepseek-chat',
                usage: { totalTokens: 42 },
                prompt: rawPromptMarker,
              },
              createdAt: '2026-09-26T09:00:00.000Z',
            },
            {
              id: 'audit-2',
              action: 'tool_call.failed',
              resourceType: 'tool_call',
              resourceId: 'step-1',
              actorUserId: '12345678-1234-4234-8234-123456789abc',
              metadata: {
                runId: 'run-1',
                toolName: 'read_file',
                stepStatus: 'failed',
              },
              createdAt: '2026-09-26T08:59:00.000Z',
            },
          ],
          nextOffset: null,
        },
      });
    }
    throw new Error(`Unhandled fixture route ${path}`);
  });

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '审计记录' })).toBeVisible();
  await expect(page.getByText('模型调用已完成', { exact: true })).toBeVisible();
  await expect(
    page.getByText('第 2 轮 · deepseek / deepseek-chat · 42 tokens', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('工具调用失败', { exact: true })).toBeVisible();
  await expect(page.getByText(rawPromptMarker)).toHaveCount(0);
  await page.getByRole('button', { name: '刷新审计记录' }).click();
  await expect.poll(() => auditRequests).toBe(2);
});
