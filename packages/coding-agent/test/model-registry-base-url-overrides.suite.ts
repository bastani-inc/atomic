import { describe, expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";

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
	describe("baseUrl override (no custom models)", () => {
		test("overriding baseUrl keeps all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// Should have multiple built-in models, not just one
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels.some((m) => m.id.includes("claude"))).toBe(true);
		});

		test("overriding baseUrl changes URL on all built-in models", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			// All models should have the new baseUrl
			for (const model of anthropicModels) {
				expect(model.baseUrl).toBe("https://my-proxy.example.com/v1");
			}
		});

		test("overriding headers resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1", {
					"X-Custom-Header": "custom-value",
				}),
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("headers-only override resolves at request time", async () => {
			writeRawModelsJson({
				anthropic: {
					headers: {
						"X-Custom-Header": "custom-value",
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(registry.getError()).toBeUndefined();
			const anthropicModels = getModelsForProvider(registry, "anthropic");

			for (const model of anthropicModels) {
				const auth = await registry.getApiKeyAndHeaders(model);
				expect(auth.ok).toBe(true);
				if (auth.ok) {
					expect(auth.headers?.["X-Custom-Header"]).toBe("custom-value");
				}
			}
		});

		test("adds GitHub Copilot API version header only for github-copilot requests", async () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const copilotModel = registry.find("github-copilot", "gpt-5.5");
			expect(copilotModel).toBeDefined();

			const copilotAuth = await registry.getApiKeyAndHeaders(copilotModel!);
			expect(copilotAuth.ok).toBe(true);
			if (copilotAuth.ok) {
				expect(copilotAuth.headers?.["X-GitHub-Api-Version"]).toBe("2026-06-01");
			}

			const openAiAuth = await registry.getApiKeyAndHeaders(openAiModel);
			expect(openAiAuth.ok).toBe(true);
			if (openAiAuth.ok) {
				expect(openAiAuth.headers?.["X-GitHub-Api-Version"]).toBeUndefined();
			}
		});

		test("routes GitHub Copilot env auth through the public hub by default", () => {
			const previous = process.env.COPILOT_GITHUB_TOKEN;
			process.env.COPILOT_GITHUB_TOKEN = "github_pat_enterprise";
			try {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const copilotModels = getModelsForProvider(registry, "github-copilot");

				expect(copilotModels.length).toBeGreaterThan(0);
				for (const model of copilotModels) {
					expect(model.baseUrl).toBe("https://api.githubcopilot.com");
				}
			} finally {
				if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
				else process.env.COPILOT_GITHUB_TOKEN = previous;
			}
		});

		test("models.json baseUrl override wins over GitHub Copilot env routing", () => {
			const previous = process.env.COPILOT_GITHUB_TOKEN;
			process.env.COPILOT_GITHUB_TOKEN = "github_pat_enterprise";
			try {
				writeRawModelsJson({
					"github-copilot": overrideConfig("https://copilot-proxy.example.com"),
				});
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const model = registry.find("github-copilot", "gpt-5.5");

				expect(model?.baseUrl).toBe("https://copilot-proxy.example.com");
			} finally {
				if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
				else process.env.COPILOT_GITHUB_TOKEN = previous;
			}
		});

		test("preserves explicit GitHub Copilot API version provider header override", async () => {
			writeRawModelsJson({
				"github-copilot": {
					headers: {
						"x-github-api-version": "custom-version",
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-5.5");
			expect(model).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(model!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["x-github-api-version"]).toBe("custom-version");
				expect(auth.headers?.["X-GitHub-Api-Version"]).toBeUndefined();
			}
		});

		test("preserves explicit GitHub Copilot API version model header override", async () => {
			writeRawModelsJson({
				"github-copilot": {
					modelOverrides: {
						"gpt-5.5": {
							headers: {
								"X-GitHub-Api-Version": "model-version",
							},
						},
					},
				},
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const model = registry.find("github-copilot", "gpt-5.5");
			expect(model).toBeDefined();

			const auth = await registry.getApiKeyAndHeaders(model!);
			expect(auth.ok).toBe(true);
			if (auth.ok) {
				expect(auth.headers?.["X-GitHub-Api-Version"]).toBe("model-version");
			}
		});

		test("baseUrl-only override does not affect other providers", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://my-proxy.example.com/v1"),
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const googleModels = getModelsForProvider(registry, "google");

			// Google models should still have their original baseUrl
			expect(googleModels.length).toBeGreaterThan(0);
			expect(googleModels[0].baseUrl).not.toBe("https://my-proxy.example.com/v1");
		});

		test("can mix baseUrl override and models merge", () => {
			writeRawModelsJson({
				// baseUrl-only for anthropic
				anthropic: overrideConfig("https://anthropic-proxy.example.com/v1"),
				// Add custom model for google (merged with built-ins)
				google: providerConfig(
					"https://google-proxy.example.com/v1",
					[{ id: "gemini-custom" }],
					"google-generative-ai",
				),
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			// Anthropic: multiple built-in models with new baseUrl
			const anthropicModels = getModelsForProvider(registry, "anthropic");
			expect(anthropicModels.length).toBeGreaterThan(1);
			expect(anthropicModels[0].baseUrl).toBe("https://anthropic-proxy.example.com/v1");

			// Google: built-ins plus custom model
			const googleModels = getModelsForProvider(registry, "google");
			expect(googleModels.length).toBeGreaterThan(1);
			expect(googleModels.some((m) => m.id === "gemini-custom")).toBe(true);
		});

		test("refresh() picks up baseUrl override changes", () => {
			writeRawModelsJson({
				anthropic: overrideConfig("https://first-proxy.example.com/v1"),
			});
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://first-proxy.example.com/v1");

			// Update and refresh
			writeRawModelsJson({
				anthropic: overrideConfig("https://second-proxy.example.com/v1"),
			});
			registry.refresh();

			expect(getModelsForProvider(registry, "anthropic")[0].baseUrl).toBe("https://second-proxy.example.com/v1");
		});
	});

});
