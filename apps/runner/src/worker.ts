import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { parseChatRequest } from '@agent-workbench/contracts';
import { ModelRequestError, OpenAICompatibleModelClient } from '@agent-workbench/runtime';
import type { DatabaseHandle } from '@agent-workbench/persistence/client';
import {
  memberships,
  modelConnections,
  users,
  workspaces,
} from '@agent-workbench/persistence/schema';
import { resolveModelSecret } from '@agent-workbench/persistence/secrets';
import {
  claimRun,
  finishRun,
  recoverExpiredRuns,
  renewLease,
  type ClaimedRun,
} from '@agent-workbench/persistence/runs';

export async function executeRun(
  database: DatabaseHandle,
  run: ClaimedRun,
  shutdown: AbortSignal,
  heartbeatMs = 2000,
) {
  const controller = new AbortController();
  const heartbeatStop = new AbortController();
  let stopReason: 'cancelled' | 'lease_lost' | 'runner_stopped' | 'run_timeout' | undefined;
  const stop = (reason: typeof stopReason) => {
    stopReason ??= reason;
    controller.abort();
  };
  const onShutdown = () => stop('runner_stopped');
  shutdown.addEventListener('abort', onShutdown, { once: true });
  if (shutdown.aborted) onShutdown();
  const deadline = setTimeout(
    () => stop('run_timeout'),
    Math.max(0, run.deadlineAt.getTime() - Date.now()),
  );
  // Start an independent, non-overlapping renewal loop before any model I/O.
  const heartbeat = (async () => {
    while (!heartbeatStop.signal.aborted) {
      try {
        const lease = await renewLease(database, run.id, run.leaseToken);
        if (!lease) {
          stop('lease_lost');
          return;
        }
        if (lease.cancelRequestedAt) {
          stop('cancelled');
          return;
        }
        await delay(heartbeatMs, undefined, { signal: heartbeatStop.signal });
      } catch {
        if (!heartbeatStop.signal.aborted) stop('lease_lost');
        return;
      }
    }
  })();
  try {
    const input = parseChatRequest(run.input);
    if (!input || !run.modelConnectionId) throw new Error('invalid execution input');
    const [authorized] = await database.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(
        and(
          eq(users.id, run.triggerUserId),
          eq(users.status, 'active'),
          eq(workspaces.id, run.workspaceId),
          eq(workspaces.status, 'active'),
        ),
      )
      .limit(1);
    if (!authorized) {
      await finishRun(database, run.id, run.leaseToken, {
        status: 'failed',
        code: 'access_revoked',
        message: '执行权限已被撤销',
      });
      return;
    }
    const [connection] = await database.db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, run.modelConnectionId),
          eq(modelConnections.workspaceId, run.workspaceId),
          eq(modelConnections.status, 'active'),
        ),
      )
      .limit(1);
    const config = run.input.modelConfig as Record<string, unknown> | undefined;
    if (
      !connection ||
      connection.updatedAt.toISOString() !== config?.updatedAt ||
      connection.provider !== config?.provider ||
      connection.modelIdentifier !== config?.model ||
      connection.baseUrl !== config?.baseUrl
    ) {
      await finishRun(database, run.id, run.leaseToken, {
        status: 'failed',
        code: 'model_configuration_changed',
        message: '模型连接已变更或停用，请重新提交',
      });
      return;
    }
    const apiKey = await resolveModelSecret(connection.secretRef, connection.secretCiphertext);
    if (!apiKey) {
      await finishRun(database, run.id, run.leaseToken, {
        status: 'failed',
        code: 'model_secret_unavailable',
        message: '模型密钥无法读取，请联系管理员',
      });
      return;
    }
    const lease = await renewLease(database, run.id, run.leaseToken);
    if (!lease) stop('lease_lost');
    else if (lease.cancelRequestedAt) stop('cancelled');
    controller.signal.throwIfAborted();
    const client = new OpenAICompatibleModelClient(connection.provider, {
      apiKey,
      baseUrl: connection.baseUrl,
      defaultModel: connection.modelIdentifier,
    });
    const result = await client.complete({
      messages: input.messages,
      maxTokens: input.maxTokens ?? 1024,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (!result.message.content?.trim() || result.message.toolCalls?.length) {
      await finishRun(database, run.id, run.leaseToken, {
        status: 'failed',
        code: 'unsupported_model_output',
        message: '模型未返回文本回复，当前运行尚不支持工具调用',
      });
      return;
    }
    await finishRun(database, run.id, run.leaseToken, {
      status: 'succeeded',
      output: {
        message: { role: 'assistant', content: result.message.content },
        provider: result.provider,
        model: result.model,
        finishReason: result.finishReason,
      },
      usage: Object.fromEntries(
        Object.entries(result.usage).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      ),
    });
  } catch (error) {
    if (stopReason === 'lease_lost') return; // Recovery marks the expired execution; no stale writes.
    if (stopReason === 'cancelled') {
      await finishRun(database, run.id, run.leaseToken, { status: 'cancelled' });
    } else {
      await finishRun(database, run.id, run.leaseToken, {
        status: 'failed',
        code: stopReason ?? 'model_request_failed',
        message:
          stopReason === 'runner_stopped'
            ? '执行器正在停止，请重新提交任务'
            : stopReason === 'run_timeout'
              ? '本次执行超过 60 秒，请重试'
              : error instanceof ModelRequestError
                ? error.message
                : '模型执行失败，请重试',
      });
    }
  } finally {
    clearTimeout(deadline);
    heartbeatStop.abort();
    shutdown.removeEventListener('abort', onShutdown);
    await heartbeat;
  }
}

export async function runOnce(
  database: DatabaseHandle,
  owner: string,
  shutdown = new AbortController().signal,
) {
  await recoverExpiredRuns(database);
  if (shutdown.aborted) return false;
  const run = await claimRun(database, owner);
  if (!run) return false;
  await executeRun(database, run, shutdown);
  return true;
}
