import type { ChatResponse } from '@agent-workbench/contracts';
import {
  createDeepSeekClient,
  ModelRequestError,
  OpenAICompatibleModelClient,
} from '@agent-workbench/runtime';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { modelConnections } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';
import { getWorkspaceAccess } from '../workspaces/access.js';
import { getModelSecretKey, resolveModelSecret } from '../models/secrets.js';

interface WorkspaceParams {
  workspaceId: string;
}

interface ChatBody {
  modelConnectionId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'database_unavailable', message: '服务暂时不可用' },
  });
}

function unauthorized(reply: FastifyReply) {
  return reply.code(401).send({
    error: { code: 'unauthorized', message: '请先登录' },
  });
}

function invalidRequest(reply: FastifyReply, message = '对话请求格式不正确') {
  return reply.code(400).send({ error: { code: 'invalid_request', message } });
}

function connectionUnavailable(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      code: 'model_connection_unavailable',
      message: '模型连接不存在、已停用或尚未配置密钥',
    },
  });
}

function secretStoreUnavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: 'model_secret_store_unavailable',
      message: '服务端尚未配置模型密钥加密主密钥，请联系管理员完成部署配置',
    },
  });
}

function parseChatBody(body: unknown): ChatBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.modelConnectionId !== 'string' || !isUuid(candidate.modelConnectionId)) {
    return undefined;
  }
  if (
    !Array.isArray(candidate.messages) ||
    candidate.messages.length < 1 ||
    candidate.messages.length > 40
  ) {
    return undefined;
  }

  let totalLength = 0;
  const messages: ChatBody['messages'] = [];
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
    modelConnectionId: candidate.modelConnectionId,
    messages,
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

async function authenticateWorkspace(
  request: FastifyRequest,
  reply: FastifyReply,
  database: DatabaseHandle | undefined,
  workspaceId: string,
) {
  if (!isUuid(workspaceId)) {
    reply.code(404).send({ error: { code: 'workspace_not_found', message: '工作空间不存在' } });
    return undefined;
  }
  if (!database) {
    unavailable(reply);
    return undefined;
  }
  const user = await getAuthenticatedUser(request, database);
  if (!user) {
    unauthorized(reply);
    return undefined;
  }
  const access = await getWorkspaceAccess(database, user.id, workspaceId);
  if (!access) {
    reply.code(404).send({ error: { code: 'workspace_not_found', message: '工作空间不存在' } });
    return undefined;
  }
  return { database, user };
}

export async function registerChatRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.post(
    '/api/v1/workspaces/:workspaceId/chat',
    async (request: FastifyRequest<{ Params: WorkspaceParams; Body: unknown }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;

      const body = parseChatBody(request.body);
      if (!body) {
        return invalidRequest(reply, '请提供有效的模型连接和对话消息，最后一条消息必须来自用户');
      }

      const [connection] = await context.database.db
        .select()
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, body.modelConnectionId),
            eq(modelConnections.workspaceId, request.params.workspaceId),
            eq(modelConnections.status, 'active'),
          ),
        )
        .limit(1);
      if (!connection) return connectionUnavailable(reply);

      let apiKey: string | undefined;
      try {
        if (connection.secretRef === 'managed') getModelSecretKey();
        apiKey = await resolveModelSecret(connection.secretRef, connection.secretCiphertext);
      } catch {
        return secretStoreUnavailable(reply);
      }
      if (!apiKey) return connectionUnavailable(reply);

      const client =
        connection.provider === 'deepseek'
          ? createDeepSeekClient({
              apiKey,
              baseUrl: connection.baseUrl,
              defaultModel: connection.modelIdentifier,
            })
          : new OpenAICompatibleModelClient(connection.provider, {
              apiKey,
              baseUrl: connection.baseUrl,
              defaultModel: connection.modelIdentifier,
            });

      try {
        const result = await client.complete({
          messages: body.messages,
          ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
          maxTokens: body.maxTokens ?? 1024,
        });
        const response: ChatResponse = {
          message: {
            role: 'assistant',
            content: result.message.content ?? '',
          },
          provider: result.provider,
          model: result.model,
          finishReason: result.finishReason,
          usage: {
            ...(result.usage.promptTokens === undefined
              ? {}
              : { promptTokens: result.usage.promptTokens }),
            ...(result.usage.completionTokens === undefined
              ? {}
              : { completionTokens: result.usage.completionTokens }),
            ...(result.usage.totalTokens === undefined
              ? {}
              : { totalTokens: result.usage.totalTokens }),
          },
        };
        return reply.send(response);
      } catch (error) {
        const modelError = error instanceof ModelRequestError ? error : undefined;
        return reply.code(502).send({
          error: {
            code: 'model_request_failed',
            message: modelError?.message ?? '模型请求失败，请稍后重试',
            retryable: modelError?.retryable ?? true,
          },
        });
      }
    },
  );
}
