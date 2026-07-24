/**
 * `ctx.tool` primitive — durable cached execution of arbitrary TypeScript code.
 *
 * Runs a user-supplied async function and caches the result durably via the
 * {@link DurableWorkflowBackend}. On resume, if the tool already completed
 * (matched by content hash of name + args), the cached result is returned
 * without re-executing the function — ensuring completed side effects are not
 * repeated.
 *
 * Only `ctx.*` blocks produce durable checkpoints. Anything outside `ctx.*`
 * (including bare `await someFunction()`) is never saved, matching the issue's
 * requirement: "checkpoints are effectively only `ctx.*` blocks."
 *
 * cross-ref: issue #1498 — "Introduce ctx.tool which allows you to run any
 * typescript code and cache the result for DBOS."
 */

import { runCallback } from "@bastani/atomic";
import type { ToolNodeSnapshot } from "../shared/store-types.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import { DURABLE_TOOL_TOPOLOGY_VERSION, type DurableCheckpoint, type DurableStageRunTopology, type DurableToolCheckpoint } from "./types.js";

/**
 * Options for `ctx.tool(name, args, fn)`.
 */
export interface WorkflowToolOptions {
  /**
   * When true, the tool function is retried on failure with exponential
   * backoff. Defaults to false (matching DBOS step default).
   */
  readonly retriesAllowed?: boolean;
  /** Max retry attempts when retriesAllowed is true. Default 3. */
  readonly maxAttempts?: number;
  /** Initial retry interval in ms. Default 1000. */
  readonly intervalMs?: number;
  /** Backoff multiplier. Default 2. */
  readonly backoffRate?: number;
}

/**
 * The `ctx.tool` primitive type exposed on {@link WorkflowRunContext}.
 *
 * @param name Tool name (for display and checkpoint identity).
 * @param args Tool arguments (JSON-serializable; included in the content hash).
 * @param fn The async function to execute. Its return must be JSON-serializable.
 * @param options Retry configuration.
 */
export type WorkflowToolPrimitive = <T extends WorkflowSerializableValue>(
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: () => Promise<T>,
  options?: WorkflowToolOptions,
) => Promise<T>;

export interface CreateToolPrimitiveInput {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  /** Monotonic checkpoint id counter source. */
  readonly nextCheckpointId: () => string;
  /** Abort check; throws if the workflow has been cancelled. */
  readonly throwIfCancelled: () => void;
  /** Optional signal for aborting retry backoff sleeps. */
  readonly signal?: AbortSignal;
  /** Track the final logical execution promise without replacing its identity. */
  readonly trackExecution?: <T>(execution: Promise<T>) => void;
  /** Admit/update a first-class graph node around the durable call. */
  readonly onNodeStart?: (node: ToolNodeSnapshot) => void;
  readonly onNodeRunning?: (nodeId: string, startedAt: number) => void;
  readonly onNodeEnd?: (nodeId: string, update: Pick<ToolNodeSnapshot, "status"> & Partial<Pick<ToolNodeSnapshot, "endedAt" | "resultSummary" | "error">>) => void;
  readonly onNodeSettle?: (nodeId: string) => void;
  readonly runTopology?: DurableStageRunTopology;
}

/**
 * Create the `ctx.tool` primitive wired to a durable backend.
 */
export function createToolPrimitive(input: CreateToolPrimitiveInput): WorkflowToolPrimitive {
  const ordinals = new Map<string, number>();
  return <T extends WorkflowSerializableValue>(
    name: string,
    args: Readonly<Record<string, WorkflowSerializableValue>>,
    fn: () => Promise<T>,
    options?: WorkflowToolOptions,
  ): Promise<T> => {
    let resolveExecution!: (value: T | PromiseLike<T>) => void;
    let rejectExecution!: (reason?: unknown) => void;
    const execution = new Promise<T>((resolve, reject) => {
      resolveExecution = resolve;
      rejectExecution = reject;
    });
    input.trackExecution?.(execution);
    void executeToolInvocation(input, ordinals, name, args, fn, options).then(resolveExecution, rejectExecution);
    return execution;
  };
}

