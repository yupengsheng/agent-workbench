import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { parseChatRequest } from '@agent-workbench/contracts';
import {
  AgentLoopError,
  executeAgentLoop,
  ModelRequestError,
  ModelRouterError,
  OpenAICompatibleModelClient,
  TypeSafeJevModelRouter,
  type ToolCall,
} from '@agent-workbench/runtime';
import { createReadOnlyToolRegistry } from '@agent-workbench/tools';
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
  finishToolStep,
  recordModelRoute,
  startToolStep,
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
    if (!input) throw new Error('invalid execution input');
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
    const runRouting = run.input.routing as
      | {
          mode?: unknown;
          candidates?: unknown;
        }
      | undefined;
    const routingMode = input.routing?.mode ?? 'fixed';
    let selectedModelConnectionId = run.modelConnectionId;
    let routeDecision:
      | {
          selectedId: string;
          confidence: number;
          probabilities: Record<string, number>;
          router: 'jev';
          routerModel: 'jev-latest';
        }
      | undefined;
    let selectedSnapshot:
      | {
          id: string;
          provider: string;
          model: string;
          baseUrl: string;
          updatedAt: string;
        }
      | undefined;
    if (routingMode === 'jev') {
      if (runRouting?.mode !== 'jev' || !Array.isArray(runRouting.candidates)) {
        throw new ModelRouterError('router_invalid_response', '任务缺少 Jev 候选快照');
      }
      const expectedCandidateIds = input.routing?.candidateModelConnectionIds;
      const snapshots = runRouting.candidates.filter(
        (
          candidate,
        ): candidate is {
          id: string;
          provider: string;
          model: string;
          baseUrl: string;
          capabilities: Record<string, boolean>;
          updatedAt: string;
        } => {
          if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
            return false;
          const item = candidate as Record<string, unknown>;
          return (
            typeof item.id === 'string' &&
            typeof item.provider === 'string' &&
            typeof item.model === 'string' &&
            typeof item.baseUrl === 'string' &&
            typeof item.updatedAt === 'string' &&
            typeof item.capabilities === 'object' &&
            item.capabilities !== null &&
            !Array.isArray(item.capabilities) &&
            Object.values(item.capabilities).every((value) => typeof value === 'boolean')
          );
        },
      );
      if (
        snapshots.length < 1 ||
        snapshots.length !== runRouting.candidates.length ||
        !expectedCandidateIds ||
        expectedCandidateIds.length !== snapshots.length ||
        snapshots.some((snapshot) => !expectedCandidateIds.includes(snapshot.id))
      ) {
        throw new ModelRouterError('router_invalid_response', '任务的 Jev 候选快照无效');
      }
      const candidateRows = await database.db
        .select()
        .from(modelConnections)
        .where(
          and(
            inArray(
              modelConnections.id,
              snapshots.map((candidate) => candidate.id),
            ),
            eq(modelConnections.workspaceId, run.workspaceId),
            eq(modelConnections.status, 'active'),
          ),
        );
      if (candidateRows.length !== snapshots.length) {
        throw new ModelRouterError('router_no_candidate', 'Jev 候选模型已停用或不存在');
      }
      const rowsById = new Map(candidateRows.map((candidate) => [candidate.id, candidate]));
      for (const snapshot of snapshots) {
        const current = rowsById.get(snapshot.id);
        if (
          !current ||
          current.provider !== snapshot.provider ||
          current.modelIdentifier !== snapshot.model ||
          current.baseUrl !== snapshot.baseUrl ||
          current.updatedAt.toISOString() !== snapshot.updatedAt
        ) {
          throw new ModelRouterError('router_no_candidate', 'Jev 候选模型配置已变更，请重新提交');
        }
      }
      const router = new TypeSafeJevModelRouter({
        ...(process.env.TYPESAFE_API_KEY ? { apiKey: process.env.TYPESAFE_API_KEY } : {}),
        timeoutMs: Number(process.env.TYPESAFE_ROUTER_TIMEOUT_MS ?? 5000),
      });
      routeDecision = await router.choose(
        input.messages
          .map((message) => `${message.role}: ${message.content}`)
          .slice(-8)
          .join('\n'),
        snapshots.map((candidate) => ({
          id: candidate.id,
          provider: candidate.provider,
          model: candidate.model,
          capabilities: candidate.capabilities,
        })),
        controller.signal,
      );
      const minimumConfidence = Number(process.env.TYPESAFE_ROUTER_MIN_CONFIDENCE ?? 0.65);
      if (!Number.isFinite(minimumConfidence) || routeDecision.confidence < minimumConfidence) {
        throw new ModelRouterError(
          'router_low_confidence',
          `Jev 对模型选择的置信度不足（${routeDecision.confidence.toFixed(2)}），请手动选择模型重试`,
        );
      }
      selectedModelConnectionId = routeDecision.selectedId;
      if (!selectedModelConnectionId) {
        throw new ModelRouterError('router_no_candidate', 'Jev 没有选择可用模型');
      }
      selectedSnapshot = snapshots.find((candidate) => candidate.id === selectedModelConnectionId);
      if (!selectedSnapshot) {
        throw new ModelRouterError('router_no_candidate', 'Jev 选择了未授权的模型');
      }
      const recorded = await recordModelRoute(
        database,
        run.id,
        run.leaseToken,
        selectedModelConnectionId,
        {
          router: routeDecision.router,
          routerModel: routeDecision.routerModel,
          selectedCandidateId: selectedModelConnectionId,
          confidence: routeDecision.confidence,
          probabilities: routeDecision.probabilities,
          candidates: snapshots.map((candidate) => ({
            id: candidate.id,
            provider: candidate.provider,
            model: candidate.model,
          })),
        },
      );
      if (!recorded) {
        stop('lease_lost');
        throw new Error('runner lease lost while recording model route');
      }
    } else if (!selectedModelConnectionId) {
      throw new Error('invalid execution input');
    }

    const [connection] = await database.db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, selectedModelConnectionId),
          eq(modelConnections.workspaceId, run.workspaceId),
          eq(modelConnections.status, 'active'),
        ),
      )
      .limit(1);
    const config = run.input.modelConfig as Record<string, unknown> | undefined;
    const fixedConfigurationChanged =
      routingMode === 'fixed' &&
      (!connection ||
        connection.updatedAt.toISOString() !== config?.updatedAt ||
        connection.provider !== config?.provider ||
        connection.modelIdentifier !== config?.model ||
        connection.baseUrl !== config?.baseUrl);
    const routedConfigurationChanged =
      routingMode === 'jev' &&
      (!connection ||
        !selectedSnapshot ||
        connection.provider !== selectedSnapshot.provider ||
        connection.modelIdentifier !== selectedSnapshot.model ||
        connection.baseUrl !== selectedSnapshot.baseUrl ||
        connection.updatedAt.toISOString() !== selectedSnapshot.updatedAt);
    if (fixedConfigurationChanged || routedConfigurationChanged || !connection) {
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
    const toolRegistry = createReadOnlyToolRegistry();
    const toolDefinitions =
      connection.capabilities.tools === true ? toolRegistry.definitions() : [];
    const result = await executeAgentLoop(
      client,
      input.messages.map((message) => ({ role: message.role, content: message.content })),
      {
        tools: toolDefinitions,
        model: connection.modelIdentifier,
        ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
        maxTokens: input.maxTokens ?? 1024,
        signal: controller.signal,
        executor: {
          execute: async (call: ToolCall, signal?: AbortSignal) => {
            const stepId = await startToolStep(database, run.id, run.leaseToken, {
              toolName: call.function.name,
              toolCallId: call.id,
              arguments: call.function.arguments.slice(0, 8_192),
            });
            if (!stepId) {
              stop('lease_lost');
              throw new Error('runner lease lost while starting tool step');
            }
            const observation = await toolRegistry.execute(
              call.function.name,
              call.function.arguments,
              {
                workspaceId: run.workspaceId,
                ...(signal ? { signal } : {}),
              },
            );
            const recorded = await finishToolStep(
              database,
              run.id,
              run.leaseToken,
              stepId,
              observation.status === 'cancelled'
                ? { status: 'cancelled' }
                : {
                    status: 'succeeded',
                    output: {
                      toolName: call.function.name,
                      toolCallId: call.id,
                      status: observation.status,
                      content: observation.content,
                      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
                      ...(observation.truncated ? { truncated: true } : {}),
                    },
                  },
            );
            if (!recorded) {
              stop('lease_lost');
              throw new Error('runner lease lost while finishing tool step');
            }
            return observation;
          },
        },
        maxRounds: 8,
        maxToolCalls: 16,
        maxTotalTokens: 16_384,
      },
    );
    controller.signal.throwIfAborted();
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
      const executionCode =
        error instanceof ModelRouterError
          ? error.code
          : error instanceof AgentLoopError
            ? error.code
            : 'model_request_failed';
      await finishRun(database, run.id, run.leaseToken, {
        status: 'failed',
        code: stopReason ?? executionCode,
        message:
          stopReason === 'runner_stopped'
            ? '执行器正在停止，请重新提交任务'
            : stopReason === 'run_timeout'
              ? '本次执行超过 60 秒，请重试'
              : error instanceof ModelRouterError
                ? error.message
                : error instanceof ModelRequestError
                  ? error.message
                  : error instanceof AgentLoopError
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
