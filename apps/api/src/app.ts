import Fastify, { type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import type { DatabaseHandle } from './db/client.js';
import { registerHealthRoutes } from './modules/health/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { registerAgentRoutes } from './modules/agents/routes.js';
import { registerIdentityRoutes } from './modules/identity/routes.js';
import { registerModelRoutes } from './modules/models/routes.js';
import { registerWorkspaceRoutes } from './modules/workspaces/routes.js';
import { registerChatRoutes } from './modules/chat/routes.js';

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
    await registerAuditRoutes(instance, dependencies.database);
    await registerAgentRoutes(instance, dependencies.database);
    await registerIdentityRoutes(instance, dependencies.database);
    await registerModelRoutes(instance, dependencies.database);
    await registerWorkspaceRoutes(instance, dependencies.database);
    await registerChatRoutes(instance, dependencies.database);
  });
  return app;
}
