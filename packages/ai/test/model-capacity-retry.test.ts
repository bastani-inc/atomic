import assert from "node:assert/strict";
import { test } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { retryAssistantCall } from "../src/utils/retry.js";

test("retries Selected model is at capacity errors (#10278)", async () => {
	let attempts = 0;
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	const result = await retryAssistantCall(
		async () => {
			attempts++;
			return attempts === 1
				? { ...message, stopReason: "error", errorMessage: "Selected model is at capacity" }
				: message;
		},
		{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		undefined,
	);
	assert.equal(result.stopReason, "stop");
	assert.equal(attempts, 2);
});
