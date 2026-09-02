import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

/**
 * Deterministic generator regression for Claude Fable 5.1.
 *
 * The catalog tests elsewhere read `src/providers/data/`, which is regenerated from live
 * upstream catalogs on every build. That is useful drift detection but it is not a fixed
 * expectation: models.dev gained three Fable 5.1 entries inside one hour during this work, and
 * a provider that publishes zeroed costs would silently rewrite those tests' inputs.
 *
 * This test pins the generator's *behavior* instead: a fixed models.dev payload in, an exact
 * catalog out. It also stubs OpenRouter and the Vercel AI Gateway to empty, which proves those
 * two Fable 5.1 mirrors come from those providers' own live APIs rather than being invented by
 * Atomic — the "no invented provider mirrors" criterion, checked rather than asserted.
 *
 * One thing deliberately is NOT asserted here: the $20 one-hour cache write is not a catalog
 * field. It is derived at request time as `input * 2` (`models.ts`) and is covered in
 * `anthropic-cache-write-1h-cost.test.ts`.
 *
 * The five published efforts *are* asserted, but through `getSupportedThinkingLevels` rather than
 * through the raw map. Anthropic models skip models.dev `reasoning_options`, because
 * `supportsDirectReasoningEffort` is evaluated before `forceAdaptiveThinking` is set, so the
 * generated map is sparse and the middle levels resolve at runtime. A level the map leaves
 * undefined is *offered*, which is how `minimal` — an effort Anthropic does not publish for this
 * model — became selectable. Asserting the resolved level list is what pins the objective's
 * effort clause; asserting the map alone would not have caught it.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const FABLE_5_1_MODELS_DEV = {
	name: "Claude Fable 5.1",
	tool_call: true,
	reasoning: true,
	temperature: false,
	structured_output: true,
	knowledge: "2026-06",
	release_date: "2026-09-01",
	modalities: { input: ["text", "image", "pdf"], output: ["text"] },
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
	limit: { context: 1_000_000, output: 128_000 },
} as const;

const OPUS_COST = { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 };
const FABLE_COST = { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 };
// US-only inference carries a documented 1.1x premium on every rate.
const FABLE_COST_US = { input: 11, output: 55, cache_read: 0.275, cache_write: 13.75 };

/** A fixed models.dev payload mirroring what the live catalog publishes for these models. */
const CATALOG = {
	anthropic: {
		models: {
			"claude-fable-5-1": { ...FABLE_5_1_MODELS_DEV, id: "claude-fable-5-1", cost: FABLE_COST },
			"claude-fable-5": {
				...FABLE_5_1_MODELS_DEV,
				id: "claude-fable-5",
				name: "Claude Fable 5",
				cost: { ...FABLE_COST, cache_read: 1 },
			},
			"claude-opus-4-8": {
				id: "claude-opus-4-8",
				name: "Claude Opus 4.8",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				cost: OPUS_COST,
				limit: { context: 1_000_000, output: 128_000 },
			},
			"claude-opus-5": {
				id: "claude-opus-5",
				name: "Claude Opus 5",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"], output: ["text"] },
				cost: OPUS_COST,
				limit: { context: 1_000_000, output: 128_000 },
			},
		},
	},
	"amazon-bedrock": {
		models: {
			"anthropic.claude-fable-5-1": {
				...FABLE_5_1_MODELS_DEV,
				id: "anthropic.claude-fable-5-1",
				structured_output: undefined,
				cost: FABLE_COST,
			},
			"global.anthropic.claude-fable-5-1": {
				...FABLE_5_1_MODELS_DEV,
				id: "global.anthropic.claude-fable-5-1",
				name: "Claude Fable 5.1 (Global)",
				structured_output: undefined,
				cost: FABLE_COST,
			},
			"us.anthropic.claude-fable-5-1": {
				...FABLE_5_1_MODELS_DEV,
				id: "us.anthropic.claude-fable-5-1",
				name: "Claude Fable 5.1 (US)",
				structured_output: undefined,
				cost: FABLE_COST_US,
			},
		},
	},
};

interface GeneratedModel {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

function generate(): Record<string, Record<string, GeneratedModel>> {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-fable-5-1-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}

	const preloadPath = join(fixtureRoot, "mock-model-apis.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(CATALOG)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
			`};\n`,
	);

	const outputPath = join(fixtureRoot, "catalog");
	const result = spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--json-only",
			"--json-output",
			outputPath,
		],
		{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 60_000 },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

	const read = (provider: string): Record<string, GeneratedModel> => {
		try {
			return JSON.parse(readFileSync(join(outputPath, `providers/${provider}.json`), "utf8"));
		} catch {
			return {};
		}
	};
	return {
		anthropic: read("anthropic"),
		"amazon-bedrock": read("amazon-bedrock"),
		openrouter: read("openrouter"),
		"vercel-ai-gateway": read("vercel-ai-gateway"),
	};
}

