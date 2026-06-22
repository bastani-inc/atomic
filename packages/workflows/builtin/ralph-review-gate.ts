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
 * Approval is therefore severity-aware and deterministic. A single reviewer
 * approves when it judged the patch correct, reported no `reviewer_error`, and
 * filed no *blocking* finding:
 *
 * - Blocking  = P0/P1/P2 (numeric priority 0, 1, or 2).
 * - Non-blocking = P3 (numeric priority 3) — a nice-to-have that should not keep
 *   the loop spinning.
 * - A finding whose priority cannot be determined (`null`/`undefined`) is treated
 *   as blocking, so genuine ambiguity never silently approves.
 *
 * The decision is computed from the structured findings rather than the
 * reviewer's self-reported `stop_review_loop` boolean, so the gate does not
 * depend on the model correctly deriving that flag.
 */

export type ReviewFinding = {
  readonly title: string;
  readonly body: string;
  readonly confidence_score: number;
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
  readonly stop_review_loop: boolean;
  readonly reviewer_error?: ReviewerError | null;
};

/**
 * Highest finding priority that still blocks approval. P0=0, P1=1, P2=2 block;
 * P3=3 does not.
 */
export const MAX_BLOCKING_PRIORITY = 2;

/**
 * True when a finding must keep the review loop iterating. P0/P1/P2 block; P3 is
 * a non-blocking nice-to-have. A finding without a determinable priority
 * (`null`/`undefined`) is treated as blocking so ambiguity never silently
 * approves.
 */
export function isBlockingFinding(finding: ReviewFinding): boolean {
  const priority = finding.priority;
  if (priority === undefined || priority === null) return true;
  return priority <= MAX_BLOCKING_PRIORITY;
}

/**
 * A single reviewer approves (would stop the loop) when it judged the patch
 * correct, surfaced no reviewer execution error, and filed no blocking
 * (P0/P1/P2) finding. P3 nice-to-haves and placeholder/dummy findings do not
 * block approval.
 */
export function reviewDecisionApproved(decision: ReviewDecision): boolean {
  return (
    decision.overall_correctness === "patch is correct" &&
    decision.reviewer_error == null &&
    !decision.findings.some(isBlockingFinding)
  );
}
