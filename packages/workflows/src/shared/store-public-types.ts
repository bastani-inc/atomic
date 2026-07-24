import type { WorkflowOutputValues } from "./types.js";
import type {
  PendingPrompt,
  PromptKind,
  RunSnapshot,
  StageInputRequest,
  StageSnapshot,
  StageNotice,
  StoreSnapshot,
  ToolEvent,
  RunStatus,
  WorkflowFailureKind,
  WorkflowFailureCode,
  WorkflowFailureRecoverability,
  WorkflowFailureDisposition,
  WorkflowNotice,
  WorkflowChildRunRef,
} from "./store-types.js";

export interface RunEndMetadata {
  readonly failureKind?: WorkflowFailureKind;
  readonly failureCode?: WorkflowFailureCode;
  readonly failureRecoverability?: WorkflowFailureRecoverability;
  readonly failureDisposition?: WorkflowFailureDisposition;
  readonly failureMessage?: string;
  readonly failedStageId?: string;
  readonly resumable?: boolean;
  readonly retryAfterMs?: number;
  readonly exited?: boolean;
  readonly exitReason?: string;
}

export interface RunPauseMetadata {
  readonly resumable?: boolean;
  readonly exitReason?: string;
}
export interface RunBlockedMetadata extends RunEndMetadata {
  readonly failureRecoverability: "recoverable";
  readonly failedStageId: string;
  readonly resumable: true;
  readonly blockedAt?: number;
}

export type StagePromptAnswerSource = "workflow_ui" | "workflow_tool";

export interface PromptAnswerRecord {
  readonly runId: string;
  readonly stageId: string;
  readonly promptId: string;
  readonly kind: PromptKind;
  readonly value: unknown;
  readonly answeredAt: number;
  readonly answerSource?: StagePromptAnswerSource;
}

export interface ResolveStagePendingPromptOptions {
  /**
   * Whether to retain the response in the live-only prompt answer ledger for
   * continuation replay. Abort/default resolutions should set this to false.
   */
  readonly recordAnswer?: boolean;
  /** Identifies who answered the prompt so notification code can avoid echoing workflow-tool answers. */
  readonly answerSource?: StagePromptAnswerSource;
}

export interface RecordStagePromptAnswerOptions {
  /** Identifies who answered the prompt so notification code can avoid echoing workflow-tool answers. */
  readonly answerSource?: StagePromptAnswerSource;
}

