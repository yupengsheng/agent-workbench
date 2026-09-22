import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from './client.js';
import { chatSessions, runEvents, runs, runSteps } from './schema.js';

type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
type RunRow = typeof runs.$inferSelect;
type EventInput = { type: string; stepId?: string; payload?: Record<string, unknown> };
export type ClaimedRun = RunRow & { leaseToken: string; deadlineAt: Date };
export const LEASE_SECONDS = 30;
export const RUN_TIMEOUT_MS = 60_000;

async function appendEvents(tx: Transaction, runId: string, events: EventInput[]) {
  // Every caller holds the Run row lock, including cancellation and recovery.
  const [last] = await tx
    .select({ sequence: sql<number>`coalesce(max(${runEvents.sequence}), 0)::int` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  await tx.insert(runEvents).values(
    events.map((event, index) => ({
      runId,
      sequence: (last?.sequence ?? 0) + index + 1,
      ...event,
    })),
  );
}

export type RunOutcome =
  | { status: 'succeeded'; output: Record<string, unknown>; usage: Record<string, number> }
  | { status: 'failed'; code: string; message: string }
  | { status: 'cancelled' };

async function finalize(tx: Transaction, run: RunRow, outcome: RunOutcome) {
  const values = {
    status: outcome.status,
    output: outcome.status === 'succeeded' ? outcome.output : null,
    errorCode: outcome.status === 'failed' ? outcome.code : null,
    errorMessage: outcome.status === 'failed' ? outcome.message : null,
    completedAt: sql`now()`,
  };
  const steps = await tx
    .update(runSteps)
    .set({ ...values, usage: outcome.status === 'succeeded' ? outcome.usage : {} })
    .where(
      and(
        eq(runSteps.runId, run.id),
        or(eq(runSteps.status, 'queued'), eq(runSteps.status, 'running')),
      ),
    )
    .returning({ id: runSteps.id });
  await tx
    .update(runs)
    .set({ ...values, updatedAt: sql`now()`, leaseExpiresAt: null })
    .where(eq(runs.id, run.id));
  await tx
    .update(chatSessions)
    .set({ updatedAt: sql`now()` })
    .where(eq(chatSessions.id, run.sessionId));
  await appendEvents(tx, run.id, [
    ...steps.map((step) => ({
      type: outcome.status === 'succeeded' ? 'step.completed' : `step.${outcome.status}`,
      stepId: step.id,
      payload: { status: outcome.status },
    })),
    {
      type: `run.${outcome.status}`,
      payload: outcome.status === 'failed' ? { code: outcome.code } : {},
    },
  ]);
}

export async function startToolStep(
  database: DatabaseHandle,
  runId: string,
  token: string,
  input: Record<string, unknown>,
) {
  return database.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(validLease(runId, token)).for('update');
    if (!run) return undefined;
    const [last] = await tx
      .select({ sequence: sql<number>`coalesce(max(${runSteps.sequence}), 0)::int` })
      .from(runSteps)
      .where(eq(runSteps.runId, runId));
    const [step] = await tx
      .insert(runSteps)
      .values({
        runId,
        sequence: (last?.sequence ?? 0) + 1,
        kind: 'tool',
        status: 'running',
        input,
        startedAt: sql`now()`,
      })
      .returning({ id: runSteps.id });
    if (!step) return undefined;
    await appendEvents(tx, runId, [
      { type: 'step.started', stepId: step.id, payload: { kind: 'tool', ...input } },
    ]);
    return step.id;
  });
}

export async function finishToolStep(
  database: DatabaseHandle,
  runId: string,
  token: string,
  stepId: string,
  outcome:
    | { status: 'succeeded'; output: Record<string, unknown>; usage?: Record<string, number> }
    | { status: 'failed'; code: string; message: string }
    | { status: 'cancelled' },
) {
  return database.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(validLease(runId, token)).for('update');
    if (!run) return false;
    const values = {
      status: outcome.status,
      output: outcome.status === 'succeeded' ? outcome.output : null,
      usage: outcome.status === 'succeeded' ? (outcome.usage ?? {}) : {},
      errorCode: outcome.status === 'failed' ? outcome.code : null,
      errorMessage: outcome.status === 'failed' ? outcome.message : null,
      completedAt: sql`now()`,
    };
    const [step] = await tx
      .update(runSteps)
      .set(values)
      .where(
        and(eq(runSteps.id, stepId), eq(runSteps.runId, runId), eq(runSteps.status, 'running')),
      )
      .returning({ id: runSteps.id });
    if (!step) return false;
    await appendEvents(tx, runId, [
      {
        type: `step.${outcome.status}`,
        stepId,
        payload:
          outcome.status === 'failed'
            ? { status: outcome.status, code: outcome.code }
            : { status: outcome.status },
      },
    ]);
    return true;
  });
}

