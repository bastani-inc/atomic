import type { RunSnapshot, StageSnapshot, WorkflowChildReplaySnapshot, WorkflowChildRunRef } from "../../shared/store-types.js";
import type { Store } from "../../shared/store.js";
import type { WorkflowChildResult } from "../../shared/types.js";
import { appendStageEnd, appendStageStart } from "../../shared/persistence-session-entries.js";
import { elapsedStageMs } from "../../shared/timing.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { EngineWorkflowBoundaryOptions } from "../../engine/options.js";
import type { ContinuationReplayIndex } from "./executor-continuation.js";
import { sameStringSet } from "./executor-continuation.js";
import { applyFailureToStage, stageReplayFields } from "./executor-lifecycle.js";
import { cloneWorkflowChildReplaySnapshot, cloneWorkflowChildValue } from "./executor-child-helpers.js";
import type { GraphFrontierTracker } from "../../engine/graph-inference.js";
import type { WorkflowExitCleanup } from "./executor-types.js";
import { makeParentWorkflowExitAbortReason } from "./executor-abort.js";

interface LinkedChildWorkflowExitState {
  readonly ref: WorkflowChildRunRef;
  readonly controller: AbortController;
  runPromise?: Promise<unknown>;
}

export interface WorkflowBoundaryStage {
  readonly id: string;
  readonly replayedChild?: WorkflowChildResult;
  finalizeReplay(): void;
  linkChildRun(ref: WorkflowChildRunRef, childController: AbortController): void;
  observeChildRun(promise: Promise<unknown>): void;
  complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): void;
  skipForWorkflowExit(reason?: string): Promise<void>;
  fail(error: unknown): void;
}

function workflowChildResultFromReplay(snapshot: WorkflowChildReplaySnapshot): WorkflowChildResult {
  const outputs = cloneWorkflowChildValue(snapshot.outputs);
  if (snapshot.exited === true || snapshot.status !== "completed") {
    return {
      workflow: snapshot.workflow,
      runId: snapshot.runId,
      status: snapshot.status,
      exited: true,
      outputs,
      ...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
    };
  }
  return {
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    status: "completed",
    exited: false,
    outputs,
  };
}

function requestLinkedChildWorkflowExit(linkedChild: LinkedChildWorkflowExitState, reason?: string): void {
  if (!linkedChild.controller.signal.aborted) {
    linkedChild.controller.abort(makeParentWorkflowExitAbortReason(reason));
  }
}

async function waitForLinkedChildWorkflowExit(linkedChild: LinkedChildWorkflowExitState): Promise<void> {
  const childRun = linkedChild.runPromise;
  if (childRun === undefined) return;
  try {
    await childRun;
  } catch {
    // Parent exit cleanup intentionally swallows child teardown failures.
  }
}

