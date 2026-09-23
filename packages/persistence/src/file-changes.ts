import { and, asc, eq, sql } from 'drizzle-orm';
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
    policyVersion: 'file-review-v1',
    status:
      row.status === 'pending' && row.expiresAt.getTime() <= Date.now() ? 'expired' : row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: row.decidedBy,
    applied: false,
  };
}

/** The caller must authorize the owning Run before listing proposals. */
export async function listFileChanges(database: DatabaseHandle, runId: string) {
  const rows = await database.db
    .select()
    .from(fileChangeReviews)
    .where(eq(fileChangeReviews.runId, runId))
    .orderBy(asc(fileChangeReviews.createdAt), asc(fileChangeReviews.id));
  return rows.map(summary);
}

/** An approval records review only. It is not a credential for a filesystem write. */
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
        applied: false,
      },
    });
    await appendEvents(tx, row.runId, [
      { type: action, stepId: row.stepId, payload: { proposalId: row.id, applied: false } },
    ]);
    return expired ? { error: 'expired' } : { change: summary(updated) };
  });
}
