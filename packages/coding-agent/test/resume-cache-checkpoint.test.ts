import assert from "node:assert/strict";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { Message } from "@bastani/atomic-ai";
import { getModel } from "@bastani/atomic-ai/compat";
import { describe, test } from "vitest";
import {
	clearsForResumedBudget,
	restoredCacheCheckpoint,
	withCacheCheckpoint,
} from "../src/core/resume-cache-checkpoint.js";

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

describe("clearing the context before the first request after a resume near the window (#6117)", () => {
	// 32,768-token window: a request keeps the 8,192 budget and 1,024 answer tokens while its input is at most
	// 32,768 - 4,096 - 9,216 = 19,456 tokens.
	const model = { ...getModel("anthropic", "claude-sonnet-4-5"), contextWindow: 32_768, maxTokens: 32_768 };
	const lastReply = (input: number, sent: number): AgentMessage =>
		({
			...reply,
			model: model.id,
			usage: { ...reply.usage, input, totalTokens: input },
			thinkingBudgetTokens: sent,
			requestedThinkingBudget: 8192,
			thinkingLevel: "medium",
		}) as AgentMessage;
	/** About `tokens` tokens of text at 3.5 characters a token. */
	const text = (tokens: number, role: "user" | "custom" = "user"): AgentMessage =>
		role === "user"
			? { role: "user", content: "x".repeat(tokens * 3.5), timestamp: 6 }
			: { role: "custom", customType: "note", content: "y".repeat(tokens * 3.5), display: false, timestamp: 5 };
	const first: AgentMessage = { role: "user", content: "first", timestamp: 1 };
	const request = (history: AgentMessage[], resumeOnly: AgentMessage[]) => ({
		model,
		thinkingLevel: "medium" as const,
		thinkingBudgets: undefined,
		history,
		resumeOnly,
		prompt: [text(10)],
		cleared: [text(500), ...resumeOnly],
	});

	test("clears when only what the resume added lowers the budget the history was sent with", () => {
		const history = [first, lastReply(18_000, 8192)];
		assert.equal(clearsForResumedBudget(request(history, [text(3_000, "custom")])), true);
		// Without the resume's 3,000 tokens the budget fits: nothing to clear for.
		assert.equal(clearsForResumedBudget(request(history, [])), false);
	});

	test("does not clear when the history and the input alone would already lower the budget", () => {
		const history = [first, lastReply(19_800, 8192)];
		assert.equal(clearsForResumedBudget(request(history, [text(3_000, "custom")])), false);
	});

	test("does not clear when the request still sends the lower budget the history was sent with", () => {
		// The last request before the exit counted its input higher and sent 6,144. With what the resume added, the
		// request's 18,000 + 3,494 + 10 = 21,504 tokens leave 32,768 - 21,504 - 4,096 = 7,168, so it sends
		// 7,168 - 1,024 = 6,144 again: the budget of the cached history, which a clear would only throw away.
		const history = [first, lastReply(18_000, 6144)];
		const added = text(21_504 - 18_000 - 10, "custom");
		assert.equal(clearsForResumedBudget(request(history, [added])), false);
	});

	test("does not clear when what the resume added does not fit the whole budget even after a clear", () => {
		const history = [first, lastReply(18_000, 8192)];
		assert.equal(clearsForResumedBudget(request(history, [text(19_000, "custom")])), false);
	});

	test("does not clear for a reply on another model, or without a fixed budget", () => {
		const added = [text(3_000, "custom")];
		const otherModel = { ...lastReply(18_000, 8192), model: "claude-opus-4-5" } as AgentMessage;
		assert.equal(clearsForResumedBudget(request([first, otherModel], added)), false);
		const adaptive = { ...lastReply(18_000, 8192), thinkingBudgetTokens: undefined } as AgentMessage;
		assert.equal(clearsForResumedBudget(request([first, adaptive], added)), false);
	});
});
