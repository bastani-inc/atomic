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
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import type { DurableCheckpoint, DurableToolCheckpoint } from "./types.js";

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
}

/**
 * Create the `ctx.tool` primitive wired to a durable backend.
 */
export function createToolPrimitive(input: CreateToolPrimitiveInput): WorkflowToolPrimitive {
  const ordinals = new Map<string, number>();
  return async <T extends WorkflowSerializableValue>(
    name: string,
    args: Readonly<Record<string, WorkflowSerializableValue>>,
    fn: () => Promise<T>,
    options?: WorkflowToolOptions,
  ): Promise<T> => {
    input.throwIfCancelled();
    const callKey = durableHash({ name, args });
    const ordinal = (ordinals.get(callKey) ?? 0) + 1;
    ordinals.set(callKey, ordinal);
    const argsHash = durableHash({ name, args, ordinal });

    // Check for cached result — completed side effects are not repeated.
    const cached = input.backend.getToolOutput(input.workflowId, argsHash);
    if (cached !== undefined) return cached as T;

    // Execute (with optional retries).
    const result = await executeWithRetries(
      () => runCallback(
        { kind: "workflow.ctx_tool", name, runId: input.workflowId },
        fn,
      ),
      options,
      input.throwIfCancelled,
      input.signal,
    );

    // Re-check cancellation after the tool function resolves but BEFORE the
    // side-effect result is durably checkpointed/returned. A side effect that
    // completes concurrently with a cancellation must not be recorded as a
    // durable checkpoint that a resume would silently replay.
    // cross-ref: issue #1498.
    input.throwIfCancelled();

    // Record the checkpoint durably.
    const checkpoint: DurableToolCheckpoint = {
      kind: "tool",
      workflowId: input.workflowId,
      checkpointId: `tool:${argsHash}`,
      name,
      argsHash,
      output: result,
      completedAt: Date.now(),
    };
    await recordCheckpointDurably(input.backend, checkpoint);
    return result;
  };
}

export async function recordCheckpointDurably(backend: DurableWorkflowBackend, checkpoint: DurableCheckpoint): Promise<void> {
  if (backend.recordCheckpointAsync !== undefined) {
    await backend.recordCheckpointAsync(checkpoint);
    return;
  }
  backend.recordCheckpoint(checkpoint);
  await backend.flush?.();
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
