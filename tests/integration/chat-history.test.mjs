import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { createDatabase } from '../../apps/api/dist/db/client.js';
import { createApp } from '../../apps/api/dist/app.js';
import { createSession } from '../../apps/api/dist/modules/identity/service.js';
import { encryptModelSecret } from '../../apps/api/dist/modules/models/secrets.js';

const connectionString = process.env.TEST_DATABASE_URL;

test(
  'chat history: migrations, ownership, success and failure persistence',
  {
    skip: !connectionString && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database',
  },
  async (t) => {
    const schemaName = `chat_test_${randomBytes(8).toString('hex')}`;
    const admin = createDatabase(connectionString);
    let database;
    let app;
    let modelCalls = 0;
    const oldKey = process.env.MODEL_SECRET_ENCRYPTION_KEY;
    process.env.MODEL_SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const secret = `fixture-key-${randomUUID()}`;
    const provider = createServer(async (req, res) => {
      modelCalls++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader('content-type', 'application/json');
      if (body.messages.at(-1).content === 'fail') {
        res.writeHead(401);
        res.end(JSON.stringify({ error: `upstream must not expose ${secret}` }));
      } else {
        res.end(
          JSON.stringify({
            model: 'fixture-model',
            choices: [
              { message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        );
      }
    });
    try {
      await admin.pool.query(`CREATE SCHEMA "${schemaName}"`);
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
      database = createDatabase(scopedUrl.toString());
      const migrations = new URL('../../database/migrations/', import.meta.url);
      for (const file of (await readdir(migrations))
        .filter((name) => /^\d+_.+\.sql$/.test(name))
        .sort()) {
        await database.pool.query(await readFile(new URL(file, migrations), 'utf8'));
      }
      const tables = (
        await database.pool.query(
          'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
          [schemaName],
        )
      ).rows.map((row) => row.table_name);
      assert(tables.includes('sessions') && tables.includes('chat_sessions'));

      const userId = randomUUID();
      const otherId = randomUUID();
      const workspaceId = randomUUID();
      const otherWorkspaceId = randomUUID();
      for (const id of [userId, otherId]) {
        await database.pool.query(
          "INSERT INTO users (id,email,email_normalized,display_name,password_hash) VALUES ($1,$2,$2,'fixture','unused')",
          [id, `${id}@example.test`],
        );
      }
      for (const id of [workspaceId, otherWorkspaceId]) {
        await database.pool.query(
          "INSERT INTO workspaces (id,slug,name) VALUES ($1,$2,'fixture')",
          [id, id],
        );
      }
      await database.pool.query(
        "INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($4,$2,'owner')",
        [workspaceId, userId, otherId, otherWorkspaceId],
      );
      const cookie = `aw_session=${(await createSession(database, userId)).token}`;
      const otherCookie = `aw_session=${(await createSession(database, otherId)).token}`;
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const modelId = randomUUID();
      const missingSecretId = randomUUID();
      for (const id of [modelId, missingSecretId]) {
        await database.pool.query(
          "INSERT INTO model_connections (id,workspace_id,name,provider,model_identifier,secret_ref,secret_ciphertext,base_url,created_by) VALUES ($1,$2,$7,'deepseek','fixture-model',$3,$4,$5,$6)",
          [
            id,
            workspaceId,
            id === modelId ? 'managed' : 'none',
            id === modelId ? encryptModelSecret(secret) : null,
            `http://127.0.0.1:${provider.address().port}`,
            userId,
            id,
          ],
        );
      }
      app = createApp({ logger: false }, { database });
      const base = `/api/v1/workspaces/${workspaceId}`;
      const request = (method, url, payload, auth = cookie) =>
        app.inject({
          method,
          url,
          ...(payload ? { payload } : {}),
          headers: auth ? { cookie: auth } : {},
        });
      const input = (content = 'hello') => ({
        modelConnectionId: modelId,
        messages: [{ role: 'user', content }],
      });
      let sessionId;

      await t.test('unauthenticated and invalid model requests create no runs', async () => {
        assert.equal((await request('POST', `${base}/chat`, input(), '')).statusCode, 401);
        assert.equal((await request('GET', `${base}/sessions`, undefined, '')).statusCode, 401);
        assert.equal(
          (await request('POST', `${base}/chat`, { ...input(), modelConnectionId: randomUUID() }))
            .statusCode,
          400,
        );
        assert.equal(
          (
            await request('POST', `${base}/chat`, {
              ...input(),
              modelConnectionId: missingSecretId,
            })
          ).statusCode,
          400,
        );
        const key = process.env.MODEL_SECRET_ENCRYPTION_KEY;
        delete process.env.MODEL_SECRET_ENCRYPTION_KEY;
        try {
          assert.equal((await request('POST', `${base}/chat`, input())).statusCode, 503);
        } finally {
          process.env.MODEL_SECRET_ENCRYPTION_KEY = key;
        }
        assert.equal(
          (await database.pool.query('SELECT count(*)::int AS count FROM runs')).rows[0].count,
          0,
        );
        assert.equal(modelCalls, 0);
      });

      await t.test('success persists response, usage and ordered terminal events', async () => {
        const response = await request('POST', `${base}/chat`, input());
        assert.equal(response.statusCode, 200);
        const result = response.json();
        sessionId = result.sessionId;
        const detail = (await request('GET', `${base}/sessions/${sessionId}`)).json();
        assert.equal(detail.runs[0].run.id, result.runId);
        assert.equal(detail.runs[0].run.status, 'succeeded');
        assert.deepEqual(detail.runs[0].run.output.message, result.message);
        assert.equal(detail.runs[0].steps[0].id, result.stepId);
        assert.equal(detail.runs[0].steps[0].usage.totalTokens, 5);
        assert.deepEqual(
          detail.runs[0].events.map((event) => event.sequence),
          [1, 2, 3, 4],
        );
        assert.deepEqual(
          detail.runs[0].events.map((event) => event.type),
          ['run.started', 'step.started', 'step.completed', 'run.succeeded'],
        );
        assert.equal((await request('GET', '/api/v1/auth/me')).statusCode, 200);
      });

      await t.test(
        'another member and workspace cannot read or append this conversation',
        async () => {
          assert.deepEqual(
            (await request('GET', `${base}/sessions`, undefined, otherCookie)).json().sessions,
            [],
          );
          assert.equal(
            (await request('GET', `${base}/sessions/${sessionId}`, undefined, otherCookie))
              .statusCode,
            404,
          );
          assert.equal(
            (await request('POST', `${base}/chat`, { ...input(), sessionId }, otherCookie))
              .statusCode,
            404,
          );
          assert.equal(
            (await request('GET', `/api/v1/workspaces/${otherWorkspaceId}/sessions/${sessionId}`))
              .statusCode,
            404,
          );
          assert.equal(modelCalls, 1);
        },
      );

      await t.test(
        'continuation survives API restart; upstream failure is terminal and redacted',
        async () => {
          await app.close();
          app = createApp({ logger: false }, { database });
          const restored = (await request('GET', `${base}/sessions/${sessionId}`)).json();
          const response = await request('POST', `${base}/chat`, {
            ...input('fail'),
            sessionId,
            messages: [
              ...restored.runs[0].run.input.messages,
              restored.runs[0].run.output.message,
              { role: 'user', content: 'fail' },
            ],
          });
          assert.equal(response.statusCode, 502);
          assert.equal(response.json().error.retryable, false);
          const detail = (await request('GET', `${base}/sessions/${sessionId}`)).json();
          assert.equal(detail.runs.length, 2);
          const failed = detail.runs.at(-1);
          assert.equal(failed.run.status, 'failed');
          assert.equal(failed.steps[0].status, 'failed');
          assert(failed.run.completedAt && failed.steps[0].completedAt);
          assert.equal(failed.run.input.messages.length, 3);
          assert.deepEqual(
            failed.events.map((event) => event.type),
            ['run.started', 'step.started', 'step.failed', 'run.failed'],
          );
          assert(!JSON.stringify(detail).includes(secret));
          assert(!response.body.includes(secret));
          assert.equal((await request('GET', `${base}/sessions`)).json().sessions.length, 1);
        },
      );
    } finally {
      if (oldKey === undefined) delete process.env.MODEL_SECRET_ENCRYPTION_KEY;
      else process.env.MODEL_SECRET_ENCRYPTION_KEY = oldKey;
      await app?.close();
      provider.closeAllConnections();
      if (provider.listening) await new Promise((resolve) => provider.close(resolve));
      await database?.pool.end();
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.pool.end();
    }
  },
);
