/**
 * Durable terminal-status finalization for workflow runs.
 *
 * Extracted from `run()` to keep the engine entrypoint under the file-length
 * gate. Persists the final durable status (cancelled/blocked/skipped/failed/
 * killed) for cross-session resume discovery when the run did not complete
 * normally (normal completion is handled in the run try-block).
 *
 * cross-ref: issue #1498.
 */

import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowPersistencePort } from "../shared/types.js";
import type { DurableWorkflowBackend } from "../durable/backend.js";
import { persistDurableCacheEntry } from "../durable/resume-catalog.js";
import type { DurableWorkflowStatus } from "../durable/types.js";

export interface DurableTerminalFinalizeInput {
  readonly runId: string;
  readonly runSnapshot: RunSnapshot;
  readonly isRoot: boolean;
  readonly durableBackend: DurableWorkflowBackend;
  readonly persistence?: WorkflowPersistencePort;
}

/**
 * Map and persist the terminal durable status for a root workflow run when the
 * run did not complete normally. Safe to call from a `finally` block: flush
 * failures are logged but never rethrown so they do not mask the original
 * failure/exit status.
 */
export async function finalizeDurableTerminalStatus(input: DurableTerminalFinalizeInput): Promise<void> {
  if (!input.isRoot) return;
  const status = input.runSnapshot.status;
  const isExitTerminal = input.runSnapshot.exited === true && status !== "running";
  if (status !== "failed" && status !== "killed" && !isExitTerminal) return;

  const durableStatus = toDurableStatus(status);
  if (durableStatus !== undefined) {
    input.durableBackend.setWorkflowStatus(input.runId, durableStatus, undefined, input.runSnapshot.resumable);
  }
  try {
    await input.durableBackend.flush?.();
  } catch (flushErr) {
    const msg = flushErr instanceof Error ? flushErr.message : String(flushErr);
    console.warn(`atomic-workflows: durable terminal status flush failed: ${msg}`);
  }
  if (input.persistence !== undefined && input.durableBackend.persistent) {
    const cacheEntry = input.durableBackend.toCacheEntry(input.runId);
    if (cacheEntry) persistDurableCacheEntry(input.persistence, cacheEntry);
  }
}

function toDurableStatus(status: RunSnapshot["status"]): DurableWorkflowStatus | undefined {
  switch (status) {
    case "completed":
    case "skipped":
      return "completed";
    case "cancelled":
    case "killed":
      return "cancelled";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return undefined;
  }
}
