import type { HealthResponse } from '@agent-workbench/contracts';
import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance) {
  const health = (): HealthResponse => ({
    status: 'ok',
    service: 'agent-workbench-api',
    apiVersion: 'v1',
  });

  app.get('/healthz', health);
  app.get('/api/v1/health', health);
}
