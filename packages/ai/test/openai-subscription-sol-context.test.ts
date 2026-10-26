import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { openaiCodexProvider } from "../src/providers/openai-codex.js";
import { openaiProvider } from "../src/providers/openai.js";

const oauth = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
const apiKey = { type: "api_key" as const, key: "sk-test" };

describe("openai provider GPT-6.1 Sol auth-aware limits", () => {
	it("gives ChatGPT subscription OAuth 500K context and flat pricing while API keys keep long-context pricing", () => {
		const provider = openaiProvider();
		const models = provider.getModels();
		const apiSol = provider.filterModels?.(models, apiKey)?.find((model) => model.id === "gpt-6.1-sol");
		assert.equal(apiSol?.contextWindow, 272_000);
		assert.ok(apiSol?.cost.tiers);

		const available = provider.filterModels?.(models, oauth) ?? [];
		const sol = available.find((model) => model.id === "gpt-6.1-sol");
		assert.ok(sol);
		assert.equal(sol.contextWindow, 500_000);
		assert.equal(sol.cost.tiers, undefined);
		assert.deepEqual(
			sol.serviceTiers?.map((tier) => tier.id),
			apiSol?.serviceTiers?.map((tier) => tier.id),
		);
		for (const tier of sol.serviceTiers ?? []) assert.equal(tier.cost.tiers, undefined);

		const unrelated = models.find((model) => model.id !== "gpt-6.1-sol" && !model.fastRoute);
		assert.ok(unrelated);
		assert.deepEqual(
			available.find((model) => model.id === unrelated.id),
			unrelated,
		);
	});

	it("keeps Codex subscription limits when refreshed Sol metadata carries API limits and pricing", () => {
		const provider = openaiCodexProvider();
		const sol = provider.getModels().find((model) => model.id === "gpt-6.1-sol");
		const apiSol = openaiProvider().getModels().find((model) => model.id === "gpt-6.1-sol");
		assert.ok(sol);
		assert.ok(apiSol);
		const stale = { ...sol, contextWindow: apiSol.contextWindow, cost: apiSol.cost, serviceTiers: apiSol.serviceTiers };
		const [available] = provider.filterModels?.([stale], oauth) ?? [];
		assert.equal(available?.contextWindow, 500_000);
		assert.equal(available?.cost.tiers, undefined);
		assert.deepEqual(available?.serviceTiers?.map((tier) => tier.id), ["priority", "ultrafast"]);
		for (const tier of available?.serviceTiers ?? []) assert.equal(tier.cost.tiers, undefined);
		assert.equal(stale.contextWindow, 272_000);
		assert.ok(stale.cost.tiers);
	});

	it("gives GPT-6.1 Terra the 500K subscription context but keeps its long-context pricing", () => {
		const provider = openaiProvider();
		const models = provider.getModels();
		const apiTerra = provider.filterModels?.(models, apiKey)?.find((model) => model.id === "gpt-6.1-terra");
		assert.equal(apiTerra?.contextWindow, 272_000);
		assert.ok(apiTerra?.cost.tiers);

		const terra = provider.filterModels?.(models, oauth)?.find((model) => model.id === "gpt-6.1-terra");
		assert.equal(terra?.contextWindow, 500_000);
		assert.deepEqual(terra?.cost, apiTerra?.cost);
		assert.deepEqual(terra?.serviceTiers, apiTerra?.serviceTiers);

		const codexTerra = openaiCodexProvider()
			.getModels()
			.find((model) => model.id === "gpt-6.1-terra");
		assert.equal(codexTerra?.contextWindow, 500_000);
		assert.ok(codexTerra?.cost.tiers);
	});
});
