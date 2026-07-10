import type { WorkflowSerializableValue } from "./types.js";

export interface ResumableWorkflowNotice {
  readonly workflowId: string;
  readonly name: string;
}

function recordOrUndefined(value: unknown): Record<string, WorkflowSerializableValue> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, WorkflowSerializableValue>
    : undefined;
}

/** Return the latest resumable durable workflow references cached in a session. */
export function findResumableWorkflowNotices(entries: readonly unknown[]): ResumableWorkflowNotice[] {
  const latestByWorkflow = new Map<string, Record<string, WorkflowSerializableValue>>();
  for (const value of entries) {
    const entry = recordOrUndefined(value);
    if (entry === undefined) continue;
    const payload = entry["type"] === "custom" && entry["customType"] === "workflow.durable.checkpoint"
      ? recordOrUndefined(entry["data"])
      : entry["type"] === "workflow.durable.checkpoint"
        ? recordOrUndefined(entry["payload"])
        : undefined;
    const workflowId = payload?.["workflowId"];
    if (typeof workflowId === "string" && payload !== undefined) latestByWorkflow.set(workflowId, payload);
  }

  const notices: ResumableWorkflowNotice[] = [];
  for (const payload of latestByWorkflow.values()) {
    const workflowId = payload["workflowId"];
    const name = payload["name"];
    const status = payload["status"];
    const resumable = payload["resumable"];
    const canResume = status === "running" || status === "paused" || status === "blocked"
      || (status === "failed" && resumable === true);
    if (typeof workflowId === "string" && typeof name === "string" && canResume && resumable !== false) {
      notices.push({ workflowId, name });
    }
  }
  return notices;
}
