/**
 * Plain mutable singleton store with subscribe/version counter.
 * cross-ref: spec §5.5
 */

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
  StageStatus,
  WorkflowFailureKind,
  WorkflowFailureCode,
  WorkflowFailureRecoverability,
  WorkflowFailureDisposition,
  WorkflowNotice,
  WorkflowChildRunRef,
} from "./store-types.js";
import { accumulatePausedDurationMs, elapsedRunMs } from "./timing.js";
import { isTopLevelWorkflowRun } from "./run-visibility.js";

/** Statuses that represent a terminal run state — cannot be overwritten. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "killed", "skipped", "cancelled", "blocked"]);

function isTerminalStageStatus(status: StageStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function cannotAwaitInput(status: StageStatus): boolean {
  return isTerminalStageStatus(status) || status === "paused" || status === "blocked";
}

function cannotBlock(status: StageStatus): boolean {
  return isTerminalStageStatus(status) || status === "paused";
}

function cannotPause(status: StageStatus): boolean {
  return isTerminalStageStatus(status) || status === "paused" || status === "blocked";
}

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

export interface RunBlockedMetadata extends RunEndMetadata {
  readonly failureRecoverability: "recoverable";
  readonly failedStageId: string;
  readonly resumable: true;
  readonly blockedAt?: number;
}

function clearRunFailureMetadata(run: RunSnapshot): void {
  delete run.error;
  delete run.failureKind;
  delete run.failureCode;
  delete run.failureRecoverability;
  delete run.failureDisposition;
  delete run.failureMessage;
  delete run.failedStageId;
  delete run.resumable;
  delete run.retryAfterMs;
  delete run.blockedAt;
  delete run.exited;
  delete run.exitReason;
}

function clearStaleBlockedRunMetadata(run: RunSnapshot, metadata: RunEndMetadata | undefined): void {
  if (metadata?.failureKind === undefined) delete run.failureKind;
  if (metadata?.failureCode === undefined) delete run.failureCode;
  if (metadata?.failureRecoverability === undefined) delete run.failureRecoverability;
  if (metadata?.failureDisposition === undefined) delete run.failureDisposition;
  if (metadata?.failureMessage === undefined) delete run.failureMessage;
  if (metadata?.failedStageId === undefined) delete run.failedStageId;
  if (metadata?.resumable === undefined) delete run.resumable;
  if (metadata?.retryAfterMs === undefined) delete run.retryAfterMs;
  if (metadata?.exited === undefined) delete run.exited;
  if (metadata?.exitReason === undefined) delete run.exitReason;
}

function applyRunEndMetadata(run: RunSnapshot, metadata: RunEndMetadata): void {
  if (metadata.failureKind !== undefined) run.failureKind = metadata.failureKind;
  if (metadata.failureCode !== undefined) run.failureCode = metadata.failureCode;
  if (metadata.failureRecoverability !== undefined) run.failureRecoverability = metadata.failureRecoverability;
  if (metadata.failureDisposition !== undefined) run.failureDisposition = metadata.failureDisposition;
  if (metadata.retryAfterMs !== undefined) run.retryAfterMs = metadata.retryAfterMs;
  if (metadata.failureMessage !== undefined) run.failureMessage = metadata.failureMessage;
  if (metadata.failedStageId !== undefined) run.failedStageId = metadata.failedStageId;
  if (metadata.resumable !== undefined) run.resumable = metadata.resumable;
  if (metadata.exited !== undefined) run.exited = metadata.exited;
  if (metadata.exitReason !== undefined) run.exitReason = metadata.exitReason;
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
   * `result` is applied for intentional success/exit statuses (completed | skipped | cancelled | blocked).
   * `error` is only applied for status "failed" | "killed".
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
  resolvePendingPrompt(
    runId: string,
    promptId: string,
    response: unknown,
  ): boolean;
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
   * Record Pi/pi SDK session metadata for a stage after lazy
   * attach. The serializable snapshot tracks this so post-mortem reopen
   * via `SessionManager.open(sessionFile)` is possible without storing
   * live handles in the store. Returns `true` when state changed.
   */
  recordStageSession(
    runId: string,
    stageId: string,
    session: { sessionId?: string; sessionFile?: string },
  ): boolean;
  /**
   * Toggle the `attachable` flag on a stage. The flag reflects whether
   * the stage remains in the live workflow-control set. A completed stage may
   * still have a detached chat handle while this flag is cleared.
   */
  recordStageAttachable(runId: string, stageId: string, attachable: boolean): boolean;
  /**
   * Toggle the `attached` flag on a stage. Snapshot-only — the live
   * pane keeps its own ref to the stage-control handle.
   */
  recordStageAttached(runId: string, stageId: string, attached: boolean): boolean;
  /**
   * Mark a live stage as awaiting a user response from ask_user_question,
   * or restore it to running after the tool resolves.
   */
  recordStageAwaitingInput(runId: string, stageId: string, awaiting: boolean, ts?: number): boolean;
  /**
   * Record the serializable descriptor of a brokered structured prompt
   * (`ask_user_question` / readiness gate) awaiting an answer on a stage.
   * Surfaces the questions/options on the snapshot so `workflow send` and
   * status inspection can answer the prompt headlessly. Resolution itself lives
   * in `StageUiBroker`. Returns `true` when the descriptor changed.
   */
  recordStageInputRequest(runId: string, stageId: string, request: StageInputRequest): boolean;
  /** Clear a stage's brokered structured-prompt descriptor. Returns `true` when one was present. */
  clearStageInputRequest(runId: string, stageId: string): boolean;
  /**
   * Mark a stage as `paused` and record `pausedAt`. Returns `true` when
   * the stage transitioned (was not already paused, blocked, or terminal).
   */
  recordStagePaused(runId: string, stageId: string, pausedAt?: number): boolean;
  /**
   * Clear `paused`/`blocked` state on a stage and record `resumedAt`.
   * Returns `true` when the stage transitioned out of either status.
   * Status is restored to `running` so downstream gating reflects the
   * resumed Pi operation.
   */
  recordStageResumed(runId: string, stageId: string, resumedAt?: number): boolean;
  recordStageBlocked(runId: string, stageId: string, blockedBy: string): boolean;
  recordStageUnblocked(runId: string, stageId: string): boolean;
  recordStageNotice(runId: string, stageId: string, notice: StageNotice): boolean;
  /**
   * Mark a run as `paused`. Idempotent on a paused run; refuses to
   * change a terminal run. Returns `true` when state changed.
   */
  recordRunPaused(runId: string, pausedAt?: number): boolean;
  /**
   * Restore a run from `paused` back to `running`. Refuses terminal
   * runs. Returns `true` when state changed.
   */
  recordRunResumed(runId: string, resumedAt?: number): boolean;
  /**
   * Drop every run and notice. Invoked on session boundaries so workflow
   * state is scoped to the originating chat — once the chat ends or a
   * new session starts, prior-session runs no longer pollute the store
   * (or the `/workflow status` output).
   */
  clear(): void;
  snapshot(): StoreSnapshot;
  subscribe(fn: (snap: StoreSnapshot) => void): () => void;
}

