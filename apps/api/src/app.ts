import Fastify, { type FastifyServerOptions } from 'fastify';
import type { DatabaseHandle } from './db/client.js';
import { registerHealthRoutes } from './modules/health/routes.js';

export interface AppDependencies {
  database: DatabaseHandle | undefined;
}

export function createApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = { database: undefined },
) {
  const app = Fastify(options);
  app.register(async (instance) => {
    await registerHealthRoutes(instance, dependencies.database);
  });
  return app;
}
