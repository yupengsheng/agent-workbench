import Fastify, { type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import type { DatabaseHandle } from './db/client.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerIdentityRoutes } from './modules/identity/routes.js';
import { registerWorkspaceRoutes } from './modules/workspaces/routes.js';

export interface AppDependencies {
  database: DatabaseHandle | undefined;
}

export function createApp(
  options: FastifyServerOptions = {},
  dependencies: AppDependencies = { database: undefined },
) {
  const app = Fastify(options);
  app.register(cookie);
  app.register(async (instance) => {
    await registerHealthRoutes(instance, dependencies.database);
    await registerIdentityRoutes(instance, dependencies.database);
    await registerWorkspaceRoutes(instance, dependencies.database);
  });
  return app;
}
