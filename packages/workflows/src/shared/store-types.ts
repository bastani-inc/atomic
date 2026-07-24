/**
 * Types for live run/stage snapshots.
 * cross-ref: spec §5.5
 */

import type { WorkflowExitStatus, WorkflowInputValues, WorkflowOutputValues } from "./types.js";

export type RunStatus = "pending" | "running" | "paused" | WorkflowExitStatus | "failed" | "killed";
export type StageStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "paused"
  | "blocked"
  | "completed"
  | "failed"
  | "skipped";

export type ToolNodeStatus = "pending" | "running" | "completed" | "failed" | "cached" | "cancelled";

/** First-class, durable graph node created for each ctx.tool invocation. */
export interface ToolNodeSnapshot {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  readonly argsHash: string;
  readonly ordinal: number;
  readonly parentIds: readonly string[];
  status: ToolNodeStatus;
  /** Set when a legacy checkpoint lacks persisted topology. */
  topologyState?: "unavailable";
  /** True when the callback was skipped in favor of a durable checkpoint. */
  replayed?: boolean;
  /** Shared admission order with stages in this run. */
  executionOrder?: number;
  startedAt?: number;
  endedAt?: number;
  resultSummary?: string;
  error?: string;
  readonly attachable: false;
}

export type WorkflowFailureKind = "auth" | "rate_limit" | "provider" | "cancelled" | "unknown";
export type WorkflowFailureRecoverability = "recoverable" | "non_recoverable" | "unknown";
export type WorkflowFailureDisposition = "active_blocked" | "terminal_killed" | "terminal_failed";
export type WorkflowFailureCode =
  | "login_required"
  | "missing_api_key"
  | "invalid_api_key"
  | "forbidden_config"
  | "unknown_model"
  | "rate_limited"
  | "quota_limited"
  | "provider_unavailable"
  | "cancelled"
  | "unknown";

/**
 * Human-in-the-loop prompt kind. Mirrors the `WorkflowUIContext` methods.
 * cross-ref: src/shared/types.ts WorkflowUIContext
 */
export type PromptKind = "input" | "confirm" | "select" | "editor" | "custom";

export type CustomPromptIdentitySource = "caller" | "factory" | "callsite";

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
  /** Hash of caller-supplied or derived replay identity for `kind: "custom"`. */
  readonly customIdentityHash?: string;
  /** Explains how a custom prompt replay identity was derived without storing the raw identity. */
  readonly customIdentitySource?: CustomPromptIdentitySource;
  /** Issue timestamp (ms since epoch). */
  readonly createdAt: number;
}

/** Discriminates the brokered structured-prompt source. */
export type StageInputKind = "ask_user_question" | "readiness_gate";

/** One selectable option in a {@link StageInputQuestion}. */
export interface StageInputOption {
  readonly label: string;
  readonly description?: string;
}

/** One question in a {@link StageInputRequest}. */
export interface StageInputQuestion {
  readonly question: string;
  readonly header?: string;
  readonly multiSelect?: boolean;
  readonly options: readonly StageInputOption[];
}

/**
 * Serializable descriptor of an in-stage `ask_user_question` (or readiness
 * gate) prompt brokered through `StageUiBroker`. Unlike {@link PendingPrompt}
 * (the simple input/confirm/select/editor HIL model), this mirrors the richer
 * structured ask_user_question shape so `workflow send` and status inspection
 * can see the questions/options and answer the prompt without the TUI.
 *
 * Resolution lives in `StageUiBroker` (the awaiting `ctx.ui.custom` promise);
 * only this JSON-cloneable descriptor lives on the snapshot.
 */
