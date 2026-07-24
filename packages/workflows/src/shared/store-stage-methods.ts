import type { Store } from "./store-public-types.js";
import type {
  StageInputRequest,
  StageNotice,
  StageSnapshot,
  ToolEvent,
  WorkflowChildRunRef,
} from "./store-types.js";
import { accumulatePausedDurationMs } from "./timing.js";
import { nextExecutionOrder } from "./store-tool-node-methods.js";
import {
  cannotAwaitInput,
  cannotBlock,
  cannotPause,
  isTerminalStageStatus,
  TERMINAL_STATUSES,
  type StoreContext,
} from "./store-internal.js";

type StageStoreMethods = Pick<
  Store,
  | "recordStageStart"
  | "recordStageWorkflowChildRun"
  | "recordToolStart"
  | "recordToolEnd"
  | "recordStageEnd"
  | "recordStageSession"
  | "recordStageAttachable"
  | "recordStageAttached"
  | "recordStageAwaitingInput"
  | "recordStageInputRequest"
  | "clearStageInputRequest"
  | "recordStageBlocked"
  | "recordStageUnblocked"
  | "recordStageNotice"
  | "recordStagePaused"
  | "recordStageResumed"
>;

export function createStageStoreMethods(context: StoreContext): StageStoreMethods {
  return {
    recordStageStart(runId: string, stage: StageSnapshot): void {
      const run = context.findRun(runId);
      if (!run) return;
      if (stage.executionOrder === undefined) stage.executionOrder = nextExecutionOrder(run);
      if (!run.stages.some((s) => s.id === stage.id)) {
        run.stages.push(stage);
      }
      context.bumpAndNotify();
    },

    recordStageWorkflowChildRun(runId: string, stageId: string, ref: WorkflowChildRunRef): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (
        stage.workflowChildRun?.runId === ref.runId &&
        stage.workflowChildRun.alias === ref.alias &&
        stage.workflowChildRun.workflow === ref.workflow
      ) return false;
      stage.workflowChildRun = { ...ref };
      context.bumpAndNotify();
      return true;
    },

    recordToolStart(runId: string, stageId: string, evt: ToolEvent): void {
      const run = context.findRun(runId);
      if (!run) return;
      const stage = context.findStage(run, stageId);
      if (!stage) return;
      const exists = stage.toolEvents.some((e) => e.name === evt.name && e.startedAt === evt.startedAt);
      if (!exists) {
        stage.toolEvents.push(evt);
      }
      context.bumpAndNotify();
    },

    recordToolEnd(runId: string, stageId: string, evt: ToolEvent): void {
      const run = context.findRun(runId);
      if (!run) return;
      const stage = context.findStage(run, stageId);
      if (!stage) return;
      const existing = stage.toolEvents.find((e) => e.name === evt.name && e.startedAt === evt.startedAt);
      if (existing) {
        existing.endedAt = evt.endedAt;
        existing.output = evt.output;
      }
      context.bumpAndNotify();
    },

    recordStageEnd(runId: string, stage: StageSnapshot): void {
      const run = context.findRun(runId);
      if (!run) return;
      const existing = context.findStage(run, stage.id);
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
      if (stage.sessionId !== undefined) existing.sessionId = stage.sessionId;
      if (stage.sessionFile !== undefined) existing.sessionFile = stage.sessionFile;
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
      context.rejectStagePrompt(runId, existing, `atomic-workflows: stage ${stage.id} ended before prompt resolved`);
      context.bumpAndNotify();
    },

    recordStageSession(runId: string, stageId: string, session: { sessionId?: string; sessionFile?: string }): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
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
      context.bumpAndNotify();
      return true;
    },

    recordStageAttachable(runId: string, stageId: string, attachable: boolean): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      const next = attachable === true ? true : undefined;
      if (stage.attachable === next) return false;
      if (next === undefined) {
        delete stage.attachable;
      } else {
        stage.attachable = next;
      }
      context.bumpAndNotify();
      return true;
    },

    recordStageAttached(runId: string, stageId: string, attached: boolean): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      const next = attached === true ? true : undefined;
      if (stage.attached === next) return false;
      if (next === undefined) {
        delete stage.attached;
      } else {
        stage.attached = next;
      }
      context.bumpAndNotify();
      return true;
    },

    recordStageAwaitingInput(runId: string, stageId: string, awaiting: boolean, ts?: number): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
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
      context.bumpAndNotify();
      return true;
    },

    recordStageInputRequest(runId: string, stageId: string, request: StageInputRequest): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (isTerminalStageStatus(stage.status)) return false;
      if (stage.inputRequest?.id === request.id) return false;
      stage.inputRequest = { ...request };
      context.bumpAndNotify();
      return true;
    },

    clearStageInputRequest(runId: string, stageId: string): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage || stage.inputRequest === undefined) return false;
      delete stage.inputRequest;
      context.bumpAndNotify();
      return true;
    },

    recordStageBlocked(runId: string, stageId: string, blockedBy: string): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
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
      context.bumpAndNotify();
      return true;
    },

    recordStageUnblocked(runId: string, stageId: string): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage || stage.status !== "blocked") return false;
      stage.status = "pending";
      delete stage.blockedByStageId;
      delete stage.awaitingInputSince;
      context.bumpAndNotify();
      return true;
    },

    recordStageNotice(runId: string, stageId: string, notice: StageNotice): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (!stage.notices) stage.notices = [];
      stage.notices.push(notice);
      context.bumpAndNotify();
      return true;
    },

    recordStagePaused(runId: string, stageId: string, pausedAt?: number): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (cannotPause(stage.status)) return false;
      stage.status = "paused";
      stage.pausedAt = pausedAt ?? Date.now();
      stage.resumedAt = undefined;
      delete stage.awaitingInputSince;
      context.bumpAndNotify();
      return true;
    },

    recordStageResumed(runId: string, stageId: string, resumedAt?: number): boolean {
      const run = context.findRun(runId);
      if (!run) return false;
      if (TERMINAL_STATUSES.has(run.status)) return false;
      const stage = context.findStage(run, stageId);
      if (!stage) return false;
      if (stage.status !== "paused" && stage.status !== "blocked") return false;
      const resumedTs = resumedAt ?? Date.now();
      stage.status = "running";
      if (stage.startedAt !== undefined) {
        stage.pausedDurationMs = accumulatePausedDurationMs(stage.pausedDurationMs, stage.pausedAt, resumedTs);
      }
      stage.resumedAt = resumedTs;
      stage.pausedAt = undefined;
      delete stage.blockedByStageId;
      delete stage.awaitingInputSince;
      context.bumpAndNotify();
      return true;
    },
  };
}