export interface Store {
  runs(): readonly RunSnapshot[];
  notices(): readonly WorkflowNotice[];
  activeRunId(): string | null;
  recordRunStart(run: RunSnapshot): void;
  /** Compare-and-swap a cached child run's owning boundary during durable replay. */
  reconcileRunParentStage(runId: string, expectedParentStageId: string, parentStageId: string): boolean;
  recordStageStart(runId: string, stage: StageSnapshot): void;
  /** Link a workflow boundary stage to its live child run before that child completes. */
  recordStageWorkflowChildRun(runId: string, stageId: string, ref: WorkflowChildRunRef): boolean;
  recordToolStart(runId: string, stageId: string, evt: ToolEvent): void;
  recordToolEnd(runId: string, stageId: string, evt: ToolEvent): void;
  recordStageEnd(runId: string, stage: StageSnapshot): void;
  /**
   * Records the end of a run.
   * Returns `true` if state changed, `false` if the run was not found or
   * already in a terminal state (completed | failed | killed | skipped | cancelled | blocked).
   * `result` is applied for intentional success/exit statuses (completed | skipped | cancelled | blocked)
   * and for workflows that intentionally return a failed status with structured outputs.
   * `error` is applied for status "failed" | "killed" | "blocked".
   */
  recordRunEnd(
    runId: string,
    status: RunStatus,
    result?: WorkflowOutputValues,
    error?: string,
    metadata?: RunEndMetadata,
  ): boolean;
  /**
   * Record an active, recoverable workflow failure without ending the run.
   * The run remains resumable/running and carries failure metadata for status,
   * persistence restore, and continuation decisions.
   */
  recordRunBlocked(runId: string, error: string, metadata: RunBlockedMetadata): boolean;
  /**
   * Remove a run from live workflow history/status. Any pending HIL prompt
   * waiter is rejected because the workflow will not resume through that path.
   * Returns `true` when a run was removed, `false` when the id is unknown.
   */
  removeRun(runId: string): boolean;
  recordNotice(notice: WorkflowNotice): void;
  /**
   * Acknowledges a notice by id.
   * Returns `true` if notice was found and not yet acked, `false` otherwise.
   */
  ackNotice(id: string): boolean;
  /**
   * Record a pending HIL prompt for a run. The run must exist; if it's
   * already in a terminal state or already has a pending prompt, the call
   * is rejected (`false`). On success, store subscribers fire.
   *
   * Resolution lives on `awaitPendingPrompt` / `resolvePendingPrompt`.
   */
  recordPendingPrompt(runId: string, prompt: PendingPrompt): boolean;
  /**
   * Resolve the pending prompt on a run with a user-provided response.
   * Returns `true` when the run had a matching pending prompt (the prompt
   * is cleared and any waiter rejected with the response). `false` for
   * unknown runId, missing prompt, or id mismatch.
   *
   * `response` is forwarded verbatim to the awaiter; callers shape it to
   * match the prompt's kind (string for input/editor, boolean for confirm,
   * one of `choices` for select).
   */
  resolvePendingPrompt(runId: string, promptId: string, response: unknown): boolean;
  /**
   * Wait for a previously recorded pending prompt to resolve. Returns the
   * response value passed to `resolvePendingPrompt`. Rejects if the run is
   * terminated (cancelled / killed) before the user responds.
   *
   * Used by the background UI adapter to bridge `ctx.ui.*` calls to the
   * overlay-driven response. Foreground runs never call this.
   */
  awaitPendingPrompt(runId: string, promptId: string): Promise<unknown>;
  /** Record a pending HIL prompt for a specific workflow stage/node. */
  recordStagePendingPrompt(runId: string, stageId: string, prompt: PendingPrompt): boolean;
  /** Resolve a pending HIL prompt on a specific workflow stage/node. */
  resolveStagePendingPrompt(
    runId: string,
    stageId: string,
    promptId: string,
    response: unknown,
    options?: ResolveStagePendingPromptOptions,
  ): boolean;
  /** Wait for a stage/node-scoped HIL prompt to resolve. */
  awaitStagePendingPrompt(runId: string, stageId: string, promptId: string): Promise<unknown>;
  /**
   * Record a live-only prompt answer for prompt-node UIs that do not use
   * `stage.pendingPrompt` (notably arbitrary `ctx.ui.custom<T>` widgets).
   * The raw value stays in the private answer ledger and is never serialized
   * into snapshots or persistence.
   */
  recordStagePromptAnswer(
    runId: string,
    stageId: string,
    prompt: PendingPrompt,
    response: unknown,
    options?: RecordStagePromptAnswerOptions,
  ): boolean;
  /**
   * Record a live-only draft for an active stage-local input/editor prompt.
   * Draft text may contain secrets and must never be copied into snapshots,
   * status output, logs, notifications, or persisted metadata.
   */
  recordStagePromptDraft(runId: string, stageId: string, promptId: string, text: string): boolean;
  /** Return a live-only draft for an active stage-local input/editor prompt, if present. */
  getStagePromptDraft(runId: string, stageId: string, promptId: string): string | undefined;
  /** Clear a live-only draft for a stage-local prompt. */
  clearStagePromptDraft(runId: string, stageId: string, promptId: string): boolean;
  /**
   * Return the live-only prompt answer record for a completed prompt stage, if
   * still available. The returned value may contain secrets and must never be
   * logged, serialized, or copied into snapshots/persistence. Answers remain
   * resident in memory until explicitly cleared, the run is removed, or the
   * store is cleared.
   */
  getStagePromptAnswer(runId: string, stageId: string): PromptAnswerRecord | undefined;
  /** Clear the live-only prompt answer record for a stage. Primarily used by tests/cleanup. */
  clearStagePromptAnswer(runId: string, stageId: string): void;
  /**
   * Record Pi/pi SDK session metadata for a stage after lazy attach. The
   * serializable snapshot tracks this so post-mortem reopen via
   * `SessionManager.open(sessionFile)` is possible without storing live
   * handles in the store. Returns `true` when state changed.
   */
  recordStageSession(runId: string, stageId: string, session: { sessionId?: string; sessionFile?: string }): boolean;
  /** Toggle the `attachable` flag on a stage. */
  recordStageAttachable(runId: string, stageId: string, attachable: boolean): boolean;
  /** Toggle the `attached` flag on a stage. Snapshot-only. */
  recordStageAttached(runId: string, stageId: string, attached: boolean): boolean;
  /** Mark a live stage as awaiting a user response, or restore it to running. */
  recordStageAwaitingInput(runId: string, stageId: string, awaiting: boolean, ts?: number): boolean;
  /** Record the serializable descriptor of a brokered structured prompt awaiting an answer. */
  recordStageInputRequest(runId: string, stageId: string, request: StageInputRequest): boolean;
  /** Clear a stage's brokered structured-prompt descriptor. */
  clearStageInputRequest(runId: string, stageId: string): boolean;
  /** Mark a stage as `paused` and record `pausedAt`. */
  recordStagePaused(runId: string, stageId: string, pausedAt?: number): boolean;
  /** Clear `paused`/`blocked` state on a stage and record `resumedAt`. */
  recordStageResumed(runId: string, stageId: string, resumedAt?: number): boolean;
  recordStageBlocked(runId: string, stageId: string, blockedBy: string): boolean;
  recordStageUnblocked(runId: string, stageId: string): boolean;
  recordStageNotice(runId: string, stageId: string, notice: StageNotice): boolean;
  /** Mark a run as `paused`. Optional metadata can annotate resumable quit/detach state. */
  recordRunPaused(runId: string, pausedAt?: number, metadata?: RunPauseMetadata): boolean;
  /** Restore a run from `paused` back to `running`. */
  recordRunResumed(runId: string, resumedAt?: number): boolean;
  /** Drop every run and notice. */
  clear(): void;
  snapshot(): StoreSnapshot;
  subscribe(fn: (snap: StoreSnapshot) => void): () => void;
}
