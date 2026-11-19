import assert from "node:assert/strict";
import { test } from "vitest";
import { deriveSessionActivity } from "../src/extensions/herdr/activity.js";

test("Herdr activity uses settled work", () => {
	assert.deepEqual(deriveSessionActivity({ agentRunning: false, openPromptCount: 0 }), {
		state: "idle",
		reason: "quiescent",
	});
	assert.deepEqual(deriveSessionActivity({ agentRunning: true, openPromptCount: 1 }), {
		state: "blocked",
		reason: "awaiting_input",
		message: "Waiting for approval",
	});
});
