import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createDatabase } from '../../apps/api/dist/db/client.js';
import { createApp } from '../../apps/api/dist/app.js';
import { createSession } from '../../apps/api/dist/modules/identity/service.js';
import { executeApprovedShellCommand } from '../../apps/runner/dist/worker.js';
import { finishToolStep, startToolStep } from '@agent-workbench/persistence/runs';
import { recoverStuckShellCommandExecutions } from '@agent-workbench/persistence/shell-commands';

const connectionString = process.env.TEST_DATABASE_URL;

function proposal(command = 'npm test') {
  return {
    kind: 'shell_command_proposal',
    version: 1,
    command,
    reason: '运行项目测试',
    approvalRequired: true,
    approvalScope: 'single_command_exact_text',
    sandbox: {
      network: 'disabled',
      workspaceAccess: 'read_write',
      timeoutMs: 30_000,
      cpuSeconds: 20,
      memoryBytes: 512 * 1024 * 1024,
      maxProcesses: 64,
      maxOutputBytes: 64 * 1024,
    },
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
  'shell command review binds approval, executes once, and preserves unknown outcomes',
  { skip: !connectionString && 'Set TEST_DATABASE_URL to a disposable PostgreSQL database' },
  async () => {
    const schemaName = `shell_review_test_${randomBytes(8).toString('hex')}`;
    const admin = createDatabase(connectionString);
    let database;
    let app;
    let workspaceRoot;
    try {
      await admin.pool.query(`CREATE SCHEMA "${schemaName}"`);
      const scopedUrl = new URL(connectionString);
      scopedUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
      database = createDatabase(scopedUrl.toString());
      await applyMigrations(database);

      const userId = randomUUID();
      const workspaceId = randomUUID();
      const modelId = randomUUID();
      const sessionId = randomUUID();
      const runId = randomUUID();
      const leaseToken = randomUUID();
      workspaceRoot = await mkdtemp('/tmp/agent-workbench-shell-review-');
      await mkdir(join(workspaceRoot, workspaceId), { recursive: true });
      await database.pool.query(
        "INSERT INTO users (id,email,email_normalized,display_name,password_hash) VALUES ($1,'owner@example.test','owner@example.test','owner','unused')",
        [userId],
      );
      await database.pool.query(
        "INSERT INTO workspaces (id,slug,name) VALUES ($1,'shell-review','Shell review')",
        [workspaceId],
      );
      await database.pool.query(
        "INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'owner')",
        [workspaceId, userId],
      );
      await database.pool.query(
        "INSERT INTO model_connections (id,workspace_id,name,provider,model_identifier,secret_ref,capabilities,created_by) VALUES ($1,$2,'test','deepseek','deepseek-chat','none',$3,$4)",
        [modelId, workspaceId, { tools: true, shell: true }, userId],
      );
      await database.pool.query(
        'INSERT INTO chat_sessions (id,workspace_id,owner_user_id) VALUES ($1,$2,$3)',
        [sessionId, workspaceId, userId],
      );
      await database.pool.query(
        "INSERT INTO runs (id,workspace_id,session_id,trigger_user_id,model_connection_id,status,lease_token,lease_expires_at,deadline_at) VALUES ($1,$2,$3,$4,$5,'running',$6,now()+interval '1 hour',now()+interval '1 hour')",
        [runId, workspaceId, sessionId, userId, modelId, leaseToken],
      );
      const stepId = await startToolStep(database, runId, leaseToken, {
        toolName: 'propose_shell_command',
        toolCallId: 'call-shell-1',
        arguments: '{}',
      });
      assert.ok(stepId);
      const exactProposal = proposal('printf approved');
      assert.equal(
        await finishToolStep(database, runId, leaseToken, stepId, {
          status: 'succeeded',
          output: {
            toolName: 'propose_shell_command',
            toolCallId: 'call-shell-1',
            status: 'success',
            content: JSON.stringify(exactProposal),
            shellCommand: exactProposal,
          },
        }),
        true,
      );
      await database.pool.query(
        "UPDATE runs SET status='succeeded', completed_at=now() WHERE id=$1",
        [runId],
      );

      const cookie = `aw_session=${(await createSession(database, userId)).token}`;
      app = createApp({ logger: false }, { database });
      const request = (method, url, payload) =>
        app.inject({
          method,
          url,
          ...(payload ? { payload } : {}),
          headers: { cookie },
        });
      const runUrl = `/api/v1/workspaces/${workspaceId}/runs/${runId}`;
      const detail = await request('GET', runUrl);
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().shellCommands.length, 1);
      assert.deepEqual(detail.json().shellCommands[0].proposal, exactProposal);
      const command = detail.json().shellCommands[0];
      const decisionUrl = `${runUrl}/shell-commands/${command.id}/decision`;
      assert.equal(
        (
          await request('POST', decisionUrl, {
            decision: 'approve',
            digest: '0'.repeat(64),
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await request('POST', decisionUrl, {
            decision: 'approve',
            digest: command.digest,
          })
        ).json().status,
        'approved',
      );

      let executions = 0;
      const fixtureExecutor = async (_workspace, input, limits) => {
        executions += 1;
        assert.equal(input, exactProposal.command);
        assert.equal(limits.timeoutMs, exactProposal.sandbox.timeoutMs);
        return {
          status: 'success',
          exitCode: 0,
          signal: null,
          stdout: 'approved',
          stderr: '',
          truncated: false,
          durationMs: 12,
        };
      };
      assert.equal(
        await executeApprovedShellCommand(
          database,
          randomUUID(),
          workspaceRoot,
          undefined,
          fixtureExecutor,
        ),
        true,
      );
      assert.equal(
        await executeApprovedShellCommand(
          database,
          randomUUID(),
          workspaceRoot,
          undefined,
          fixtureExecutor,
        ),
        false,
      );
      assert.equal(executions, 1);
      const executed = (await request('GET', runUrl)).json().shellCommands[0];
      assert.equal(executed.executionStatus, 'succeeded');
      assert.equal(executed.result.stdout, 'approved');
      assert.equal(executed.result.exitCode, 0);

      const unknownId = randomUUID();
      const unknownStepId = randomUUID();
      const unknownProposal = proposal('printf maybe');
      const unknownDigest = createHash('sha256')
        .update(JSON.stringify(unknownProposal))
        .digest('hex');
      await database.pool.query(
        "INSERT INTO run_steps (id,run_id,sequence,kind,status,completed_at) VALUES ($1,$2,99,'tool','succeeded',now())",
        [unknownStepId, runId],
      );
      await database.pool.query(
        "INSERT INTO shell_command_reviews (id,run_id,step_id,proposal,digest,status,execution_status,execution_owner,execution_started_at,expires_at,decided_by) VALUES ($1,$2,$3,$4,$5,'approved','executing',$6,now()-interval '10 minutes',now()+interval '1 day',$7)",
        [unknownId, runId, unknownStepId, unknownProposal, unknownDigest, randomUUID(), userId],
      );
      assert.equal(await recoverStuckShellCommandExecutions(database), 1);
      const unknown = await database.pool.query(
        'SELECT execution_status,execution_error_code FROM shell_command_reviews WHERE id=$1',
        [unknownId],
      );
      assert.equal(unknown.rows[0].execution_status, 'unknown');
      assert.equal(unknown.rows[0].execution_error_code, 'runner_lost');

      const events = await database.pool.query(
        'SELECT type FROM run_events WHERE run_id=$1 ORDER BY sequence',
        [runId],
      );
      assert.deepEqual(
        events.rows.map((row) => row.type),
        [
          'step.started',
          'shell_command.proposed',
          'step.succeeded',
          'shell_command.approved',
          'shell_command.succeeded',
          'shell_command.unknown',
        ],
      );
      const audits = await database.pool.query(
        "SELECT action,metadata FROM audit_records WHERE resource_type='shell_command' ORDER BY created_at,id",
      );
      assert.deepEqual(
        audits.rows.map((row) => row.action),
        [
          'shell_command.proposed',
          'shell_command.approved',
          'shell_command.succeeded',
          'shell_command.unknown',
        ],
      );
      assert.equal(
        JSON.stringify(audits.rows.map((row) => row.metadata)).includes('printf'),
        false,
      );
    } finally {
      await app?.close();
      await database?.pool.end();
      if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
      await admin.pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.pool.end();
    }
  },
);
