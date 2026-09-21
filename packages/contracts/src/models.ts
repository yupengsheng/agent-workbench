export type ModelConnectionStatus = 'active' | 'disabled';

export interface ModelConnectionSummary {
  id: string;
  name: string;
  provider: string;
  modelIdentifier: string;
  capabilities: Record<string, boolean>;
  status: ModelConnectionStatus;
  secretConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConnectionListResponse {
  connections: ModelConnectionSummary[];
}
