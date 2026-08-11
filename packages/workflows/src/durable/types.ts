/**
 * Durable workflow state types for DBOS-backed cross-session resumability.
 *
 * These types describe the checkpoint records that the durable backend stores
 * for each `ctx.*` operation (tool, ui, stage). Only `ctx.*` blocks produce
 * durable checkpoints — anything outside `ctx.*` is never saved, matching the
 * issue's "checkpoints are effectively only `ctx.*` blocks" requirement.
 *
 * cross-ref: issue #1498
 */

import type {
	WorkflowActor,
	WorkflowFailureCode,
	WorkflowFailureDisposition,
	WorkflowFailureKind,
	WorkflowFailureRecoverability,
} from "../shared/store-types.js";
import type { WorkflowModelAttempt, WorkflowSerializableValue } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Top-level workflow identity
// ---------------------------------------------------------------------------

/**
 * A resumable top-level workflow. The `workflowId` is the public resume handle
 * (a run id); internal nested workflow ids are abstracted away from users.
 */
export interface DurableWorkflowHandle {
	/** Top-level workflow id used by `/workflow resume <id>`. */
	readonly workflowId: string;
	/** Workflow definition name. */
	readonly name: string;
	/** Workflow inputs (JSON-serializable). */
	readonly inputs: Readonly<WorkflowSerializableObject>;
	/** Creation timestamp (ms since epoch). */
	readonly createdAt: number;
	/** Last update timestamp (ms since epoch). */
	readonly updatedAt: number;
	/** Current durable status. */
	readonly status: DurableWorkflowStatus;
	/** Original invocation cwd used to resolve repo-relative workflow defaults on resume. */
	readonly invocationCwd?: string;
	/** Who launched this workflow, when the launcher was attributable. */
	readonly origin?: WorkflowActor;
	/** Resolved workflow cwd when an input-bound reusable worktree was set up. */
	readonly workflowCwd?: string;
	/** Invoking repository root used for reusable worktree validation. */
	readonly repositoryRoot?: string;
	/** Resolved reusable git worktree root, when setup happened at workflow start. */
	readonly gitWorktreeRoot?: string;
	/** Session file path that caches this workflow's durable metadata. */
	readonly sessionFile?: string;
	/** Number of completed durable checkpoints. */
	readonly completedCheckpoints: number;
	/** Number of pending (unanswered) UI prompts. */
	readonly pendingPrompts: number;
	/** Optional human-readable label. */
	readonly label?: string;
	/** Root workflow id. Omitted or equal to workflowId means top-level. */
	readonly rootWorkflowId?: string;
	/** Explicit resumability flag for failed/blocked runs. */
	readonly resumable?: boolean;
	/** True when the terminal status came from an author-selected ctx.exit(). */
	readonly exited?: boolean;
	/** Author-supplied reason from ctx.exit(), when present. */
	readonly exitReason?: string;
	readonly error?: string;
	readonly failureKind?: WorkflowFailureKind;
	readonly failureCode?: WorkflowFailureCode;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly failureDisposition?: WorkflowFailureDisposition;
	readonly failedToolNodeId?: string;
	/** Executor id of the Atomic process that last wrote this workflow's metadata. */
	readonly ownerExecutorId?: string;
}

export type DurableWorkflowStatus = "running" | "paused" | "completed" | "failed" | "cancelled" | "blocked";

// ---------------------------------------------------------------------------
// Checkpoint records
// ---------------------------------------------------------------------------

/**
 * Discriminated union of durable checkpoint records.
 * Each `ctx.*` operation that should survive cross-session resume writes one
 * of these. The backend keys checkpoints by (workflowId, kind, checkpointId).
 */
export type DurableCheckpoint = DurableToolCheckpoint | DurableUiCheckpoint | DurableStageCheckpoint;

export type DurableCheckpointKind = "tool" | "ui" | "stage";

export const DURABLE_TOOL_TOPOLOGY_VERSION = 1 as const;

export interface DurableToolTopology {
	readonly version: typeof DURABLE_TOOL_TOPOLOGY_VERSION;
	readonly nodeId: string;
	readonly ordinal: number;
	readonly order: number;
	readonly parentIds: readonly string[];
	readonly startedAt?: number;
	/** Original terminal timestamp; replay metadata may be written later. */
	readonly endedAt?: number;
	readonly run?: DurableStageRunTopology;
}

