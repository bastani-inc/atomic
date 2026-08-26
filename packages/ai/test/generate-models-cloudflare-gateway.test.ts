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

test.each([
	["omitted", undefined, undefined],
	[
		"not marked tool-capable by Workers AI",
		{
			id: "@cf/moonshotai/kimi-k2.6",
			name: "Catalog Kimi K2.6",
			tool_call: false,
			limit: { context: 131_072, output: 65_536 },
		},
		undefined,
	],
	[
		"not marked tool-capable by AI Gateway",
		undefined,
		{
			id: "workers-ai/@cf/moonshotai/kimi-k2.6",
			name: "Filtered Gateway Kimi K2.6",
			tool_call: false,
		},
	],
])(
	"keeps the Cloudflare default catalog-independent when its metadata is %s",
	(_state, defaultMetadata, gatewayDefaultMetadata) => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-cloudflare-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}

		const workersModel = {
			id: "@cf/example/derived",
			name: "Derived Workers Model",
			tool_call: true,
			reasoning: true,
			reasoning_options: [{ type: "effort", values: ["low", "high"] }],
			modalities: { input: ["text", "image"] },
			cost: { input: 1, output: 2, cache_read: 0.25, cache_write: 0.5 },
			limit: { context: 8192, output: 2048 },
		};
		const catalog = {
			"cloudflare-workers-ai": {
				models: {
					...(defaultMetadata ? { [defaultMetadata.id]: defaultMetadata } : {}),
					[workersModel.id]: workersModel,
					"@cf/example/native": { id: "@cf/example/native", name: "Workers metadata", tool_call: true },
					"@cf/example/no-tools": { id: "@cf/example/no-tools", name: "No tools", tool_call: false },
				},
			},
			"cloudflare-ai-gateway": {
				models: {
					...(gatewayDefaultMetadata ? { [gatewayDefaultMetadata.id]: gatewayDefaultMetadata } : {}),
					"workers-ai/@cf/example/native": {
						id: "workers-ai/@cf/example/native",
						name: "Gateway metadata wins",
						tool_call: true,
						cost: { input: 9 },
					},
				},
			},
		};
		const preloadPath = join(fixtureRoot, "mock-model-apis.mjs");
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  const url = String(input);\n` +
				`  if (url === "https://models.dev/api.json") return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  if (url.includes("openrouter.ai")) return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
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

		const completions = JSON.parse(
			readFileSync(join(outputPath, "providers/cloudflare-ai-gateway.json"), "utf8"),
		) as Record<string, { id: string; name: string; cost: { input: number }; provider: string; baseUrl: string }>;
		const workersCompletions = JSON.parse(
			readFileSync(join(outputPath, "providers/cloudflare-workers-ai.json"), "utf8"),
		) as Record<string, { id: string; name: string; provider: string; baseUrl: string }>;
		assert.deepEqual(completions["workers-ai/@cf/example/derived"], {
			id: "workers-ai/@cf/example/derived",
			name: "Derived Workers Model",
			api: "openai-completions",
			provider: "cloudflare-ai-gateway",
			baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
			contextWindow: 8192,
			maxTokens: 2048,
			compat: {
				sendSessionAffinityHeaders: true,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsLongCacheRetention: false,
				supportsStrictMode: false,
				supportsStore: false,
				maxTokensField: "max_tokens",
			},
		});
		assert.equal(completions["workers-ai/@cf/example/native"].name, "Gateway metadata wins");
		assert.equal(completions["workers-ai/@cf/example/native"].cost.input, 9);
		assert.equal(completions["workers-ai/@cf/example/no-tools"], undefined);
		const defaultWorkersId = "@cf/moonshotai/kimi-k2.6";
		const defaultGatewayId = `workers-ai/${defaultWorkersId}`;
		assert.deepEqual(
			{
				id: workersCompletions[defaultWorkersId]?.id,
				name: workersCompletions[defaultWorkersId]?.name,
				provider: workersCompletions[defaultWorkersId]?.provider,
				baseUrl: workersCompletions[defaultWorkersId]?.baseUrl,
			},
			{
				id: defaultWorkersId,
				name: defaultMetadata?.name ?? "Kimi K2.6",
				provider: "cloudflare-workers-ai",
				baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
			},
		);
		assert.deepEqual(
			{
				id: completions[defaultGatewayId]?.id,
				name: completions[defaultGatewayId]?.name,
				provider: completions[defaultGatewayId]?.provider,
				baseUrl: completions[defaultGatewayId]?.baseUrl,
			},
			{
				id: defaultGatewayId,
				name: defaultMetadata?.name ?? "Kimi K2.6",
				provider: "cloudflare-ai-gateway",
				baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat",
			},
		);
		assert.deepEqual(Object.keys(completions), [
			"workers-ai/@cf/example/derived",
			"workers-ai/@cf/example/native",
			defaultGatewayId,
		]);
	},
);
