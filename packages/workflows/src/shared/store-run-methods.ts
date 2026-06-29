import type { WorkflowOutputValues } from "./types.js";
import type { Store, RunBlockedMetadata, RunEndMetadata, RunPauseMetadata } from "./store-public-types.js";
import type { RunSnapshot, RunStatus, StoreSnapshot, WorkflowNotice } from "./store-types.js";
import { accumulatePausedDurationMs, elapsedRunMs } from "./timing.js";
import { isTopLevelWorkflowRun } from "./run-visibility.js";
import {
  applyRunEndMetadata,
  clearRunFailureMetadata,
  clearStaleBlockedRunMetadata,
  TERMINAL_STATUSES,
  type StoreContext,
} from "./store-internal.js";

type RunStoreMethods = Pick<
  Store,
  | "runs"
  | "notices"
  | "activeRunId"
  | "recordRunStart"
  | "recordRunEnd"
  | "recordRunBlocked"
  | "removeRun"
  | "recordNotice"
  | "ackNotice"
  | "recordRunPaused"
  | "recordRunResumed"
  | "clear"
  | "snapshot"
  | "subscribe"
>;

export function createRunStoreMethods(context: StoreContext): RunStoreMethods {
  const { state } = context;

  return {
    runs(): readonly RunSnapshot[] {
      return state.runs;
    },

    notices(): readonly WorkflowNotice[] {
      return state.notices;
    },

    activeRunId(): string | null {
      // Most recently started top-level run that hasn't ended. Nested workflow runs stay in the
      // store for live control/expanded graph rendering, but should not steal the active slot.
      for (let i = state.runs.length - 1; i >= 0; i--) {
        const run = state.runs[i];
        if (run && isTopLevelWorkflowRun(run) && run.endedAt === undefined) {
          return run.id;
        }
      }
      // Degraded fallback: a child run is in flight but no top-level run is.
      for (let i = state.runs.length - 1; i >= 0; i--) {
        const run = state.runs[i];
        if (run && run.endedAt === undefined) {
          return run.id;
        }
      }
      return null;
    },

    recordRunStart(run: RunSnapshot): void {
      state.runs.push(run);
      context.bumpAndNotify();
    },

    recordRunEnd(
      runId: string,
      status: RunStatus,
      result?: WorkflowOutputValues,
      error?: string,
      metadata?: RunEndMetadata,
    ): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      run.status = status;
      run.endedAt = Date.now();
      if (run.pausedAt !== undefined) {
        run.pausedDurationMs = accumulatePausedDurationMs(run.pausedDurationMs, run.pausedAt, run.endedAt);
        run.pausedAt = undefined;
      }
      run.durationMs = elapsedRunMs(run, run.endedAt);
      if (result !== undefined && shouldStoreRunResult(status)) run.result = result;
      const wasBlocked = run.blockedAt !== undefined || run.failureDisposition === "active_blocked";
      delete run.blockedAt;
      if (status === "completed" || status === "skipped" || status === "cancelled" || status === "blocked") {
        clearRunFailureMetadata(run);
        if (status === "blocked" && error !== undefined) run.error = error;
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
      const pending = run.pendingPrompt;
      if (pending) {
        run.pendingPrompt = undefined;
        context.rejectPrompt(pending.id, `atomic-workflows: run ${runId} ended before prompt resolved`);
      }
      context.rejectAllStagePrompts(runId, run, `atomic-workflows: run ${runId} ended before prompt resolved`);
      context.bumpAndNotify();
      return true;
    },

    recordRunBlocked(runId: string, error: string, metadata: RunBlockedMetadata): boolean {
      const run = context.findRun(runId);
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
      context.bumpAndNotify();
      return true;
    },

    removeRun(runId: string): boolean {
      const index = state.runs.findIndex((r) => r.id === runId);
      if (index < 0) return false;
      const run = state.runs[index]!;
      const pending = run.pendingPrompt;
      if (pending) {
        context.rejectPrompt(pending.id, `atomic-workflows: run ${runId} was removed before prompt resolved`);
      }
      context.rejectAllStagePrompts(runId, run, `atomic-workflows: run ${runId} was removed before prompt resolved`);
      for (const stage of run.stages) {
        state.stagePromptAnswers.delete(context.stagePromptAnswerKey(runId, stage.id));
      }
      state.runs.splice(index, 1);
      for (let i = state.notices.length - 1; i >= 0; i--) {
        if (state.notices[i]?.runId === runId) state.notices.splice(i, 1);
      }
      context.bumpAndNotify();
      return true;
    },

    recordNotice(notice: WorkflowNotice): void {
      state.notices.push(notice);
      context.bumpAndNotify();
    },

    ackNotice(id: string): boolean {
      const notice = state.notices.find((n) => n.id === id);
      if (!notice || notice.ackedAt !== undefined) return false;
      notice.ackedAt = Date.now();
      context.bumpAndNotify();
      return true;
    },

    recordRunPaused(runId: string, pausedAt?: number, metadata?: RunPauseMetadata): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const wasPaused = run.status === "paused";
      if (!wasPaused) {
        run.status = "paused";
        run.pausedAt = pausedAt ?? Date.now();
        run.resumedAt = undefined;
      }
      if (metadata?.resumable !== undefined) run.resumable = metadata.resumable;
      if (metadata?.exitReason !== undefined) run.exitReason = metadata.exitReason;
      if (wasPaused && metadata === undefined) return false;
      context.bumpAndNotify();
      return true;
    },

    recordRunResumed(runId: string, resumedAt?: number): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      if (run.status !== "paused") return false;
      const resumedTs = resumedAt ?? Date.now();
      run.status = "running";
      run.pausedDurationMs = accumulatePausedDurationMs(run.pausedDurationMs, run.pausedAt, resumedTs);
      run.resumedAt = resumedTs;
      run.pausedAt = undefined;
      delete run.exitReason;
      context.bumpAndNotify();
      return true;
    },

    clear(): void {
      if (
        state.runs.length === 0 &&
        state.notices.length === 0 &&
        state.resolvers.size === 0 &&
        state.stagePromptAnswers.size === 0 &&
        state.stagePromptDrafts.size === 0
      ) return;
      state.runs.length = 0;
      state.notices.length = 0;
      for (const entry of state.resolvers.values()) {
        entry.reject(new Error("atomic-workflows: store cleared"));
      }
      state.resolvers.clear();
      state.stagePromptAnswers.clear();
      state.stagePromptDrafts.clear();
      context.bumpAndNotify();
    },

    snapshot(): StoreSnapshot {
      return context.snapshot();
    },

    subscribe(fn: (snap: StoreSnapshot) => void): () => void {
      state.listeners.add(fn);
      return () => {
        state.listeners.delete(fn);
      };
    },
  };
}

function shouldStoreRunResult(status: RunStatus): boolean {
  return status === "completed" || status === "skipped" || status === "cancelled" || status === "blocked" || status === "failed";
}
