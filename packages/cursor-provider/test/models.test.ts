import { beforeEach, describe, expect, it } from "bun:test";
import { clearCursorModelDiscoveryCache, discoverCursorModels, normalizeCursorModels } from "../models.ts";

describe("Cursor model discovery", () => {
	beforeEach(() => clearCursorModelDiscoveryCache());

	it("normalizes mocked GetUsableModels responses from Cursor bridge shapes", () => {
		const models = normalizeCursorModels({
			models: [
				{ modelId: "gpt-5-high", displayName: "GPT-5 High", contextWindow: 128000, maxTokens: 8192, thinkingDetails: {} },
				{ modelName: "composer-1", displayName: "Composer 1", maxContextTokens: 200000, maxOutputTokens: 16384 },
			],
		});

		expect(models).toEqual([
			{ id: "gpt-5", name: "GPT-5", reasoning: true, contextWindow: 128000, maxTokens: 8192, rawVariants: expect.any(Array) },
			{ id: "composer-1", name: "Composer 1", reasoning: false, contextWindow: 200000, maxTokens: 16384, rawVariants: expect.any(Array) },
		]);
	});

	it("caches discovered models by access token hash", async () => {
		let calls = 0;
		const resultA = await discoverCursorModels("token-a", {
			cacheTtlMs: 60_000,
			bridge: {
				async getUsableModels() {
					calls += 1;
					return { models: [{ id: "gpt-5-high", name: "GPT-5 High", supportsReasoning: true }] };
				},
			},
		});
		const resultB = await discoverCursorModels("token-a", {
			cacheTtlMs: 60_000,
			bridge: {
				async getUsableModels() {
					calls += 1;
					return { models: [{ id: "should-not-fetch" }] };
				},
			},
		});

		expect(calls).toBe(1);
		expect(resultB.models).toEqual(resultA.models);
		expect(resultB.source).toBe("cache");
	});

	it("retains only explicitly supplied usable models when discovery fails", async () => {
		const retained = [{ id: "cached-live", name: "Cached Live", reasoning: false, contextWindow: 10, maxTokens: 5 }];
		const result = await discoverCursorModels("token-b", {
			fallbackModels: retained,
			bridge: {
				async getUsableModels() {
					throw new Error("private API unavailable");
				},
			},
		});

		expect(result.source).toBe("fallback");
		expect(result.models).toEqual(retained);
		expect(result.warning).toContain("private API unavailable");
	});

	it("does not synthesize fake selectable models when discovery fails without cache", async () => {
		const result = await discoverCursorModels("token-c", {
			bridge: {
				async getUsableModels() {
					throw new Error("private API unavailable");
				},
			},
		});

		expect(result.source).toBe("fallback");
		expect(result.models).toEqual([]);
	});
});
