import assert from "node:assert/strict";
import type { Usage } from "@bastani/pi-ai/compat";
import { describe, it } from "vitest";
import { combineUsage } from "../src/core/usage-totals.js";

function usage(total: number, totalFromProvider?: boolean): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total,
			...(totalFromProvider === undefined ? {} : { totalFromProvider }),
		},
	};
}

describe("combineUsage", () => {
	it("marks the combined total as provider-reported only when both totals are", () => {
		const bothFromProvider = combineUsage(usage(1, true), usage(2, true)).cost;
		assert.equal(bothFromProvider.total, 3);
		assert.equal(bothFromProvider.totalFromProvider, true);
		assert.equal(combineUsage(usage(1, true), usage(2)).cost.totalFromProvider, false);
		assert.equal(combineUsage(usage(1), usage(2, true)).cost.totalFromProvider, false);
		assert.equal(combineUsage(usage(1), usage(2)).cost.totalFromProvider, false);
	});
});
