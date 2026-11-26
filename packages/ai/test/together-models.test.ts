import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import {
	buildModelsDevChatModels,
	finalizeChatModels,
	type ModelsDevCatalog,
} from "../src/utils/models-dev-catalog.ts";

const togetherInput = {
	together: {
		models: {
			"moonshotai/Kimi-K3": {
				id: "moonshotai/Kimi-K3",
				name: "Kimi K3",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 262_144, output: 32_768 },
				cost: { input: 1, output: 4 },
			},
			"openai/gpt-oss-120b": {
				id: "openai/gpt-oss-120b",
				name: "GPT-OSS 120B",
				tool_call: true,
				reasoning: true,
				reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
			},
			"deepseek-ai/DeepSeek-V4-Pro-0813": {
				id: "deepseek-ai/DeepSeek-V4-Pro-0813",
				name: "DeepSeek V4 Pro",
				tool_call: true,
				reasoning: true,
			},
		},
	},
} satisfies ModelsDevCatalog;

function generateTogetherModels() {
	return new Map(
		finalizeChatModels(buildModelsDevChatModels(togetherInput))
			.filter((model) => model.provider === "together")
			.map((model) => [model.id, model] as const),
	);
}

const originalTogetherApiKey = process.env.TOGETHER_API_KEY;

afterEach(() => {
	if (originalTogetherApiKey === undefined) {
		delete process.env.TOGETHER_API_KEY;
	} else {
		process.env.TOGETHER_API_KEY = originalTogetherApiKey;
	}
});

describe("Together models", () => {
	it("generates Kimi K3 for Together's OpenAI-compatible Chat Completions API", () => {
		const model = generateTogetherModels().get("moonshotai/Kimi-K3");

		expect(model).toBeDefined();
		if (!model) throw new Error("Kimi K3 is missing from the generated fixture catalog");
		expect(model.api).toBe("openai-completions");
		expect(model.provider).toBe("together");
		expect(model.baseUrl).toBe("https://api.together.ai/v1");
		expect(model.reasoning).toBe(true);
		expect(model.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null });
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(262_144);
		expect(model.maxTokens).toBe(32_768);
		expect(model.cost).toEqual({ input: 1, output: 4, cacheRead: 0, cacheWrite: 0 });
		expect(model.compat).toEqual({
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "together",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		});
	});

	it("models Together reasoning controls from the Together API surface", () => {
		const models = generateTogetherModels();
		const gptOss = models.get("openai/gpt-oss-120b");
		expect(gptOss?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			max: null,
			xhigh: null,
		});
		expect(gptOss?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "openai",
		});

		const deepSeekV4 = models.get("deepseek-ai/DeepSeek-V4-Pro-0813");
		expect(deepSeekV4?.thinkingLevelMap).toEqual({
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
		});
		expect(deepSeekV4?.compat).toMatchObject({
			supportsReasoningEffort: true,
			thinkingFormat: "together",
		});
	});

	it("resolves TOGETHER_API_KEY from the environment", () => {
		process.env.TOGETHER_API_KEY = "test-together-key";

		expect(findEnvKeys("together")).toEqual(["TOGETHER_API_KEY"]);
		expect(getEnvApiKey("together")).toBe("test-together-key");
	});
});