export function createStore(): Store {
  const _runs: RunSnapshot[] = [];
  const _notices: WorkflowNotice[] = [];
  const _listeners: Set<(snap: StoreSnapshot) => void> = new Set();
  const _stagePromptAnswers = new Map<string, PromptAnswerRecord>();
  const _stagePromptDrafts = new Map<string, string>();
  let _version = 0;

  /**
   * Per-runId resolver registry for pending HIL prompts. Keyed by promptId
   * so a misrouted resolve (stale id) is a clean no-op rather than a crash.
   * Lives outside the snapshot — functions are not JSON-cloneable.
   */
  interface ResolverEntry {
    readonly promptId: string;
    readonly resolve: (response: unknown) => void;
    readonly reject: (reason: unknown) => void;
  }
  const _resolvers = new Map<string, ResolverEntry>();

  function notify(): void {
    const snap = snapshot();
    for (const fn of _listeners) {
      fn(snap);
    }
  }

  function snapshot(): StoreSnapshot {
    return JSON.parse(
      JSON.stringify({ runs: _runs, notices: _notices, version: _version }),
    ) as StoreSnapshot;
  }

  function findRun(runId: string): RunSnapshot | undefined {
    return _runs.find((r) => r.id === runId);
  }

  function findStage(run: RunSnapshot, stageId: string): StageSnapshot | undefined {
    return run.stages.find((s) => s.id === stageId);
  }

  function rejectPrompt(promptId: string, reason: string): void {
    const entry = _resolvers.get(promptId);
    if (!entry) return;
    _resolvers.delete(promptId);
    entry.reject(new Error(reason));
  }

  function stagePromptAnswerKey(runId: string, stageId: string): string {
    return JSON.stringify([runId, stageId]);
  }

  function stagePromptDraftKey(runId: string, stageId: string, promptId: string): string {
    return JSON.stringify([runId, stageId, promptId]);
  }

  function stageHasActiveTextPrompt(
    runId: string,
    stageId: string,
    promptId: string,
  ): { prompt: PendingPrompt } | undefined {
    const run = findRun(runId);
    if (!run || TERMINAL_STATUSES.has(run.status)) return undefined;
    const stage = findStage(run, stageId);
    if (!stage || isTerminalStageStatus(stage.status)) return undefined;
    const prompt = stage.pendingPrompt;
    if (!prompt || prompt.id !== promptId) return undefined;
    if (prompt.kind !== "input" && prompt.kind !== "editor") return undefined;
    return { prompt };
  }

  function rejectStagePrompt(runId: string, stage: StageSnapshot, reason: string): void {
    const prompt = stage.pendingPrompt;
    if (!prompt) return;
    stage.pendingPrompt = undefined;
    _stagePromptDrafts.delete(stagePromptDraftKey(runId, stage.id, prompt.id));
    rejectPrompt(prompt.id, reason);
  }

  function rejectAllStagePrompts(runId: string, run: RunSnapshot, reason: string): void {
    for (const stage of run.stages) {
      rejectStagePrompt(runId, stage, reason);
    }
  }

  return {
    runs(): readonly RunSnapshot[] {
      return _runs;
    },

    notices(): readonly WorkflowNotice[] {
      return _notices;
    },

    activeRunId(): string | null {
      // Most recently started top-level run that hasn't ended. Nested
      // workflow runs stay in the store for live control/expanded graph
      // rendering, but should not steal the active top-level workflow slot.
      for (let i = _runs.length - 1; i >= 0; i--) {
        const run = _runs[i];
        if (run && isTopLevelWorkflowRun(run) && run.endedAt === undefined) {
          return run.id;
        }
      }
      // Fallback for the degraded "orphaned-nested-only" state: a child run is in
      // flight but no top-level run is. This normally cannot happen (a parent
      // stays in flight while awaiting `ctx.workflow(...)`), so callers that rely
      // on a top-level id should treat a returned nested id as best-effort.
      for (let i = _runs.length - 1; i >= 0; i--) {
        const run = _runs[i];
        if (run && run.endedAt === undefined) {
          return run.id;
        }
      }
      return null;
    },

    recordRunStart(run: RunSnapshot): void {
      _runs.push(run);
      _version++;
      notify();
    },

    recordStageStart(runId: string, stage: StageSnapshot): void {
      const run = findRun(runId);
      if (!run) return;
      // Only push if not already in run.stages
      if (!run.stages.some((s) => s.id === stage.id)) {
        run.stages.push(stage);
      }
      _version++;
      notify();
    },

    recordStageWorkflowChildRun(runId: string, stageId: string, ref: WorkflowChildRunRef): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (
        stage.workflowChildRun?.runId === ref.runId &&
        stage.workflowChildRun.alias === ref.alias &&
        stage.workflowChildRun.workflow === ref.workflow
      ) {
        return false;
      }
      stage.workflowChildRun = { ...ref };
      _version++;
      notify();
      return true;
    },

    recordToolStart(runId: string, stageId: string, evt: ToolEvent): void {
      const run = findRun(runId);
      if (!run) return;
      const stage = findStage(run, stageId);
      if (!stage) return;
      // Don't duplicate if same tool event already present (match by name + startedAt)
      const exists = stage.toolEvents.some(
        (e) => e.name === evt.name && e.startedAt === evt.startedAt,
      );
      if (!exists) {
        stage.toolEvents.push(evt);
      }
      _version++;
      notify();
    },

    recordToolEnd(runId: string, stageId: string, evt: ToolEvent): void {
      const run = findRun(runId);
      if (!run) return;
      const stage = findStage(run, stageId);
      if (!stage) return;
      // Find and update matching ToolEvent by name + startedAt
      const existing = stage.toolEvents.find(
        (e) => e.name === evt.name && e.startedAt === evt.startedAt,
      );
      if (existing) {
        existing.endedAt = evt.endedAt;
        existing.output = evt.output;
      }
      _version++;
      notify();
    },

    recordStageEnd(runId: string, stage: StageSnapshot): void {
      const run = findRun(runId);
      if (!run) return;
      const existing = findStage(run, stage.id);
      if (!existing) return;
      existing.status = stage.status;
      existing.endedAt = stage.endedAt;
      if (existing.endedAt !== undefined && existing.pausedAt !== undefined) {
        existing.pausedDurationMs = accumulatePausedDurationMs(
          existing.pausedDurationMs,
          existing.pausedAt,
          existing.endedAt,
        );
        existing.pausedAt = undefined;
      }
      existing.durationMs = stage.durationMs;
      existing.result = stage.result;
      existing.error = stage.error;
      existing.failureKind = stage.failureKind;
      existing.failureCode = stage.failureCode;
      existing.failureRecoverability = stage.failureRecoverability;
      existing.failureDisposition = stage.failureDisposition;
      existing.retryAfterMs = stage.retryAfterMs;
      existing.failureMessage = stage.failureMessage;
      existing.skippedReason = stage.skippedReason;
      if (stage.replayKey !== undefined) existing.replayKey = stage.replayKey;
      if (stage.promptAnswerState !== undefined) existing.promptAnswerState = stage.promptAnswerState;
      if (stage.replayedFromStageId !== undefined) existing.replayedFromStageId = stage.replayedFromStageId;
      if (stage.replayed !== undefined) existing.replayed = stage.replayed;
      if (stage.status === "completed") {
        if (stage.workflowChildRun !== undefined) existing.workflowChildRun = { ...stage.workflowChildRun };
        if (stage.workflowChild !== undefined) existing.workflowChild = structuredClone(stage.workflowChild);
      } else {
        delete existing.workflowChildRun;
        delete existing.workflowChild;
      }
      delete existing.awaitingInputSince;
      delete existing.inputRequest;
      rejectStagePrompt(runId, existing, `atomic-workflows: stage ${stage.id} ended before prompt resolved`);
      _version++;
      notify();
    },

    recordRunEnd(
      runId: string,
      status: RunStatus,
      result?: WorkflowOutputValues,
      error?: string,
      metadata?: RunEndMetadata,
    ): boolean {
      const run = findRun(runId);
      if (!run) return false;
      // Terminal guard — once in a terminal state, refuse overwrite.
      if (TERMINAL_STATUSES.has(run.status)) return false;
      run.status = status;
      run.endedAt = Date.now();
      if (run.pausedAt !== undefined) {
        run.pausedDurationMs = accumulatePausedDurationMs(
          run.pausedDurationMs,
          run.pausedAt,
          run.endedAt,
        );
        run.pausedAt = undefined;
      }
      run.durationMs = elapsedRunMs(run, run.endedAt);
      const wasBlocked = run.blockedAt !== undefined || run.failureDisposition === "active_blocked";
      delete run.blockedAt;
      if (status === "completed" || status === "skipped" || status === "cancelled" || status === "blocked") {
        if (result !== undefined) {
          run.result = result;
        }
        clearRunFailureMetadata(run);
        if (metadata !== undefined) applyRunEndMetadata(run, metadata);
      } else {
        if (wasBlocked && error === undefined) delete run.error;
        if ((status === "failed" || status === "killed") && error !== undefined) {
          run.error = error;
        }
        if (wasBlocked) clearStaleBlockedRunMetadata(run, metadata);
        if (metadata !== undefined) applyRunEndMetadata(run, metadata);
        if (run.failureDisposition === "active_blocked") delete run.failureDisposition;
        if (status === "killed") {
          run.failureRecoverability = "non_recoverable";
          run.failureDisposition = "terminal_killed";
          run.resumable = false;
        }
      }
      // Abandon any waiting HIL prompt — workflow body never resumed past
      // it, but the awaiter promise must reject so the executor's catch
      // can finalise the run state cleanly.
      const pending = run.pendingPrompt;
      if (pending) {
        run.pendingPrompt = undefined;
        rejectPrompt(pending.id, `atomic-workflows: run ${runId} ended before prompt resolved`);
      }
      rejectAllStagePrompts(runId, run, `atomic-workflows: run ${runId} ended before prompt resolved`);
      _version++;
      notify();
      return true;
    },

    recordRunBlocked(runId: string, error: string, metadata: RunBlockedMetadata): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      run.status = "running";
      run.error = error;
      run.failureKind = metadata.failureKind;
      run.failureCode = metadata.failureCode;
      run.failureRecoverability = metadata.failureRecoverability;
      run.failureDisposition = metadata.failureDisposition;
      run.failureMessage = metadata.failureMessage;
      run.failedStageId = metadata.failedStageId;
      run.resumable = metadata.resumable;
      run.blockedAt = metadata.blockedAt ?? Date.now();
      if (metadata.retryAfterMs !== undefined) run.retryAfterMs = metadata.retryAfterMs;
      _version++;
      notify();
      return true;
    },

    removeRun(runId: string): boolean {
      const index = _runs.findIndex((r) => r.id === runId);
      if (index < 0) return false;
      const run = _runs[index]!;
      const pending = run.pendingPrompt;
      if (pending) {
        rejectPrompt(pending.id, `atomic-workflows: run ${runId} was removed before prompt resolved`);
      }
      rejectAllStagePrompts(runId, run, `atomic-workflows: run ${runId} was removed before prompt resolved`);
      for (const stage of run.stages) {
        _stagePromptAnswers.delete(stagePromptAnswerKey(runId, stage.id));
      }
      _runs.splice(index, 1);
      for (let i = _notices.length - 1; i >= 0; i--) {
        if (_notices[i]?.runId === runId) _notices.splice(i, 1);
      }
      _version++;
      notify();
      return true;
    },

    recordNotice(notice: WorkflowNotice): void {
      _notices.push(notice);
      _version++;
      notify();
    },

    ackNotice(id: string): boolean {
      const notice = _notices.find((n) => n.id === id);
      if (!notice || notice.ackedAt !== undefined) return false;
      notice.ackedAt = Date.now();
      _version++;
      notify();
      return true;
    },

    recordPendingPrompt(runId: string, prompt: PendingPrompt): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.pendingPrompt !== undefined) return false;
      run.pendingPrompt = { ...prompt };
      _version++;
      notify();
      return true;
    },

    resolvePendingPrompt(
      runId: string,
      promptId: string,
      response: unknown,
    ): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const pending = run.pendingPrompt;
      if (!pending || pending.id !== promptId) return false;
      run.pendingPrompt = undefined;
      _version++;
      // Notify first so observers see the cleared state before the waiter
      // resumes the workflow body (which may immediately mutate the store).
      notify();
      const entry = _resolvers.get(promptId);
      if (entry) {
        _resolvers.delete(promptId);
        entry.resolve(response);
      }
      return true;
    },

    awaitPendingPrompt(runId: string, promptId: string): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const run = findRun(runId);
        if (!run) {
          reject(new Error(`atomic-workflows: run "${runId}" not found`));
          return;
        }
        const pending = run.pendingPrompt;
        if (!pending || pending.id !== promptId) {
          reject(
            new Error(
              `atomic-workflows: pending prompt "${promptId}" not registered on run "${runId}"`,
            ),
          );
          return;
        }
        _resolvers.set(promptId, { promptId, resolve, reject });
      });
    },

    recordStagePendingPrompt(runId: string, stageId: string, prompt: PendingPrompt): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (isTerminalStageStatus(stage.status)) return false;
      if (stage.pendingPrompt !== undefined) return false;
      stage.pendingPrompt = { ...prompt };
      stage.promptFootprint = { ...prompt };
      stage.status = "awaiting_input";
      stage.awaitingInputSince = prompt.createdAt;
      _version++;
      notify();
      return true;
    },

    resolveStagePendingPrompt(
      runId: string,
      stageId: string,
      promptId: string,
      response: unknown,
      options: ResolveStagePendingPromptOptions = {},
    ): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      const pending = stage.pendingPrompt;
      if (!pending || pending.id !== promptId) return false;
      _stagePromptDrafts.delete(stagePromptDraftKey(runId, stageId, promptId));
      if (options.recordAnswer !== false) {
        _stagePromptAnswers.set(stagePromptAnswerKey(runId, stageId), {
          runId,
          stageId,
          promptId,
          kind: pending.kind,
          value: response,
          answeredAt: Date.now(),
          ...(options.answerSource !== undefined ? { answerSource: options.answerSource } : {}),
        });
        stage.promptAnswerState = "available";
      } else {
        _stagePromptAnswers.delete(stagePromptAnswerKey(runId, stageId));
        delete stage.promptAnswerState;
      }
      stage.pendingPrompt = undefined;
      if (stage.status === "awaiting_input") {
        stage.status = "running";
        delete stage.awaitingInputSince;
      }
      _version++;
      notify();
      const entry = _resolvers.get(promptId);
      if (entry) {
        _resolvers.delete(promptId);
        entry.resolve(response);
      }
      return true;
    },

    awaitStagePendingPrompt(runId: string, stageId: string, promptId: string): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const run = findRun(runId);
        if (!run) {
          reject(new Error(`atomic-workflows: run "${runId}" not found`));
          return;
        }
        const stage = findStage(run, stageId);
        if (!stage) {
          reject(new Error(`atomic-workflows: stage "${stageId}" not found on run "${runId}"`));
          return;
        }
        const pending = stage.pendingPrompt;
        if (!pending || pending.id !== promptId) {
          reject(
            new Error(
              `atomic-workflows: pending prompt "${promptId}" not registered on stage "${stageId}" in run "${runId}"`,
            ),
          );
          return;
        }
        _resolvers.set(promptId, { promptId, resolve, reject });
      });
    },

    recordStagePromptAnswer(
      runId: string,
      stageId: string,
      prompt: PendingPrompt,
      response: unknown,
      options: RecordStagePromptAnswerOptions = {},
    ): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (isTerminalStageStatus(stage.status)) return false;
      _stagePromptAnswers.set(stagePromptAnswerKey(runId, stageId), {
        runId,
        stageId,
        promptId: prompt.id,
        kind: prompt.kind,
        value: response,
        answeredAt: Date.now(),
        ...(options.answerSource !== undefined ? { answerSource: options.answerSource } : {}),
      });
      if (stage.promptFootprint === undefined) stage.promptFootprint = { ...prompt };
      stage.promptAnswerState = "available";
      if (stage.status === "awaiting_input") {
        stage.status = "running";
        delete stage.awaitingInputSince;
      }
      _version++;
      notify();
      return true;
    },

    recordStagePromptDraft(runId: string, stageId: string, promptId: string, text: string): boolean {
      if (stageHasActiveTextPrompt(runId, stageId, promptId) === undefined) return false;
      _stagePromptDrafts.set(stagePromptDraftKey(runId, stageId, promptId), text);
      return true;
    },

    getStagePromptDraft(runId: string, stageId: string, promptId: string): string | undefined {
      if (stageHasActiveTextPrompt(runId, stageId, promptId) === undefined) return undefined;
      return _stagePromptDrafts.get(stagePromptDraftKey(runId, stageId, promptId));
    },

    clearStagePromptDraft(runId: string, stageId: string, promptId: string): boolean {
      return _stagePromptDrafts.delete(stagePromptDraftKey(runId, stageId, promptId));
    },

    getStagePromptAnswer(runId: string, stageId: string): PromptAnswerRecord | undefined {
      return _stagePromptAnswers.get(stagePromptAnswerKey(runId, stageId));
    },

    clearStagePromptAnswer(runId: string, stageId: string): void {
      const removed = _stagePromptAnswers.delete(stagePromptAnswerKey(runId, stageId));
      const run = findRun(runId);
      const stage = run ? findStage(run, stageId) : undefined;
      const clearAvailabilityMarker = stage?.promptAnswerState === "available";
      if (clearAvailabilityMarker) {
        delete stage.promptAnswerState;
      }
      if (removed || clearAvailabilityMarker) {
        _version++;
        notify();
      }
    },

    recordStageSession(
      runId: string,
      stageId: string,
      session: { sessionId?: string; sessionFile?: string },
    ): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      let changed = false;
      if (session.sessionId !== undefined && stage.sessionId !== session.sessionId) {
        stage.sessionId = session.sessionId;
        changed = true;
      }
      if (session.sessionFile !== undefined && stage.sessionFile !== session.sessionFile) {
        stage.sessionFile = session.sessionFile;
        changed = true;
      }
      if (!changed) return false;
      _version++;
      notify();
      return true;
    },

    recordStageAttachable(runId: string, stageId: string, attachable: boolean): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      const next = attachable === true ? true : undefined;
      if (stage.attachable === next) return false;
      if (next === undefined) {
        delete stage.attachable;
      } else {
        stage.attachable = next;
      }
      _version++;
      notify();
      return true;
    },

    recordStageAttached(runId: string, stageId: string, attached: boolean): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      const next = attached === true ? true : undefined;
      if (stage.attached === next) return false;
      if (next === undefined) {
        delete stage.attached;
      } else {
        stage.attached = next;
      }
      _version++;
      notify();
      return true;
    },

    recordStageAwaitingInput(runId: string, stageId: string, awaiting: boolean, ts?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (cannotAwaitInput(stage.status)) return false;

      if (awaiting) {
        if (stage.status === "awaiting_input") return false;
        stage.status = "awaiting_input";
        stage.awaitingInputSince = ts ?? Date.now();
      } else {
        if (stage.pendingPrompt !== undefined) return false;
        if (stage.status !== "awaiting_input") return false;
        stage.status = "running";
        delete stage.awaitingInputSince;
      }
      _version++;
      notify();
      return true;
    },

    recordStageInputRequest(runId: string, stageId: string, request: StageInputRequest): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (isTerminalStageStatus(stage.status)) return false;
      if (stage.inputRequest?.id === request.id) return false;
      stage.inputRequest = { ...request };
      _version++;
      notify();
      return true;
    },

    clearStageInputRequest(runId: string, stageId: string): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage || stage.inputRequest === undefined) return false;
      delete stage.inputRequest;
      _version++;
      notify();
      return true;
    },

    recordStageBlocked(runId: string, stageId: string, blockedBy: string): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (cannotBlock(stage.status)) return false;
      if (stage.status === "blocked") {
        if (stage.blockedByStageId === blockedBy) return false;
        stage.blockedByStageId = blockedBy;
      } else {
        stage.status = "blocked";
        stage.blockedByStageId = blockedBy;
        delete stage.awaitingInputSince;
      }
      _version++;
      notify();
      return true;
    },

    recordStageUnblocked(runId: string, stageId: string): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage || stage.status !== "blocked") return false;
      stage.status = "pending";
      delete stage.blockedByStageId;
      delete stage.awaitingInputSince;
      _version++;
      notify();
      return true;
    },

    recordStageNotice(runId: string, stageId: string, notice: StageNotice): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (!stage.notices) stage.notices = [];
      stage.notices.push(notice);
      _version++;
      notify();
      return true;
    },

    recordStagePaused(runId: string, stageId: string, pausedAt?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (cannotPause(stage.status)) return false;
      stage.status = "paused";
      stage.pausedAt = pausedAt ?? Date.now();
      stage.resumedAt = undefined;
      delete stage.awaitingInputSince;
      _version++;
      notify();
      return true;
    },

    recordStageResumed(runId: string, stageId: string, resumedAt?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      const stage = findStage(run, stageId);
      if (!stage) return false;
      if (stage.status !== "paused" && stage.status !== "blocked") return false;
      const resumedTs = resumedAt ?? Date.now();
      stage.status = "running";
      if (stage.startedAt !== undefined) {
        stage.pausedDurationMs = accumulatePausedDurationMs(
          stage.pausedDurationMs,
          stage.pausedAt,
          resumedTs,
        );
      }
      stage.resumedAt = resumedTs;
      stage.pausedAt = undefined;
      delete stage.blockedByStageId;
      delete stage.awaitingInputSince;
      _version++;
      notify();
      return true;
    },

    recordRunPaused(runId: string, pausedAt?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.status === "paused") return false;
      run.status = "paused";
      run.pausedAt = pausedAt ?? Date.now();
      run.resumedAt = undefined;
      _version++;
      notify();
      return true;
    },

    recordRunResumed(runId: string, resumedAt?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.status !== "paused") return false;
      const resumedTs = resumedAt ?? Date.now();
      run.status = "running";
      run.pausedDurationMs = accumulatePausedDurationMs(
        run.pausedDurationMs,
        run.pausedAt,
        resumedTs,
      );
      run.resumedAt = resumedTs;
      run.pausedAt = undefined;
      _version++;
      notify();
      return true;
    },

    clear(): void {
      if (
        _runs.length === 0 &&
        _notices.length === 0 &&
        _resolvers.size === 0 &&
        _stagePromptAnswers.size === 0 &&
        _stagePromptDrafts.size === 0
      ) return;
      _runs.length = 0;
      _notices.length = 0;
      // Reject any outstanding HIL waiters so background promises terminate
      // instead of leaking. The error message is intentionally generic — the
      // caller already issued a session boundary, exact cause isn't needed.
      for (const entry of _resolvers.values()) {
        entry.reject(new Error("atomic-workflows: store cleared"));
      }
      _resolvers.clear();
      _stagePromptAnswers.clear();
      _stagePromptDrafts.clear();
      _version++;
      notify();
    },

    snapshot,

    subscribe(fn: (snap: StoreSnapshot) => void): () => void {
      _listeners.add(fn);
      return () => {
        _listeners.delete(fn);
      };
    },
  };
}

export const store: Store = createStore();
