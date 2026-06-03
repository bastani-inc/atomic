import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type DeepResearchCodebaseWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_partitions: number;
  readonly max_concurrency: number;
};

export type DeepResearchCodebaseWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_partitions?: number;
  readonly max_concurrency?: number;
};

export type DeepResearchCodebaseWorkflowOutputs = WorkflowOutputValues & {
  readonly result?: string;
  readonly findings?: string;
  readonly research_doc_path?: string;
  readonly artifact_dir?: string;
  readonly manifest_path?: string;
  readonly partitions?: string[];
  readonly explorer_count?: number;
  readonly specialist_count?: number;
  readonly max_concurrency?: number;
  readonly history?: string;
};

export type DeepResearchCodebaseWorkflowDefinition = WorkflowDefinition<
  DeepResearchCodebaseWorkflowInputs,
  DeepResearchCodebaseWorkflowOutputs,
  DeepResearchCodebaseWorkflowRunInputs
>;

declare const workflow: DeepResearchCodebaseWorkflowDefinition;
export default workflow;