/** A `ctx.tool(...)` result cached durably. */
export interface DurableToolCheckpoint {
	readonly kind: "tool";
	readonly workflowId: string;
	/** Unique checkpoint id within the workflow (monotonic). */
	readonly checkpointId: string;
	/** Tool name for display/debugging. */
	readonly name: string;
	/** Deterministic hash of the tool arguments for idempotency. */
	readonly argsHash: string;
	/** Cached tool output (JSON-serializable). */
	readonly output: WorkflowSerializableValue;
	/** Explicit return-mode result kind; absent for legacy/default successful tools. */
	readonly outcomeKind?: "return_success" | "return_failure";
	/**
	 * Inspection-only message for a non-replayable tool failure or cancellation;
	 * never used as a replay cache hit, so the call runs again on resume.
	 */
	readonly throwingFailureError?: string;
	readonly completedAt: number;
	/** Additive graph topology; omitted by pre-#1991 checkpoints. */
	readonly topology?: DurableToolTopology;
}

/** A `ctx.ui.*` user response cached durably. */
export interface DurableUiCheckpoint {
	readonly kind: "ui";
	readonly workflowId: string;
	readonly checkpointId: string;
	/** UI prompt kind (input/confirm/select/editor/custom). */
	readonly promptKind: UiPromptKind;
	/** Prompt message shown to the user. */
	readonly message: string;
	/** Deterministic hash of the prompt identity for replay matching. */
	readonly promptHash: string;
	/** User response (JSON-serializable). */
	readonly response: WorkflowSerializableValue;
	readonly completedAt: number;
}

export const DURABLE_STAGE_TOPOLOGY_VERSION = 1 as const;

export const DURABLE_BOUNDARY_TOPOLOGY_VERSION = 1 as const;

export type DurableStageLifecycleStatus =
	| "pending"
	| "running"
	| "awaiting_input"
	| "paused"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped";

export interface DurableBoundaryChildTopology {
	readonly runId: string;
	readonly runName: string;
	readonly parentRunId: string;
	readonly parentStageId: string;
	readonly rootRunId: string;
}

interface DurableWorkflowBoundaryIdentity {
	readonly version: typeof DURABLE_BOUNDARY_TOPOLOGY_VERSION;
	readonly replayScope: string;
	readonly alias: string;
	readonly workflow: string;
	/** Definition + exact validated inputs; absent only on compatible completed legacy records. */
	readonly invocationFingerprint?: string;
	readonly child: DurableBoundaryChildTopology;
}

/** Additive identity record written before a nested workflow can execute. */
export type DurableWorkflowBoundaryTopology = DurableWorkflowBoundaryIdentity &
	(
		| { readonly event: "start"; readonly status: "running" }
		| {
				readonly event: "terminal";
				readonly status: Extract<DurableStageLifecycleStatus, "completed" | "failed" | "skipped">;
		  }
	);

/** Durable ownership metadata needed to rebuild nested workflow runs. */
export interface DurableStageRunTopology {
	readonly runId: string;
	readonly runName: string;
	readonly parentRunId?: string;
	readonly parentStageId?: string;
	readonly rootRunId?: string;
}

/** Versioned source-stage lineage used to reconstruct completed DAGs after restart. */
export interface DurableStageTopology {
	readonly version: typeof DURABLE_STAGE_TOPOLOGY_VERSION;
	readonly stageId: string;
	readonly parentIds: readonly string[];
	/** Zero-based source/spawn order within the owning run. */
	readonly sourceOrder?: number;
	/** Distinguishes one durable prompt-node occurrence from its logical continuation replay key. */
	readonly occurrenceKey?: string;
	/** Actual stage lifecycle state represented by this checkpoint. */
	readonly status?: DurableStageLifecycleStatus;
	/** Shared admission order with durable tool nodes. */
	readonly order?: number;
	/** Owning run and boundary linkage for nested workflow graph reconstruction. */
	readonly run?: DurableStageRunTopology;
	/** Present only for durable nested-workflow boundary records. */
	readonly boundary?: DurableWorkflowBoundaryTopology;
}

