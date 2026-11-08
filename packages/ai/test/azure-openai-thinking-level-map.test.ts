import { describe, expect, it } from "vitest";
import {
	applyAzureOpenAIListedEfforts,
	applyAzureOpenAIThinkingOffMasks,
} from "../scripts/azure-openai-thinking-level-map.ts";
import type { Api, Model, ThinkingLevelMap } from "../src/types.ts";

type CatalogModel = Pick<Model<Api>, "id" | "provider" | "api" | "thinkingLevelMap">;

function openAI(id: string, thinkingLevelMap?: ThinkingLevelMap): CatalogModel {
	return { id, provider: "openai", api: "openai-responses", ...(thinkingLevelMap ? { thinkingLevelMap } : {}) };
}

function azure(id: string, thinkingLevelMap?: ThinkingLevelMap): CatalogModel {
	return {
		id,
		provider: "azure",
		api: "azure-openai-responses",
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
}

describe("applyAzureOpenAIListedEfforts", () => {
	it("copies only off and the efforts listed under their own level name (#4556)", () => {
		const deployment = azure("gpt-test", { minimal: "minimal", medium: "medium" });

		applyAzureOpenAIListedEfforts([
			openAI("gpt-test", {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			}),
			deployment,
		]);

		expect(deployment.thinkingLevelMap).toEqual({
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
		});
	});

	it("copies an off entry that denies off without copying the other masks (#4556)", () => {
		const deployment = azure("o-test", { minimal: "minimal" });

		applyAzureOpenAIListedEfforts([openAI("o-test", { off: null, minimal: null, low: "low" }), deployment]);

		expect(deployment.thinkingLevelMap).toEqual({ off: null, minimal: "minimal", low: "low" });
	});

	it("leaves deployments without a matching OpenAI Responses model untouched (#4556)", () => {
		const unmatched = azure("azure-only");
		const otherApi = { ...azure("gpt-test"), api: "openai-completions" } satisfies CatalogModel;
		const otherProvider = { ...azure("gpt-test"), provider: "azure-foundry" } satisfies CatalogModel;
		const fromChatCompletions = azure("chat-test");
		const fromOtherProvider = azure("grok-test");

		applyAzureOpenAIListedEfforts([
			openAI("gpt-test", { off: "none", low: "low" }),
			{ ...openAI("chat-test", { off: "none", low: "low" }), api: "openai-completions" },
			{ ...openAI("grok-test", { off: "none", low: "low" }), provider: "xai" },
			unmatched,
			otherApi,
			otherProvider,
			fromChatCompletions,
			fromOtherProvider,
		]);

		expect(unmatched).not.toHaveProperty("thinkingLevelMap");
		expect(otherApi).not.toHaveProperty("thinkingLevelMap");
		expect(otherProvider).not.toHaveProperty("thinkingLevelMap");
		expect(fromChatCompletions).not.toHaveProperty("thinkingLevelMap");
		expect(fromOtherProvider).not.toHaveProperty("thinkingLevelMap");
	});
});

describe("applyAzureOpenAIThinkingOffMasks", () => {
	it("copies the minimal, low and medium masks where the OpenAI map denies off (#4556)", () => {
		const deployment = azure("gpt-5-pro", { off: null, minimal: "minimal", high: "high" });

		applyAzureOpenAIThinkingOffMasks([
			openAI("gpt-5-pro", {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			}),
			deployment,
		]);

		expect(deployment.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: "high" });
	});

	it("copies only the masks the OpenAI map sets (#4556)", () => {
		const deployment = azure("o3", { off: null, low: "low", medium: "medium", high: "high" });

		applyAzureOpenAIThinkingOffMasks([
			openAI("o3", { off: null, minimal: null, low: "low", medium: "medium", high: "high" }),
			deployment,
		]);

		expect(deployment.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
		});
	});

	it("leaves the levels of deployments whose OpenAI model can disable thinking (#4556)", () => {
		const offEffort = azure("gpt-5.1", { off: "none", low: "low" });
		const offUnset = azure("gpt-test", { low: "low" });

		applyAzureOpenAIThinkingOffMasks([
			openAI("gpt-5.1", { off: "none", minimal: null, low: "low" }),
			openAI("gpt-test", { minimal: null, low: "low" }),
			offEffort,
			offUnset,
		]);

		expect(offEffort.thinkingLevelMap).toEqual({ off: "none", low: "low" });
		expect(offUnset.thinkingLevelMap).toEqual({ low: "low" });
	});

	it("leaves deployments without masks to copy or a matching OpenAI Responses model untouched (#4556)", () => {
		const noMasks = azure("gpt-5");
		const unmatched = azure("azure-only");
		const otherApi = { ...azure("gpt-5-pro"), api: "openai-completions" } satisfies CatalogModel;
		const otherProvider = { ...azure("gpt-5-pro"), provider: "azure-foundry" } satisfies CatalogModel;
		const fromChatCompletions = azure("chat-test");
		const fromOtherProvider = azure("grok-test");

		applyAzureOpenAIThinkingOffMasks([
			openAI("gpt-5", { off: null, minimal: "minimal", low: "low" }),
			openAI("gpt-5-pro", { off: null, minimal: null }),
			{ ...openAI("chat-test", { off: null, minimal: null }), api: "openai-completions" },
			{ ...openAI("grok-test", { off: null, minimal: null }), provider: "xai" },
			noMasks,
			unmatched,
			otherApi,
			otherProvider,
			fromChatCompletions,
			fromOtherProvider,
		]);

		expect(noMasks).not.toHaveProperty("thinkingLevelMap");
		expect(unmatched).not.toHaveProperty("thinkingLevelMap");
		expect(otherApi).not.toHaveProperty("thinkingLevelMap");
		expect(otherProvider).not.toHaveProperty("thinkingLevelMap");
		expect(fromChatCompletions).not.toHaveProperty("thinkingLevelMap");
		expect(fromOtherProvider).not.toHaveProperty("thinkingLevelMap");
	});
});
