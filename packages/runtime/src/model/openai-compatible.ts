import type {
  ChatMessage,
  ModelClientOptions,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ToolCall,
} from './types.js';
import { ModelRequestError } from './types.js';

interface ProviderResponse {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

interface ResolvedModelClientOptions extends Omit<ModelClientOptions, 'fetch'> {
  fetch: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.type !== 'function')
      return undefined;
    if (!isRecord(item.function) || typeof item.function.name !== 'string') return undefined;
    const args = item.function.arguments;
    if (typeof args !== 'string') return undefined;
    calls.push({
      id: item.id,
      type: 'function',
      function: { name: item.function.name, arguments: args },
    });
  }
  return calls;
}

function parseUsage(value: unknown): ModelUsage {
  if (!isRecord(value)) return {};
  const usage: ModelUsage = {};
  if (typeof value.prompt_tokens === 'number') usage.promptTokens = value.prompt_tokens;
  if (typeof value.completion_tokens === 'number') usage.completionTokens = value.completion_tokens;
  if (typeof value.total_tokens === 'number') usage.totalTokens = value.total_tokens;
  return usage;
}

function parseMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || value.role !== 'assistant') return undefined;
  const content =
    value.content === null || typeof value.content === 'string' ? value.content : undefined;
  if (content === undefined) return undefined;
  const toolCalls = value.tool_calls === undefined ? undefined : parseToolCalls(value.tool_calls);
  if (value.tool_calls !== undefined && !toolCalls) return undefined;
  return {
    role: 'assistant',
    content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function parseProviderResponse(body: unknown):
  | {
      id?: string;
      model: string;
      message: ChatMessage;
      finishReason: string | null;
      usage: ModelUsage;
    }
  | undefined {
  if (!isRecord(body)) return undefined;
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0];
  if (!isRecord(choice)) return undefined;
  const message = parseMessage(choice.message);
  if (!message) return undefined;
  const model = typeof body.model === 'string' ? body.model : undefined;
  const finishReason =
    choice.finish_reason === null || typeof choice.finish_reason === 'string'
      ? choice.finish_reason
      : undefined;
  if (!model || finishReason === undefined) return undefined;
  return {
    ...(typeof body.id === 'string' ? { id: body.id } : {}),
    model,
    message,
    finishReason,
    usage: parseUsage(body.usage),
  };
}

function retryableStatus(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

export class OpenAICompatibleModelClient implements ModelPort {
  readonly provider: string;
  private readonly options: ResolvedModelClientOptions;

  constructor(provider: string, options: ModelClientOptions) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(provider)) {
      throw new Error('provider must be a normalized identifier');
    }
    if (!options.apiKey.trim()) throw new Error('apiKey is required');
    if (!options.defaultModel.trim()) throw new Error('defaultModel is required');
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('baseUrl must use http or https');
    this.provider = provider;
    this.options = { ...options, baseUrl, fetch: options.fetch ?? fetch };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new ModelRequestError('at least one message is required', {
        provider: this.provider,
        retryable: false,
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.options.fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model ?? this.options.defaultModel,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.name ? { name: message.name } : {}),
            ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
            ...(message.toolCalls ? { tool_calls: message.toolCalls } : {}),
          })),
          ...(request.tools ? { tools: request.tools } : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ModelRequestError(`model provider returned HTTP ${response.status}`, {
          provider: this.provider,
          statusCode: response.status,
          retryable: retryableStatus(response.status),
        });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ModelRequestError('model provider returned invalid JSON', {
          provider: this.provider,
          retryable: false,
        });
      }
      const parsed = parseProviderResponse(body);
      if (!parsed) {
        throw new ModelRequestError('model provider returned an unsupported response shape', {
          provider: this.provider,
          retryable: false,
        });
      }
      return { provider: this.provider, ...parsed };
    } catch (error) {
      if (error instanceof ModelRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ModelRequestError('model request timed out or was cancelled', {
          provider: this.provider,
          retryable: true,
        });
      }
      throw new ModelRequestError('model request failed', {
        provider: this.provider,
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}
