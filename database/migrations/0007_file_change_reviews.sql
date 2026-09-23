CREATE TYPE file_change_review_status AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE file_change_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id uuid NOT NULL UNIQUE REFERENCES run_steps(id) ON DELETE CASCADE,
  preview jsonb NOT NULL,
  digest text NOT NULL,
  policy_version text NOT NULL DEFAULT 'file-review-v1',
  status file_change_review_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  decided_at timestamptz,
  decided_by uuid REFERENCES users(id)
);
CREATE INDEX file_change_reviews_run_idx ON file_change_reviews(run_id);
