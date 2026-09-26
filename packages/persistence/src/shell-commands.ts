import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { ShellCommandResult, ShellCommandSummary } from '@agent-workbench/contracts';
import type { DatabaseHandle } from './client.js';
import {
  auditRecords,
  chatSessions,
  memberships,
  modelConnections,
  runs,
  shellCommandReviews,
  users,
  workspaces,
} from './schema.js';
import { appendEvents } from './runs.js';

function result(row: typeof shellCommandReviews.$inferSelect): ShellCommandResult | null {
  if (row.durationMs === null) return null;
  return {
    exitCode: row.exitCode,
    signal: row.processSignal,
    stdout: row.stdout ?? '',
    stderr: row.stderr ?? '',
    truncated: row.outputTruncated,
    durationMs: row.durationMs,
  };
}

function summary(row: typeof shellCommandReviews.$inferSelect): ShellCommandSummary {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    proposal: row.proposal,
    digest: row.digest,
    policyVersion: row.policyVersion as 'shell-review-v1',
    status:
      row.status === 'pending' && row.expiresAt.getTime() <= Date.now() ? 'expired' : row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    executionStatus: row.executionStatus,
    result: result(row),
    executionErrorCode: row.executionErrorCode,
    executionErrorMessage: row.executionErrorMessage,
  };
}

export type ClaimedShellCommand = typeof shellCommandReviews.$inferSelect & {
  workspaceId: string;
};

export type ShellCommandExecutionOutcome =
  | { status: 'succeeded'; result: ShellCommandResult }
  | { status: 'failed'; result: ShellCommandResult; code: string; message: string }
  | { status: 'unknown'; code: string; message: string };

/** The caller must authorize the owning Run before listing proposals. */
export async function listShellCommands(database: DatabaseHandle, runId: string) {
  const rows = await database.db
    .select()
    .from(shellCommandReviews)
    .where(eq(shellCommandReviews.runId, runId))
    .orderBy(asc(shellCommandReviews.createdAt), asc(shellCommandReviews.id));
  return rows.map(summary);
}

/** Approval authorizes one exact command and its persisted sandbox budget. */
export async function decideShellCommand(
  database: DatabaseHandle,
  input: {
    workspaceId: string;
    runId: string;
    commandId: string;
    userId: string;
    digest: string;
    decision: 'approve' | 'reject';
  },
): Promise<
  | { command: ShellCommandSummary }
  | { error: 'not_found' | 'forbidden' | 'conflict' | 'expired' | 'run_not_succeeded' }
> {
  return database.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ run: runs, role: memberships.role })
      .from(runs)
      .innerJoin(chatSessions, eq(chatSessions.id, runs.sessionId))
      .innerJoin(
        memberships,
        and(eq(memberships.workspaceId, runs.workspaceId), eq(memberships.userId, input.userId)),
      )
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.workspaceId, input.workspaceId),
          eq(chatSessions.workspaceId, input.workspaceId),
          eq(chatSessions.ownerUserId, input.userId),
          eq(users.status, 'active'),
          eq(workspaces.status, 'active'),
        ),
      )
      .for('update', { of: runs });
    if (!owned) return { error: 'not_found' };
    if (owned.role === 'viewer') return { error: 'forbidden' };
    const [row] = await tx
      .select()
      .from(shellCommandReviews)
      .where(
        and(
          eq(shellCommandReviews.id, input.commandId),
          eq(shellCommandReviews.runId, input.runId),
        ),
      )
      .for('update');
    if (!row) return { error: 'not_found' };
    if (row.digest !== input.digest || row.policyVersion !== 'shell-review-v1')
      return { error: 'conflict' };
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    if (row.status === status) return { command: summary(row) };
    if (row.status !== 'pending')
      return { error: row.status === 'expired' ? 'expired' : 'conflict' };
    const [clock] = await tx
      .select({ expired: sql<boolean>`clock_timestamp() >= ${row.expiresAt}` })
      .from(shellCommandReviews)
      .where(eq(shellCommandReviews.id, row.id));
    const expired = Boolean(clock?.expired);
    if (
      !expired &&
      status === 'approved' &&
      (owned.run.status !== 'succeeded' || owned.run.cancelRequestedAt)
    )
      return { error: 'run_not_succeeded' };
    const [updated] = await tx
      .update(shellCommandReviews)
      .set({
        status: expired ? 'expired' : status,
        decidedAt: expired ? null : sql`clock_timestamp()`,
        decidedBy: expired ? null : input.userId,
      })
      .where(eq(shellCommandReviews.id, row.id))
      .returning();
    if (!updated) throw new Error('shell command decision returned no row');
    const action = `shell_command.${updated.status}`;
    await tx.insert(auditRecords).values({
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      action,
      resourceType: 'shell_command',
      resourceId: row.id,
      metadata: {
        runId: row.runId,
        stepId: row.stepId,
        digest: row.digest,
        policyVersion: row.policyVersion,
      },
    });
    await appendEvents(tx, row.runId, [
      { type: action, stepId: row.stepId, payload: { proposalId: row.id } },
    ]);
    return expired ? { error: 'expired' } : { command: summary(updated) };
  });
}