export interface StageInputRequest {
  readonly id: string;
  readonly kind: StageInputKind;
  readonly questions: readonly StageInputQuestion[];
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

export interface WorkflowChildRunRef {
  readonly alias: string;
  readonly workflow: string;
  readonly runId: string;
}

export interface WorkflowChildReplaySnapshot {
  readonly alias: string;
  readonly workflow: string;
  readonly runId: string;
  readonly status: WorkflowExitStatus;
  /** True when the child reached this terminal status through ctx.exit(). */
  readonly exited?: boolean;
  readonly outputs: WorkflowOutputValues;
  readonly exitReason?: string;
}

export interface StageSnapshot {
  readonly id: string;
  readonly name: string;
  status: StageStatus;
  /**
   * Parent stage ids. Treat as immutable from consumer code; the executor may
   * replace the frozen array before a stage starts when late topology inference
   * refreshes parents, so do not cache this reference across store updates.
   */
  parentIds: readonly string[];
  /** Shared admission order with tool nodes in this run. */
  executionOrder?: number;
  /** View-only graph discriminator; authored stages omit this or use "stage". */
  nodeKind?: "stage" | "tool";
  /** Original tool state when a tool node is projected into stage-compatible graph rendering. */
  toolStatus?: ToolNodeStatus;
  /** Set when durable inspection cannot safely determine the original stage lineage. */
  topologyState?: "unavailable";
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  result?: string;
  error?: string;
  /** Structured workflow failure category for failed stages. */
  failureKind?: WorkflowFailureKind;
  /** Specific additive workflow failure code within `failureKind`. */
  failureCode?: WorkflowFailureCode;
  /** Whether retry/resume can recover this failed stage without a workflow rerun. */
  failureRecoverability?: WorkflowFailureRecoverability;
  /** Executor lifecycle disposition chosen for the failed stage. */
  failureDisposition?: WorkflowFailureDisposition;
  /** Optional provider retry hint in milliseconds. Informational; blocked stages resume only via explicit user action. */
  retryAfterMs?: number;
  /** Original unsanitized error text when different from `error`. */
  failureMessage?: string;
  /** Reason for stages skipped by fail-fast/cascade handling. */
  skippedReason?: string;
  /** Stable continuation replay identity, separate from display name. */
  replayKey?: string;
  /** Snapshot-safe prompt answer availability marker; never contains the raw answer. */
  promptAnswerState?: "available" | "unavailable" | "ambiguous";
  /** Snapshot-safe descriptor of the prompt UI shown by this stage; never contains the raw answer. */
  promptFootprint?: PendingPrompt;
  /** Source stage id when this stage was replayed during failed-run continuation. */
  replayedFromStageId?: string;
  /** True when provider work was skipped by continuation replay. */
  replayed?: boolean;
  /** Live child workflow run metadata used to expand nested workflow graphs while the child is running. */
  workflowChildRun?: WorkflowChildRunRef;
  /** Snapshot-safe child workflow result metadata for continuation replay of import boundaries. */
  workflowChild?: WorkflowChildReplaySnapshot;
  readonly toolEvents: ToolEvent[];
  /** True while an in-stage ask_user_question tool is waiting on the user. */
  awaitingInputSince?: number;
  /** Pending human-in-the-loop prompt owned by this workflow stage/node. */
  pendingPrompt?: PendingPrompt;
  /**
   * Structured descriptor of a brokered ask_user_question / readiness-gate
   * prompt awaiting an answer. Set while the stage's `ctx.ui.custom` promise is
   * pending; resolution lives in `StageUiBroker`. Lets `workflow send` answer
   * the prompt headlessly. Distinct from {@link pendingPrompt}, which models
   * the simpler input/confirm/select/editor HIL prompts.
   */
  inputRequest?: StageInputRequest;
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
  /** Effective model id selected for this stage after fallback resolution. */
  model?: string;
  /** True when Codex fast mode applied to this workflow stage. */
  fastMode?: boolean;
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
  readonly inputs: Readonly<WorkflowInputValues>;
  status: RunStatus;
  readonly stages: StageSnapshot[];
  /** Durable ctx.tool execution nodes. Optional only for legacy/restored snapshots. */
  readonly toolNodes?: ToolNodeSnapshot[];
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  /**
   * Elapsed milliseconds inherited from prior sessions of this run. Seeded on
   * durable/continuation resume so `elapsedRunMs` reports prior + current
   * elapsed instead of restarting the total workflow duration at zero.
   */
  accumulatedDurationMs?: number;
  /** Milliseconds spent paused across completed pause intervals. */
  pausedDurationMs?: number;
  /** Timestamp set when a controlled pause begins; cleared on resume. */
  pausedAt?: number;
  /** Timestamp recorded on the most recent resume from a paused state. */
  resumedAt?: number;
  result?: WorkflowOutputValues;
  error?: string;
  /** True when the run reached its terminal status through ctx.exit(). */
  exited?: boolean;
  /** Optional author-supplied reason from ctx.exit(). */
  exitReason?: string;
  /** Structured workflow failure category for failed runs. */
  failureKind?: WorkflowFailureKind;
  /** Specific additive workflow failure code within `failureKind`. */
  failureCode?: WorkflowFailureCode;
  /** Whether retry/resume can recover this run without a workflow rerun. */
  failureRecoverability?: WorkflowFailureRecoverability;
  /** Executor lifecycle disposition chosen for this failure. */
  failureDisposition?: WorkflowFailureDisposition;
  /** Optional provider retry hint in milliseconds. Informational; blocked runs resume only via explicit user action. */
  retryAfterMs?: number;
  /** Timestamp when an active run was blocked by a recoverable workflow failure. */
  blockedAt?: number;
  /** Original unsanitized error text when different from `error`. */
  failureMessage?: string;
  failedStageId?: string;
  resumable?: boolean;
  /** Parent workflow run when this snapshot is an internal child workflow run. Hidden from top-level status lists. */
  parentRunId?: string;
  /** Parent workflow boundary stage that launched this internal child workflow run. */
  parentStageId?: string;
  /** Top-level workflow run that owns this nested run tree. */
  rootRunId?: string;
  /** Source failed run when this run is a continuation. */
  resumedFromRunId?: string;
  /** Source stage id where continuation resumes real execution. */
  resumeFromStageId?: string;
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
