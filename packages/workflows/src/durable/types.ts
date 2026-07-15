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

import type { WorkflowModelAttempt, WorkflowSerializableValue } from "../shared/types.js";
import type { DURABLE_FORMAT_VERSION } from "./format-version.js";

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
}

export type DurableWorkflowStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

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
  readonly completedAt: number;
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

/** Versioned source-stage lineage used to reconstruct completed DAGs after restart. */
export interface DurableStageTopology {
  readonly version: typeof DURABLE_STAGE_TOPOLOGY_VERSION;
  readonly stageId: string;
  readonly parentIds: readonly string[];
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
// Resume catalog entry (cached on session JSONL)
// ---------------------------------------------------------------------------

/**
 * Durable workflow metadata cached as a `workflow.durable.checkpoint` session
 * entry. This is the session-file cache described by the issue — it lets a new
 * session discover resumable workflows without scanning the full DBOS system
 * database. DBOS remains the checkpoint source of truth; this cache mirrors
 * the minimal top-level metadata needed for `/workflow resume` discovery.
 */
export interface DurableCheckpointEntry {
  /** Durable metadata schema version used to reject incompatible discovery rows. */
  readonly formatVersion: typeof DURABLE_FORMAT_VERSION;
  readonly type: "workflow.durable.checkpoint";
  readonly workflowId: string;
  readonly name: string;
  readonly inputs: WorkflowSerializableObject;
  readonly status: DurableWorkflowStatus;
  readonly completedCheckpoints: number;
  readonly pendingPrompts: number;
  /** DBOS prompt-ledger generation; omitted for pre-generation metadata. */
  readonly promptReservationEpoch?: string;
  readonly label?: string;
  readonly rootWorkflowId?: string;
  readonly resumable?: boolean;
  readonly invocationCwd?: string;
  readonly workflowCwd?: string;
  readonly repositoryRoot?: string;
  readonly gitWorktreeRoot?: string;
  readonly ts: number;
}

/**
 * Resume catalog entry for the cross-session `/workflow resume` selector.
 * Built from durable checkpoint entries found across session files.
 */
export interface ResumableWorkflowEntry {
  readonly workflowId: string;
  readonly name: string;
  readonly inputs?: WorkflowSerializableObject;
  readonly status: DurableWorkflowStatus;
  readonly completedCheckpoints: number;
  readonly pendingPrompts: number;
  readonly sessionFile?: string;
  readonly label?: string;
  readonly rootWorkflowId?: string;
  readonly resumable?: boolean;
  readonly invocationCwd?: string;
  readonly workflowCwd?: string;
  readonly repositoryRoot?: string;
  readonly gitWorktreeRoot?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
