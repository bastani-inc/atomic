import type { OpenAICompletionsCompat } from "@bastani/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { describeModelRegistry } from "./model-registry-fixtures.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describeModelRegistry((context) => {
	const { builtinOpenRouterModels, getModelsForProvider, writeRawModelsJson } = context;
	describe("modelOverrides (per-model customization)", () => {
		test("explicit Sol subscription context overrides win for normal, Fast and Ultrafast models", async () => {
			writeRawModelsJson({ openai: { modelOverrides: { "gpt-6.1-sol": { contextWindow: 400_000 } } } });
			await context.authStorage.modify("openai", async () => ({
				type: "oauth",
				access: "fake",
				refresh: "fake",
				expires: Date.now() + 3_600_000,
			}));
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			for (const suffix of ["", "-fast", "-ultrafast"]) {
				const id = `gpt-6.1-sol${suffix}`;
				expect(registry.find("openai", id)?.contextWindow).toBe(400_000);
				expect(
					(await registry.getAvailable()).find((model) => model.provider === "openai" && model.id === id)
						?.contextWindow,
				).toBe(400_000);
			}
		});

		test("model override applies to a single built-in model", async () => {
			const [builtin, other] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							name: "Custom Model Name",
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const overridden = models.find((m) => m.id === builtin.id);
			expect(overridden?.name).toBe("Custom Model Name");

			// Other models should be unchanged
			const untouched = models.find((m) => m.id === other.id);
			expect(untouched?.name).toBe(other.name);
		});

		test("model override deep-merges image resize limits (#9631)", async () => {
			writeRawModelsJson({
				test: {
					baseUrl: "https://example.com",
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "vision-model",
							input: ["text", "image"],
							inputLimits: {
								maxRequestBytes: 32 * 1024 * 1024,
								images: {
									maxPerRequest: 100,
									resize: {
										maxWidth: 2000,
										maxHeight: 2000,
										maxBytes: 4.5 * 1024 * 1024,
										jpegQuality: 80,
									},
								},
							},
						},
					],
					modelOverrides: {
						"vision-model": {
							inputLimits: {
								images: { resize: { maxWidth: 1568, maxBytes: 524288, jpegQuality: 75 } },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const model = registry.find("test", "vision-model");

			expect(registry.getError()).toBeUndefined();
			expect(model?.inputLimits).toMatchObject({
				maxRequestBytes: 32 * 1024 * 1024,
				images: {
					maxPerRequest: 100,
					resize: { maxWidth: 1568, maxHeight: 2000, maxBytes: 524288, jpegQuality: 75 },
				},
			});
		});

		test("model override with compat.openRouterRouting", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const overridden = models.find((m) => m.id === builtin.id);
			const compat = overridden?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const overridden = models.find((m) => m.id === builtin.id);

			// Should have both the new routing AND preserve other compat settings
			const compat = overridden?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("model override deep merges chatTemplateKwargs", async () => {
			const [builtin] = await builtinOpenRouterModels();
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
						[builtin.id]: {
							compat: {
								chatTemplateKwargs: { effort: { $var: "thinking.effort", omitWhenOff: true } },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const overridden = getModelsForProvider(registry, "openrouter").find((m) => m.id === builtin.id);
			const compat = overridden?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.chatTemplateKwargs).toEqual({
				preserve_thinking: true,
				thinking: { $var: "thinking.enabled" },
				effort: { $var: "thinking.effort", omitWhenOff: true },
			});
		});

		test("model override deep merges chatTemplateArgs", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					compat: {
						thinkingFormat: "baseten",
						chatTemplateArgs: {
							enable_thinking: { $var: "thinking.enabled" },
							preserve_thinking: true,
						},
					},
					modelOverrides: {
						[builtin.id]: {
							compat: {
								chatTemplateArgs: { effort: { $var: "thinking.effort", omitWhenOff: true } },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const overridden = getModelsForProvider(registry, "openrouter").find((m) => m.id === builtin.id);
			const compat = overridden?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.chatTemplateArgs).toEqual({
				enable_thinking: { $var: "thinking.enabled" },
				preserve_thinking: true,
				effort: { $var: "thinking.effort", omitWhenOff: true },
			});
		});

		test("multiple model overrides on same provider", async () => {
			const [builtin, other] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						[other.id]: {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const first = models.find((m) => m.id === builtin.id);
			const second = models.find((m) => m.id === other.id);

			const firstCompat = first?.compat as OpenAICompletionsCompat | undefined;
			const secondCompat = second?.compat as OpenAICompletionsCompat | undefined;
			expect(firstCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(secondCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});

		test("model override combined with baseUrl override", async () => {
			const [builtin, other] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					baseUrl: "https://my-proxy.example.com/v1",
					modelOverrides: {
						[builtin.id]: {
							name: "Proxied Model",
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const overridden = models.find((m) => m.id === builtin.id);

			// Both overrides should apply
			expect(overridden?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(overridden?.name).toBe("Proxied Model");

			// Other models should have the baseUrl but not the name override
			const untouched = models.find((m) => m.id === other.id);
			expect(untouched?.baseUrl).toBe("https://my-proxy.example.com/v1");
			expect(untouched?.name).toBe(other.name);
		});

		test("model override for non-existent model ID is ignored", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"nonexistent/model-id": {
							name: "This should not appear",
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			// Should not create a new model
			expect(models.find((m) => m.id === "nonexistent/model-id")).toBeUndefined();
			// Should not crash or show error
			expect(registry.getError()).toBeUndefined();
		});

		test("model override can change cost fields partially", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							cost: { input: 99 },
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const overridden = models.find((m) => m.id === builtin.id);

			// Input cost should be overridden
			expect(overridden?.cost.input).toBe(99);
			// Other cost fields should be preserved from built-in
			expect(overridden?.cost.output).toBe(builtin.cost.output);
			expect(overridden?.cost.cacheRead).toBe(builtin.cost.cacheRead);
			expect(overridden?.cost.cacheWrite).toBe(builtin.cost.cacheWrite);
		});

		test("model override can add headers at request time", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							headers: { "X-Custom-Model-Header": "value" },
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const overridden = models.find((m) => m.id === builtin.id);
			expect(overridden).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(overridden!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-Custom-Model-Header"]).toBe("value");
			}
		});

		test("refresh() picks up model override changes", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							name: "First Name",
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			expect(getModelsForProvider(registry, "openrouter").find((m) => m.id === builtin.id)?.name).toBe("First Name");

			// Update and refresh
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							name: "Second Name",
						},
					},
				},
			});
			await registry.refresh();

			expect(getModelsForProvider(registry, "openrouter").find((m) => m.id === builtin.id)?.name).toBe(
				"Second Name",
			);
		});

		test("removing model override restores built-in values", async () => {
			const [builtin] = await builtinOpenRouterModels();
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						[builtin.id]: {
							name: "Custom Name",
						},
					},
				},
			});

			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
			const customName = getModelsForProvider(registry, "openrouter").find((m) => m.id === builtin.id)?.name;
			expect(customName).toBe("Custom Name");

			// Remove override and refresh
			writeRawModelsJson({});
			await registry.refresh();

			const restoredName = getModelsForProvider(registry, "openrouter").find((m) => m.id === builtin.id)?.name;
			expect(restoredName).toBe(builtin.name);
		});
	});
});
