import Fastify, { type FastifyServerOptions } from 'fastify';
import { registerHealthRoutes } from './modules/health/routes.js';

export function createApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);
  app.register(registerHealthRoutes);
  return app;
}
