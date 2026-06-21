import type { RunSnapshot } from "../../shared/store-types.js";
import type { Store } from "../../shared/store.js";
import type { WorkflowDefinition, WorkflowOutputValues } from "../../shared/types.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import type { ParentWorkflowExitAbortProbe, WorkflowExitSignal } from "./executor-abort.js";
import { parentWorkflowExitRunReason } from "./executor-abort.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import {
  appendRunEndWhenRecorded,
  reconcileTerminalRunResult,
  runFailureMetadata,
} from "./executor-lifecycle.js";
import {
  assertWorkflowExitOutputs,
  normalizeWorkflowExitOutput,
} from "./executor-outputs.js";

export interface RunFinalizers {
  finalizeWorkflowExit(signal: WorkflowExitSignal): Promise<RunResult>;
  finalizeParentWorkflowExitCancellation(abortReason: ParentWorkflowExitAbortProbe): Promise<RunResult>;
}

export function createRunFinalizers(input: {
  readonly def: WorkflowDefinition;
  readonly runId: string;
  readonly runSnapshot: RunSnapshot;
  readonly activeStore: Store;
  readonly opts: RunOpts;
  readonly classifyExecutorFailure: (error: unknown) => WorkflowFailure;
  readonly drainWorkflowExitCleanups: (reason?: string) => Promise<void>;
}): RunFinalizers {
  const finalizeWorkflowExitValidationFailure = (err: unknown, exitReason?: string): RunResult => {
    const failure = input.classifyExecutorFailure(err);
    const classifiedMetadata = runFailureMetadata(failure, input.runSnapshot.stages);
    const metadata = {
      ...classifiedMetadata,
      resumable: false,
      ...(exitReason !== undefined ? { exitReason } : {}),
    } as const;
    const recorded = input.activeStore.recordRunEnd(input.runId, "failed", undefined, metadata.errorMessage, metadata);
    appendRunEndWhenRecorded(input.opts.persistence, recorded, {
      runId: input.runId,
      status: "failed",
      error: metadata.errorMessage,
      failureKind: metadata.failureKind,
      ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
      ...(metadata.failureRecoverability !== undefined ? { failureRecoverability: metadata.failureRecoverability } : {}),
      ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
      failureMessage: metadata.failureMessage,
      ...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
      resumable: false,
      ...(metadata.exitReason !== undefined ? { exitReason: metadata.exitReason } : {}),
      ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(input.runId, input.runSnapshot, input.activeStore, {
      status: "failed",
      error: metadata.errorMessage,
      ...(metadata.exitReason !== undefined ? { exitReason: metadata.exitReason } : {}),
    }, input.opts.onRunEnd);
  };

  const finalizeWorkflowExit = async (signal: WorkflowExitSignal): Promise<RunResult> => {
    await input.drainWorkflowExitCleanups(signal.reason);
    if (signal.validationError !== undefined) {
      return finalizeWorkflowExitValidationFailure(signal.validationError, signal.reason);
    }

    let outputs: WorkflowOutputValues | undefined;
    try {
      outputs = normalizeWorkflowExitOutput(input.def.name, signal.outputSnapshot);
      assertWorkflowExitOutputs(input.def.name, outputs, input.def.outputs);
    } catch (err) {
      return finalizeWorkflowExitValidationFailure(err, signal.reason);
    }

    const metadata = {
      resumable: false,
      exited: true,
      ...(signal.reason !== undefined ? { exitReason: signal.reason } : {}),
    } as const;
    const recorded = input.activeStore.recordRunEnd(input.runId, signal.status, outputs, undefined, metadata);
    appendRunEndWhenRecorded(input.opts.persistence, recorded, {
      runId: input.runId,
      status: signal.status,
      result: outputs,
      exited: true,
      ...(signal.reason !== undefined ? { exitReason: signal.reason } : {}),
      resumable: false,
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(input.runId, input.runSnapshot, input.activeStore, {
      status: signal.status,
      result: outputs,
      exited: true,
      ...(signal.reason !== undefined ? { exitReason: signal.reason } : {}),
    }, input.opts.onRunEnd);
  };

  const finalizeParentWorkflowExitCancellation = async (abortReason: ParentWorkflowExitAbortProbe): Promise<RunResult> => {
    const parentReason = abortReason.workflowExitReason;
    await input.drainWorkflowExitCleanups(parentReason);
    const exitReason = parentWorkflowExitRunReason(parentReason);
    const metadata = { resumable: false, exited: true, exitReason } as const;
    const recorded = input.activeStore.recordRunEnd(input.runId, "cancelled", undefined, undefined, metadata);
    appendRunEndWhenRecorded(input.opts.persistence, recorded, {
      runId: input.runId,
      status: "cancelled",
      exited: true,
      exitReason,
      resumable: false,
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(input.runId, input.runSnapshot, input.activeStore, {
      status: "cancelled",
      exited: true,
      exitReason,
    }, input.opts.onRunEnd);
  };

  return { finalizeWorkflowExit, finalizeParentWorkflowExitCancellation };
}
