import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  isBlockingFinding,
  MAX_BLOCKING_PRIORITY,
  reviewDecisionApproved,
  type ReviewDecision,
  type ReviewFinding,
} from "../../packages/workflows/builtin/ralph-review-gate.js";

function finding(
  priority: number | null | undefined,
  objectiveAlignment:
    | "required_by_objective"
    | "consistent_with_objective"
    | "beyond_objective"
    | "contradicts_objective" = "consistent_with_objective",
): ReviewFinding {
  return {
    title: priority === undefined ? "untitled" : `[P${priority}] finding`,
    body: "body",
    confidence_score: 0.9,
    objective_alignment: objectiveAlignment,
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
    requirements_traceability: [
      {
        requirement: "Implement the task",
        status: "proven",
        evidence: "Current-state evidence proves the task.",
      },
    ],
    stop_review_loop: true,
    reviewer_error: null,
    ...overrides,
  };
}

describe("isBlockingFinding", () => {
  // isBlockingFinding still classifies findings for reviewer prompts and
  // consolidated repair batches; it no longer overrides the reviewer's
  // stop_review_loop boolean in the approval gate.
  test("P0/P1/P2 are blocking", () => {
    assert.equal(isBlockingFinding(finding(0)), true);
    assert.equal(isBlockingFinding(finding(1)), true);
    assert.equal(isBlockingFinding(finding(2)), true);
    assert.equal(isBlockingFinding(finding(0, "required_by_objective")), true);
    assert.equal(isBlockingFinding(finding(2, "required_by_objective")), true);
  });

  test("P3 is non-blocking only for consistent_with_objective findings", () => {
    assert.equal(isBlockingFinding(finding(3)), false);
  });

  test("required_by_objective findings block at any priority — severity labels alone never dismiss them", () => {
    assert.equal(isBlockingFinding(finding(3, "required_by_objective")), true);
    assert.equal(isBlockingFinding(finding(null, "required_by_objective")), true);
  });

  test("the blocking threshold for in-scope findings is P2", () => {
    assert.equal(MAX_BLOCKING_PRIORITY, 2);
  });

  test("beyond_objective and contradicts_objective findings are non-blocking regardless of priority", () => {
    assert.equal(isBlockingFinding({ ...finding(0), objective_alignment: "beyond_objective" }), false);
    assert.equal(isBlockingFinding({ ...finding(0), objective_alignment: "contradicts_objective" }), false);
  });

  test("missing objective_alignment is blocking even for P3", () => {
    const unclassified = { ...finding(3) } as Record<string, unknown>;
    delete unclassified.objective_alignment;
    assert.equal(isBlockingFinding(unclassified as ReviewFinding), true);
  });

  test("unprioritized (null/undefined) findings are blocking", () => {
    assert.equal(isBlockingFinding(finding(null)), true);
    assert.equal(isBlockingFinding(finding(undefined)), true);
  });
});

describe("reviewDecisionApproved (boolean convergence gate)", () => {
  test("stop_review_loop=true with no reviewer_error approves", () => {
    assert.equal(reviewDecisionApproved(decision()), true);
  });

  test("stop_review_loop=false never approves, regardless of other evidence", () => {
    assert.equal(reviewDecisionApproved(decision({ stop_review_loop: false })), false);
    assert.equal(
      reviewDecisionApproved(decision({ stop_review_loop: false, findings: [] })),
      false,
    );
  });

  test("a reviewer_error never approves, even when stop_review_loop is true", () => {
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

  test("the boolean is authoritative: findings and traceability do not override it", () => {
    // The deadlock this gate fixes: acceptance criteria referencing the review
    // process itself (quorum, PR creation) can never be `proven` by a single
    // reviewer. The reviewer signals convergence through the boolean instead.
    assert.equal(
      reviewDecisionApproved(
        decision({
          requirements_traceability: [
            { requirement: "Implement the task", status: "proven", evidence: "verified" },
            {
              requirement: "All reviewers approve and a PR is created",
              status: "unverified",
              evidence: "harness process gate / post-approval final action",
            },
          ],
        }),
      ),
      true,
    );
    // Findings arrays are audit evidence, not a second gate.
    assert.equal(
      reviewDecisionApproved(decision({ findings: [finding(0)] })),
      true,
    );
  });
});
