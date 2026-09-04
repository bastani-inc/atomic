import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

type GeneratedModel = {
	id: string;
	api: string;
	baseUrl: string;
	compat?: { supportsMidConvoEffort?: boolean };
};
type GeneratedProviderCatalog = Record<string, Record<string, GeneratedModel>>;

function generateProviderCatalogs(
	catalog: unknown,
	providers: readonly string[],
	openRouterModels: readonly unknown[] = [],
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
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  if (url === "https://openrouter.ai/api/v1/models") return new Response(JSON.stringify({ data: openRouterModels }), { status: 200 });\n` +
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
// adapter, otherwise the selected reasoning level is never sent.
test("routes GitHub Copilot Claude Fable models through anthropic-messages", () => {
	const catalog = {
		"github-copilot": {
			models: {
				"claude-fable-5": { id: "claude-fable-5", ...toolCapable },
				"claude-fable-5-1": { id: "claude-fable-5-1", ...toolCapable },
				"claude-sonnet-4": { id: "claude-sonnet-4", ...toolCapable },
				// Neither a Claude model nor a /responses-only model.
				"gemini-3-pro": { id: "gemini-3-pro", ...toolCapable },
				// Copilot serves these only through /responses.
				"gpt-5.2": { id: "gpt-5.2", ...toolCapable },
			},
		},
	};

	const copilot = generateProviderCatalogs(catalog, ["github-copilot"])["github-copilot"];

	assert.deepEqual(Object.fromEntries(Object.entries(copilot).map(([id, model]) => [id, model.api])), {
		"claude-fable-5": "anthropic-messages",
		"claude-fable-5-1": "anthropic-messages",
		"claude-sonnet-4": "anthropic-messages",
		"gemini-3-pro": "openai-completions",
		"gpt-5.2": "openai-responses",
		// Astra's provisional fallback is present even before models.dev advertises it.
		"gpt-6-astra": "openai-responses",
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
