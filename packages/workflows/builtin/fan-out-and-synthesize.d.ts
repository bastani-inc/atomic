import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type FanOutAndSynthesizeWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_branches: number;
  readonly max_concurrency: number;
};
export type FanOutAndSynthesizeWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_branches?: number;
  readonly max_concurrency?: number;
};
export type FanOutAndSynthesizeWorkflowOutputs = WorkflowOutputValues & {
  readonly result: string;
  readonly partitions: string[];
  readonly branch_artifact_paths: string[];
  readonly synthesis_path: string;
  readonly artifact_dir: string;
  readonly manifest_path: string;
};
export type FanOutAndSynthesizeWorkflowDefinition = WorkflowDefinition<FanOutAndSynthesizeWorkflowInputs, FanOutAndSynthesizeWorkflowOutputs, FanOutAndSynthesizeWorkflowRunInputs>;
declare const definition: FanOutAndSynthesizeWorkflowDefinition;
export default definition;
