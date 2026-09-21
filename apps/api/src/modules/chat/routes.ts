import { parseChatRequest, type ChatAcceptedResponse } from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { chatSessions, modelConnections, runEvents, runs, runSteps } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';
import { getWorkspaceAccess } from '../workspaces/access.js';
import { getModelSecretKey, resolveModelSecret } from '../models/secrets.js';

interface WorkspaceParams {
  workspaceId: string;
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

      const body = parseChatRequest(request.body);
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

      // Resolve and validate the server-side secret before persisting a run.
      // Configuration errors should not leave an orphaned run in `running`.
      let apiKey: string | undefined;
      try {
        if (connection.secretRef === 'managed') getModelSecretKey();
        apiKey = await resolveModelSecret(connection.secretRef, connection.secretCiphertext);
      } catch {
        return secretStoreUnavailable(reply);
      }
      if (!apiKey) return connectionUnavailable(reply);

      let sessionId = body.sessionId;
      const firstUserMessage = body.messages.find((message) => message.role === 'user');
      const sessionTitle = firstUserMessage?.content.slice(0, 80) || '新对话';
      const execution = await context.database.db.transaction(async (tx) => {
        if (sessionId) {
          const [session] = await tx
            .select()
            .from(chatSessions)
            .where(
              and(
                eq(chatSessions.id, sessionId),
                eq(chatSessions.workspaceId, request.params.workspaceId),
                eq(chatSessions.ownerUserId, context.user.id),
                eq(chatSessions.status, 'active'),
              ),
            )
            .for('update');
          if (!session) return { error: 'session_not_found' } as const;
          const active = await tx
            .select({ id: runs.id })
            .from(runs)
            .where(and(eq(runs.sessionId, sessionId), inArray(runs.status, ['queued', 'running'])))
            .limit(1);
          if (active.length) return { error: 'session_busy' } as const;
        }
        if (!sessionId) {
          const [createdSession] = await tx
            .insert(chatSessions)
            .values({
              workspaceId: request.params.workspaceId,
              ownerUserId: context.user.id,
              title: sessionTitle,
            })
            .returning({ id: chatSessions.id });
          if (!createdSession) throw new Error('session insert returned no row');
          sessionId = createdSession.id;
        }

        const [run] = await tx
          .insert(runs)
          .values({
            workspaceId: request.params.workspaceId,
            sessionId,
            triggerUserId: context.user.id,
            modelConnectionId: connection.id,
            status: 'queued',
            input: {
              messages: body.messages,
              modelConnectionId: connection.id,
              maxTokens: body.maxTokens ?? 1024,
              ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
              modelConfig: {
                provider: connection.provider,
                model: connection.modelIdentifier,
                baseUrl: connection.baseUrl,
                updatedAt: connection.updatedAt.toISOString(),
              },
            },
          })
          .returning({ id: runs.id });
        if (!run) throw new Error('run insert returned no row');

        const [step] = await tx
          .insert(runSteps)
          .values({
            runId: run.id,
            sequence: 1,
            kind: 'model',
            status: 'queued',
            input: { messages: body.messages, modelConnectionId: connection.id },
          })
          .returning({ id: runSteps.id });
        if (!step) throw new Error('run step insert returned no row');

        await tx.insert(runEvents).values([
          {
            runId: run.id,
            sequence: 1,
            type: 'run.created',
            payload: { modelConnectionId: connection.id },
          },
          {
            runId: run.id,
            sequence: 2,
            type: 'step.queued',
            stepId: step.id,
            payload: { kind: 'model' },
          },
        ]);
        await tx
          .update(chatSessions)
          .set({ updatedAt: sql`now()` })
          .where(eq(chatSessions.id, sessionId));
        return { sessionId, runId: run.id, stepId: step.id };
      });

      if ('error' in execution) {
        return reply.code(execution.error === 'session_busy' ? 409 : 404).send({
          error: {
            code: execution.error,
            message:
              execution.error === 'session_busy'
                ? '当前对话已有任务，请等待完成或取消'
                : '对话不存在',
          },
        });
      }
      const response: ChatAcceptedResponse = { ...execution, status: 'queued' };
      return reply.code(202).send(response);
    },
  );
}
