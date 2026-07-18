import type { DurableWorkflowBackend } from "./backend.js";

export type DurableWorkflowDeleteOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly message: string };

/**
 * `/resume` parity keeps every eligible run regardless of age/count and only
 * removes history after an explicit confirmed action. This helper is the
 * workflow-aware deletion gate used after selector confirmation.
 */
export async function deleteDurableWorkflowIfSafe(
  backend: DurableWorkflowBackend,
  workflowId: string,
  isInFlight: (workflowId: string) => boolean,
): Promise<DurableWorkflowDeleteOutcome> {
  if (isInFlight(workflowId)) {
    return { ok: false, message: "Cannot delete an in-flight workflow run." };
  }
  try {
    const handle = backend.getLoadableWorkflow(workflowId);
    if (handle === undefined) {
      return { ok: false, message: "Workflow durable state is stale or no longer available." };
    }
    if (handle.status === "running") {
      return { ok: false, message: "Cannot delete a workflow marked running; it may be active in another process." };
    }
    const result = await backend.deleteWorkflowIfInactive(workflowId);
    if (!result.ok) {
      return {
        ok: false,
        message: result.reason === "running"
          ? "Cannot delete a workflow that became active while deletion was pending."
          : "Workflow durable state is stale or no longer available.",
      };
    }
    return { ok: true, message: "Workflow durable history deleted; retained session transcripts were not removed." };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Failed to delete workflow durable history: ${detail}` };
  }
}
