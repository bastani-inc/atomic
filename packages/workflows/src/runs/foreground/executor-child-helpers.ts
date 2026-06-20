import { isBrandedWorkflowDefinition } from "../../workflows/define-workflow.js";
import type {
  WorkflowChildResult,
  WorkflowDefinition,
  WorkflowOutputValues,
  WorkflowSerializableValue,
} from "../../shared/types.js";
import type { WorkflowChildReplaySnapshot } from "../../shared/store-types.js";

export function cloneWorkflowChildValue<T>(value: T): T {
  return structuredClone(value);
}

function workflowChildSerializationMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!isBrandedWorkflowDefinition(value)) return false;
  const record = value as Partial<WorkflowDefinition>;
  return record.__piWorkflow === true &&
    typeof record.name === "string" && record.name.trim().length > 0 &&
    typeof record.normalizedName === "string" && record.normalizedName.trim().length > 0 &&
    typeof record.run === "function" &&
    typeof record.inputs === "object" && record.inputs !== null;
}

export function workflowDefinitionRequirementMessage(callSite: string, value: unknown): string {
  if (value !== null && typeof value === "object" && (value as { __piWorkflow?: unknown }).__piWorkflow === true) {
    return `atomic-workflows: ${callSite} requires a compiled workflow definition produced by defineWorkflow(...).compile(); hand-rolled __piWorkflow objects are not supported`;
  }
  return `atomic-workflows: ${callSite} requires a compiled workflow definition`;
}

export function cloneWorkflowChildReplaySnapshot(snapshot: WorkflowChildReplaySnapshot): WorkflowChildReplaySnapshot {
  return {
    alias: snapshot.alias,
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    status: snapshot.status,
    ...(snapshot.exited !== undefined ? { exited: snapshot.exited } : {}),
    outputs: cloneWorkflowChildValue(snapshot.outputs),
    ...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
  };
}

export function workflowChildReplaySnapshot(
  alias: string,
  childResult: WorkflowChildResult,
): WorkflowChildReplaySnapshot {
  const outputs: Record<string, WorkflowSerializableValue> = {};
  for (const [key, value] of Object.entries(childResult.outputs as WorkflowOutputValues)) {
    if (value === undefined) continue;
    try {
      outputs[key] = cloneWorkflowChildValue(value);
    } catch (err) {
      throw new Error(
        `atomic-workflows: child workflow "${alias}" (${childResult.workflow}) exposed output "${key}" is not serializable for continuation replay: ${workflowChildSerializationMessage(err)}`,
        { cause: err },
      );
    }
  }

  const exitReason = childResult.exited === true ? childResult.exitReason : undefined;
  return {
    alias,
    workflow: childResult.workflow,
    runId: childResult.runId,
    status: childResult.status,
    exited: childResult.exited,
    outputs,
    ...(exitReason !== undefined ? { exitReason } : {}),
  };
}
