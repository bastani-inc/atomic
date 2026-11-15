import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, test } from "vitest";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
// #2847 split the custom-provider guide into child pages and left an
// anchor-compatible heading behind for every section that moved. The child
// pages carry the real content, so they come first: a slice anchored on
// `### API Types` must land on the table, not on the stub that only points at
// it. The entry page stays in the corpus for the markers that never moved.
const doc = [
	"packages/coding-agent/docs/custom-provider/override.md",
	"packages/coding-agent/docs/custom-provider/registration.md",
	"packages/coding-agent/docs/custom-provider/oauth.md",
	"packages/coding-agent/docs/custom-provider/streaming.md",
	"packages/coding-agent/docs/custom-provider/api-reference.md",
	"packages/coding-agent/docs/custom-provider.md",
]
	.map((path) => readFileSync(join(repoRoot, path), "utf8"))
	.join("\n");

// npm links the forked packages into the root node_modules; the artifacts
// suite (forked-packages-artifacts.test.ts) asserts that install, so this suite only
// has to read it. Every path the doc names is checked against this tree, which
// is exactly what a reader following the doc would find.
const piAiDist = join(repoRoot, "node_modules", "@bastani", "atomic-ai", "dist");

/** One heading-bounded slice of the doc, failing loudly when a marker moves. */
function section(startMarker: string, endMarker: string): string {
	const start = doc.indexOf(startMarker);
	assert.ok(start !== -1, `the custom provider docs must still contain "${startMarker}"`);
	const end = doc.indexOf(endMarker, start);
	assert.ok(end !== -1, `the custom provider docs must still contain "${endMarker}" after "${startMarker}"`);
	return doc.slice(start, end);
}

const referenceBlock = section("**Reference implementations:**", "### Stream Pattern");
const apiTypesBlock = section("### API Types", "### Auth Header");

function assertDistModuleExists(directory: "api" | "providers", name: string): void {
	for (const extension of [".d.ts", ".js"]) {
		const path = join(piAiDist, directory, `${name}${extension}`);
		assert.ok(
			existsSync(path),
			`docs/custom-provider.md names ${directory}/${name}${extension}, which must exist in the installed @bastani/atomic-ai tree`,
		);
	}
}

describe("custom provider reference list", () => {
	test("streams readers to dist/api, not dist/providers", () => {
		const firstBullet = referenceBlock.indexOf("- `");
		assert.ok(firstBullet !== -1, "the reference block still carries a file list");
		const intro = referenceBlock.slice(0, firstBullet);
		assert.match(
			intro,
			/dist\/api\//u,
			"the streaming reference list must live under dist/api/ in the installed pi-ai package",
		);
		// The original defect: this sentence sent readers to dist/providers/,
		// where openai-completions and openai-responses do not exist.
		assert.doesNotMatch(
			intro,
			/dist\/providers\//u,
			"the streaming reference list must not point at dist/providers/",
		);
	});

	test("every module in the reference list resolves in the installed tree", () => {
		const bullets = [...referenceBlock.matchAll(/^- `([\w.-]+)\.d\.ts` \/ `[\w.-]+\.js` - /gmu)].map((m) => m[1]);
		assert.ok(bullets.length > 0, "the reference list still names at least one dist/api module");
		for (const name of bullets) assertDistModuleExists("api", name);

		// The six transports the original list meant to name. Two of them
		// (openai-completions, openai-responses) never existed under
		// dist/providers/, and the other four live there only as per-vendor
		// configs, not as streaming implementations.
		for (const name of [
			"anthropic-messages",
			"mistral-conversations",
			"openai-completions",
			"openai-responses",
			"google-generative-ai",
			"bedrock-converse-stream",
		]) {
			assert.ok(bullets.includes(name), `the reference list must name dist/api/${name}`);
		}
	});

	test("per-vendor config examples resolve under dist/providers", () => {
		const perVendor = /Per-vendor[^\n]*/u.exec(referenceBlock)?.[0];
		assert.ok(
			perVendor,
			"the reference block must still explain that dist/providers/ holds per-vendor configurations",
		);
		assert.match(perVendor, /dist\/providers\//u);
		const names = [...perVendor.matchAll(/`([\w.-]+)\.(?:d\.ts|js)`/gu)].map((m) => m[1]);
		assert.ok(names.length > 0, "the per-vendor sentence still names example files");
		for (const name of new Set(names)) assertDistModuleExists("providers", name);
	});

	test("every api value the table offers is a real dist/api module", () => {
		const rows = [...apiTypesBlock.matchAll(/^\| `([a-z0-9-]+)` \|/gmu)].map((m) => m[1]);
		assert.ok(rows.length >= 9, `the API Types table still lists its transports (found ${rows.length})`);
		for (const name of rows) assertDistModuleExists("api", name);
	});

	test("the Mistral transport is stated as native, matching pi-ai 0.84.2", () => {
		// Upstream 9dd90a49 replaced @mistralai/mistralai with a native HTTP
		// transport; the table row must not claim an SDK that is no longer
		// installed anywhere in the tree.
		assert.match(apiTypesBlock, /\| `mistral-conversations` \| Native Mistral Chat Completions streaming \|/u);
		assert.equal(doc.includes("Mistral SDK"), false, "the doc must not claim a Mistral SDK transport");
	});
});
