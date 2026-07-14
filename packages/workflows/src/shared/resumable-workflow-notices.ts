import type { WorkflowSerializableValue } from "./types.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
import type { ResumableWorkflowEntry } from "../durable/types.js";

export interface ResumableWorkflowNotice {
  readonly workflowId: string;
  readonly name: string;
}

function recordOrUndefined(value: unknown): Record<string, WorkflowSerializableValue> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, WorkflowSerializableValue>
    : undefined;
}

/** Return authoritative resumable workflow references cached in a session. */
export function findResumableWorkflowNotices(
  entries: readonly unknown[],
  authoritativeCatalog: readonly ResumableWorkflowEntry[],
): ResumableWorkflowNotice[] {
  const authoritativeById = new Map(authoritativeCatalog.map((entry) => [entry.workflowId, entry]));
  const sessionWorkflowIds = new Set<string>();
  for (const value of entries) {
    const entry = recordOrUndefined(value);
    if (entry === undefined) continue;
    const payload = entry["type"] === "custom" && entry["customType"] === "workflow.durable.checkpoint"
      ? recordOrUndefined(entry["data"])
      : entry["type"] === "workflow.durable.checkpoint"
        ? recordOrUndefined(entry["payload"]) ?? entry
        : undefined;
    const workflowId = payload?.["workflowId"];
    if (typeof workflowId === "string") sessionWorkflowIds.add(workflowId);
  }

  const notices: ResumableWorkflowNotice[] = [];
  for (const workflowId of sessionWorkflowIds) {
    const authoritative = authoritativeById.get(workflowId);
    if (authoritative !== undefined && isDurableWorkflowResumable(authoritative)) {
      notices.push({ workflowId, name: authoritative.name });
    }
  }
  return notices;
}
