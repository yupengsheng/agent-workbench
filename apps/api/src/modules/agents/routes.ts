import type {
  AgentDetailResponse,
  AgentListResponse,
  AgentStatus,
  AgentSummary,
  AgentVersionStatus,
  AgentVersionSummary,
} from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, max } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { agents, agentVersions, auditRecords, modelConnections } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';
import { canManageWorkspace, getWorkspaceAccess } from '../workspaces/access.js';

interface WorkspaceParams {
  workspaceId: string;
}

interface AgentParams extends WorkspaceParams {
  agentId: string;
}

interface VersionParams extends AgentParams {
  versionId: string;
}

interface CreateAgentBody {
  slug: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
}

const sensitiveKey = /(secret|token|password|authorization|credential|api.?key)/i;

function error(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseText(value: unknown, maxLength: number, required = true): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!required && text.length === 0) return '';
  return text.length > 0 && text.length <= maxLength ? text : undefined;
}

function validateConfigValue(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null) return depth <= 8;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((item) => validateConfigValue(item, depth + 1));
  }
  if (typeof value !== 'object') return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 128 &&
    entries.every(([key, item]) => !sensitiveKey.test(key) && validateConfigValue(item, depth + 1))
  );
}

function parseConfig(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (!validateConfigValue(value)) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > 64 * 1024) return undefined;
  } catch {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseCreateBody(body: unknown): CreateAgentBody | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const candidate = body as Record<string, unknown>;
  const slug = parseText(candidate.slug, 64)?.toLowerCase();
  const name = parseText(candidate.name, 120);
  const description = parseText(candidate.description ?? '', 1000, false);
  const config = parseConfig(candidate.config ?? {});
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) return undefined;
  if (!name || description === undefined || !config) return undefined;
  return { slug, name, description, config };
}

function isUniqueViolation(errorValue: unknown): boolean {
  return (
    typeof errorValue === 'object' &&
    errorValue !== null &&
    'code' in errorValue &&
    errorValue.code === '23505'
  );
}

function toAgentSummary(row: {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: AgentStatus;
  currentVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toVersionSummary(row: {
  id: string;
  agentId: string;
  version: number;
  status: AgentVersionStatus;
  config: Record<string, unknown>;
  publishedAt: Date | null;
  createdAt: Date;
}): AgentVersionSummary {
  return {
    id: row.id,
    agentId: row.agentId,
    version: row.version,
    status: row.status,
    config: row.config,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function authenticateWorkspace(
  request: FastifyRequest,
  reply: FastifyReply,
  database: DatabaseHandle | undefined,
  workspaceId: string,
) {
  if (!isUuid(workspaceId)) {
    error(reply, 404, 'workspace_not_found', '工作空间不存在');
    return undefined;
  }
  if (!database) {
    error(reply, 503, 'database_unavailable', '服务暂时不可用');
    return undefined;
  }
  const user = await getAuthenticatedUser(request, database);
  if (!user) {
    error(reply, 401, 'unauthorized', '请先登录');
    return undefined;
  }
  const access = await getWorkspaceAccess(database, user.id, workspaceId);
  if (!access) {
    error(reply, 404, 'workspace_not_found', '工作空间不存在');
    return undefined;
  }
  return { database, user, access };
}

async function findAgent(database: DatabaseHandle, workspaceId: string, agentId: string) {
  if (!isUuid(agentId)) return undefined;
  const [row] = await database.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)))
    .limit(1);
  return row;
}

async function ensureModelReference(
  database: DatabaseHandle,
  workspaceId: string,
  config: Record<string, unknown>,
): Promise<boolean> {
  const modelConnectionId = config.modelConnectionId;
  if (modelConnectionId === undefined) return true;
  if (typeof modelConnectionId !== 'string' || !isUuid(modelConnectionId)) return false;
  const [connection] = await database.db
    .select({ id: modelConnections.id })
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.id, modelConnectionId),
        eq(modelConnections.workspaceId, workspaceId),
        eq(modelConnections.status, 'active'),
      ),
    )
    .limit(1);
  return Boolean(connection);
}