/** Claim one approved command. The database row is the single-use execution lease. */
export async function claimApprovedShellCommand(
  database: DatabaseHandle,
  owner: string,
): Promise<ClaimedShellCommand | undefined> {
  return database.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ review: shellCommandReviews, workspaceId: runs.workspaceId })
      .from(shellCommandReviews)
      .innerJoin(runs, eq(runs.id, shellCommandReviews.runId))
      .innerJoin(modelConnections, eq(modelConnections.id, runs.modelConnectionId))
      .where(
        and(
          eq(shellCommandReviews.status, 'approved'),
          eq(shellCommandReviews.executionStatus, 'not_started'),
          eq(runs.status, 'succeeded'),
          isNull(runs.cancelRequestedAt),
          eq(modelConnections.status, 'active'),
          sql`${modelConnections.capabilities}->>'shell' = 'true'`,
          sql`${shellCommandReviews.expiresAt} > clock_timestamp()`,
        ),
      )
      .orderBy(asc(shellCommandReviews.createdAt), asc(shellCommandReviews.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return undefined;
    const [claimed] = await tx
      .update(shellCommandReviews)
      .set({
        executionStatus: 'executing',
        executionOwner: owner,
        executionStartedAt: sql`clock_timestamp()`,
        executionErrorCode: null,
        executionErrorMessage: null,
      })
      .where(
        and(
          eq(shellCommandReviews.id, candidate.review.id),
          eq(shellCommandReviews.executionStatus, 'not_started'),
        ),
      )
      .returning();
    return claimed ? { ...claimed, workspaceId: candidate.workspaceId } : undefined;
  });
}

/** Persist the observed result; an unknown outcome is terminal and never replayed. */
export async function finishShellCommandExecution(
  database: DatabaseHandle,
  input: { id: string; owner: string; outcome: ShellCommandExecutionOutcome },
) {
  return database.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ review: shellCommandReviews, workspaceId: runs.workspaceId })
      .from(shellCommandReviews)
      .innerJoin(runs, eq(runs.id, shellCommandReviews.runId))
      .where(
        and(
          eq(shellCommandReviews.id, input.id),
          eq(shellCommandReviews.executionStatus, 'executing'),
          eq(shellCommandReviews.executionOwner, input.owner),
        ),
      )
      .for('update');
    if (!owned) return undefined;
    const row = owned.review;
    const action = `shell_command.${input.outcome.status}`;
    const executionResult = input.outcome.status === 'unknown' ? undefined : input.outcome.result;
    const [updated] = await tx
      .update(shellCommandReviews)
      .set({
        executionStatus: input.outcome.status,
        executedAt: input.outcome.status === 'unknown' ? null : sql`clock_timestamp()`,
        executionOwner: null,
        executionStartedAt: null,
        exitCode: executionResult?.exitCode ?? null,
        processSignal: executionResult?.signal ?? null,
        stdout: executionResult?.stdout ?? null,
        stderr: executionResult?.stderr ?? null,
        outputTruncated: executionResult?.truncated ?? false,
        durationMs: executionResult?.durationMs ?? null,
        executionErrorCode: input.outcome.status === 'succeeded' ? null : input.outcome.code,
        executionErrorMessage: input.outcome.status === 'succeeded' ? null : input.outcome.message,
      })
      .where(eq(shellCommandReviews.id, row.id))
      .returning();
    if (!updated) throw new Error('shell command execution returned no row');
    await tx.insert(auditRecords).values({
      workspaceId: owned.workspaceId,
      actorUserId: row.decidedBy,
      action,
      resourceType: 'shell_command',
      resourceId: row.id,
      metadata: {
        runId: row.runId,
        stepId: row.stepId,
        digest: row.digest,
        policyVersion: row.policyVersion,
        ...(executionResult
          ? {
              exitCode: executionResult.exitCode,
              signal: executionResult.signal,
              truncated: executionResult.truncated,
              durationMs: executionResult.durationMs,
            }
          : {}),
        ...(input.outcome.status === 'succeeded' ? {} : { errorCode: input.outcome.code }),
      },
    });
    await appendEvents(tx, row.runId, [
      {
        type: action,
        stepId: row.stepId,
        payload: {
          proposalId: row.id,
          ...(executionResult
            ? {
                exitCode: executionResult.exitCode,
                signal: executionResult.signal,
                truncated: executionResult.truncated,
                durationMs: executionResult.durationMs,
              }
            : {}),
          ...(input.outcome.status === 'succeeded' ? {} : { code: input.outcome.code }),
        },
      },
    ]);
    return summary(updated);
  });
}

