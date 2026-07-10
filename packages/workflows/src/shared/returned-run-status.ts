import type { RunEndMetadata } from "./store-public-types.js";
import type { RunSnapshot, RunStatus, StageSnapshot, WorkflowFailureKind } from "./store-types.js";
import type { WorkflowOutputValues } from "./types.js";

const RETURNED_BLOCKED_STATUSES = new Set([
  "blocked",
  "needs_human",
  "incomplete",
  "auth_blocked",
  "active",
]);

export interface StructuredRecoverableWorkflowFailure {
  readonly error: string;
  readonly metadata: RunEndMetadata;
}

export function normalizeReturnedWorkflowStatus(status: unknown): string | undefined {
  if (typeof status !== "string") return undefined;
  const normalized = status.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

export function isReturnedBlockedWorkflowStatus(status: string): boolean {
  return RETURNED_BLOCKED_STATUSES.has(status);
}

export function isReturnedResumableBlockedWorkflowStatus(status: string): boolean {
  return status !== "blocked" && isReturnedBlockedWorkflowStatus(status);
}

export function actionableReturnedStatusText(result: WorkflowOutputValues | undefined): string | undefined {
  return stringResultField(result, "summary") ?? stringResultField(result, "remaining_work") ?? stringResultField(result, "result");
}

export function structuredRecoverableWorkflowFailure(
  run: Pick<RunSnapshot,
    | "error"
    | "failureKind"
    | "failureCode"
    | "failureRecoverability"
    | "failureDisposition"
    | "failureMessage"
    | "failedStageId"
    | "retryAfterMs"
    | "stages"
  >,
): StructuredRecoverableWorkflowFailure | undefined {
  const runFailure = structuredRecoverableFailureFromSnapshot(run);
  if (runFailure !== undefined) return runFailure;
  if (run.failedStageId === undefined) return undefined;

  const failedStage = run.stages.find((stage) => stage.id === run.failedStageId);
  return failedStage === undefined
    ? undefined
    : structuredRecoverableFailureFromSnapshot(failedStage, failedStage.id);
}

export function structuredRecoverableWorkflowFailureText(
  run: Pick<RunSnapshot,
    | "error"
    | "failureKind"
    | "failureCode"
    | "failureRecoverability"
    | "failureDisposition"
    | "failureMessage"
    | "failedStageId"
    | "retryAfterMs"
    | "stages"
  >,
): string | undefined {
  return structuredRecoverableWorkflowFailure(run)?.error;
}

export function effectiveRunStatus(run: RunSnapshot): RunStatus {
  if (run.status !== "completed") return run.status;
  if (structuredRecoverableWorkflowFailure(run) !== undefined) return "blocked";
  const returnedStatus = normalizeReturnedWorkflowStatus(run.result?.["status"]);
  if (returnedStatus === "failed") return "failed";
  if (returnedStatus !== undefined && isReturnedBlockedWorkflowStatus(returnedStatus)) return "blocked";
  return run.status;
}

function structuredRecoverableFailureFromSnapshot(
  snapshot: Pick<RunSnapshot | StageSnapshot, "error" | "failureKind" | "failureCode" | "failureRecoverability" | "failureDisposition" | "failureMessage" | "retryAfterMs">,
  failedStageId?: string,
): StructuredRecoverableWorkflowFailure | undefined {
  if (snapshot.failureDisposition !== "active_blocked") return undefined;
  if (snapshot.failureRecoverability !== "recoverable") return undefined;
  if (!isRecoverableProviderFailureKind(snapshot.failureKind)) return undefined;
  const error = snapshot.error ?? snapshot.failureMessage ?? "Workflow is blocked by a recoverable provider failure.";
  return {
    error,
    metadata: {
      failureKind: snapshot.failureKind,
      ...(snapshot.failureCode !== undefined ? { failureCode: snapshot.failureCode } : {}),
      failureRecoverability: snapshot.failureRecoverability,
      failureDisposition: snapshot.failureDisposition,
      failureMessage: snapshot.failureMessage ?? error,
      ...(failedStageId !== undefined ? { failedStageId } : {}),
      resumable: true,
      ...(snapshot.retryAfterMs !== undefined ? { retryAfterMs: snapshot.retryAfterMs } : {}),
    },
  };
}

function isRecoverableProviderFailureKind(kind: WorkflowFailureKind | undefined): kind is "auth" | "rate_limit" | "provider" {
  return kind === "auth" || kind === "rate_limit" || kind === "provider";
}



function stringResultField(result: WorkflowOutputValues | undefined, key: string): string | undefined {
  const value = result?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
