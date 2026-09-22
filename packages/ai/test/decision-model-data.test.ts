import { describe, expect, it } from "vitest";
import { generateDecisionModelsFile, parseModelsDevDecisionModels } from "../scripts/generate-decision-models.ts";
import { getDecisionModel, getDecisionModels } from "../src/decision-models.ts";

const payload = {
	opencode: {
		models: {
			"jev-1.13": {
				id: "jev-1.13",
				name: "Jev 1.13",
				type: "decision",
				limit: { context: 64000 },
				cost: { input: 0.042, output: 0 },
			},
			"jev-1.13-free": {
				id: "jev-1.13-free",
				name: "Jev 1.13 Free",
				type: "decision",
				limit: { context: 64000 },
				cost: { input: 0, output: 0 },
			},
			"gpt-6-sol": { id: "gpt-6-sol", name: "GPT-6 Sol", tool_call: true, limit: { context: 272000 } },
		},
	},
	vercel: {
		models: {
			"typesafe-ai/jev": {
				id: "typesafe-ai/jev",
				name: "Jev",
				type: "decision",
				limit: { context: 32000 },
				cost: { input: 0.042, output: 0, cache_read: 0.021 },
			},
		},
	},
};

describe("models.dev decision catalog", () => {
	it("keeps only decision-type rows, sorted by provider and id, with normalized cost", () => {
		expect(parseModelsDevDecisionModels(payload, true)).toEqual([
			{
				provider: "opencode",
				id: "jev-1.13",
				name: "Jev 1.13",
				contextWindow: 64000,
				cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				provider: "opencode",
				id: "jev-1.13-free",
				name: "Jev 1.13 Free",
				contextWindow: 64000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			{
				provider: "vercel",
				id: "typesafe-ai/jev",
				name: "Jev",
				contextWindow: 32000,
				cost: { input: 0.042, output: 0, cacheRead: 0.021, cacheWrite: 0 },
			},
		]);
	});

	it("fails strict generation when the catalog has no decision rows or a row lacks a context limit", () => {
		expect(() => parseModelsDevDecisionModels({ opencode: { models: {} } }, true)).toThrow("no decision models");
		expect(() =>
			parseModelsDevDecisionModels({ x: { models: { jev: { id: "jev", type: "decision" } } } }, true),
		).toThrow("x/jev has no context limit");
		expect(parseModelsDevDecisionModels({ x: { models: { jev: { id: "jev", type: "decision" } } } }, false)).toEqual(
			[],
		);
	});

	it("writes a generated module whose rows round-trip through the runtime accessors", () => {
		const source = generateDecisionModelsFile(parseModelsDevDecisionModels(payload, true));
		expect(source).toContain('provider: "opencode"');
		expect(source).toContain('id: "typesafe-ai/jev"');
		expect(source).toContain("export const DECISION_MODELS: readonly DecisionModel[]");
	});

	it("ships the Jev gateways models.dev lists in the bundled catalog", () => {
		expect(getDecisionModels().length).toBeGreaterThan(0);
		expect(getDecisionModel("opencode", "jev-1.13")).toMatchObject({ name: "Jev 1.13", contextWindow: 64000 });
		expect(getDecisionModel("vercel", "typesafe-ai/jev")).toMatchObject({ contextWindow: 32000 });
		expect(getDecisionModel("openai", "gpt-6-sol")).toBeUndefined();
	});
});
