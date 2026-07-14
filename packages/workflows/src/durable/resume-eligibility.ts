import type { DurableWorkflowStatus } from "./types.js";

/** Metadata shared by durable handles and session-cache resume entries. */
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
