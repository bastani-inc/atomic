import { fuzzyFilter } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { getModelSearchText, getModelSelectorSearchText, type ModelSearchItem } from "../src/modes/interactive/model-search.ts";

describe("model search text", () => {
	test("autocomplete keeps bare model IDs first for inherited slash-separated fuzzy queries", () => {
		const item: ModelSearchItem = { provider: "openrouter", id: "openai/gpt-5", name: "GPT 5" };

		expect(getModelSearchText(item).startsWith("openai/gpt-5 ")).toBe(true);
	});

	test("model selector ranks exact provider-prefixed matches before proxy-provider IDs", () => {
		const items: ModelSearchItem[] = [
			{ provider: "openrouter", id: "openai/gpt-5", name: "OpenRouter GPT 5" },
			{ provider: "openai", id: "gpt-5", name: "OpenAI GPT 5" },
		];

		const filtered = fuzzyFilter(items, "openai/gpt", getModelSelectorSearchText);

		expect(filtered[0]).toEqual(items[1]);
	});
});
