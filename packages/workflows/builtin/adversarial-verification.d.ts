import type { WorkflowDefinition, WorkflowInputValues, WorkflowOutputValues } from "../src/authoring.js";
export type AdversarialVerificationInputs = WorkflowInputValues & { readonly task: string; readonly verifier_count: number; readonly max_repairs: number };
export type AdversarialVerificationRunInputs = WorkflowInputValues & { readonly task: string; readonly verifier_count?: number; readonly max_repairs?: number };
export type AdversarialVerificationOutputs = WorkflowOutputValues & {
  readonly result: string; readonly approved: boolean; readonly repairs_completed: number;
  readonly candidate_path: string; readonly review_report_path: string;
  readonly verifier_artifact_paths: string[]; readonly artifact_dir: string; readonly remaining_work: string[];
};
export type AdversarialVerificationDefinition = WorkflowDefinition<AdversarialVerificationInputs, AdversarialVerificationOutputs, AdversarialVerificationRunInputs>;
declare const workflow: AdversarialVerificationDefinition;
export default workflow;
