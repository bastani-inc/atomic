import type { RunEndMetadata } from "../shared/store-public-types.js";
import type { WorkflowOutputValues } from "../shared/types.js";

export interface ReturnedRunStatus {
  readonly status: "completed" | "failed" | "blocked";
  readonly error?: string;
  readonly metadata?: RunEndMetadata;
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
  return {
    status: returnedStatus,
    error,
    metadata: returnedStatus === "failed"
      ? returnedFailureMetadata(error)
      : returnedBlockedMetadata(),
  };
}

function returnedFailureMetadata(error: string): RunEndMetadata {
  return {
    failureKind: "unknown",
    failureRecoverability: "non_recoverable",
    failureDisposition: "terminal_failed",
    failureMessage: error,
    resumable: false,
  };
}

function returnedBlockedMetadata(): RunEndMetadata {
  return { resumable: false };
}
