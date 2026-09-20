import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const migrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../database/migrations',
);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();
const pool = new Pool({ connectionString, application_name: 'agent-workbench-migrations' });
const client = await pool.connect();

try {
  await client.query("SELECT pg_advisory_lock(hashtext('agent-workbench:migrations'))");
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  for (const filename of migrationFiles) {
    const existing = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [filename],
    );
    if (existing.rowCount) {
      console.log(`skip ${filename}`);
      continue;
    }

    const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`apply ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock(hashtext('agent-workbench:migrations'))");
  client.release();
  await pool.end();
}
