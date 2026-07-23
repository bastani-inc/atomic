import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";

const replacementTier = {
	inputTokensAbove: 100_000,
	input: 20,
	output: 30,
	cacheRead: 4,
	cacheWrite: 5,
};

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describeModelRegistry((context) => {
	describe("request-wide model cost tiers", () => {
		test("custom models retain complete tiers and price only strictly above aggregate input threshold", () => {
			context.writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "tiered-model",
							reasoning: false,
							input: ["text"],
							cost: {
								input: 1,
								output: 2,
								cacheRead: 0.5,
								cacheWrite: 0.75,
								tiers: [replacementTier],
							},
							contextWindow: 200_000,
							maxTokens: 8_000,
						},
					],
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("demo", "tiered-model");
			expect(registry.getError()).toBeUndefined();
			expect(model?.cost.tiers).toEqual([replacementTier]);
			if (!model) throw new Error("missing tiered custom model");

			const atThreshold = calculateCost(model, usage(1, 10, 99_999));
			expect(atThreshold.input).toBeCloseTo(0.000_001);
			expect(atThreshold.output).toBeCloseTo(0.000_02);
			expect(atThreshold.cacheRead).toBeCloseTo(0.049_999_5);

			const aboveThreshold = calculateCost(model, usage(1, 10, 100_000));
			expect(aboveThreshold.input).toBeCloseTo(0.000_02);
			expect(aboveThreshold.output).toBeCloseTo(0.000_3);
			expect(aboveThreshold.cacheRead).toBeCloseTo(0.4);
		});

		test("custom models reject incomplete cost tiers", () => {
			context.writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "invalid-tier",
							cost: {
								input: 1,
								output: 2,
								cacheRead: 0.5,
								cacheWrite: 0.75,
								tiers: [{ inputTokensAbove: 100_000, input: 20, output: 30, cacheRead: 4 }],
							},
						},
					],
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(registry.find("demo", "invalid-tier")).toBeUndefined();
			expect(registry.getError()).toContain("cacheWrite");
		});

		test("model overrides reject incomplete cost tiers", () => {
			context.writeRawModelsJson({
				openai: {
					modelOverrides: {
						"gpt-5.6-sol": {
							cost: { tiers: [{ inputTokensAbove: 100_000, input: 20, output: 30, cacheRead: 4 }] },
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(registry.getError()).toContain("cacheWrite");
		});

		test("scalar built-in override preserves inherited GPT-5.6 tiers", () => {
			context.writeRawModelsJson({
				openai: { modelOverrides: { "gpt-5.6-sol": { cost: { input: 99 } } } },
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("openai", "gpt-5.6-sol");
			expect(model?.cost.input).toBe(99);
			expect(model?.cost.output).toBeGreaterThan(0);
			expect(model?.cost.tiers?.length).toBeGreaterThan(0);
		});

		test("explicit tier override replaces inherited tiers and preserves unspecified scalar rates", () => {
			const baseline = ModelRegistry.create(context.authStorage).find("openai", "gpt-5.6-sol");
			context.writeRawModelsJson({
				openai: { modelOverrides: { "gpt-5.6-sol": { cost: { tiers: [replacementTier] } } } },
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("openai", "gpt-5.6-sol");
			expect(model?.cost.input).toBe(baseline?.cost.input);
			expect(model?.cost.output).toBe(baseline?.cost.output);
			expect(model?.cost.tiers).toEqual([replacementTier]);
		});

		test("empty tier override clears inherited tiers", () => {
			context.writeRawModelsJson({
				openai: { modelOverrides: { "gpt-5.6-sol": { cost: { tiers: [] } } } },
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(registry.find("openai", "gpt-5.6-sol")?.cost.tiers).toEqual([]);
		});

		test("dynamic provider model override replaces tiers while preserving unspecified scalar rates", () => {
			context.writeRawModelsJson({
				"extension-provider": {
					modelOverrides: {
						"demo-model": { cost: { output: 42, tiers: [replacementTier] } },
					},
				},
			});
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			registry.registerProvider("extension-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: {
							input: 1,
							output: 2,
							cacheRead: 3,
							cacheWrite: 4,
							tiers: [{ ...replacementTier, input: 10 }],
						},
						contextWindow: 128_000,
						maxTokens: 4_096,
					},
				],
			});

			const model = registry.find("extension-provider", "demo-model");
			expect(model?.cost).toEqual({
				input: 1,
				output: 42,
				cacheRead: 3,
				cacheWrite: 4,
				tiers: [replacementTier],
			});
		});
	});
});
