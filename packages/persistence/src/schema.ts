import { relations } from 'drizzle-orm';
import type { FileChangePreview } from '@agent-workbench/contracts';
import {
  integer,
  index,
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
export const modelConnectionTestStatus = pgEnum('model_connection_test_status', [
  'unknown',
  'passed',
  'failed',
]);
export const agentStatus = pgEnum('agent_status', ['active', 'archived']);
export const agentVersionStatus = pgEnum('agent_version_status', [
  'draft',
  'published',
  'archived',
]);
export const chatSessionStatus = pgEnum('chat_session_status', ['active', 'archived']);
export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const runStepKind = pgEnum('run_step_kind', ['model', 'tool']);
export const runStepStatus = pgEnum('run_step_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
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
    secretCiphertext: text('secret_ciphertext'),
    baseUrl: text('base_url').notNull().default('https://api.deepseek.com'),
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>().notNull().default({}),
    status: modelConnectionStatus('status').notNull().default('active'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestStatus: modelConnectionTestStatus('last_test_status').notNull().default('unknown'),
    lastTestError: text('last_test_error'),
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

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('新对话'),
    status: chatSessionStatus('status').notNull().default('active'),
    ...auditTimestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('chat_sessions_workspace_owner_updated_at_idx').on(
      table.workspaceId,
      table.ownerUserId,
      table.updatedAt,
    ),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    parentRunId: uuid('parent_run_id'),
    triggerUserId: uuid('trigger_user_id')
      .notNull()
      .references(() => users.id),
    modelConnectionId: uuid('model_connection_id').references(() => modelConnections.id, {
      onDelete: 'set null',
    }),
    leaseToken: uuid('lease_token'),
    leaseOwner: uuid('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    status: runStatus('status').notNull().default('queued'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...auditTimestamps,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('runs_workspace_created_at_idx').on(table.workspaceId, table.createdAt)],
);

export const runSteps = pgTable(
  'run_steps',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    kind: runStepKind('kind').notNull(),
    status: runStepStatus('status').notNull().default('queued'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb('output').$type<Record<string, unknown> | null>(),
    usage: jsonb('usage').$type<Record<string, number>>().notNull().default({}),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...auditTimestamps,
  },
  (table) => [uniqueIndex('run_steps_run_sequence_idx').on(table.runId, table.sequence)],
);

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    type: text('type').notNull(),
    stepId: uuid('step_id').references(() => runSteps.id, { onDelete: 'set null' }),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    ...auditTimestamps,
  },
  (table) => [uniqueIndex('run_events_run_sequence_idx').on(table.runId, table.sequence)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    contentType: text('content_type').notNull(),
    storageRef: text('storage_ref').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    checksum: text('checksum'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...auditTimestamps,
  },
  (table) => [uniqueIndex('artifacts_run_name_idx').on(table.runId, table.name)],
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

export const fileChangeReviewStatus = pgEnum('file_change_review_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);
export const fileChangeApplyStatus = pgEnum('file_change_apply_status', [
  'not_started',
  'applying',
  'applied',
  'failed',
  'unknown',
]);
export const fileChangeReviews = pgTable(
  'file_change_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepId: uuid('step_id')
      .notNull()
      .unique()
      .references(() => runSteps.id, { onDelete: 'cascade' }),
    preview: jsonb('preview').$type<FileChangePreview>().notNull(),
    proposedContent: text('proposed_content').notNull(),
    digest: text('digest').notNull(),
    policyVersion: text('policy_version').notNull().default('file-review-v1'),
    status: fileChangeReviewStatus('status').notNull().default('pending'),
    applyStatus: fileChangeApplyStatus('apply_status').notNull().default('not_started'),
    applyOwner: uuid('apply_owner'),
    applyStartedAt: timestamp('apply_started_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    applyErrorCode: text('apply_error_code'),
    applyErrorMessage: text('apply_error_message'),
    ...auditTimestamps,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => users.id),
  },
  (table) => [index('file_change_reviews_run_idx').on(table.runId)],
);

export const workspaceRelations = relations(workspaces, ({ many }) => ({
  memberships: many(memberships),
  modelConnections: many(modelConnections),
  agents: many(agents),
  auditRecords: many(auditRecords),
  chatSessions: many(chatSessions),
  runs: many(runs),
  artifacts: many(artifacts),
}));

export const userRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
  auditRecords: many(auditRecords),
  chatSessions: many(chatSessions),
  runs: many(runs),
  fileChangeDecisions: many(fileChangeReviews),
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

export const chatSessionRelations = relations(chatSessions, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [chatSessions.workspaceId],
    references: [workspaces.id],
  }),
  owner: one(users, {
    fields: [chatSessions.ownerUserId],
    references: [users.id],
  }),
  runs: many(runs),
}));

export const runRelations = relations(runs, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [runs.workspaceId],
    references: [workspaces.id],
  }),
  session: one(chatSessions, {
    fields: [runs.sessionId],
    references: [chatSessions.id],
  }),
  triggerUser: one(users, {
    fields: [runs.triggerUserId],
    references: [users.id],
  }),
  modelConnection: one(modelConnections, {
    fields: [runs.modelConnectionId],
    references: [modelConnections.id],
  }),
  steps: many(runSteps),
  events: many(runEvents),
  artifacts: many(artifacts),
  fileChanges: many(fileChangeReviews),
}));

export const runStepRelations = relations(runSteps, ({ one, many }) => ({
  run: one(runs, {
    fields: [runSteps.runId],
    references: [runs.id],
  }),
  events: many(runEvents),
  fileChangeReview: one(fileChangeReviews),
}));

export const runEventRelations = relations(runEvents, ({ one }) => ({
  run: one(runs, {
    fields: [runEvents.runId],
    references: [runs.id],
  }),
  step: one(runSteps, {
    fields: [runEvents.stepId],
    references: [runSteps.id],
  }),
}));

export const artifactRelations = relations(artifacts, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [artifacts.workspaceId],
    references: [workspaces.id],
  }),
  run: one(runs, {
    fields: [artifacts.runId],
    references: [runs.id],
  }),
}));

export const fileChangeReviewRelations = relations(fileChangeReviews, ({ one }) => ({
  run: one(runs, {
    fields: [fileChangeReviews.runId],
    references: [runs.id],
  }),
  step: one(runSteps, {
    fields: [fileChangeReviews.stepId],
    references: [runSteps.id],
  }),
  decidedBy: one(users, {
    fields: [fileChangeReviews.decidedBy],
    references: [users.id],
  }),
}));

export const schema = {
  fileChangeReviews,
  users,
  workspaces,
  memberships,
  sessions,
  modelConnections,
  agents,
  agentVersions,
  chatSessions,
  runs,
  runSteps,
  runEvents,
  artifacts,
  auditRecords,
};
