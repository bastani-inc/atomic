import type {
  WorkflowChildResult,
  WorkflowDefinition,
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRunChildOptions,
} from "../../shared/types.js";
import type { WorkflowChildRunRef } from "../../shared/store-types.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import type { WorkflowExitManager } from "./executor-exit-manager.js";
import type { WorkflowBoundaryStage } from "./executor-child-boundary.js";
import { findWorkflowExitSignal, isWorkflowExitStatus, makeParentWorkflowExitAbortReason } from "./executor-abort.js";
import { selectWorkflowOutputs } from "./executor-outputs.js";
import { resolveAndValidateInputs } from "./executor-inputs.js";
import {
  isWorkflowDefinition,
  workflowChildReplaySnapshot,
  workflowDefinitionRequirementMessage,
} from "./executor-child-helpers.js";

export function createChildWorkflowRunner(input: {
  readonly runId: string;
  readonly depth: number;
  readonly opts: RunOpts;
  readonly exit: WorkflowExitManager;
  readonly ownController: AbortController;
  readonly resolveWorkflowCwd: () => string;
  readonly nextWorkflowBoundaryReplayKey: (name: string) => string;
  readonly startWorkflowBoundaryStage: (name: string, replayKey: string) => WorkflowBoundaryStage;
  readonly runWorkflow: <TInputs extends WorkflowInputValues>(
    def: WorkflowDefinition<TInputs>,
    inputs: Readonly<Record<string, unknown>>,
    opts?: RunOpts,
  ) => Promise<RunResult>;
}): <TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
  child: WorkflowDefinition<TChildInputs, TChildOutputs>,
  options?: WorkflowRunChildOptions<TChildInputs>,
) => Promise<WorkflowChildResult<TChildOutputs>> {
  return async <TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
    child: WorkflowDefinition<TChildInputs, TChildOutputs>,
    options: WorkflowRunChildOptions<TChildInputs> = {},
  ): Promise<WorkflowChildResult<TChildOutputs>> => {
    input.exit.throwIfWorkflowExitSelected();
    if (!isWorkflowDefinition(child)) throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
    const childName = child.normalizedName;
    const boundaryName = options.stageName ?? `workflow:${childName}`;
    const boundaryReplayKey = input.nextWorkflowBoundaryReplayKey(boundaryName);
    const boundary = input.startWorkflowBoundaryStage(boundaryName, boundaryReplayKey);
    let childRunId: string | undefined;
    let detachParentAbort: (() => void) | undefined;
    try {
      if (boundary.replayedChild !== undefined) {
        await Promise.resolve();
        input.exit.throwIfWorkflowExitSelected();
        boundary.finalizeReplay();
        return boundary.replayedChild as WorkflowChildResult<TChildOutputs>;
      }

      const childInputs = resolveAndValidateInputs(child.inputs, options.inputs ?? {}, `child workflow "${childName}" (${child.name})`);
      input.exit.throwIfWorkflowExitSelected();

      childRunId = crypto.randomUUID();
      const childController = new AbortController();
      const childRef: WorkflowChildRunRef = { alias: childName, workflow: child.normalizedName, runId: childRunId };
      boundary.linkChildRun(childRef, childController);

      const abortChildFromParent = (): void => {
        const parentExit = findWorkflowExitSignal(input.ownController.signal.reason, input.exit.exitScope);
        childController.abort(parentExit !== undefined ? makeParentWorkflowExitAbortReason(parentExit.reason) : input.ownController.signal.reason);
      };
      if (input.ownController.signal.aborted) abortChildFromParent();
      else {
        input.ownController.signal.addEventListener("abort", abortChildFromParent, { once: true });
        detachParentAbort = () => input.ownController.signal.removeEventListener("abort", abortChildFromParent);
      }
      input.exit.throwIfWorkflowExitSelected();
      input.opts.cancellation?.register(childRunId, childController);
      input.exit.throwIfWorkflowExitSelected();

      const {
        runId: _parentRunId,
        continuation: _parentContinuation,
        deferWorkflowStart: _parentDeferWorkflowStart,
        parentRun: _parentRun,
        onRunStart: _parentOnRunStart,
        onRunEnd: _parentOnRunEnd,
        ...childBaseOpts
      } = input.opts;
      const childRunPromise = input.runWorkflow(child, childInputs, {
        ...childBaseOpts,
        runId: childRunId,
        cwd: input.resolveWorkflowCwd(),
        depth: input.depth + 1,
        ...(input.opts.registry !== undefined ? { registry: input.opts.registry } : {}),
        parentRun: {
          runId: input.runId,
          stageId: boundary.id,
          rootRunId: input.opts.parentRun?.rootRunId ?? input.runId,
        },
        signal: childController.signal,
        deferWorkflowStart: false,
      });
      boundary.observeChildRun(childRunPromise);
      const childRun = await childRunPromise;
      input.exit.throwIfWorkflowExitSelected();

      if (!isWorkflowExitStatus(childRun.status)) {
        const failedChildStage = childRun.stages.find((stage) => stage.failureKind !== undefined);
        throw new Error(
          `atomic-workflows: child workflow "${childName}" (${child.name}) failed with status ${childRun.status}${childRun.error !== undefined ? `: ${childRun.error}` : ""}`,
          {
            cause: {
              ...(failedChildStage?.failureKind !== undefined ? { code: failedChildStage.failureKind } : {}),
              ...(failedChildStage?.failureMessage !== undefined ? { message: failedChildStage.failureMessage } : {}),
            },
          },
        );
      }

      const outputs = selectWorkflowOutputs(child, childRun.result);
      const childExited = childRun.exited === true || childRun.status !== "completed";
      const childResult: WorkflowChildResult<TChildOutputs> = childExited
        ? {
            workflow: child.normalizedName,
            runId: childRun.runId,
            status: childRun.status,
            exited: true,
            outputs: outputs as Partial<TChildOutputs>,
            ...(childRun.exitReason !== undefined ? { exitReason: childRun.exitReason } : {}),
          }
        : {
            workflow: child.normalizedName,
            runId: childRun.runId,
            status: "completed",
            exited: false,
            outputs: outputs as TChildOutputs,
          };
      const workflowChild = workflowChildReplaySnapshot(childName, childResult);
      const outputKeys = Object.keys(outputs);
      boundary.complete(
        `Workflow "${child.name}" ${childRun.status} (runId: ${childRun.runId}; outputs: ${outputKeys.length > 0 ? outputKeys.join(", ") : "(none)"})`,
        workflowChild,
      );
      return childResult;
    } catch (err) {
      const exit = findWorkflowExitSignal(err, input.exit.exitScope) ?? findWorkflowExitSignal(input.ownController.signal.reason, input.exit.exitScope);
      if (exit !== undefined) {
        await boundary.skipForWorkflowExit(exit.reason);
        throw exit;
      }
      boundary.fail(err);
      throw err;
    } finally {
      detachParentAbort?.();
      if (childRunId !== undefined) input.opts.cancellation?.unregister(childRunId);
    }
  };
}
