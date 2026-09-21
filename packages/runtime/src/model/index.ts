export { createDeepSeekClient } from './deepseek.js';
export { OpenAICompatibleModelClient } from './openai-compatible.js';
export { createEnvironmentSecretResolver } from './secrets.js';
export type { SecretResolver } from './secrets.js';
export { ModelRequestError } from './types.js';
export type {
  ChatMessage,
  ModelClientOptions,
  ModelPort,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ToolCall,
  ToolDefinition,
} from './types.js';
