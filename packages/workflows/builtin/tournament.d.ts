import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type TournamentWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly num_attempts: number;
  readonly max_concurrency: number;
};

export type TournamentWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly num_attempts?: number;
  readonly max_concurrency?: number;
};

export type TournamentWorkflowOutputs = WorkflowOutputValues & {
  readonly result: string;
  readonly winner: string;
  readonly winner_artifact_path: string;
  readonly result_path: string;
  readonly attempt_artifact_paths: string[];
  readonly judge_artifact_paths: string[];
  readonly bracket_path: string;
  readonly artifact_dir: string;
};

export type TournamentWorkflowDefinition = WorkflowDefinition<
  TournamentWorkflowInputs,
  TournamentWorkflowOutputs,
  TournamentWorkflowRunInputs
>;

declare const workflow: TournamentWorkflowDefinition;
export default workflow;
