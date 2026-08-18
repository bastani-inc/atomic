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
	for (const filePath of shippedSourceFiles()) {
		const source = readFileSync(filePath, "utf8");
		const references = source.match(/(?:xai|openrouter\/x-ai|github-copilot)\/grok-[^"'\s,]+/gu) ?? [];
		const directReferences = references.filter((reference) => reference.startsWith("xai/"));
		const openRouterReferences = references.filter((reference) => reference.startsWith("openrouter/"));
		const copilotReferences = references.filter((reference) => reference.startsWith("github-copilot/"));

		for (const reference of directReferences) assert.equal(reference, "xai/grok-4.6:xhigh", filePath);
		for (const reference of openRouterReferences) assert.equal(reference, "openrouter/x-ai/grok-4.6", filePath);
		for (const reference of copilotReferences) assert.equal(reference, "github-copilot/grok-4.6:xhigh", filePath);

		const xaiMatches = [...source.matchAll(/xai\/grok-[^"'\s,]+/gu)];
		for (const match of xaiMatches) {
			const after = source.slice((match.index ?? 0) + match[0].length);
			assert.match(after, /^["']?,\s*(?:\n\s*)?["']?github-copilot\/grok-4\.6:xhigh/, filePath);
		}
	}

	const allReferences = shippedSourceFiles().flatMap(
		(filePath) =>
			readFileSync(filePath, "utf8").match(/(?:xai|openrouter\/x-ai|github-copilot)\/grok-[^"'\s,]+/gu) ?? [],
	);
	assert.ok(
		allReferences.some((reference) => reference.startsWith("xai/")),
		"expected direct xAI Grok fallbacks",
	);
	assert.ok(
		allReferences.some((reference) => reference.startsWith("openrouter/")),
		"expected OpenRouter Grok fallbacks",
	);
	assert.ok(
		allReferences.some((reference) => reference.startsWith("github-copilot/")),
		"expected Copilot Grok fallbacks",
	);
});
