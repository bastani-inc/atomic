import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	mapCursorCatalogToProviderModels,
	normalizeCursorUsableModels,
	type CursorModelCatalog,
} from "../../packages/cursor/src/model-mapper.js";

describe("Cursor exact GetUsable model mapping", () => {
	test("preserves every GetUsable row, value, occurrence, and source order", () => {
		const first = { id: " cursor-grok-4.5-high ", displayName: "Old", maxMode: false };
		const blank = { id: "", displayName: "", maxMode: true };
		const whitespace = { id: "   ", displayNameShort: "  ", maxMode: true };
		const duplicate = { id: "dup", displayName: "First", maxMode: false };
		const duplicateLater = { id: "dup", displayName: "Second", maxMode: true, supportsImages: true as const };
		const input = [first, blank, whitespace, duplicate, duplicateLater] as const;

		const models = normalizeCursorUsableModels(input);

		assert.ok(Array.isArray(models));
		assert.notEqual(models, input);
		assert.deepEqual(models, input);
		assert.equal(models[0], first);
		assert.equal(models[1], blank);
		assert.equal(models[2], whitespace);
		assert.equal(models[3], duplicate);
		assert.equal(models[4], duplicateLater);
		models.reverse();
		assert.equal(models[0], duplicateLater);
		assert.equal(input[0], first);
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
			"cursor-grok-4.5-high": {
				modelId: "cursor-grok-4.5-high", maxMode: true, supportsImages: false, catalogOccurrence: 0,
			},
		});
		assert.equal("cursorModelAliases" in (mapped[0]?.compat ?? {}), false);
		assert.equal("thinkingLevelMap" in (mapped[0] ?? {}), false);
	});

	test("maps blank and duplicate rows in order with occurrence-specific routing metadata", () => {
		const mapped = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "", displayName: "", maxMode: false },
				{ id: "duplicate", displayName: "First", maxMode: false },
				{ id: "duplicate", displayName: "Second", maxMode: true, supportsImages: true },
				{ id: "   ", displayNameShort: "  ", maxMode: true },
			],
		});

		assert.deepEqual(mapped.map((model) => [model.id, model.name]), [
			["", ""], ["duplicate", "First"], ["duplicate", "Second"], ["   ", "  "],
		]);
		assert.deepEqual(mapped.map((model) => model.compat.cursorRouting[model.id]), [
			{ modelId: "", maxMode: false, supportsImages: false, catalogOccurrence: 0 },
			{ modelId: "duplicate", maxMode: false, supportsImages: false, catalogOccurrence: 1 },
			{ modelId: "duplicate", maxMode: true, supportsImages: true, catalogOccurrence: 2 },
			{ modelId: "   ", maxMode: true, supportsImages: false, catalogOccurrence: 3 },
		]);
	});
});
