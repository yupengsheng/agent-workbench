import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4100);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const app = createApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
