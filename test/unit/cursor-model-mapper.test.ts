import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getModels, getProviders } from "@earendil-works/pi-ai";
import {
	createEstimatedCursorCatalog,
	insertEffortBeforeCursorSuffix,
	mapCursorCatalogToProviderModels,
	parseCursorVariant,
	resolveCursorModelVariant,
	type CursorModelCatalog,
} from "../../packages/cursor/src/model-mapper.js";
import {
	resolveCursorModelReferenceLimits,
	setCursorModelReferenceCatalogForTesting,
	type CursorModelReferenceCatalogEntry,
} from "../../packages/cursor/src/model-reference.js";

const REFERENCE_CATALOG_FIXTURE: readonly CursorModelReferenceCatalogEntry[] = [
	{ provider: "opencode", id: "claude-sonnet-4", name: "Claude Sonnet 4", contextWindow: 200_000, maxTokens: 64_000 },
	{ provider: "opencode", id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 300_000, maxTokens: 70_000 },
	{ provider: "opencode", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 450_000, maxTokens: 80_000 },
	{ provider: "opencode", id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 1_048_576, maxTokens: 65_536 },
	{ provider: "opencode", id: "gpt-5.1", name: "GPT-5.1", contextWindow: 256_000, maxTokens: 50_000 },
	{ provider: "opencode", id: "gpt-5.4", name: "GPT-5.4", contextWindow: 400_000, maxTokens: 90_000 },
	{ provider: "opencode", id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 180_000, maxTokens: 45_000 },
	{ provider: "opencode", id: "gpt-5.5", name: "GPT-5.5", contextWindow: 512_000, maxTokens: 100_000 },
	{ provider: "xai", id: "grok-4.3", name: "Grok 4.3", contextWindow: 131_072, maxTokens: 32_768 },
	{ provider: "opencode", id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 262_144, maxTokens: 131_072 },
];

beforeEach(() => {
	setCursorModelReferenceCatalogForTesting(REFERENCE_CATALOG_FIXTURE);
});

afterEach(() => {
	setCursorModelReferenceCatalogForTesting(undefined);
});

