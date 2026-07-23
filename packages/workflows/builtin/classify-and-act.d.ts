import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type ClassifyAndActWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly categories: string[];
  readonly confidence_threshold: number;
};
export type ClassifyAndActWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly categories?: string[];
  readonly confidence_threshold?: number;
};
export type ClassifyAndActWorkflowOutputs = WorkflowOutputValues & {
  readonly result: string;
  readonly category: string;
  readonly confidence: number;
  readonly action: string;
  readonly classification_path: string;
  readonly action_path: string;
  readonly artifact_dir: string;
};
export type ClassifyAndActWorkflowDefinition = WorkflowDefinition<ClassifyAndActWorkflowInputs, ClassifyAndActWorkflowOutputs, ClassifyAndActWorkflowRunInputs>;
declare const definition: ClassifyAndActWorkflowDefinition;
export default definition;
