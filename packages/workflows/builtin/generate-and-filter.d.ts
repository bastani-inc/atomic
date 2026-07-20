import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";
export type GenerateAndFilterInputs = WorkflowInputValues & { readonly prompt: string; readonly num_candidates: number; readonly shortlist_size: number; readonly use_judge: boolean; readonly max_concurrency: number };
export type GenerateAndFilterRunInputs = WorkflowInputValues & { readonly prompt: string; readonly num_candidates?: number; readonly shortlist_size?: number; readonly use_judge?: boolean; readonly max_concurrency?: number };
export type GenerateAndFilterOutputs = WorkflowOutputValues & {
  readonly result: string; readonly shortlist: string[]; readonly candidate_artifact_paths: string[];
  readonly filter_path: string; readonly judge_path: string | null; readonly final_path: string;
  readonly artifact_dir: string; readonly manifest_path: string;
};
export type GenerateAndFilterDefinition = WorkflowDefinition<GenerateAndFilterInputs, GenerateAndFilterOutputs, GenerateAndFilterRunInputs>;
declare const workflow: GenerateAndFilterDefinition;
export default workflow;
