import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	createEstimatedCursorCatalog,
	insertEffortBeforeCursorSuffix,
	mapCursorCatalogToProviderModels,
	parseCursorVariant,
	resolveCursorModelVariant,
	type CursorModelCatalog,
} from "../../packages/cursor/src/model-mapper.js";

describe("Cursor model mapper", () => {
	test("groups Cursor variants and maps reasoning efforts to Atomic thinking levels", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "composer-2", displayName: "Composer 2", contextWindow: 100, maxTokens: 10 },
				{ id: "composer-2-low", displayName: "Composer 2 Low", contextWindow: 200, maxTokens: 20 },
				{ id: "composer-2-medium", displayName: "Composer 2 Medium" },
				{ id: "composer-2-high", displayName: "Composer 2 High" },
				{ id: "composer-2-max", displayName: "Composer 2 Max" },
				{ id: "composer-2-thinking-fast", displayName: "Composer 2 Thinking Fast", supportsThinking: true },
			],
		};

		const models = mapCursorCatalogToProviderModels(catalog);
		assert.equal(models.length, 1);
		const composer = models[0];
		assert.equal(composer?.id, "composer-2");
		assert.equal(composer?.name, "Composer 2");
		assert.equal(composer?.reasoning, true);
		assert.deepEqual(composer?.input, ["text"]);
		assert.equal(composer?.contextWindow, 200);
		assert.equal(composer?.maxTokens, 20);
		assert.deepEqual(composer?.thinkingLevelMap, {
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "max",
		});
	});

	test("marks static fallback catalog as estimated and keeps cursor/composer-2 available", () => {
		const models = mapCursorCatalogToProviderModels(createEstimatedCursorCatalog(123));
		const composer = models.find((model) => model.id === "composer-2");
		assert.ok(composer);
		assert.match(composer.name, /estimated/u);
		assert.equal(composer.reasoning, true);
	});

	test("parses and reconstructs effort variants before fast/thinking suffixes", () => {
		assert.deepEqual(parseCursorVariant({ id: "claude-4-sonnet-high-thinking-fast" }), {
			id: "claude-4-sonnet-high-thinking-fast",
			baseId: "claude-4-sonnet",
			displayName: "Claude 4 Sonnet",
			effort: "high",
			fast: true,
			thinking: true,
			contextWindow: undefined,
			maxTokens: undefined,
			supportsReasoning: undefined,
			supportsThinking: undefined,
		});
		assert.equal(insertEffortBeforeCursorSuffix("claude-4-sonnet-thinking-fast", "max"), "claude-4-sonnet-max-thinking-fast");
		assert.equal(
			resolveCursorModelVariant("composer-2", { xhigh: "max", high: "high" }, "xhigh"),
			"composer-2-max",
		);
	});
});
