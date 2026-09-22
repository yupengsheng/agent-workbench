import type {
  ChatMessage,
  ModelPort,
  ModelResponse,
  ModelUsage,
  ToolCall,
  ToolDefinition,
} from './model/types.js';

export interface LoopToolResult {
  status: string;
  content: string;
  truncated?: boolean;
  errorCode?: string;
}

export interface LoopToolExecutor {
  execute(call: ToolCall, signal?: AbortSignal): Promise<LoopToolResult>;
}

export interface AgentLoopLimits {
  maxRounds?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
}

export interface AgentLoopEvent {
  type: 'model.started' | 'model.completed' | 'tool.started' | 'tool.completed';
  round: number;
  call?: ToolCall;
  toolResult?: LoopToolResult;
  response?: ModelResponse;
}

export interface AgentLoopOptions extends AgentLoopLimits {
  tools: ToolDefinition[];
  executor: LoopToolExecutor;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
}

export interface AgentLoopResult {
  message: ChatMessage;
  messages: ChatMessage[];
  usage: ModelUsage;
  rounds: number;
  toolCalls: number;
  provider: string;
  model: string;
  finishReason: string | null;
}

export class AgentLoopError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'cancelled'
      | 'empty_model_output'
      | 'max_rounds'
      | 'max_tool_calls'
      | 'max_tokens'
      | 'invalid_tool_call',
  ) {
    super(message);
    this.name = 'AgentLoopError';
  }
}

function addUsage(total: ModelUsage, current: ModelUsage): ModelUsage {
  const currentTotal =
    current.totalTokens ?? (current.promptTokens ?? 0) + (current.completionTokens ?? 0);
  return {
    promptTokens: (total.promptTokens ?? 0) + (current.promptTokens ?? 0),
    completionTokens: (total.completionTokens ?? 0) + (current.completionTokens ?? 0),
    totalTokens: (total.totalTokens ?? 0) + currentTotal,
  };
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new AgentLoopError('执行已取消', 'cancelled');
}

/**
 * Minimal Think-Act-Observe loop. The model decides whether to answer or call
 * one of the registered tools; the executor remains the deterministic policy
 * boundary and is never replaced by model text.
 */
export async function executeAgentLoop(
  model: ModelPort,
  initialMessages: ChatMessage[],
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const messages = [...initialMessages];
  const maxRounds = options.maxRounds ?? 8;
  const maxToolCalls = options.maxToolCalls ?? 16;
  const maxTotalTokens = options.maxTotalTokens ?? 16_384;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 32)
    throw new Error('maxRounds is invalid');
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 64)
    throw new Error('maxToolCalls is invalid');
  if (!Number.isInteger(maxTotalTokens) || maxTotalTokens < 1 || maxTotalTokens > 100_000)
    throw new Error('maxTotalTokens is invalid');
  let usage: ModelUsage = {};
  let toolCalls = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    assertNotAborted(options.signal);
    await options.onEvent?.({ type: 'model.started', round });
    const response = await model.complete({
      ...(options.model ? { model: options.model } : {}),
      messages,
      tools: options.tools,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    usage = addUsage(usage, response.usage);
    if ((usage.totalTokens ?? 0) > maxTotalTokens)
      throw new AgentLoopError('模型累计 Token 超过本次运行上限', 'max_tokens');
    messages.push(response.message);
    await options.onEvent?.({ type: 'model.completed', round, response });
    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      if (!response.message.content?.trim())
        throw new AgentLoopError('模型未返回文本或工具调用', 'empty_model_output');
      return {
        message: response.message,
        messages,
        usage,
        rounds: round,
        toolCalls,
        provider: response.provider,
        model: response.model,
        finishReason: response.finishReason,
      };
    }
    if (toolCalls + calls.length > maxToolCalls) {
      throw new AgentLoopError('工具调用次数超过本次运行上限', 'max_tool_calls');
    }
    for (const call of calls) {
      if (
        !call.id ||
        call.type !== 'function' ||
        !call.function?.name ||
        typeof call.function.arguments !== 'string'
      ) {
        throw new AgentLoopError('模型返回了无效的工具调用', 'invalid_tool_call');
      }
      toolCalls += 1;
      assertNotAborted(options.signal);
      await options.onEvent?.({ type: 'tool.started', round, call });
      const toolResult = await options.executor.execute(call, options.signal);
      messages.push({ role: 'tool', toolCallId: call.id, content: toolResult.content });
      await options.onEvent?.({ type: 'tool.completed', round, call, toolResult });
    }
  }
  throw new AgentLoopError('模型工具循环超过轮次上限', 'max_rounds');
}
