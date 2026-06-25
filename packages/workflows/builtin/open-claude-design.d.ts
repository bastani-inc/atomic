import type { WorkflowDefinition, WorkflowOutputValues } from "../src/authoring.js";

export type OpenClaudeDesignOutputType = "prototype" | "wireframe" | "page" | "component" | "theme" | "tokens";

export type OpenClaudeDesignWorkflowInputs = {
  readonly prompt: string;
  readonly discover_references: boolean;
  readonly max_refinements: number;
};

export type OpenClaudeDesignWorkflowRunInputs = {
  readonly prompt: string;
  readonly discover_references?: boolean;
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
  readonly playwright_cli_status?: string;
};

export type OpenClaudeDesignWorkflowDefinition = WorkflowDefinition<
  OpenClaudeDesignWorkflowInputs,
  OpenClaudeDesignWorkflowOutputs,
  OpenClaudeDesignWorkflowRunInputs
>;

declare const workflow: OpenClaudeDesignWorkflowDefinition;
export default workflow;
