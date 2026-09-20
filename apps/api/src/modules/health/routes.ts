import type { HealthResponse } from '@agent-workbench/contracts';
import type { FastifyInstance } from 'fastify';
import type { DatabaseHandle } from '../../db/client.js';
import { getReadiness } from './ready.js';

export async function registerHealthRoutes(
  app: FastifyInstance,
  database: DatabaseHandle | undefined,
) {
  const health = (): HealthResponse => ({
    status: 'ok',
    service: 'agent-workbench-api',
    apiVersion: 'v1',
  });

  app.get('/healthz', health);
  app.get('/api/v1/health', health);
  app.get('/readyz', async (_request, reply) => {
    const readiness = await getReadiness(database);
    return reply.code(readiness.status === 'ok' ? 200 : 503).send(readiness);
  });
  app.get('/api/v1/ready', async (_request, reply) => {
    const readiness = await getReadiness(database);
    return reply.code(readiness.status === 'ok' ? 200 : 503).send(readiness);
  });
}
