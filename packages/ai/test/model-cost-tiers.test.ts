import assert from "node:assert/strict";
import { test } from "vitest";
import { getAiGatewayCost } from "../scripts/ai-gateway-pricing.ts";
import { buildOpenRouterCatalog } from "../scripts/openrouter-catalog.ts";

test("OpenRouter skips time-dependent pricing overrides", () => {
	const catalog = buildOpenRouterCatalog(
		[
			{
				id: "example/model",
				name: "Example",
				supported_parameters: ["tools"],
				pricing: {
					prompt: "0.000002",
					completion: "0.000012",
					overrides: [{ min_prompt_tokens: 1000, utc_days: ["saturday"], prompt: "0.000001" }],
				},
			},
		],
		[],
		[],
	);
	assert.deepEqual(catalog.chat[0].cost, { input: 2, output: 12, cacheRead: 0, cacheWrite: 0 });
});

test("OpenRouter prompt-length overrides retain unlisted base rates", () => {
	const catalog = buildOpenRouterCatalog(
		[
			{
				id: "example/model",
				name: "Example",
				supported_parameters: ["tools"],
				pricing: {
					prompt: "0.000002",
					completion: "0.000012",
					input_cache_read: "0.0000002",
					input_cache_write: "0.000000375",
					overrides: [{ min_prompt_tokens: 200000, prompt: "0.000004", completion: "0.000018" }],
				},
			},
		],
		[],
		[],
	);
	assert.deepEqual(catalog.chat[0].cost.tiers, [
		{ inputTokensAbove: 200000, input: 4, output: 18, cacheRead: 0.2, cacheWrite: 0.375 },
	]);
});

test("AI Gateway combines per-rate brackets into request-wide pricing tiers", () => {
	assert.deepEqual(
		getAiGatewayCost({
			input: "0.000001",
			output: "0.000005",
			input_cache_read: "0.0000002",
			input_tiers: [
				{ min: 0, max: 32001, cost: "0.000001" },
				{ min: 32001, max: 128001, cost: "0.0000018" },
				{ min: 128001, cost: "0.000003" },
			],
			output_tiers: [
				{ min: 0, max: 32001, cost: "0.000005" },
				{ min: 32001, max: 128001, cost: "0.000009" },
				{ min: 128001, cost: "0.000015" },
			],
		}),
		{
			input: 1,
			output: 5,
			cacheRead: 0.2,
			cacheWrite: 0,
			tiers: [
				{ inputTokensAbove: 32000, input: 1.8, output: 9, cacheRead: 0.2, cacheWrite: 0 },
				{ inputTokensAbove: 128000, input: 3, output: 15, cacheRead: 0.2, cacheWrite: 0 },
			],
		},
	);
});

test("AI Gateway returns base pricing without brackets", () => {
	assert.deepEqual(getAiGatewayCost({ input: "0.000003", output: 0.000015 }), {
		input: 3,
		output: 15,
		cacheRead: 0,
		cacheWrite: 0,
	});
});
