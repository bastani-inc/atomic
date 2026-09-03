/**
 * Types for live run/stage snapshots.
 * cross-ref: spec §5.5
 */

import type { BudgetDimension, BudgetReport, DurationBudgetReport, UsageBudgetReport } from "./budget.js";
import type { RunMeterCounters } from "./budget-meter.js";
import type {
	WorkflowExitStatus,
	WorkflowInputValues,
	WorkflowOutputValues,
	WorkflowSerializableValue,
} from "./types.js";

export type RunStatus = "pending" | "running" | "paused" | WorkflowExitStatus | "killed";
export type StageStatus =
	| "pending"
	| "running"
	| "awaiting_input"
	| "paused"
	| "blocked"
	| "completed"
	| "failed"
	| "skipped";

export type RunBudgetSnapshot = Readonly<Record<"maxDurationMs" | "warnAtPercent", number>> &
	Readonly<Partial<Record<"maxTokens" | "maxCost", number>>>;
export type RunBudgetUsageBaseline = RunMeterCounters & { readonly cost: number };
export type RunBudgetAccountingState = Readonly<Record<"tokens" | "cost", number>> & {
	readonly baseline: RunBudgetUsageBaseline;
	readonly perCounter: RunMeterCounters;
};
export interface RunBudgetState
	extends Partial<Record<"warned" | "wrapUpDelivered" | "wrapUpCompleted" | "systemOwnedStop", boolean>> {
	readonly duration?: DurationBudgetReport;
	readonly tokens?: UsageBudgetReport & { readonly dimension: "tokens" };
	readonly cost?: UsageBudgetReport & { readonly dimension: "cost" };
	/** Latest warning retained for legacy consumers; `warnings` keeps each dimension. */
	readonly warning?: BudgetReport;
	readonly warnings?: Partial<Record<BudgetDimension, BudgetReport>>;
	readonly accounting?: RunBudgetAccountingState;
	readonly wrapUpSummary?: string;
	readonly wrapUpUsage?: import("./types.js").WorkflowModelUsage;
}
export type ToolNodeStatus = "pending" | "running" | "completed" | "failed" | "cached" | "cancelled";

/** First-class, durable graph node created for each ctx.tool invocation. */
export interface ToolNodeSnapshot {
	readonly kind: "tool";
	readonly id: string;
	readonly name: string;
	/** Exact invocation arguments retained for read-only graph inspection. */
	readonly args?: Readonly<Record<string, WorkflowSerializableValue>>;
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
	durationMs?: number;
	/** Full serializable callback result, when one was retained. */
	result?: WorkflowSerializableValue;
	/**
	 * Callback source captured from `fn.toString()` when the call was
	 * registered. Inspection-only: capture never re-runs the callback, never
	 * reads a file, and never reaches past the value already in hand.
	 */
	source?: string;
	resultSummary?: string;
	error?: string;
	/** Tool nodes remain read-only graph inspection targets, never chat targets. */
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
 * structured ask_user_question shape so `workflow answer` and status inspection
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
	/** Payload-free output count used by compact graph projections. */
	readonly outputCount?: number;
	readonly exitReason?: string;
}

/** Serializable attachment retained verbatim from an ordinary intercom message. */
export interface PendingStageAttachment {
	readonly type: "file" | "snippet" | "context";
	readonly name: string;
	readonly content: string;
	readonly language?: string;
}

/** The ordinary intercom message wire shape persisted by workflows. */
export interface PendingStageIntercomMessage {
	readonly id: string;
	readonly timestamp: number;
	readonly replyTo?: string;
	readonly expectsReply?: boolean;
	readonly replyError?: string;
	readonly source?: {
		readonly subagentRunId: string;
		readonly subagentAgent?: string;
		readonly subagentIndex?: number;
	};
	readonly content: {
		readonly text: string;
		readonly attachments?: readonly PendingStageAttachment[];
	};
}

export interface PendingStageSender {
	readonly id: string;
	readonly name?: string;
	readonly group?: string;
	readonly groups?: readonly string[];
	readonly cwd?: string;
	readonly model?: string;
	readonly pid?: number;
	readonly startedAt?: number;
	readonly lastActivity?: number;
	readonly status?: string;
}

export interface PendingStageMessage {
	readonly id: string;
	readonly runId: string;
	readonly stageKey: string;
	/** Canonical authored stage id. Absent only on durable records written before alias canonicalization. */
	readonly stageId?: string;
	/** Stable authored replay identity used to restore the canonical stage across process resume. */
	readonly stageReplayKey?: string;
	/** Immutable broker registration name captured separately from mutable sender display presence. */
	readonly senderRegistrationName?: string;
	/** Stable internal host identity used only for broker-verified durable replies. */
	readonly senderReturnAddress?: string;
	readonly from: PendingStageSender;
	readonly message: PendingStageIntercomMessage;
	readonly queuedAt: string;
	/** Durable workflow admission sequence; sender clocks never determine delivery order. */
	readonly admissionOrder?: number;
	readonly status: "queued" | "delivered" | "undeliverable";
	readonly deliveredAt?: string;
	readonly undeliverableReason?: string;
	/** Deterministic outbox identity retained until the correlated sender notification is acknowledged. */
	readonly undeliverableNotificationId?: string;
	readonly undeliverableNotifiedAt?: string;
	/** Slice 3 (D3): sticky entry delivered to every future matching stage until the root run terminates. */
	readonly sticky?: true;
	/** Verbatim target string as sent (path or pattern form, `workflow:<rootRunId>/...`). */
	readonly targetPath?: string;
	/** D4 speculative accept: target was not present in the persisted possible-stage set. */
	readonly notInKnownSet?: true;
	/** One immutable record per (entry, materialized stage) delivery; the exactly-once ledger (D3). */
	readonly deliveries?: readonly PendingStageMessageDelivery[];
	/** Total recorded deliveries; observable on the entry. */
	readonly deliveryCount?: number;
}

