CREATE TYPE shell_command_review_status AS ENUM ('pending', 'approved', 'rejected', 'expired');
CREATE TYPE shell_command_execution_status AS ENUM ('not_started', 'executing', 'succeeded', 'failed', 'unknown');

CREATE TABLE shell_command_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL UNIQUE REFERENCES run_steps(id) ON DELETE CASCADE,
  proposal jsonb NOT NULL,
  digest text NOT NULL,
  policy_version text NOT NULL DEFAULT 'shell-review-v1',
  status shell_command_review_status NOT NULL DEFAULT 'pending',
  execution_status shell_command_execution_status NOT NULL DEFAULT 'not_started',
  execution_owner uuid,
  execution_started_at timestamptz,
  executed_at timestamptz,
  exit_code integer,
  process_signal text,
  stdout text,
  stderr text,
  output_truncated boolean NOT NULL DEFAULT false,
  duration_ms integer,
  execution_error_code text,
  execution_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id)
);

CREATE INDEX shell_command_reviews_run_idx ON shell_command_reviews(run_id);
CREATE INDEX shell_command_reviews_execution_queue_idx
  ON shell_command_reviews (created_at, id)
  WHERE status = 'approved' AND execution_status = 'not_started';
