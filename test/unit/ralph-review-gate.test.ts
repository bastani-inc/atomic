import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  isBlockingFinding,
  MAX_BLOCKING_PRIORITY,
  reviewDecisionApproved,
  type ReviewDecision,
  type ReviewFinding,
} from "../../packages/workflows/builtin/ralph-review-gate.js";

function finding(priority: number | null | undefined): ReviewFinding {
  return {
    title: priority === undefined ? "untitled" : `[P${priority}] finding`,
    body: "body",
    confidence_score: 0.9,
    ...(priority === undefined ? {} : { priority }),
    code_location: {
      absolute_file_path: "/repo/file.ts",
      line_range: { start: 1, end: 1 },
    },
  };
}

function decision(overrides: Partial<ReviewDecision> = {}): ReviewDecision {
  return {
    findings: [],
    overall_correctness: "patch is correct",
    overall_explanation: "looks good",
    overall_confidence_score: 0.95,
    stop_review_loop: true,
    reviewer_error: null,
    ...overrides,
  };
}

describe("isBlockingFinding", () => {
  test("P0/P1/P2 are blocking", () => {
    assert.equal(isBlockingFinding(finding(0)), true);
    assert.equal(isBlockingFinding(finding(1)), true);
    assert.equal(isBlockingFinding(finding(2)), true);
  });

  test("P3 is non-blocking", () => {
    assert.equal(isBlockingFinding(finding(3)), false);
  });

  test("the blocking threshold is P2", () => {
    assert.equal(MAX_BLOCKING_PRIORITY, 2);
  });

  test("unprioritized (null/undefined) findings are blocking", () => {
    assert.equal(isBlockingFinding(finding(null)), true);
    assert.equal(isBlockingFinding(finding(undefined)), true);
  });
});

describe("reviewDecisionApproved", () => {
  test("correct patch with no findings approves", () => {
    assert.equal(reviewDecisionApproved(decision()), true);
  });

  test("correct patch with only a P3 nit approves (the dummy-finding regression)", () => {
    assert.equal(
      reviewDecisionApproved(
        decision({ findings: [finding(3)], stop_review_loop: false }),
      ),
      true,
    );
  });

  test("approval ignores the self-reported stop_review_loop flag", () => {
    // A reviewer that coupled stop_review_loop to "findings empty" still
    // approves when the only finding is a non-blocking P3.
    assert.equal(
      reviewDecisionApproved(
        decision({ findings: [finding(3), finding(3)], stop_review_loop: false }),
      ),
      true,
    );
  });

  test.each([0, 1, 2])("a P%d finding blocks approval", (priority) => {
    assert.equal(
      reviewDecisionApproved(decision({ findings: [finding(priority)] })),
      false,
    );
  });

  test("a blocking finding alongside P3 nits still blocks", () => {
    assert.equal(
      reviewDecisionApproved(decision({ findings: [finding(3), finding(1), finding(3)] })),
      false,
    );
  });

  test("an unprioritized finding blocks approval", () => {
    assert.equal(reviewDecisionApproved(decision({ findings: [finding(null)] })), false);
    assert.equal(reviewDecisionApproved(decision({ findings: [finding(undefined)] })), false);
  });

  test("'patch is incorrect' never approves, even with no findings", () => {
    assert.equal(
      reviewDecisionApproved(decision({ overall_correctness: "patch is incorrect" })),
      false,
    );
  });

  test("a reviewer_error never approves, even with no blocking findings", () => {
    assert.equal(
      reviewDecisionApproved(
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
});
