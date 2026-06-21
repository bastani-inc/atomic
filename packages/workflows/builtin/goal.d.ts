import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";

export type GoalWorkflowStatus = "active" | "complete" | "blocked" | "needs_human";

export type GoalWorkflowReceipt = {
  readonly turn: number;
  readonly stage: string;
  readonly artifact_path: string;
  readonly summary: string;
};

export type GoalWorkflowInputs = WorkflowInputValues & {
  readonly objective: string;
  readonly max_turns: number;
  readonly base_branch: string;
};

export type GoalWorkflowRunInputs = WorkflowInputValues & {
  readonly objective: string;
  readonly max_turns?: number;
  readonly base_branch?: string;
};

export type GoalWorkflowOutputs = WorkflowOutputValues & {
  readonly result?: string;
  readonly status?: GoalWorkflowStatus;
  readonly approved?: boolean;
  readonly goal_id?: string;
  readonly objective?: string;
  readonly original_objective?: string;
  readonly ledger_path?: string;
  readonly turns_completed?: number;
  readonly iterations_completed?: number;
  readonly receipts?: GoalWorkflowReceipt[];
  readonly remaining_work?: string;
  readonly review_report?: string;
  readonly review_report_path?: string;
};

export type GoalWorkflowDefinition = WorkflowDefinition<
  GoalWorkflowInputs,
  GoalWorkflowOutputs,
  GoalWorkflowRunInputs
>;

declare const workflow: GoalWorkflowDefinition;
export default workflow;
