import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver-defaults.ts";
import { moduleDir } from "../helpers/runtime.js";

const root = resolve(moduleDir(import.meta.url), "../..");
const shippedModelSources = ["packages/subagents/agents"];

function recursivelyListFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? recursivelyListFiles(path) : [path];
	});
}

function shippedSourceFiles(): string[] {
	return shippedModelSources.flatMap((relativePath) => recursivelyListFiles(join(root, relativePath)));
}

test("xAI defaults to Grok 4.7", () => {
	assert.equal(defaultModelPerProvider.xai, "grok-4.7");
});

test("builtin workflow and subagent sources contain no stale Grok 4.5 references", () => {
	for (const filePath of shippedSourceFiles()) {
		assert.doesNotMatch(readFileSync(filePath, "utf8"), /grok[- /]?4\.5/iu, filePath);
	}
});

test("builtin defaults no longer pin Grok provider fallback chains", () => {
	for (const filePath of shippedSourceFiles()) {
		assert.doesNotMatch(
			readFileSync(filePath, "utf8"),
			/(?:xai|openrouter\/x-ai|github-copilot)\/grok-[^"'\s,]+/u,
			filePath,
		);
	}
});
