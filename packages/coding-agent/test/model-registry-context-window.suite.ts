import { afterEach, describe, expect, test } from "vitest";
import { getSupportedContextWindows, selectContextWindow } from "../src/core/context-window.ts";
import {
	clearActiveCopilotModelCatalog,
	copilotCatalogCachePath,
	setActiveCopilotModelCatalog,
	writeCopilotCatalogCache,
} from "../src/core/copilot-model-catalog.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";


describeModelRegistry((context) => {
	const {
		providerConfig,
		writeModelsJson,
		getModelsForProvider,
		toShPath,
		overrideConfig,
		writeRawModelsJson,
		openAiModel,
		emptyContext,
	} = context;
	describe("context window options", () => {
		// The live CAPI catalog (only populated when the user has the GitHub Copilot provider) drives
		// which Copilot models expose a selectable long-context window. Seed it like a successful fetch.
		const copilotCatalog = new Map([
			["gpt-5.5", { contextWindow: 272_000, contextWindowOptions: [272_000, 1_050_000], maxInputTokens: 922_000, maxTokens: 128_000 }],
			["claude-opus-4.8", { contextWindow: 200_000, contextWindowOptions: [200_000, 1_000_000], maxInputTokens: 936_000, maxTokens: 128_000 }],
			["gemini-3.1-pro-preview", { contextWindow: 200_000, contextWindowOptions: [200_000, 1_000_000], maxInputTokens: 936_000, maxTokens: 64_000 }],
			["gpt-4.1", { contextWindow: 200_000 }],
		]);

		afterEach(() => clearActiveCopilotModelCatalog());

		test("derives selectable input-token windows from the active Copilot catalog", () => {
			setActiveCopilotModelCatalog(copilotCatalog);
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			// gpt-5.5: 272k default / 1.05M long (full context window); 922k prompt cap carried internally.
			const gpt55 = registry.find("github-copilot", "gpt-5.5");
			expect(gpt55?.contextWindow).toBe(272_000);
			expect(gpt55?.defaultContextWindow).toBe(272_000);
			expect(gpt55?.contextWindowOptions).toEqual([272_000, 1_050_000]);
			expect(gpt55?.maxInputTokens).toBe(922_000);
			expect(gpt55?.maxTokens).toBe(128_000);
			expect(gpt55 ? getSupportedContextWindows(gpt55) : []).toEqual([272_000, 1_050_000]);

			// claude/gemini: 200k default / 1M long; 936k prompt cap carried internally.
			const claude = registry.find("github-copilot", "claude-opus-4.8");
			expect(claude?.contextWindow).toBe(200_000);
			expect(claude?.defaultContextWindow).toBe(200_000);
			expect(claude?.contextWindowOptions).toEqual([200_000, 1_000_000]);
			expect(claude?.maxInputTokens).toBe(936_000);
			expect(claude?.maxTokens).toBe(128_000);

			const gemini31 = registry.find("github-copilot", "gemini-3.1-pro-preview");
			expect(gemini31?.contextWindowOptions).toEqual([200_000, 1_000_000]);
			expect(gemini31?.maxInputTokens).toBe(936_000);
			expect(gemini31?.maxTokens).toBe(64_000);
		});

		test("overrides contextWindow (input tokens) without options for single-window catalog models", () => {
			setActiveCopilotModelCatalog(copilotCatalog);
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			// gpt-4.1 has no long_context tier, but its input budget still replaces the scalar window.
			const model = registry.find("github-copilot", "gpt-4.1");
			expect(model?.contextWindow).toBe(200_000);
			expect(model?.contextWindowOptions).toBeUndefined();
			expect(model ? getSupportedContextWindows(model) : []).toEqual([200_000]);
		});

		test("leaves github-copilot models absent from the catalog untouched", () => {
			setActiveCopilotModelCatalog(copilotCatalog);
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			// Models with no catalog entry keep their built-in window and gain no picker.
			for (const id of ["claude-haiku-4.5", "gpt-5-mini"]) {
				const model = registry.find("github-copilot", id);
				expect(model).toBeDefined();
				expect(model?.contextWindowOptions).toBeUndefined();
				expect(model ? getSupportedContextWindows(model) : []).toEqual([model?.contextWindow]);
			}
		});

		test("adds no options when the catalog is empty (no Copilot auth / offline)", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-5.5");
			expect(model).toBeDefined();
			expect(model?.contextWindowOptions).toBeUndefined();
			expect(model ? getSupportedContextWindows(model) : []).toEqual([model?.contextWindow]);
		});

		test("seeds context-window options from the on-disk cache at construction (returning user)", () => {
			// Regression: a persisted long-context selection must be recognized at startup without first
			// running the async catalog fetch — otherwise it warns ("1m is not supported…") and resets.
			context.authStorage.set("github-copilot", {
				type: "oauth",
				access: "tid=x;proxy-ep=proxy.individual.githubcopilot.com",
				refresh: "r",
				expires: Date.now() + 1_000_000,
			});
			writeCopilotCatalogCache(
				copilotCatalogCachePath(context.tempDir),
				"https://api.individual.githubcopilot.com",
				new Map([[
					"claude-opus-4.8",
					{ contextWindow: 200_000, contextWindowOptions: [200_000, 1_000_000], maxInputTokens: 936_000, maxTokens: 128_000 },
				]]),
				1_000,
			);

			// No setActiveCopilotModelCatalog here: the registry constructor must seed it from disk.
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const claude = registry.find("github-copilot", "claude-opus-4.8");
			expect(claude?.contextWindow).toBe(200_000);
			expect(claude?.contextWindowOptions).toEqual([200_000, 1_000_000]);
			expect(claude?.maxInputTokens).toBe(936_000);
			expect(claude?.maxTokens).toBe(128_000);
			// The previously selected long window now validates instead of warning/resetting.
			const selected = claude ? selectContextWindow(claude, 1_000_000) : { error: "missing" };
			expect("error" in selected).toBe(false);
		});

		test("does not apply the catalog to other providers with matching model IDs", () => {
			setActiveCopilotModelCatalog(copilotCatalog);
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("openai-codex", "gpt-5.5");
			if (!model) {
				throw new Error("Missing built-in openai-codex/gpt-5.5 test model");
			}

			expect(model.contextWindowOptions).toBeUndefined();
			expect(getSupportedContextWindows(model)).toEqual([model.contextWindow]);
		});

		test("selecting the long-context window raises the effective context window", () => {
			setActiveCopilotModelCatalog(copilotCatalog);
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-5.5");
			expect(model?.contextWindow).toBe(272_000);

			const selected = model ? selectContextWindow(model, 1_050_000) : { error: "missing model" };
			expect("error" in selected).toBe(false);
			if (!("error" in selected)) {
				expect(selected.model.contextWindow).toBe(1_050_000);
				expect(selected.model.defaultContextWindow).toBe(272_000);
				// The prompt cap rides along so compaction/overflow still respect the real input budget.
				expect(selected.model.maxInputTokens).toBe(922_000);
				expect(selected.model.maxTokens).toBe(128_000);
				expect(getSupportedContextWindows(selected.model)).toEqual([272_000, 1_050_000]);
			}
		});

		test("loads custom contextWindowOptions and preserves scalar contextWindow", () => {
			writeRawModelsJson({
				custom: {
					baseUrl: "https://example.com/v1",
					apiKey: "test-key",
					api: "openai-responses",
					models: [
						{
							id: "selectable-context",
							reasoning: true,
							contextWindow: 128_000,
							contextWindowOptions: [1_000_000],
						},
					],
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("custom", "selectable-context");
			expect(model?.contextWindow).toBe(128_000);
			expect(model ? getSupportedContextWindows(model) : []).toEqual([128_000, 1_000_000]);
		});

		test("loads custom github-copilot contextWindowOptions and preserves scalar contextWindow", () => {
			writeRawModelsJson({
				"github-copilot": {
					models: [
						{
							id: "custom-copilot-long-context",
							reasoning: true,
							contextWindow: 400_000,
							contextWindowOptions: [1_000_000],
						},
					],
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "custom-copilot-long-context");
			expect(model?.contextWindow).toBe(400_000);
			expect(model ? getSupportedContextWindows(model) : []).toEqual([400_000, 1_000_000]);
		});

		test("rejects invalid custom contextWindowOptions", () => {
			writeRawModelsJson({
				custom: {
					baseUrl: "https://example.com/v1",
					apiKey: "test-key",
					api: "openai-responses",
					models: [
						{
							id: "bad-context-option",
							contextWindowOptions: [0],
						},
					],
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(registry.getError()).toContain("invalid contextWindowOptions value");
		});
	});

});
