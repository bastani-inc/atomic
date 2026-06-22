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

	test("marks static fallback catalog as estimated and mirrors the reference visible Cursor model set", () => {
		const models = mapCursorCatalogToProviderModels(createEstimatedCursorCatalog(123));
		const ids = models.map((model) => model.id);
		const composer = models.find((model) => model.id === "composer-2.5");
		assert.ok(composer);
		assert.match(composer.name, /estimated/u);
		assert.equal(composer.reasoning, true);
		assert.deepEqual(composer.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(models.length, 48);
		for (const id of ["composer-2.5-fast", "gemini-3.5-flash", "gpt-5.5-medium", "gpt-5.5-medium-fast", "claude-opus-4-8-medium", "grok-4.3", "grok-build-0.1", "kimi-k2.5"]) {
			assert.ok(ids.includes(id), `expected fallback catalog to include ${id}`);
		}
		for (const leaked of ["composer-1.5", "composer-2", "composer-2-fast", "gpt-5.3-codex-spark-preview", "grok-4-20", "grok-4-20-thinking", "claude-fable-5-medium"]) {
			assert.equal(ids.includes(leaked), false, `fallback catalog leaked stale or gated model ${leaked}`);
		}
	});

	test("marks live Cursor reasoning-capable ids by id even without discovery metadata", () => {
		const [composer] = mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 1, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] });

		assert.equal(composer?.id, "composer-2.5");
		assert.equal(composer?.reasoning, true);
		assert.equal(composer?.thinkingLevelMap, undefined);
		assert.equal(resolveCursorModelVariant("composer-2.5", composer?.thinkingLevelMap, "high"), "composer-2.5");
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

	test("uses callable primary ids for effort-only variant groups", () => {
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
		assert.deepEqual(models.map((model) => model.id), ["alpha-none", "beta-default", "beta-none"]);
		assert.equal(resolveCursorModelVariant("alpha-none", models.find((model) => model.id === "alpha-none")?.thinkingLevelMap, "high"), "alpha-high");
	});

	test("treats max suffixes as effort levels like the reference provider", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [{ id: "gpt-5.1-codex-max", displayName: "GPT-5.1 Codex Max" }],
		};

		const models = mapCursorCatalogToProviderModels(catalog);
		assert.deepEqual(models.map((entry) => entry.id), ["gpt-5.1-codex-max"]);
		assert.equal(resolveCursorModelVariant("gpt-5.1-codex-max", models[0]?.thinkingLevelMap, "high"), "gpt-5.1-codex-max");
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

	test("collapses mandatory effort-only live fast/thinking ids", () => {
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

		const [effortOnly] = mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 1, models: [{ id: "claude-4.5-opus-high", displayName: "Claude Opus 4.5" }] });
		assert.equal(effortOnly?.id, "claude-4.5-opus-high");
		assert.equal(resolveCursorModelVariant(effortOnly!.id, effortOnly!.thinkingLevelMap, "minimal"), "claude-4.5-opus-high");
	});
});
