import type { WorkspaceListResponse, WorkspaceSummary } from '@agent-workbench/contracts';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { asc, and, eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { auditRecords, memberships, workspaces } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';

interface CreateWorkspaceBody {
  name: string;
  slug?: string;
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

function parseCreateBody(body: unknown): CreateWorkspaceBody | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.name !== 'string') return undefined;
  const name = candidate.name.trim();
  if (name.length < 1 || name.length > 120) return undefined;
  if (candidate.slug !== undefined && typeof candidate.slug !== 'string') return undefined;
  const slug = typeof candidate.slug === 'string' ? candidate.slug.trim().toLowerCase() : undefined;
  if (slug !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    return undefined;
  }
  return { name, ...(slug ? { slug } : {}) };
}

function generatedSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `workspace-${randomUUID().slice(0, 8)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.get('/api/v1/workspaces', async (request, reply) => {
    if (!database) return unavailable(reply);
    const user = await getAuthenticatedUser(request, database);
    if (!user) return unauthorized(reply);

    const rows = await database.db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        role: memberships.role,
      })
      .from(memberships)
      .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
      .where(and(eq(memberships.userId, user.id), eq(workspaces.status, 'active')))
      .orderBy(asc(workspaces.name));
    const response: WorkspaceListResponse = { workspaces: rows };
    return reply.send(response);
  });

  app.post('/api/v1/workspaces', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    if (!database) return unavailable(reply);
    const user = await getAuthenticatedUser(request, database);
    if (!user) return unauthorized(reply);
    const body = parseCreateBody(request.body);
    if (!body) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'name 必须为 1 到 120 个字符，slug 只能包含小写字母、数字和连字符',
        },
      });
    }

    const slug = body.slug ?? generatedSlug(body.name);
    try {
      const workspace = await database.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(workspaces)
          .values({ name: body.name, slug })
          .returning({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name });
        if (!created) throw new Error('workspace insert returned no row');

        await tx.insert(memberships).values({
          workspaceId: created.id,
          userId: user.id,
          role: 'owner',
        });
        await tx.insert(auditRecords).values({
          workspaceId: created.id,
          actorUserId: user.id,
          action: 'workspace.created',
          resourceType: 'workspace',
          resourceId: created.id,
          metadata: { slug: created.slug },
        });
        return created;
      });

      const response: WorkspaceSummary = { ...workspace, role: 'owner' };
      return reply.code(201).send(response);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({
          error: { code: 'workspace_slug_taken', message: '工作空间 slug 已存在' },
        });
      }
      throw error;
    }
  });
}
