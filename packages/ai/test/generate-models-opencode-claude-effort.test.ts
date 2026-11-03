import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";

/**
 * OpenCode Zen and Go forward per-message effort and `thinking.block_binding` to Anthropic.
 * Without `drop_block`, Go rejects replayed thinking once the system prompt or tools change
 * (upstream pi #10954), so their Claude models that take per-message effort must get it.
 */

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function claude(id: string, name: string) {
	return {
		id,
		name,
		tool_call: true,
		reasoning: true,
		temperature: false,
		modalities: { input: ["text", "image"], output: ["text"] },
		cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
		limit: { context: 200_000, output: 64_000 },
		provider: { npm: "@ai-sdk/anthropic" },
	};
}

const CATALOG = {
	opencode: {
		models: {
			"claude-haiku-5-5": claude("claude-haiku-5-5", "Claude Haiku 5.5"),
			"claude-opus-5-5": claude("claude-opus-5-5", "Claude Opus 5.5"),
			"claude-opus-4-8": claude("claude-opus-4-8", "Claude Opus 4.8"),
		},
	},
	"opencode-go": {
		models: {
			"claude-haiku-5-5": claude("claude-haiku-5-5", "Claude Haiku 5.5"),
		},
	},
};

interface GeneratedModel {
	id: string;
	api: string;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

function generate(): Record<string, Record<string, GeneratedModel>> {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-generate-opencode-claude-"));
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
	const read = (provider: string): Record<string, GeneratedModel> =>
		JSON.parse(readFileSync(join(outputPath, `providers/${provider}.json`), "utf8"));
	return { opencode: read("opencode"), "opencode-go": read("opencode-go") };
}

test("OpenCode Zen and Go Claude 5.5 models use per-message effort (upstream #10954)", () => {
	const catalogs = generate();
	const zenHaiku = catalogs.opencode["claude-haiku-5-5"];
	const zenOpus = catalogs.opencode["claude-opus-5-5"];
	const goHaiku = catalogs["opencode-go"]["claude-haiku-5-5"];
	for (const model of [zenHaiku, zenOpus, goHaiku]) {
		assert.ok(model, "expected the model to be generated");
		assert.equal(model.api, "anthropic-messages");
		assert.equal(model.compat?.supportsMidConvoEffort, true, model.id);
	}
	// Haiku 5.5 accepts disabled thinking with per-message effort; Opus 5.5 rejects it.
	assert.notEqual(zenHaiku.thinkingLevelMap?.off, null);
	assert.equal(zenOpus.thinkingLevelMap?.off, null);
	assert.equal(catalogs.opencode["claude-opus-4-8"]?.compat?.supportsMidConvoEffort, undefined);
});
