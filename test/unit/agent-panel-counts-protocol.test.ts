import assert from "node:assert/strict";
import { test } from "vitest";
import { parseInteractiveEngineMessage } from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";

test("isolated panel counts carry every eligible row and pending question independently of rendered lines (#5224)", () => {
	const message = { type: "engine_agent_panel_state", total: 17, needsInput: 2 };
	assert.deepEqual(parseInteractiveEngineMessage(JSON.stringify(message)), message);
	for (const counts of [
		{ total: -1, needsInput: 0 },
		{ total: 1.5, needsInput: 0 },
		{ total: 1, needsInput: 2 },
		{ total: 1, needsInput: -1 },
		{ total: 1, needsInput: "1" },
	]) {
		assert.equal(parseInteractiveEngineMessage(JSON.stringify({ type: message.type, ...counts })), undefined);
	}
});
