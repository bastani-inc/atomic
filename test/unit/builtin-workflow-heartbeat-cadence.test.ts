import assert from "node:assert/strict";
import { describe, test } from "vitest";
import adversarialVerification from "../../packages/workflows/builtin/adversarial-verification.js";
import classifyAndAct from "../../packages/workflows/builtin/classify-and-act.js";
import fanOutAndSynthesize from "../../packages/workflows/builtin/fan-out-and-synthesize.js";
import generateAndFilter from "../../packages/workflows/builtin/generate-and-filter.js";
import goal from "../../packages/workflows/builtin/goal.js";
import loopUntilDone from "../../packages/workflows/builtin/loop-until-done.js";
import openClaudeDesign from "../../packages/workflows/builtin/open-claude-design.js";
import ralph from "../../packages/workflows/builtin/ralph.js";
import tournament from "../../packages/workflows/builtin/tournament.js";
import { DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES } from "../../packages/workflows/src/shared/workflow-heartbeat-contract.js";

/**
 * Every builtin states its heartbeat cadence rather than inheriting it, so a
 * change to the global default cannot silently re-cadence a long autonomous run
 * or start heartbeating a workflow that deliberately runs quiet.
 */
describe("builtin workflow heartbeat cadences", () => {
	const autonomous = [
		["adversarial-verification", adversarialVerification],
		["classify-and-act", classifyAndAct],
		["fan-out-and-synthesize", fanOutAndSynthesize],
		["generate-and-filter", generateAndFilter],
		["goal", goal],
		["loop-until-done", loopUntilDone],
		["ralph", ralph],
		["tournament", tournament],
	] as const;

	for (const [name, definition] of autonomous) {
		test(`${name} heartbeats on the 15-minute default`, () => {
			assert.equal(definition.heartbeatIntervalMinutes, 15);
			assert.equal(definition.heartbeatIntervalMinutes, DEFAULT_WORKFLOW_HEARTBEAT_INTERVAL_MINUTES);
		});
	}

	test("open-claude-design disables heartbeats", () => {
		// The user reviews generated HTML turn by turn, so the parent chat is
		// already holding this workflow to its goal; a periodic alignment steer
		// would interrupt that review rather than inform it.
		assert.equal(openClaudeDesign.heartbeatIntervalMinutes, 0);
	});

	test("every builtin states a cadence explicitly", () => {
		for (const [name, definition] of [...autonomous, ["open-claude-design", openClaudeDesign] as const]) {
			assert.equal(typeof definition.heartbeatIntervalMinutes, "number", `${name} must carry a resolved cadence`);
			assert.ok(
				Number.isFinite(definition.heartbeatIntervalMinutes) && definition.heartbeatIntervalMinutes >= 0,
				`${name} must carry a non-negative finite cadence`,
			);
		}
	});
});
