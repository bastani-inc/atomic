import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const AI_DIR = join(ROOT, "packages/ai");
const AI_DIST = join(AI_DIR, "dist");
const CHILD_TIMEOUT_MS = 60_000;
const builtTest = existsSync(join(AI_DIST, "api/openai-completions.js")) ? test : test.skip;

interface LoadAudit {
	readonly totalFiles: number;
	readonly urls: string[];
	readonly byPackage: Record<string, number>;
}

function auditLoad(entryRelPaths: readonly string[]): LoadAudit {
	const script = `import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const urls = [];
const byPackage = {};
registerHooks({
	load(url, ctx, next) {
		if (url.startsWith("file:")) {
			urls.push(url);
			const match = url.match(/node_modules\\/((?:@[^/]+\\/)?[^/]+)/);
			const pkg = match ? match[1] : "@bastani/atomic-ai";
			byPackage[pkg] = (byPackage[pkg] ?? 0) + 1;
		}
		return next(url, ctx);
	},
});
for (const rel of ${JSON.stringify(entryRelPaths)}) {
	await import(pathToFileURL(${JSON.stringify(AI_DIST)} + "/" + rel).href);
}
console.log(JSON.stringify({ totalFiles: urls.length, urls, byPackage }));
`;
	const result = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
		cwd: ROOT,
		env: { ...process.env, NODE_OPTIONS: "" },
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return JSON.parse(result.stdout.toString()) as LoadAudit;
}

builtTest(
	"openai-completions and openai-responses load openai from one shared bundled chunk instead of ~200 files",
	() => {
		const completions = auditLoad(["api/openai-completions.js"]);
		assert.equal(
			completions.byPackage.openai ?? 0,
			0,
			`expected 0 external openai files: ${JSON.stringify(completions.byPackage)}`,
		);
		assert.equal(completions.byPackage["partial-json"] ?? 0, 0, "expected 0 external partial-json files");
		assert.ok(
			completions.totalFiles <= 15,
			`expected <= 15 files for openai-completions, got ${completions.totalFiles}`,
		);

		const both = auditLoad(["api/openai-completions.js", "api/openai-responses.js"]);
		assert.equal(both.byPackage.openai ?? 0, 0);
		// openai-responses reuses the same shared openai chunk as openai-completions (only adds its own facade + thin adapter).
		assert.ok(
			both.totalFiles <= completions.totalFiles + 4,
			`openai-responses should share openai chunk with openai-completions (${completions.totalFiles} -> ${both.totalFiles})`,
		);
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"anthropic-messages loads @anthropic-ai/sdk and its dependencies from bundled chunks instead of ~125 files",
	() => {
		const anthropic = auditLoad(["api/anthropic-messages.js"]);
		assert.equal(
			anthropic.byPackage["@anthropic-ai/sdk"] ?? 0,
			0,
			`expected 0 external @anthropic-ai/sdk files: ${JSON.stringify(anthropic.byPackage)}`,
		);
		assert.equal(anthropic.byPackage.standardwebhooks ?? 0, 0);
		assert.equal(anthropic.byPackage["@stablelib/base64"] ?? 0, 0);
		assert.equal(anthropic.byPackage["fast-sha256"] ?? 0, 0);
		assert.equal(anthropic.byPackage["partial-json"] ?? 0, 0);
		assert.ok(anthropic.totalFiles <= 15, `expected <= 15 files for anthropic-messages, got ${anthropic.totalFiles}`);
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"startup entries index.js and compat.js never load openai or @anthropic-ai/sdk chunks and load 0 external partial-json files",
	() => {
		const startup = auditLoad(["index.js", "compat.js"]);
		assert.equal(startup.byPackage.openai ?? 0, 0);
		assert.equal(startup.byPackage["@anthropic-ai/sdk"] ?? 0, 0);
		assert.equal(startup.byPackage["partial-json"] ?? 0, 0);
		// Ensure none of the loaded chunks at startup contain the bundled OpenAI or Anthropic client classes.
		const openaiLazyChunks = auditLoad(["api/openai-completions.js"]).urls.filter((u) => !startup.urls.includes(u));
		const anthropicLazyChunks = auditLoad(["api/anthropic-messages.js"]).urls.filter(
			(u) => !startup.urls.includes(u),
		);
		assert.ok(
			openaiLazyChunks.some((u) => u.includes("/_lazy-")),
			"openai must stay in a _lazy chunk",
		);
		assert.ok(
			anthropicLazyChunks.some((u) => u.includes("/_lazy-")),
			"anthropic must stay in a _lazy chunk",
		);
	},
	CHILD_TIMEOUT_MS,
);

test("packages/ai keeps SDK dependencies declared and ships third-party licenses for every inlined package", () => {
	const pkg = JSON.parse(readFileSync(join(AI_DIR, "package.json"), "utf8")) as {
		dependencies: Record<string, string>;
	};
	for (const dep of ["openai", "@anthropic-ai/sdk", "partial-json", "typebox"]) {
		assert.ok(pkg.dependencies[dep], `${dep} must remain declared for dist/_modules and in-place compatibility`);
	}
	const noticesDir = join(AI_DIR, "THIRD_PARTY_NOTICES");
	for (const file of [
		"typebox-LICENSE",
		"openai-LICENSE",
		"anthropic-sdk-LICENSE",
		"partial-json-LICENSE",
		"standardwebhooks-LICENSE",
		"stablelib-base64-LICENSE",
		"fast-sha256-LICENSE",
	]) {
		assert.ok(existsSync(join(noticesDir, file)), `missing license file ${file}`);
	}
});
