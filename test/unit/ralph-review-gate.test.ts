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

  test("a required_by_objective P3 finding blocks approval — severity labels never dismiss objective-relevant findings", () => {
    assert.equal(
      reviewDecisionApproved(
        decision({ findings: [finding(3, "required_by_objective")] }),
      ),
      false,
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

  test("rejects missing or non-proven requirements traceability", () => {
    assert.equal(reviewDecisionApproved(decision({ requirements_traceability: [] })), false);
    for (const status of ["contradicted", "missing", "unverified"] as const) {
      assert.equal(
        reviewDecisionApproved(
          decision({
            requirements_traceability: [
              {
                requirement: `Requirement is ${status}`,
                status,
                evidence: "Evidence does not prove the requirement.",
              },
            ],
          }),
        ),
        false,
      );
    }
  });

  test("approves when every requirements traceability entry is proven", () => {
    assert.equal(
      reviewDecisionApproved(
        decision({
          requirements_traceability: [
            { requirement: "First clause", status: "proven", evidence: "File and test evidence." },
            { requirement: "Second clause", status: "proven", evidence: "Runtime evidence." },
          ],
        }),
      ),
      true,
    );
  });
});
