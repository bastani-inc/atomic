import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { reduceGoalDecision } from "../../packages/workflows/builtin/goal-reducer.js";
import type {
  GoalLedger,
  ReviewFinding,
  ReviewRecord,
} from "../../packages/workflows/builtin/goal-types.js";

function ledger(): GoalLedger {
  const now = new Date().toISOString();
  return {
    goal_id: "test-goal",
    objective: "Complete the requested objective",
    acceptance_criteria: "Complete the requested objective",
    status: "active",
    turns: 1,
    created_at: now,
    updated_at: now,
    receipts: [],
    reviews: [],
    blockers: [],
    decisions: [],
    lifecycle: [],
  };
}

function reviewFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "[P2] Unproven contract clause",
    body: "A concrete objective-relevant defect remains.",
    confidence_score: 0.9,
    objective_alignment: "required_by_objective",
    priority: 2,
    code_location: {
      absolute_file_path: "/repo/src/file.ts",
      line_range: { start: 1, end: 1 },
    },
    ...overrides,
  };
}

function review(
  reviewer: string,
  decision: "complete" | "continue",
  findings: readonly ReviewFinding[] = [],
): ReviewRecord {
  const approved = decision === "complete";
  return {
    findings,
    overall_correctness: approved ? "patch is correct" : "patch is incorrect",
    overall_explanation: `${decision} from ${reviewer}`,
    overall_confidence_score: 0.9,
    goal_oracle_satisfied: approved,
    requirements_traceability: [
      {
        requirement: "complete requested objective",
        status: approved ? "proven" : "missing",
        evidence: approved ? "current-state evidence" : "work remains",
      },
    ],
    receipt_assessment: "receipts inspected",
    verification_remaining: approved ? "none" : "work remains",
    stop_review_loop: approved,
    reviewer_error: null,
    decision,
    evidence: ["receipts inspected"],
    gaps: findings.map((finding) => finding.title),
    blocker: null,
    confidence_score: 0.9,
    explanation: `${decision} from ${reviewer}`,
    turn: 1,
    reviewer,
    artifact_path: `/tmp/review-${reviewer}.json`,
    parsed: true,
    approved,
    parse_diagnostics: [],
    convergence_decision: {
      parsed: true,
      approved,
      stopReviewLoop: approved,
      nextAction: approved ? "finish" : "implementation",
      finalActionRemaining: false,
      diagnostics: [],
    },
  };
}

const OPTIONS = {
  turn: 1,
  maxTurns: 5,
  reviewQuorum: 2,
  blockerThreshold: 3,
  nextActionOnComplete: "finish",
} as const;

describe("goal reducer boolean convergence", () => {
  test("quorum of reviewer stop_review_loop booleans completes", () => {
    const outcome = reduceGoalDecision(
      ledger(),
      [review("a", "complete"), review("b", "complete"), review("c", "continue")],
      OPTIONS,
    );
    assert.equal(outcome.status, "complete");
    assert.match(outcome.decision.reason, /Reviewer quorum met: 2\/2/);
    assert.match(outcome.decision.reason, /stop_review_loop=true/);
  });

  test("a dissenting reviewer's findings do not veto quorum — the boolean is authoritative", () => {
    const outcome = reduceGoalDecision(
      ledger(),
      [
        review("a", "complete"),
        review("b", "complete"),
        review("c", "continue", [reviewFinding()]),
      ],
      OPTIONS,
    );
    assert.equal(outcome.status, "complete");
    assert.equal(outcome.decision.decision, "complete");
  });

  test("without quorum the run continues with the remaining work recorded", () => {
    const outcome = reduceGoalDecision(
      ledger(),
      [
        review("a", "complete"),
        review("b", "continue", [reviewFinding()]),
        review("c", "continue"),
      ],
      OPTIONS,
    );
    assert.equal(outcome.status, "active");
    assert.equal(outcome.decision.decision, "continue");
    assert.match(outcome.decision.reason, /Reviewer quorum not met/);
    assert.match(outcome.decision.reason, /Unproven contract clause/);
  });

  test("the loop stays bounded: at max_turns without quorum it stops inspectably as needs_human", () => {
    const outcome = reduceGoalDecision(
      ledger(),
      [
        review("a", "complete"),
        review("b", "continue", [reviewFinding()]),
        review("c", "continue"),
      ],
      { ...OPTIONS, turn: 5 },
    );
    assert.equal(outcome.status, "needs_human");
    assert.match(
      outcome.decision.reason,
      /Worker attempt budget reached without reviewer quorum/,
    );
    assert.match(outcome.decision.reason, /Unproven contract clause/);
  });
});
