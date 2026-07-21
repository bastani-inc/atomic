import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";

function requireModel(provider: "openai" | "openai-codex", id: string): Model<Api> {
	const model = getModels(provider).find((candidate) => candidate.id === id);
	assert.ok(model, `expected ${provider}/${id} in the pi-ai catalog`);
	return model;
}

function usage(input: number, output: number, cacheRead: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assertCost(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to equal ${expected}`);
}

describe("pi-ai 0.81.1 runtime compatibility", () => {
	test("uses one long-context tier for every GPT-5.5 cost bucket", () => {
		const model = requireModel("openai-codex", "gpt-5.5");

		const atThreshold = calculateCost(model, usage(1, 10, 271_999));
		assertCost(atThreshold.input, 0.000_005);
		assertCost(atThreshold.output, 0.000_3);
		assertCost(atThreshold.cacheRead, 0.135_999_5);

		const aboveThreshold = calculateCost(model, usage(1, 10, 272_000));
		assertCost(aboveThreshold.input, 0.000_01);
		assertCost(aboveThreshold.output, 0.000_45);
		assertCost(aboveThreshold.cacheRead, 0.272);
	});

	test("exposes only named GPT-5.6 variants with the corrected context window", () => {
		const variants = ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"];
		const openAiModels = getModels("openai");
		const codexModels = getModels("openai-codex");
		const azureModels = getModels("azure-openai-responses");

		assert.equal(openAiModels.some((model) => model.id === "gpt-5.6"), false);
		assert.equal(azureModels.some((model) => model.id === "gpt-5.6"), false);
		for (const id of variants) {
			assert.equal(requireModel("openai", id).contextWindow, 272_000);
			assert.equal(requireModel("openai-codex", id).contextWindow, 272_000);
		}
		assert.deepEqual(
			openAiModels.filter((model) => model.id.startsWith("gpt-5.6")).map((model) => model.id),
			variants,
		);
		assert.deepEqual(
			codexModels.filter((model) => model.id.startsWith("gpt-5.6")).map((model) => model.id),
			variants,
		);
	});
});
