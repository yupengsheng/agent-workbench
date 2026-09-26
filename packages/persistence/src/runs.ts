import { createHash, randomUUID } from 'node:crypto';
import {
  parseFileChangeProposal,
  parseFileChangePreview,
  parseShellCommandProposal,
} from '@agent-workbench/contracts';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { AppDatabase, DatabaseHandle } from './client.js';
import {
  auditRecords,
  chatSessions,
  fileChangeReviews,
  runEvents,
  runs,
  runSteps,
  shellCommandReviews,
} from './schema.js';

type Transaction = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
type RunRow = typeof runs.$inferSelect;
type EventInput = { type: string; stepId?: string; payload?: Record<string, unknown> };
type ModelCallAuditInput =
  | {
      phase: 'started';
      round: number;
      provider: string;
      model: string;
    }
  | {
      phase: 'completed';
      round: number;
      provider: string;
      model: string;
      finishReason: string | null;
      usage: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      };
    }
  | {
      phase: 'failed' | 'cancelled';
      round: number;
      provider: string;
      model: string;
      errorCode: string;
    };
export type ClaimedRun = RunRow & { leaseToken: string; deadlineAt: Date };
export const LEASE_SECONDS = 30;
export const RUN_TIMEOUT_MS = 60_000;

export async function appendEvents(tx: Transaction, runId: string, events: EventInput[]) {
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
    await tx.insert(auditRecords).values({
      workspaceId: run.workspaceId,
      actorUserId: run.triggerUserId,
      action: 'tool_call.started',
      resourceType: 'tool_call',
      resourceId: step.id,
      metadata: {
        runId,
        stepId: step.id,
        toolName: safeMetadataString(input.toolName),
        toolCallId: safeMetadataString(input.toolCallId),
      },
    });
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
    let fileChangeProposal: ReturnType<typeof parseFileChangeProposal>;
    let shellCommandProposal: ReturnType<typeof parseShellCommandProposal>;
    let persistedOutput = outcome.status === 'succeeded' ? outcome.output : null;
    if (
      outcome.status === 'succeeded' &&
      outcome.output.toolName === 'propose_file_change' &&
      outcome.output.status === 'success' &&
      typeof outcome.output.content === 'string'
    ) {
      let proposalInput: unknown = outcome.output.fileChange;
      if (proposalInput === undefined) {
        try {
          proposalInput = JSON.parse(outcome.output.content);
        } catch {
          proposalInput = undefined;
        }
      }
      fileChangeProposal = parseFileChangeProposal(proposalInput);
      if (!fileChangeProposal) throw new Error('invalid file change proposal');
      const { content: _content, ...preview } = fileChangeProposal;
      const sanitizedPreview = parseFileChangePreview(preview);
      if (!sanitizedPreview) throw new Error('invalid file change preview');
      persistedOutput = { ...outcome.output, fileChange: sanitizedPreview };
    }
    if (
      outcome.status === 'succeeded' &&
      outcome.output.toolName === 'propose_shell_command' &&
      outcome.output.status === 'success' &&
      typeof outcome.output.content === 'string'
    ) {
      let proposalInput: unknown = outcome.output.shellCommand;
      if (proposalInput === undefined) {
        try {
          proposalInput = JSON.parse(outcome.output.content);
        } catch {
          proposalInput = undefined;
        }
      }
      shellCommandProposal = parseShellCommandProposal(proposalInput);
      if (!shellCommandProposal) throw new Error('invalid shell command proposal');
      persistedOutput = { ...outcome.output, shellCommand: shellCommandProposal };
    }
    const values = {
      status: outcome.status,
      output: persistedOutput,
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
      .returning({ id: runSteps.id, input: runSteps.input });
    if (!step) return false;
    if (fileChangeProposal?.changed) {
      const { content: proposedContent, ...preview } = fileChangeProposal;
      const digest = createHash('sha256').update(JSON.stringify(preview)).digest('hex');
      const [proposal] = await tx
        .insert(fileChangeReviews)
        .values({
          runId,
          stepId,
          preview,
          proposedContent,
          digest,
          expiresAt: sql`now() + interval '24 hours'`,
        })
        .returning({ id: fileChangeReviews.id });
      if (!proposal) throw new Error('proposal insert returned no row');
      await tx.insert(auditRecords).values({
        workspaceId: run.workspaceId,
        actorUserId: run.triggerUserId,
        action: 'file_change.proposed',
        resourceType: 'file_change',
        resourceId: proposal.id,
        metadata: { runId, stepId, digest, policyVersion: 'file-review-v1' },
      });
      await appendEvents(tx, runId, [
        { type: 'file_change.proposed', stepId, payload: { proposalId: proposal.id, digest } },
      ]);
    }
    if (shellCommandProposal) {
      const digest = createHash('sha256')
        .update(JSON.stringify(shellCommandProposal))
        .digest('hex');
      const [proposal] = await tx
        .insert(shellCommandReviews)
        .values({
          runId,
          stepId,
          proposal: shellCommandProposal,
          digest,
          expiresAt: sql`now() + interval '24 hours'`,
        })
        .returning({ id: shellCommandReviews.id });
      if (!proposal) throw new Error('shell command proposal insert returned no row');
      await tx.insert(auditRecords).values({
        workspaceId: run.workspaceId,
        actorUserId: run.triggerUserId,
        action: 'shell_command.proposed',
        resourceType: 'shell_command',
        resourceId: proposal.id,
        metadata: { runId, stepId, digest, policyVersion: 'shell-review-v1' },
      });
      await appendEvents(tx, runId, [
        { type: 'shell_command.proposed', stepId, payload: { proposalId: proposal.id, digest } },
      ]);
    }
    const toolStatus =
      outcome.status === 'succeeded' ? safeMetadataString(outcome.output.status) : outcome.status;
    const errorCode =
      outcome.status === 'failed'
        ? outcome.code
        : outcome.status === 'succeeded'
          ? safeMetadataString(outcome.output.errorCode)
          : undefined;
    await tx.insert(auditRecords).values({
      workspaceId: run.workspaceId,
      actorUserId: run.triggerUserId,
      action: `tool_call.${outcome.status === 'succeeded' ? 'completed' : outcome.status}`,
      resourceType: 'tool_call',
      resourceId: step.id,
      metadata: {
        runId,
        stepId: step.id,
        toolName: safeMetadataString(step.input.toolName),
        toolCallId: safeMetadataString(step.input.toolCallId),
        stepStatus: outcome.status,
        ...(toolStatus ? { toolStatus } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(outcome.status === 'succeeded' && outcome.output.truncated === true
          ? { truncated: true }
          : {}),
      },
    });
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

function safeMetadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 256) : undefined;
}

function safeModelRoutePayload(payload: Record<string, unknown>) {
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates.flatMap((candidate) => {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
          return [];
        const item = candidate as Record<string, unknown>;
        const id = safeMetadataString(item.id);
        const provider = safeMetadataString(item.provider);
        const model = safeMetadataString(item.model);
        return id && provider && model ? [{ id, provider, model }] : [];
      })
    : [];
  const probabilities =
    typeof payload.probabilities === 'object' &&
    payload.probabilities !== null &&
    !Array.isArray(payload.probabilities)
      ? Object.fromEntries(
          Object.entries(payload.probabilities).flatMap(([key, value]) =>
            candidates.some((candidate) => candidate.id === key) &&
            typeof value === 'number' &&
            Number.isFinite(value)
              ? [[key.slice(0, 256), value]]
              : [],
          ),
        )
      : {};
  return {
    router: safeMetadataString(payload.router),
    routerModel: safeMetadataString(payload.routerModel),
    selectedCandidateId: safeMetadataString(payload.selectedCandidateId),
    confidence:
      typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
        ? payload.confidence
        : undefined,
    probabilities,
    candidates,
  };
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

/** Persist the selected model and Jev decision while holding the runner fence. */
export async function recordModelRoute(
  database: DatabaseHandle,
  runId: string,
  token: string,
  modelConnectionId: string,
  payload: Record<string, unknown>,
) {
  return database.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(validLease(runId, token)).for('update');
    if (!run) return false;
    await tx
      .update(runs)
      .set({ modelConnectionId, updatedAt: sql`now()` })
      .where(eq(runs.id, runId));
    const safePayload = safeModelRoutePayload(payload);
    await tx.insert(auditRecords).values({
      workspaceId: run.workspaceId,
      actorUserId: run.triggerUserId,
      action: 'model_routing.completed',
      resourceType: 'model_routing',
      resourceId: run.id,
      metadata: { runId, modelConnectionId, ...safePayload },
    });
    await appendEvents(tx, runId, [{ type: 'model.routed', payload: safePayload }]);
    return true;
  });
}

/** Record one model request lifecycle edge without retaining prompts or model output. */
export async function recordModelCallAudit(
  database: DatabaseHandle,
  runId: string,
  token: string,
  input: ModelCallAuditInput,
) {
  return database.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(validLease(runId, token)).for('update');
    if (!run) return false;
    const usage =
      input.phase === 'completed'
        ? Object.fromEntries(
            Object.entries(input.usage).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
            ),
          )
        : undefined;
    await tx.insert(auditRecords).values({
      workspaceId: run.workspaceId,
      actorUserId: run.triggerUserId,
      action: `model_call.${input.phase}`,
      resourceType: 'model_call',
      resourceId: run.id,
      metadata: {
        runId,
        round: input.round,
        provider: safeMetadataString(input.provider),
        model: safeMetadataString(input.model),
        ...(input.phase === 'completed'
          ? { finishReason: safeMetadataString(input.finishReason), usage }
          : {}),
        ...(input.phase === 'failed' || input.phase === 'cancelled'
          ? { errorCode: safeMetadataString(input.errorCode) }
          : {}),
      },
    });
    return true;
  });
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
