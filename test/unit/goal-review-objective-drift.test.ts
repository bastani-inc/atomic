import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { reviewApproved } from "../../packages/workflows/builtin/goal-review.js";
import type { ReviewDecision, ReviewFinding } from "../../packages/workflows/builtin/goal-types.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "[P2] Finding",
    body: "body",
    confidence_score: 0.9,
    objective_alignment: "required_by_objective",
    priority: 2,
    code_location: {
      absolute_file_path: "/repo/file.ts",
      line_range: { start: 1, end: 1 },
    },
    ...overrides,
  };
}

function decision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "reviewed",
    overall_confidence_score: 0.95,
    goal_oracle_satisfied: true,
    requirements_traceability: [
      { requirement: "complete objective", status: "proven", evidence: "current state" },
    ],
    receipt_assessment: "receipts map to objective",
    verification_remaining: "none",
    stop_review_loop: true,
    reviewer_error: null,
    ...overrides,
  };
}

describe("goal review boolean convergence gate", () => {
  test("stop_review_loop=true with no reviewer_error approves", () => {
    assert.equal(reviewApproved(decision()), true);
  });

  test("stop_review_loop=false never approves, regardless of other evidence", () => {
    assert.equal(reviewApproved(decision({ stop_review_loop: false })), false);
  });

  test("a reviewer_error never approves, even when stop_review_loop is true", () => {
    assert.equal(
      reviewApproved(
        decision({
          reviewer_error: {
            kind: "tool_failure",
            message: "could not run validation",
            attempted_recovery: "retried once",
          },
        }),
      ),
      false,
    );
  });

  test("the boolean is authoritative: findings and traceability do not override it", () => {
    // The deadlock this gate fixes: acceptance criteria referencing the review
    // process itself (quorum, PR creation) can never be `proven` by a single
    // reviewer. The reviewer signals convergence through the boolean instead.
    assert.equal(
      reviewApproved(
        decision({
          requirements_traceability: [
            { requirement: "implementation clause", status: "proven", evidence: "verified" },
            {
              requirement: "Three independent reviewers approve",
              status: "unverified",
              evidence: "process gate resolved by the harness quorum",
            },
            {
              requirement: "One unmerged PR to main is created",
              status: "missing",
              evidence: "post-approval final action",
            },
          ],
        }),
      ),
      true,
    );
    // Conversely, a reviewer holding the flag at false blocks even when its
    // own arrays look clean — the prompt owns deriving the flag correctly.
    assert.equal(
      reviewApproved(decision({ stop_review_loop: false, findings: [] })),
      false,
    );
    // Findings arrays are audit evidence, not a second gate.
    assert.equal(
      reviewApproved(decision({ findings: [finding({ priority: 0 })] })),
      true,
    );
  });
});
