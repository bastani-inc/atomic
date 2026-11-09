import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY,
	CACHE_WARMING_MAX_AGE_MS,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	evaluateCacheWarming,
	getCacheWarmingDelayMs,
	getCacheWarmingRequestOptions,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
} from "../src/cache-warming.ts";
import type { Api, Model, SimpleStreamOptions } from "../src/types.ts";

function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 16384,
		promptCache: { short: 300, long: 3600 },
		...overrides,
	} as Model<Api>;
}

describe("cache warming policy", () => {
	const originalRetention = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalRetention === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = originalRetention;
	});

	it("exposes the shared limits", () => {
		expect(CACHE_WARMING_MAX_AGE_MS).toBe(60 * 60_000);
		expect(CACHE_WARMING_MAX_IDLE_AGE_MS).toBe(30 * 60_000);
		expect(CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS).toBe(0.05);
		expect(CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY).toBe(0.15);
	});

	describe("getCacheWarmingDelayMs", () => {
		it("refreshes at 90% of the lifetime and keeps ten seconds of margin", () => {
			expect(getCacheWarmingDelayMs(300_000)).toBe(270_000);
			expect(getCacheWarmingDelayMs(3_600_000)).toBe(3_240_000);
			expect(getCacheWarmingDelayMs(60_000)).toBe(50_000);
			expect(getCacheWarmingDelayMs(20_000)).toBe(10_000);
		});

		it("refuses lifetimes of ten seconds or less", () => {
			expect(getCacheWarmingDelayMs(10_000)).toBeUndefined();
			expect(getCacheWarmingDelayMs(0)).toBeUndefined();
			expect(getCacheWarmingDelayMs(10_001)).toBe(1);
		});
	});

	describe("getPromptCacheTtlMs", () => {
		it("uses the tier of the request's retention", () => {
			const model = createModel();
			expect(getPromptCacheTtlMs(model, { cacheRetention: "short" })).toBe(300_000);
			expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBe(3_600_000);
		});

		it("is undefined when the request turns caching off", () => {
			expect(getPromptCacheTtlMs(createModel(), { cacheRetention: "none" })).toBeUndefined();
		});

		it("defaults to the short tier", () => {
			expect(getPromptCacheTtlMs(createModel(), undefined)).toBe(300_000);
			expect(getPromptCacheTtlMs(createModel(), {})).toBe(300_000);
		});

		it("uses the long tier when PI_CACHE_RETENTION is long", () => {
			process.env.PI_CACHE_RETENTION = "long";
			expect(getPromptCacheTtlMs(createModel(), undefined)).toBe(3_600_000);
		});

		it("reads PI_CACHE_RETENTION from the request's env before the process env", () => {
			process.env.PI_CACHE_RETENTION = "long";
			expect(getPromptCacheTtlMs(createModel(), { env: { PI_CACHE_RETENTION: "short" } })).toBe(300_000);
			expect(getPromptCacheTtlMs(createModel(), { env: { PI_CACHE_RETENTION: "long" } })).toBe(3_600_000);
		});

		it("lets the request's cacheRetention override PI_CACHE_RETENTION", () => {
			process.env.PI_CACHE_RETENTION = "long";
			expect(getPromptCacheTtlMs(createModel(), { cacheRetention: "short" })).toBe(300_000);
		});

		it("is undefined when the model has no lifetime for the tier", () => {
			expect(
				getPromptCacheTtlMs(createModel({ promptCache: { short: 300 } }), { cacheRetention: "long" }),
			).toBeUndefined();
			expect(getPromptCacheTtlMs(createModel({ promptCache: undefined }), undefined)).toBeUndefined();
		});
	});

	describe("isCacheWarmingReplayable", () => {
		const budgetModel = createModel();
		const adaptiveModel = createModel({
			compat: { forceAdaptiveThinking: true },
		} as Partial<Model<Api>>);
		const openaiModel = createModel({ api: "openai-responses", provider: "openai" });

		it("refuses budget-based Anthropic thinking", () => {
			expect(isCacheWarmingReplayable(budgetModel, { reasoning: "medium" })).toBe(false);
		});

		it("replays Anthropic requests without reasoning", () => {
			expect(isCacheWarmingReplayable(budgetModel, undefined)).toBe(true);
			expect(isCacheWarmingReplayable(budgetModel, {})).toBe(true);
		});

		it("replays adaptive-thinking Anthropic models and other APIs", () => {
			expect(isCacheWarmingReplayable(adaptiveModel, { reasoning: "medium" })).toBe(true);
			expect(isCacheWarmingReplayable(openaiModel, { reasoning: "medium" })).toBe(true);
		});

		it("refuses Anthropic models whose adaptive thinking is not forced", () => {
			const model = createModel({ compat: { forceAdaptiveThinking: false } } as Partial<Model<Api>>);
			expect(isCacheWarmingReplayable(model, { reasoning: "medium" })).toBe(false);
		});
	});

	describe("getCacheWarmingRequestOptions", () => {
		it("caps output at one token, disables retries and continuation, and swaps the signal", () => {
			const original = new AbortController();
			const replacement = new AbortController();
			const options: SimpleStreamOptions = {
				maxTokens: 4096,
				maxRetries: 3,
				disableContinuation: false,
				signal: original.signal,
				sessionId: "session-1",
				cacheRetention: "long",
			};
			const warmed = getCacheWarmingRequestOptions(options, replacement.signal);
			expect(warmed).toEqual({
				maxTokens: 1,
				maxRetries: 0,
				disableContinuation: true,
				signal: replacement.signal,
				sessionId: "session-1",
				cacheRetention: "long",
			});
			expect(warmed.signal).toBe(replacement.signal);
		});

		it("does not modify the request's own options", () => {
			const options: SimpleStreamOptions = { maxTokens: 4096, maxRetries: 3 };
			getCacheWarmingRequestOptions(options, new AbortController().signal);
			expect(options).toEqual({ maxTokens: 4096, maxRetries: 3 });
		});
	});

	describe("evaluateCacheWarming", () => {
		const million = 1_000_000;

		it("prices a refresh as a cache read plus one output token against a cache write", () => {
			const decision = evaluateCacheWarming(createModel(), million, "streaming");
			expect(decision.phase).toBe("streaming");
			expect(decision.warmCost).toBeCloseTo(0.300015, 9);
			expect(decision.missCost).toBeCloseTo(3.45, 9);
			expect(decision.continuationProbability).toBe(1);
			expect(decision.expectedSavings).toBeCloseTo(3.149985, 9);
			expect(decision.economicsAvailable).toBe(true);
			expect(decision.action).toBe("warm");
		});

		it("discounts the miss cost by the idle continuation probability", () => {
			const decision = evaluateCacheWarming(createModel(), million, "idle");
			expect(decision.phase).toBe("idle");
			expect(decision.continuationProbability).toBe(CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY);
			expect(decision.expectedSavings).toBeCloseTo(0.15 * 3.45 - 0.300015, 9);
			expect(decision.action).toBe("warm");
		});

		it("stops when the expected savings fall below the minimum", () => {
			const decision = evaluateCacheWarming(createModel(), 100_000, "idle");
			expect(decision.expectedSavings).toBeLessThan(CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS);
			expect(decision.expectedSavings).toBeCloseTo(0.15 * 0.345 - 0.030015, 9);
			expect(decision.action).toBe("stop");
		});

		it("warms when the expected savings equal the minimum exactly", () => {
			const model = createModel({ cost: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } });
			const decision = evaluateCacheWarming(model, 50, "streaming");
			expect(decision.expectedSavings).toBe(CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS);
			expect(decision.action).toBe("warm");
		});

		it("prices a miss as a full-price input when the model has no cache write rate", () => {
			const model = createModel({ cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 } });
			const decision = evaluateCacheWarming(model, million, "streaming");
			expect(decision.missCost).toBeCloseTo(2.7, 9);
			expect(decision.warmCost).toBeCloseTo(0.300015, 9);
		});

		it("never reports a negative miss cost", () => {
			const model = createModel({ cost: { input: 1, output: 1, cacheRead: 5, cacheWrite: 0 } });
			const decision = evaluateCacheWarming(model, million, "streaming");
			expect(decision.missCost).toBe(0);
			expect(decision.expectedSavings).toBeLessThan(0);
			expect(decision.action).toBe("stop");
		});

		it("reports unavailable economics for an unknown prompt size", () => {
			const decision = evaluateCacheWarming(createModel(), 0, "streaming");
			expect(decision.economicsAvailable).toBe(false);
			expect(decision.warmCost).toBe(0.000015);
			expect(decision.missCost).toBe(0);
			expect(decision.action).toBe("stop");
		});

		it("reports unavailable economics for a model without prices", () => {
			const model = createModel({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
			const decision = evaluateCacheWarming(model, million, "streaming");
			expect(decision.economicsAvailable).toBe(false);
			expect(decision.action).toBe("stop");
		});

		it("keeps economics available when only a cache read has a price", () => {
			const model = createModel({ cost: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 } });
			expect(evaluateCacheWarming(model, million, "streaming").economicsAvailable).toBe(true);
		});

		it("keeps economics available when only a miss has a price", () => {
			const model = createModel({ cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } });
			expect(evaluateCacheWarming(model, million, "streaming").economicsAvailable).toBe(true);
		});

		it("uses the long-context tier of the prompt size", () => {
			const model = createModel({
				cost: {
					input: 1,
					output: 1,
					cacheRead: 0.1,
					cacheWrite: 1.25,
					tiers: [{ inputTokensAbove: 200_000, input: 2, output: 2, cacheRead: 0.2, cacheWrite: 2.5 }],
				},
			});
			const below = evaluateCacheWarming(model, 200_000, "streaming");
			const above = evaluateCacheWarming(model, 200_001, "streaming");
			expect(above.warmCost).toBeGreaterThan(below.warmCost * 1.9);
		});
	});
});