export async function claimRun(
  database: DatabaseHandle,
  owner: string,
): Promise<ClaimedRun | undefined> {
  return database.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(runs)
      .where(eq(runs.status, 'queued'))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return undefined;
    const [run] = await tx
      .update(runs)
      .set({
        status: 'running',
        leaseOwner: owner,
        leaseToken: randomUUID(),
        leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
        deadlineAt: sql`now() + ${RUN_TIMEOUT_MS} * interval '1 millisecond'`,
        startedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(runs.id, candidate.id))
      .returning();
    if (!run?.leaseToken || !run.deadlineAt) throw new Error('claim returned no lease');
    const steps = await tx
      .update(runSteps)
      .set({ status: 'running', startedAt: sql`now()` })
      .where(eq(runSteps.runId, run.id))
      .returning({ id: runSteps.id });
    await appendEvents(tx, run.id, [
      { type: 'run.started' },
      ...steps.map((step) => ({
        type: 'step.started',
        stepId: step.id,
        payload: { kind: 'model' },
      })),
    ]);
    return { ...run, leaseToken: run.leaseToken, deadlineAt: run.deadlineAt };
  });
}

function validLease(runId: string, token: string) {
  return and(
    eq(runs.id, runId),
    eq(runs.status, 'running'),
    eq(runs.leaseToken, token),
    sql`${runs.leaseExpiresAt} > clock_timestamp()`,
  );
}

export async function renewLease(database: DatabaseHandle, runId: string, token: string) {
  const [row] = await database.db
    .update(runs)
    .set({
      leaseExpiresAt: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
      updatedAt: sql`now()`,
    })
    .where(validLease(runId, token))
    .returning({ cancelRequestedAt: runs.cancelRequestedAt });
  return row;
}

export async function finishRun(
  database: DatabaseHandle,
  runId: string,
  token: string,
  outcome: RunOutcome,
) {
  return database.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(validLease(runId, token)).for('update');
    if (!run) return false;
    // Recheck against database wall time after acquiring the lock, which may have waited.
    const [fenced] = await tx
      .update(runs)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(validLease(runId, token))
      .returning({
        timedOut: sql<boolean>`${runs.deadlineAt} <= clock_timestamp()`,
      });
    if (!fenced) return false;
    if (fenced.timedOut && outcome.status === 'succeeded' && !run.cancelRequestedAt) {
      outcome = { status: 'failed', code: 'run_timeout', message: '本次执行超过 60 秒，请重试' };
    }
    // The local model request has settled before this call. A concurrent cancel wins over success.
    await finalize(
      tx,
      run,
      run.cancelRequestedAt && outcome.status === 'succeeded' ? { status: 'cancelled' } : outcome,
    );
    return true;
  });
}

export async function requestRunCancellation(database: DatabaseHandle, runId: string) {
  await database.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
    if (!run || (run.status !== 'queued' && run.status !== 'running') || run.cancelRequestedAt)
      return;
    await tx
      .update(runs)
      .set({ cancelRequestedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(runs.id, run.id));
    await appendEvents(tx, run.id, [{ type: 'run.cancel_requested' }]);
    if (run.status === 'queued') await finalize(tx, run, { status: 'cancelled' });
  });
}

export async function recoverExpiredRuns(database: DatabaseHandle) {
  return database.db.transaction(async (tx) => {
    const expired = await tx
      .select()
      .from(runs)
      .where(
        or(
          and(
            eq(runs.status, 'running'),
            or(isNull(runs.leaseExpiresAt), sql`${runs.leaseExpiresAt} <= now()`),
          ),
          and(eq(runs.status, 'queued'), sql`${runs.createdAt} < now() - interval '5 minutes'`),
        ),
      )
      .limit(100)
      .for('update', { skipLocked: true });
    for (const run of expired) {
      await finalize(tx, run, {
        status: 'failed',
        code: run.status === 'queued' ? 'queue_timeout' : 'runner_lease_expired',
        message:
          run.status === 'queued'
            ? '等待执行超时，请确认 Runner 已启动后重试'
            : '执行器已中断，请重新提交任务；本次调用未自动重试',
      });
    }
    return expired.length;
  });
}
