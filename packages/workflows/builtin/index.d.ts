import type { WorkflowDefinition, WorkflowOutputValues } from "../src/authoring.js";

export {
  default as goal,
  type GoalWorkflowDefinition,
  type GoalWorkflowInputs,
  type GoalWorkflowOutputs,
  type GoalWorkflowReceipt,
  type GoalWorkflowRunInputs,
  type GoalWorkflowStatus,
} from "./goal.js";
export {
  default as ralph,
  type RalphWorkflowDefinition,
  type RalphWorkflowInputs,
  type RalphWorkflowOutputs,
  type RalphWorkflowRunInputs,
} from "./ralph.js";

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

export {
  default as adversarialVerification,
  type AdversarialVerificationDefinition,
  type AdversarialVerificationInputs,
  type AdversarialVerificationOutputs,
  type AdversarialVerificationRunInputs,
} from "./adversarial-verification.js";
export {
  default as classifyAndAct,
  type ClassifyAndActWorkflowDefinition,
  type ClassifyAndActWorkflowInputs,
  type ClassifyAndActWorkflowOutputs,
  type ClassifyAndActWorkflowRunInputs,
} from "./classify-and-act.js";
export {
  default as fanOutAndSynthesize,
  type FanOutAndSynthesizeWorkflowDefinition,
  type FanOutAndSynthesizeWorkflowInputs,
  type FanOutAndSynthesizeWorkflowOutputs,
  type FanOutAndSynthesizeWorkflowRunInputs,
} from "./fan-out-and-synthesize.js";
export {
  default as generateAndFilter,
  type GenerateAndFilterDefinition,
  type GenerateAndFilterInputs,
  type GenerateAndFilterOutputs,
  type GenerateAndFilterRunInputs,
} from "./generate-and-filter.js";
export {
  default as loopUntilDone,
  type LoopUntilDoneWorkflowDefinition,
  type LoopUntilDoneWorkflowInputs,
  type LoopUntilDoneWorkflowOutputs,
  type LoopUntilDoneWorkflowRunInputs,
  type LoopUntilDoneWorkflowStatus,
} from "./loop-until-done.js";
export {
  default as tournament,
  type TournamentWorkflowDefinition,
  type TournamentWorkflowInputs,
  type TournamentWorkflowOutputs,
  type TournamentWorkflowRunInputs,
} from "./tournament.js";

export declare const openClaudeDesign: OpenClaudeDesignWorkflowDefinition;
