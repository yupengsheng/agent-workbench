import { choice, TypeSafeClient } from '@typesafe-ai/sdk';

export interface ModelRouteCandidate {
  id: string;
  provider: string;
  model: string;
  capabilities: Record<string, boolean>;
}

export interface ModelRouteDecision {
  selectedId: string;
  confidence: number;
  probabilities: Record<string, number>;
  router: 'jev';
  routerModel: 'jev-latest';
}

export type ModelRouterErrorCode =
  | 'router_unavailable'
  | 'router_invalid_response'
  | 'router_no_candidate'
  | 'router_low_confidence';

export class ModelRouterError extends Error {
  readonly code: ModelRouterErrorCode;

  constructor(code: ModelRouterErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelRouterError';
    this.code = code;
  }
}

export interface ModelRouter {
  choose(
    request: string,
    candidates: ModelRouteCandidate[],
    signal?: AbortSignal,
  ): Promise<ModelRouteDecision>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProbabilities(value: unknown, candidateIds: ReadonlySet<string>) {
  if (!isRecord(value))
    throw new ModelRouterError('router_invalid_response', 'Jev 返回的概率分布无效');
  const probabilities: Record<string, number> = {};
  for (const [id, probability] of Object.entries(value)) {
    if (!candidateIds.has(id) || typeof probability !== 'number' || !Number.isFinite(probability)) {
      throw new ModelRouterError('router_invalid_response', 'Jev 返回了未知候选或无效概率');
    }
    if (probability < 0 || probability > 1) {
      throw new ModelRouterError('router_invalid_response', 'Jev 返回了越界概率');
    }
    probabilities[id] = probability;
  }
  const total = [...candidateIds].reduce((sum, id) => sum + (probabilities[id] ?? 0), 0);
  if (candidateIds.size !== Object.keys(probabilities).length || Math.abs(total - 1) > 0.05) {
    throw new ModelRouterError('router_invalid_response', 'Jev 返回的概率分布不完整');
  }
  return probabilities;
}

export class TypeSafeJevModelRouter implements ModelRouter {
  private readonly client: TypeSafeClient;

  constructor(
    options: {
      apiKey?: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
      baseURL?: string;
    } = {},
  ) {
    if (!options.apiKey?.trim()) {
      throw new ModelRouterError('router_unavailable', '未配置 TYPESAFE_API_KEY');
    }
    this.client = new TypeSafeClient({
      apiKey: options.apiKey,
      defaultModel: 'jev-latest',
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      logLevel: 'off',
      retry: { maxRetries: 0 },
    });
  }

  async choose(
    request: string,
    candidates: ModelRouteCandidate[],
    signal?: AbortSignal,
  ): Promise<ModelRouteDecision> {
    if (candidates.length === 0) {
      throw new ModelRouterError('router_no_candidate', '没有可用于 Jev 路由的模型');
    }
    if (candidates.length === 1) {
      const only = candidates[0];
      if (!only) throw new ModelRouterError('router_no_candidate', '没有可用于 Jev 路由的模型');
      return {
        selectedId: only.id,
        confidence: 1,
        probabilities: { [only.id]: 1 },
        router: 'jev',
        routerModel: 'jev-latest',
      };
    }

    const criteria = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        {
          provider: candidate.provider,
          model: candidate.model,
          capabilities: candidate.capabilities,
        },
      ]),
    );
    let response: Awaited<ReturnType<TypeSafeClient['systemOne']>>;
    try {
      response = await this.client.systemOne(
        {
          model: 'jev-latest',
          state: {
            user_request: request,
            candidates: criteria,
          },
          questions: {
            selected_model: choice(
              '根据用户请求和候选模型能力，选择最适合完成本次请求的模型。只能选择候选项。',
              criteria,
            ),
          },
        },
        signal ? { signal } : {},
      );
    } catch (error) {
      if (error instanceof ModelRouterError) throw error;
      throw new ModelRouterError('router_unavailable', 'Jev 路由服务暂时不可用', { cause: error });
    }

    const answer = response.answers.selected_model;
    if (
      !answer ||
      answer.type !== 'choice' ||
      typeof answer.choice !== 'string' ||
      !Number.isFinite(answer.confidence)
    ) {
      throw new ModelRouterError('router_invalid_response', 'Jev 返回缺少有效选择结果');
    }
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    if (!candidateIds.has(answer.choice)) {
      throw new ModelRouterError('router_invalid_response', 'Jev 选择了未授权的模型');
    }
    if (answer.confidence < 0 || answer.confidence > 1) {
      throw new ModelRouterError('router_invalid_response', 'Jev 返回了无效置信度');
    }
    const probabilities = parseProbabilities(answer.probabilities, candidateIds);
    return {
      selectedId: answer.choice,
      confidence: answer.confidence,
      probabilities,
      router: 'jev',
      routerModel: 'jev-latest',
    };
  }
}
