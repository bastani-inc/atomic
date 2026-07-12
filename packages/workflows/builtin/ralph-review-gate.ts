import { findingBlocksClosure } from "./review-convergence.js";

/**
 * Review-gate convergence logic for the builtin `ralph` workflow.
 *
 * The reviewer's self-reported `stop_review_loop` boolean is the single
 * authoritative convergence signal, mirroring the builtin `goal` gate. The
 * harness no longer recomputes approval from findings arrays, priorities, or
 * requirements_traceability statuses: those fields remain required audit
 * evidence for humans and later stages, and the reviewer prompt instructs the
 * model exactly how to derive the flag from them (blocking P0/P1/P2 findings
 * and required_by_objective findings at any priority mean `false`; in-scope
 * P3 nice-to-haves, out-of-scope observations, authorized post-approval final
 * actions such as PR creation, and the multi-reviewer quorum process itself
 * must never hold the flag at `false`).
 *
 * Recomputing approval from those arrays previously deadlocked runs whose
 * acceptance criteria referenced the review process itself (for example
 * "three reviewers approve" or "a PR is created"): no individual reviewer can
 * prove such clauses, so traceability could never be fully `proven` even when
 * every reviewer explicitly approved via the boolean.
 *
 * Two hard guards remain: a reviewer execution failure (`reviewer_error`)
 * never approves, and unparsed reviewer output is synthesized upstream as a
 * `stop_review_loop: false` decision, so parse failures never approve either.
 */

export type ObjectiveAlignment =
  | "required_by_objective"
  | "consistent_with_objective"
  | "beyond_objective"
  | "contradicts_objective";

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
export type RequirementTraceability = {
  readonly requirement: string;
  readonly status: "proven" | "contradicted" | "missing" | "unverified";
  readonly evidence: string;
};


export type ReviewDecision = {
  readonly findings: readonly ReviewFinding[];
  readonly overall_correctness: "patch is correct" | "patch is incorrect";
  readonly overall_explanation: string;
  readonly overall_confidence_score: number;
  readonly requirements_traceability: readonly RequirementTraceability[];
  readonly stop_review_loop: boolean;
  readonly reviewer_error?: ReviewerError | null;
};

/**
 * Highest finding priority that still blocks approval for
 * `consistent_with_objective` findings. P0=0, P1=1, P2=2 block; P3=3 does not.
 * `required_by_objective` findings block regardless of priority.
 * Re-exported from the shared evidence-closure module.
 */
export { MAX_BLOCKING_PRIORITY } from "./review-convergence.js";

/**
 * True when a finding should be treated as blocking when *deriving* the
 * reviewer's convergence flag or consolidating repair batches. Delegates to
 * the shared predicate so Goal and Ralph classify findings identically:
 * objective-required findings block at any priority, in-scope P3
 * nice-to-haves do not, and ambiguity (missing priority or alignment)
 * always blocks. This classification feeds prompts and repair batches; it no
 * longer overrides the reviewer's `stop_review_loop` boolean.
 */
export function isBlockingFinding(finding: ReviewFinding): boolean {
  return findingBlocksClosure(finding);
}

/**
 * Deterministic single-reviewer approval gate: the reviewer approves exactly
 * when it set `stop_review_loop` to `true` and reported no execution error.
 */
export function reviewDecisionApproved(decision: ReviewDecision): boolean {
  return decision.stop_review_loop === true && decision.reviewer_error == null;
}
