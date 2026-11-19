import assert from "node:assert/strict";
import { test } from "vitest";
import { DEFAULT_PROMPT_GUIDANCE } from "../../packages/subagents/src/extension/prompt-guidance.js";

test("delegation guidance keeps blocking work local without forbidding specialist dependencies", () => {
	const guidance = DEFAULT_PROMPT_GUIDANCE.join("\n");
	assert.ok(guidance.includes("Keep immediately blocking work local"));
	assert.ok(
		guidance.includes(
			"unless specialist expertise, context isolation, or an explicit user request justifies delegation",
		),
	);
	assert.ok(guidance.includes("Continue useful independent work after spawning"));
	assert.ok(guidance.includes("Avoid repeated short waits or status polls"));
	assert.ok(guidance.includes("Wait for terminal completion before starting dependent work"));
	assert.ok(guidance.includes("Subagents always run in the background: a launch returns once each child is admitted"));
	assert.ok(guidance.includes('subagent({ action: "wait", id })'));
	assert.ok(!guidance.includes('wait:{kind:"foreground"'), "no launch waits in the foreground");
});
