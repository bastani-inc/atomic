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
		assert.deepEqual(composer?.input, ["text", "image"]);
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
		const composer = models.find((model) => model.id === "composer-2");
		const kimi = models.find((model) => model.id === "kimi-k2.5");
		assert.ok(composer);
		assert.ok(kimi);
		assert.match(composer.name, /estimated/u);
		assert.equal(composer.reasoning, true);
		assert.deepEqual(composer.input, ["text", "image"]);
		assert.deepEqual(kimi.input, ["text", "image"]);
		assert.deepEqual(composer.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(models.length, 37);
		for (const id of ["gpt-5.4", "gpt-5.4-fast", "gpt-5.4-mini", "claude-4.6-opus", "gpt-5.1-codex-max", "kimi-k2.5"]) {
			assert.ok(ids.includes(id), `expected fallback catalog to include ${id}`);
		}
		for (const leaked of ["gpt-5.4-high", "gpt-5.4-mini-none", "claude-4.6-opus-high", "gpt-5.1-codex-max-high"]) {
			assert.equal(ids.includes(leaked), false, `fallback catalog leaked effort variant ${leaked}`);
		}
	});

	test("marks live Cursor reasoning-capable ids by id even without discovery metadata", () => {
		const [composer] = mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 1, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] });

		assert.equal(composer?.id, "composer-2.5");
		assert.equal(composer?.reasoning, true);
		assert.deepEqual(composer?.input, ["text", "image"]);
		assert.equal(composer?.thinkingLevelMap, undefined);
		assert.equal(resolveCursorModelVariant("composer-2.5", composer?.thinkingLevelMap, "high"), "composer-2.5");
	});

	test("marks only known multimodal Cursor families as image-capable", () => {
		const models = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "claude-4.5-sonnet", displayName: "Claude Sonnet" },
				{ id: "gemini-3.1-pro", displayName: "Gemini Pro" },
				{ id: "gpt-5.2", displayName: "GPT" },
				{ id: "composer-2", displayName: "Composer" },
				{ id: "kimi-k2.5", displayName: "Kimi" },
				{ id: "grok-4-20", displayName: "Grok" },
				{ id: "default", displayName: "Default" },
			],
		});

		const inputFor = (id: string) => models.find((entry) => entry.id === id)?.input;
		assert.deepEqual(inputFor("claude-4.5-sonnet"), ["text", "image"]);
		assert.deepEqual(inputFor("gemini-3.1-pro"), ["text", "image"]);
		assert.deepEqual(inputFor("gpt-5.2"), ["text", "image"]);
		assert.deepEqual(inputFor("composer-2"), ["text", "image"]);
		assert.deepEqual(inputFor("kimi-k2.5"), ["text", "image"]);
		assert.deepEqual(inputFor("grok-4-20"), ["text"]);
		assert.deepEqual(inputFor("default"), ["text"]);
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

	test("collapses effort variants into synthesized primary ids", () => {
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
		assert.deepEqual(models.map((model) => model.id), ["alpha", "beta", "beta-default"]);
		assert.equal(resolveCursorModelVariant("alpha", models.find((model) => model.id === "alpha")?.thinkingLevelMap, "high"), "alpha-high");
	});

	test("treats max suffixes as effort levels like the reference provider", () => {
		const catalog: CursorModelCatalog = {
			source: "live",
			fetchedAt: 1,
			models: [{ id: "gpt-5.1-codex-max", displayName: "GPT-5.1 Codex Max" }],
		};

		const models = mapCursorCatalogToProviderModels(catalog);
		assert.deepEqual(models.map((entry) => entry.id), ["gpt-5.1-codex"]);
		assert.equal(resolveCursorModelVariant("gpt-5.1-codex", models[0]?.thinkingLevelMap, "high"), "gpt-5.1-codex-max");
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
		assert.equal(effortOnly?.id, "claude-4.5-opus");
		assert.equal(resolveCursorModelVariant(effortOnly!.id, effortOnly!.thinkingLevelMap, "minimal"), "claude-4.5-opus-high");
	});
});
