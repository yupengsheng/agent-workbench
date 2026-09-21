import { createDatabase } from '../db/client.js';
import { sql } from 'drizzle-orm';
import { auditRecords, memberships, users, workspaces } from '../db/schema.js';
import { hashPassword, normalizeEmail } from '../modules/identity/service.js';

const database = createDatabase();
if (!database) {
  throw new Error('DATABASE_URL is required');
}

const email = normalizeEmail(process.env.ADMIN_EMAIL ?? '');
const password = process.env.ADMIN_PASSWORD ?? '';
const displayName = (process.env.ADMIN_DISPLAY_NAME ?? '管理员').trim();
const workspaceName = (process.env.ADMIN_WORKSPACE_NAME ?? '默认工作空间').trim();
const workspaceSlug = (process.env.ADMIN_WORKSPACE_SLUG ?? 'default').trim().toLowerCase();
const allowDevelopmentCredentials =
  process.env.NODE_ENV === 'development' && process.env.ALLOW_WEAK_ADMIN_PASSWORD === 'true';
const isDevelopmentUsername = allowDevelopmentCredentials && email === 'admin';

if ((!/^\S+@\S+\.\S+$/.test(email) && !isDevelopmentUsername) || email.length > 320) {
  throw new Error(
    'ADMIN_EMAIL must be a valid email address (or "admin" with NODE_ENV=development and ALLOW_WEAK_ADMIN_PASSWORD=true)',
  );
}
if (
  (password.length < 12 && !(allowDevelopmentCredentials && password === 'admin')) ||
  password.length > 1024
) {
  throw new Error('ADMIN_PASSWORD must contain 12 to 1024 characters');
}
if (!displayName || displayName.length > 120) {
  throw new Error('ADMIN_DISPLAY_NAME must contain 1 to 120 characters');
}
if (!workspaceName || workspaceName.length > 120) {
  throw new Error('ADMIN_WORKSPACE_NAME must contain 1 to 120 characters');
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(workspaceSlug)) {
  throw new Error('ADMIN_WORKSPACE_SLUG must contain lowercase letters, numbers and hyphens');
}

try {
  const passwordHash = await hashPassword(password);
  const result = await database.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-workbench:admin-init'))`);
    const existing = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing.length > 0) {
      throw new Error('users already exist; refusing to replace or elevate an existing account');
    }

    const [user] = await tx
      .insert(users)
      .values({
        email,
        emailNormalized: email,
        displayName,
        passwordHash,
      })
      .returning({ id: users.id, email: users.email });
    if (!user) throw new Error('user insert returned no row');

    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: workspaceName, slug: workspaceSlug })
      .returning({ id: workspaces.id, name: workspaces.name });
    if (!workspace) throw new Error('workspace insert returned no row');

    await tx.insert(memberships).values({
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
    });
    await tx.insert(auditRecords).values({
      workspaceId: workspace.id,
      actorUserId: user.id,
      action: 'admin.initialized',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { workspaceId: workspace.id },
    });
    return { user, workspace };
  });

  console.log(`initialized admin ${result.user.email} (${result.user.id})`);
  console.log(`created workspace ${result.workspace.name} (${result.workspace.id})`);
} finally {
  await database.pool.end();
}
