CREATE TYPE chat_session_status AS ENUM ('active', 'archived');
CREATE TYPE run_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE run_step_kind AS ENUM ('model', 'tool');
CREATE TYPE run_step_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '新对话',
  status chat_session_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_sessions_workspace_owner_updated_at_idx
  ON chat_sessions (workspace_id, owner_user_id, updated_at DESC);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  parent_run_id uuid,
  trigger_user_id uuid NOT NULL REFERENCES users (id),
  model_connection_id uuid REFERENCES model_connections (id) ON DELETE SET NULL,
  status run_status NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_workspace_created_at_idx ON runs (workspace_id, created_at DESC);
CREATE INDEX runs_session_created_at_idx ON runs (session_id, created_at ASC);

CREATE TABLE run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind run_step_kind NOT NULL,
  status run_step_status NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX run_steps_run_created_at_idx ON run_steps (run_id, created_at ASC);

CREATE TABLE run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type text NOT NULL,
  step_id uuid REFERENCES run_steps (id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, sequence)
);

CREATE INDEX run_events_run_sequence_idx ON run_events (run_id, sequence ASC);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  content_type text NOT NULL,
  storage_ref text NOT NULL,
  size_bytes integer NOT NULL DEFAULT 0,
  checksum text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, name)
);

CREATE INDEX artifacts_workspace_created_at_idx ON artifacts (workspace_id, created_at DESC);
