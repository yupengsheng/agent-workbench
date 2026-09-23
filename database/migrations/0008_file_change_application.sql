CREATE TYPE file_change_apply_status AS ENUM ('not_started', 'applying', 'applied', 'failed', 'unknown');

ALTER TABLE file_change_reviews
  ADD COLUMN proposed_content text NOT NULL DEFAULT '',
  ADD COLUMN apply_status file_change_apply_status NOT NULL DEFAULT 'not_started',
  ADD COLUMN apply_owner uuid,
  ADD COLUMN apply_started_at timestamptz,
  ADD COLUMN applied_at timestamptz,
  ADD COLUMN apply_error_code text,
  ADD COLUMN apply_error_message text;

ALTER TABLE file_change_reviews
  ALTER COLUMN proposed_content DROP DEFAULT;

CREATE INDEX file_change_reviews_apply_queue_idx
  ON file_change_reviews (created_at, id)
  WHERE status = 'approved' AND apply_status = 'not_started';