/** A `ctx.stage(...)` / `ctx.task(...)` durable checkpoint or resumable session marker. */
export interface DurableStageCheckpoint {
	readonly kind: "stage";
	readonly workflowId: string;
	readonly checkpointId: string;
	/** Stage name for display. */
	readonly name: string;
	/** Stable replay key (matches existing continuation replay semantics). */
	readonly replayKey: string;
	/** Source stage identity and parents for fresh-process completed-run inspection. */
	readonly topology?: DurableStageTopology;
	/** Stage output text or structured result when the stage completed. */
	readonly output?: WorkflowSerializableValue;
	/** Resumable Atomic/Pi session metadata for in-progress LM stages. */
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly completedAt: number;
	/** Original stage start timestamp, when available. */
	readonly startedAt?: number;
	/** Original stage end timestamp, when available. */
	readonly endedAt?: number;
	/** Original stage duration, when available. */
	readonly durationMs?: number;
	/** Display/result text recorded for the completed stage. */
	readonly result?: string;
	/** Completed stage/task model metadata used to hydrate replayed snapshots. */
	readonly model?: string;
	readonly fastMode?: boolean;
	readonly attemptedModels?: readonly string[];
	readonly modelAttempts?: readonly WorkflowModelAttempt[];
}

export type UiPromptKind = "input" | "confirm" | "select" | "editor" | "custom";

// ---------------------------------------------------------------------------
// Serializable helpers
// ---------------------------------------------------------------------------

export type WorkflowSerializableObject = Readonly<Record<string, WorkflowSerializableValue>>;

// ---------------------------------------------------------------------------
// DBOS metadata and resume catalog
// ---------------------------------------------------------------------------

/** Current workflow metadata persisted in DBOS. */
export interface DurableWorkflowMetadata {
	readonly workflowId: string;
	readonly name: string;
	readonly inputs: WorkflowSerializableObject;
	readonly status: DurableWorkflowStatus;
	readonly completedCheckpoints: number;
	readonly pendingPrompts: number;
	readonly createdAt: number;
	readonly promptReservationEpoch: string;
	/** Executor id of the Atomic process that wrote this metadata generation. */
	readonly ownerExecutorId?: string;
	/** Unique winner token for a first-writer-wins status-transition generation. */
	readonly transitionClaimId?: string;
	readonly sessionFile?: string;
	readonly label?: string;
	readonly error?: string;
	readonly failureKind?: WorkflowFailureKind;
	readonly failureCode?: WorkflowFailureCode;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly failureDisposition?: WorkflowFailureDisposition;
	readonly failedToolNodeId?: string;
	readonly rootWorkflowId?: string;
	readonly resumable?: boolean;
	/** True when the terminal status came from an author-selected ctx.exit(). */
	readonly exited?: boolean;
	/** Author-supplied reason from ctx.exit(), when present. */
	readonly exitReason?: string;
	readonly invocationCwd?: string;
	readonly origin?: WorkflowActor;
	readonly workflowCwd?: string;
	readonly repositoryRoot?: string;
	readonly gitWorktreeRoot?: string;
	readonly updatedAt: number;
}

/** Resume catalog entry loaded directly from DBOS metadata. */
export interface ResumableWorkflowEntry {
	readonly workflowId: string;
	readonly name: string;
	readonly inputs?: WorkflowSerializableObject;
	readonly status: DurableWorkflowStatus;
	readonly completedCheckpoints: number;
	readonly pendingPrompts: number;
	readonly sessionFile?: string;
	readonly label?: string;
	readonly error?: string;
	readonly failureKind?: WorkflowFailureKind;
	readonly failureCode?: WorkflowFailureCode;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly failureDisposition?: WorkflowFailureDisposition;
	readonly failedToolNodeId?: string;
	readonly rootWorkflowId?: string;
	readonly resumable?: boolean;
	/** True when the terminal status came from an author-selected ctx.exit(). */
	readonly exited?: boolean;
	/** Author-supplied reason from ctx.exit(), when present. */
	readonly exitReason?: string;
	readonly invocationCwd?: string;
	readonly origin?: WorkflowActor;
	readonly workflowCwd?: string;
	readonly repositoryRoot?: string;
	readonly gitWorktreeRoot?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface DurableWorkflowFailureMetadata {
	readonly error?: string;
	/** True when the terminal status came from an author-selected ctx.exit(). */
	readonly exited?: boolean;
	/** Author-supplied reason from ctx.exit(), when present. */
	readonly exitReason?: string;
	readonly failureKind?: WorkflowFailureKind;
	readonly failureCode?: WorkflowFailureCode;
	readonly failureRecoverability?: WorkflowFailureRecoverability;
	readonly failureDisposition?: WorkflowFailureDisposition;
	readonly failedToolNodeId?: string;
}
