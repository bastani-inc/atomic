import type { StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowExitOptions } from "../../shared/types.js";
import type { WorkflowExitCleanup } from "./executor-types.js";
import { workflowSerializableTypeName } from "../../shared/serializable.js";
import {
  captureWorkflowExitOutputSnapshot,
  describeWorkflowExitOptionValue,
  findWorkflowExitSignal,
  freezeWorkflowExitOutputSnapshot,
  isWorkflowExitStatus,
  makeWorkflowExitSignal,
  parentWorkflowExitAbortReason,
  readWorkflowExitOption,
  type WorkflowExitSignal,
} from "./executor-abort.js";

export interface WorkflowExitAbortReason {
  readonly reason?: string;
}

export interface WorkflowExitManager {
  readonly exitScope: symbol;
  getSelectedExit(): WorkflowExitSignal | undefined;
  currentWorkflowExitAbortReason(): WorkflowExitAbortReason | undefined;
  workflowExitSkippedReason(reason?: string): string;
  isWorkflowExitSkippedReason(reason: string | undefined): boolean;
  preserveWorkflowExitSkippedReason(stage: StageSnapshot, fallback: string): void;
  registerWorkflowExitCleanup(stageId: string, cleanup: WorkflowExitCleanup): () => void;
  runWorkflowExitCleanups(reason?: string): void;
  drainWorkflowExitCleanups(reason?: string): Promise<void>;
  throwIfWorkflowExitSelected(): void;
  exit(options?: WorkflowExitOptions): never;
}

