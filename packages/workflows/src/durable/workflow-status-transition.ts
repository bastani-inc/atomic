import type { DurableWorkflowHandle, DurableWorkflowStatus } from "./types.js";
import type { DurableWorkflowBackend } from "./backend.js";

/** Read one loadable handle without combining objects from different generations. */
export function getLoadableDurableWorkflow(
  backend: DurableWorkflowBackend,
  workflowId: string,
): DurableWorkflowHandle | undefined {
  return backend.getLoadableWorkflow(workflowId);
}

/** Terminal durable generations cannot be reopened by stale nonterminal writers. */
export function isAbsorbingDurableStatus(status: DurableWorkflowStatus, resumable?: boolean): boolean {
  return status === "completed" || status === "cancelled"
    || ((status === "failed" || status === "blocked") && resumable === false);
}

/** Perform a required conditional status transition. */
export async function transitionDurableWorkflowStatus(
  backend: DurableWorkflowBackend,
  workflowId: string,
  expectedStatuses: readonly DurableWorkflowStatus[],
  status: DurableWorkflowStatus,
  pendingPrompts?: number,
  resumable?: boolean,
): Promise<boolean> {
  return await backend.transitionWorkflowStatus(
    workflowId, expectedStatuses, status, pendingPrompts, resumable,
  );
}
