import type { ReviewConvergenceSummary } from "./review-convergence.js";

export const DEFAULT_MAX_TURNS = 10;
// Goal Runner runs three independent reviewer personas; two approvals form a majority.
export const DEFAULT_REVIEW_QUORUM = 2;
export const DEFAULT_BLOCKER_THRESHOLD = 3;
export const LEDGER_FILENAME = "goal-ledger.json";

export type GoalStatus = "active" | "complete" | "blocked" | "needs_human";
export type ReviewGateDecisionValue = "complete" | "continue" | "blocked";

export type WorkReceipt = {
  readonly turn: number;
  readonly stage: string;
  readonly artifact_path: string;
  readonly summary: string;
};

export type ObjectiveAlignment =
  | "required_by_objective"
  | "consistent_with_objective"
  | "beyond_objective"
  | "contradicts_objective";

export type RequirementTraceability = {
  readonly requirement: string;
  readonly status: "proven" | "contradicted" | "missing" | "unverified";
  readonly evidence: string;
};

export type ReviewFinding = {
  readonly title: string;
  readonly body: string;
  readonly confidence_score: number;
  readonly objective_alignment: ObjectiveAlignment;
  readonly priority?: number | null;
  readonly code_location: {
    readonly absolute_file_path: string;
    readonly line_range: {
      readonly start: number;
      readonly end: number;
    };
  };
};

export type ReviewerError = {
  readonly kind:
    | "validation_unavailable"
    | "dependency_unavailable"
    | "tool_failure"
    | "reviewer_failure";
  readonly message: string;
  readonly attempted_recovery: string;
};

export type ReviewDecision = {
  readonly findings: readonly ReviewFinding[];
  readonly overall_correctness: "patch is correct" | "patch is incorrect";
  readonly overall_explanation: string;
  readonly overall_confidence_score: number;
  readonly goal_oracle_satisfied: boolean;
  readonly requirements_traceability: readonly RequirementTraceability[];
  readonly receipt_assessment: string;
  readonly verification_remaining: string;
  readonly stop_review_loop: boolean;
  readonly reviewer_error?: ReviewerError | null;
};

export type ReviewRecord = ReviewDecision & {
  readonly decision: ReviewGateDecisionValue;
  readonly evidence: readonly string[];
  readonly gaps: readonly string[];
  readonly blocker: string | null;
  readonly confidence_score: number;
  readonly explanation: string;
  readonly turn: number;
  readonly reviewer: string;
  readonly artifact_path: string;
  readonly parsed: boolean;
  readonly approved: boolean;
  readonly parse_diagnostics: readonly string[];
  readonly convergence_decision: ReviewConvergenceSummary;
};

export type BlockerObservation = {
  readonly turn: number;
  readonly blocker: string;
  readonly reviewers: readonly string[];
};

export type ReducerDecision = ReviewConvergenceSummary & {
  readonly turn: number;
  readonly decision: "complete" | "continue" | "blocked" | "needs_human";
  readonly reason: string;
  readonly complete_votes: number;
  readonly review_quorum: number;
  readonly blocker?: string;
};

export type GoalLifecycleEvent = {
  readonly turn: number;
  readonly event:
    | "created"
    | "work_turn_started"
    | "receipt_recorded"
    | "reviews_recorded"
    | "status_decided";
  readonly status: GoalStatus;
  readonly at: string;
  readonly summary: string;
};

export type GoalLedger = {
  readonly goal_id: string;
  readonly objective: string;
  readonly acceptance_criteria: string;
  status: GoalStatus;
  turns: number;
  readonly created_at: string;
  updated_at: string;
  receipts: WorkReceipt[];
  reviews: ReviewRecord[];
  blockers: BlockerObservation[];
  decisions: ReducerDecision[];
  lifecycle: GoalLifecycleEvent[];
};

export type ReducerOutcome = {
  readonly status: GoalStatus;
  readonly decision: ReducerDecision;
  readonly blockerObservation?: BlockerObservation;
};

export type GoalWorkflowInputs = {
  readonly objective: string;
  readonly acceptance_criteria?: string;
  readonly max_turns: number;
  readonly base_branch: string;
  readonly git_worktree_dir: string;
  readonly create_pr: boolean;
};

export type GoalWorkflowOutputs = {
  readonly result?: string;
  readonly status?: GoalStatus;
  readonly approved?: boolean;
  readonly goal_id?: string;
  readonly objective?: string;
  readonly acceptance_criteria?: string;
  readonly ledger_path?: string;
  readonly turns_completed?: number;
  readonly iterations_completed?: number;
  readonly receipts?: WorkReceipt[];
  readonly remaining_work?: string;
  readonly review_report?: string;
  readonly review_report_path?: string;
  readonly pr_report?: string;
};
