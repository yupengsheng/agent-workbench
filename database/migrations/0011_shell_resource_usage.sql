ALTER TABLE shell_command_reviews
  ADD COLUMN resource_usage jsonb;

ALTER TABLE shell_command_reviews
  ADD CONSTRAINT shell_command_reviews_resource_usage_object
  CHECK (resource_usage IS NULL OR jsonb_typeof(resource_usage) = 'object');
