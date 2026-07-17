import type { DurableWorkflowStatus } from "./types.js";

/** Metadata required to classify a current DBOS workflow as resumable. */
export interface DurableResumeCandidate {
  readonly workflowId: string;
  readonly status: DurableWorkflowStatus;
  readonly completedCheckpoints: number;
  readonly pendingPrompts: number;
  readonly rootWorkflowId?: string;
  readonly resumable?: boolean;
}

/** Authoritative status/progress rules for durable workflow resume discovery. */
export function isDurableWorkflowResumable(candidate: DurableResumeCandidate): boolean {
  const isRoot = candidate.rootWorkflowId === undefined || candidate.rootWorkflowId === candidate.workflowId;
  if (!isRoot) return false;
  if (candidate.status === "failed" || candidate.status === "blocked") return candidate.resumable !== false;
  const hasResumeProgress = candidate.completedCheckpoints > 0 || candidate.pendingPrompts > 0;
  return (candidate.status === "running" || candidate.status === "paused") && hasResumeProgress;
}

/**
 * Liveness window for a `running` workflow owned by another Atomic process.
 * Active LM stages refresh durable timing metadata at least every ~30s, so a
 * running handle whose metadata is fresher than this window is treated as
 * genuinely executing in that other session rather than crashed.
 */
export const FOREIGN_LIVE_WORKFLOW_WINDOW_MS = 120_000;

export interface ForeignLivenessCandidate {
  readonly status: DurableWorkflowStatus;
  readonly updatedAt: number;
  readonly ownerExecutorId?: string;
}

/** Whether a running workflow appears live in a DIFFERENT Atomic process. */
export function isForeignLiveWorkflow(
  candidate: ForeignLivenessCandidate,
  localExecutorId: string,
  now: number = Date.now(),
): boolean {
  if (candidate.status !== "running") return false;
  if (candidate.ownerExecutorId === undefined || candidate.ownerExecutorId === localExecutorId) return false;
  return now - candidate.updatedAt < FOREIGN_LIVE_WORKFLOW_WINDOW_MS;
}
