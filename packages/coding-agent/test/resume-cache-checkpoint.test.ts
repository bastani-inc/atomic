import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { Message } from "@bastani/atomic-ai";
import { test } from "vitest";
import { restoredCacheCheckpoint, withCacheCheckpoint } from "../src/core/resume-cache-checkpoint.js";

const reply: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "second answer" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 3,
};

test("a history that ends with a system message, as after a model switch before a quit, still gets its checkpoint", () => {
	const restored: AgentMessage[] = [
		{ role: "user", content: "second task", timestamp: 2 },
		reply,
		{ role: "system", content: "", sections: { model: "<model>\nB\n</model>" }, timestamp: 4 },
	];
	const checkpoint = restoredCacheCheckpoint(restored);
	assert.equal(checkpoint, reply);

	// A request that rebuilds system messages as new objects, as a subagent's prompt projection does.
	const projected: AgentMessage[] = restored.map((message) => (message.role === "system" ? { ...message } : message));
	const next: AgentMessage = { role: "user", content: "third task", timestamp: 5 };
	const messages = [...projected, next];
	const rows = messages as Message[];
	const result = withCacheCheckpoint(messages, rows, rows, checkpoint!);
	assert.equal(result.keep, true);
	assert.deepEqual(
		result.converted.map((message) => ("cacheBreakpoint" in message ? message.cacheBreakpoint === true : false)),
		[false, true, false, false],
	);
});
