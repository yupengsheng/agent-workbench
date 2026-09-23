import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FileChangeSummary } from '@agent-workbench/contracts';
import type { DatabaseHandle } from './client.js';
import {
  auditRecords,
  chatSessions,
  fileChangeReviews,
  memberships,
  runs,
  users,
  workspaces,
} from './schema.js';
import { appendEvents } from './runs.js';

function summary(row: typeof fileChangeReviews.$inferSelect): FileChangeSummary {
  return {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    preview: row.preview,
    digest: row.digest,
    policyVersion: row.policyVersion as 'file-review-v1',
    status:
      row.status === 'pending' && row.expiresAt.getTime() <= Date.now() ? 'expired' : row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    applicationStatus: row.applyStatus,
    applyErrorCode: row.applyErrorCode,
    applyErrorMessage: row.applyErrorMessage,
    applied: row.applyStatus === 'applied',
  };
}

export type ClaimedFileChange = typeof fileChangeReviews.$inferSelect & {
  workspaceId: string;
};

export type FileChangeApplicationOutcome =
  { status: 'applied' } | { status: 'failed' | 'unknown'; code: string; message: string };

/** The caller must authorize the owning Run before listing proposals. */
export async function listFileChanges(database: DatabaseHandle, runId: string) {
  const rows = await database.db
    .select()
    .from(fileChangeReviews)
    .where(eq(fileChangeReviews.runId, runId))
    .orderBy(asc(fileChangeReviews.createdAt), asc(fileChangeReviews.id));
  return rows.map(summary);
}

/** An approval queues one exact-content application; the Runner performs the write. */
export async function decideFileChange(
  database: DatabaseHandle,
  input: {
    workspaceId: string;
    runId: string;
    changeId: string;
    userId: string;
    digest: string;
    decision: 'approve' | 'reject';
  },
): Promise<
  | { change: FileChangeSummary }
  | { error: 'not_found' | 'forbidden' | 'conflict' | 'expired' | 'run_not_succeeded' }
> {
  return database.db.transaction(async (tx) => {
    // Same lock order as tool completion: Run, then proposal. Serializes competing decisions.
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
      .from(fileChangeReviews)
      .where(
        and(eq(fileChangeReviews.id, input.changeId), eq(fileChangeReviews.runId, input.runId)),
      )
      .for('update');
    if (!row) return { error: 'not_found' };
    if (row.digest !== input.digest || row.policyVersion !== 'file-review-v1')
      return { error: 'conflict' };
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    if (row.status === status) return { change: summary(row) };
    if (row.status !== 'pending')
      return { error: row.status === 'expired' ? 'expired' : 'conflict' };
    const [clock] = await tx
      .select({ expired: sql<boolean>`clock_timestamp() >= ${row.expiresAt}` })
      .from(fileChangeReviews)
      .where(eq(fileChangeReviews.id, row.id));
    const expired = Boolean(clock?.expired);
    if (
      !expired &&
      status === 'approved' &&
      (owned.run.status !== 'succeeded' || owned.run.cancelRequestedAt)
    )
      return { error: 'run_not_succeeded' };
    const [updated] = await tx
      .update(fileChangeReviews)
      .set({
        status: expired ? 'expired' : status,
        decidedAt: expired ? null : sql`clock_timestamp()`,
        decidedBy: expired ? null : input.userId,
      })
      .where(eq(fileChangeReviews.id, row.id))
      .returning();
    if (!updated) throw new Error('proposal decision returned no row');
    const action = `file_change.${updated.status}`;
    await tx.insert(auditRecords).values({
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      action,
      resourceType: 'file_change',
      resourceId: row.id,
      metadata: {
        runId: row.runId,
        stepId: row.stepId,
        digest: row.digest,
        policyVersion: row.policyVersion,
        applied: updated.applyStatus === 'applied',
      },
    });
    await appendEvents(tx, row.runId, [
      {
        type: action,
        stepId: row.stepId,
        payload: { proposalId: row.id, applied: updated.applyStatus === 'applied' },
      },
    ]);
    return expired ? { error: 'expired' } : { change: summary(updated) };
  });
}

/** Claim one approved proposal for the Runner. The database row is the apply lease. */
export async function claimApprovedFileChange(
  database: DatabaseHandle,
  owner: string,
): Promise<ClaimedFileChange | undefined> {
  return database.db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ review: fileChangeReviews, workspaceId: runs.workspaceId })
      .from(fileChangeReviews)
      .innerJoin(runs, eq(runs.id, fileChangeReviews.runId))
      .where(
        and(
          eq(fileChangeReviews.status, 'approved'),
          eq(fileChangeReviews.applyStatus, 'not_started'),
          eq(runs.status, 'succeeded'),
          isNull(runs.cancelRequestedAt),
          sql`${fileChangeReviews.expiresAt} > clock_timestamp()`,
        ),
      )
      .orderBy(asc(fileChangeReviews.createdAt), asc(fileChangeReviews.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!candidate) return undefined;
    const [claimed] = await tx
      .update(fileChangeReviews)
      .set({
        applyStatus: 'applying',
        applyOwner: owner,
        applyStartedAt: sql`clock_timestamp()`,
        applyErrorCode: null,
        applyErrorMessage: null,
      })
      .where(
        and(
          eq(fileChangeReviews.id, candidate.review.id),
          eq(fileChangeReviews.applyStatus, 'not_started'),
        ),
      )
      .returning();
    return claimed ? { ...claimed, workspaceId: candidate.workspaceId } : undefined;
  });
}

