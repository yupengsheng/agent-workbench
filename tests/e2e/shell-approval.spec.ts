import { expect, test } from '@playwright/test';

test('Shell command approval shows the exact target and execution result', async ({ page }) => {
  let approved = false;
  const command = {
    id: '33333333-3333-4333-8333-333333333333',
    runId: '22222222-2222-4222-8222-222222222222',
    stepId: '44444444-4444-4444-8444-444444444444',
    proposal: {
      kind: 'shell_command_proposal',
      version: 1,
      command: 'npm test -- --runInBand',
      reason: '运行项目测试',
      approvalRequired: true,
      approvalScope: 'single_command_exact_text',
      sandbox: {
        network: 'disabled',
        workspaceAccess: 'read_write',
        timeoutMs: 30_000,
        cpuSeconds: 20,
        memoryBytes: 512 * 1024 * 1024,
        maxProcesses: 64,
        maxOutputBytes: 64 * 1024,
      },
    },
    digest: 'a'.repeat(64),
    policyVersion: 'shell-review-v1',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    executionStatus: 'not_started',
    result: null,
    executionErrorCode: null,
    executionErrorMessage: null,
  };
  const runDetail = () => ({
    run: {
      id: command.runId,
      modelConnectionId: 'model-one',
      status: 'succeeded',
      input: { messages: [{ role: 'user', content: '运行测试' }] },
      output: { message: { role: 'assistant', content: '命令已提交审阅' } },
      cancelRequestedAt: null,
    },
    steps: [],
    events: [],
    fileChanges: [],
    shellCommands: [
      approved
        ? {
            ...command,
            status: 'approved',
            executionStatus: 'succeeded',
            result: {
              exitCode: 0,
              signal: null,
              stdout: '2 tests passed',
              stderr: '',
              truncated: false,
              durationMs: 125,
            },
          }
        : command,
    ],
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/health'))
      return route.fulfill({ json: { status: 'ok', service: 'api', apiVersion: 'v1' } });
    if (path.endsWith('/auth/me'))
      return route.fulfill({ json: { user: { id: 'user-1', email: 'a@b.c', displayName: 'A' } } });
    if (path === '/api/v1/workspaces')
      return route.fulfill({ json: { workspaces: [{ id: 'one', name: 'one', role: 'owner' }] } });
    if (path.endsWith('/model-connections'))
      return route.fulfill({
        json: {
          connections: [
            {
              id: 'model-one',
              name: 'Fixture model',
              modelIdentifier: 'fixture',
              status: 'active',
              secretConfigured: true,
            },
          ],
        },
      });
    if (path.endsWith('/agents')) return route.fulfill({ json: { agents: [] } });
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [] } });
    if (path.endsWith('/chat'))
      return route.fulfill({
        status: 202,
        json: {
          sessionId: 'session-1',
          runId: command.runId,
          stepId: command.stepId,
          status: 'queued',
        },
      });
    if (path.endsWith('/events'))
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'event: end\ndata: {"status":"succeeded"}\n\n',
      });
    if (path.endsWith(`/shell-commands/${command.id}/decision`)) {
      expect(request.postDataJSON()).toEqual({ decision: 'approve', digest: command.digest });
      approved = true;
      return route.fulfill({ json: { ...command, status: 'approved' } });
    }
    if (path.includes('/runs/')) return route.fulfill({ json: runDetail() });
    throw new Error(`Unhandled fixture route ${path}`);
  });

  await page.goto('/app');
  await page.locator('textarea').fill('运行测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText(command.proposal.command, { exact: true })).toBeVisible();
  await page.getByText('执行边界').click();
  await expect(page.getByText(/网络：禁用/)).toBeVisible();
  await page.getByRole('button', { name: '批准并执行' }).click();
  await expect(page.getByText('执行成功', { exact: true })).toBeVisible();
  await page.getByText('标准输出', { exact: true }).click();
  await expect(page.getByText('2 tests passed', { exact: true })).toBeVisible();
  await expect(page.getByText(/退出码：0/)).toBeVisible();
});
