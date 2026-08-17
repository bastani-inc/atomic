import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver-defaults.ts";
import { moduleDir } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const shippedModelSources = ["packages/workflows/builtin", "packages/subagents/agents"];

function recursivelyListFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? recursivelyListFiles(path) : [path];
	});
}

function shippedSourceFiles(): string[] {
	return shippedModelSources.flatMap((relativePath) => recursivelyListFiles(join(root, relativePath)));
}

test("xAI defaults to Grok 4.6", () => {
	assert.equal(defaultModelPerProvider.xai, "grok-4.6");
});

test("builtin workflow and subagent sources contain no stale Grok 4.5 references", () => {
	for (const filePath of shippedSourceFiles()) {
		assert.doesNotMatch(readFileSync(filePath, "utf8"), /grok[- /]?4\.5/iu, filePath);
	}
});

test("builtin xAI and OpenRouter Grok fallbacks use Grok 4.6", () => {
	const references = shippedSourceFiles().flatMap(
		(filePath) => readFileSync(filePath, "utf8").match(/(?:xai|openrouter\/x-ai)\/grok-[^"'\s,]+/gu) ?? [],
	);
	const directReferences = references.filter((reference) => reference.startsWith("xai/"));
	const openRouterReferences = references.filter((reference) => reference.startsWith("openrouter/"));

	assert.ok(directReferences.length > 0, "expected direct xAI Grok fallbacks");
	assert.ok(openRouterReferences.length > 0, "expected OpenRouter Grok fallbacks");
	for (const reference of directReferences) assert.equal(reference, "xai/grok-4.6:high");
	for (const reference of openRouterReferences) assert.equal(reference, "openrouter/x-ai/grok-4.6");
});
