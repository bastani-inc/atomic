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

import type { WorkflowSerializableValue } from "../shared/types.js";

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

/** A `ctx.stage(...)` / `ctx.task(...)` completion cached durably. */
export interface DurableStageCheckpoint {
  readonly kind: "stage";
  readonly workflowId: string;
  readonly checkpointId: string;
  /** Stage name for display. */
  readonly name: string;
  /** Stable replay key (matches existing continuation replay semantics). */
  readonly replayKey: string;
  /** Stage output text or structured result (JSON-serializable). */
  readonly output: WorkflowSerializableValue;
  readonly completedAt: number;
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
  readonly type: "workflow.durable.checkpoint";
  readonly workflowId: string;
  readonly name: string;
  readonly inputs: WorkflowSerializableObject;
  readonly status: DurableWorkflowStatus;
  readonly completedCheckpoints: number;
  readonly pendingPrompts: number;
  readonly label?: string;
  readonly rootWorkflowId?: string;
  readonly resumable?: boolean;
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
  readonly createdAt: number;
  readonly updatedAt: number;
}
