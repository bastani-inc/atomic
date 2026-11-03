import { join, resolve } from "node:path";
import type { Model } from "@bastani/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { resolveModelScopeFromModels } from "../src/core/model-resolver.ts";
import { applyNamePatterns, applyPatterns } from "../src/core/package-manager-resource-patterns.ts";

// Pins the glob semantics of the two minimatch call sites, so a minimatch upgrade that changes them fails here.

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

describe("model scope globs", () => {
	const models = [
		model("anthropic", "claude-sonnet-4"),
		model("anthropic", "claude-opus-4"),
		model("openai", "gpt-4o-mini"),
		model("openrouter", "meta-llama/llama-3.1-8b-instruct"),
	];
	const scope = (pattern: string) =>
		resolveModelScopeFromModels([pattern], models).scopedModels.map(
			({ model, thinkingLevel }) => `${model.provider}/${model.id}${thinkingLevel ? `:${thinkingLevel}` : ""}`,
		);

	it.each([
		["*sonnet*", ["anthropic/claude-sonnet-4"]],
		["ANTHROPIC/Claude-*", ["anthropic/claude-sonnet-4", "anthropic/claude-opus-4"]],
		["anthropic/claude-{sonnet,opus}-*:high", ["anthropic/claude-sonnet-4:high", "anthropic/claude-opus-4:high"]],
		["anthropic/!(claude-opus-*)", ["anthropic/claude-sonnet-4"]],
		["gpt-4?-mini", ["openai/gpt-4o-mini"]],
		["openrouter/*", []],
		["openrouter/**", ["openrouter/meta-llama/llama-3.1-8b-instruct"]],
		["**/llama-*", ["openrouter/meta-llama/llama-3.1-8b-instruct"]],
	])("%s selects %j", (pattern, expected) => {
		expect(scope(pattern)).toEqual(expected);
	});
});

describe("resource filter globs", () => {
	const base = resolve("/atomic-glob-pins");
	const files = [
		"extensions/a.ts",
		"extensions/sub/b.ts",
		"extensions/c.js",
		"skills/skill-a/SKILL.md",
		"skills/nested/skill-b/SKILL.md",
		"skills/.hidden/skill-c/SKILL.md",
		"themes/dark.json",
	];
	const select = (patterns: string[]) =>
		[
			...applyPatterns(
				files.map((file) => join(base, file)),
				patterns,
				base,
			),
		].map((path) => files.find((file) => join(base, file) === path));

	it.each([
		[["**/*.ts"], ["extensions/a.ts", "extensions/sub/b.ts"]],
		[["extensions/*.ts"], ["extensions/a.ts"]],
		[["extensions/**"], ["extensions/a.ts", "extensions/sub/b.ts", "extensions/c.js"]],
		[["**/*.{ts,js}"], ["extensions/a.ts", "extensions/sub/b.ts", "extensions/c.js"]],
		[["{extensions,themes}/*"], ["extensions/a.ts", "extensions/c.js", "themes/dark.json"]],
		[
			["!**/*.ts"],
			[
				"extensions/c.js",
				"skills/skill-a/SKILL.md",
				"skills/nested/skill-b/SKILL.md",
				"skills/.hidden/skill-c/SKILL.md",
				"themes/dark.json",
			],
		],
		[
			["extensions/**", "!extensions/sub/**"],
			["extensions/a.ts", "extensions/c.js"],
		],
		[["skills/*"], ["skills/skill-a/SKILL.md"]],
		[
			["**/skill-*"],
			["skills/skill-a/SKILL.md", "skills/nested/skill-b/SKILL.md", "skills/.hidden/skill-c/SKILL.md"],
		],
		[
			["skills/**", "!**/.hidden/**"],
			["skills/skill-a/SKILL.md", "skills/nested/skill-b/SKILL.md"],
		],
	])("%j selects %j", (patterns, expected) => {
		expect(select(patterns)).toEqual(expected);
	});

	it.each([
		[["server-*"], ["server-alpha"]],
		[["server{-,.}*"], ["server-alpha", "server.beta"]],
		[["!server-*"], ["server.beta", "other"]],
		[
			["*", "!other"],
			["server-alpha", "server.beta"],
		],
	])("names %j select %j", (patterns, expected) => {
		expect([...applyNamePatterns(["server-alpha", "server.beta", "other"], patterns)]).toEqual(expected);
	});
});
