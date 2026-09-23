import type { FileChangeSummary } from './file-changes.js';

export type SessionStatus = 'active' | 'archived';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type RunStepKind = 'model' | 'tool';
export type RunStepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RunSummary {
  id: string;
  sessionId: string;
  modelConnectionId: string | null;
  status: RunStatus;
  cancelRequestedAt: string | null;
  deadlineAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunStepSummary {
  id: string;
  runId: string;
  sequence: number;
  kind: RunStepKind;
  status: RunStepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  usage: Record<string, number>;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RunEventSummary {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  stepId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SessionListResponse {
  sessions: SessionSummary[];
}

export interface SessionDetailResponse {
  session: SessionSummary;
  runs: RunDetailResponse[];
}

export interface RunDetailResponse {
  run: RunSummary;
  steps: RunStepSummary[];
  events: RunEventSummary[];
  fileChanges: FileChangeSummary[];
}
