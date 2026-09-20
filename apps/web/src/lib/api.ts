import type { HealthResponse } from '@agent-workbench/contracts';

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/v1/health', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`服务检查失败（HTTP ${response.status}）`);
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('status' in body) ||
    body.status !== 'ok' ||
    !('service' in body) ||
    body.service !== 'agent-workbench-api' ||
    !('apiVersion' in body) ||
    body.apiVersion !== 'v1'
  ) {
    throw new Error('服务返回了无法识别的健康状态');
  }
  return { status: body.status, service: body.service, apiVersion: body.apiVersion };
}
