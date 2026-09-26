import { expect, test } from '@playwright/test';

test('admin audit renders friendly structured summaries without raw metadata', async ({ page }) => {
  let auditRequests = 0;
  let modelLogRequests = 0;
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
      const scope = new URL(route.request().url()).searchParams.get('scope');
      if (scope === 'model') modelLogRequests += 1;
      else auditRequests += 1;
      return route.fulfill({
        json: {
          records: [
            {
              id: 'audit-route-1',
              action: 'model_routing.completed',
              resourceType: 'model_routing',
              resourceId: 'run-1',
              actorUserId: '12345678-1234-4234-8234-123456789abc',
              metadata: {
                runId: 'run-1',
                router: 'jev',
                routerModel: 'jev-latest',
                selectedCandidateId: 'model-deepseek',
                confidence: 0.84,
                durationMs: 125,
                probabilities: { 'model-deepseek': 0.84, 'model-general': 0.16 },
                candidates: [
                  { id: 'model-deepseek', provider: 'deepseek', model: 'deepseek-chat' },
                  { id: 'model-general', provider: 'openai', model: 'gpt-4.1-mini' },
                ],
              },
              createdAt: '2026-09-26T09:00:01.000Z',
            },
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
                durationMs: 830,
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
  await expect(page).toHaveURL(/\/admin\/overview$/);
  await expect(page.getByRole('heading', { name: '管理入口' })).toBeVisible();
  await page
    .getByRole('navigation', { name: '管理员导航' })
    .getByRole('button', { name: '调用流水' })
    .click();
  await expect(page).toHaveURL(/\/admin\/llm-calls$/);
  await expect(page.getByRole('heading', { name: '模型调用日志' })).toBeVisible();
  await expect(page.getByText('Jev 模型路由', { exact: true })).toBeVisible();
  await expect(
    page.getByText('jev-latest · 选择 deepseek / deepseek-chat · 置信度 84.0% · 125 ms', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText('候选概率', { exact: true }).click();
  await expect(page.getByText('openai / gpt-4.1-mini', { exact: true })).toBeVisible();
  await expect(page.getByText('84.0%', { exact: true })).toBeVisible();
  await expect.poll(() => modelLogRequests).toBe(1);
  await page.getByRole('button', { name: '模型请求', exact: true }).click();
  await expect(page.locator('.model-log-row')).toHaveCount(1);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page
    .getByRole('navigation', { name: '管理员导航' })
    .getByRole('button', { name: '审计日志' })
    .click();
  await expect(page).toHaveURL(/\/admin\/audit-logs$/);
  await expect(page.getByRole('heading', { name: '审计记录' })).toBeVisible();
  await expect(page.getByText('模型调用已完成', { exact: true })).toBeVisible();
  await expect(
    page.getByText('第 2 轮 · deepseek / deepseek-chat · 42 tokens', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('工具调用失败', { exact: true })).toBeVisible();
  await expect(page.getByText(rawPromptMarker)).toHaveCount(0);
  await page.getByRole('button', { name: '刷新审计记录' }).click();
  await expect.poll(() => auditRequests).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect
    .poll(() =>
      page
        .locator('.admin-layout-aside')
        .evaluate((element) => element.getBoundingClientRect().left),
    )
    .toBeGreaterThanOrEqual(0);
  await page
    .getByRole('navigation', { name: '管理员导航' })
    .getByRole('button', { name: '调用流水' })
    .click();
  await expect(page.getByRole('heading', { name: '模型调用日志' })).toBeVisible();
  await expect(page.getByLabel('调用状态')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
