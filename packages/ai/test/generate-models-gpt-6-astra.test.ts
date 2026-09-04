import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Api, Model } from "../src/types.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

interface GeneratedModel {
	id: string;
	name: string;
	api: string;
	provider: string;
	reasoning: boolean;
	input: string[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers?: Array<{
			inputTokensAbove: number;
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
		}>;
	};
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
	fastRoute?: unknown;
}

function generate(
	aiGatewayModels: readonly Record<string, unknown>[] = [],
	openRouterModels: readonly Record<string, unknown>[] = [],
	modelsDev: Record<string, { models: Record<string, object> }> = {},
): Record<string, Record<string, GeneratedModel>> {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-gpt-6-astra-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}

	const preloadPath = join(fixtureRoot, "mock-model-apis.mjs");
	writeFileSync(
		preloadPath,
		`const aiGatewayModels = ${JSON.stringify(aiGatewayModels)};\n` +
			`const openRouterModels = ${JSON.stringify(openRouterModels)};\n` +
			`const modelsDev = ${JSON.stringify(modelsDev)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(modelsDev), { status: 200 });\n` +
			`  if (url === "https://ai-gateway.vercel.sh/v1/models") return new Response(JSON.stringify({ data: aiGatewayModels }), { status: 200 });\n` +
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
		openai: read("openai"),
		"openai-codex": read("openai-codex"),
		"amazon-bedrock": read("amazon-bedrock"),
		"azure-openai-responses": read("azure-openai-responses"),
		openrouter: read("openrouter"),
		"vercel-ai-gateway": read("vercel-ai-gateway"),
		"github-copilot": read("github-copilot"),
	};
}

