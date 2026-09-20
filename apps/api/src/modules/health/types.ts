export interface ReadinessResponse {
  status: 'ok' | 'unavailable';
  service: 'agent-workbench-api';
  apiVersion: 'v1';
  dependencies: {
    database: 'ok' | 'not_configured' | 'unavailable';
  };
}
