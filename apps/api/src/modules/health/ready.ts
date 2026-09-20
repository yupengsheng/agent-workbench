import type { DatabaseHandle } from '../../db/client.js';
import type { ReadinessResponse } from './types.js';

export async function getReadiness(
  database: DatabaseHandle | undefined,
): Promise<ReadinessResponse> {
  if (!database) {
    return {
      status: 'unavailable',
      service: 'agent-workbench-api',
      apiVersion: 'v1',
      dependencies: { database: 'not_configured' },
    };
  }

  try {
    await database.pool.query('SELECT 1');
    return {
      status: 'ok',
      service: 'agent-workbench-api',
      apiVersion: 'v1',
      dependencies: { database: 'ok' },
    };
  } catch {
    return {
      status: 'unavailable',
      service: 'agent-workbench-api',
      apiVersion: 'v1',
      dependencies: { database: 'unavailable' },
    };
  }
}
