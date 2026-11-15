import assert from "node:assert/strict";
import type { Api, Model } from "@bastani/pi-ai/compat";
import { describe, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { resolveFallbackModel } from "../src/core/fallback-models.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main-session-options.ts";
import { fakeModelRuntime } from "./model-runtime-test-utils.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

const CATALOG = [
	model("anthropic", "claude-sonnet-4-5"),
	model("openai", "gpt-4o"),
	model("openrouter", "qwen/qwen3-coder:exacto"),
	model("openrouter", "moonshotai/kimi-k2"),
	model("openai", "shared-model"),
	model("openrouter", "shared-model"),
];

function runtime(authenticated: readonly string[] = ["anthropic", "openai", "openrouter"]) {
	return fakeModelRuntime({
		getModels: () => CATALOG,
		getAvailableSnapshot: () => CATALOG.filter((entry) => authenticated.includes(entry.provider)),
		getModel: (provider, id) => CATALOG.find((entry) => entry.provider === provider && entry.id === id),
		hasConfiguredAuth: (provider) => authenticated.includes(provider),
	});
}

function label(resolved: { model?: Model<Api>; thinkingLevel?: string } | undefined): string | undefined {
	if (!resolved?.model) return undefined;
	return `${resolved.model.provider}/${resolved.model.id}:${resolved.thinkingLevel ?? ""}`;
}

describe("fallbackModels resolution (#4902)", () => {
	const references = [
		"Anthropic/Claude-Sonnet-4-5",
		"ANTHROPIC/claude-sonnet-4-5:high",
		"claude-sonnet-4-5:low",
		"qwen/qwen3-coder:exacto",
		"moonshotai/kimi-k2:medium",
		"openrouter/qwen/qwen3-coder:exacto",
		"OpenAI/GPT-4o",
	];
	for (const reference of references) {
		test(`"${reference}" resolves as a fallback exactly as it does for --model (#4902)`, () => {
			const modelRuntime = runtime();
			const cli = resolveCliModel({ cliModel: reference, modelRuntime });
			assert.equal(cli.error, undefined);
			assert.ok(cli.model, "the --model reference resolves");

			assert.equal(label(resolveFallbackModel(reference, modelRuntime, undefined)), label(cli));
		});
	}

	test("an invalid thinking suffix does not resolve to the model without it (#4902)", () => {
		assert.equal(resolveFallbackModel("anthropic/claude-sonnet-4-5:bogus", runtime(), undefined), undefined);
	});

	test("a bare id several authenticated providers serve picks the preferred provider (#4902)", () => {
		assert.equal(label(resolveFallbackModel("shared-model", runtime(), "openrouter")), "openrouter/shared-model:");
		assert.equal(resolveFallbackModel("shared-model", runtime(), undefined), undefined);
		assert.equal(resolveFallbackModel("shared-model", runtime(), "anthropic"), undefined);
	});

	test("the startup check prefers the default provider for an ambiguous bare id (#4902)", () => {
		const settingsManager = SettingsManager.inMemory({ defaultProvider: "openai", fallbackModels: ["shared-model"] });

		const { diagnostics } = buildSessionOptions(parseArgs([]), [], false, runtime(), settingsManager);

		assert.deepEqual(diagnostics, []);
	});

	test("a fallback on a provider without credentials stays unusable (#4902)", () => {
		assert.equal(resolveFallbackModel("openai/gpt-4o", runtime(["anthropic"]), undefined), undefined);
	});

	test("an unresolvable fallback entry is warned about once at startup (#4902)", () => {
		const settingsManager = SettingsManager.inMemory({
			fallbackModels: ["nowhere/no-model", "openai/gpt-4o", "nowhere/no-model"],
		});

		const { diagnostics } = buildSessionOptions(parseArgs([]), [], false, runtime(), settingsManager);

		assert.deepEqual(diagnostics, [
			{
				type: "warning",
				message:
					'fallbackModels setting entry "nowhere/no-model" does not match a model with configured credentials, so model fallback skips it. Use --list-models to see available models.',
			},
		]);
	});

	test("--fallback-models entries are checked in place of the setting (#4902)", () => {
		const settingsManager = SettingsManager.inMemory({ fallbackModels: ["nowhere/no-model"] });

		const { diagnostics } = buildSessionOptions(
			parseArgs(["--fallback-models", "openai/gpt-4o,ghost/model"]),
			[],
			false,
			runtime(),
			settingsManager,
		);

		assert.equal(diagnostics.length, 1);
		assert.match(diagnostics[0]?.message ?? "", /"ghost\/model"/);
		assert.match(diagnostics[0]?.message ?? "", /--fallback-models/);
	});

	test("resolvable fallback entries produce no warning (#4902)", () => {
		const settingsManager = SettingsManager.inMemory({
			fallbackModels: ["Anthropic/Claude-Sonnet-4-5", "qwen/qwen3-coder:exacto"],
		});

		const { diagnostics } = buildSessionOptions(parseArgs([]), [], false, runtime(), settingsManager);

		assert.deepEqual(diagnostics, []);
	});
});
