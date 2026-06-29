import type { WorkflowOutputValues } from "../shared/types.js";

export interface ReturnedRunStatus {
  readonly status: "completed" | "failed" | "blocked";
  readonly error?: string;
}

export function classifyReturnedRunStatus(result: WorkflowOutputValues | undefined): ReturnedRunStatus {
  const returnedStatus = result?.["status"];
  if (returnedStatus !== "failed" && returnedStatus !== "blocked") {
    return { status: "completed" };
  }

  const summary = result?.["summary"];
  const error = typeof summary === "string" && summary.trim().length > 0
    ? summary.trim()
    : `Workflow returned status ${JSON.stringify(returnedStatus)}.`;
  return { status: returnedStatus, error };
}
