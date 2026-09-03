import assert from "node:assert/strict";
import { test } from "vitest";
import {
	targetSegmentsInPossibleStages as inSetIntercom,
	matchStagePathSegments as matchIntercom,
} from "../../packages/intercom/workflow-stage-path-matching.js";
import {
	targetSegmentsInPossibleStages as inSetWorkflows,
	matchStagePathSegments as matchWorkflows,
	splitStagePathSegments,
} from "../../packages/workflows/src/shared/workflow-stage-path-matching.js";

/**
 * Amendment A1: packages/workflows and packages/intercom each carry a private mirror of
 * the stage-path glob grammar (no cross-package imports). This parity test runs both
 * implementations over one fixture table and fails if they ever diverge.
 */

interface Fixture {
	readonly pattern: readonly string[];
	readonly candidate: readonly string[];
	readonly expected: boolean;
}

const MATCH_FIXTURES: readonly Fixture[] = [
	{ pattern: ["orchestrator-*"], candidate: ["orchestrator-3"], expected: true },
	{ pattern: ["orchestrator-*"], candidate: ["orchestrator"], expected: false },
	{ pattern: ["review-*-*"], candidate: ["review-slice-1-2"], expected: true },
	{ pattern: ["**"], candidate: ["a"], expected: true },
	{ pattern: ["**"], candidate: ["a", "b"], expected: true },
	{ pattern: ["**"], candidate: ["a", "b", "c"], expected: true },
	{ pattern: ["a", "**", "b"], candidate: ["a", "b"], expected: true },
	{ pattern: ["a", "**", "b"], candidate: ["a", "x", "y", "b"], expected: true },
	{ pattern: ["a", "**"], candidate: ["a"], expected: true },
	{ pattern: ["**", "b"], candidate: ["b"], expected: true },
	{ pattern: ["orchestrator-*"], candidate: ["orchestrator-*"], expected: true },
	{ pattern: ["reviewer-*"], candidate: ["reviewer-a"], expected: true },
	// Raw matching is one-directional; membership (below) is bidirectional.
	{ pattern: ["reviewer-a"], candidate: ["reviewer-*"], expected: false },
	{ pattern: ["a*"], candidate: ["ab"], expected: true },
	{ pattern: ["a*"], candidate: ["aa"], expected: true },
	{ pattern: ["a*"], candidate: ["ba"], expected: false },
	{ pattern: ["Orchestrator-*"], candidate: ["orchestrator-3"], expected: false },
	{ pattern: [], candidate: [], expected: true },
	{ pattern: [], candidate: ["a"], expected: false },
	{ pattern: ["a"], candidate: [], expected: false },
	{ pattern: ["workflow:child", "review"], candidate: ["workflow:child", "review"], expected: true },
	{ pattern: ["workflow:child", "review"], candidate: ["workflow:child", "approve"], expected: false },
];

const MEMBERSHIP_FIXTURES: readonly {
	readonly target: readonly string[];
	readonly set: readonly string[];
	readonly expected: boolean;
}[] = [
	{ target: ["orchestrator-3"], set: ["implement-slice-2/reviewer-a", "orchestrator-*"], expected: true },
	{ target: ["orchestrator-*"], set: ["orchestrator-*", "pull-request"], expected: true },
	{ target: ["orchestrator-9"], set: ["orchestrator-*"], expected: true },
	{ target: ["reviewer-a"], set: ["reviewer-*"], expected: true },
	{ target: ["ghost"], set: ["orchestrator-*"], expected: false },
	{ target: ["x"], set: [], expected: false },
	{ target: ["slice-2", "reviewer-a"], set: ["slice-*/reviewer-*"], expected: true },
];

test("both mirrored matchers agree on every fixture", () => {
	for (const fixture of MATCH_FIXTURES) {
		const intercom = matchIntercom(fixture.pattern, fixture.candidate);
		const workflows = matchWorkflows(fixture.pattern, fixture.candidate);
		assert.equal(
			workflows,
			fixture.expected,
			`workflows matcher (${JSON.stringify(fixture.pattern)} vs ${JSON.stringify(fixture.candidate)})`,
		);
		assert.equal(intercom, workflows, `mirror divergence on ${JSON.stringify(fixture)}`);
	}
});

test("both mirrored membership checks agree on every fixture", () => {
	for (const fixture of MEMBERSHIP_FIXTURES) {
		const workflows = inSetWorkflows(fixture.target, fixture.set);
		const intercom = inSetIntercom(fixture.target, fixture.set);
		assert.equal(workflows, fixture.expected, `workflows membership on ${JSON.stringify(fixture)}`);
		assert.equal(intercom, workflows, `mirror divergence on ${JSON.stringify(fixture)}`);
	}
});

test("segment splitting is identical", () => {
	assert.deepEqual(splitStagePathSegments("a/b/c"), ["a", "b", "c"]);
	assert.deepEqual(splitStagePathSegments("a"), ["a"]);
	assert.deepEqual(splitStagePathSegments(""), [""]);
});
