import { expect, expectTypeOf, it } from "vitest";
import { AMAZON_BEDROCK_MODELS } from "../src/providers/amazon-bedrock.models.ts";
import { GITHUB_COPILOT_MODELS } from "../src/providers/github-copilot.models.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";
import { OPENAI_CODEX_MODELS } from "../src/providers/openai-codex.models.ts";
import { XAI_MODELS } from "../src/providers/xai.models.ts";

it("derives model API, ID, and provider literals from grouped model data", () => {
	expectTypeOf(XAI_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.5"].id).toEqualTypeOf<"grok-4.5">();
	expectTypeOf(XAI_MODELS["grok-4.5"].provider).toEqualTypeOf<"xai">();
	expectTypeOf(XAI_MODELS["grok-4.6"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(XAI_MODELS["grok-4.6"].id).toEqualTypeOf<"grok-4.6">();
	expectTypeOf(XAI_MODELS["grok-4.3"].api).toEqualTypeOf<"openai-responses">();
});

it("preserves GPT-6-Astra provider, ID, and API literals in generated catalogs", () => {
	expectTypeOf(OPENAI_MODELS["gpt-6-astra"].api).toEqualTypeOf<"openai-responses">();
	expectTypeOf(OPENAI_MODELS["gpt-6-astra"].id).toEqualTypeOf<"gpt-6-astra">();
	expectTypeOf(OPENAI_MODELS["gpt-6-astra"].provider).toEqualTypeOf<"openai">();
	expectTypeOf(OPENAI_CODEX_MODELS["gpt-6-astra"].api).toEqualTypeOf<"openai-codex-responses">();
	expectTypeOf(OPENAI_CODEX_MODELS["gpt-6-astra"].provider).toEqualTypeOf<"openai-codex">();

	for (const id of ["openai.gpt-6-astra", "global.openai.gpt-6-astra", "us.openai.gpt-6-astra"] as const) {
		expectTypeOf(AMAZON_BEDROCK_MODELS[id].api).toEqualTypeOf<"bedrock-converse-stream">();
		expectTypeOf(AMAZON_BEDROCK_MODELS[id].id).toEqualTypeOf<typeof id>();
		expectTypeOf(AMAZON_BEDROCK_MODELS[id].provider).toEqualTypeOf<"amazon-bedrock">();
	}
});

it("routes GitHub Copilot Grok 4.5 through the Responses API", () => {
	expectTypeOf(GITHUB_COPILOT_MODELS["grok-4.5"].api).toEqualTypeOf<"openai-responses">();
	expect(GITHUB_COPILOT_MODELS["grok-4.5"].api).toBe("openai-responses");
});
