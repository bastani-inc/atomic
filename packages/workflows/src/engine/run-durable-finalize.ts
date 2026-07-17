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
import type { DurableWorkflowBackend } from "../durable/backend.js";
import type { DurableWorkflowStatus } from "../durable/types.js";

export interface DurableTerminalFinalizeInput {
  readonly runId: string;
  readonly runSnapshot: RunSnapshot;
  readonly isRoot: boolean;
  readonly durableBackend: DurableWorkflowBackend;
}

/** Persist the terminal durable status and surface DBOS write failures. */
export async function finalizeDurableTerminalStatus(input: DurableTerminalFinalizeInput): Promise<void> {
  if (!input.isRoot) return;
  const status = input.runSnapshot.status;
  const isExitTerminal = input.runSnapshot.exited === true && status !== "running";
  const isReturnedBlockedTerminal = status === "blocked" && input.runSnapshot.endedAt !== undefined;
  if (status !== "failed" && status !== "killed" && !isExitTerminal && !isReturnedBlockedTerminal) return;

  const durableStatus = toDurableStatus(status);
  if (durableStatus !== undefined) {
    input.durableBackend.setWorkflowStatus(input.runId, durableStatus, undefined, input.runSnapshot.resumable);
  }
  await input.durableBackend.flush();
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
