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
  /** Write-only managed secret. It is never returned by the API. */
  secret?: string;
  /** Optional server-side reference for deployments using an external secret store. */
  secretRef?: string;
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
