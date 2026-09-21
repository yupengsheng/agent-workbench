ALTER TABLE runs
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_owner uuid,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN deadline_at timestamptz;

CREATE INDEX runs_queued_idx ON runs (created_at, id) WHERE status = 'queued';
CREATE INDEX runs_lease_idx ON runs (lease_expires_at) WHERE status = 'running';
