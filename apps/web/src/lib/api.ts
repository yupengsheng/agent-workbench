import type {
  AgentListResponse,
  AuthResponse,
  FileChangeSummary,
  ChatRequest,
  ChatAcceptedResponse,
  RunDetailResponse,
  HealthResponse,
  ModelConnectionInput,
  ModelConnectionListResponse,
  ModelConnectionSummary,
  ModelConnectionTestResponse,
  SessionDetailResponse,
  SessionListResponse,
  ShellCommandSummary,
  WorkspaceListResponse,
} from '@agent-workbench/contracts';

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
  });
  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const body = (await response.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      // Keep the HTTP error when the server does not return JSON.
    }
    const error = new Error(message);
    Object.assign(error, { status: response.status });
    throw error;
  }
  return (await response.json()) as T;
}

export async function getHealth(): Promise<HealthResponse> {
  const body = await readJson<unknown>('/api/v1/health', { signal: AbortSignal.timeout(5000) });
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

export function getCurrentUser(): Promise<AuthResponse> {
  return readJson<AuthResponse>('/api/v1/auth/me');
}

export function login(email: string, password: string): Promise<AuthResponse> {
  return readJson<AuthResponse>('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  const response = await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
  if (!response.ok && response.status !== 204)
    throw new Error(`退出失败（HTTP ${response.status}）`);
}

export function getWorkspaces(): Promise<WorkspaceListResponse> {
  return readJson<WorkspaceListResponse>('/api/v1/workspaces');
}

export function getModelConnections(workspaceId: string): Promise<ModelConnectionListResponse> {
  return readJson<ModelConnectionListResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/model-connections`,
  );
}

export function createModelConnection(
  workspaceId: string,
  input: ModelConnectionInput,
): Promise<ModelConnectionSummary> {
  return readJson<ModelConnectionSummary>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/model-connections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export function updateModelConnection(
  workspaceId: string,
  connectionId: string,
  input: Partial<ModelConnectionInput> & { status?: 'active' | 'disabled' },
): Promise<ModelConnectionSummary> {
  return readJson<ModelConnectionSummary>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/model-connections/${encodeURIComponent(connectionId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export function testModelConnection(
  workspaceId: string,
  connectionId: string,
): Promise<ModelConnectionTestResponse> {
  return readJson<ModelConnectionTestResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/model-connections/${encodeURIComponent(connectionId)}/test`,
    { method: 'POST' },
  );
}

export function getAgents(workspaceId: string): Promise<AgentListResponse> {
  return readJson<AgentListResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/agents`,
  );
}

export function chatWithModel(
  workspaceId: string,
  input: ChatRequest,
): Promise<ChatAcceptedResponse> {
  return readJson<ChatAcceptedResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chat`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export function getSession(workspaceId: string, sessionId: string): Promise<SessionDetailResponse> {
  return readJson<SessionDetailResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export function getSessions(workspaceId: string): Promise<SessionListResponse> {
  return readJson<SessionListResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
  );
}

export function decideFileChange(
  workspaceId: string,
  proposal: FileChangeSummary,
  decision: 'approve' | 'reject',
): Promise<FileChangeSummary> {
  return readJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(proposal.runId)}/file-changes/${encodeURIComponent(proposal.id)}/decision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, digest: proposal.digest }),
      signal: AbortSignal.timeout(10000),
    },
  );
}

export function decideShellCommand(
  workspaceId: string,
  proposal: ShellCommandSummary,
  decision: 'approve' | 'reject',
): Promise<ShellCommandSummary> {
  return readJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(proposal.runId)}/shell-commands/${encodeURIComponent(proposal.id)}/decision`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, digest: proposal.digest }),
      signal: AbortSignal.timeout(10000),
    },
  );
}

export function getRun(workspaceId: string, runId: string): Promise<RunDetailResponse> {
  return readJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
    { signal: AbortSignal.timeout(10000) },
  );
}

export function cancelRun(workspaceId: string, runId: string): Promise<RunDetailResponse> {
  return readJson(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
}

export function openRunEventStream(
  workspaceId: string,
  runId: string,
  handlers: {
    onEvent: (event: RunDetailResponse['events'][number]) => void;
    onEnd: () => void;
    onError: () => void;
  },
): EventSource {
  const source = new EventSource(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/events`,
    { withCredentials: true },
  );
  source.addEventListener('run', (event) => {
    try {
      handlers.onEvent(
        JSON.parse((event as MessageEvent<string>).data) as RunDetailResponse['events'][number],
      );
    } catch {
      handlers.onError();
    }
  });
  source.addEventListener('end', () => {
    source.close();
    handlers.onEnd();
  });
  source.onerror = () => {
    source.close();
    handlers.onError();
  };
  return source;
}
