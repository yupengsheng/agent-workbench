import { requestRunCancellation } from '@agent-workbench/persistence/runs';
import type {
  RunDetailResponse,
  RunEventSummary,
  RunStepSummary,
  RunSummary,
  SessionDetailResponse,
  SessionListResponse,
  SessionSummary,
} from '@agent-workbench/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { chatSessions, runEvents, runs, runSteps } from '../../db/schema.js';
import { getAuthenticatedUser } from '../identity/service.js';
import { getWorkspaceAccess } from '../workspaces/access.js';

interface WorkspaceParams {
  workspaceId: string;
}

interface SessionParams extends WorkspaceParams {
  sessionId: string;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: { code: 'database_unavailable', message: '服务暂时不可用' },
  });
}

function unauthenticated(reply: FastifyReply) {
  return reply.code(401).send({
    error: { code: 'unauthorized', message: '请先登录' },
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
    unauthenticated(reply);
    return undefined;
  }
  const access = await getWorkspaceAccess(database, user.id, workspaceId);
  if (!access) {
    reply.code(404).send({ error: { code: 'workspace_not_found', message: '工作空间不存在' } });
    return undefined;
  }
  return { database, user };
}

function toSession(row: typeof chatSessions.$inferSelect): SessionSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRun(row: typeof runs.$inferSelect): RunSummary {
  return {
    id: row.id,
    sessionId: row.sessionId,
    modelConnectionId: row.modelConnectionId,
    status: row.status,
    cancelRequestedAt: row.cancelRequestedAt?.toISOString() ?? null,
    deadlineAt: row.deadlineAt?.toISOString() ?? null,
    input: row.input,
    output: row.output,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toStep(row: typeof runSteps.$inferSelect): RunStepSummary {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    kind: row.kind,
    status: row.status,
    input: row.input,
    output: row.output,
    usage: row.usage,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toEvent(row: typeof runEvents.$inferSelect): RunEventSummary {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    stepId: row.stepId,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

async function runDetail(
  database: DatabaseHandle,
  row: typeof runs.$inferSelect,
): Promise<RunDetailResponse> {
  const [steps, events] = await Promise.all([
    database.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, row.id))
      .orderBy(asc(runSteps.sequence)),
    database.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, row.id))
      .orderBy(asc(runEvents.sequence)),
  ]);
  return { run: toRun(row), steps: steps.map(toStep), events: events.map(toEvent) };
}

export async function registerRunRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  for (const method of ['GET', 'POST'] as const) {
    app.route<{ Params: WorkspaceParams & { runId: string } }>({
      method,
      url: `/api/v1/workspaces/:workspaceId/runs/:runId${method === 'POST' ? '/cancel' : ''}`,
      handler: async (request, reply) => {
        const context = await authenticateWorkspace(
          request,
          reply,
          database,
          request.params.workspaceId,
        );
        if (!context) return;
        const missing = () =>
          reply.code(404).send({ error: { code: 'run_not_found', message: '任务不存在' } });
        if (!isUuid(request.params.runId)) return missing();
        const [row] = await context.database.db
          .select({ run: runs })
          .from(runs)
          .innerJoin(chatSessions, eq(chatSessions.id, runs.sessionId))
          .where(
            and(
              eq(runs.id, request.params.runId),
              eq(runs.workspaceId, request.params.workspaceId),
              eq(chatSessions.workspaceId, request.params.workspaceId),
              eq(chatSessions.ownerUserId, context.user.id),
            ),
          )
          .limit(1);
        if (!row) return missing();
        if (method === 'POST') {
          await requestRunCancellation(context.database, row.run.id);
          const [updated] = await context.database.db
            .select()
            .from(runs)
            .where(eq(runs.id, row.run.id));
          if (!updated) return missing();
          return reply.send(await runDetail(context.database, updated));
        }
        return reply.send(await runDetail(context.database, row.run));
      },
    });
  }
  app.get(
    '/api/v1/workspaces/:workspaceId/sessions',
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
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.workspaceId, request.params.workspaceId),
            eq(chatSessions.ownerUserId, context.user.id),
            eq(chatSessions.status, 'active'),
          ),
        )
        .orderBy(desc(chatSessions.updatedAt))
        .limit(50);
      const response: SessionListResponse = { sessions: rows.map(toSession) };
      return reply.send(response);
    },
  );

  app.get(
    '/api/v1/workspaces/:workspaceId/sessions/:sessionId',
    async (request: FastifyRequest<{ Params: SessionParams }>, reply) => {
      const context = await authenticateWorkspace(
        request,
        reply,
        database,
        request.params.workspaceId,
      );
      if (!context) return;
      if (!isUuid(request.params.sessionId)) {
        return reply
          .code(404)
          .send({ error: { code: 'session_not_found', message: '对话不存在' } });
      }

      const [session] = await context.database.db
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.id, request.params.sessionId),
            eq(chatSessions.workspaceId, request.params.workspaceId),
            eq(chatSessions.ownerUserId, context.user.id),
          ),
        )
        .limit(1);
      if (!session) {
        return reply
          .code(404)
          .send({ error: { code: 'session_not_found', message: '对话不存在' } });
      }

      const runRows = await context.database.db
        .select()
        .from(runs)
        .where(eq(runs.sessionId, session.id))
        .orderBy(asc(runs.createdAt));
      const runDetails = await Promise.all(
        runRows.map(async (run) => {
          const [stepRows, eventRows] = await Promise.all([
            context.database.db
              .select()
              .from(runSteps)
              .where(eq(runSteps.runId, run.id))
              .orderBy(asc(runSteps.sequence)),
            context.database.db
              .select()
              .from(runEvents)
              .where(eq(runEvents.runId, run.id))
              .orderBy(asc(runEvents.sequence)),
          ]);
          return {
            run: toRun(run),
            steps: stepRows.map(toStep),
            events: eventRows.map(toEvent),
          };
        }),
      );

      const response: SessionDetailResponse = { session: toSession(session), runs: runDetails };
      return reply.send(response);
    },
  );
}
