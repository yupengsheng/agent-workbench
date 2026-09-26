import { runOnce, executeRun } from '../../apps/runner/dist/worker.js';
import {
  claimRun,
  finishRun,
  recordModelRoute,
  recordModelRoutingAudit,
  renewLease,
  requestRunCancellation,
  recoverExpiredRuns,
} from '@agent-workbench/persistence/runs';
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
    let modelStarted;
    let heldResponse;
    const oldKey = process.env.MODEL_SECRET_ENCRYPTION_KEY;
    process.env.MODEL_SECRET_ENCRYPTION_KEY = randomBytes(32).toString('hex');
    const secret = `fixture-key-${randomUUID()}`;
    const auditInputMarker = `audit-input-${randomUUID()}`;
    const auditArgumentMarker = `audit-argument-${randomUUID()}`;
    const auditOutputMarker = `audit-output-${randomUUID()}`;
    const routePromptMarker = `route-prompt-${randomUUID()}`;
    const provider = createServer(async (req, res) => {
      modelCalls++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const lastMessage = body.messages.at(-1);
      res.setHeader('content-type', 'application/json');
      if (lastMessage.content === 'hold') {
        heldResponse = res;
        modelStarted?.();
        return;
      }
      if (lastMessage.content === 'fail') {
        res.writeHead(401);
        res.end(JSON.stringify({ error: `upstream must not expose ${secret}` }));
      } else if (
        body.messages.some((message) => message.content === auditInputMarker) &&
        lastMessage.role === 'user'
      ) {
        res.end(
          JSON.stringify({
            model: 'fixture-model',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'audit-tool-call',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: auditArgumentMarker }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      } else if (body.messages.some((message) => message.content === auditInputMarker)) {
        res.end(
          JSON.stringify({
            model: 'fixture-model',
            choices: [
              {
                message: { role: 'assistant', content: auditOutputMarker },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
          }),
        );
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
        assert.equal(response.statusCode, 202);
        assert.equal(modelCalls, 0);
        assert.equal(response.json().status, 'queued');
        await runOnce(database, randomUUID());
        const result = response.json();
        sessionId = result.sessionId;
        const detail = (await request('GET', `${base}/sessions/${sessionId}`)).json();
        assert.equal(detail.runs[0].run.id, result.runId);
        assert.equal(detail.runs[0].run.status, 'succeeded');
        assert.deepEqual(detail.runs[0].run.output.message, {
          role: 'assistant',
          content: 'fixture answer',
        });
        assert.equal(detail.runs[0].steps[0].id, result.stepId);
        assert.equal(detail.runs[0].steps[0].usage.totalTokens, 5);
        assert.deepEqual(
          detail.runs[0].events.map((event) => event.sequence),
          [1, 2, 3, 4, 5, 6],
        );
        assert.deepEqual(
          detail.runs[0].events.map((event) => event.type),
          [
            'run.created',
            'step.queued',
            'run.started',
            'step.started',
            'step.completed',
            'run.succeeded',
          ],
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
          assert.equal(response.statusCode, 202);
          await runOnce(database, randomUUID());
          const detail = (await request('GET', `${base}/sessions/${sessionId}`)).json();
          assert.equal(detail.runs.length, 2);
          const failed = detail.runs.at(-1);
          assert.equal(failed.run.status, 'failed');
          assert.equal(failed.steps[0].status, 'failed');
          assert(failed.run.completedAt && failed.steps[0].completedAt);
          assert.equal(failed.run.input.messages.length, 3);
          assert.deepEqual(
            failed.events.map((event) => event.type),
            [
              'run.created',
              'step.queued',
              'run.started',
              'step.started',
              'step.failed',
              'run.failed',
            ],
          );
          assert(!JSON.stringify(detail).includes(secret));
          assert(!response.body.includes(secret));
          const auditRows = (
            await database.pool.query(
              "SELECT action,metadata FROM audit_records WHERE metadata->>'runId'=$1 ORDER BY created_at,id",
              [response.json().runId],
            )
          ).rows;
          assert.deepEqual(
            auditRows.map((row) => row.action),
            ['model_call.started', 'model_call.failed'],
          );
          assert.equal(typeof auditRows[1].metadata.durationMs, 'number');
          assert(!JSON.stringify(auditRows).includes(secret));
          assert.equal((await request('GET', `${base}/sessions`)).json().sessions.length, 1);
        },
      );

      const submit = async (content = 'hello', session) => {
        const result = await request('POST', `${base}/chat`, {
          ...input(content),
          ...(session ? { sessionId: session } : {}),
        });
        assert.equal(result.statusCode, 202);
        return result.json();
      };
      const detail = async (runId) => (await request('GET', `${base}/runs/${runId}`)).json();

      await t.test('model and tool audit records retain only structured metadata', async () => {
        const accepted = await submit(auditInputMarker);
        await runOnce(database, randomUUID());
        assert.equal((await detail(accepted.runId)).run.status, 'succeeded');
        const auditRows = (
          await database.pool.query(
            "SELECT action,resource_type,metadata FROM audit_records WHERE metadata->>'runId'=$1 ORDER BY created_at,id",
            [accepted.runId],
          )
        ).rows;
        const actions = auditRows.map((row) => row.action);
        assert.equal(actions.filter((action) => action === 'model_call.started').length, 2);
        assert.equal(actions.filter((action) => action === 'model_call.completed').length, 2);
        assert.equal(actions.filter((action) => action === 'tool_call.started').length, 1);
        assert.equal(actions.filter((action) => action === 'tool_call.completed').length, 1);
        const serialized = JSON.stringify(auditRows);
        for (const forbidden of [
          auditInputMarker,
          auditArgumentMarker,
          auditOutputMarker,
          secret,
        ]) {
          assert(!serialized.includes(forbidden));
        }
        for (const row of auditRows.filter((item) => item.resource_type === 'tool_call')) {
          assert(!('arguments' in row.metadata));
          assert(!('content' in row.metadata));
        }
        for (const row of auditRows.filter((item) => item.action === 'model_call.completed')) {
          assert.equal(typeof row.metadata.durationMs, 'number');
        }
        const response = await request('GET', `${base}/audit-records?limit=100&offset=0`);
        assert.equal(response.statusCode, 200);
        assert(response.json().records.some((record) => record.metadata.runId === accepted.runId));
        const modelResponse = await request(
          'GET',
          `${base}/audit-records?limit=100&offset=0&scope=model`,
        );
        assert.equal(modelResponse.statusCode, 200);
        assert(
          modelResponse
            .json()
            .records.every((record) =>
              ['model_call', 'model_routing'].includes(record.resourceType),
            ),
        );
        assert.equal((await request('GET', `${base}/audit-records?scope=unknown`)).statusCode, 400);
        assert.equal(
          (await request('GET', `${base}/audit-records`, undefined, otherCookie)).statusCode,
          403,
        );
        assert.deepEqual(
          (
            await request(
              'GET',
              `/api/v1/workspaces/${otherWorkspaceId}/audit-records`,
              undefined,
              cookie,
            )
          ).json().records,
          [],
        );
      });

      await t.test('Jev route audit excludes unrecognized routing fields', async () => {
        const accepted = await submit('route audit');
        const claimed = await claimRun(database, randomUUID());
        assert.equal(
          await recordModelRoutingAudit(database, claimed.id, claimed.leaseToken, {
            phase: 'started',
            router: 'jev',
            routerModel: 'jev-latest',
            candidates: [{ id: modelId, provider: 'deepseek', model: 'fixture-model' }],
          }),
          true,
        );
        assert.equal(
          await recordModelRoute(database, claimed.id, claimed.leaseToken, modelId, {
            router: 'jev',
            routerModel: 'jev-latest',
            selectedCandidateId: modelId,
            confidence: 0.92,
            probabilities: { [modelId]: 0.92 },
            candidates: [{ id: modelId, provider: 'deepseek', model: 'fixture-model' }],
            durationMs: 37,
            prompt: routePromptMarker,
          }),
          true,
        );
        await finishRun(database, claimed.id, claimed.leaseToken, { status: 'cancelled' });
        const auditRows = (
          await database.pool.query(
            "SELECT action,metadata FROM audit_records WHERE resource_type='model_routing' AND metadata->>'runId'=$1 ORDER BY created_at,id",
            [accepted.runId],
          )
        ).rows;
        assert.deepEqual(
          auditRows.map((row) => row.action),
          ['model_routing.started', 'model_routing.completed'],
        );
        assert.equal(auditRows[1].metadata.router, 'jev');
        assert.equal(auditRows[1].metadata.durationMs, 37);
        assert(!JSON.stringify(auditRows).includes(routePromptMarker));
        const runDetail = await detail(accepted.runId);
        const routed = runDetail.events.find((event) => event.type === 'model.routed');
        assert(routed);
        assert(!JSON.stringify(routed).includes(routePromptMarker));

        const failedAccepted = await submit('route audit failure');
        const failedClaim = await claimRun(database, randomUUID());
        assert.equal(
          await recordModelRoutingAudit(database, failedClaim.id, failedClaim.leaseToken, {
            phase: 'started',
            router: 'jev',
            routerModel: 'jev-latest',
            candidates: [{ id: modelId, provider: 'deepseek', model: 'fixture-model' }],
          }),
          true,
        );
        assert.equal(
          await recordModelRoutingAudit(database, failedClaim.id, failedClaim.leaseToken, {
            phase: 'failed',
            router: 'jev',
            routerModel: 'jev-latest',
            candidates: [{ id: modelId, provider: 'deepseek', model: 'fixture-model' }],
            errorCode: 'router_unavailable',
            durationMs: 5000,
            prompt: routePromptMarker,
          }),
          true,
        );
        await finishRun(database, failedClaim.id, failedClaim.leaseToken, { status: 'cancelled' });
        const [failedAudit] = (
          await database.pool.query(
            "SELECT metadata FROM audit_records WHERE action='model_routing.failed' AND metadata->>'runId'=$1",
            [failedAccepted.runId],
          )
        ).rows;
        assert.equal(failedAudit.metadata.errorCode, 'router_unavailable');
        assert.equal(failedAudit.metadata.durationMs, 5000);
        assert(!JSON.stringify(failedAudit).includes(routePromptMarker));
      });

      await t.test(
        'session serializes concurrent submissions; competing workers claim once',
        async () => {
          const responses = await Promise.all(
            [1, 2].map(() => request('POST', `${base}/chat`, { ...input(), sessionId })),
          );
          assert.deepEqual(responses.map((r) => r.statusCode).sort(), [202, 409]);
          const accepted = responses.find((r) => r.statusCode === 202).json();
          const leases = await Promise.all([
            claimRun(database, randomUUID()),
            claimRun(database, randomUUID()),
          ]);
          assert.equal(leases.filter(Boolean).length, 1);
          const run = leases.find(Boolean);
          assert.equal(run.id, accepted.runId);
          const before = modelCalls;
          await executeRun(database, run, new AbortController().signal);
          assert.equal(modelCalls, before + 1);
          assert.equal((await detail(run.id)).run.status, 'succeeded');
          assert.equal(
            await finishRun(database, run.id, run.leaseToken, {
              status: 'failed',
              code: 'late',
              message: 'late',
            }),
            false,
          );
        },
      );

      await t.test('cancel before claim, repeat cancel, and ownership checks', async () => {
        const accepted = await submit();
        assert.equal(
          (await request('GET', `${base}/runs/${accepted.runId}`, undefined, otherCookie))
            .statusCode,
          404,
        );
        assert.equal(
          (await request('POST', `${base}/runs/${accepted.runId}/cancel`, {}, otherCookie))
            .statusCode,
          404,
        );
        const cancel = await request('POST', `${base}/runs/${accepted.runId}/cancel`, {});
        assert.equal(cancel.statusCode, 200);
        assert.equal(cancel.json().run.status, 'cancelled');
        const repeated = await request('POST', `${base}/runs/${accepted.runId}/cancel`, {});
        assert.equal(repeated.json().events.length, cancel.json().events.length);
        assert.equal(await claimRun(database, randomUUID()), undefined);
      });

      await t.test(
        'active cancellation aborts the local model request before terminal state',
        async () => {
          const accepted = await submit('hold');
          const started = new Promise((resolve) => {
            modelStarted = resolve;
          });
          const claimed = await claimRun(database, randomUUID());
          const execution = executeRun(database, claimed, new AbortController().signal, 50);
          await started;
          await requestRunCancellation(database, accepted.runId);
          const waiting = await detail(accepted.runId);
          assert(waiting.run.cancelRequestedAt);
          assert.equal(waiting.run.status, 'running');
          await execution;
          assert.equal((await detail(accepted.runId)).run.status, 'cancelled');
          heldResponse.destroy();
          modelStarted = undefined;
        },
      );

      await t.test(
        'expired lease fails without replay and rejects stale renewal and completion',
        async () => {
          const accepted = await submit();
          const claimed = await claimRun(database, randomUUID());
          await database.pool.query(
            "UPDATE runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
            [accepted.runId],
          );
          assert.equal(await renewLease(database, claimed.id, claimed.leaseToken), undefined);
          assert.equal(
            await finishRun(database, claimed.id, claimed.leaseToken, {
              status: 'succeeded',
              output: {},
              usage: {},
            }),
            false,
          );
          const before = modelCalls;
          await recoverExpiredRuns(database);
          assert.equal((await detail(claimed.id)).run.errorCode, 'runner_lease_expired');
          assert.equal(await runOnce(database, randomUUID()), false);
          assert.equal(modelCalls, before);
        },
      );

      await t.test(
        'changed configuration, timeout and shutdown cannot produce successful output',
        async () => {
          const accepted = await submit();
          await database.pool.query('UPDATE model_connections SET updated_at=now() WHERE id=$1', [
            modelId,
          ]);
          await runOnce(database, randomUUID());
          assert.equal((await detail(accepted.runId)).run.errorCode, 'model_configuration_changed');
          const timeout = await submit();
          const timedRun = await claimRun(database, randomUUID());
          await executeRun(
            database,
            { ...timedRun, deadlineAt: new Date(0) },
            new AbortController().signal,
          );
          assert.equal((await detail(timeout.runId)).run.errorCode, 'run_timeout');
          const stopped = await submit();
          const stoppedRun = await claimRun(database, randomUUID());
          const shutdown = new AbortController();
          shutdown.abort();
          await executeRun(database, stoppedRun, shutdown.signal);
          assert.equal((await detail(stopped.runId)).run.errorCode, 'runner_stopped');
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
