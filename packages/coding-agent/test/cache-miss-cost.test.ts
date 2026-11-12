import assert from "node:assert/strict";
import type { AssistantMessage, Usage } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import {
	collectCacheMisses,
	computeCacheWaste,
	estimateCompactionCacheMiss,
	formatCacheCost,
	formatCacheMissNotice,
	formatCacheWaste,
	formatCompactionCacheMissNotice,
	type ModelPriceSource,
} from "../src/core/cache-stats.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const PER_MILLION = 1_000_000;
const ISSUE_TOKENS = 257_225;

interface Rates {
	input: number;
	cacheRead: number;
}

/** A request whose catalog-derived costs follow `rates` (USD per million tokens). */
function priced(input: number, cacheRead: number, rates: Rates, reported?: number): Usage {
	const cost = {
		input: (input * rates.input) / PER_MILLION,
		output: 0,
		cacheRead: (cacheRead * rates.cacheRead) / PER_MILLION,
		cacheWrite: 0,
	};
	const catalogTotal = cost.input + cost.cacheRead;
	return {
		input,
		output: 10,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + cacheRead + 10,
		cost:
			reported === undefined
				? { ...cost, total: catalogTotal }
				: { ...cost, total: reported, totalFromProvider: true },
	};
}

function assistantEntry(id: string, timestamp: number, usage: Usage): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "gateway",
		model: "flash",
		usage,
		stopReason: "stop",
		timestamp,
	};
	return { type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message };
}

function models(rates: Rates): ModelPriceSource {
	return { getModel: () => ({ cost: rates }) };
}

/** A fully cached request followed by one that re-bills `tokens` uncached. */
function missAfterCachedRequest(tokens: number, rates: Rates, reported?: number): SessionEntry[] {
	return [
		assistantEntry("cached", 0, priced(100, tokens, rates)),
		assistantEntry("missed", 1_000, priced(tokens, 0, rates, reported)),
	];
}

function onlyMissNotice(entries: SessionEntry[], rates: Rates): string {
	const misses = [...collectCacheMisses(entries, models(rates)).values()];
	assert.equal(misses.length, 1);
	return formatCacheMissNotice(misses[0]!);
}

describe("cache-miss cost display (#4688)", () => {
	test("reports the issue's near-equal-rate miss at the full input rate, never $0.000 (#4688)", () => {
		const rates = { input: 0.042, cacheRead: 0.041 };
		assert.equal(
			onlyMissNotice(missAfterCachedRequest(ISSUE_TOKENS, rates), rates),
			"Prompt cache miss: 257,225 tokens re-billed ($0.011, <$0.001 more than a cache hit)",
		);
	});

	test("reports a large-token miss even when its extra cost is far below the cost gate (#4688)", () => {
		const rates = { input: 0.042, cacheRead: 0.041 };
		const waste = computeCacheWaste(missAfterCachedRequest(ISSUE_TOKENS, rates), models(rates));
		assert.equal(waste.missCount, 1);
		assert.equal(waste.missedTokens, ISSUE_TOKENS);
		assert.ok(waste.missedCost > 0 && waste.missedCost < 0.001);
	});

	test("shows both the re-billed cost and the extra over a hit for a normally priced model (#4688)", () => {
		const rates = { input: 3, cacheRead: 0.3 };
		assert.equal(
			onlyMissNotice(missAfterCachedRequest(40_000, rates), rates),
			"Prompt cache miss: 40,000 tokens re-billed ($0.120, $0.108 more than a cache hit)",
		);
	});

	test("says the cost is unknown for a zero-rate custom model without a provider-reported cost (#4688)", () => {
		const rates = { input: 0, cacheRead: 0 };
		assert.equal(
			onlyMissNotice(missAfterCachedRequest(ISSUE_TOKENS, rates), rates),
			"Prompt cache miss: 257,225 tokens re-billed (cost unknown)",
		);
	});

	test("shows the provider-reported request cost for a zero-rate custom model (#4688)", () => {
		const rates = { input: 0, cacheRead: 0 };
		assert.equal(
			onlyMissNotice(missAfterCachedRequest(ISSUE_TOKENS, rates, 0.0123), rates),
			"Prompt cache miss: 257,225 tokens re-billed (provider billed $0.012 for the request)",
		);
	});

	test("renders sub-quantum amounts as an upper bound and exact zero as zero (#4688)", () => {
		assert.equal(formatCacheCost(0.000257), "<$0.001");
		assert.equal(formatCacheCost(0.00003, 4), "<$0.0001");
		assert.equal(formatCacheCost(0.0108), "$0.011");
		assert.equal(formatCacheCost(0), "$0.000");
	});

	test("stats waste keeps the extra-over-a-hit total with the shared formatting (#4688)", () => {
		const nearEqual = { input: 0.042, cacheRead: 0.041 };
		assert.equal(
			formatCacheWaste(computeCacheWaste(missAfterCachedRequest(ISSUE_TOKENS, nearEqual), models(nearEqual))),
			"$0.0003 (1 miss)",
		);
		const tiny = missAfterCachedRequest(30_000, nearEqual);
		assert.equal(formatCacheWaste(computeCacheWaste(tiny, models(nearEqual))), "<$0.0001 (1 miss)");
		const zero = { input: 0, cacheRead: 0 };
		assert.equal(
			formatCacheWaste(computeCacheWaste(missAfterCachedRequest(ISSUE_TOKENS, zero, 0.0123), models(zero))),
			"unknown (1 miss without pricing)",
		);
		const mixed = [
			...missAfterCachedRequest(40_000, { input: 3, cacheRead: 0.3 }),
			assistantEntry("cached-again", 2_000, priced(100, 40_000, zero)),
			assistantEntry("missed-again", 3_000, priced(40_000, 0, zero)),
		];
		assert.equal(
			formatCacheWaste(computeCacheWaste(mixed, models({ input: 3, cacheRead: 0.3 }))),
			"$0.1080 (2 misses, 1 without pricing)",
		);
	});

	test("background compaction expectation shows the re-billed cost and keeps the extra over a hit (#4688)", () => {
		const rates = { input: 0.042, cacheRead: 0.041 };
		const cached = [assistantEntry("cached", 0, priced(100, ISSUE_TOKENS, rates))];
		const miss = estimateCompactionCacheMiss(cached, ISSUE_TOKENS, models(rates));
		assert.ok(miss);
		assert.ok(Math.abs(miss.expectedMissedCost - (ISSUE_TOKENS * 0.001) / PER_MILLION) < 1e-12);
		assert.equal(
			formatCompactionCacheMissNotice(miss),
			"Prompt cache miss expected after background compaction: 257,225 tokens re-billed ($0.011, <$0.001 more than a cache hit)",
		);
		const zero = { input: 0, cacheRead: 0 };
		const unpriced = estimateCompactionCacheMiss(
			[assistantEntry("cached", 0, priced(100, ISSUE_TOKENS, zero))],
			ISSUE_TOKENS,
			models(zero),
		);
		assert.ok(unpriced);
		assert.equal(
			formatCompactionCacheMissNotice(unpriced),
			"Prompt cache miss expected after background compaction: 257,225 tokens re-billed (cost unknown)",
		);
	});
});
