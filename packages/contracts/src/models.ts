export type ModelConnectionStatus = 'active' | 'disabled';
export type ModelConnectionTestStatus = 'unknown' | 'passed' | 'failed';

export interface ModelConnectionSummary {
  id: string;
  name: string;
  provider: string;
  modelIdentifier: string;
  baseUrl: string;
  capabilities: Record<string, boolean>;
  status: ModelConnectionStatus;
  secretConfigured: boolean;
  lastTestStatus: ModelConnectionTestStatus;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConnectionListResponse {
  connections: ModelConnectionSummary[];
}

export interface ModelConnectionInput {
  name: string;
  provider: string;
  modelIdentifier: string;
  /** Write-only managed secret. It is never returned by the API. */
  secret?: string;
  /** Optional server-side reference for deployments using an external secret store. */
  secretRef?: string;
  baseUrl: string;
  capabilities: Record<string, boolean>;
}

export interface ModelConnectionTestResponse {
  status: 'passed';
  provider: string;
  model: string;
  finishReason: string | null;
  usage: Record<string, number>;
  testedAt: string;
}

export type ChatMessageRole = 'user' | 'assistant';

export interface ChatMessageInput {
  role: ChatMessageRole;
  content: string;
}

export type ChatRoutingMode = 'fixed' | 'jev';

export interface ChatRoutingInput {
  mode: ChatRoutingMode;
  /** Optional allow-list. Jev mode uses all active workspace models when omitted. */
  candidateModelConnectionIds?: string[];
}

export interface ChatRequest {
  modelConnectionId?: string;
  routing?: ChatRoutingInput;
  /** Continue an existing conversation owned by the current user. */
  sessionId?: string;
  messages: ChatMessageInput[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  sessionId: string;
  runId: string;
  stepId: string;
  message: ChatMessageInput;
  provider: string;
  model: string;
  finishReason: string | null;
  usage: Record<string, number>;
}

/** POST /chat acknowledges durable submission; read the Run for its result. */
export interface ChatAcceptedResponse {
  sessionId: string;
  runId: string;
  stepId: string;
  status: 'queued';
}
