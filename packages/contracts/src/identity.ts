export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}

export interface AuthResponse {
  user: UserSummary;
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}
