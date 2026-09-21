import { OpenAICompatibleModelClient } from './openai-compatible.js';
import type { ModelClientOptions } from './types.js';

export interface DeepSeekClientOptions extends Omit<
  ModelClientOptions,
  'baseUrl' | 'defaultModel'
> {
  baseUrl?: string;
  defaultModel?: string;
}

export function createDeepSeekClient(options: DeepSeekClientOptions) {
  return new OpenAICompatibleModelClient('deepseek', {
    ...options,
    baseUrl: options.baseUrl ?? 'https://api.deepseek.com',
    defaultModel: options.defaultModel ?? 'deepseek-chat',
  });
}
