import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import type { ModelCost } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type GeneratedModel = {
	id: string;
	name?: string;
	api: string;
	baseUrl: string;
	compat?: {
		supportsReasoningEffort?: boolean;
		supportsMidConvoEffort?: boolean;
		supportsMidConvoSystemMessages?: boolean;
		supportsMidConvoToolAdditions?: boolean;
	};
	thinkingLevelMap?: Record<string, string | null>;
	cost: ModelCost;
};
type GeneratedProviderCatalog = Record<string, Record<string, GeneratedModel>>;

function generateProviderCatalogs(
	catalog: unknown,
	providers: readonly string[],
	openRouterModels: readonly unknown[] = [],
	aiGatewayModels: readonly object[] = [],
): GeneratedProviderCatalog {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-api-routing-"));
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
			`const openRouterModels = ${JSON.stringify(openRouterModels)};\n` +
			`const aiGatewayModels = ${JSON.stringify(aiGatewayModels)};\n` +
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

const toolCapable = {
	tool_call: true,
	limit: { context: 128_000, output: 8_192 },
	cost: { input: 1, output: 2 },
} as const;

// Regression for upstream pi 1e4fbe38 (closes upstream #8978): every Fireworks
// GLM model is served by the OpenAI-compatible completions API, not only the
// glm-5p2 family the previous substring match selected.
test("routes every Fireworks GLM model through openai-completions", () => {
	const catalog = {
		"fireworks-ai": {
			models: {
				"accounts/fireworks/models/glm-5p2": { id: "accounts/fireworks/models/glm-5p2", ...toolCapable },
				"accounts/fireworks/routers/glm-5p2-fast": {
					id: "accounts/fireworks/routers/glm-5p2-fast",
					...toolCapable,
				},
				"accounts/fireworks/models/glm-5p3": { id: "accounts/fireworks/models/glm-5p3", ...toolCapable },
				"accounts/fireworks/models/glm-5p3-flash": {
					id: "accounts/fireworks/models/glm-5p3-flash",
					...toolCapable,
				},
				// A non-GLM Fireworks model must stay on the Anthropic-compatible route.
				"accounts/fireworks/models/deepseek-v4": { id: "accounts/fireworks/models/deepseek-v4", ...toolCapable },
			},
		},
	};

	const { fireworks } = generateProviderCatalogs(catalog, ["fireworks"]);

	assert.deepEqual(Object.fromEntries(Object.entries(fireworks).map(([id, model]) => [id, model.api])), {
		"accounts/fireworks/models/glm-5p2": "openai-completions",
		"accounts/fireworks/routers/glm-5p2-fast": "openai-completions",
		"accounts/fireworks/models/glm-5p3": "openai-completions",
		"accounts/fireworks/models/glm-5p3-flash": "openai-completions",
		"accounts/fireworks/models/deepseek-v4": "anthropic-messages",
	});
});

// Regression for upstream pi 69afa105 (closes upstream #8961): GitHub Copilot
// Claude Fable models are Claude models and must use the Anthropic Messages
// adapter, otherwise the selected reasoning level is never sent. Each Copilot
// model's API comes from its models.dev SDK metadata, never its ID (#4324).
test("routes GitHub Copilot models by their models.dev SDK metadata, not their IDs (#4324)", () => {
	const anthropicSdk = { provider: { npm: "@ai-sdk/anthropic" } };
	const openAISdk = { provider: { npm: "@ai-sdk/openai" } };
	const catalog = {
		"github-copilot": {
			models: {
				"claude-fable-5": { id: "claude-fable-5", name: "Copilot Fable 5", ...toolCapable, ...anthropicSdk },
				"claude-sonnet-4": { id: "claude-sonnet-4", ...toolCapable, ...anthropicSdk },
				// No per-model SDK: Copilot's Chat Completions endpoint, as for Gemini and Kimi.
				"gemini-3-pro": { id: "gemini-3-pro", ...toolCapable },
				"kimi-k9": { id: "kimi-k9", ...toolCapable, provider: { npm: "@ai-sdk/openai-compatible" } },
				// Copilot serves these only through /responses.
				"gpt-5.2": { id: "gpt-5.2", ...toolCapable, ...openAISdk },
				"grok-9": { id: "grok-9", ...toolCapable, ...openAISdk },
				// An ID that reads like a /responses or Claude model still follows its metadata.
				"gpt-chat-preview": { id: "gpt-chat-preview", ...toolCapable },
				"claude-opus-9-chat": { id: "claude-opus-9-chat", ...toolCapable },
				"new-vendor-model": { id: "new-vendor-model", ...toolCapable, ...openAISdk },
			},
		},
		// Copilot lags Fable 5.1, so the generator reuses the Anthropic row, which carries no per-model SDK.
		// Copilot's own row wins over the Anthropic row when Copilot lists the model.
		anthropic: {
			models: {
				"claude-fable-5": { id: "claude-fable-5", name: "Anthropic Fable 5", ...toolCapable },
				"claude-fable-5-1": { id: "claude-fable-5-1", ...toolCapable },
			},
		},
	};

	const copilot = generateProviderCatalogs(catalog, ["github-copilot"])["github-copilot"];

	assert.equal(copilot["claude-fable-5"]?.name, "Copilot Fable 5");
	assert.deepEqual(Object.fromEntries(Object.entries(copilot).map(([id, model]) => [id, model.api])), {
		"claude-fable-5": "anthropic-messages",
		"claude-fable-5-1": "anthropic-messages",
		"claude-opus-5.5": "anthropic-messages",
		"claude-opus-9-chat": "openai-completions",
		"claude-sonnet-4": "anthropic-messages",
		"gemini-3-pro": "openai-completions",
		"gpt-5.2": "openai-responses",
		"gpt-chat-preview": "openai-completions",
		"grok-9": "openai-responses",
		"kimi-k9": "openai-completions",
		"new-vendor-model": "openai-responses",
		// Astra's provisional fallback is present even before models.dev advertises it.
		"gpt-6-astra": "openai-responses",
		// Copilot fallbacks added before models.dev lists them (upstream pi 27c072e9).
		"gpt-6-luna": "openai-responses",
		"gpt-6-sol": "openai-responses",
	});
});

// Regression for upstream pi 4e69b0c: OpenRouter Claude models use its native
// Anthropic Messages transport, while batch and non-Anthropic models retain the
// OpenAI-compatible endpoint.
test("routes eligible OpenRouter Claude models through anthropic-messages", () => {
	const openRouterModels = [
		{
			id: "anthropic/claude-fable-5.1",
			name: "Claude Fable 5.1",
			context_length: 128_000,
			pricing: { prompt: "0.000001", completion: "0.000002" },
			supported_parameters: ["reasoning", "tools"],
		},
		{
			id: "anthropic/claude-fable-5.1:batch",
			name: "Claude Fable 5.1 Batch",
			context_length: 128_000,
			pricing: { prompt: "0.000001", completion: "0.000002" },
			supported_parameters: ["reasoning", "tools"],
		},
		{
			id: "openai/gpt-5",
			name: "GPT 5",
			context_length: 128_000,
			pricing: { prompt: "0.000001", completion: "0.000002" },
			supported_parameters: ["reasoning", "tools"],
		},
	];

	const { openrouter } = generateProviderCatalogs({}, ["openrouter"], openRouterModels);
	assert.equal(openrouter["anthropic/claude-fable-5.1"].api, "anthropic-messages");
	assert.equal(openrouter["anthropic/claude-fable-5.1"].baseUrl, "https://openrouter.ai/api");
	assert.equal(openrouter["anthropic/claude-fable-5.1"].compat?.supportsMidConvoEffort, true);
	assert.equal(openrouter["anthropic/claude-fable-5.1:batch"].api, "openai-completions");
	assert.equal(openrouter["openai/gpt-5"].api, "openai-completions");
});

const kimiEffort = [{ type: "effort", values: ["none", "low", "high", "max"] }];

test.each(["kimi-code-plan-global", "kimi-code-plan-cn", "kimi-for-coding"])(
	"routes Kimi Coding models from the %s catalog source through Chat Completions (#10720)",
	(source) => {
		const catalog = {
			[source]: {
				models: {
					// models.dev lists effort options for K3-style models only, which marks them K3-style.
					"kimi-for-coding": { id: "kimi-for-coding", ...toolCapable, reasoning_options: kimiEffort },
					"kimi-for-coding-highspeed": { id: "kimi-for-coding-highspeed", ...toolCapable, reasoning_options: [] },
					k3: { id: "k3", ...toolCapable, reasoning_options: kimiEffort },
					"no-tools": { id: "no-tools", ...toolCapable, tool_call: false },
				},
			},
			...(source === "kimi-code-plan-global"
				? {
						"kimi-code-plan-cn": { models: { "cn-only": { id: "cn-only", ...toolCapable } } },
					}
				: {}),
		};
		const models = generateProviderCatalogs(catalog, ["kimi-coding"])["kimi-coding"];
		assert.deepEqual(Object.keys(models).sort(), ["k3", "kimi-for-coding", "kimi-for-coding-highspeed"]);
		for (const model of Object.values(models)) {
			assert.equal(model.api, "openai-completions");
			assert.equal(model.baseUrl, "https://api.kimi.com/coding/v1");
			assert.equal(model.compat?.supportsMidConvoSystemMessages, true);
			assert.equal(model.thinkingLevelMap?.off, null);
		}
		assert.equal(models.k3.compat?.supportsMidConvoToolAdditions, true);
		assert.equal(models["kimi-for-coding"].compat?.supportsMidConvoToolAdditions, true);
		assert.equal(models["kimi-for-coding-highspeed"].compat?.supportsMidConvoToolAdditions, undefined);
	},
);

test("treats Kimi K3.1 Pro models as Kimi K3 family (port pi 1de2d7ad)", () => {
	const k31Effort = [{ type: "effort", values: ["low", "high", "max"] }];
	const catalog = {
		moonshotai: {
			models: {
				"kimi-k3.1-pro": {
					id: "kimi-k3.1-pro",
					...toolCapable,
					cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2 },
				},
				"kimi-k2.6": { id: "kimi-k2.6", ...toolCapable },
			},
		},
		"kimi-code-plan-global": {
			models: {
				"k3.1-pro": { id: "k3.1-pro", ...toolCapable, cost: { input: 0, output: 0 }, reasoning_options: k31Effort },
			},
		},
	};
	const { moonshotai, "kimi-coding": kimiCoding } = generateProviderCatalogs(catalog, ["moonshotai", "kimi-coding"]);

	assert.equal(moonshotai["kimi-k3.1-pro"].compat?.supportsReasoningEffort, true);
	assert.equal(moonshotai["kimi-k3.1-pro"].compat?.supportsMidConvoToolAdditions, true);
	assert.equal(moonshotai["kimi-k3.1-pro"].cost.cacheWrite, 0);
	assert.equal(moonshotai["kimi-k2.6"].compat?.supportsReasoningEffort, false);
	assert.equal(kimiCoding["k3.1-pro"].compat?.supportsReasoningEffort, true);
	assert.deepEqual(kimiCoding["k3.1-pro"].cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 });
});

