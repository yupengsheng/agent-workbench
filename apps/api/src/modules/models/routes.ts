import type {
  ModelConnectionListResponse,
  ModelConnectionStatus,
  ModelConnectionSummary,
} from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import {
  createDeepSeekClient,
  createEnvironmentSecretResolver,
  ModelRequestError,
  OpenAICompatibleModelClient,
} from '@agent-workbench/runtime';
import type { DatabaseHandle } from '../../db/client.js';
import { auditRecords, modelConnections } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';
import { canManageWorkspace, getWorkspaceAccess } from '../workspaces/access.js';

interface WorkspaceParams {
  workspaceId: string;
}

interface ConnectionParams extends WorkspaceParams {
  connectionId: string;
}

interface CreateConnectionBody {
  name: string;
  provider: string;
  modelIdentifier: string;
  secretRef: string;
  baseUrl: string;
  capabilities?: Record<string, boolean>;
}

interface UpdateConnectionBody {
  name?: string;
  modelIdentifier?: string;
  secretRef?: string;
  baseUrl?: string;
  capabilities?: Record<string, boolean>;
  status?: ModelConnectionStatus;
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

function forbidden(reply: FastifyReply) {
  return reply.code(403).send({
    error: { code: 'forbidden', message: '没有执行该操作的工作空间权限' },
  });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: 'not_found', message: '模型连接不存在' },
  });
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: {
      code: 'invalid_request',
      message: '模型连接字段格式不正确；secretRef 只能是 none、env:NAME 或 secret:PATH',
    },
  });
}

function parseCapabilities(value: unknown): Record<string, boolean> | undefined {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 32) return undefined;
  const capabilities: Record<string, boolean> = {};
  for (const [key, capability] of entries) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(key) || typeof capability !== 'boolean') {
      return undefined;
    }
    capabilities[key] = capability;
  }
  return capabilities;
}

