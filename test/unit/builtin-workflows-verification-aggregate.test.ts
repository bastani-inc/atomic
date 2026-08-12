import assert from "node:assert/strict";
import { test } from "vitest";
import {
	aggregateVerification,
	CRITERION_FLOOR,
	PARSE_QUORUM,
	PASS_THRESHOLD,
	type VerificationReport,
} from "../../packages/workflows/builtin/verification-aggregate.js";

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
	return {
		criterion: "rubric",
		score: 1,
		blocking_findings: [],
		veto_findings: [],
		...overrides,
	};
}

test("verification aggregation publishes the threshold, floor, and quorum constants", () => {
	assert.equal(PASS_THRESHOLD, 0.75);
	assert.equal(CRITERION_FLOOR, 0.5);
	assert.equal(PARSE_QUORUM, 0.5);
});

test("returns pass when the mean over parsed reports clears the threshold", () => {
	// Four of five verifiers parsed and passed; the fifth produced no parseable
	// report at all. The dropped report must not be counted as an objection.
	const outcome = aggregateVerification([report(), report(), report(), report()], 5);
	assert.equal(outcome.outcome, "pass");
	assert.equal(outcome.outcome === "pass" ? outcome.score : undefined, 1);
	assert.equal(outcome.parsed, 4);
	assert.equal(outcome.expected, 5);
});

test("divides by the parsed count and never the expected count", () => {
	const outcome = aggregateVerification([report(), report()], 4);
	assert.equal(outcome.outcome, "pass");
	assert.equal(outcome.outcome === "pass" ? outcome.score : undefined, 1);
	assert.equal(outcome.parsed, 2);
	assert.equal(outcome.expected, 4);
});

test("returns indeterminate below the parse quorum", () => {
	const outcome = aggregateVerification([report()], 4);
	assert.equal(outcome.outcome, "indeterminate");
	assert.equal(outcome.parsed, 1);
	assert.equal(outcome.expected, 4);
	assert.equal(Object.hasOwn(outcome, "score"), false);
});

test("returns indeterminate for an expected count of zero rather than dividing by zero", () => {
	const outcome = aggregateVerification([], 0);
	assert.equal(outcome.outcome, "indeterminate");
	assert.equal(outcome.parsed, 0);
	assert.equal(outcome.expected, 0);
	assert.equal(Object.hasOwn(outcome, "score"), false);
});

test("checks the quorum before the veto", () => {
	// One vetoing report out of four expected is still below quorum, so the
	// round is indeterminate: too little evidence to act on at all.
	const outcome = aggregateVerification([report({ veto_findings: ["credential exposure"] })], 4);
	assert.equal(outcome.outcome, "indeterminate");
});

test("vetoes ahead of the mean", () => {
	const outcome = aggregateVerification(
		[report(), report({ veto_findings: ["destructive migration deletes user rows"] }), report()],
		3,
	);
	assert.equal(outcome.outcome, "fail");
	assert.equal(outcome.outcome === "fail" ? outcome.reason : undefined, "veto");
	assert.deepEqual(outcome.outcome === "fail" ? [...outcome.blocking_findings] : [], [
		"destructive migration deletes user rows",
	]);
	// The mean alone would have passed; the veto is what decided the round.
	assert.equal(outcome.outcome === "fail" ? outcome.score : undefined, 1);
});

test("names veto findings ahead of ordinary blocking findings", () => {
	const outcome = aggregateVerification(
		[
			report({ score: 0, blocking_findings: ["missing test"] }),
			report({ veto_findings: ["writes plaintext credentials to disk"] }),
		],
		2,
	);
	assert.equal(outcome.outcome, "fail");
	assert.deepEqual(outcome.outcome === "fail" ? [...outcome.blocking_findings] : [], [
		"writes plaintext credentials to disk",
		"missing test",
	]);
});

