import { relations } from 'drizzle-orm';
import {
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const workspaceStatus = pgEnum('workspace_status', ['active', 'archived']);
export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'member', 'viewer']);
export const modelConnectionStatus = pgEnum('model_connection_status', ['active', 'disabled']);
export const agentStatus = pgEnum('agent_status', ['active', 'archived']);
export const agentVersionStatus = pgEnum('agent_version_status', [
  'draft',
  'published',
  'archived',
]);

const auditTimestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: userStatus('status').notNull().default('active'),
    ...auditTimestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_normalized_idx').on(table.emailNormalized)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    status: workspaceStatus('status').notNull().default('active'),
    ...auditTimestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspaces_slug_idx').on(table.slug)],
);

export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    ...auditTimestamps,
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditTimestamps,
  },
  (table) => [uniqueIndex('sessions_token_hash_idx').on(table.tokenHash)],
);

export const modelConnections = pgTable(
  'model_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull(),
    modelIdentifier: text('model_identifier').notNull(),
    secretRef: text('secret_ref').notNull(),
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
    status: modelConnectionStatus('status').notNull().default('active'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    ...auditTimestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('model_connections_workspace_name_idx').on(table.workspaceId, table.name),
  ],
);

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: agentStatus('status').notNull().default('active'),
    currentVersionId: uuid('current_version_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    ...auditTimestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('agents_workspace_slug_idx').on(table.workspaceId, table.slug)],
);

export const agentVersions = pgTable(
  'agent_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    status: agentVersionStatus('status').notNull().default('draft'),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (table) => [uniqueIndex('agent_versions_agent_version_idx').on(table.agentId, table.version)],
);

export const auditRecords = pgTable('audit_records', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  ...auditTimestamps,
});

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  memberships: many(memberships),
  modelConnections: many(modelConnections),
  agents: many(agents),
  auditRecords: many(auditRecords),
}));

export const userRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
  auditRecords: many(auditRecords),
}));

export const sessionRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const agentRelations = relations(agents, ({ many }) => ({
  versions: many(agentVersions),
}));

export const agentVersionRelations = relations(agentVersions, ({ one }) => ({
  agent: one(agents, {
    fields: [agentVersions.agentId],
    references: [agents.id],
  }),
}));

export const schema = {
  users,
  workspaces,
  memberships,
  sessions,
  modelConnections,
  agents,
  agentVersions,
  auditRecords,
};
