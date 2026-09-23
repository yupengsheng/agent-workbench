import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '@agent-workbench/persistence/client';
import { recoverStuckFileChangeApplications } from '@agent-workbench/persistence/file-changes';
import { applyApprovedFileChange, runOnce } from './worker.js';

const database = createDatabase();
if (!database) {
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL is required');
  console.log('Runner idle: configure DATABASE_URL to execute queued runs');
  // Keep the optional, database-free development stack alive.
  const idle = setInterval(() => {}, 60_000);
  const stop = () => {
    clearInterval(idle);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} else {
  const owner = randomUUID();
  const shutdown = new AbortController();
  process.once('SIGTERM', () => shutdown.abort());
  process.once('SIGINT', () => shutdown.abort());
  await database.pool.query('SELECT 1');
  console.log(`Runner started: ${owner}`);
  try {
    while (!shutdown.signal.aborted) {
      try {
        await recoverStuckFileChangeApplications(database);
        if (await applyApprovedFileChange(database, owner, undefined, shutdown.signal)) continue;
        if (await runOnce(database, owner, shutdown.signal)) continue;
      } catch {
        console.error('Runner cycle failed; retrying database coordination');
      }
      try {
        await delay(1000, undefined, { signal: shutdown.signal });
      } catch {
        break;
      }
    }
  } finally {
    await database.pool.end();
  }
}