/** A crashed execution may have changed files, so recovery records unknown and never retries. */
export async function recoverStuckShellCommandExecutions(database: DatabaseHandle) {
  return database.db.transaction(async (tx) => {
    const rows = await tx
      .select({ review: shellCommandReviews, workspaceId: runs.workspaceId })
      .from(shellCommandReviews)
      .innerJoin(runs, eq(runs.id, shellCommandReviews.runId))
      .where(
        and(
          eq(shellCommandReviews.executionStatus, 'executing'),
          sql`${shellCommandReviews.executionStartedAt} < clock_timestamp() - interval '5 minutes'`,
        ),
      )
      .limit(100)
      .for('update', { skipLocked: true });
    for (const item of rows) {
      const row = item.review;
      await tx
        .update(shellCommandReviews)
        .set({
          executionStatus: 'unknown',
          executionOwner: null,
          executionStartedAt: null,
          executionErrorCode: 'runner_lost',
          executionErrorMessage: '执行器在命令结果确认前中断，未自动重试',
        })
        .where(eq(shellCommandReviews.id, row.id));
      await tx.insert(auditRecords).values({
        workspaceId: item.workspaceId,
        actorUserId: row.decidedBy,
        action: 'shell_command.unknown',
        resourceType: 'shell_command',
        resourceId: row.id,
        metadata: {
          runId: row.runId,
          stepId: row.stepId,
          digest: row.digest,
          errorCode: 'runner_lost',
        },
      });
      await appendEvents(tx, row.runId, [
        {
          type: 'shell_command.unknown',
          stepId: row.stepId,
          payload: { proposalId: row.id, code: 'runner_lost' },
        },
      ]);
    }
    const expired = await tx
      .select({ review: shellCommandReviews, workspaceId: runs.workspaceId })
      .from(shellCommandReviews)
      .innerJoin(runs, eq(runs.id, shellCommandReviews.runId))
      .where(
        and(
          eq(shellCommandReviews.status, 'approved'),
          eq(shellCommandReviews.executionStatus, 'not_started'),
          sql`${shellCommandReviews.expiresAt} <= clock_timestamp()`,
        ),
      )
      .limit(100)
      .for('update', { skipLocked: true });
    for (const item of expired) {
      const row = item.review;
      await tx
        .update(shellCommandReviews)
        .set({ status: 'expired' })
        .where(eq(shellCommandReviews.id, row.id));
      await tx.insert(auditRecords).values({
        workspaceId: item.workspaceId,
        actorUserId: row.decidedBy,
        action: 'shell_command.expired',
        resourceType: 'shell_command',
        resourceId: row.id,
        metadata: { runId: row.runId, stepId: row.stepId, digest: row.digest },
      });
      await appendEvents(tx, row.runId, [
        { type: 'shell_command.expired', stepId: row.stepId, payload: { proposalId: row.id } },
      ]);
    }
    return rows.length + expired.length;
  });
}
