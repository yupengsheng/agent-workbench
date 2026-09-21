export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ModelRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelResponse {
  provider: string;
  model: string;
  message: ChatMessage;
  finishReason: string | null;
  usage: ModelUsage;
  requestId?: string;
}

export interface ModelPort {
  readonly provider: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelClientOptions {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ModelRequestError extends Error {
  readonly provider: string;
  readonly statusCode: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { provider: string; statusCode?: number; retryable: boolean },
  ) {
    super(message);
    this.name = 'ModelRequestError';
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
  }
}
