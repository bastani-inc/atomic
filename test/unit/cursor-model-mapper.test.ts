import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { parseCursorCatalogCacheRecord, toCursorCatalogCacheRecord } from "../../packages/cursor/src/catalog-cache.js";
import {
	createEstimatedCursorCatalog,
	insertEffortBeforeCursorSuffix,
	mapCursorCatalogToProviderModels,
	parseCursorVariant,
	resolveCursorModelVariant,
	type CursorModelCatalog,
	type CursorUsableModel,
} from "../../packages/cursor/src/model-mapper.js";

const parameter = (id: string, value: string) => ({ id, value });
const variant = (parameters: readonly { id: string; value: string }[], isMaxMode = false) => ({ parameters, isMaxMode });

function availableModel(overrides: Partial<CursorUsableModel> & Pick<CursorUsableModel, "id">): CursorUsableModel {
	return {
		displayName: overrides.id,
		contextWindow: 200_000,
		maxModeContextWindow: 1_000_000,
		supportsImages: false,
		supportsMaxMode: true,
		supportsNonMaxMode: true,
		metadataProvenance: "available-models-reverse-engineered",
		...overrides,
	};
}

function liveCatalog(models: readonly CursorUsableModel[]): CursorModelCatalog {
	return { source: "live", fetchedAt: 100, models };
}