/** Persist a deterministic result or an unknown outcome; unknown writes are never replayed. */
export async function finishFileChangeApplication(
  database: DatabaseHandle,
  input: { id: string; owner: string; outcome: FileChangeApplicationOutcome },
) {
  return database.db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ review: fileChangeReviews, workspaceId: runs.workspaceId })
      .from(fileChangeReviews)
      .innerJoin(runs, eq(runs.id, fileChangeReviews.runId))
      .where(
        and(
          eq(fileChangeReviews.id, input.id),
          eq(fileChangeReviews.applyStatus, 'applying'),
          eq(fileChangeReviews.applyOwner, input.owner),
        ),
      )
      .for('update');
    if (!owned) return undefined;
    const row = owned.review;
    const action =
      input.outcome.status === 'applied'
        ? 'file_change.applied'
        : input.outcome.status === 'unknown'
          ? 'file_change.apply_unknown'
          : 'file_change.apply_failed';
    const [updated] = await tx
      .update(fileChangeReviews)
      .set({
        applyStatus: input.outcome.status,
        appliedAt: input.outcome.status === 'applied' ? sql`clock_timestamp()` : null,
        applyOwner: null,
        applyStartedAt: null,
        applyErrorCode: input.outcome.status === 'applied' ? null : input.outcome.code,
        applyErrorMessage: input.outcome.status === 'applied' ? null : input.outcome.message,
      })
      .where(eq(fileChangeReviews.id, row.id))
      .returning();
    if (!updated) throw new Error('file change application returned no row');
    await tx.insert(auditRecords).values({
      workspaceId: owned.workspaceId,
      actorUserId: row.decidedBy,
      action,
      resourceType: 'file_change',
      resourceId: row.id,
      metadata: {
        runId: row.runId,
        stepId: row.stepId,
        digest: row.digest,
        policyVersion: row.policyVersion,
        applied: input.outcome.status === 'applied',
        ...(input.outcome.status === 'applied'
          ? {}
          : { errorCode: input.outcome.code, errorMessage: input.outcome.message }),
      },
    });
    await appendEvents(tx, row.runId, [
      {
        type: action,
        stepId: row.stepId,
        payload: {
          proposalId: row.id,
          applied: input.outcome.status === 'applied',
          ...(input.outcome.status === 'applied'
            ? {}
            : { code: input.outcome.code, message: input.outcome.message }),
        },
      },
    ]);
    return summary(updated);
  });
}

/** Mark a crashed Runner's apply lease as unknown without replaying a possible write. */
export async function recoverStuckFileChangeApplications(database: DatabaseHandle) {
  return database.db.transaction(async (tx) => {
    const rows = await tx
      .select({ review: fileChangeReviews, workspaceId: runs.workspaceId })
      .from(fileChangeReviews)
      .innerJoin(runs, eq(runs.id, fileChangeReviews.runId))
      .where(
        and(
          eq(fileChangeReviews.applyStatus, 'applying'),
          sql`${fileChangeReviews.applyStartedAt} < clock_timestamp() - interval '5 minutes'`,
        ),
      )
      .limit(100)
      .for('update', { skipLocked: true });
    for (const item of rows) {
      const row = item.review;
      await tx
        .update(fileChangeReviews)
        .set({
          applyStatus: 'unknown',
          applyOwner: null,
          applyStartedAt: null,
          applyErrorCode: 'runner_lost',
          applyErrorMessage: '执行器在写入结果确认前中断，未自动重试',
        })
        .where(eq(fileChangeReviews.id, row.id));
      await tx.insert(auditRecords).values({
        workspaceId: item.workspaceId,
        actorUserId: row.decidedBy,
        action: 'file_change.apply_unknown',
        resourceType: 'file_change',
        resourceId: row.id,
        metadata: { runId: row.runId, stepId: row.stepId, digest: row.digest, applied: false },
      });
      await appendEvents(tx, row.runId, [
        {
          type: 'file_change.apply_unknown',
          stepId: row.stepId,
          payload: { proposalId: row.id, applied: false, code: 'runner_lost' },
        },
      ]);
    }
    const expired = await tx
      .select({ review: fileChangeReviews, workspaceId: runs.workspaceId })
      .from(fileChangeReviews)
      .innerJoin(runs, eq(runs.id, fileChangeReviews.runId))
      .where(
        and(
          eq(fileChangeReviews.status, 'approved'),
          eq(fileChangeReviews.applyStatus, 'not_started'),
          sql`${fileChangeReviews.expiresAt} <= clock_timestamp()`,
        ),
      )
      .limit(100)
      .for('update', { skipLocked: true });
    for (const item of expired) {
      const row = item.review;
      await tx
        .update(fileChangeReviews)
        .set({ status: 'expired' })
        .where(eq(fileChangeReviews.id, row.id));
      await tx.insert(auditRecords).values({
        workspaceId: item.workspaceId,
        actorUserId: row.decidedBy,
        action: 'file_change.expired',
        resourceType: 'file_change',
        resourceId: row.id,
        metadata: { runId: row.runId, stepId: row.stepId, digest: row.digest, applied: false },
      });
      await appendEvents(tx, row.runId, [
        {
          type: 'file_change.expired',
          stepId: row.stepId,
          payload: { proposalId: row.id, applied: false },
        },
      ]);
    }
    return rows.length + expired.length;
  });
}
