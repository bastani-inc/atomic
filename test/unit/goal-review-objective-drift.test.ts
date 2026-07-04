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

describe("goal review objective-drift gates", () => {
  test("rejects approval when traceability is empty or not proven", () => {
    assert.equal(reviewApproved(decision({ requirements_traceability: [] })), false);
    for (const status of ["contradicted", "missing", "unverified"] as const) {
      assert.equal(
        reviewApproved(decision({
          requirements_traceability: [
            { requirement: "literal clause", status, evidence: "gap" },
          ],
        })),
        false,
      );
    }
  });

  test("beyond_objective and contradicts_objective findings are non-blocking", () => {
    assert.equal(
      reviewApproved(decision({ findings: [finding({ objective_alignment: "beyond_objective", priority: 0 })] })),
      true,
    );
    assert.equal(
      reviewApproved(decision({ findings: [finding({ objective_alignment: "contradicts_objective", priority: 0 })] })),
      true,
    );
  });

  test("missing objective_alignment blocks even for P3 findings", () => {
    const unclassified = { ...finding({ priority: 3 }) } as Record<string, unknown>;
    delete unclassified.objective_alignment;
    assert.equal(reviewApproved(decision({ findings: [unclassified as ReviewFinding] })), false);
  });
});
