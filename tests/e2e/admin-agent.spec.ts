import { expect, test } from '@playwright/test';

test('admin can create an Agent draft from the management page', async ({ page }) => {
  let created = false;
  let submittedBody: Record<string, unknown> | undefined;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
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
      return route.fulfill({
        json: {
          connections: [
            {
              id: 'model-1',
              name: 'DeepSeek',
              provider: 'deepseek',
              modelIdentifier: 'deepseek-chat',
              baseUrl: 'https://api.deepseek.com',
              capabilities: { chat: true, tools: true },
              status: 'active',
              secretConfigured: true,
              lastTestStatus: 'passed',
              lastTestedAt: '2026-09-26T08:00:00.000Z',
            },
          ],
        },
      });
    }
    if (path.endsWith('/agents') && request.method() === 'POST') {
      submittedBody = request.postDataJSON() as Record<string, unknown>;
      created = true;
      return route.fulfill({
        status: 201,
        json: {
          agent: {
            id: 'agent-1',
            slug: 'coding-agent',
            name: '代码助手',
            description: '读取代码并给出建议',
            status: 'active',
            currentVersionId: null,
            createdAt: '2026-09-26T09:00:00.000Z',
            updatedAt: '2026-09-26T09:00:00.000Z',
          },
          versions: [],
        },
      });
    }
    if (path.endsWith('/agents')) {
      return route.fulfill({
        json: {
          agents: created
            ? [
                {
                  id: 'agent-1',
                  slug: 'coding-agent',
                  name: '代码助手',
                  description: '读取代码并给出建议',
                  status: 'active',
                  currentVersionId: null,
                  createdAt: '2026-09-26T09:00:00.000Z',
                  updatedAt: '2026-09-26T09:00:00.000Z',
                },
              ]
            : [],
        },
      });
    }
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [] } });
    throw new Error(`Unhandled fixture route ${request.method()} ${path}`);
  });

  await page.goto('/admin/agents');
  await expect(page.getByRole('heading', { name: 'Agent 管理' })).toBeVisible();
  await page.getByRole('button', { name: '新增 Agent' }).click();
  await page.getByLabel('名称').fill('代码助手');
  await page.getByLabel('标识').fill('coding-agent');
  await page.getByLabel('描述').fill('读取代码并给出建议');
  await page.getByLabel('默认模型').selectOption('model-1');
  await page.getByLabel('系统提示词').fill('你是一个受控的代码助手。');
  await page.getByRole('button', { name: '创建草稿' }).click();

  await expect(page.getByText('Agent 草稿已创建')).toBeVisible();
  await expect(page.getByText('coding-agent', { exact: true })).toBeVisible();
  expect(submittedBody).toEqual({
    name: '代码助手',
    slug: 'coding-agent',
    description: '读取代码并给出建议',
    config: {
      modelConnectionId: 'model-1',
      systemPrompt: '你是一个受控的代码助手。',
    },
  });
});
