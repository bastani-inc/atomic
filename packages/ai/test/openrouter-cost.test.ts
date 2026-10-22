import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Usage } from "../src/types.ts";
import { applyOpenRouterReportedCost, isOpenRouterModel } from "../src/utils/openrouter-cost.ts";

function usage(total = 1): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0.25, output: 0.75, cacheRead: 0, cacheWrite: 0, total },
	};
}

describe("isOpenRouterModel", () => {
	it("recognizes both the built-in provider and custom providers using OpenRouter's endpoint", () => {
		assert.equal(isOpenRouterModel({ provider: "openrouter", baseUrl: "https://example.com" }), true);
		assert.equal(isOpenRouterModel({ provider: "openrouter-work", baseUrl: "https://openrouter.ai/api/v1" }), true);
		assert.equal(isOpenRouterModel({ provider: "custom", baseUrl: "https://example.com/v1" }), false);
	});
});

describe("applyOpenRouterReportedCost", () => {
	it("uses OpenRouter's reported cost for non-BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0,
			is_byok: false,
			cost_details: {
				upstream_inference_cost: 0,
				upstream_inference_prompt_cost: 0,
				upstream_inference_completions_cost: 0,
			},
		});
		assert.equal(value.cost.total, 0);
		assert.equal(value.cost.totalFromProvider, true);
	});

	it("adds the upstream inference cost for BYOK requests", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: 0.9,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		assert.equal(value.cost.total, 1);
		assert.equal(value.cost.totalFromProvider, true);
	});

	it("uses upstream cost components when OpenRouter omits their total", () => {
		const value = usage();
		applyOpenRouterReportedCost(value, {
			cost: 0.1,
			is_byok: true,
			cost_details: {
				upstream_inference_cost: null,
				upstream_inference_prompt_cost: 0.6,
				upstream_inference_completions_cost: 0.3,
			},
		});
		assert.ok(Math.abs(value.cost.total - 1) < 1e-9);
		assert.equal(value.cost.totalFromProvider, true);
	});

	it("keeps the catalog total when OpenRouter's accounting is incomplete", () => {
		const value = usage();
		value.cost.totalFromProvider = false;
		applyOpenRouterReportedCost(value, { cost: null, is_byok: false, cost_details: null });
		applyOpenRouterReportedCost(value, { cost: 0.1, is_byok: true, cost_details: null });
		assert.equal(value.cost.total, 1);
		assert.equal(value.cost.totalFromProvider, false);
	});
});
