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

export type RalphWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_loops: number;
  readonly base_branch: string;
  readonly git_worktree_dir: string;
};
export type RalphWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
};
export type RalphWorkflowOutputs = WorkflowOutputValues & {
  readonly result?: string;
  readonly plan?: string;
  readonly plan_path?: string;
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

export type OpenClaudeDesignOutputType = "prototype" | "wireframe" | "page" | "component" | "theme" | "tokens";
export type OpenClaudeDesignWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly reference?: string;
  readonly output_type: OpenClaudeDesignOutputType;
  readonly design_system?: string;
  readonly max_refinements: number;
};
export type OpenClaudeDesignWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly reference?: string;
  readonly output_type?: OpenClaudeDesignOutputType;
  readonly design_system?: string;
  readonly max_refinements?: number;
};
export type OpenClaudeDesignWorkflowOutputs = WorkflowOutputValues & {
  readonly output_type?: string;
  readonly design_system?: string;
  readonly artifact?: string;
  readonly handoff?: string;
  readonly approved_for_export?: boolean;
  readonly refinements_completed?: number;
  readonly import_context?: string;
  readonly run_id?: string;
  readonly artifact_dir?: string;
  readonly preview_path?: string;
  readonly preview_file_url?: string;
  readonly spec_path?: string;
  readonly spec_file_url?: string;
};
export type OpenClaudeDesignWorkflowDefinition = WorkflowDefinition<
  OpenClaudeDesignWorkflowInputs,
  OpenClaudeDesignWorkflowOutputs,
  OpenClaudeDesignWorkflowRunInputs
>;

export declare const deepResearchCodebase: DeepResearchCodebaseWorkflowDefinition;
export declare const goal: GoalWorkflowDefinition;
export declare const ralph: RalphWorkflowDefinition;
export declare const openClaudeDesign: OpenClaudeDesignWorkflowDefinition;
