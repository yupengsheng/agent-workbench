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

export interface ModelConnectionInput {
  name: string;
  provider: string;
  modelIdentifier: string;
  secretRef: string;
  baseUrl: string;
  capabilities: Record<string, boolean>;
}

export interface ModelConnectionTestResponse {
  status: 'passed';
  provider: string;
  model: string;
  finishReason: string | null;
  usage: Record<string, number>;
  testedAt: string;
}
