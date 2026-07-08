import type {
  WorkflowChildResult,
  WorkflowDefinition,
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRunChildArgs,
  WorkflowSerializableValue,
} from "../shared/types.js";
import { isWorkflowDefinition, workflowDefinitionRequirementMessage } from "../runs/foreground/executor-child-helpers.js";
import type { DurableWorkflowBackend } from "./backend.js";
import type { DurableScope } from "./scoped-backend.js";
import { recordCheckpointDurably } from "./tool-primitive.js";
import { stageCheckpointWithOutput, type DurableCompletedStageCheckpoint } from "./stage-primitive.js";

export function createDurableChildWorkflowPrimitive(input: {
  readonly workflowId: string;
  readonly rootWorkflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextReplayKey: (name: string) => string;
  readonly recordCachedStage: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint) => void;
  /**
   * Publish the durable scope computed for the next child invocation so the
   * child runner can consume it and route its internal side-effect checkpoints
   * under the root workflow. Avoids re-deriving the ordinal independently.
   */
  readonly setChildDurableScope: (scope: DurableScope) => void;
  readonly workflow: <
    TChildInputs extends WorkflowInputValues,
    TChildOutputs extends WorkflowOutputValues,
    TChildRunInputs extends WorkflowInputValues = TChildInputs,
  >(
    child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
    ...args: WorkflowRunChildArgs<TChildRunInputs>
  ) => Promise<WorkflowChildResult<TChildOutputs>>;
}) {
  return async <
    TChildInputs extends WorkflowInputValues,
    TChildOutputs extends WorkflowOutputValues,
    TChildRunInputs extends WorkflowInputValues = TChildInputs,
  >(
    child: WorkflowDefinition<TChildInputs, TChildOutputs, TChildRunInputs>,
    ...args: WorkflowRunChildArgs<TChildRunInputs>
  ): Promise<WorkflowChildResult<TChildOutputs>> => {
    if (!isWorkflowDefinition(child)) throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
    const options = args[0] as { readonly stageName?: string } | undefined;
    const boundaryName = options?.stageName ?? `workflow:${child.normalizedName}`;
    const replayKey = input.nextReplayKey(boundaryName);
    // Route this child's internal side-effect checkpoints under the root
    // workflow with a stable boundary key, so an interrupted child does not
    // re-execute completed side effects on parent resume.
    // cross-ref: issue #1498.
    input.setChildDurableScope({ rootWorkflowId: input.rootWorkflowId, scopePrefix: replayKey });
    const cached = stageCheckpointWithOutput(input.backend, input.workflowId, replayKey, isWorkflowChildResult);
    if (cached !== undefined && isWorkflowChildResult(cached.output)) {
      input.recordCachedStage(boundaryName, replayKey, cached);
      return cached.output as WorkflowChildResult<TChildOutputs>;
    }
    const result = await input.workflow(child, ...args);
    await recordCheckpointDurably(input.backend, {
      kind: "stage",
      workflowId: input.workflowId,
      checkpointId: `workflow:${replayKey}`,
      name: boundaryName,
      replayKey,
      output: result as WorkflowSerializableValue,
      completedAt: Date.now(),
      result: result.status,
    });
    return result as WorkflowChildResult<TChildOutputs>;
  };
}


function isWorkflowChildResult(value: WorkflowSerializableValue): value is WorkflowChildResult<WorkflowOutputValues> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { readonly workflow?: WorkflowSerializableValue }).workflow === "string"
    && typeof (value as { readonly runId?: WorkflowSerializableValue }).runId === "string"
    && typeof (value as { readonly status?: WorkflowSerializableValue }).status === "string"
    && typeof (value as { readonly outputs?: WorkflowSerializableValue }).outputs === "object";
}
