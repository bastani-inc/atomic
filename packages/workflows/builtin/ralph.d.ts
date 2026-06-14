import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type RalphWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_loops: number;
  readonly base_branch: string;
  readonly git_worktree_dir: string;
  readonly create_pr: boolean;
};

export type RalphWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
  readonly create_pr?: boolean;
};

export type RalphWorkflowOutputs = WorkflowOutputValues & {
  readonly result?: string;
  readonly plan?: string;
  readonly plan_path?: string;
  readonly research?: string;
  readonly research_path?: string;
  readonly implementation_notes_path?: string;
  readonly pr_report?: string;
  readonly approved?: boolean;
  readonly iterations_completed?: number;
  readonly review_report?: string;
  readonly review_report_path?: string;
};

export type RalphWorkflowDefinition = WorkflowDefinition<
  RalphWorkflowInputs,
  RalphWorkflowOutputs,
  RalphWorkflowRunInputs
>;

declare const workflow: RalphWorkflowDefinition;
export default workflow;
