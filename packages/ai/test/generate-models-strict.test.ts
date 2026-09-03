import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function runOpenRouterRetryFixture(
	mode: "transient-success" | "transient-failure" | "http-429" | "http-400" | "cyclic-self" | "cyclic-mutual",
) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-retry-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "package");
	mkdirSync(isolatedPackageRoot);
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}

	const modelIds = [
		"deepseek-v4-flash-0731",
		"deepseek-v4-pro",
		"deepseek-v4-pro-0813",
		"glm-5.2",
		"qwen3.6-flash",
		"qwen3.7-max",
		"qwen3.7-plus",
		"qwen3.8-max",
	];
	const sourceModels = Object.fromEntries(modelIds.map((id) => [id, { id, name: id, tool_call: true }]));
	const catalog = { "alibaba-token-plan": { models: sourceModels } };
	const preloadPath = join(fixtureRoot, "mock-model-catalogs.mjs");
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`let openRouterAttempts = 0;\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  const url = String(input);\n` +
			`  if (url === "https://models.dev/api.json") {\n` +
			`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  }\n` +
			`  if (url === "https://openrouter.ai/api/v1/models") {\n` +
			`    openRouterAttempts += 1;\n` +
			`    const mode = ${JSON.stringify(mode)};\n` +
			`    if ((mode === "transient-success" || mode === "http-429") && openRouterAttempts > 1) {\n` +
			`      return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
			`    }\n` +
			`    if (mode === "http-429") return new Response("rate limited", { status: 429 });\n` +
			`    if (mode === "http-400") return new Response("bad request", { status: 400 });\n` +
			`    if (mode === "cyclic-self") {\n` +
			`      const error = new Error("cyclic self");\n` +
			`      error.cause = error;\n` +
			`      throw error;\n` +
			`    }\n` +
			`    if (mode === "cyclic-mutual") {\n` +
			`      const error = new Error("cyclic mutual");\n` +
			`      const cause = new Error("cyclic mutual cause");\n` +
			`      error.cause = cause;\n` +
			`      cause.cause = error;\n` +
			`      throw error;\n` +
			`    }\n` +
			`    const error = new TypeError("fetch failed");\n` +
			`    error.cause = Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });\n` +
			`    throw error;\n` +
			`  }\n` +
			`  if (url === "https://ai-gateway.vercel.sh/v1/models") {\n` +
			`    return new Response(JSON.stringify({ data: [] }), { status: 200 });\n` +
			`  }\n` +
			`  throw new Error(\`Unexpected fetch: \${url}\`);\n` +
			`};\n`,
	);

	return spawnSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			"--strict",
			"--json-only",
			"--json-output",
			join(fixtureRoot, "catalog"),
		],
		{
			cwd: isolatedPackageRoot,
			encoding: "utf8",
			timeout: 10_000,
		},
	);
}

describe("strict model generation", () => {
	it("retries a transient model-catalog fetch before succeeding in strict mode", () => {
		const result = runOpenRouterRetryFixture("transient-success");

		expect(result.status).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"Model fetch from https://openrouter.ai/api/v1/models failed transiently; retrying (attempt 2/2)",
		);
		expect(result.stdout).toContain("Fetched 0 tool-capable models from OpenRouter");
	});

	it("still fails strict mode after exhausting transient model-catalog fetch retries", () => {
		const result = runOpenRouterRetryFixture("transient-failure");

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"Model fetch from https://openrouter.ai/api/v1/models failed transiently; retrying (attempt 2/2)",
		);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"Failed to fetch OpenRouter models: TypeError: fetch failed",
		);
	});

	it("retries a rate-limited model-catalog response", () => {
		const result = runOpenRouterRetryFixture("http-429");

		expect(result.status).toBe(0);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"Model fetch from https://openrouter.ai/api/v1/models returned 429; retrying (attempt 2/2)",
		);
	});

	it("does not retry a deterministic model-catalog response", () => {
		const result = runOpenRouterRetryFixture("http-400");
		const output = `${result.stdout}\n${result.stderr}`;

		expect(result.status).toBe(1);
		expect(output).toContain("OpenRouter API returned 400");
		expect(output).not.toContain("retrying");
	});

	it.each([
		["self-referential", "cyclic-self", "cyclic self"],
		["mutually referential", "cyclic-mutual", "cyclic mutual"],
	] as const)("handles a %s model-catalog error cause without overflowing", (_description, mode, message) => {
		const result = runOpenRouterRetryFixture(mode);
		const output = `${result.stdout}\n${result.stderr}`;

		expect(result.status).toBe(1);
		expect(output).toContain(message);
		expect(output).not.toContain("retrying");
		expect(output).not.toContain("RangeError: Maximum call stack size exceeded");
	});

	it("fails before mutating generated data when an Individual model loses tool support", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-models-"));
		temporaryRoots.push(fixtureRoot);
		const isolatedPackageRoot = join(fixtureRoot, "package");
		mkdirSync(isolatedPackageRoot);
		for (const entry of ["package.json", "scripts", "src"]) {
			cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
		}
		const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
		const modelIds = [
			"deepseek-v4-flash-0731",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"glm-5.2",
			"qwen3.6-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
			"qwen3.8-max-preview",
		];
		const sourceModels = Object.fromEntries(
			modelIds.map((id) => [
				id,
				{
					id,
					name: id,
					tool_call: id !== "deepseek-v4-flash-0731",
				},
			]),
		);
		const catalog = { "alibaba-token-plan": { models: sourceModels } };
		writeFileSync(
			preloadPath,
			`const catalog = ${JSON.stringify(catalog)};\n` +
				`globalThis.fetch = async (input) => {\n` +
				`  if (String(input) === "https://models.dev/api.json") {\n` +
				`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
				`  }\n` +
				`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
				`};\n`,
		);

		const generatedPaths = [
			"src/models.generated.ts",
			"src/providers/qwen-token-plan-individual.models.ts",
			"src/providers/data/qwen-token-plan-individual.json",
			"src/providers/data/.manifest.json",
		];
		const sourceBefore = generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"));
		const isolatedBefore = generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"));

		const result = spawnSync(
			process.execPath,
			["--import", pathToFileURL(preloadPath).href, "scripts/generate-models.ts", "--strict"],
			{
				cwd: isolatedPackageRoot,
				encoding: "utf8",
				timeout: 10_000,
			},
		);

		expect(result.status).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain(
			"qwen-token-plan-individual model IDs do not match (missing: deepseek-v4-flash-0731)",
		);
		expect(generatedPaths.map((path) => readFileSync(join(isolatedPackageRoot, path), "utf8"))).toEqual(
			isolatedBefore,
		);
		expect(generatedPaths.map((path) => readFileSync(join(packageRoot, path), "utf8"))).toEqual(sourceBefore);
	});
});