test("retains models.dev tiers and base rates across provider catalogs", () => {
	const cost = {
		input: 2,
		output: 12,
		cache_read: 0.2,
		cache_write: 0.375,
		tiers: [{ tier: { type: "context", size: 200000 }, input: 4, output: 18 }],
	};
	const model = { id: "tiered-model", ...toolCapable, cost };
	const catalogs = generateProviderCatalogs(
		{
			google: { models: { "tiered-model": model } },
			opencode: { models: { "tiered-model": model } },
			groq: { models: { "tiered-model": model } },
			openai: { models: { "tiered-model": model } },
		},
		["google", "opencode", "groq", "openai"],
	);
	for (const provider of ["google", "opencode", "groq", "openai"]) {
		assert.deepEqual(
			catalogs[provider]["tiered-model"].cost,
			{
				input: 2,
				output: 12,
				cacheRead: 0.2,
				cacheWrite: 0.375,
				tiers: [{ inputTokensAbove: 200000, input: 4, output: 18, cacheRead: 0.2, cacheWrite: 0.375 }],
			},
			provider,
		);
	}
});

test("AI Gateway pricing honors bracket ends and missing bracket rates", () => {
	const catalogs = generateProviderCatalogs(
		{},
		["vercel-ai-gateway"],
		[],
		[
			{
				id: "example/model",
				name: "Example",
				type: "language",
				tags: ["tool-use"],
				pricing: {
					input: "0.000001",
					output: "0.000005",
					input_tiers: [{ min: 100, max: 200, cost: "0.000002" }, { min: 200 }],
					output_tiers: [{ min: 300, cost: "0.000009" }],
				},
			},
		],
	);
	assert.deepEqual(catalogs["vercel-ai-gateway"]["example/model"].cost.tiers, [
		{ inputTokensAbove: 99, input: 2, output: 5, cacheRead: 0, cacheWrite: 0 },
		{ inputTokensAbove: 199, input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
		{ inputTokensAbove: 299, input: 1, output: 9, cacheRead: 0, cacheWrite: 0 },
	]);
});

test("copies the efforts the OpenAI catalog lists onto Azure deployments, except xhigh and max (#4545)", () => {
	const reasoningModel = (id: string, values: readonly string[]) => ({
		id,
		...toolCapable,
		reasoning: true,
		reasoning_options: [{ type: "effort", values }],
	});
	const catalogs = generateProviderCatalogs(
		{
			openai: {
				models: {
					"gpt-4.1": { id: "gpt-4.1", ...toolCapable },
					"gpt-5": reasoningModel("gpt-5", ["minimal", "low", "medium", "high"]),
					"gpt-5.1": reasoningModel("gpt-5.1", ["none", "low", "medium", "high", "xhigh", "max"]),
				},
			},
			"github-copilot": {
				models: {
					"gpt-5.1": {
						...reasoningModel("gpt-5.1", ["low", "medium", "high"]),
						provider: { npm: "@ai-sdk/openai" },
					},
				},
			},
		},
		["openai", "azure", "github-copilot"],
	);
	const { openai, azure, "github-copilot": copilot } = catalogs;

	assert.equal(openai["gpt-5.1"].thinkingLevelMap?.max, "max");
	assert.equal(openai["gpt-5.1"].thinkingLevelMap?.minimal, null);
	assert.deepEqual(azure["gpt-5"].thinkingLevelMap, {
		off: null,
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
	});
	assert.deepEqual(azure["gpt-5.1"].thinkingLevelMap, { off: "none", low: "low", medium: "medium", high: "high" });
	assert.equal("thinkingLevelMap" in azure["gpt-4.1"], false);
	assert.equal(copilot["gpt-5.1"].api, "openai-responses");
	assert.notEqual(copilot["gpt-5.1"].thinkingLevelMap?.off, "none");
});

test("copies the OpenAI off entry onto Azure deployments without masking their other levels (#4552)", () => {
	const reasoningModel = (id: string, values: readonly string[]) => ({
		id,
		...toolCapable,
		reasoning: true,
		reasoning_options: [{ type: "effort", values }],
	});
	const { openai, azure } = generateProviderCatalogs(
		{
			openai: {
				models: {
					o3: reasoningModel("o3", ["low", "medium", "high"]),
					"gpt-5-pro": reasoningModel("gpt-5-pro", ["high"]),
				},
			},
		},
		["openai", "azure"],
	);

	assert.equal(openai.o3.thinkingLevelMap?.off, null);
	assert.equal(openai.o3.thinkingLevelMap?.minimal, null);
	assert.deepEqual(azure.o3.thinkingLevelMap, { off: null, low: "low", medium: "medium", high: "high" });
	assert.deepEqual(azure["gpt-5-pro"].thinkingLevelMap, { off: null, high: "high" });
});

test("denies thinking off for Gemini 2.5 Pro on Google and Vertex only (#4552)", () => {
	const gemini = (id: string) => ({ id, name: id, ...toolCapable, reasoning: true });
	const catalogs = generateProviderCatalogs(
		{
			google: {
				models: { "gemini-2.5-pro": gemini("gemini-2.5-pro"), "gemini-2.5-flash": gemini("gemini-2.5-flash") },
			},
			"google-vertex": { models: { "gemini-2.5-pro": gemini("gemini-2.5-pro") } },
		},
		["google", "google-vertex", "vercel-ai-gateway"],
		[],
		[
			{
				id: "google/gemini-2.5-pro",
				name: "Gemini 2.5 Pro",
				context_window: 1_048_576,
				max_tokens: 65_536,
				tags: ["reasoning", "tool-use"],
				pricing: { input: "0.00000125", output: "0.00001" },
			},
		],
	);

	assert.deepEqual(catalogs.google["gemini-2.5-pro"].thinkingLevelMap, { off: null });
	assert.deepEqual(catalogs["google-vertex"]["gemini-2.5-pro"].thinkingLevelMap, { off: null });
	assert.equal("thinkingLevelMap" in catalogs.google["gemini-2.5-flash"], false);
	assert.ok(catalogs["vercel-ai-gateway"]["google/gemini-2.5-pro"], "expected the AI Gateway entry to be generated");
	assert.equal("thinkingLevelMap" in catalogs["vercel-ai-gateway"]["google/gemini-2.5-pro"], false);
});