/** One exactly-once delivery of a sticky pending-stage entry to one materialized stage. */
export interface PendingStageMessageDelivery {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName?: string;
	readonly deliveredAt: string;
}

export type PendingStageMessageInput = Omit<
	PendingStageMessage,
	| "id"
	| "stageId"
	| "stageReplayKey"
	| "admissionOrder"
	| "status"
	| "deliveredAt"
	| "undeliverableReason"
	| "undeliverableNotificationId"
	| "undeliverableNotifiedAt"
	| "sticky"
	| "deliveries"
	| "deliveryCount"
>;

/** Input for a sticky (D3) pending-stage entry: the target is a path/pattern, not one exact stage. */
export type PendingStickyStageMessageInput = PendingStageMessageInput & {
	readonly targetPath: string;
	readonly notInKnownSet?: true;
};

export type PendingStageQueueResult =
	| {
			readonly ok: true;
			readonly messages: readonly PendingStageMessage[];
			readonly entry: PendingStageMessage;
			/** One-based position within the active canonical authored stage queue; absent for terminal retries. */
			readonly position?: number;
			readonly deduplicated: boolean;
	  }
	| {
			readonly ok: false;
			readonly reason: "group_mismatch";
			readonly runId: string;
			readonly stageKey: string;
	  }
	| {
			readonly ok: false;
			readonly reason: "message_id_conflict";
			readonly runId: string;
			readonly stageKey: string;
			readonly messageId: string;
	  }
	| {
			readonly ok: false;
			readonly reason: "capacity";
			readonly limit: number;
			readonly runId: string;
			readonly stageKey: string;
	  };

export type LiveStageMessageValidationResult =
	| { readonly outcome: "forward" }
	| { readonly outcome: "queued"; readonly position: number }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "undeliverable"; readonly reason?: string }
	| { readonly outcome: "message_id_conflict"; readonly messageId: string };

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
	/** Actual broker group after invocation-owned subgroup resolution. */
	intercomGroup?: string;
	/** Authoritative stage-factory capability; only true stages have a pre-start Intercom drain. */
	pendingStageDeliveryAvailable?: boolean;
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
	 * pending; resolution lives in `StageUiBroker`. Lets `workflow answer` answer
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
	/** Schema-backed task/stage value, when distinct from assistant text. */
	structured?: WorkflowSerializableValue;
	/** Worktree or output artifacts collected after a completed task. */
	artifacts?: readonly import("./types.js").WorkflowArtifact[];
	/** Model-fallback warnings recorded on this stage. */
	warnings?: readonly string[];
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
	/** Who paused this stage. Set only by a deliberate control action. */
	pauseActor?: WorkflowActor;
	/** Who resumed this stage. Set only by a deliberate control action. */
	resumeActor?: WorkflowActor;
}

/**
 * Who performed a workflow lifecycle action. A run's `origin` answers "who
 * launched it"; an actor on a pause, quit, or resume answers "who did this one
 * thing". They differ routinely — the agent starts a run and the user quits it.
 */
export type WorkflowActor = "user" | "agent";

/**
 * Which code path resumed a run. Only `run_control` is a deliberate control
 * action; the rest continue work already in progress — answering a
 * human-in-the-loop prompt, per-stage control, and the acknowledgement pass —
 * and must never be reported as a lifecycle event of their own.
 */
export type RunResumeSource = "run_control" | "prompt_answer" | "stage_control" | "acknowledgement";

export interface RunSnapshot {
	readonly id: string;
	readonly name: string;
	readonly inputs: Readonly<WorkflowInputValues>;
	status: RunStatus;
	readonly stages: StageSnapshot[];
	/** Durable ctx.tool execution nodes. Optional only for legacy/restored snapshots. */
	readonly toolNodes?: ToolNodeSnapshot[];
	/** Resolved duration budget and persisted wrap-up state; omitted when unbudgeted. */
	budget?: RunBudgetSnapshot;
	budgetState?: RunBudgetState;
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
	/** Timestamp when the run entered resumable quit state; display-only expiry marker. */
	quitAt?: number;
	/**
	 * Who paused or quit this run, and who resumed it. A control path records
	 * these; the engine's own pauses and resumes leave them unset, which is what
	 * keeps an internal continuation from being reported as a user action.
	 */
	pauseActor?: WorkflowActor;
	resumeActor?: WorkflowActor;
	/** Which path performed the most recent resume. */
	resumeSource?: RunResumeSource;
	/**
	 * Who launched this run. Set once at dispatch and inherited by a continuation
	 * from the run it continues. Absent on legacy and restored runs that never
	 * recorded it, in which case attribution is omitted rather than guessed.
	 */
	origin?: WorkflowActor;
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
	/** Tool node whose rejection supplied the selected terminal failure. */
	failedToolNodeId?: string;
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
	/** Durable messages queued for workflow stages that have not started yet. */
	pendingStageMessages?: PendingStageMessage[];
	/** Possible stage targets from the D1 static scan; root runs only; empty when not scanned (D10). */
	possibleStages?: readonly string[];
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
