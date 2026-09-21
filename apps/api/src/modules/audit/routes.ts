import type { AuditRecordListResponse, AuditRecordSummary } from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { auditRecords } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';
import { canManageWorkspace, getWorkspaceAccess } from '../workspaces/access.js';

interface Params {
  workspaceId: string;
}

interface Querystring {
  limit?: string;
  offset?: string;
}

function error(reply: FastifyReply, statusCode: number, code: string, message: string) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadata(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(secret|token|password|authorization|credential|api.?key)/i.test(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeMetadata(item, depth + 1);
    }
  }
  return result;
}

export async function registerAuditRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.get(
    '/api/v1/workspaces/:workspaceId/audit-records',
    async (request: FastifyRequest<{ Params: Params; Querystring: Querystring }>, reply) => {
      if (!isUuid(request.params.workspaceId)) {
        return error(reply, 404, 'workspace_not_found', '工作空间不存在');
      }
      if (!database) return error(reply, 503, 'database_unavailable', '服务暂时不可用');
      const user = await getAuthenticatedUser(request, database);
      if (!user) return error(reply, 401, 'unauthorized', '请先登录');

      const access = await getWorkspaceAccess(database, user.id, request.params.workspaceId);
      if (!access) return error(reply, 404, 'workspace_not_found', '工作空间不存在');
      if (!canManageWorkspace(access.role))
        return error(reply, 403, 'forbidden', '没有查看审计记录的权限');

      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0
      ) {
        return error(reply, 400, 'invalid_request', 'limit 必须为 1 到 100，offset 必须为非负整数');
      }

      const rows = await database.db
        .select()
        .from(auditRecords)
        .where(eq(auditRecords.workspaceId, request.params.workspaceId))
        .orderBy(desc(auditRecords.createdAt), desc(auditRecords.id))
        .limit(limit + 1)
        .offset(offset);
      const hasMore = rows.length > limit;
      const records: AuditRecordSummary[] = rows.slice(0, limit).map((row) => ({
        id: row.id,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        actorUserId: row.actorUserId,
        metadata: sanitizeMetadata(row.metadata) as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      }));
      const response: AuditRecordListResponse = {
        records,
        nextOffset: hasMore ? offset + limit : null,
      };
      return reply.send(response);
    },
  );
}
