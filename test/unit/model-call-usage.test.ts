import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session-types.js";
import { modelCallUsage } from "../../packages/coding-agent/src/index.js";

const usage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0.3, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.5 },
};

const event = (value: unknown) => value as AgentSessionEvent;

describe("modelCallUsage (#5053)", () => {
	test("reports the usage of each kind of model call a session event carries (#5053)", () => {
		assert.equal(modelCallUsage(event({ type: "message_end", message: { role: "assistant", usage } })), usage);
		assert.equal(modelCallUsage(event({ type: "compaction_usage", reason: "threshold", usage })), usage);
		assert.equal(modelCallUsage(event({ type: "child_session_usage", usage })), usage);
		assert.equal(
			modelCallUsage(event({ type: "entry_appended", entry: { type: "usage", kind: "cache_warm", usage } })),
			usage,
		);
	});

	test("reports nothing for events that are not a model call (#5053)", () => {
		assert.equal(modelCallUsage(event({ type: "message_end", message: { role: "toolResult", usage } })), undefined);
		assert.equal(modelCallUsage(event({ type: "entry_appended", entry: { type: "message", usage } })), undefined);
		assert.equal(
			modelCallUsage(event({ type: "compaction_end", reason: "threshold", result: { usage } })),
			undefined,
		);
		assert.equal(modelCallUsage(event({ type: "agent_end", messages: [] })), undefined);
	});
});
