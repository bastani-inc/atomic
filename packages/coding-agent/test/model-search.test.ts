import assert from "node:assert/strict";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
	getDistinctModelName,
	getModelSearchText,
	getModelSelectorSearchText,
	type ModelSearchItem,
} from "../src/modes/interactive/model-search.ts";

describe("getDistinctModelName (pi #5916)", () => {
	test("hides names that restate the ID", () => {
		assert.equal(getDistinctModelName({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }), undefined);
		assert.equal(getDistinctModelName({ id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b" }), undefined);
		assert.equal(
			getDistinctModelName({ id: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0", name: "Claude Sonnet 4.5 (EU)" }),
			undefined,
		);
		assert.equal(getDistinctModelName({ id: "gpt-5", name: "" }), undefined);
		assert.equal(getDistinctModelName({ id: "gpt-5" }), undefined);
	});

	test("shows names with words the ID lacks", () => {
		const name = "MiniMax M3 [rasmus@openrouter, parasail]";
		assert.equal(getDistinctModelName({ id: "minimax/minimax-m3", name }), name);
		assert.equal(
			getDistinctModelName({ id: "gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite" }),
			"Nano Banana 2 Lite",
		);
	});

	test("requires single-character words to match a whole ID token", () => {
		assert.equal(getDistinctModelName({ id: "mistral-small-2603", name: "Mistral Small 4" }), "Mistral Small 4");
	});
});

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

describe("model selector search ranking (pi-tui 1.5.0 fuzzyMatch)", () => {
	test("ranks models containing the query above scattered matches (upstream #11220)", () => {
		const models: ModelSearchItem[] = [
			{ provider: "openrouter", id: "openai/gpt-oss-120b", name: "OpenAI: gpt-oss-120b" },
			{ provider: "openrouter", id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5" },
			{ provider: "openrouter", id: "anthropic/claude-opus-4.1", name: "Anthropic: Claude Opus 4.1" },
			{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			{ provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
		];

		const result = fuzzyFilter(models, "opus", getModelSelectorSearchText).map((model) => model.id);

		assert.deepEqual(result.slice(0, 2).sort(), ["anthropic/claude-opus-4.1", "claude-opus-4-1"]);
	});

	test("ranks the typed model above models sharing a long provider prefix (upstream #10065)", () => {
		const models: ModelSearchItem[] = [
			{ provider: "fireworks", id: "accounts/fireworks/models/deepseek-v4-flash-0731" },
			{ provider: "fireworks", id: "accounts/fireworks/models/kimi-k3" },
			{ provider: "fireworks", id: "accounts/fireworks/routers/firerouter", name: "FireRouter" },
		];

		const result = fuzzyFilter(models, "firerouter", getModelSelectorSearchText);

		assert.equal(result[0]?.id, "accounts/fireworks/routers/firerouter");
	});
});
