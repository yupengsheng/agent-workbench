import type { FastifyInstance } from 'fastify';
import { decideFileChange } from '@agent-workbench/persistence/file-changes';
import type { DatabaseHandle } from '../../db/client.js';
import { getAuthenticatedUser } from '../identity/service.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerApprovalRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  app.post<{ Params: { workspaceId: string; runId: string; changeId: string }; Body: unknown }>(
    '/api/v1/workspaces/:workspaceId/runs/:runId/file-changes/:changeId/decision',
    async (request, reply) => {
      if (!database)
        return reply
          .code(503)
          .send({ error: { code: 'database_unavailable', message: '服务暂时不可用' } });
      const user = await getAuthenticatedUser(request, database);
      if (!user)
        return reply.code(401).send({ error: { code: 'unauthorized', message: '请先登录' } });
      if (!Object.values(request.params).every((id) => uuid.test(id)))
        return reply.code(404).send({ error: { code: 'not_found', message: '提案不存在' } });
      const body = request.body as Record<string, unknown> | null;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !['decision', 'digest'].includes(key)) ||
        !['approve', 'reject'].includes(String(body.decision)) ||
        typeof body.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.digest)
      )
        return reply.code(400).send({
          error: { code: 'invalid_request', message: '请提供审批决定和所审阅提案的摘要' },
        });
      const result = await decideFileChange(database, {
        ...request.params,
        userId: user.id,
        digest: body.digest,
        decision: body.decision as 'approve' | 'reject',
      });
      if ('change' in result) return reply.send(result.change);
      const errors = {
        not_found: [404, '提案不存在'],
        forbidden: [403, '当前角色没有审批权限'],
        conflict: [409, '提案或审批状态已变化，请刷新后查看'],
        expired: [409, '提案已过期，请生成新的提案'],
        run_not_succeeded: [409, '任务尚未成功完成，不能批准此提案'],
      } as const;
      const [status, message] = errors[result.error];
      return reply.code(status).send({ error: { code: result.error, message } });
    },
  );
}
