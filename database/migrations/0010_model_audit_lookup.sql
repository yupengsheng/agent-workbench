CREATE INDEX audit_records_workspace_resource_created_at_idx
  ON audit_records (workspace_id, resource_type, created_at DESC, id DESC);