export async function registerAgentRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.get(
    '/api/v1/workspaces/:workspaceId/agents',
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
        .from(agents)
        .where(eq(agents.workspaceId, request.params.workspaceId))
        .orderBy(asc(agents.name));
      const response: AgentListResponse = { agents: rows.map(toAgentSummary) };
      return reply.send(response);
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/agents',
    async (request: FastifyRequest<{ Params: WorkspaceParams; Body: unknown }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!canManageWorkspace(context.access.role)) {
        return error(reply, 403, 'forbidden', '没有执行该操作的工作空间权限');
      }
      const body = parseCreateBody(request.body);
      if (!body) {
        return error(reply, 400, 'invalid_request', 'Agent 字段格式不正确或配置包含敏感字段');
      }
      if (
        !(await ensureModelReference(context.database, request.params.workspaceId, body.config))
      ) {
        return error(reply, 400, 'invalid_model_connection', 'Agent 引用的模型连接不存在或已停用');
      }

      try {
        const result = await context.database.db.transaction(async (tx) => {
          const [agent] = await tx
            .insert(agents)
            .values({
              workspaceId: request.params.workspaceId,
              slug: body.slug,
              name: body.name,
              description: body.description,
              createdBy: context.user.id,
            })
            .returning();
          if (!agent) throw new Error('agent insert returned no row');
          const [version] = await tx
            .insert(agentVersions)
            .values({
              agentId: agent.id,
              version: 1,
              config: body.config,
              createdBy: context.user.id,
            })
            .returning();
          if (!version) throw new Error('agent version insert returned no row');
          await tx.insert(auditRecords).values({
            workspaceId: request.params.workspaceId,
            actorUserId: context.user.id,
            action: 'agent.created',
            resourceType: 'agent',
            resourceId: agent.id,
            metadata: { slug: agent.slug, version: version.version },
          });
          return { agent, version };
        });
        const response: AgentDetailResponse = {
          agent: toAgentSummary(result.agent),
          versions: [toVersionSummary(result.version)],
        };
        return reply.code(201).send(response);
      } catch (errorValue) {
        if (isUniqueViolation(errorValue)) {
          return error(reply, 409, 'agent_slug_taken', 'Agent slug 已存在');
        }
        throw errorValue;
      }
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/agents/:agentId',
    async (request: FastifyRequest<{ Params: AgentParams }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      const agent = await findAgent(
        context.database,
        request.params.workspaceId,
        request.params.agentId,
      );
      if (!agent) return error(reply, 404, 'agent_not_found', 'Agent 不存在');
      const versions = await context.database.db
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agent.id))
        .orderBy(desc(agentVersions.version));
      const response: AgentDetailResponse = {
        agent: toAgentSummary(agent),
        versions: versions.map(toVersionSummary),
      };
      return reply.send(response);
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/agents/:agentId/versions',
    async (request: FastifyRequest<{ Params: AgentParams; Body: unknown }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!canManageWorkspace(context.access.role)) {
        return error(reply, 403, 'forbidden', '没有执行该操作的工作空间权限');
      }
      const agent = await findAgent(
        context.database,
        request.params.workspaceId,
        request.params.agentId,
      );
      if (!agent) return error(reply, 404, 'agent_not_found', 'Agent 不存在');
      const body =
        typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
          ? parseConfig((request.body as Record<string, unknown>).config)
          : undefined;
      if (!body)
        return error(reply, 400, 'invalid_request', '版本 config 格式不正确或包含敏感字段');
      if (!(await ensureModelReference(context.database, request.params.workspaceId, body))) {
        return error(reply, 400, 'invalid_model_connection', 'Agent 引用的模型连接不存在或已停用');
      }

      const result = await context.database.db.transaction(async (tx) => {
        const [latest] = await tx
          .select({ version: max(agentVersions.version) })
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agent.id));
        const [version] = await tx
          .insert(agentVersions)
          .values({
            agentId: agent.id,
            version: (latest?.version ?? 0) + 1,
            config: body,
            createdBy: context.user.id,
          })
          .returning();
        if (!version) throw new Error('agent version insert returned no row');
        await tx.insert(auditRecords).values({
          workspaceId: request.params.workspaceId,
          actorUserId: context.user.id,
          action: 'agent_version.created',
          resourceType: 'agent_version',
          resourceId: version.id,
          metadata: { agentId: agent.id, version: version.version },
        });
        return version;
      });
      return reply.code(201).send(toVersionSummary(result));
    },
  );

  app.post(
    '/api/v1/workspaces/:workspaceId/agents/:agentId/versions/:versionId/publish',
    async (request: FastifyRequest<{ Params: VersionParams }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!canManageWorkspace(context.access.role)) {
        return error(reply, 403, 'forbidden', '没有执行该操作的工作空间权限');
      }
      if (!isUuid(request.params.agentId) || !isUuid(request.params.versionId)) {
        return error(reply, 404, 'version_not_found', 'Agent 版本不存在');
      }
      const agent = await findAgent(
        context.database,
        request.params.workspaceId,
        request.params.agentId,
      );
      if (!agent) return error(reply, 404, 'agent_not_found', 'Agent 不存在');

      const [candidate] = await context.database.db
        .select()
        .from(agentVersions)
        .where(
          and(eq(agentVersions.id, request.params.versionId), eq(agentVersions.agentId, agent.id)),
        )
        .limit(1);
      if (!candidate) return error(reply, 404, 'version_not_found', 'Agent 版本不存在');
      if (candidate.status === 'archived') {
        return error(reply, 409, 'version_archived', '已归档版本不能发布');
      }
      if (candidate.status === 'published' && agent.currentVersionId === candidate.id) {
        return reply.send(toVersionSummary(candidate));
      }

      const result = await context.database.db.transaction(async (tx) => {
        await tx
          .update(agentVersions)
          .set({ status: 'archived' })
          .where(and(eq(agentVersions.agentId, agent.id), eq(agentVersions.status, 'published')));
        const [published] = await tx
          .update(agentVersions)
          .set({ status: 'published', publishedAt: new Date() })
          .where(eq(agentVersions.id, candidate.id))
          .returning();
        if (!published) throw new Error('agent version publish returned no row');
        const [updatedAgent] = await tx
          .update(agents)
          .set({ currentVersionId: published.id, updatedAt: new Date() })
          .where(eq(agents.id, agent.id))
          .returning();
        if (!updatedAgent) throw new Error('agent current version update returned no row');
        await tx.insert(auditRecords).values({
          workspaceId: request.params.workspaceId,
          actorUserId: context.user.id,
          action: 'agent_version.published',
          resourceType: 'agent_version',
          resourceId: published.id,
          metadata: { agentId: agent.id, version: published.version },
        });
        return published;
      });
      return reply.send(toVersionSummary(result));
    },
  );
}
