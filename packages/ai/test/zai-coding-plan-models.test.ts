import { expect, it } from "vitest";
import { publishedModel } from "./live-catalog-model.ts";

it("exposes GLM-4.6V on the China Coding Plan catalog", (ctx) => {
	const model = publishedModel("zai-coding-cn", "glm-4.6v", ctx);

	expect(model).toMatchObject({
		id: "glm-4.6v",
		provider: "zai-coding-cn",
		api: "openai-completions",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 0.9, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 32768,
		compat: {
			maxTokensField: "max_tokens",
			thinkingFormat: "zai",
			zaiToolStream: true,
		},
	});
});

it("uses API-equivalent reference costs for Coding Plan models", (ctx) => {
	expect(publishedModel("zai", "glm-5.2", ctx).cost).toEqual({
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(publishedModel(provider, "glm-5.3", ctx).cost).toEqual({
			input: 1.4,
			output: 4.4,
			cacheRead: 0.26,
			cacheWrite: 0,
		});
	}
});

it("keeps zero costs for Coding Plan models without a matching API price", (ctx) => {
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	expect(publishedModel("zai", "glm-5.2-highspeed", ctx).cost).toEqual(zeroCost);

	for (const provider of ["zai", "zai-coding-cn"] as const) {
		expect(publishedModel(provider, "glm-5.3-highspeed", ctx).cost).toEqual(zeroCost);
	}
});
