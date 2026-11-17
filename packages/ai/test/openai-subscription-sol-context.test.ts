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

	it("gives GPT-6.2 Sol the 500K Codex context on a ChatGPT subscription and keeps its long-context pricing", () => {
		const provider = openaiProvider();
		const models = provider.getModels();
		const apiSol = provider.filterModels?.(models, apiKey)?.find((model) => model.id === "gpt-6.2-sol");
		assert.equal(apiSol?.contextWindow, 272_000);
		assert.ok(apiSol?.cost.tiers);

		const available = provider.filterModels?.(models, oauth) ?? [];
		const sol = available.find((model) => model.id === "gpt-6.2-sol");
		assert.equal(sol?.contextWindow, 500_000);
		assert.deepEqual(sol?.cost, apiSol?.cost);
		assert.deepEqual(sol?.serviceTiers, apiSol?.serviceTiers);
		assert.equal(available.find((model) => model.id === "gpt-6.2-astra")?.contextWindow, 272_000);

		const codexSol = openaiCodexProvider().getModels().find((model) => model.id === "gpt-6.2-sol");
		assert.ok(codexSol);
		const [refreshed] = openaiCodexProvider().filterModels?.([{ ...codexSol, contextWindow: 272_000 }], oauth) ?? [];
		assert.equal(refreshed?.contextWindow, 500_000);
	});
});
