import type { RunSnapshot, RunStatus, WorkflowFailureRecoverability } from "../shared/store-types.js";
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

/** Live snapshot fields used by every workflow resume surface. */
export interface WorkflowRunResumeCandidate {
	readonly status: RunStatus;
	readonly endedAt?: number;
	readonly resumable?: boolean;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly exitReason?: string;
	/** True when a descendant stage is paused/blocked even if the root is still running. */
	readonly hasPausedState?: boolean;
	/** Explicitly false when durable state or referenced artifacts are missing. */
	readonly hasDurableCheckpoint?: boolean;
	readonly artifactsIntact?: boolean;
	/** True only for the engine-owned budget_exceeded blocked rail. */
	readonly budgetSystemOwnedStop?: boolean;
}

/** Derive the paused/blocked state used by every workflow resume surface. */
export function workflowRunHasPausedState(run: Pick<RunSnapshot, "status" | "exitReason" | "stages">): boolean {
	return (
		run.status === "paused" ||
		run.exitReason === "quit" ||
		run.stages.some((stage) => stage.status === "paused" || stage.status === "blocked")
	);
}

/**
 * Authoritative live-run resume rule shared by every workflow resume surface.
 * Missing durable state or artifacts is never a resume target even when stale
 * snapshot metadata still says resumable.
 */
export function isWorkflowRunResumable(candidate: WorkflowRunResumeCandidate): boolean {
	if (candidate.status === "killed" || candidate.hasDurableCheckpoint === false || candidate.artifactsIntact === false)
		return false;
	if (candidate.hasPausedState === true || candidate.status === "paused" || candidate.exitReason === "quit") {
		return candidate.resumable !== false;
	}
	return (
		(candidate.status === "failed" && candidate.endedAt !== undefined && candidate.resumable !== false) ||
		(candidate.resumable === true &&
			candidate.failureRecoverability === "recoverable" &&
			(candidate.endedAt === undefined ||
				candidate.status === "blocked" ||
				candidate.budgetSystemOwnedStop === true))
	);
}

/** Authoritative status/progress rules for durable workflow resume discovery. */
export function isDurableWorkflowResumable(candidate: DurableResumeCandidate): boolean {
	const isRoot = candidate.rootWorkflowId === undefined || candidate.rootWorkflowId === candidate.workflowId;
	if (!isRoot) return false;
	if (candidate.status === "failed" || candidate.status === "blocked") return candidate.resumable !== false;
	const hasResumeProgress = candidate.completedCheckpoints > 0 || candidate.pendingPrompts > 0;
	return (
		candidate.resumable !== false &&
		(candidate.status === "running" || candidate.status === "paused") &&
		hasResumeProgress
	);
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
	readonly ownerLiveness?: "alive" | "dead" | "unknown";
}

/** Whether a running workflow appears live in a DIFFERENT Atomic process. */
export function isForeignLiveWorkflow(
	candidate: ForeignLivenessCandidate,
	localExecutorId: string,
	now: number = Date.now(),
): boolean {
	if (candidate.status !== "running") return false;
	if (candidate.ownerExecutorId === undefined || candidate.ownerExecutorId === localExecutorId) return false;
	return candidate.ownerLiveness === "alive" || now - candidate.updatedAt < FOREIGN_LIVE_WORKFLOW_WINDOW_MS;
}

/**
 * Whether a running workflow appears genuinely live ANYWHERE (any owner).
 * Live-running workflows are never resume targets: offering them would allow
 * double-dispatch across sessions. Only stale-heartbeat (crashed) running
 * workflows surface, presented as crashed rather than running.
 */
export function isLiveRunningWorkflow(candidate: ForeignLivenessCandidate, now: number = Date.now()): boolean {
	return (
		candidate.status === "running" &&
		(candidate.ownerLiveness === "alive" || now - candidate.updatedAt < FOREIGN_LIVE_WORKFLOW_WINDOW_MS)
	);
}
