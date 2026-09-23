import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { createDatabase } from '../../apps/api/dist/db/client.js';
import { createApp } from '../../apps/api/dist/app.js';
import { createSession } from '../../apps/api/dist/modules/identity/service.js';
import { finishToolStep, startToolStep } from '@agent-workbench/persistence/runs';

const connectionString = process.env.TEST_DATABASE_URL;

function digest(preview) {
  return createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}

function preview(path, changed = true) {
  return {
    kind: 'file_change_proposal',
    version: 1,
    path,
    operation: 'update',
    changed,
    reason: '为审批行为测试生成的最小变更',
    before: { sha256: '1'.repeat(64), bytes: 3 },
    after: { sha256: changed ? '2'.repeat(64) : '1'.repeat(64), bytes: changed ? 4 : 3 },
    patch: changed ? '--- a/README.md\n+++ b/README.md\n@@\n-old\n+new\n' : '',
    approvalRequired: true,
    approvalScope: 'single_file_exact_content',
  };
}

async function applyMigrations(database) {
  const migrations = new URL('../../database/migrations/', import.meta.url);
  for (const file of (await readdir(migrations))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort()) {
    await database.pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
}

test(
  'file change review: persists proposals and enforces review boundaries',
  { skip: !connectionString && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database' },
  async () => {
    const schemaName = `review_test_${randomBytes(8).toString('hex')}`;
    const admin = createDatabase(connectionString);
    let database;
    let app;
    try {
      await admin.pool.query(`CREATE SCHEMA "${schemaName}"`);
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
      database = createDatabase(scopedUrl.toString());
      await applyMigrations(database);

      const ownerId = randomUUID();
      const viewerId = randomUUID();
      const otherWorkspaceId = randomUUID();
      const workspaceId = randomUUID();
      for (const [id, email] of [
        [ownerId, 'owner@example.test'],
        [viewerId, 'viewer@example.test'],
      ]) {
        await database.pool.query(
          'INSERT INTO users (id,email,email_normalized,display_name,password_hash) VALUES ($1,$2,$2,$3,$4)',
          [id, email, email.split('@')[0], 'unused'],
        );
      }
      await database.pool.query(
        "INSERT INTO workspaces (id,slug,name) VALUES ($1,'review-workspace','Review workspace'),($2,'other-workspace','Other workspace')",
        [workspaceId, otherWorkspaceId],
      );
      await database.pool.query(
        "INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'viewer'),($4,$2,'owner')",
        [workspaceId, ownerId, viewerId, otherWorkspaceId],
      );
      const ownerCookie = `aw_session=${(await createSession(database, ownerId)).token}`;
      const viewerCookie = `aw_session=${(await createSession(database, viewerId)).token}`;

      const sessionId = randomUUID();
      const runId = randomUUID();
      const leaseToken = randomUUID();
      await database.pool.query(
        'INSERT INTO chat_sessions (id,workspace_id,owner_user_id) VALUES ($1,$2,$3)',
        [sessionId, workspaceId, ownerId],
      );
      await database.pool.query(
        "INSERT INTO runs (id,workspace_id,session_id,trigger_user_id,status,lease_token,lease_expires_at,deadline_at) VALUES ($1,$2,$3,$4,'running',$5,now()+interval '1 hour',now()+interval '1 hour')",
        [runId, workspaceId, sessionId, ownerId, leaseToken],
      );
      const stepId = await startToolStep(database, runId, leaseToken, {
        toolName: 'propose_file_change',
        toolCallId: 'call-review-1',
        arguments: '{}',
      });
      assert.ok(stepId);
      const proposedPreview = preview('README.md');
      assert.equal(
        await finishToolStep(database, runId, leaseToken, stepId, {
          status: 'succeeded',
          output: {
            toolName: 'propose_file_change',
            toolCallId: 'call-review-1',
            status: 'success',
            content: JSON.stringify(proposedPreview),
          },
        }),
        true,
      );
      await database.pool.query(
        "UPDATE runs SET status='succeeded', completed_at=now() WHERE id=$1",
        [runId],
      );

      const viewerSessionId = randomUUID();
      const viewerRunId = randomUUID();
      const viewerStepId = randomUUID();
      await database.pool.query(
        'INSERT INTO chat_sessions (id,workspace_id,owner_user_id) VALUES ($1,$2,$3)',
        [viewerSessionId, workspaceId, viewerId],
      );
      await database.pool.query(
        "INSERT INTO runs (id,workspace_id,session_id,trigger_user_id,status,completed_at) VALUES ($1,$2,$3,$4,'succeeded',now())",
        [viewerRunId, workspaceId, viewerSessionId, viewerId],
      );
      await database.pool.query(
        "INSERT INTO run_steps (id,run_id,sequence,kind,status,completed_at) VALUES ($1,$2,1,'tool','succeeded',now())",
        [viewerStepId, viewerRunId],
      );
      const viewerPreview = preview('VIEWER.md');
      const viewerDigest = digest(viewerPreview);
      const viewerChangeId = randomUUID();
      await database.pool.query(
        "INSERT INTO file_change_reviews (id,run_id,step_id,preview,digest,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')",
        [viewerChangeId, viewerRunId, viewerStepId, viewerPreview, viewerDigest],
      );

      const expiredSessionId = randomUUID();
      const expiredRunId = randomUUID();
      const expiredStepId = randomUUID();
      const expiredChangeId = randomUUID();
      const expiredPreview = preview('EXPIRED.md');
      const expiredDigest = digest(expiredPreview);
      await database.pool.query(
        'INSERT INTO chat_sessions (id,workspace_id,owner_user_id) VALUES ($1,$2,$3)',
        [expiredSessionId, workspaceId, ownerId],
      );
      await database.pool.query(
        "INSERT INTO runs (id,workspace_id,session_id,trigger_user_id,status,completed_at) VALUES ($1,$2,$3,$4,'succeeded',now())",
        [expiredRunId, workspaceId, expiredSessionId, ownerId],
      );
      await database.pool.query(
        "INSERT INTO run_steps (id,run_id,sequence,kind,status,completed_at) VALUES ($1,$2,1,'tool','succeeded',now())",
        [expiredStepId, expiredRunId],
      );
      await database.pool.query(
        "INSERT INTO file_change_reviews (id,run_id,step_id,preview,digest,expires_at) VALUES ($1,$2,$3,$4,$5,now()-interval '1 minute')",
        [expiredChangeId, expiredRunId, expiredStepId, expiredPreview, expiredDigest],
      );

      app = createApp({ logger: false }, { database });
      const base = `/api/v1/workspaces/${workspaceId}/runs/${runId}/file-changes`;
      const request = (method, url, payload, cookie = ownerCookie) =>
        app.inject({
          method,
          url,
          ...(payload ? { payload } : {}),
          headers: cookie ? { cookie } : {},
        });

      const detail = await request('GET', `/api/v1/workspaces/${workspaceId}/runs/${runId}`);
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().fileChanges.length, 1);
      assert.deepEqual(detail.json().fileChanges[0].preview, proposedPreview);
      assert.equal(detail.json().fileChanges[0].status, 'pending');
      const changeId = detail.json().fileChanges[0].id;
      const correctDigest = detail.json().fileChanges[0].digest;

      assert.equal(
        (
          await request('POST', `${base}/${changeId}/decision`, {
            decision: 'approve',
            digest: '0'.repeat(64),
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await request('POST', `${base}/${changeId}/decision`, {
            decision: 'approve',
            digest: correctDigest,
          })
        ).json().status,
        'approved',
      );
      const repeated = await request('POST', `${base}/${changeId}/decision`, {
        decision: 'approve',
        digest: correctDigest,
      });
      assert.equal(repeated.statusCode, 200);
      assert.equal(repeated.json().applied, false);
      assert.equal(
        (
          await request('POST', `${base}/${changeId}/decision`, {
            decision: 'reject',
            digest: correctDigest,
          })
        ).statusCode,
        409,
      );

      const viewerResponse = await request(
        'POST',
        `/api/v1/workspaces/${workspaceId}/runs/${viewerRunId}/file-changes/${viewerChangeId}/decision`,
        { decision: 'reject', digest: viewerDigest },
        viewerCookie,
      );
      assert.equal(viewerResponse.statusCode, 403);
      assert.equal(
        (
          await request(
            'GET',
            `/api/v1/workspaces/${workspaceId}/runs/${runId}`,
            undefined,
            viewerCookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            'POST',
            `/api/v1/workspaces/${otherWorkspaceId}/runs/${runId}/file-changes/${changeId}/decision`,
            { decision: 'approve', digest: correctDigest },
          )
        ).statusCode,
        404,
      );

      const expiredResponse = await request(
        'POST',
        `/api/v1/workspaces/${workspaceId}/runs/${expiredRunId}/file-changes/${expiredChangeId}/decision`,
        { decision: 'approve', digest: expiredDigest },
      );
      assert.equal(expiredResponse.statusCode, 409);
      assert.equal(expiredResponse.json().error.code, 'expired');
      const expiredRow = await database.pool.query(
        'SELECT status FROM file_change_reviews WHERE id=$1',
        [expiredChangeId],
      );
      assert.equal(expiredRow.rows[0].status, 'expired');

      const events = await database.pool.query(
        'SELECT type FROM run_events WHERE run_id=$1 ORDER BY sequence',
        [runId],
      );
      assert.deepEqual(
        events.rows.map((row) => row.type),
        ['step.started', 'file_change.proposed', 'step.succeeded', 'file_change.approved'],
      );
      const audits = await database.pool.query(
        'SELECT action FROM audit_records WHERE resource_id=$1 ORDER BY created_at',
        [changeId],
      );
      assert.deepEqual(
        audits.rows.map((row) => row.action),
        ['file_change.proposed', 'file_change.approved'],
      );
    } finally {
      await app?.close();
      await database?.pool.end();
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.pool.end();
    }
  },
);
