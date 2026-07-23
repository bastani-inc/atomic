import type { RunEndMetadata } from "../shared/store-public-types.js";
import type { WorkflowOutputValues } from "../shared/types.js";
import type { RunSnapshot } from "../shared/store-types.js";
import {
  actionableReturnedStatusText,
  isReturnedBlockedWorkflowStatus,
  isReturnedResumableBlockedWorkflowStatus,
  normalizeReturnedWorkflowStatus,
  structuredRecoverableWorkflowFailure,
} from "../shared/returned-run-status.js";

export interface ReturnedRunStatus {
  readonly status: "completed" | "failed" | "blocked";
  readonly error?: string;
  readonly metadata?: RunEndMetadata;
}

export function classifyReturnedRunStatus(result: WorkflowOutputValues | undefined, runSnapshot?: RunSnapshot): ReturnedRunStatus {
  const structuredFailure = runSnapshot !== undefined ? structuredRecoverableWorkflowFailure(runSnapshot) : undefined;
  if (structuredFailure !== undefined) {
    return {
      status: "blocked",
      error: structuredFailure.error,
      metadata: structuredFailure.metadata,
    };
  }
  const returnedStatus = normalizeReturnedWorkflowStatus(result?.["status"]);
  if (returnedStatus === undefined || returnedStatus === "completed" || returnedStatus === "complete") {
    return { status: "completed" };
  }

  const error = returnedStatusError(result, returnedStatus);
  if (returnedStatus === "failed") {
    return {
      status: "failed",
      error,
      metadata: returnedFailureMetadata(error),
    };
  }
  if (isReturnedBlockedWorkflowStatus(returnedStatus)) {
    const metadata = isReturnedResumableBlockedWorkflowStatus(returnedStatus)
      ? returnedRecoverableBlockedMetadata(error)
      : { resumable: false };
    return {
      status: "blocked",
      error,
      metadata,
    };
  }

  return { status: "completed" };
}

function returnedStatusError(result: WorkflowOutputValues | undefined, returnedStatus: string): string {
  return actionableReturnedStatusText(result) ?? `Workflow returned status ${JSON.stringify(returnedStatus)}.`;
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

function returnedRecoverableBlockedMetadata(error: string): RunEndMetadata {
  return {
    failureRecoverability: "recoverable",
    failureDisposition: "active_blocked",
    failureMessage: error,
    resumable: true,
  };
}
