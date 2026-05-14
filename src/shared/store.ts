/**
 * Plain mutable singleton store with subscribe/version counter.
 * cross-ref: spec §5.5
 */

import type {
  PendingPrompt,
  RunSnapshot,
  StageSnapshot,
  StageNotice,
  StoreSnapshot,
  ToolEvent,
  RunStatus,
  WorkflowNotice,
} from "./store-types.js";

/** Statuses that represent a terminal run state — cannot be overwritten. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "killed"]);

export interface Store {
  runs(): readonly RunSnapshot[];
  notices(): readonly WorkflowNotice[];
  activeRunId(): string | null;
  recordRunStart(run: RunSnapshot): void;
  recordStageStart(runId: string, stage: StageSnapshot): void;
  recordToolStart(runId: string, stageId: string, evt: ToolEvent): void;
  recordToolEnd(runId: string, stageId: string, evt: ToolEvent): void;
  recordStageEnd(runId: string, stage: StageSnapshot): void;
  /**
   * Records the end of a run.
   * Returns `true` if state changed, `false` if the run was not found or
   * already in a terminal state (completed | failed | killed).
   * `result` is only applied for status "completed".
   * `error` is only applied for status "failed" | "killed".
   */
  recordRunEnd(
    runId: string,
    status: RunStatus,
    result?: Record<string, unknown>,
    error?: string,
  ): boolean;
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
   * a live `StageControlHandle` currently exists in the stage-control
   * registry, which the attach UI uses to decide whether a stage's
   * chat surface is interactive or inspect-only.
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

  return {
    runs(): readonly RunSnapshot[] {
      return _runs;
    },

    notices(): readonly WorkflowNotice[] {
      return _notices;
    },

    activeRunId(): string | null {
      // Most recently started run that hasn't ended
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
      existing.durationMs = stage.durationMs;
      existing.result = stage.result;
      existing.error = stage.error;
      delete existing.awaitingInputSince;
      _version++;
      notify();
    },

    recordRunEnd(
      runId: string,
      status: RunStatus,
      result?: Record<string, unknown>,
      error?: string,
    ): boolean {
      const run = findRun(runId);
      if (!run) return false;
      // Terminal guard — once in a terminal state, refuse overwrite.
      if (TERMINAL_STATUSES.has(run.status)) return false;
      run.status = status;
      run.endedAt = Date.now();
      run.durationMs = run.endedAt - run.startedAt;
      if (status === "completed" && result !== undefined) {
        run.result = result;
      }
      if ((status === "failed" || status === "killed") && error !== undefined) {
        run.error = error;
      }
      // Abandon any waiting HIL prompt — workflow body never resumed past
      // it, but the awaiter promise must reject so the executor's catch
      // can finalise the run state cleanly.
      const pending = run.pendingPrompt;
      if (pending) {
        run.pendingPrompt = undefined;
        const entry = _resolvers.get(pending.id);
        if (entry) {
          _resolvers.delete(pending.id);
          entry.reject(
            new Error(`pi-workflows: run ${runId} ended before prompt resolved`),
          );
        }
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
          reject(new Error(`pi-workflows: run "${runId}" not found`));
          return;
        }
        const pending = run.pendingPrompt;
        if (!pending || pending.id !== promptId) {
          reject(
            new Error(
              `pi-workflows: pending prompt "${promptId}" not registered on run "${runId}"`,
            ),
          );
          return;
        }
        _resolvers.set(promptId, { promptId, resolve, reject });
      });
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
      if (stage.status === "completed" || stage.status === "failed" || stage.status === "paused" || stage.status === "blocked") return false;

      if (awaiting) {
        if (stage.status === "awaiting_input") return false;
        stage.status = "awaiting_input";
        stage.awaitingInputSince = ts ?? Date.now();
      } else {
        if (stage.status !== "awaiting_input") return false;
        stage.status = "running";
        delete stage.awaitingInputSince;
      }
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
      if (stage.status === "completed" || stage.status === "failed" || stage.status === "paused") return false;
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
      if (stage.status === "paused" || stage.status === "blocked" || stage.status === "completed" || stage.status === "failed") return false;
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
      stage.status = "running";
      stage.resumedAt = resumedAt ?? Date.now();
      stage.pausedAt = undefined;
      delete stage.blockedByStageId;
      delete stage.awaitingInputSince;
      _version++;
      notify();
      return true;
    },

    recordRunPaused(runId: string, _pausedAt?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.status === "paused") return false;
      run.status = "paused";
      _version++;
      notify();
      return true;
    },

    recordRunResumed(runId: string, _resumedAt?: number): boolean {
      const run = findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.status !== "paused") return false;
      run.status = "running";
      _version++;
      notify();
      return true;
    },

    clear(): void {
      if (_runs.length === 0 && _notices.length === 0 && _resolvers.size === 0) return;
      _runs.length = 0;
      _notices.length = 0;
      // Reject any outstanding HIL waiters so background promises terminate
      // instead of leaking. The error message is intentionally generic — the
      // caller already issued a session boundary, exact cause isn't needed.
      for (const entry of _resolvers.values()) {
        entry.reject(new Error("pi-workflows: store cleared"));
      }
      _resolvers.clear();
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
