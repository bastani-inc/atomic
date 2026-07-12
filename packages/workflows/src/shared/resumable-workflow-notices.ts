import type { WorkflowSerializableValue } from "./types.js";
import { isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
import type { DurableWorkflowStatus } from "../durable/types.js";

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
  authoritativeCatalog: readonly { readonly workflowId: string }[],
): ResumableWorkflowNotice[] {
  const authoritativeIds = new Set(authoritativeCatalog.map((entry) => entry.workflowId));
  const latestByWorkflow = new Map<string, Record<string, WorkflowSerializableValue>>();
  for (const value of entries) {
    const entry = recordOrUndefined(value);
    if (entry === undefined) continue;
    const payload = entry["type"] === "custom" && entry["customType"] === "workflow.durable.checkpoint"
      ? recordOrUndefined(entry["data"])
      : entry["type"] === "workflow.durable.checkpoint"
        ? recordOrUndefined(entry["payload"]) ?? entry
        : undefined;
    const workflowId = payload?.["workflowId"];
    if (typeof workflowId === "string" && payload !== undefined) latestByWorkflow.set(workflowId, payload);
  }

  const notices: ResumableWorkflowNotice[] = [];
  for (const payload of latestByWorkflow.values()) {
    const workflowId = payload["workflowId"];
    const name = payload["name"];
    const status = payload["status"];
    if (
      typeof workflowId !== "string" ||
      typeof name !== "string" ||
      typeof status !== "string" ||
      !authoritativeIds.has(workflowId)
    ) continue;
    const resumable = payload["resumable"];
    const rootWorkflowId = payload["rootWorkflowId"];
    const candidate = {
      workflowId,
      status: status as DurableWorkflowStatus,
      completedCheckpoints: typeof payload["completedCheckpoints"] === "number" ? payload["completedCheckpoints"] : 0,
      pendingPrompts: typeof payload["pendingPrompts"] === "number" ? payload["pendingPrompts"] : 0,
      ...(typeof rootWorkflowId === "string" ? { rootWorkflowId } : {}),
      ...(typeof resumable === "boolean" ? { resumable } : {}),
    };
    if (isDurableWorkflowResumable(candidate)) {
      notices.push({ workflowId, name });
    }
  }
  return notices;
}
