import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  pool: Pool;
  db: AppDatabase;
}

export function createDatabase(
  connectionString = process.env.DATABASE_URL,
): DatabaseHandle | undefined {
  if (!connectionString) return undefined;

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 3000),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30000),
    application_name: 'agent-workbench-api',
  });

  return { pool, db: drizzle(pool, { schema }) };
}
