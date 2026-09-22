import type { ChatRequest } from './models.js';

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function parseChatRequest(body: unknown): ChatRequest | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;

  let modelConnectionId: string | undefined;
  if (candidate.modelConnectionId !== undefined) {
    if (typeof candidate.modelConnectionId !== 'string' || !isUuid(candidate.modelConnectionId)) {
      return undefined;
    }
    modelConnectionId = candidate.modelConnectionId;
  }

  let routing: ChatRequest['routing'];
  if (candidate.routing !== undefined) {
    if (
      typeof candidate.routing !== 'object' ||
      candidate.routing === null ||
      Array.isArray(candidate.routing)
    ) {
      return undefined;
    }
    const routingCandidate = candidate.routing as Record<string, unknown>;
    if (routingCandidate.mode !== 'fixed' && routingCandidate.mode !== 'jev') return undefined;
    const ids = routingCandidate.candidateModelConnectionIds;
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 16) return undefined;
      const parsedIds: string[] = [];
      for (const id of ids) {
        if (typeof id !== 'string' || !isUuid(id) || parsedIds.includes(id)) return undefined;
        parsedIds.push(id);
      }
      routing = { mode: routingCandidate.mode, candidateModelConnectionIds: parsedIds };
    } else {
      routing = { mode: routingCandidate.mode };
    }
  }

  const mode = routing?.mode ?? 'fixed';
  if (mode === 'fixed') {
    if (!modelConnectionId || routing?.candidateModelConnectionIds) return undefined;
  } else {
    if (modelConnectionId) return undefined;
  }
  if (candidate.sessionId !== undefined) {
    if (typeof candidate.sessionId !== 'string' || !isUuid(candidate.sessionId)) return undefined;
  }
  if (
    !Array.isArray(candidate.messages) ||
    candidate.messages.length < 1 ||
    candidate.messages.length > 40
  ) {
    return undefined;
  }

  let totalLength = 0;
  const messages: ChatRequest['messages'] = [];
  for (const item of candidate.messages) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return undefined;
    const message = item as Record<string, unknown>;
    if (message.role !== 'user' && message.role !== 'assistant') return undefined;
    if (typeof message.content !== 'string') return undefined;
    const content = message.content.trim();
    if (!content || content.length > 16_000) return undefined;
    totalLength += content.length;
    if (totalLength > 100_000) return undefined;
    messages.push({ role: message.role, content });
  }
  if (messages[messages.length - 1]?.role !== 'user') return undefined;

  const temperature = candidate.temperature;
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    return undefined;
  }
  const maxTokens = candidate.maxTokens;
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' ||
      !Number.isInteger(maxTokens) ||
      maxTokens < 1 ||
      maxTokens > 8192)
  ) {
    return undefined;
  }
  return {
    ...(modelConnectionId ? { modelConnectionId } : {}),
    ...(routing ? { routing } : {}),
    ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
    messages,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}
