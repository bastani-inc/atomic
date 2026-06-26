import type {
  WorkflowChildResult,
  WorkflowDefinition,
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRunChildArgs,
  WorkflowRunChildOptions,
} from "../../shared/types.js";
import type { WorkflowChildRunRef } from "../../shared/store-types.js";
import type { ResolvedInputs, RunOpts, RunResult } from "../../runs/foreground/executor-types.js";
import type { EngineRuntime } from "../runtime.js";
import { findWorkflowExitSignal, isWorkflowExitStatus, makeParentWorkflowExitAbortReason } from "../../runs/foreground/executor-abort.js";
import { selectWorkflowOutputs } from "../../runs/foreground/executor-outputs.js";
import { resolveAndValidateInputs } from "../../runs/foreground/executor-inputs.js";
import {
  isWorkflowDefinition,
  workflowChildReplaySnapshot,
  workflowDefinitionRequirementMessage,
} from "../../runs/foreground/executor-child-helpers.js";
import type { DurableScope } from "../../durable/scoped-backend.js";

export function createChildWorkflowRunner(input: {
  readonly runtime: EngineRuntime;
  readonly resolveWorkflowCwd: () => string;
  readonly nextWorkflowBoundaryReplayKey: (name: string) => string;
  /**
   * Consume the durable scope published by the durable child primitive for the
   * current invocation, if any. Routes child internal side-effect checkpoints
   * under the root workflow.
   */
  readonly consumeDurableScope?: () => DurableScope | undefined;
  readonly runWorkflow: <
    TInputs extends WorkflowInputValues,
    TRunInputs extends WorkflowInputValues = TInputs,
  >(
    def: WorkflowDefinition<TInputs, WorkflowOutputValues, TRunInputs>,
    inputs: ResolvedInputs,
    opts?: RunOpts,
  ) => Promise<RunResult>;
}): <
  TChildInputs extends WorkflowInputValues,
  TChildOutputs extends WorkflowOutputValues,
  TChildRunInputs extends WorkflowInputValues = TChildInputs,
>(
  child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
  ...args: WorkflowRunChildArgs<TChildRunInputs>
) => Promise<WorkflowChildResult<TChildOutputs>> {
  return async <
    TChildInputs extends WorkflowInputValues,
    TChildOutputs extends WorkflowOutputValues,
    TChildRunInputs extends WorkflowInputValues = TChildInputs,
  >(
    child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
    ...args: WorkflowRunChildArgs<TChildRunInputs>
  ): Promise<WorkflowChildResult<TChildOutputs>> => {
    const options: WorkflowRunChildOptions<TChildRunInputs> = args[0] ?? {};
    const { runtime } = input;
    runtime.exit.throwIfWorkflowExitSelected();
    if (!isWorkflowDefinition(child)) throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
    const childName = child.normalizedName;
    const boundaryName = options.stageName ?? `workflow:${childName}`;
    const boundaryReplayKey = input.nextWorkflowBoundaryReplayKey(boundaryName);
    const boundary = runtime.spawnStage(boundaryName, { kind: "workflow-boundary", replayKey: boundaryReplayKey }).boundary;
    let childRunId: string | undefined;
    let detachParentAbort: (() => void) | undefined;
    try {
      if (boundary.replayedChild !== undefined) {
        await Promise.resolve();
        runtime.exit.throwIfWorkflowExitSelected();
        boundary.finalizeReplay();
        return boundary.replayedChild as WorkflowChildResult<TChildOutputs>;
      }

      const childInputs = resolveAndValidateInputs(child.inputs, options.inputs ?? {}, `child workflow "${childName}" (${child.name})`);
      runtime.exit.throwIfWorkflowExitSelected();

      childRunId = crypto.randomUUID();
      const childController = new AbortController();
      const childRef: WorkflowChildRunRef = { alias: childName, workflow: child.normalizedName, runId: childRunId };
      boundary.linkChildRun(childRef, childController);

      const abortChildFromParent = (): void => {
        const parentExit = findWorkflowExitSignal(runtime.signal.reason, runtime.exit.exitScope);
        childController.abort(parentExit !== undefined ? makeParentWorkflowExitAbortReason(parentExit.reason) : runtime.signal.reason);
      };
      if (runtime.signal.aborted) abortChildFromParent();
      else {
        runtime.signal.addEventListener("abort", abortChildFromParent, { once: true });
        detachParentAbort = () => runtime.signal.removeEventListener("abort", abortChildFromParent);
      }
      runtime.exit.throwIfWorkflowExitSelected();
      runtime.childRunOptions.cancellation?.register(childRunId, childController);
      runtime.exit.throwIfWorkflowExitSelected();

      // Ordering is intentional: linkChildRun happens before launch so parent
      // cleanup can abort the child; observeChildRun happens immediately after
      // promise creation, with no await in between, so cleanup can await teardown.
      const childRunPromise = input.runWorkflow(child, childInputs, {
        ...runtime.childRunOptions,
        runId: childRunId,
        cwd: input.resolveWorkflowCwd(),
        depth: runtime.depth + 1,
        parentRun: {
          runId: runtime.runId,
          stageId: boundary.id,
          rootRunId: runtime.parentRootRunId ?? runtime.runId,
        },
        signal: childController.signal,
        deferWorkflowStart: false,
        ...(input.consumeDurableScope !== undefined ? { durableScope: input.consumeDurableScope() } : {}),
      });
      boundary.observeChildRun(childRunPromise);
      const childRun = await childRunPromise;
      runtime.exit.throwIfWorkflowExitSelected();

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
      const exit = findWorkflowExitSignal(err, runtime.exit.exitScope) ?? findWorkflowExitSignal(runtime.signal.reason, runtime.exit.exitScope);
      if (exit !== undefined) {
        await boundary.skipForWorkflowExit(exit.reason);
        throw exit;
      }
      boundary.fail(err);
      throw err;
    } finally {
      detachParentAbort?.();
      if (childRunId !== undefined) runtime.childRunOptions.cancellation?.unregister(childRunId);
    }
  };
}
