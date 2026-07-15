import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	mapCursorCatalogToProviderModels,
	normalizeCursorUsableModels,
	type CursorModelCatalog,
} from "../../packages/cursor/src/model-mapper.js";

describe("Cursor exact GetUsable model mapping", () => {
	test("keeps byte-for-byte routes and applies last-wins only to exact duplicates", () => {
		const models = normalizeCursorUsableModels([
			{ id: " cursor-grok-4.5-high ", displayName: "Old", maxMode: false },
			{ id: "", displayName: "Ignored", maxMode: true },
			{ id: "   ", displayName: "Ignored whitespace", maxMode: true },
			{ id: "cursor-grok-4.5-high", displayName: "Grok High", maxMode: true, supportsImages: true },
			{ id: " cursor-grok-4.5-high ", displayName: "Whitespace Route", maxMode: true },
			{ id: "cursor-grok-4.5-low", displayNameShort: "Grok Low", maxMode: false },
		]);

		assert.deepEqual(models, [
			{ id: " cursor-grok-4.5-high ", displayName: "Whitespace Route", maxMode: true },
			{ id: "cursor-grok-4.5-high", displayName: "Grok High", maxMode: true, supportsImages: true },
			{ id: "cursor-grok-4.5-low", displayNameShort: "Grok Low", maxMode: false },
		]);
	});

	test("registers each exact flat route without aliases, synthesis, or a reasoning selector", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "cursor-grok-4.5-high", displayName: "Grok High", maxMode: true },
				{ id: "claude-sonnet-5-thinking", displayModelId: "Claude Sonnet 5", maxMode: false, supportsImages: true },
			],
		};
		const mapped = mapCursorCatalogToProviderModels(catalog);

		assert.deepEqual(mapped.map((model) => model.id), ["cursor-grok-4.5-high", "claude-sonnet-5-thinking"]);
		assert.deepEqual(mapped.map((model) => model.name), ["Grok High", "Claude Sonnet 5"]);
		assert.deepEqual(mapped.map((model) => model.reasoning), [false, false]);
		assert.deepEqual(mapped.map((model) => model.input), [["text"], ["text", "image"]]);
		assert.deepEqual(mapped[0]?.compat.cursorRouting, {
			"cursor-grok-4.5-high": { modelId: "cursor-grok-4.5-high", maxMode: true },
		});
		assert.equal("cursorModelAliases" in (mapped[0]?.compat ?? {}), false);
		assert.equal("thinkingLevelMap" in (mapped[0] ?? {}), false);
	});
});