describe("Cursor model metadata mapping", () => {
	const cases = [
		{ family: "Claude thinking", id: "claude-sonnet-5", params: [parameter("thinking", "true")], expected: "claude-sonnet-5-thinking", reasoning: true },
		{ family: "GPT effort", id: "gpt-5.5", params: [parameter("reasoning", "high")], expected: "gpt-5.5-high", reasoning: true, high: "gpt-5.5-high" },
		{ family: "Gemini non-reasoning", id: "gemini-3-pro", params: [parameter("temperature", "balanced")], expected: "gemini-3-pro-temperature-balanced", reasoning: false },
		{ family: "Composer fast", id: "composer-2", params: [parameter("fast", "true")], expected: "composer-2-fast", reasoning: false },
	] as const;

	for (const entry of cases) {
		test(`maps ${entry.family} from exact Cursor parameters`, () => {
			const models = mapCursorCatalogToProviderModels(liveCatalog([
				availableModel({ id: entry.id, variants: [variant(entry.params)] }),
			]));
			const mapped = models.find((model) => model.id === entry.expected);
			assert.ok(mapped);
			assert.equal(mapped.reasoning, entry.reasoning);
			if ("high" in entry) assert.equal(mapped.thinkingLevelMap?.high, entry.high);
			assert.equal(mapped.metadataProvenance.capabilities, "Cursor AvailableModels (reverse-engineered, account snapshot)");
		});
	}

	test("exposes only discovered reasoning values and never routes unsupported levels", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({
				id: "gpt-5.5",
				variants: [
					variant([parameter("reasoning", "low")]),
					variant([parameter("reasoning", "high")]),
					variant([parameter("reasoning", "extra-high")]),
				],
			}),
		]));
		assert.deepEqual(model?.thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "gpt-5.5-low",
			medium: null,
			high: "gpt-5.5-high",
			xhigh: "gpt-5.5-extra-high",
			max: null,
		});
		assert.throws(
			() => resolveCursorModelVariant(model?.id ?? "gpt-5.5-low", model?.thinkingLevelMap, "medium"),
			/does not support the requested medium reasoning level/u,
		);
		assert.equal(resolveCursorModelVariant(model?.id ?? "gpt-5.5-low", model?.thinkingLevelMap, "xhigh"), "gpt-5.5-extra-high");
	});

	test("keeps fast, thinking, Max context, Max-only, and effort semantics distinct", () => {
		const mapped = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({
				id: "gpt-5.5",
				supportsImages: true,
				variants: [
					variant([parameter("reasoning", "low"), parameter("fast", "false")]),
					variant([parameter("reasoning", "high"), parameter("fast", "true")]),
					variant([parameter("reasoning", "high")], true),
				],
			}),
			availableModel({ id: "max-only-model", supportsNonMaxMode: false, variants: [variant([], true)] }),
		]));
		assert.deepEqual(mapped.map((model) => model.id), ["gpt-5.5-high-fast", "gpt-5.5-low", "gpt-5.5-max-mode-high", "max-only-model-max-mode"]);
		assert.equal(mapped.find((model) => model.id === "gpt-5.5-low")?.contextWindow, 200_000);
		assert.equal(mapped.find((model) => model.id === "gpt-5.5-max-mode-high")?.contextWindow, 1_000_000);
		assert.equal(mapped.find((model) => model.id === "max-only-model-max-mode")?.reasoning, false);
		assert.deepEqual(mapped.find((model) => model.id === "gpt-5.5-low")?.input, ["text", "image"]);
	});

	test("creates routed normal and Max models when only model-level Max metadata is available", () => {
		const mapped = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({ id: "partial-max", variants: undefined }),
		]));
		assert.deepEqual(mapped.map((model) => model.id), ["partial-max", "partial-max-max-mode"]);
		assert.equal(mapped[0]?.contextWindow, 200_000);
		assert.equal(mapped[0]?.contextWindowOptions, undefined);
		assert.equal(mapped[0]?.compat?.cursorRouting?.["partial-max"]?.maxMode, false);
		assert.equal(mapped[1]?.contextWindow, 1_000_000);
		assert.equal(mapped[1]?.compat?.cursorRouting?.["partial-max-max-mode"]?.maxMode, true);
	});

	test("routes complete parameter combinations without recombining variants", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({ id: "gpt-5.5", serverModelName: "backend-gpt", variants: [variant([parameter("reasoning", "high"), parameter("fast", "false")])] }),
		]));
		assert.deepEqual(model?.compat?.cursorRouting?.["gpt-5.5-high"], {
			modelId: "backend-gpt",
			maxMode: false,
			parameters: [parameter("reasoning", "high"), parameter("fast", "false")],
		});
	});

	test("keeps distinct parameter values on distinct collision-free routes", () => {
		const models = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({ id: "parameterized", variants: [
				variant([parameter("temperature", "a+b")]),
				variant([parameter("temperature", "a-b")]),
			] }),
		]));
		const routes = models.flatMap((model) => Object.entries(model.compat?.cursorRouting ?? {}))
			.filter(([, routing]) => routing.parameters?.some(({ id }) => id === "temperature"));
		assert.equal(routes.length, 2);
		assert.notEqual(routes[0]?.[0], routes[1]?.[0]);
		assert.deepEqual(routes.map(([, routing]) => routing.parameters?.[0]?.value).sort(), ["a+b", "a-b"]);
	});

	test("preserves supplied output limits and does not combine normal and Max contexts", () => {
		const models = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({ id: "claude-sonnet", contextWindow: 180_000, maxModeContextWindow: 900_000, maxTokens: 32_000, variants: [variant([]), variant([], true)] }),
		]));
		assert.equal(models.find((model) => model.id === "claude-sonnet")?.contextWindow, 180_000);
		assert.equal(models.find((model) => model.id === "claude-sonnet")?.maxTokens, 32_000);
		assert.equal(models.find((model) => model.id === "claude-sonnet-max-mode")?.contextWindow, 900_000);
	});

	test("keeps context and output evidence attached to one corresponding variant", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([
			{ id: "paired-low", effort: "low", contextWindow: 100_000, maxTokens: 8_000, metadataProvenance: "available-models-reverse-engineered" },
			{ id: "paired-high", effort: "high", contextWindow: 200_000, maxTokens: 4_000, metadataProvenance: "available-models-reverse-engineered", isDefaultVariant: true },
		]));
		assert.equal(model?.contextWindow, 200_000);
		assert.equal(model?.maxTokens, 4_000);
	});

	test("does not strengthen legacy-cache limit provenance", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([
			{ id: "legacy-limits", contextWindow: 120_000, maxTokens: 12_000, metadataProvenance: "legacy-cache" },
		]));
		assert.match(model?.metadataProvenance.contextWindow ?? "", /legacy cached/u);
		assert.match(model?.metadataProvenance.maxTokens ?? "", /legacy cached/u);
		assert.doesNotMatch(model?.metadataProvenance.contextWindow ?? "", /AvailableModels/u);
	});

	test("does not infer defaults for unmarked effort-only variants", () => {
		for (const effort of ["none", "minimal", "medium"] as const) {
			const id = `unmarked-${effort}`;
			const [model] = mapCursorCatalogToProviderModels(liveCatalog([
				{ id, effort, parameters: [parameter("reasoning", effort)], requestedModelId: "unmarked", metadataProvenance: "available-models-reverse-engineered" },
			]));
			assert.equal(model?.id, id);
			assert.equal(model?.thinkingLevelMap?.off, null);
			assert.equal(model?.compat?.cursorRouting?.[id]?.parameters?.[0]?.value, effort);
		}
	});

	test("treats standalone -max names as ambiguous without supporting metadata", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([{ id: "gpt-5.1-codex-max", displayName: "GPT Codex Max", metadataProvenance: "get-usable-models" }]));
		assert.equal(model?.id, "gpt-5.1-codex-max");
		assert.equal(model?.reasoning, false);
		assert.equal(model?.thinkingLevelMap, undefined);
	});

	test("degrades absent and partial metadata conservatively with explicit provenance", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([{ id: "brand-new", displayName: "Brand New", metadataProvenance: "get-usable-models" }]));
		assert.equal(model?.contextWindow, 200_000);
		assert.equal(model?.maxTokens, 64_000);
		assert.equal(model?.reasoning, false);
		assert.deepEqual(model?.input, ["text"]);
		assert.match(model?.metadataProvenance.contextWindow ?? "", /exact limit unknown/u);
	});

	test("preserves unknown reasoning presets without advertising an Atomic level", () => {
		const [model] = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({ id: "future-reasoning", variants: [variant([parameter("reasoning", "adaptive-v2")])] }),
		]));
		assert.equal(model?.id, "future-reasoning-reasoning-adaptive_2dv2");
		assert.equal(model?.reasoning, true);
		assert.deepEqual(model?.thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
		assert.deepEqual(model?.compat?.cursorRouting?.[model.id]?.parameters, [parameter("reasoning", "adaptive-v2")]);
	});

	test("keeps live and persisted-cache metadata at parity", () => {
		const catalog = liveCatalog([availableModel({ id: "gpt-5.5", maxTokens: 48_000, variants: [variant([parameter("reasoning", "low")]), variant([parameter("reasoning", "high")], true)] })]);
		const record = toCursorCatalogCacheRecord(catalog);
		const reloaded = parseCursorCatalogCacheRecord(JSON.parse(JSON.stringify(record)));
		assert.ok(reloaded);
		assert.deepEqual(mapCursorCatalogToProviderModels(reloaded), mapCursorCatalogToProviderModels(catalog));
	});

	test("static fallback is explicitly conservative rather than authoritative", () => {
		const models = mapCursorCatalogToProviderModels(createEstimatedCursorCatalog(1));
		const composer = models.find((model) => model.id === "composer-2");
		assert.ok(composer);
		assert.match(composer.name, /fallback/u);
		assert.equal(composer.reasoning, false);
		assert.deepEqual(composer.input, ["text"]);
		assert.equal(composer.metadataProvenance.catalog, "estimated");
	});

	test("normalizes static suffix sets without inferring reasoning semantics", () => {
		const models = mapCursorCatalogToProviderModels(createEstimatedCursorCatalog(1));
		assert.equal(models.length, 37, "36 normalized compatibility groups plus the refreshed GPT-5.5 base entry");
		const family = models.filter((model) => model.id.startsWith("gpt-5.1-codex-max-"));
		assert.deepEqual(family.map((model) => model.id), ["gpt-5.1-codex-max-high", "gpt-5.1-codex-max-high-fast"]);
		for (const model of family) {
			assert.equal(model.reasoning, false, `${model.id}: suffix does not prove reasoning semantics`);
			assert.equal(model.thinkingLevelMap, undefined);
			assert.equal(model.compat?.cursorRouting?.[model.id]?.modelId, model.id);
		}
	});

	test("keeps colliding context presets distinct and honors Cursor-marked defaults", () => {
		const models = mapCursorCatalogToProviderModels(liveCatalog([
			availableModel({
				id: "gpt-contextual",
				variants: [
					{ ...variant([parameter("context", "272k"), parameter("reasoning", "low")]), isDefaultNonMaxConfig: false },
					{ ...variant([parameter("context", "1m"), parameter("reasoning", "high")]), isDefaultNonMaxConfig: true },
				],
			}),
		]));
		assert.deepEqual(models.map((model) => model.id), ["gpt-contextual-context-1m", "gpt-contextual-context-272k-low"]);
		const selected = models.find((model) => model.id === "gpt-contextual-context-1m");
		assert.equal(selected?.thinkingLevelMap?.off, "gpt-contextual-context-1m-high");
		assert.equal(selected?.compat?.cursorRouting?.["gpt-contextual-context-1m"]?.parameters?.find((item) => item.id === "context")?.value, "1m");
	});

	test("table-driven live/cache parity and fallback degradation covers representative semantics", () => {
		const scenarios = [
			{ name: "Claude", model: availableModel({ id: "claude", maxTokens: 32_000, variants: [variant([parameter("reasoning", "high")])] }), ids: ["claude-high"], reasoning: true, level: ["high", "claude-high"] as const, context: 200_000, output: 32_000 },
			{ name: "GPT", model: availableModel({ id: "gpt", variants: [{ ...variant([parameter("reasoning", "low")]), isDefaultNonMaxConfig: true }] }), ids: ["gpt"], reasoning: true, level: ["low", "gpt-low"] as const, off: "gpt-low", context: 200_000, output: 64_000 },
			{ name: "Gemini", model: availableModel({ id: "gemini", variants: [variant([parameter("thinking", "true")])] }), ids: ["gemini-thinking"], reasoning: true, context: 200_000, output: 64_000 },
			{ name: "Composer", model: availableModel({ id: "composer", variants: [variant([])] }), ids: ["composer"], reasoning: false, context: 200_000, output: 64_000 },
			{ name: "fast", model: availableModel({ id: "fast-model", variants: [variant([parameter("fast", "true")])] }), ids: ["fast-model-fast"], reasoning: false, context: 200_000, output: 64_000 },
			{ name: "thinking", model: availableModel({ id: "thinking-model", variants: [variant([parameter("thinking", "true")])] }), ids: ["thinking-model-thinking"], reasoning: true, context: 200_000, output: 64_000 },
			{ name: "Max", model: availableModel({ id: "max-model", variants: [variant([], true)] }), ids: ["max-model-max-mode"], reasoning: false, context: 1_000_000, output: 64_000, maxMode: true },
			{ name: "Max-only", model: availableModel({ id: "max-only", supportsNonMaxMode: false, variants: [] }), ids: ["max-only-max-mode"], reasoning: false, context: 1_000_000, output: 64_000, maxMode: true },
			{ name: "non-reasoning", model: availableModel({ id: "plain", variants: [variant([parameter("temperature", "balanced")])] }), ids: ["plain-temperature-balanced"], reasoning: false, context: 200_000, output: 64_000 },
		] as const;
		for (const scenario of scenarios) {
			const live = liveCatalog([scenario.model]);
			const cached = parseCursorCatalogCacheRecord(JSON.parse(JSON.stringify(toCursorCatalogCacheRecord(live))));
			assert.ok(cached, `${scenario.name}: cache reload`);
			const liveMapped = mapCursorCatalogToProviderModels(live);
			assert.deepEqual(mapCursorCatalogToProviderModels(cached), liveMapped, `${scenario.name}: live/cache parity`);
			assert.deepEqual(liveMapped.map((model) => model.id), scenario.ids, `${scenario.name}: distinct model IDs`);
			assert.equal(liveMapped[0]?.reasoning, scenario.reasoning, `${scenario.name}: reasoning capability`);
			assert.equal(liveMapped[0]?.contextWindow, scenario.context, `${scenario.name}: mode-specific context`);
			assert.equal(liveMapped[0]?.maxTokens, scenario.output, `${scenario.name}: output limit`);
			if ("level" in scenario) assert.equal(liveMapped[0]?.thinkingLevelMap?.[scenario.level[0]], scenario.level[1], `${scenario.name}: exact level`);
			if ("off" in scenario) assert.equal(liveMapped[0]?.thinkingLevelMap?.off, scenario.off, `${scenario.name}: discovered default`);
			if ("maxMode" in scenario) assert.equal(liveMapped[0]?.compat?.cursorRouting?.[scenario.ids[0]]?.maxMode, scenario.maxMode, `${scenario.name}: Max routing`);
			const [fallback] = mapCursorCatalogToProviderModels({ source: "estimated", fetchedAt: 1, models: [{ id: scenario.model.id, metadataProvenance: "static-fallback" }] });
			assert.equal(fallback?.reasoning, false, `${scenario.name}: no level synthesis without fallback evidence`);
			assert.deepEqual(fallback?.input, ["text"], `${scenario.name}: unknown image support degrades to text`);
			assert.match(fallback?.metadataProvenance.contextWindow ?? "", /exact limit unknown/u);
		}
	});

	test("keeps utility parsing and reconstruction deterministic", () => {
		assert.equal(parseCursorVariant({ id: "claude-high-thinking-fast", effort: "high" }).baseId, "claude");
		assert.equal(insertEffortBeforeCursorSuffix("claude-thinking-fast", "high"), "claude-high-thinking-fast");
	});
});
