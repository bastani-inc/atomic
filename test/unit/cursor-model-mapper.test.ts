import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getModel } from "@earendil-works/pi-ai";
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
		const grok = models.find((model) => model.id === "grok-4.3");
		const kimi = models.find((model) => model.id === "kimi-k2.5");
		assert.ok(composer);
		assert.ok(grok);
		assert.ok(kimi);
		assert.match(composer.name, /estimated/u);
		assert.equal(composer.reasoning, true);
		assert.deepEqual(composer.input, ["text", "image"]);
		assert.deepEqual(grok.input, ["text", "image"]);
		assert.deepEqual(kimi.input, ["text", "image"]);
		assert.deepEqual(composer.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(models.length, 36);
		for (const id of ["gpt-5.4", "gpt-5.4-fast", "gpt-5.4-mini", "claude-4.6-opus", "gpt-5.1-codex-max", "grok-4.3", "kimi-k2.5"]) {
			assert.ok(ids.includes(id), `expected fallback catalog to include ${id}`);
		}
		for (const leaked of ["gpt-5.4-high", "gpt-5.4-mini-none", "claude-4.6-opus-high", "gpt-5.1-codex-max-high"]) {
			assert.equal(ids.includes(leaked), false, `fallback catalog leaked effort variant ${leaked}`);
		}
	});

	test("derives missing fallback limits from the pi-ai model catalog", () => {
		const models = mapCursorCatalogToProviderModels(createEstimatedCursorCatalog(123));
		const contextWindowFor = (id: string) => models.find((model) => model.id === id)?.contextWindow;
		const maxTokensFor = (id: string) => models.find((model) => model.id === id)?.maxTokens;

		// Known model families resolve to the installed pi-ai metadata by id.
		assert.equal(contextWindowFor("claude-4-sonnet"), getModel("opencode", "claude-sonnet-4").contextWindow);
		assert.equal(contextWindowFor("claude-4.6-opus"), getModel("opencode", "claude-opus-4-6").contextWindow);
		assert.equal(contextWindowFor("gemini-3.1-pro"), getModel("opencode", "gemini-3.1-pro").contextWindow);
		assert.equal(contextWindowFor("gpt-5.1"), getModel("opencode", "gpt-5.1").contextWindow);
		assert.equal(contextWindowFor("gpt-5.4-mini"), getModel("opencode", "gpt-5.4-mini").contextWindow);
		assert.equal(contextWindowFor("grok-4.3"), getModel("xai", "grok-4.3").contextWindow);
		assert.equal(contextWindowFor("kimi-k2.5"), getModel("opencode", "kimi-k2.5").contextWindow);
		assert.equal(maxTokensFor("gpt-5.4"), getModel("opencode", "gpt-5.4").maxTokens);
		assert.equal(maxTokensFor("grok-4.3"), getModel("xai", "grok-4.3").maxTokens);

		// Cursor's explicit "1M" labels are honored as a long-context floor.
		assert.ok((contextWindowFor("claude-4-sonnet-1m") ?? 0) >= 1_000_000);
		assert.ok((contextWindowFor("claude-4.5-sonnet") ?? 0) >= 1_000_000);
		assert.ok((contextWindowFor("gpt-5.4") ?? 0) >= 1_000_000);

		// Cursor-only models without a pi-ai match keep the conservative estimate,
		// and the generic "Auto" model must not false-match an unrelated catalog entry.
		assert.equal(contextWindowFor("composer-2"), 200_000);
		assert.equal(maxTokensFor("composer-2"), 64_000);
		assert.equal(contextWindowFor("default"), 200_000);
	});

	test("resolves live Cursor limits from pi-ai references and ignores bogus discovered limits", () => {
		const models = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "gpt-5.5-low", displayName: "GPT-5.5 Low" },
				{ id: "gpt-5.5-medium", displayName: "GPT-5.5" },
				{ id: "gpt-5.5-high", displayName: "GPT-5.5 High" },
				{ id: "gpt-5.5-xhigh", displayName: "GPT-5.5 Extra High" },
				{ id: "claude-4-sonnet", displayName: "Sonnet 4" },
				{ id: "gpt-5.4-explicit", displayName: "GPT-5.4 Explicit", contextWindow: 512_000, maxTokens: 12_345 },
				{ id: "gemini-zero-limit", displayName: "Gemini Zero Limit", contextWindow: 0, maxTokens: 0 },
				{ id: "kimi-negative-limit", displayName: "Kimi Negative", contextWindow: -1, maxTokens: -1 },
				{ id: "brand-new-unknown", displayName: "Brand New" },
			],
		});
		const byId = (id: string) => models.find((model) => model.id === id);

		// Live discovery (which omits token limits) still registers every group, including gpt-5.5.
		assert.ok(byId("gpt-5.5"), "expected live gpt-5.5 to register");
		assert.equal(byId("gpt-5.5")?.contextWindow, getModel("opencode", "gpt-5.5").contextWindow);
		assert.equal(byId("gpt-5.5")?.maxTokens, getModel("opencode", "gpt-5.5").maxTokens);
		assert.equal(byId("claude-4-sonnet")?.contextWindow, getModel("opencode", "claude-sonnet-4").contextWindow);
		// Explicit positive live limits win over the reference catalog.
		assert.equal(byId("gpt-5.4-explicit")?.contextWindow, 512_000);
		assert.equal(byId("gpt-5.4-explicit")?.maxTokens, 12_345);
		// Non-positive discovered limits are ignored and fall back to the estimate.
		assert.equal(byId("gemini-zero-limit")?.contextWindow, 200_000);
		assert.equal(byId("gemini-zero-limit")?.maxTokens, 64_000);
		assert.equal(byId("kimi-negative-limit")?.contextWindow, 200_000);
		// Unknown models keep the conservative estimate.
		assert.equal(byId("brand-new-unknown")?.contextWindow, 200_000);
		assert.equal(byId("brand-new-unknown")?.maxTokens, 64_000);
	});

	test("marks live Cursor reasoning-capable ids by id even without discovery metadata", () => {
		const [composer] = mapCursorCatalogToProviderModels({ source: "live", fetchedAt: 1, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] });

		assert.equal(composer?.id, "composer-2.5");
		assert.equal(composer?.reasoning, true);
		assert.deepEqual(composer?.input, ["text", "image"]);
		assert.equal(composer?.thinkingLevelMap, undefined);
		assert.equal(resolveCursorModelVariant("composer-2.5", composer?.thinkingLevelMap, "high"), "composer-2.5");
	});

	test("marks known multimodal Cursor families and Grok 4.3 as image-capable", () => {
		const models = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "claude-4.5-sonnet", displayName: "Claude Sonnet" },
				{ id: "gemini-3.1-pro", displayName: "Gemini Pro" },
				{ id: "gpt-5.2", displayName: "GPT" },
				{ id: "composer-2", displayName: "Composer" },
				{ id: "kimi-k2.5", displayName: "Kimi" },
				{ id: "grok-4.3", displayName: "Grok 4.3" },
				{ id: "grokish-1", displayName: "Grokish" },
				{ id: "default", displayName: "Default" },
			],
		});

		const inputFor = (id: string) => models.find((entry) => entry.id === id)?.input;
		assert.deepEqual(inputFor("claude-4.5-sonnet"), ["text", "image"]);
		assert.deepEqual(inputFor("gemini-3.1-pro"), ["text", "image"]);
		assert.deepEqual(inputFor("gpt-5.2"), ["text", "image"]);
		assert.deepEqual(inputFor("composer-2"), ["text", "image"]);
		assert.deepEqual(inputFor("kimi-k2.5"), ["text", "image"]);
		assert.deepEqual(inputFor("grok-4.3"), ["text", "image"]);
		assert.deepEqual(inputFor("grokish-1"), ["text"]);
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