test("generates Claude Fable 5.1 with exact limits, pricing, thinking map, and compat", () => {
	const catalogs = generate();
	const model = catalogs.anthropic["claude-fable-5-1"];

	assert.ok(model, "expected anthropic/claude-fable-5-1 to be generated");
	assert.equal(model.api, "anthropic-messages");
	assert.equal(model.provider, "anthropic");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 128_000);
	assert.deepEqual(model.cost, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });

	// The fixture feeds `["text", "image", "pdf"]`, matching what upstream publishes, and the
	// Anthropic Messages path keeps `pdf` because it can serialize a document block. The
	// OpenRouter and Vercel assertions further down keep `["text", "image"]`, so this one test
	// encodes the per-API gating rule from both sides.
	assert.deepEqual(model.input, ["text", "image", "pdf"]);

	// Adaptive thinking is always on, so `off` is denied. `minimal` is denied too: Anthropic
	// publishes exactly five efforts for this model and `minimal` is not among them, and
	// `getSupportedThinkingLevels` treats an unmapped level as available. `xhigh` and `max` need
	// an explicit mapping; `low`, `medium`, and `high` resolve at runtime.
	assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" });

	// The assertion that actually encodes the objective's effort clause. The map alone would not
	// have caught `minimal` leaking in, because it leaked through the *absence* of a mapping.
	assert.deepEqual(getSupportedThinkingLevels(model as unknown as Model<Api>), [
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);

	assert.equal(model.compat?.forceAdaptiveThinking, true);
	assert.equal(model.compat?.supportsTemperature, false);
	assert.equal(model.compat?.supportsStrictTools, true);
	assert.equal(model.compat?.delegatesThinkingModelBinding, true);
	assert.equal(model.compat?.enforcesPreservedThinkingBinding, true);
	// Claude Fable 5.1 rejects forced tool use on every request.
	assert.equal(model.compat?.supportsForcedToolChoice, false);
});

test("resolves Claude Fable 5.1 fallback targets to exactly Opus 4.8 and Opus 5", () => {
	const model = generate().anthropic["claude-fable-5-1"];
	const fallbacks = model.compat?.allowedFallbackModels as Array<{ provider: string; model: string }> | undefined;

	assert.ok(fallbacks, "expected allowedFallbackModels to be generated");
	assert.deepEqual(fallbacks.map((f) => f.model).sort(), ["claude-opus-4-8", "claude-opus-5"]);
	for (const fallback of fallbacks) assert.equal(fallback.provider, "anthropic");
});

test("generates every published Bedrock profile with its own pricing and no invented mirror", () => {
	const bedrock = generate()["amazon-bedrock"];

	assert.deepEqual(Object.keys(bedrock).sort(), [
		"anthropic.claude-fable-5-1",
		"global.anthropic.claude-fable-5-1",
		"us.anthropic.claude-fable-5-1",
	]);
	// The fixture publishes no `eu.` profile, and the generator must not synthesize one.
	assert.equal(bedrock["eu.anthropic.claude-fable-5-1"], undefined);

	assert.deepEqual(bedrock["anthropic.claude-fable-5-1"].cost, {
		input: 10,
		output: 50,
		cacheRead: 0.25,
		cacheWrite: 12.5,
	});
	assert.deepEqual(bedrock["global.anthropic.claude-fable-5-1"].cost, {
		input: 10,
		output: 50,
		cacheRead: 0.25,
		cacheWrite: 12.5,
	});
	assert.deepEqual(bedrock["us.anthropic.claude-fable-5-1"].cost, {
		input: 11,
		output: 55,
		cacheRead: 0.275,
		cacheWrite: 13.75,
	});

	for (const id of Object.keys(bedrock)) {
		assert.equal(bedrock[id].contextWindow, 1_000_000, id);
		assert.equal(bedrock[id].maxTokens, 128_000, id);
		assert.deepEqual(bedrock[id].thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" }, id);
		assert.deepEqual(
			getSupportedThinkingLevels(bedrock[id] as unknown as Model<Api>),
			["low", "medium", "high", "xhigh", "max"],
			id,
		);
	}
});

test("scopes preserved-thinking compat to first-party Anthropic models", () => {
	const catalogs = generate();

	// Bedrock rides a different API and is not covered by Anthropic's signature adjudication.
	for (const id of Object.keys(catalogs["amazon-bedrock"])) {
		const compat = catalogs["amazon-bedrock"][id].compat ?? {};
		assert.equal(compat.enforcesPreservedThinkingBinding, undefined, id);
		assert.equal(compat.delegatesThinkingModelBinding, undefined, id);
		// models.dev omits `structured_output` on the Bedrock entries; do not mirror Anthropic's.
		assert.equal(compat.supportsStrictMode, undefined, id);
	}

	// Only Claude Fable 5.1 runs the conversation check and rejects forced tool use. Fable 5
	// delegates model binding but is opted into neither, which pins the capability boundaries.
	const fable5 = catalogs.anthropic["claude-fable-5"];
	assert.equal(fable5.compat?.delegatesThinkingModelBinding, true);
	assert.equal(fable5.compat?.enforcesPreservedThinkingBinding, undefined);
	assert.equal(fable5.compat?.supportsForcedToolChoice, undefined);
	assert.equal(catalogs.anthropic["claude-opus-5"].compat?.enforcesPreservedThinkingBinding, undefined);
	assert.equal(catalogs.anthropic["claude-opus-5"].compat?.supportsForcedToolChoice, undefined);
});

test("emits no OpenRouter or Vercel Fable mirror when those live APIs return nothing", () => {
	const catalogs = generate();

	// Neither mirror comes from models.dev: the generator fetches each provider's own API. With
	// both stubbed empty, no Fable entry appears under either provider, so the ones Atomic ships
	// are provider-published rather than invented. This also covers the `~anthropic/
	// claude-fable-latest` alias, whose ID contains `fable` but not `fable-5-1`.
	const fableIds = (models: Record<string, GeneratedModel>) => Object.keys(models).filter((id) => /fable/i.test(id));
	assert.deepEqual(fableIds(catalogs.openrouter), []);
	assert.deepEqual(fableIds(catalogs["vercel-ai-gateway"]), []);

	// OpenRouter's two synthesized routing entries are unrelated to any upstream catalog and are
	// expected to survive an empty stub; naming them keeps this assertion honest about scope.
	assert.deepEqual(Object.keys(catalogs.openrouter).sort(), ["auto", "openrouter/fusion"]);
});
