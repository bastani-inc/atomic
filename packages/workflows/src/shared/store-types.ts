/**
 * Types for live run/stage snapshots.
 * cross-ref: spec §5.5
 */

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "killed";
export type StageStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "paused"
  | "blocked"
  | "completed"
  | "failed";

/**
 * Human-in-the-loop prompt kind. Mirrors the four `WorkflowUIContext` methods.
 * cross-ref: src/shared/types.ts WorkflowUIContext
 */
export type PromptKind = "input" | "confirm" | "select" | "editor";

/**
 * A pending HIL prompt awaiting user response. Surfaced through the graph
 * viewer overlay for background runs so the main chat editor is never
 * blocked by a workflow.
 *
 * Resolver lives in `pendingPromptResolvers` (store-internal map) — only the
 * JSON-cloneable descriptor lives on the snapshot.
 */
export interface PendingPrompt {
  readonly id: string;
  readonly kind: PromptKind;
  readonly message: string;
  /** Choices for `kind: "select"`. */
  readonly choices?: readonly string[];
  /** Initial value for `kind: "input"` and `kind: "editor"`. */
  readonly initial?: string;
  /** Issue timestamp (ms since epoch). */
  readonly createdAt: number;
}

export interface ToolEvent {
  name: string;
  input?: Record<string, unknown>;
  output?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface StageNotice {
  readonly id: string;
  readonly ts: number;
  readonly kind: "model" | "thinking" | "compaction" | "tree" | "abort" | "mcp";
  readonly from?: string;
  readonly to: string;
  readonly meta?: string;
}

export interface StageSnapshot {
  readonly id: string;
  readonly name: string;
  status: StageStatus;
  readonly parentIds: readonly string[];
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  result?: string;
  error?: string;
  readonly toolEvents: ToolEvent[];
  /** True while an in-stage ask_user_question tool is waiting on the user. */
  awaitingInputSince?: number;
  blockedByStageId?: string;
  notices?: StageNotice[];
  /**
   * MCP server gating config stored at stage creation time.
   * Null allow/deny entries mean unrestricted for that dimension.
   * Absent when no mcp options were passed to ctx.stage().
   */
  mcpScope?: { allow: string[] | null; deny: string[] | null };
  /**
   * Pi/pi SDK session metadata, populated lazily once the stage
   * acquires an AgentSession. Carried on the serializable snapshot so
   * the attached chat surface can reopen completed sessions via
   * `SessionManager.open(sessionFile)` without keeping live handles in
   * the store.
   */
  sessionId?: string;
  sessionFile?: string;
  /** Effective model selected for this stage after fallback resolution. */
  model?: string;
  /** Ordered model ids attempted by fallback orchestration. */
  attemptedModels?: readonly string[];
  /** Per-model fallback attempt outcomes. */
  modelAttempts?: readonly import("./types.js").WorkflowModelAttempt[];
  /**
   * True while the stage is still part of the live workflow-control set.
   * Completion clears this even if an already-open chat pane keeps a detached
   * chat handle alive for post-stage conversation.
   */
  attachable?: boolean;
  /** True while a user pane is actively attached to this stage. */
  attached?: boolean;
  /** Milliseconds spent paused across completed pause intervals. */
  pausedDurationMs?: number;
  /** Timestamp set when a controlled pause begins; cleared on resume. */
  pausedAt?: number;
  /** Timestamp recorded on the most recent resume from a paused state. */
  resumedAt?: number;
}

export interface RunSnapshot {
  readonly id: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, unknown>>;
  status: RunStatus;
  readonly stages: StageSnapshot[];
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /** Milliseconds spent paused across completed pause intervals. */
  pausedDurationMs?: number;
  /** Timestamp set when a controlled pause begins; cleared on resume. */
  pausedAt?: number;
  /** Timestamp recorded on the most recent resume from a paused state. */
  resumedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
  /**
   * Pending human-in-the-loop prompt. Set when a background workflow calls
   * `ctx.ui.input/confirm/select/editor`; cleared when the user responds via
   * the graph viewer overlay. Foreground runs never set this (they route HIL
   * straight to pi.ui dialogs).
   */
  pendingPrompt?: PendingPrompt;
}

export interface StoreSnapshot {
  readonly runs: readonly RunSnapshot[];
  readonly notices: readonly WorkflowNotice[];
  readonly version: number;
}

/** Lightweight notice attached to a run or stage. */
export type NoticeLevel = "info" | "warning" | "error";

export interface WorkflowNotice {
  readonly id: string;
  readonly runId?: string;
  readonly stageId?: string;
  readonly level: NoticeLevel;
  message: string;
  readonly createdAt: number;
  readonly requiresAck?: boolean;
  /** Set once acknowledged. */
  ackedAt?: number;
}

/**
 * Adapter for displaying run progress / status in a UI layer.
 * Implemented by the TUI widget or a test spy; injected via RunOpts.overlay.
 */
export interface WorkflowOverlayAdapter {
  /** Show or update the overlay with the given notice. */
  show(notice: WorkflowNotice): void;
  /** Hide the overlay (called when the run completes or is cancelled). */
  hide(): void;
}