function assertAstraCapabilities(model: GeneratedModel, provider: string): void {
	assert.equal(model.provider, provider);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 272_000);
	assert.equal(model.maxTokens, 128_000);
	assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" });
	assert.deepEqual(getSupportedThinkingLevels(model as unknown as Model<Api>), [
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
}

function astraIds(models: Record<string, GeneratedModel>): string[] {
	return Object.keys(models).filter((id) => id.includes("gpt-6-astra"));
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("generates authoritative OpenAI and Codex GPT-6-Astra metadata without internal policy fields", () => {
	const catalogs = generate();
	const openai = catalogs.openai["gpt-6-astra"];
	const codex = catalogs["openai-codex"]["gpt-6-astra"];

	assert.ok(openai);
	assert.ok(codex);
	assertAstraCapabilities(openai, "openai");
	assertAstraCapabilities(codex, "openai-codex");
	assert.equal(openai.api, "openai-responses");
	assert.equal(codex.api, "openai-codex-responses");
	assert.equal(codex.name, "GPT-6-Astra");

	const standardCost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
	const longContextTier = {
		inputTokensAbove: 272_000,
		input: 20,
		output: 75,
		cacheRead: 2,
		cacheWrite: 25,
	};
	for (const model of [openai, codex]) {
		assert.deepEqual(model.cost, { ...standardCost, tiers: [longContextTier] });
		assert.equal(model.compat?.supportsAdditionalTools, true);
		assert.equal(model.compat?.supportsToolSearch, true);
		assert.equal("model_messages" in model, false);
		assert.equal("persistent_instructions" in model, false);
		assert.equal("tools" in model, false);
	}
	assert.equal(openai.compat?.supportsExplicitPromptCacheMode, true);
});

test("generates only the three Codex-advertised Bedrock IDs with safe zero pricing", () => {
	const bedrock = generate()["amazon-bedrock"];
	assert.deepEqual(astraIds(bedrock), ["global.openai.gpt-6-astra", "openai.gpt-6-astra", "us.openai.gpt-6-astra"]);
	assert.equal(bedrock["eu.openai.gpt-6-astra"], undefined);

	const expectedNames: Record<string, string> = {
		"openai.gpt-6-astra": "GPT-6-Astra",
		"global.openai.gpt-6-astra": "GPT-6-Astra (Global)",
		"us.openai.gpt-6-astra": "GPT-6-Astra (US cross-region)",
	};
	for (const id of astraIds(bedrock)) {
		const model = bedrock[id];
		assertAstraCapabilities(model, "amazon-bedrock");
		assert.equal(model.api, "bedrock-converse-stream");
		assert.equal(model.name, expectedNames[id]);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(model.compat?.supportsToolSearch, undefined);
		assert.equal(model.compat?.supportsAdditionalTools, undefined);
	}
});

test("does not fabricate Azure, OpenRouter, or Vercel GPT-6-Astra availability", () => {
	const catalogs = generate();
	assert.deepEqual(astraIds(catalogs["azure-openai-responses"]), []);
	assert.deepEqual(astraIds(catalogs.openrouter), []);
	assert.deepEqual(astraIds(catalogs["vercel-ai-gateway"]), []);
});

test("preserves live-provider Astra IDs, long-context prices, and provider-owned fast semantics", () => {
	const catalogs = generate(
		[
			{
				id: "openai/gpt-6-astra",
				name: "GPT-6 Astra",
				context_window: 1_050_000,
				max_tokens: 128_000,
				tags: ["tool-use", "reasoning", "vision", "web-search"],
				pricing: {
					input: "0.00001",
					input_tiers: [
						{ cost: "0.00001", max: 272_001 },
						{ cost: "0.00002", min: 272_001 },
					],
					output: "0.00005",
					output_tiers: [
						{ cost: "0.00005", max: 272_001 },
						{ cost: "0.000075", min: 272_001 },
					],
					input_cache_read: "0.000001",
					input_cache_read_tiers: [
						{ cost: "0.000001", max: 272_001 },
						{ cost: "0.000002", min: 272_001 },
					],
					input_cache_write: "0.0000125",
					input_cache_write_tiers: [
						{ cost: "0.0000125", max: 272_001 },
						{ cost: "0.000025", min: 272_001 },
					],
				},
			},
			{
				id: "openai/gpt-6-astra-fast",
				name: "GPT-6 Astra Fast",
				context_window: 1_050_000,
				max_tokens: 128_000,
				tags: ["tool-use", "reasoning", "vision", "web-search"],
				pricing: {
					input: "0.00002",
					input_tiers: [
						{ cost: "0.00002", max: 272_001 },
						{ cost: "0.00004", min: 272_001 },
					],
					output: "0.0001",
					output_tiers: [
						{ cost: "0.0001", max: 272_001 },
						{ cost: "0.00015", min: 272_001 },
					],
					input_cache_read: "0.000002",
					input_cache_read_tiers: [
						{ cost: "0.000002", max: 272_001 },
						{ cost: "0.000004", min: 272_001 },
					],
					input_cache_write: "0.0000125",
					input_cache_write_tiers: [
						{ cost: "0.0000125", max: 272_001 },
						{ cost: "0.000025", min: 272_001 },
					],
				},
			},
		],
		[
			{
				id: "openai/gpt-6-astra",
				name: "OpenAI: GPT-6 Astra",
				supported_parameters: ["reasoning", "reasoning_effort", "tools"],
				architecture: { modality: "text+image+file->text" },
				pricing: {
					prompt: "0.00001",
					completion: "0.00005",
					input_cache_read: "0.000001",
					input_cache_write: "0.0000125",
					overrides: [
						{
							min_prompt_tokens: 272_000,
							prompt: "0.00002",
							completion: "0.000075",
							input_cache_read: "0.000002",
							input_cache_write: "0.000025",
						},
					],
				},
				top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
				reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high", "xhigh", "max"] },
			},
			{
				id: "openai/gpt-6-astra-pro",
				name: "OpenAI: GPT-6 Astra Pro",
				supported_parameters: ["reasoning", "reasoning_effort", "tools"],
				architecture: { modality: "text+image+file->text" },
				pricing: {
					prompt: "0.00001",
					completion: "0.00005",
					input_cache_read: "0.000001",
					input_cache_write: "0.0000125",
					overrides: [
						{
							min_prompt_tokens: 272_000,
							prompt: "0.00002",
							completion: "0.000075",
							input_cache_read: "0.000002",
							input_cache_write: "0.000025",
						},
					],
				},
				top_provider: { context_length: 1_050_000, max_completion_tokens: 128_000 },
				reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high", "xhigh", "max"] },
			},
		],
	);
	const vercel = catalogs["vercel-ai-gateway"];
	const openrouter = catalogs.openrouter;

	assert.deepEqual(astraIds(vercel), ["openai/gpt-6-astra", "openai/gpt-6-astra-fast"]);
	assert.equal(vercel["openai/gpt-6-astra-fast"].fastRoute, undefined);
	assert.deepEqual(vercel["openai/gpt-6-astra"].cost, {
		input: 10,
		output: 50,
		cacheRead: 1,
		cacheWrite: 12.5,
		tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
	});
	assert.deepEqual(vercel["openai/gpt-6-astra-fast"].cost, {
		input: 20,
		output: 100,
		cacheRead: 2,
		cacheWrite: 12.5,
		tiers: [{ inputTokensAbove: 272_000, input: 40, output: 150, cacheRead: 4, cacheWrite: 25 }],
	});
	assert.deepEqual(astraIds(openrouter), ["openai/gpt-6-astra", "openai/gpt-6-astra-pro"]);
	for (const id of astraIds(openrouter)) {
		assert.deepEqual(openrouter[id].cost, {
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 12.5,
			tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
		});
	}
});

test("adds a Copilot Astra fallback without inventing Copilot pricing or fast entitlement", () => {
	const copilot = generate()["github-copilot"];
	assert.deepEqual(astraIds(copilot), ["gpt-6-astra"]);
	const model = copilot["gpt-6-astra"];
	assertAstraCapabilities(model, "github-copilot");
	assert.equal(model.api, "openai-responses");
	assert.equal(model.baseUrl, "https://api.individual.githubcopilot.com");
	assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(model.fastRoute, undefined);
});

test("prefers Copilot catalog metadata and routes Astra through Responses", () => {
	const copilot = generate([], [], {
		"github-copilot": {
			models: {
				"gpt-6-astra": {
					name: "Copilot Astra fixture",
					tool_call: true,
					reasoning: true,
					modalities: { input: ["text", "image"], output: ["text"] },
					limit: { context: 1_050_000, output: 128_000 },
					cost: { input: 3, output: 9, cache_read: 0.3 },
				},
			},
		},
	})["github-copilot"];
	assert.deepEqual(astraIds(copilot), ["gpt-6-astra"]);
	const model = copilot["gpt-6-astra"];
	assert.equal(model.name, "Copilot Astra fixture");
	assert.equal(model.api, "openai-responses");
	assert.equal(model.contextWindow, 1_050_000);
	assert.deepEqual(model.cost, { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 0 });
});
