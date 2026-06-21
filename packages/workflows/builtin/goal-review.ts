import type { WorkflowTaskResult } from "../src/shared/types.js";
import type { ReviewDecision, ReviewRecord } from "./goal-types.js";

export function reviewDecisionFromResult(result: WorkflowTaskResult): ReviewDecision | undefined {
  return result.structured as ReviewDecision | undefined;
}

export function reviewApproved(decision: ReviewDecision): boolean {
  const hasBlockingFindings = decision.findings.some(
    (finding) => finding.priority !== 3,
  );
  return (
    decision.stop_review_loop === true &&
    decision.overall_correctness === "patch is correct" &&
    decision.goal_oracle_satisfied === true &&
    !hasBlockingFindings &&
    decision.reviewer_error == null
  );
}

export function reviewerErrorDecision(message: string): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is incorrect",
    overall_explanation:
      "Reviewer execution failed, so the review gate cannot safely approve this turn.",
    overall_confidence_score: 0,
    goal_oracle_satisfied: false,
    receipt_assessment:
      "No reviewer receipt could be produced because reviewer execution failed.",
    verification_remaining: "Recover reviewer execution and re-run oracle validation.",
    stop_review_loop: false,
    reviewer_error: {
      kind: "reviewer_failure",
      message,
      attempted_recovery:
        "Model fallbacks were configured for the reviewer stage; continuing the bounded loop without approval.",
    },
  };
}

export function blockerFromReviewDecision(decision: ReviewDecision): string | null {
  const reviewerError = decision.reviewer_error;
  if (reviewerError == null) return null;
  if (
    reviewerError.kind !== "dependency_unavailable" &&
    reviewerError.kind !== "tool_failure"
  ) {
    return null;
  }
  const blocker = reviewerError.message.trim();
  return blocker.length > 0 ? blocker : null;
}

export function reviewDecisionToRecord(args: {
  readonly turn: number;
  readonly reviewer: string;
  readonly artifactPath: string;
  readonly decision: ReviewDecision;
}): ReviewRecord {
  const blocker = blockerFromReviewDecision(args.decision);
  const approved = reviewApproved(args.decision);
  const verificationGap = args.decision.verification_remaining.trim();
  const gaps = [
    ...args.decision.findings.map((finding) => `${finding.title}: ${finding.body}`),
    ...(approved || verificationGap.length === 0 ? [] : [verificationGap]),
    ...(args.decision.reviewer_error == null
      ? []
      : [`${args.decision.reviewer_error.kind}: ${args.decision.reviewer_error.message}`]),
  ];

  return {
    ...args.decision,
    decision: approved ? "complete" : blocker === null ? "continue" : "blocked",
    evidence: [args.decision.receipt_assessment, args.decision.overall_explanation],
    gaps,
    blocker,
    confidence_score: args.decision.overall_confidence_score,
    explanation: args.decision.overall_explanation,
    turn: args.turn,
    reviewer: args.reviewer,
    artifact_path: args.artifactPath,
  };
}
