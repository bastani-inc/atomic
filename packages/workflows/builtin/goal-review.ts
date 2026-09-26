import type { WorkflowTaskResult } from "../src/shared/types.js";
import type { ReviewDecision, ReviewRecord } from "./goal-types.js";
import {
  contradictedStopReviewLoopGap,
  finalActionRemaining,
  parseFailureDiagnostics,
  stopReviewLoopContradictions,
  summarizeReviewConvergence,
  type ParsedReviewDecision,
} from "./review-convergence.js";

export function reviewDecisionFromResult(result: WorkflowTaskResult): ReviewDecision | undefined {
  return result.structured as ReviewDecision | undefined;
}

export function parsedReviewDecisionFromResult(
  result: WorkflowTaskResult,
  reviewer: string,
): ParsedReviewDecision<ReviewDecision> {
  const parsed = reviewDecisionFromResult(result);
  if (parsed !== undefined) {
    return { decision: parsed, parsed: true, diagnostics: [] };
  }
  const diagnostics = parseFailureDiagnostics(reviewer, result.text);
  return {
    decision: reviewerErrorDecision(diagnostics.join("\n")),
    parsed: false,
    diagnostics,
  };
}

/**
 * Deterministic single-reviewer approval gate.
 *
 * The reviewer's self-reported `stop_review_loop` boolean is the convergence
 * signal: the harness does not recompute approval from
 * requirements_traceability statuses, because process-only clauses (quorum,
 * PR creation) can never be proven by one reviewer.
 *
 * Hard guards: a reviewer execution failure (`reviewer_error`) never
 * approves; unparsed reviewer output is synthesized upstream as a
 * `stop_review_loop: false` decision; and a flag contradicted by the same
 * review's verdict (patch incorrect, oracle unsatisfied, or a blocking
 * finding) does not count as approval.
 */
export function reviewApproved(decision: ReviewDecision): boolean {
  return decision.stop_review_loop === true &&
    decision.reviewer_error == null &&
    stopReviewLoopContradictions(decision).length === 0;
}

export function reviewerErrorDecision(message: string): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is incorrect",
    overall_explanation:
      "Reviewer execution failed, so the review gate cannot safely approve the current repository state.",
    overall_confidence_score: 0,
    goal_oracle_satisfied: false,
    requirements_traceability: [],
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
  readonly parsed: boolean;
  readonly diagnostics: readonly string[];
  readonly allowFinalActionRemaining: boolean;
}): ReviewRecord {
  const blocker = blockerFromReviewDecision(args.decision);
  const approved = reviewApproved(args.decision);
  const contradictions = args.decision.stop_review_loop === true
    ? stopReviewLoopContradictions(args.decision)
    : [];
  const hasFinalActionRemaining = args.allowFinalActionRemaining &&
    finalActionRemaining(args.decision.requirements_traceability);
  const verificationGap = args.decision.verification_remaining.trim();
  const traceabilityGaps = args.decision.requirements_traceability
    .filter((entry) => entry.status !== "proven")
    .map((entry) => `${entry.status}: ${entry.requirement} — ${entry.evidence}`);
  const gaps = [
    ...args.decision.findings.map((finding) =>
      `[${finding.objective_alignment}] ${finding.title}: ${finding.body}`
    ),
    ...traceabilityGaps,
    ...(approved || verificationGap.length === 0 ? [] : [verificationGap]),
    ...(args.decision.reviewer_error == null
      ? []
      : [`${args.decision.reviewer_error.kind}: ${args.decision.reviewer_error.message}`]),
    ...(contradictions.length === 0 ? [] : [contradictedStopReviewLoopGap(contradictions)]),
  ];

  const nextAction = approved
    ? hasFinalActionRemaining ? "pull-request" : "finish"
    : blocker === null ? "implementation" : "blocked";
  const convergenceDecision = summarizeReviewConvergence({
    parsed: args.parsed,
    approved,
    stopReviewLoop: args.decision.stop_review_loop,
    nextAction,
    finalActionRemaining: approved && hasFinalActionRemaining,
    diagnostics: args.diagnostics,
  });

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
    parsed: args.parsed,
    approved,
    parse_diagnostics: args.diagnostics,
    convergence_decision: convergenceDecision,
  };
}
