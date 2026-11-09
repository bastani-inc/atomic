import type { WorkflowDefinition, WorkflowOutputValues } from "../src/authoring.js";

export type OpenClaudeDesignOutputType = "prototype" | "wireframe" | "page" | "component" | "theme" | "tokens";

export type OpenClaudeDesignWorkflowInputs = {
  readonly prompt: string;
  readonly discover_references: boolean;
  readonly image_model?: string;
};

export type OpenClaudeDesignWorkflowRunInputs = {
  readonly prompt: string;
  readonly discover_references?: boolean;
  readonly image_model?: string;
};

export type OpenClaudeDesignReferenceImagesStatus = {
  readonly status: "skipped" | "generated" | "failed";
  readonly reason?: string;
  readonly model?: string;
  readonly paths: string[];
  readonly retryable?: boolean;
};

export type OpenClaudeDesignWorkflowOutputs = WorkflowOutputValues & {
  readonly output_type?: string;
  readonly design_system?: string;
  readonly artifact?: string;
  readonly handoff?: string;
  readonly import_context?: string;
  readonly run_id?: string;
  readonly artifact_dir?: string;
  readonly preview_path?: string;
  readonly preview_file_url?: string;
  readonly spec_path?: string;
  readonly spec_file_url?: string;
  readonly agent_browser_status?: string;
  readonly reference_images_status?: OpenClaudeDesignReferenceImagesStatus;
};

export type OpenClaudeDesignWorkflowDefinition = WorkflowDefinition<
  OpenClaudeDesignWorkflowInputs,
  OpenClaudeDesignWorkflowOutputs,
  OpenClaudeDesignWorkflowRunInputs
>;

declare const workflow: OpenClaudeDesignWorkflowDefinition;
export default workflow;
