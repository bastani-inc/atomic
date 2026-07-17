import type { DurableWorkflowBackend } from "./backend.js";
import type { ResumableWorkflowEntry } from "./types.js";

/** List resumable workflows directly from the ready backend. */
export function listResumableFromBackend(backend: DurableWorkflowBackend): readonly ResumableWorkflowEntry[] {
  return backend.listResumableWorkflows();
}

export function formatResumableWorkflowList(entries: readonly ResumableWorkflowEntry[]): string {
  if (entries.length === 0) return "No resumable or completed workflows found.";
  const hasCompleted = entries.some((entry) => entry.status === "completed");
  const lines = entries.map((entry, index) => {
    const id = entry.workflowId.slice(0, 8);
    const status = entry.status === "completed" ? "✓ completed" : entry.status.padEnd(8);
    const checkpoints = `${entry.completedCheckpoints} checkpoint${entry.completedCheckpoints === 1 ? "" : "s"}`;
    const label = entry.label ? ` "${entry.label}"` : "";
    return `  ${index + 1}. ${id}  ${status}  ${entry.name}${label}  (${checkpoints})`;
  });
  return `${hasCompleted ? "Workflow resume targets" : "Resumable workflows"}:\n${lines.join("\n")}`;
}