test("blocks on a criterion floor the flat mean would hide", () => {
	const reports = [
		report({ criterion: "literal-task" }),
		report({ criterion: "literal-task" }),
		report({ criterion: "evidence" }),
		report({ criterion: "evidence" }),
		report({ criterion: "safety", score: 0, blocking_findings: ["no safety evidence"] }),
		report({ criterion: "safety", score: 0 }),
	];
	const flatMean = reports.reduce((sum, item) => sum + item.score, 0) / reports.length;
	// 4 ÷ 6 is below the threshold, so raise it explicitly to prove the floor —
	// not the mean — is what blocks this round.
	assert.ok(flatMean > 0.5);
	const outcome = aggregateVerification(reports, reports.length, { passThreshold: 0.5 });
	assert.equal(outcome.outcome, "fail");
	assert.equal(outcome.outcome === "fail" ? outcome.reason : undefined, "criterion_floor");
	assert.deepEqual(outcome.outcome === "fail" ? [...outcome.blocking_findings] : [], ["no safety evidence"]);
});

test("passes a criterion whose own mean sits exactly on the floor", () => {
	const outcome = aggregateVerification(
		[
			report({ criterion: "safety" }),
			report({ criterion: "safety", score: 0 }),
			report({ criterion: "literal-task" }),
			report({ criterion: "literal-task" }),
		],
		4,
		{ passThreshold: 0.5 },
	);
	assert.equal(outcome.outcome, "pass");
	assert.equal(outcome.outcome === "pass" ? outcome.score : undefined, 0.75);
});

test("fails below the threshold when every criterion clears its floor", () => {
	const outcome = aggregateVerification(
		[report({ score: 0.6, blocking_findings: ["weak evidence"] }), report({ score: 0.6 })],
		2,
	);
	assert.equal(outcome.outcome, "fail");
	assert.equal(outcome.outcome === "fail" ? outcome.reason : undefined, "below_threshold");
	assert.deepEqual(outcome.outcome === "fail" ? [...outcome.blocking_findings] : [], ["weak evidence"]);
});

test("passes a flat mean sitting exactly on the threshold", () => {
	const outcome = aggregateVerification([report(), report(), report(), report({ score: 0 })], 4);
	assert.equal(outcome.outcome, "pass");
	assert.equal(outcome.outcome === "pass" ? outcome.score : undefined, 0.75);
});

test("honors the criterionFloor option override", () => {
	const reports = [report({ criterion: "literal-task" }), report({ criterion: "safety", score: 0.4 })];
	const blocked = aggregateVerification(reports, 2, { criterionFloor: 0.5, passThreshold: 0.5 });
	assert.equal(blocked.outcome, "fail");
	assert.equal(blocked.outcome === "fail" ? blocked.reason : undefined, "criterion_floor");
	const relaxed = aggregateVerification(reports, 2, { criterionFloor: 0.1, passThreshold: 0.5 });
	assert.equal(relaxed.outcome, "pass");
});

test("is monotone in added passing verifiers", () => {
	// The property today's unanimity rule violates: another passing verifier
	// must never turn an accepted round into a rejected one.
	const base = [report(), report(), report()];
	let reports = [...base];
	let expected = base.length;
	assert.equal(aggregateVerification(reports, expected).outcome, "pass");
	for (let added = 0; added < 5; added += 1) {
		reports = [...reports, report()];
		expected += 1;
		const outcome = aggregateVerification(reports, expected);
		assert.equal(outcome.outcome, "pass", `adding ${added + 1} passing reports must not fail the round`);
		assert.equal(outcome.outcome === "pass" ? outcome.score : undefined, 1);
	}
});

test("does not mutate the reports it is given", () => {
	const reports = [report({ blocking_findings: ["finding"], veto_findings: ["veto"] })];
	const snapshot = JSON.stringify(reports);
	aggregateVerification(reports, 1);
	assert.equal(JSON.stringify(reports), snapshot);
});
