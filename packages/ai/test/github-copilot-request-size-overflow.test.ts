import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { stream } from "../src/api/openai-responses.js";
import type { Model } from "../src/types.js";
import { isContextOverflow } from "../src/utils/overflow.js";
import { normalizeContext } from "../src/utils/transcript.js";

const model: Model<"openai-responses"> = {
	id: "copilot-test-model",
	name: "Copilot test model",
	api: "openai-responses",
	provider: "github-copilot",
	baseUrl: "https://copilot.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};

describe("Copilot HTTP request-size errors", () => {
	it.each([
		{ status: 413, nested: true, overflow: true },
		{ status: 413, nested: false, overflow: true },
		{ status: 400, nested: true, overflow: false },
	])("classifies HTTP $status with nested=$nested through the real SDK", async ({ status, nested, overflow }) => {
		const error = { message: "failed to parse request", code: "" };
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response(JSON.stringify(nested ? { error } : error), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);
		const result = await stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Continue", timestamp: 0 }] }),
			{ apiKey: "test-key", fetch, maxRetries: 0 },
		).result();

		assert.equal(fetch.mock.calls.length, 1);
		assert.equal(result.provider, "github-copilot");
		assert.equal(result.stopReason, "error");
		assert.equal(result.usage.totalTokens, 0);
		assert.ok(result.errorMessage?.includes(`(${status})`), result.errorMessage);
		assert.ok(result.errorMessage?.includes("failed to parse request"), result.errorMessage);
		assert.equal(isContextOverflow(result, model.contextWindow), overflow);
	});
});
