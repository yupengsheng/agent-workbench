import type {
  ModelConnectionListResponse,
  ModelConnectionStatus,
  ModelConnectionSummary,
} from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
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
  capabilities?: Record<string, boolean>;
}

interface UpdateConnectionBody {
  name?: string;
  modelIdentifier?: string;
  secretRef?: string;
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
  if (/^secret:[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/.test(value)) return value;
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

function parseCreateBody(body: unknown): CreateConnectionBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  const name = parseText(candidate.name, 120);
  const provider = parseProvider(candidate.provider);
  const modelIdentifier = parseText(candidate.modelIdentifier, 200);
  const secretRef = parseSecretRef(candidate.secretRef);
  const capabilities = parseCapabilities(candidate.capabilities);
  if (!name || !provider || !modelIdentifier || !secretRef || !capabilities) return undefined;
  return { name, provider, modelIdentifier, secretRef, capabilities };
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
  capabilities: Record<string, boolean>;
  status: ModelConnectionStatus;
  secretRef: string;
  createdAt: Date;
  updatedAt: Date;
}): ModelConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    modelIdentifier: row.modelIdentifier,
    capabilities: row.capabilities,
    status: row.status,
    secretConfigured: row.secretRef !== 'none',
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
}