export function createWorkflowExitManager(input: {
  readonly runId: string;
  readonly exitScope: symbol;
  readonly controller: AbortController;
}): WorkflowExitManager {
  let selectedExit: WorkflowExitSignal | undefined;
  const exitCleanups = new Map<string, WorkflowExitCleanup>();
  const workflowExitCleanupPromises = new Set<Promise<void>>();

  const workflowExitSkippedReason = (reason?: string): string =>
    reason === undefined || reason.length === 0 ? "workflow-exit" : `workflow-exit: ${reason}`;
  const isWorkflowExitSkippedReason = (reason: string | undefined): boolean =>
    reason === "workflow-exit" || reason?.startsWith("workflow-exit: ") === true;
  const currentWorkflowExitAbortReason = (): WorkflowExitAbortReason | undefined => {
    const scopedExit = selectedExit ?? findWorkflowExitSignal(input.controller.signal.reason, input.exitScope);
    if (scopedExit !== undefined) {
      return scopedExit.reason === undefined ? {} : { reason: scopedExit.reason };
    }
    const parentExit = parentWorkflowExitAbortReason(input.controller.signal.reason);
    if (parentExit !== undefined) {
      return parentExit.workflowExitReason === undefined ? {} : { reason: parentExit.workflowExitReason };
    }
    return undefined;
  };
  const preserveWorkflowExitSkippedReason = (stage: StageSnapshot, fallback: string): void => {
    if (isWorkflowExitSkippedReason(stage.skippedReason)) return;
    const workflowExitAbort = currentWorkflowExitAbortReason();
    stage.skippedReason = workflowExitAbort !== undefined
      ? workflowExitSkippedReason(workflowExitAbort.reason)
      : fallback;
  };
  const trackWorkflowExitCleanup = (operation: void | Promise<void>): void => {
    if (operation === undefined) return;
    let tracked: Promise<void>;
    tracked = Promise.resolve(operation)
      .catch(() => {
        // Cleanup is best-effort and must never convert ctx.exit into failure.
      })
      .finally(() => {
        workflowExitCleanupPromises.delete(tracked);
      });
    workflowExitCleanupPromises.add(tracked);
  };
  const invokeWorkflowExitCleanup = (cleanup: WorkflowExitCleanup, reason?: string): void => {
    try {
      trackWorkflowExitCleanup(cleanup.skipForWorkflowExit(reason));
    } catch (err) {
      trackWorkflowExitCleanup(Promise.reject(err));
    }
  };
  const registerWorkflowExitCleanup = (stageId: string, cleanup: WorkflowExitCleanup): (() => void) => {
    if (selectedExit !== undefined) {
      invokeWorkflowExitCleanup(cleanup, selectedExit.reason);
      return () => undefined;
    }
    exitCleanups.set(stageId, cleanup);
    return () => {
      if (exitCleanups.get(stageId) === cleanup) exitCleanups.delete(stageId);
    };
  };
  const runWorkflowExitCleanups = (reason?: string): void => {
    for (const cleanup of [...exitCleanups.values()]) invokeWorkflowExitCleanup(cleanup, reason);
  };
  const drainWorkflowExitCleanups = async (reason?: string): Promise<void> => {
    runWorkflowExitCleanups(reason);
    while (workflowExitCleanupPromises.size > 0) {
      await Promise.all([...workflowExitCleanupPromises]);
    }
  };
  const throwIfWorkflowExitSelected = (): void => {
    if (selectedExit !== undefined) {
      if (!input.controller.signal.aborted) input.controller.abort(selectedExit);
      runWorkflowExitCleanups(selectedExit.reason);
      throw selectedExit;
    }
    if (input.controller.signal.aborted) {
      throw input.controller.signal.reason ?? new DOMException("workflow killed", "AbortError");
    }
  };

  const exit = (options?: WorkflowExitOptions): never => {
    if (selectedExit !== undefined) {
      if (!input.controller.signal.aborted) input.controller.abort(selectedExit);
      runWorkflowExitCleanups(selectedExit.reason);
      throw selectedExit;
    }
    if (input.controller.signal.aborted) {
      throw input.controller.signal.reason ?? new DOMException("workflow killed", "AbortError");
    }

    const throwNestedSelectedExit = (): void => {
      if (selectedExit === undefined) return;
      if (!input.controller.signal.aborted) input.controller.abort(selectedExit);
      runWorkflowExitCleanups(selectedExit.reason);
      throw selectedExit;
    };
    const rawOptions = options as Pick<WorkflowExitOptions, "status" | "reason" | "outputs"> | null | undefined;
    let validationError: Error | undefined;
    const captureValidationError = (error: Error): void => {
      validationError ??= error;
    };

    const statusRead = readWorkflowExitOption(rawOptions, "status");
    throwNestedSelectedExit();
    const rawStatus = statusRead.ok ? statusRead.value ?? "completed" : "completed";
    if (!statusRead.ok) {
      captureValidationError(statusRead.error);
    } else if (!isWorkflowExitStatus(rawStatus)) {
      captureValidationError(new TypeError(
        `atomic-workflows: ctx.exit() status must be one of completed, skipped, cancelled, blocked; got ${describeWorkflowExitOptionValue(rawStatus)}`,
      ));
    }
    const status = isWorkflowExitStatus(rawStatus) ? rawStatus : "completed";

    const reasonRead = readWorkflowExitOption(rawOptions, "reason");
    throwNestedSelectedExit();
    const rawReason = reasonRead.ok ? reasonRead.value : undefined;
    if (!reasonRead.ok) {
      captureValidationError(reasonRead.error);
    } else if (rawReason !== undefined && typeof rawReason !== "string") {
      captureValidationError(new TypeError(
        `atomic-workflows: ctx.exit() reason must be a string when provided; got ${workflowSerializableTypeName(rawReason)}`,
      ));
    }
    const reason = typeof rawReason === "string" ? rawReason : undefined;

    const outputsRead = readWorkflowExitOption(rawOptions, "outputs");
    throwNestedSelectedExit();
    const outputSnapshot = !outputsRead.ok
      ? freezeWorkflowExitOutputSnapshot({ ok: false, error: outputsRead.error })
      : outputsRead.value !== undefined
        ? captureWorkflowExitOutputSnapshot(outputsRead.value)
        : undefined;
    throwNestedSelectedExit();

    selectedExit = Object.freeze(makeWorkflowExitSignal({
      scope: input.exitScope,
      status,
      ...(reason !== undefined ? { reason } : {}),
      ...(outputSnapshot !== undefined ? { outputSnapshot } : {}),
      ...(validationError !== undefined ? { validationError } : {}),
    }));
    input.controller.abort(selectedExit);
    runWorkflowExitCleanups(reason);
    throw selectedExit;
  };

  return {
    exitScope: input.exitScope,
    getSelectedExit: () => selectedExit,
    currentWorkflowExitAbortReason,
    workflowExitSkippedReason,
    isWorkflowExitSkippedReason,
    preserveWorkflowExitSkippedReason,
    registerWorkflowExitCleanup,
    runWorkflowExitCleanups,
    drainWorkflowExitCleanups,
    throwIfWorkflowExitSelected,
    exit,
  };
}
