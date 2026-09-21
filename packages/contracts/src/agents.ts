export type AgentStatus = 'active' | 'archived';
export type AgentVersionStatus = 'draft' | 'published' | 'archived';

export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: AgentStatus;
  currentVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentVersionSummary {
  id: string;
  agentId: string;
  version: number;
  status: AgentVersionStatus;
  config: Record<string, unknown>;
  publishedAt: string | null;
  createdAt: string;
}

export interface AgentListResponse {
  agents: AgentSummary[];
}

export interface AgentDetailResponse {
  agent: AgentSummary;
  versions: AgentVersionSummary[];
}