export function createWorkflowBoundaryFactory(input: {
  readonly runId: string;
  readonly runSnapshot: RunSnapshot;
  readonly activeStore: Store;
  readonly opts: EngineWorkflowBoundaryOptions;
  readonly tracker: GraphFrontierTracker;
  readonly replayIndex: ContinuationReplayIndex;
  readonly registerWorkflowExitCleanup: (stageId: string, cleanup: WorkflowExitCleanup) => () => void;
  readonly workflowExitSkippedReason: (reason?: string) => string;
  readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
}): (name: string, replayKey: string) => WorkflowBoundaryStage {
  return (name: string, replayKey: string): WorkflowBoundaryStage => {
    const stageId = crypto.randomUUID();
    const provisionalParentIds = input.tracker.onSpawn(stageId, name);
    const replayDecision = input.replayIndex.decide({
      displayName: name,
      replayKey,
      parentIds: provisionalParentIds,
      stageId,
      kind: "workflow",
    });
    const parentIds = replayDecision.parentIds;
    if (!sameStringSet(parentIds, provisionalParentIds)) input.tracker.replaceParents(stageId, parentIds);
    const replaySource = replayDecision.source;
    const replayChildSnapshot = replayDecision.kind === "replay" ? replayDecision.source.workflowChild : undefined;
    const replayedChild = replayChildSnapshot !== undefined ? workflowChildResultFromReplay(replayChildSnapshot) : undefined;
    const startedAt = Date.now();
    const stageSnapshot: StageSnapshot = {
      id: stageId,
      name,
      replayKey,
      status: replayedChild !== undefined ? "completed" : "running",
      parentIds: Object.freeze([...parentIds]),
      startedAt,
      toolEvents: [],
      attachable: false,
      ...(replaySource !== undefined ? { replayedFromStageId: replaySource.id, replayed: replayedChild !== undefined } : {}),
      ...(replayedChild !== undefined && replayChildSnapshot !== undefined ? {
        endedAt: startedAt,
        durationMs: 0,
        ...(replayDecision.kind === "replay" && replayDecision.source.result !== undefined ? { result: replayDecision.source.result } : {}),
        workflowChild: cloneWorkflowChildReplaySnapshot(replayChildSnapshot),
      } : {}),
    };
    let finalized = false;
    let unregisterWorkflowExitCleanup = (): void => {};
    let linkedChild: LinkedChildWorkflowExitState | undefined;

    const appendStageStartOnce = (): void => {
      if (!input.opts.persistence) return;
      appendStageStart(input.opts.persistence, {
        runId: input.runId,
        stageId,
        name,
        parentIds: stageSnapshot.parentIds,
        ...stageReplayFields(stageSnapshot),
        ts: startedAt,
      });
    };

    const appendStageEndForSnapshot = (): void => {
      if (!input.opts.persistence) return;
      appendStageEnd(input.opts.persistence, {
        runId: input.runId,
        stageId,
        status: stageSnapshot.status,
        durationMs: stageSnapshot.durationMs,
        ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
        ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
        ...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
        ...(stageSnapshot.failureRecoverability !== undefined ? { failureRecoverability: stageSnapshot.failureRecoverability } : {}),
        ...(stageSnapshot.failureDisposition !== undefined ? { failureDisposition: stageSnapshot.failureDisposition } : {}),
        ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
        ...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
        ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
        ...(stageSnapshot.sessionId !== undefined ? { sessionId: stageSnapshot.sessionId } : {}),
        ...(stageSnapshot.sessionFile !== undefined ? { sessionFile: stageSnapshot.sessionFile } : {}),
        ...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed" ? { summary: stageSnapshot.result } : {}),
        ...stageReplayFields(stageSnapshot),
        ...(stageSnapshot.status === "completed" && stageSnapshot.workflowChild !== undefined ? { workflowChild: stageSnapshot.workflowChild } : {}),
      });
    };

    const clearBoundaryChildMetadata = (): void => {
      delete stageSnapshot.workflowChildRun;
      delete stageSnapshot.workflowChild;
    };

    const finalize = (status: "completed" | "failed" | "skipped", summaryOrError: string, workflowChild?: WorkflowChildReplaySnapshot, failureError?: unknown): void => {
      if (finalized) return;
      finalized = true;
      unregisterWorkflowExitCleanup();
      stageSnapshot.status = status;
      if (status === "completed") {
        stageSnapshot.result = summaryOrError;
        if (workflowChild !== undefined) stageSnapshot.workflowChild = workflowChild;
      } else if (status === "skipped") {
        clearBoundaryChildMetadata();
        stageSnapshot.skippedReason = summaryOrError;
      } else {
        clearBoundaryChildMetadata();
        applyFailureToStage(stageSnapshot, input.classifyExecutorFailure(failureError));
      }
      stageSnapshot.endedAt = Date.now();
      stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
      input.activeStore.recordStageEnd(input.runId, stageSnapshot);
      input.opts.onStageEnd?.(input.runId, stageSnapshot);
      appendStageEndForSnapshot();
      input.tracker.onSettle(stageId);
    };

    input.activeStore.recordStageStart(input.runId, stageSnapshot);
    input.opts.onStageStart?.(input.runId, stageSnapshot);
    appendStageStartOnce();

    unregisterWorkflowExitCleanup = input.registerWorkflowExitCleanup(stageId, {
      async skipForWorkflowExit(reason?: string): Promise<void> {
        const child = linkedChild;
        if (child !== undefined) requestLinkedChildWorkflowExit(child, reason);
        finalize("skipped", input.workflowExitSkippedReason(reason));
        if (child !== undefined) await waitForLinkedChildWorkflowExit(child);
      },
    });

    const finalizeReplay = (): void => {
      if (replayedChild === undefined || finalized) return;
      finalized = true;
      unregisterWorkflowExitCleanup();
      input.activeStore.recordStageEnd(input.runId, stageSnapshot);
      input.opts.onStageEnd?.(input.runId, stageSnapshot);
      appendStageEndForSnapshot();
      input.tracker.onSettle(stageId);
    };

    return {
      id: stageId,
      ...(replayedChild !== undefined ? { replayedChild } : {}),
      finalizeReplay,
      linkChildRun(ref: WorkflowChildRunRef, childController: AbortController): void {
        if (finalized) return;
        linkedChild = { ref: { ...ref }, controller: childController };
        stageSnapshot.workflowChildRun = { ...ref };
        input.activeStore.recordStageWorkflowChildRun(input.runId, stageId, ref);
      },
      observeChildRun(promise: Promise<unknown>): void {
        if (linkedChild === undefined || finalized) return;
        linkedChild.runPromise = promise;
      },
      complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): void {
        finalize("completed", summary, workflowChild);
      },
      async skipForWorkflowExit(reason?: string): Promise<void> {
        const child = linkedChild;
        if (child !== undefined) requestLinkedChildWorkflowExit(child, reason);
        finalize("skipped", input.workflowExitSkippedReason(reason));
        if (child !== undefined) await waitForLinkedChildWorkflowExit(child);
      },
      fail(error: unknown): void {
        finalize("failed", error instanceof Error ? error.message : String(error), undefined, error);
      },
    };
  };
}
