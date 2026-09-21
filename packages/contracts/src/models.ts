export type ModelConnectionStatus = 'active' | 'disabled';
export type ModelConnectionTestStatus = 'unknown' | 'passed' | 'failed';

export interface ModelConnectionSummary {
  id: string;
  name: string;
  provider: string;
  modelIdentifier: string;
  baseUrl: string;
  capabilities: Record<string, boolean>;
  status: ModelConnectionStatus;
  secretConfigured: boolean;
  lastTestStatus: ModelConnectionTestStatus;
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelConnectionListResponse {
  connections: ModelConnectionSummary[];
}
