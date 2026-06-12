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
		assert.equal(models.length, 2);
		const composer = models.find((entry) => entry.id === "composer-2");
		assert.equal(composer?.id, "composer-2");
		assert.equal(composer?.name, "Composer 2");
		assert.equal(composer?.reasoning, true);
		assert.deepEqual(composer?.input, ["text"]);
		assert.equal(composer?.contextWindow, 200);
		assert.equal(composer?.maxTokens, 20);
		assert.deepEqual(composer?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(composer?.thinkingLevelMap, {
			minimal: "composer-2-low",
			low: "composer-2-low",
			medium: "composer-2-medium",
			high: "composer-2-high",
			xhigh: "composer-2-max",
		});
		assert.equal(models.find((entry) => entry.id === "composer-2-thinking-fast")?.reasoning, true);
	});

	test("marks static fallback catalog as estimated and keeps cursor/composer-2 available", () => {
		const models = mapCursorCatalogToProviderModels(createEstimatedCursorCatalog(123));
		const composer = models.find((model) => model.id === "composer-2");
		assert.ok(composer);
		assert.match(composer.name, /estimated/u);
		assert.equal(composer.reasoning, true);
		assert.deepEqual(composer.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
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
		assert.equal(
			resolveCursorModelVariant("composer-2", { xhigh: "composer-2-max", high: "composer-2-high" }, "xhigh"),
			"composer-2-max",
		);
	});

	test("prefers advertised default or none live variants as primary ids", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "alpha-high", displayName: "Alpha High" },
				{ id: "alpha-none", displayName: "Alpha None" },
				{ id: "beta-high", displayName: "Beta High" },
				{ id: "beta-none", displayName: "Beta None" },
				{ id: "beta-default", displayName: "Beta Default" },
			],
		};

		const models = mapCursorCatalogToProviderModels(catalog);
		assert.equal(models.find((model) => model.id.startsWith("alpha"))?.id, "alpha-none");
		assert.equal(models.find((model) => model.id.startsWith("beta"))?.id, "beta-default");
	});

	test("keeps ambiguous max suffixes as standalone model names without sibling evidence", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [{ id: "gpt-5.1-codex-max", displayName: "GPT-5.1 Codex Max" }],
		};

		const models = mapCursorCatalogToProviderModels(catalog);
		assert.deepEqual(models.map((entry) => entry.id), ["gpt-5.1-codex-max"]);
		assert.equal(models[0]?.thinkingLevelMap?.high, undefined);
	});

	test("keeps fast and thinking modes in separate live model groups", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "gpt-5.4", displayName: "GPT-5.4" },
				{ id: "gpt-5.4-high", displayName: "GPT-5.4 High" },
				{ id: "gpt-5.4-fast", displayName: "GPT-5.4 Fast" },
				{ id: "gpt-5.4-high-fast", displayName: "GPT-5.4 High Fast" },
				{ id: "gpt-5.4-thinking", displayName: "GPT-5.4 Thinking", supportsThinking: true },
			],
		};

		const models = mapCursorCatalogToProviderModels(catalog);
		assert.deepEqual(models.map((entry) => entry.id), ["gpt-5.4", "gpt-5.4-fast", "gpt-5.4-thinking"]);
		const normal = models.find((entry) => entry.id === "gpt-5.4");
		const fast = models.find((entry) => entry.id === "gpt-5.4-fast");
		assert.equal(resolveCursorModelVariant(normal!.id, normal!.thinkingLevelMap, "high"), "gpt-5.4-high");
		assert.equal(resolveCursorModelVariant(fast!.id, fast!.thinkingLevelMap, "high"), "gpt-5.4-high-fast");
	});

	test("uses advertised live fast/thinking ids instead of synthesizing absent base ids", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "claude-4-sonnet-thinking-fast", displayName: "Claude Sonnet Thinking Fast", supportsThinking: true },
				{ id: "claude-4-sonnet-high-thinking-fast", displayName: "Claude Sonnet High Thinking Fast", supportsThinking: true },
			],
		};

		const [mapped] = mapCursorCatalogToProviderModels(catalog);
		assert.equal(mapped?.id, "claude-4-sonnet-thinking-fast");
		assert.equal(resolveCursorModelVariant(mapped!.id, mapped!.thinkingLevelMap, "high"), "claude-4-sonnet-high-thinking-fast");
		assert.equal(resolveCursorModelVariant(mapped!.id, mapped!.thinkingLevelMap, "medium"), "claude-4-sonnet-thinking-fast");
	});
});