async function executeToolInvocation<T extends WorkflowSerializableValue>(
  input: CreateToolPrimitiveInput,
  ordinals: Map<string, number>,
  name: string,
  args: Readonly<Record<string, WorkflowSerializableValue>>,
  fn: () => Promise<T>,
  options?: WorkflowToolOptions,
): Promise<T> {
  input.throwIfCancelled();
  const callKey = durableHash({ name, args });
  const ordinal = (ordinals.get(callKey) ?? 0) + 1;
  ordinals.set(callKey, ordinal);
  const argsHash = durableHash({ name, args, ordinal });

  const cached = input.backend.getToolCheckpoint(input.workflowId, argsHash);
  const node: ToolNodeSnapshot = {
    kind: "tool",
    id: cached?.topology?.nodeId ?? `tool:${argsHash}`,
    name,
    argsHash,
    ordinal: cached?.topology?.ordinal ?? ordinal,
    parentIds: Object.freeze(cached?.topology?.parentIds ?? []),
    status: "pending",
    ...(cached !== undefined && cached.topology === undefined ? { topologyState: "unavailable" as const } : {}),
    ...(cached !== undefined ? { replayed: true } : {}),
    ...(cached?.topology?.order !== undefined ? { executionOrder: cached.topology.order } : {}),
    ...(cached?.topology?.startedAt !== undefined ? { startedAt: cached.topology.startedAt } : {}),
    attachable: false,
  };
  input.onNodeStart?.(node);
  if (cached !== undefined) {
    const endedAt = cached.topology?.endedAt ?? cached.completedAt;
    try {
      await recordReplayedToolTopology(input, node, cached, argsHash, endedAt);
      input.onNodeEnd?.(node.id, {
        status: "cached",
        endedAt,
        resultSummary: summarizeToolResult(cached.output),
      });
      input.onNodeSettle?.(node.id);
      return cached.output as T;
    } catch (error) {
      const status = input.signal?.aborted === true ? "cancelled" : "failed";
      input.onNodeEnd?.(node.id, { status, endedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
      input.onNodeSettle?.(node.id);
      throw error;
    }
  }

  const startedAt = Date.now();
  input.onNodeRunning?.(node.id, startedAt);
  try {
    const result = await executeWithRetries(
      () => runCallback(
        { kind: "workflow.ctx_tool", name, runId: input.workflowId },
        fn,
      ),
      options,
      input.throwIfCancelled,
      input.signal,
    );

    // Linearization policy: cancellation observed before persistence prevents
    // a checkpoint. Once the durable write begins, a successful commit wins
    // for this node; the root still observes its aborted signal and is killed.
    input.throwIfCancelled();
    const completedAt = Date.now();
    const checkpoint: DurableToolCheckpoint = {
      kind: "tool",
      workflowId: input.workflowId,
      checkpointId: `tool:${argsHash}`,
      name,
      argsHash,
      output: result,
      completedAt,
      topology: {
        version: DURABLE_TOOL_TOPOLOGY_VERSION,
        nodeId: node.id,
        ordinal,
        order: node.executionOrder ?? 0,
        parentIds: [...node.parentIds],
        startedAt,
        endedAt: completedAt,
        ...(input.runTopology !== undefined ? { run: { ...input.runTopology } } : {}),
      },
    };
    await recordCheckpointDurably(input.backend, checkpoint);
    input.onNodeEnd?.(node.id, { status: "completed", endedAt: completedAt, resultSummary: summarizeToolResult(result) });
    input.onNodeSettle?.(node.id);
    return result;
  } catch (error) {
    const cancelled = input.signal?.aborted === true;
    input.onNodeEnd?.(node.id, {
      status: cancelled ? "cancelled" : "failed",
      endedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    input.onNodeSettle?.(node.id);
    throw error;
  }
}


async function recordReplayedToolTopology(
  input: CreateToolPrimitiveInput,
  node: ToolNodeSnapshot,
  cached: DurableToolCheckpoint,
  argsHash: string,
  endedAt: number,
): Promise<void> {
  const runTopology = input.runTopology;
  if (runTopology === undefined) return;
  if (cached.topology === undefined && runTopology.parentRunId === undefined) return;
  if (cached.topology?.run?.runId === runTopology.runId) return;
  const topology = cached.topology === undefined
    ? {
        version: DURABLE_TOOL_TOPOLOGY_VERSION,
        nodeId: node.id,
        ordinal: node.ordinal,
        order: node.executionOrder ?? 0,
        parentIds: [...node.parentIds],
        endedAt,
        run: { ...runTopology },
      }
    : {
        ...cached.topology,
        parentIds: [...node.parentIds],
        order: node.executionOrder ?? cached.topology.order,
        endedAt,
        run: { ...runTopology },
      };
  const unchanged = cached.topology !== undefined
    && JSON.stringify(cached.topology.parentIds) === JSON.stringify(topology.parentIds)
    && JSON.stringify(cached.topology.run) === JSON.stringify(topology.run)
    && cached.topology.endedAt === topology.endedAt;
  if (unchanged) return;
  await recordCheckpointDurably(input.backend, {
    kind: "tool",
    workflowId: input.workflowId,
    checkpointId: `tool-replay-meta:${durableHash({ argsHash, topology })}`,
    name: node.name,
    argsHash,
    output: cached.output,
    completedAt: Date.now(),
    topology,
  });
}
function summarizeToolResult(value: WorkflowSerializableValue): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value).slice(0, 240);
  return serialized.length <= 240 ? serialized : `${serialized.slice(0, 237)}...`;
}

export async function recordCheckpointDurably(backend: DurableWorkflowBackend, checkpoint: DurableCheckpoint): Promise<void> {
  await backend.recordCheckpointAsync(checkpoint);
}

async function executeWithRetries<T>(
  fn: () => Promise<T>,
  options: WorkflowToolOptions | undefined,
  throwIfCancelled: () => void,
  signal?: AbortSignal,
): Promise<T> {
  throwIfCancelled();
  if (!options?.retriesAllowed) return fn();
  const maxAttempts = options.maxAttempts ?? 3;
  const intervalMs = options.intervalMs ?? 1000;
  const backoffRate = options.backoffRate ?? 2;
  let lastError: Error | undefined;
  let delay = intervalMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfCancelled();
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        await sleepOrAbort(delay, signal);
        throwIfCancelled();
        delay = Math.min(delay * backoffRate, 3600_000);
      }
    }
  }
  throw lastError ?? new Error("ctx.tool: retries exhausted");
}

export function sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("atomic-workflows: workflow cancelled"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => fail(signal?.reason instanceof Error ? signal.reason : new Error("atomic-workflows: workflow cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Create a monotonic checkpoint id generator for a workflow.
 */
export function createCheckpointIdGenerator(): () => string {
  let counter = 0;
  return () => `cp-${++counter}`;
}
