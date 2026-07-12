import {
  findingBlocksClosure,
  traceabilityProvenExceptFinalAction,
} from "./review-convergence.js";

/**
 * Review-gate severity logic for the builtin `ralph` workflow.
 *
 * The bounded review loop must stop as soon as the patch is judged correct, even
 * when a reviewer leaves a low-priority nit (or, occasionally, appends a
 * placeholder finding because it wrongly believed an empty `findings` array would
 * fail schema validation). Requiring a literally empty `findings` array made the
 * loop iterate forever in those cases despite unanimous "patch is correct"
 * verdicts.
 *
 * Approval is therefore alignment- and severity-aware, deterministic, and
 * computed by the shared evidence-closure predicate
 * (`findingBlocksClosure` in ./review-convergence.ts). A single reviewer
 * approves when it judged the patch correct, reported no `reviewer_error`, and
 * filed no *blocking* finding:
 *
 * - `required_by_objective` findings block at ANY priority (P3 included):
 *   severity labels alone never dismiss objective-relevant findings.
 * - `consistent_with_objective` findings block at P0/P1/P2 (numeric priority
 *   0, 1, or 2); P3 is a non-blocking nice-to-have that should not keep the
 *   loop spinning.
 * - `beyond_objective` / `contradicts_objective` findings never block.
 * - A finding whose priority cannot be determined (`null`/`undefined`) or
 *   whose alignment is missing is treated as blocking, so genuine ambiguity
 *   never silently approves.
 *
 * The decision is computed from the structured findings rather than the
 * reviewer's self-reported `stop_review_loop` boolean, so the gate does not
 * depend on the model correctly deriving that flag.
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
 * True when a finding must keep the review loop iterating. Delegates to the
 * shared evidence-closure predicate so Goal and Ralph gate findings
 * identically: objective-required findings block at any priority, in-scope
 * P3 nice-to-haves do not, and ambiguity (missing priority or alignment)
 * always blocks.
 */
export function isBlockingFinding(finding: ReviewFinding): boolean {
  return findingBlocksClosure(finding);
}

/**
 * A single reviewer approves (would stop the loop) when it judged the patch
 * correct, surfaced no reviewer execution error, filed no blocking (P0/P1/P2)
 * finding, and supplied a non-empty requirement traceability map where every
 * explicit requirement is proven. P3 nice-to-haves and placeholder/dummy
 * findings do not block approval.
 */
export function reviewDecisionApproved(
  decision: ReviewDecision,
  options: { readonly allowFinalActionRemaining?: boolean } = {},
): boolean {
  const traceability = decision.requirements_traceability;
  return (
    decision.overall_correctness === "patch is correct" &&
    decision.reviewer_error == null &&
    !decision.findings.some(isBlockingFinding) &&
    traceabilityProvenExceptFinalAction({
      traceability,
      allowFinalActionRemaining: options.allowFinalActionRemaining === true,
    })
  );
}
