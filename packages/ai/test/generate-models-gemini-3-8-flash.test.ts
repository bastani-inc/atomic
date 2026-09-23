import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

/**
 * Deterministic generator regressions for Gemini 3.8 Flash.
 *
 * Every fixture below mirrors the upstream catalog entry it stands in for, so these assertions
 * pin generator behavior against a fixed input and do not drift with the live catalogs. That is
 * the split established by `be05f82112`: exact per-mirror values belong in a fixture test like
 * this one, while `test/google-gemini-3-8-flash-catalog.test.ts` sweeps the live catalog for
 * invariants only.
 *
 * Google / Google Vertex (models.dev, GA 2026-09-02):
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
 * - https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash
 *
 * GitHub Copilot: the generator consumes the `github-copilot/gemini-3.8-flash` row from
 * models.dev without supplementing or correcting it. The Copilot fixtures pin that direct
 * translation and prove that no entry is invented when models.dev omits the row.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type GeneratedModel = {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
};
type GeneratedProviderCatalog = Record<string, Record<string, GeneratedModel>>;

function generateProviderCatalogs(
	catalog: unknown,
	providers: readonly string[],
	liveCatalogs: { openRouterModels?: readonly unknown[]; aiGatewayModels?: readonly unknown[] } = {},
): GeneratedProviderCatalog {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-gemini-3-8-flash-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}

	const preloadPath = join(fixtureRoot, "mock-model-apis.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`const openRouterModels = ${JSON.stringify(liveCatalogs.openRouterModels ?? [])};\n` +
			`const aiGatewayModels = ${JSON.stringify(liveCatalogs.aiGatewayModels ?? [])};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: openRouterModels }), { status: 200 });\n` +
			`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: aiGatewayModels }), { status: 200 });\n` +
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
		{ cwd: isolatedPackageRoot, encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

	const catalogs: GeneratedProviderCatalog = {};
	for (const provider of providers) {
		// `--json-output` writes one flat model map per provider, with `api` on each model.
		catalogs[provider] = JSON.parse(readFileSync(join(outputPath, `providers/${provider}.json`), "utf8")) as Record<
			string,
			GeneratedModel
		>;
	}
	return catalogs;
}

// models.dev's `google` and `google-vertex` entries for this model are byte-identical.
const GEMINI_3_8_FLASH = {
	name: "Gemini 3.8 Flash",
	family: "gemini-flash",
	attachment: true,
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
	tool_call: true,
	structured_output: true,
	temperature: true,
	release_date: "2026-09-02",
	last_updated: "2026-09-02",
	modalities: { input: ["text", "image", "video", "audio", "pdf"], output: ["text"] },
	limit: { context: 1_048_576, output: 65_536 },
	cost: { input: 0.75, output: 3.75, cache_read: 0.075, input_audio: 0.75 },
} as const;

const COPILOT_GEMINI_3_7_FLASH = {
	name: "Gemini 3.7 Flash",
	reasoning: true,
	reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
	tool_call: true,
	modalities: { input: ["text", "image"], output: ["text"] },
	limit: { context: 1_000_000, input: 936_000, output: 64_000 },
	cost: { input: 0.75, output: 3.75, cache_read: 0.075 },
} as const;

const COPILOT_GEMINI_3_8_FLASH = {
	...COPILOT_GEMINI_3_7_FLASH,
	name: "Gemini 3.8 Flash",
} as const;

// models.dev `opencode.models["gemini-3.8-flash"]`: opencode zen's own rates, Google SDK routing.
const OPENCODE_GEMINI_3_8_FLASH = {
	...GEMINI_3_8_FLASH,
	cost: { input: 1.5, output: 7.5, cache_read: 0.15, input_audio: 1.5 },
	provider: { npm: "@ai-sdk/google" },
} as const;

const CLAUDE_OPUS_5 = {
	name: "Claude Opus 5",
	tool_call: true,
	reasoning: true,
	limit: { context: 200_000, output: 64_000 },
	cost: { input: 5, output: 25 },
} as const;

const BASE_CATALOG = {
	google: { models: { "gemini-3.8-flash": GEMINI_3_8_FLASH } },
	"google-vertex": {
		models: {
			"gemini-3.8-flash": GEMINI_3_8_FLASH,
			// A non-Gemini Vertex MaaS entry must stay excluded from the Gemini-only Vertex provider.
			"claude-opus-5": CLAUDE_OPUS_5,
		},
	},
	"github-copilot": {
		models: {
			"gemini-3.7-flash": COPILOT_GEMINI_3_7_FLASH,
			"gemini-3.8-flash": COPILOT_GEMINI_3_8_FLASH,
		},
	},
	opencode: { models: { "gemini-3.8-flash": OPENCODE_GEMINI_3_8_FLASH } },
	// A provider with no Gemini entry must never sprout a mirrored one.
	anthropic: { models: { "claude-opus-5": CLAUDE_OPUS_5 } },
} as const;

// Live openrouter.ai/api/v1/models values for the model and its batch variant.
const OPENROUTER_MODELS = [
	{
		id: "google/gemini-3.8-flash",
		name: "Google: Gemini 3.8 Flash",
		context_length: 1_048_576,
		top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
		architecture: { modality: "text+image->text" },
		pricing: {
			prompt: "0.00000075",
			completion: "0.00000375",
			input_cache_read: "0.000000075",
			input_cache_write: "0.0000000416666666666667",
		},
		supported_parameters: ["reasoning", "reasoning_effort", "tools"],
		reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high"] },
	},
	{
		id: "google/gemini-3.8-flash:batch",
		name: "Google: Gemini 3.8 Flash (batch)",
		context_length: 1_048_576,
		top_provider: { context_length: 1_048_576, max_completion_tokens: 65_536 },
		architecture: { modality: "text+image->text" },
		pricing: {
			prompt: "0.000000375",
			completion: "0.000001875",
			input_cache_read: "0.0000000375",
			input_cache_write: "0.0000000416666666666667",
		},
		supported_parameters: ["reasoning", "reasoning_effort", "tools"],
		reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high"] },
	},
] as const;

// Live ai-gateway.vercel.sh/v1/models values for the model.
const AI_GATEWAY_MODELS = [
	{
		id: "google/gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		context_window: 1_000_000,
		max_tokens: 65_536,
		tags: ["reasoning", "vision", "tool-use", "video-input"],
		pricing: { input: "0.00000075", output: "0.00000375", input_cache_read: "0.000000075" },
	},
] as const;

test("generates the documented Gemini 3.8 Flash entry for the Google Gemini API", () => {
	const { google } = generateProviderCatalogs(BASE_CATALOG, ["google"]);
	const model = google["gemini-3.8-flash"];

	assert.ok(model, "expected google/gemini-3.8-flash to be generated");
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.name, "Gemini 3.8 Flash");
	assert.equal(model.provider, "google");
	assert.equal(model.api, "google-generative-ai");
	assert.equal(model.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(model.maxTokens, 65_536);
	// `Model.input` describes what Atomic can serialize, not everything the model accepts, so
	// the five models.dev input modalities collapse to text+image on the Gemini path.
	assert.deepEqual(model.input, ["text", "image"]);
	assert.deepEqual(model.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	// The catalog now declares every level from models.dev instead of relying on runtime defaults.
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("generates the Vertex Gemini 3.8 Flash entry without inventing non-Gemini mirrors", () => {
	const catalogs = generateProviderCatalogs(BASE_CATALOG, ["google-vertex", "anthropic"]);
	const vertex = catalogs["google-vertex"];
	const model = vertex["gemini-3.8-flash"];

	assert.ok(model, "expected google-vertex/gemini-3.8-flash to be generated");
	// Vertex publishes the plain model id, with no `publishers/google/models/` prefix.
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.provider, "google-vertex");
	assert.equal(model.api, "google-vertex");
	assert.equal(model.baseUrl, "https://{location}-aiplatform.googleapis.com");
	assert.equal(model.reasoning, true);
	assert.equal(model.contextWindow, 1_048_576);
	assert.equal(model.maxTokens, 65_536);
	assert.deepEqual(model.input, ["text", "image"]);
	// Vertex accounts only cachedContentTokenCount, so cacheWrite is always 0 on this path.
	assert.deepEqual(model.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});

	// Negative controls: the Vertex provider serves only Gemini, and no unrelated provider
	// gains a Gemini 3.8 Flash entry it does not publish.
	assert.equal(vertex["claude-opus-5"], undefined);
	assert.equal(catalogs.anthropic["gemini-3.8-flash"], undefined);
});

// The `minimal` denial is scoped to 3.8 on purpose: Google's own comparison table publishes
// MINIMAL for Gemini 3.5 and 3.6 Flash, and only drops it from 3.7 onward. A family-wide rule
// would misreport those two models.
test("denies minimal only for 3.8 Flash, leaving the 3.5 and 3.6 Flash entries alone", () => {
	const catalog = {
		google: {
			models: {
				"gemini-3.8-flash": GEMINI_3_8_FLASH,
				"gemini-3.6-flash": {
					...GEMINI_3_8_FLASH,
					name: "Gemini 3.6 Flash",
					reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }],
				},
			},
		},
	};

	const { google } = generateProviderCatalogs(catalog, ["google"]);

	assert.equal(google["gemini-3.8-flash"].thinkingLevelMap?.minimal, null);
	assert.equal(google["gemini-3.6-flash"].thinkingLevelMap?.minimal, "minimal");
	assert.deepEqual(google["gemini-3.6-flash"].thinkingLevelMap, {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("generates the GitHub Copilot entry from models.dev metadata", () => {
	const copilot = generateProviderCatalogs(BASE_CATALOG, ["github-copilot"])["github-copilot"];
	const model = copilot["gemini-3.8-flash"];

	assert.ok(model, "expected models.dev's github-copilot/gemini-3.8-flash row to be generated");
	assert.equal(model.id, "gemini-3.8-flash");
	assert.equal(model.name, "Gemini 3.8 Flash");
	assert.equal(model.provider, "github-copilot");
	assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "https://api.individual.githubcopilot.com");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 1_000_000);
	assert.equal(model.maxTokens, 64_000);
	assert.deepEqual(model.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	assert.deepEqual(model.headers, {
		"User-Agent": "GitHubCopilotChat/0.35.0",
		"Editor-Version": "vscode/1.107.0",
		"Editor-Plugin-Version": "copilot-chat/0.35.0",
		"Copilot-Integration-Id": "vscode-chat",
	});
	assert.deepEqual(model.compat, {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		supportsStrictMode: true,
	});
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
});

test("pins the opencode, OpenRouter, and Vercel AI Gateway mirrors", () => {
	const catalogs = generateProviderCatalogs(BASE_CATALOG, ["opencode", "openrouter", "vercel-ai-gateway"], {
		openRouterModels: OPENROUTER_MODELS,
		aiGatewayModels: AI_GATEWAY_MODELS,
	});

	// opencode zen routes Google models through the Gemini API with its own pricing.
	assert.deepEqual(catalogs.opencode["gemini-3.8-flash"], {
		id: "gemini-3.8-flash",
		type: "chat",
		name: "Gemini 3.8 Flash",
		api: "google-generative-ai",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		reasoning: true,
		input: ["text", "image"],
		inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
		cost: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		// opencode rides the same Google thinking path and published level map.
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		},
	});

	const openrouter = catalogs.openrouter["google/gemini-3.8-flash"];
	assert.equal(openrouter.api, "openai-completions");
	assert.equal(openrouter.baseUrl, "https://openrouter.ai/api/v1");
	assert.equal(openrouter.contextWindow, 1_048_576);
	assert.equal(openrouter.maxTokens, 65_536);
	assert.deepEqual(openrouter.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.041667 });
	assert.deepEqual(openrouter.compat, {
		supportsDeveloperRole: false,
		supportsStrictMode: true,
		thinkingFormat: "openrouter",
		sendSessionAffinityHeaders: true,
	});
	// OpenRouter builds a full map from its own reasoning metadata and already denies `minimal`,
	// which is the same three efforts the Google-path fix arrives at from Google's docs.
	assert.deepEqual(openrouter.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: null,
		max: null,
	});
	const batch = catalogs.openrouter["google/gemini-3.8-flash:batch"];
	assert.equal(batch.api, "openai-completions");
	assert.deepEqual(batch.cost, { input: 0.375, output: 1.875, cacheRead: 0.0375, cacheWrite: 0.041667 });
	assert.deepEqual(batch.thinkingLevelMap, openrouter.thinkingLevelMap);

	const vercel = catalogs["vercel-ai-gateway"]["google/gemini-3.8-flash"];
	// The gateway routes its whole `google/*` family through anthropic-messages. That is
	// unconditional in `fetchAiGatewayModels` and pre-existing for every Gemini generation there;
	// it is pinned here so it reads as deliberate rather than accidental.
	assert.equal(vercel.api, "anthropic-messages");
	assert.equal(vercel.baseUrl, "https://ai-gateway.vercel.sh");
	assert.equal(vercel.contextWindow, 1_000_000);
	assert.equal(vercel.maxTokens, 65_536);
	assert.deepEqual(vercel.input, ["text", "image"]);
	assert.deepEqual(vercel.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
	// The gateway publishes no per-model thinking levels for its `anthropic-messages` models, so no
	// map is generated and its entry keeps offering `off` and `minimal` while the Google-path and
	// OpenAI-completions mirrors deny both. Pre-existing for every Gemini generation on the gateway,
	// and the reason the user-facing docs scope the three-level claim to the other mirrors.
	assert.equal(vercel.thinkingLevelMap, undefined);
});

test("preserves the models.dev Copilot row without overriding it", () => {
	const catalog = {
		...BASE_CATALOG,
		"github-copilot": {
			models: {
				"gemini-3.8-flash": {
					...COPILOT_GEMINI_3_8_FLASH,
					name: "Gemini 3.8 Flash (upstream)",
					limit: { context: 512_000, output: 32_000 },
					cost: { input: 1.5, output: 7.5, cache_read: 0.15 },
				},
			},
		},
	};

	const copilot = generateProviderCatalogs(catalog, ["github-copilot"])["github-copilot"];

	assert.equal(copilot["gemini-3.8-flash"].name, "Gemini 3.8 Flash (upstream)");
	assert.equal(copilot["gemini-3.8-flash"].contextWindow, 512_000);
	assert.equal(copilot["gemini-3.8-flash"].maxTokens, 32_000);
	assert.deepEqual(copilot["gemini-3.8-flash"].cost, {
		input: 1.5,
		output: 7.5,
		cacheRead: 0.15,
		cacheWrite: 0,
	});
});

test("does not invent a Copilot entry when models.dev omits it", () => {
	const catalog = {
		...BASE_CATALOG,
		"github-copilot": { models: { "gemini-3.7-flash": COPILOT_GEMINI_3_7_FLASH } },
	};

	const copilot = generateProviderCatalogs(catalog, ["github-copilot"])["github-copilot"];

	assert.equal(copilot["gemini-3.8-flash"], undefined);
	assert.ok(copilot["gemini-3.7-flash"], "expected the advertised sibling to survive");
});