function firstLiveReferenceModelWithLimits(): { readonly id: string; readonly name: string } | undefined {
	for (const provider of getProviders()) {
		for (const model of getModels(provider)) {
			if (model.id.trim().length > 0 && Number.isFinite(model.contextWindow) && model.contextWindow > 0 && Number.isFinite(model.maxTokens) && model.maxTokens > 0) {
				return { id: model.id, name: model.name };
			}
		}
	}
	return undefined;
}

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

		// Known model families resolve to deterministic fixture metadata by id.
		assert.equal(contextWindowFor("claude-4-sonnet"), 200_000);
		assert.equal(contextWindowFor("gemini-3.1-pro"), 1_048_576);
		assert.equal(contextWindowFor("gpt-5.1"), 256_000);
		assert.equal(contextWindowFor("gpt-5.4-mini"), 180_000);
		assert.equal(contextWindowFor("grok-4.3"), 131_072);
		assert.equal(contextWindowFor("kimi-k2.5"), 262_144);
		assert.equal(maxTokensFor("gpt-5.4"), 90_000);
		assert.equal(maxTokensFor("grok-4.3"), 32_768);

		// Cursor's explicit "1M" labels are honored as a long-context floor.
		assert.equal(contextWindowFor("claude-4-sonnet-1m"), 1_000_000);
		assert.equal(contextWindowFor("claude-4.5-sonnet"), 1_000_000);
		assert.equal(contextWindowFor("gpt-5.4"), 1_000_000);
		assert.equal(contextWindowFor("claude-4.6-opus"), 1_000_000);
		assert.equal(contextWindowFor("gpt-5.4-fast"), 1_000_000);

		// Cursor-only models without a pi-ai match keep the conservative estimate,
		// and the generic "Auto" model must not false-match an unrelated catalog entry.
		assert.equal(contextWindowFor("composer-2"), 200_000);
		assert.equal(maxTokensFor("composer-2"), 64_000);
		assert.equal(contextWindowFor("default"), 200_000);
	});

	test("smoke-checks the installed pi-ai reference catalog without pinning limits", () => {
		setCursorModelReferenceCatalogForTesting(undefined);
		const liveReference = firstLiveReferenceModelWithLimits();
		assert.ok(liveReference, "expected installed pi-ai catalog to expose at least one limited model");

		const resolved = resolveCursorModelReferenceLimits([{ id: liveReference.id, displayName: liveReference.name }]);
		assert.ok((resolved.contextWindow ?? 0) > 0);
		assert.ok((resolved.maxTokens ?? 0) > 0);
	});

	test("keeps Cursor models registered when the reference catalog cannot be indexed", () => {
		const badCatalogEntry: CursorModelReferenceCatalogEntry = {
			provider: "opencode",
			id: "gpt-5.5",
			name: "GPT-5.5",
			get contextWindow(): number {
				throw new Error("bad reference catalog");
			},
			maxTokens: 100_000,
		};
		setCursorModelReferenceCatalogForTesting([badCatalogEntry]);

		const [model] = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [{ id: "gpt-5.5", displayName: "GPT-5.5" }],
		});

		assert.equal(model?.id, "gpt-5.5");
		assert.equal(model?.contextWindow, 200_000);
		assert.equal(model?.maxTokens, 64_000);
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

		assert.equal(byId("gpt-5.5")?.contextWindow, 512_000);
		assert.equal(byId("gpt-5.5")?.maxTokens, 100_000);
		assert.equal(byId("gpt-5.5")?.thinkingLevelMap?.xhigh, "gpt-5.5-xhigh");
		assert.equal(byId("claude-4-sonnet")?.contextWindow, 200_000);
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

	test("normalizes hyphenated Claude version aliases to pi-ai references", () => {
		const [model] = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [{ id: "claude-4-5-sonnet", displayName: "Claude Sonnet 4.5" }],
		});

		assert.equal(model?.contextWindow, 450_000);
		assert.equal(model?.maxTokens, 80_000);
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
				{ id: "gpt-5.4", displayName: "GPT-5.4 1M" },
				{ id: "gpt-5.4-high", displayName: "GPT-5.4 1M High" },
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
		assert.equal(normal?.contextWindow, 1_000_000);
		assert.equal(fast?.contextWindow, 1_000_000);
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

	test("sends a concrete variant id for effort-only models when no thinking level is selected", () => {
		// Cursor lists only effort-variant ids for these models (no bare base id),
		// so a no-thinking request must map to a real variant or Cursor replies
		// `not_found`.
		const [effortOnly] = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "gpt-5.5-low", displayName: "GPT-5.5 Low" },
				{ id: "gpt-5.5-medium", displayName: "GPT-5.5" },
				{ id: "gpt-5.5-high", displayName: "GPT-5.5 High" },
			],
		});
		assert.equal(effortOnly?.id, "gpt-5.5");
		const off = effortOnly!.thinkingLevelMap?.off;
		// No-thinking intentionally chooses the least available effort so `off`
		// means minimum reasoning when Cursor only offers effort variants.
		assert.equal(off, "gpt-5.5-low");
		const defaultSend = resolveCursorModelVariant(effortOnly!.id, effortOnly!.thinkingLevelMap, undefined);
		assert.equal(defaultSend, "gpt-5.5-low");
		assert.equal(resolveCursorModelVariant(effortOnly!.id, effortOnly!.thinkingLevelMap, "high"), "gpt-5.5-high");
		assert.equal(effortOnly!.thinkingLevelMap?.xhigh, null);
		assert.equal(resolveCursorModelVariant(effortOnly!.id, effortOnly!.thinkingLevelMap, "xhigh"), "gpt-5.5-high");

		// Models that expose a real base id keep sending the base id by default.
		const [withBase] = mapCursorCatalogToProviderModels({
			source: "live",
			fetchedAt: 1,
			models: [
				{ id: "gpt-5.2", displayName: "GPT-5.2" },
				{ id: "gpt-5.2-high", displayName: "GPT-5.2 High" },
			],
		});
		assert.equal(withBase?.id, "gpt-5.2");
		assert.equal(withBase!.thinkingLevelMap?.off, undefined);
		assert.equal(resolveCursorModelVariant(withBase!.id, withBase!.thinkingLevelMap, undefined), "gpt-5.2");
	});
});
