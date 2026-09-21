export interface AuditRecordSummary {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditRecordListResponse {
  records: AuditRecordSummary[];
  nextOffset: number | null;
}
