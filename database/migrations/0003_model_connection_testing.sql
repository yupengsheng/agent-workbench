CREATE TYPE model_connection_test_status AS ENUM ('unknown', 'passed', 'failed');

ALTER TABLE model_connections
  ADD COLUMN base_url text NOT NULL DEFAULT 'https://api.deepseek.com',
  ADD COLUMN last_tested_at timestamptz,
  ADD COLUMN last_test_status model_connection_test_status NOT NULL DEFAULT 'unknown',
  ADD COLUMN last_test_error text;