function parseSecretRef(value: unknown): string | undefined {
  if (value === undefined) return 'none';
  if (typeof value !== 'string' || value.length > 256) return undefined;
  if (value === 'none') return value;
  if (/^env:[A-Z][A-Z0-9_]{0,127}$/.test(value)) return value;
  if (!value.includes('..') && /^secret:[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/.test(value)) {
    return value;
  }
  return undefined;
}

function parseText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

function parseProvider(value: unknown): string | undefined {
  const provider = parseText(value, 64)?.toLowerCase();
  return provider && /^[a-z][a-z0-9._-]*$/.test(provider) ? provider : undefined;
}

function parseBaseUrl(value: unknown, provider: string): string | undefined {
  const candidate =
    value === undefined && provider === 'deepseek' ? 'https://api.deepseek.com' : value;
  if (typeof candidate !== 'string' || candidate.length > 512) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    const hostname = url.hostname.toLowerCase();
    const blockedHost =
      hostname === 'localhost' ||
      hostname === 'metadata.google.internal' ||
      hostname === 'instance-data' ||
      hostname === '169.254.169.254' ||
      hostname === '100.100.100.200' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('169.254.') ||
      hostname.endsWith('.local');
    if (blockedHost) return undefined;
    if (url.protocol === 'http:' && process.env.ALLOW_INSECURE_MODEL_URLS !== 'true') {
      return undefined;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function parseCreateBody(body: unknown): CreateConnectionBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  const name = parseText(candidate.name, 120);
  const provider = parseProvider(candidate.provider);
  const modelIdentifier = parseText(candidate.modelIdentifier, 200);
  const secretRef = parseSecretRef(candidate.secretRef);
  const baseUrl = provider ? parseBaseUrl(candidate.baseUrl, provider) : undefined;
  const capabilities = parseCapabilities(candidate.capabilities);
  if (!name || !provider || !modelIdentifier || !secretRef || !baseUrl || !capabilities)
    return undefined;
  return { name, provider, modelIdentifier, secretRef, baseUrl, capabilities };
}

function parseUpdateBody(body: unknown): UpdateConnectionBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  const result: UpdateConnectionBody = {};
  if ('name' in candidate) {
    const name = parseText(candidate.name, 120);
    if (!name) return undefined;
    result.name = name;
  }
  if ('modelIdentifier' in candidate) {
    const modelIdentifier = parseText(candidate.modelIdentifier, 200);
    if (!modelIdentifier) return undefined;
    result.modelIdentifier = modelIdentifier;
  }
  if ('secretRef' in candidate) {
    const secretRef = parseSecretRef(candidate.secretRef);
    if (!secretRef) return undefined;
    result.secretRef = secretRef;
  }
  if ('baseUrl' in candidate) {
    const baseUrl = parseBaseUrl(candidate.baseUrl, 'self-hosted');
    if (!baseUrl) return undefined;
    result.baseUrl = baseUrl;
  }
  if ('capabilities' in candidate) {
    const capabilities = parseCapabilities(candidate.capabilities);
    if (!capabilities) return undefined;
    result.capabilities = capabilities;
  }
  if ('status' in candidate) {
    if (candidate.status !== 'active' && candidate.status !== 'disabled') return undefined;
    result.status = candidate.status;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toSummary(row: {
  id: string;
  name: string;
  provider: string;
  modelIdentifier: string;
  baseUrl: string;
  capabilities: Record<string, boolean>;
  status: ModelConnectionStatus;
  secretRef: string;
  lastTestStatus: 'unknown' | 'passed' | 'failed';
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ModelConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    modelIdentifier: row.modelIdentifier,
    baseUrl: row.baseUrl,
    capabilities: row.capabilities,
    status: row.status,
    secretConfigured: row.secretRef !== 'none',
    lastTestStatus: row.lastTestStatus,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
  return { database, user, access };
}

export async function registerModelRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.get(
    '/api/v1/workspaces/:workspaceId/model-connections',
    async (request: FastifyRequest<{ Params: WorkspaceParams }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;

      const rows = await context.database.db
        .select()
        .from(modelConnections)
        .where(eq(modelConnections.workspaceId, request.params.workspaceId))
        .orderBy(desc(modelConnections.createdAt));
      const response: ModelConnectionListResponse = { connections: rows.map(toSummary) };
      return reply.send(response);
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/model-connections',
    async (request: FastifyRequest<{ Params: WorkspaceParams; Body: unknown }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!canManageWorkspace(context.access.role)) return forbidden(reply);
      const body = parseCreateBody(request.body);
      if (!body) return invalidRequest(reply);

      try {
        const row = await context.database.db.transaction(async (tx) => {
          const [created] = await tx
            .insert(modelConnections)
            .values({
              workspaceId: request.params.workspaceId,
              name: body.name,
              provider: body.provider,
              modelIdentifier: body.modelIdentifier,
              secretRef: body.secretRef,
              baseUrl: body.baseUrl,
              capabilities: body.capabilities,
              createdBy: context.user.id,
            })
            .returning();
          if (!created) throw new Error('model connection insert returned no row');

          await tx.insert(auditRecords).values({
            workspaceId: request.params.workspaceId,
            actorUserId: context.user.id,
            action: 'model_connection.created',
            resourceType: 'model_connection',
            resourceId: created.id,
            metadata: {
              name: created.name,
              provider: created.provider,
              modelIdentifier: created.modelIdentifier,
              baseUrl: created.baseUrl,
              secretConfigured: created.secretRef !== 'none',
            },
          });
          return created;
        });
        return reply.code(201).send(toSummary(row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({
            error: { code: 'model_connection_name_taken', message: '模型连接名称已存在' },
          });
        }
        throw error;
      }
    },
  );

  app.patch(
    '/api/v1/workspaces/:workspaceId/model-connections/:connectionId',
    async (request: FastifyRequest<{ Params: ConnectionParams; Body: unknown }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!canManageWorkspace(context.access.role)) return forbidden(reply);
      if (!isUuid(request.params.connectionId)) return notFound(reply);
      const body = parseUpdateBody(request.body);
      if (!body) return invalidRequest(reply);

      const [existing] = await context.database.db
        .select()
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, request.params.connectionId),
            eq(modelConnections.workspaceId, request.params.workspaceId),
          ),
        )
        .limit(1);
      if (!existing) return notFound(reply);

      try {
        const row = await context.database.db.transaction(async (tx) => {
          const [updated] = await tx
            .update(modelConnections)
            .set({ ...body, updatedAt: new Date() })
            .where(eq(modelConnections.id, existing.id))
            .returning();
          if (!updated) return undefined;

          await tx.insert(auditRecords).values({
            workspaceId: request.params.workspaceId,
            actorUserId: context.user.id,
            action: 'model_connection.updated',
            resourceType: 'model_connection',
            resourceId: updated.id,
            metadata: {
              changedFields: Object.keys(body),
              status: updated.status,
              secretConfigured: updated.secretRef !== 'none',
            },
          });
          return updated;
        });
        if (!row) return notFound(reply);
        return reply.send(toSummary(row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          return reply.code(409).send({
            error: { code: 'model_connection_name_taken', message: '模型连接名称已存在' },
          });
        }
        throw error;
      }
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/model-connections/:connectionId/test',
    async (request: FastifyRequest<{ Params: ConnectionParams }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!canManageWorkspace(context.access.role)) return forbidden(reply);
      if (!isUuid(request.params.connectionId)) return notFound(reply);

      const [connection] = await context.database.db
        .select()
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, request.params.connectionId),
            eq(modelConnections.workspaceId, request.params.workspaceId),
          ),
        )
        .limit(1);
      if (!connection) return notFound(reply);
      if (connection.status !== 'active') {
        return reply.code(409).send({
          error: { code: 'connection_disabled', message: '已停用的模型连接不能测试' },
        });
      }

      const apiKey = await createEnvironmentSecretResolver().resolve(connection.secretRef);
      if (!apiKey) {
        return reply.code(400).send({
          error: { code: 'secret_unavailable', message: '模型连接引用的服务端密钥不可用' },
        });
      }

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
      const testedAt = new Date();
      try {
        const result = await client.complete({
          messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
          maxTokens: 8,
        });
        const [updated] = await context.database.db
          .update(modelConnections)
          .set({ lastTestedAt: testedAt, lastTestStatus: 'passed', lastTestError: null })
          .where(eq(modelConnections.id, connection.id))
          .returning();
        if (!updated) throw new Error('model connection test update returned no row');
        await context.database.db.insert(auditRecords).values({
          workspaceId: request.params.workspaceId,
          actorUserId: context.user.id,
          action: 'model_connection.tested',
          resourceType: 'model_connection',
          resourceId: connection.id,
          metadata: { status: 'passed', provider: connection.provider, model: result.model },
        });
        return reply.send({
          status: 'passed',
          provider: result.provider,
          model: result.model,
          finishReason: result.finishReason,
          usage: result.usage,
          testedAt: testedAt.toISOString(),
        });
      } catch (errorValue) {
        const modelError = errorValue instanceof ModelRequestError ? errorValue : undefined;
        const message = modelError?.message ?? '模型连接测试失败';
        const safeMessage = message.slice(0, 240);
        await context.database.db
          .update(modelConnections)
          .set({ lastTestedAt: testedAt, lastTestStatus: 'failed', lastTestError: safeMessage })
          .where(eq(modelConnections.id, connection.id));
        await context.database.db.insert(auditRecords).values({
          workspaceId: request.params.workspaceId,
          actorUserId: context.user.id,
          action: 'model_connection.tested',
          resourceType: 'model_connection',
          resourceId: connection.id,
          metadata: {
            status: 'failed',
            provider: connection.provider,
            retryable: modelError?.retryable ?? false,
          },
        });
        return reply.code(502).send({
          error: { code: 'model_connection_test_failed', message: safeMessage },
        });
      }
    },
  );
}
