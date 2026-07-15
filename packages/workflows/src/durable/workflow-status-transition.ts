import type { DurableWorkflowHandle, DurableWorkflowStatus } from "./types.js";
import type { DurableWorkflowBackend } from "./backend.js";

/** Read one loadable handle without combining objects from different generations. */
export function getLoadableDurableWorkflow(
  backend: DurableWorkflowBackend,
  workflowId: string,
): DurableWorkflowHandle | undefined {
  if (backend.getLoadableWorkflow !== undefined) return backend.getLoadableWorkflow(workflowId);
  return backend.isWorkflowLoadable(workflowId) ? backend.getWorkflow(workflowId) : undefined;
}

/** Terminal durable generations cannot be reopened by stale nonterminal writers. */
export function isAbsorbingDurableStatus(status: DurableWorkflowStatus, resumable?: boolean): boolean {
  return status === "completed" || status === "cancelled"
    || ((status === "failed" || status === "blocked") && resumable === false);
}

/** Compatibility wrapper for conditional status transitions on custom backends. */
export async function transitionDurableWorkflowStatus(
  backend: DurableWorkflowBackend,
  workflowId: string,
  expectedStatuses: readonly DurableWorkflowStatus[],
  status: DurableWorkflowStatus,
  pendingPrompts?: number,
  resumable?: boolean,
): Promise<boolean> {
  if (backend.transitionWorkflowStatus !== undefined) {
    return await backend.transitionWorkflowStatus(
      workflowId, expectedStatuses, status, pendingPrompts, resumable,
    );
  }
  // A read followed by an unconditional set is not an atomic transition.
  // Legacy custom backends must opt in rather than receiving a false guarantee.
  return false;
}
