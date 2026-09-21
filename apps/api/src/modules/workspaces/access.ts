import { and, eq } from 'drizzle-orm';
import type { DatabaseHandle } from '../../db/client.js';
import { memberships, workspaces } from '../../db/schema.js';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface WorkspaceAccess {
  workspaceId: string;
  role: WorkspaceRole;
}

export async function getWorkspaceAccess(
  database: DatabaseHandle,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceAccess | undefined> {
  const [row] = await database.db
    .select({ workspaceId: memberships.workspaceId, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(memberships.workspaceId, workspaces.id))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.userId, userId),
        eq(workspaces.status, 'active'),
      ),
    )
    .limit(1);
  return row;
}

export function canManageWorkspace(role: WorkspaceRole): boolean {
  return role === 'owner' || role === 'admin';
}
