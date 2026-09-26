import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { reduceGoalDecision } from "../../packages/workflows/builtin/goal-reducer.js";
import { reviewApproved, reviewDecisionToRecord } from "../../packages/workflows/builtin/goal-review.js";
import type { GoalLedger, ReviewDecision, ReviewFinding } from "../../packages/workflows/builtin/goal-types.js";

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
		requirements_traceability: [{ requirement: "complete objective", status: "proven", evidence: "current state" }],
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
		assert.equal(reviewApproved(decision({ stop_review_loop: false, findings: [] })), false);
		// A blocking finding in the same review contradicts the flag (#3295).
		assert.equal(reviewApproved(decision({ findings: [finding({ priority: 0 })] })), false);
		// Non-blocking findings stay audit evidence.
		assert.equal(
			reviewApproved(
				decision({ findings: [finding({ objective_alignment: "consistent_with_objective", priority: 3 })] }),
			),
			true,
		);
		assert.equal(
			reviewApproved(decision({ findings: [finding({ objective_alignment: "beyond_objective", priority: 0 })] })),
			true,
		);
	});
});

function emptyDeltaReview(): ReviewDecision {
	return decision({
		findings: [
			finding({
				title: "[P0] Empty implementation delta — zero work performed",
				priority: 0,
				objective_alignment: "required_by_objective",
			}),
		],
		overall_correctness: "patch is incorrect",
		goal_oracle_satisfied: false,
		requirements_traceability: [{ requirement: "complete objective", status: "missing", evidence: "no diff" }],
		verification_remaining: "all work remains",
		stop_review_loop: true,
	});
}

function emptyLedger(): GoalLedger {
	const now = new Date().toISOString();
	return {
		goal_id: "goal-3295",
		objective: "Implement the feature",
		acceptance_criteria: "Implement the feature",
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

describe("stop_review_loop contradicted by the same review (#3295)", () => {
	test("an incorrect patch or an unsatisfied oracle does not approve", () => {
		assert.equal(reviewApproved(decision({ overall_correctness: "patch is incorrect" })), false);
		assert.equal(reviewApproved(decision({ goal_oracle_satisfied: false })), false);
	});

	test("the record continues and names the contradiction as a gap", () => {
		const record = reviewDecisionToRecord({
			turn: 1,
			reviewer: "evidence-reviewer",
			artifactPath: "/tmp/review-evidence-reviewer.json",
			decision: emptyDeltaReview(),
			parsed: true,
			diagnostics: [],
			allowFinalActionRemaining: true,
		});
		assert.equal(record.approved, false);
		assert.equal(record.decision, "continue");
		assert.equal(record.convergence_decision.nextAction, "implementation");
		const gap = record.gaps.find((entry) => entry.startsWith("stop_review_loop=true was not counted"));
		assert.ok(gap);
		assert.match(gap, /overall_correctness is "patch is incorrect"/);
		assert.match(gap, /goal_oracle_satisfied is false/);
		assert.match(gap, /Empty implementation delta/);
	});

	test("three contradictory stop votes do not complete the run or start the PR stage", () => {
		const reviews = ["spec-reviewer", "evidence-reviewer", "risk-reviewer"].map((reviewer) =>
			reviewDecisionToRecord({
				turn: 1,
				reviewer,
				artifactPath: `/tmp/review-${reviewer}.json`,
				decision: emptyDeltaReview(),
				parsed: true,
				diagnostics: [],
				allowFinalActionRemaining: true,
			}),
		);
		const outcome = reduceGoalDecision(emptyLedger(), reviews, {
			turn: 1,
			maxTurns: 1,
			reviewQuorum: 2,
			blockerThreshold: 2,
			nextActionOnComplete: "pull-request",
		});
		assert.notEqual(outcome.status, "complete");
		assert.equal(outcome.decision.complete_votes, 0);
	});
});
