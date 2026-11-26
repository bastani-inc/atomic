import { expect, expectTypeOf, it } from "vitest";
import { flattenChatModelCatalog } from "../src/model-catalog.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import { publishedModel } from "./live-catalog-model.ts";

it("derives each model's API, ID, and provider literals from grouped model data", () => {
	const catalog = flattenChatModelCatalog("test-provider", {
		"openai-responses": {
			"chat:example-responses": { type: "chat", id: "example-responses" },
		},
		"bedrock-converse-stream": {
			"chat:example-bedrock": { type: "chat", id: "example-bedrock" },
		},
	});
	expectTypeOf(catalog["example-responses"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(catalog["example-responses"].id).toEqualTypeOf<"example-responses">();
	expectTypeOf(catalog["example-responses"].provider).toEqualTypeOf<"test-provider">();
	expectTypeOf(catalog["example-bedrock"].api).toEqualTypeOf<"bedrock-converse-stream">();
	expectTypeOf(catalog["example-bedrock"].id).toEqualTypeOf<"example-bedrock">();
});

it("routes GitHub Copilot Grok 4.5 through the Responses API when published", (ctx) => {
	expect(publishedModel("github-copilot", "grok-4.5", ctx).api).toBe("openai-responses");
});

it("routes all published GitHub Copilot GPT models through the Responses API (#9209)", ({ skip }) => {
	const gptModels = getBuiltinModels("github-copilot").filter((model) => model.id.startsWith("gpt-"));
	if (gptModels.length === 0) return skip("The generated GitHub Copilot catalog has no GPT models");
	for (const model of gptModels) expect(model.api, model.id).toBe("openai-responses");
});

it.for(["gpt-6-sol", "gpt-6-luna"])("publishes the Copilot %s limits and effort map", (id, ctx) => {
	expect(publishedModel("github-copilot", id, ctx)).toMatchObject({
		api: "openai-responses",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		thinkingLevelMap: { off: "none", max: "max" },
	});
});
