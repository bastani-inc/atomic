/**
 * Durable run-level elapsed-time checkpoints.
 *
 * Persists the total accumulated elapsed time of a top-level workflow run so a
 * durable `/workflow resume` can seed the new `RunSnapshot` with the prior
 * elapsed time — the main-chat dashboard total then reports prior + current
 * elapsed instead of restarting at zero.
 *
 * Storage shape: a reserved tool-kind checkpoint (name/argsHash
 * `workflow-run-timing`). Tool checkpoints round-trip through the DBOS
 * envelope untouched and are ignored by stage-graph reconstruction, so no
 * phantom stages appear in durable inspection. Repeated updates use distinct
 * checkpoint ids; the latest record (by `completedAt`) wins on hydration
 * because the in-memory mirror replays checkpoints in completion order.
 *
 * cross-ref: packages/workflows/src/shared/timing.ts elapsedRunMs
 */

import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableToolCheckpoint } from "./types.js";
import type { RunSnapshot } from "../shared/store-types.js";
import { elapsedRunMs } from "../shared/timing.js";

/** Reserved checkpoint name AND args-hash for run-level timing records. */
export const RUN_TIMING_CHECKPOINT_NAME = "workflow-run-timing";

/**
 * Debounce granularity for run-timing updates, matching the stage-session
 * duration bucket so piggybacked writes never outpace stage checkpoints.
 */
export const RUN_TIMING_DURATION_BUCKET_MS = 30_000;

function timingBucket(elapsedMs: number): number {
  return Math.floor(elapsedMs / RUN_TIMING_DURATION_BUCKET_MS);
}

/** Prior accumulated run elapsed recorded durably, or undefined when absent. */
export function priorRunElapsedMs(backend: DurableWorkflowBackend, workflowId: string): number | undefined {
  const output = backend.getToolOutput(workflowId, RUN_TIMING_CHECKPOINT_NAME);
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  const elapsedMs = (output as Record<string, unknown>)["elapsedMs"];
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
  return elapsedMs;
}

/**
 * Record the run's current total elapsed time (prior + this session) durably.
 *
 * Skipped when the workflow has no durable progress yet (a timing record with
 * nothing to resume would only manufacture resumability), when the elapsed
 * value did not grow past the last record, or — with `debounce` — while the
 * value stays inside the last 30 s bucket.
 */
export function recordRunTimingCheckpoint(
  backend: DurableWorkflowBackend,
  run: RunSnapshot,
  options?: { readonly debounce?: boolean; readonly now?: number },
): boolean {
  const now = options?.now ?? Date.now();
  const elapsedMs = elapsedRunMs(run, now);
  if (elapsedMs <= 0) return false;
  if (backend.listCheckpoints(run.id).length === 0) return false;
  const recorded = priorRunElapsedMs(backend, run.id);
  if (recorded !== undefined) {
    if (elapsedMs <= recorded) return false;
    if (options?.debounce === true && timingBucket(elapsedMs) === timingBucket(recorded)) return false;
  }
  const checkpoint: DurableToolCheckpoint = {
    kind: "tool",
    workflowId: run.id,
    checkpointId: `run-timing:${elapsedMs}`,
    name: RUN_TIMING_CHECKPOINT_NAME,
    argsHash: RUN_TIMING_CHECKPOINT_NAME,
    output: { elapsedMs },
    completedAt: now,
  };
  backend.recordCheckpoint(checkpoint);
  return true;
}

/**
 * Elapsed time a freshly-created run inherits from its predecessor:
 * continuation resumes measure the live source snapshot; durable re-dispatch
 * resumes (same run id, no continuation) read the persisted timing record.
 */
export function inheritedRunElapsedMs(input: {
  readonly backend: DurableWorkflowBackend;
  readonly runId: string;
  readonly continuationSource?: RunSnapshot;
  readonly now?: number;
}): number | undefined {
  const now = input.now ?? Date.now();
  const source = input.continuationSource;
  const inherited = source !== undefined
    ? elapsedRunMs(source, source.endedAt ?? now)
    : priorRunElapsedMs(input.backend, input.runId);
  return inherited !== undefined && inherited > 0 ? inherited : undefined;
}
