import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { getSupportedContextWindows } from "../src/core/context-window.ts";
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
	describe("modelOverrides (per-model customization)", () => {
		test("model override applies to a single built-in model", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Sonnet Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet?.name).toBe("Custom Sonnet Name");

			// Other models should be unchanged
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");
			expect(opus?.name).not.toBe("Custom Sonnet Name");
		});

		test("model override with compat.openRouterRouting", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Should have both the new routing AND preserve other compat settings
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("model override deep merges chatTemplateKwargs", () => {
			writeRawModelsJson({
				openrouter: {
					compat: {
						thinkingFormat: "chat-template",
						chatTemplateKwargs: {
							preserve_thinking: true,
							thinking: { $var: "thinking.enabled" },
						},
					},
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: {
								chatTemplateKwargs: { effort: { $var: "thinking.effort", omitWhenOff: true } },
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const sonnet = getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.chatTemplateKwargs).toEqual({
				preserve_thinking: true,
				thinking: { $var: "thinking.enabled" },
				effort: { $var: "thinking.effort", omitWhenOff: true },
			});
		});

		test("multiple model overrides on same provider", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", () => {
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Proxied Sonnet",
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Both overrides should apply
			expect(sonnet?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(sonnet?.name).toBe("Proxied Sonnet");

			// Other models should have the baseUrl but not the name override
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4");
			expect(opus?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(opus?.name).not.toBe("Proxied Sonnet");
		});

		test("model override for non-existent model ID is ignored", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("scalar contextWindow override clears inherited contextWindowOptions", () => {
			writeRawModelsJson({
				"github-copilot": {
					modelOverrides: {
						"gpt-5.5": {
							contextWindow: 128_000,
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-5.5");

			expect(model?.contextWindow).toBe(128_000);
			expect(model?.defaultContextWindow).toBe(128_000);
			expect(model?.contextWindowOptions).toBeUndefined();
			expect(model ? getSupportedContextWindows(model) : []).toEqual([128_000]);
		});

		test("explicit contextWindowOptions override is honored with scalar contextWindow override", () => {
			writeRawModelsJson({
				"github-copilot": {
					modelOverrides: {
						"gpt-5.5": {
							contextWindow: 128_000,
							contextWindowOptions: [1_000_000, 256_000],
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-5.5");

			expect(model?.contextWindow).toBe(128_000);
			expect(model?.defaultContextWindow).toBe(128_000);
			expect(model?.contextWindowOptions).toEqual([256_000, 1_000_000]);
			expect(model ? getSupportedContextWindows(model) : []).toEqual([128_000, 256_000, 1_000_000]);
		});

		test("model override can change cost fields partially", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");

			// Input cost should be overridden
			expect(sonnet?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(sonnet?.cost.output).toBeGreaterThan(0);
		});

		test("model override can add headers at request time", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4");
			expect(sonnet).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(sonnet!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-Custom-Model-Header"]).toBe("value");
			}
		});

		test("refresh() picks up model override changes", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "First Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Second Name",
						},
					},
				},
			});
			registry.refresh();

			expect(
				getModelsForProvider(registry, "openrouter").find((m) => m.id === "anthropic/claude-sonnet-4")?.name,
			).toBe("Second Name");
		});

		test("removing model override restores built-in values", () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4": {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			registry.refresh();

			const restoredName = getModelsForProvider(registry, "openrouter").find(
				(m) => m.id === "anthropic/claude-sonnet-4",
			)?.name;
			expect(restoredName).not.toBe("Custom Name");
		});
	});

});
