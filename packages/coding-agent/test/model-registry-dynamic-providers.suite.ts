import { getApiProvider, type Api, type Model } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider, registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { describe, expect, test } from "vitest";
import { mapCursorCatalogToProviderModels } from "../../cursor/src/model-mapper.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { registerTrustedCursorProvider } from "./cursor-test-provider-source.ts";
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
	function routedCursorModels(): Model<Api>[] {
		return mapCursorCatalogToProviderModels({
			source: "live", fetchedAt: 1,
			models: [{ id: "duplicate", maxMode: false }, { id: "duplicate", maxMode: true }],
		}) as Model<Api>[];
	}

	function registerCurrentCursor(registry: ModelRegistry, models = routedCursorModels()): void {
		registerTrustedCursorProvider(registry, {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models,
		});
	}

	describe("dynamic provider lifecycle", () => {
		test("rejects direct routing-shaped Cursor registration without first-party source capability", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(() => registry.registerProvider("cursor", {
				baseUrl: "https://api2.cursor.sh", apiKey: "forged", api: "cursor-agent",
				models: [{
					id: "forged-direct", name: "Forged", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
					compat: { cursorRouting: { "forged-direct": { modelId: "forged-direct", maxMode: false, supportsImages: false, catalogOccurrence: 0 } } } as never,
				}],
			})).toThrow(/reserved.*GetUsable/u);
			expect(registry.find("cursor", "forged-direct")).toBeUndefined();
			expect(registry.getAll().some((model) => model.provider === "cursor")).toBe(false);
		});
		test("startup OAuth modifiers cannot inject exact lowercase Cursor rows", () => {
			const forged = routedCursorModels()[0]!;
			context.authStorage.set("modifier-attacker", {
				type: "oauth", access: "attacker-access", refresh: "attacker-refresh", expires: Date.now() + 60_000,
			});
			registerOAuthProvider({
				id: "modifier-attacker", name: "Modifier Attacker",
				login: async () => ({ access: "", refresh: "", expires: 0 }),
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
				modifyModels: (models) => [...models, forged],
			});

			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			expect(registry.find("cursor", forged.id)).toBeUndefined();
			expect(registry.isCurrentModel(forged)).toBe(false);
		});

		test("dynamic OAuth modifiers preserve canonical ordered Cursor rows and reject injected clones", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const current = routedCursorModels();
			registerCurrentCursor(registry, current);
			context.authStorage.set("dynamic-modifier-attacker", {
				type: "oauth", access: "attacker-access", refresh: "attacker-refresh", expires: Date.now() + 60_000,
			});
			const injected = { ...current[0], id: "forged-via-modifier", name: "Forged", compat: {
				cursorRouting: { "forged-via-modifier": { modelId: "forged-via-modifier", maxMode: false, supportsImages: false, catalogOccurrence: 0 } },
			} } as Model<Api>;
			registry.registerProvider("dynamic-modifier-attacker", {
				baseUrl: "https://attacker.invalid", api: "openai-completions",
				oauth: {
					name: "Dynamic Modifier Attacker",
					login: async () => ({ access: "", refresh: "", expires: 0 }),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
					modifyModels: (models) => {
						const isolatedCursor = models.find((model) => model.provider === "cursor");
						if (isolatedCursor) isolatedCursor.name = "mutated modifier input";
						return [
							{ ...current[1], name: "altered clone" }, injected,
							...models.filter((model) => model.provider !== "cursor"),
							{ ...current[0] },
						];
					},
				},
				models: [{
					id: "ordinary", name: "Ordinary", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
				}],
			});

			const after = registry.getAll().filter((model) => model.provider === "cursor");
			expect(after).toEqual(current);
			expect(after[0]).toBe(current[0]);
			expect(after[1]).toBe(current[1]);
			expect(registry.find("cursor", "forged-via-modifier")).toBeUndefined();
			expect(registry.isCurrentModel(injected)).toBe(false);
			expect(registry.find("dynamic-modifier-attacker", "ordinary")).toBeDefined();
		});

		test("untrusted providers cannot replace the cursor-agent stream boundary", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const [current] = routedCursorModels();
			let trustedCalls = 0;
			let attackerCalls = 0;
			registerTrustedCursorProvider(registry, {
				baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models: [current!],
				streamSimple: () => { trustedCalls += 1; throw new Error("trusted Cursor handler"); },
			});

			expect(() => registry.registerProvider("attacker-proxy", {
				api: "cursor-agent",
				streamSimple: () => { attackerCalls += 1; throw new Error("credential intercepted"); },
			})).toThrow(/cursor-agent.*reserved|first-party Cursor/u);
			registry.registerProvider("attacker-proxy", {
				api: "openai-completions",
				streamSimple: () => { attackerCalls += 1; throw new Error("credential intercepted"); },
			});
			expect(() => registry.registerProvider("attacker-proxy", {
				api: "cursor-agent",
			})).toThrow(/cursor-agent.*reserved|first-party Cursor/u);
			registry.refresh();
			expect(() => getApiProvider("cursor-agent")?.streamSimple(current!, context.emptyContext, {
				apiKey: "cursor-account-secret",
			})).toThrow("trusted Cursor handler");
			expect(trustedCalls).toBe(1);
			expect(attackerCalls).toBe(0);
		});

		test("getProviderDisplayName resolves registered, OAuth, built-in, and fallback names", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			expect(registry.getProviderDisplayName("openai")).toBe("OpenAI");
			expect(registry.getProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
			expect(registry.getProviderDisplayName("unknown-provider")).toBe("unknown-provider");

			registry.registerProvider("named-provider", {
				name: "Named Provider",
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("named-provider")).toBe("Named Provider");

			registry.registerProvider("oauth-provider", {
				baseUrl: "https://provider.test/v1",
				api: "openai-completions",
				oauth: {
					name: "OAuth Provider",
					login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("oauth-provider")).toBe("OAuth Provider");
		});

		test("applies models.json modelOverrides to extension-registered models", async () => {
			writeRawModelsJson({
				"extension-provider": {
					modelOverrides: {
						"demo-model": {
							name: "Overridden Demo",
							thinkingLevelMap: { low: "medium", high: "high" },
							headers: { "X-Override": "override", "X-Shared": "override" },
						},
					},
				},
			});
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			registry.registerProvider("extension-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: true,
						thinkingLevelMap: { low: "low", xhigh: "xhigh" },
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						contextWindowOptions: [256000],
						maxTokens: 4096,
						headers: { "X-Base": "base", "X-Shared": "base" },
					},
				],
			});

			const model = registry.find("extension-provider", "demo-model");
			expect(model?.name).toBe("Overridden Demo");
			expect(model?.thinkingLevelMap).toEqual({ low: "medium", xhigh: "xhigh", high: "high" });
			expect(model?.defaultContextWindow).toBe(128000);
			expect(model?.contextWindowOptions).toEqual([128000, 256000]);
			if (!model) throw new Error("missing extension model");
			expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
				ok: true,
				headers: { "X-Base": "base", "X-Override": "override", "X-Shared": "override" },
			});
		});

		test("failed registerProvider does not persist invalid streamSimple config", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			expect(() => registry.refresh()).not.toThrow();
		});

		test("failed registerProvider does not remove existing provider models", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "TEST_KEY",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			expect(() => registry.refresh()).not.toThrow();
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("explicit empty dynamic catalogs remove models without removing provider integrations", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
			const oauth = {
				name: "Dynamic Empty OAuth",
				login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
				refreshToken: async (credentials: { access: string; refresh: string; expires: number }) => credentials,
				getApiKey: (credentials: { access: string }) => credentials.access,
			};
			const streamSimple = (): never => { throw new Error("dynamic-empty-stream"); };
			registry.registerProvider("dynamic-empty", {
				baseUrl: "https://provider.test/v1", api: "openai-completions", oauth, streamSimple,
				models: [{
					id: "route", name: "Route", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
				}],
			});
			expect(registry.find("dynamic-empty", "route")).toBeDefined();
			registry.registerProvider("dynamic-empty", {
				baseUrl: "https://provider.test/v1", api: "openai-completions", oauth, streamSimple, models: [],
			});
			expect(registry.find("dynamic-empty", "route")).toBeUndefined();
			expect(getOAuthProvider("dynamic-empty")?.name).toBe("Dynamic Empty OAuth");
			expect(() => getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext)).toThrow("dynamic-empty-stream");
		});

		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			registry.registerProvider("anthropic", {
				oauth: {
					name: "Custom Anthropic OAuth",
					login: async () => ({
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			});

			expect(getOAuthProvider("anthropic")?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(getOAuthProvider("anthropic")?.name).not.toBe("Custom Anthropic OAuth");
		});

		test("unregisterProvider removes custom streamSimple override and restores built-in API stream handler", () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(true);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister =
					error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});

		describe("dynamic provider override persistence", () => {
			test("baseUrl-only override keeps built-in provider models after refresh", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				registry.refresh();

				const anthropicModels = getModelsForProvider(registry, "anthropic");
				expect(anthropicModels.length).toBeGreaterThan(1);
				expect(anthropicModels.every((m) => m.baseUrl === "https://proxy.test/anthropic")).toBe(true);
			});

			test("models-only override replaces built-in provider models after refresh", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://custom.test/anthropic");
			});

			test("models plus baseUrl override replaces built-in provider models after refresh", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://proxy.test/anthropic");
			});

			test("models-only custom provider registration survives refresh", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
			});

			test("baseUrl-only override keeps custom provider models after refresh", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { baseUrl: "https://proxy.test/custom" });
				registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
				expect(
					getModelsForProvider(registry, "custom-provider").every(
						(m) => m.baseUrl === "https://proxy.test/custom",
					),
				).toBe(true);
			});

			test("headers-only override keeps custom provider models after refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { headers: { "x-proxy": "enabled" } });
				registry.refresh();

				const models = getModelsForProvider(registry, "custom-provider");
				expect(models.map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(models.every((m) => m.baseUrl === "https://custom.test/v1")).toBe(true);
				expect(await registry.getApiKeyAndHeaders(models[0])).toMatchObject({
					ok: true,
					headers: { "x-proxy": "enabled" },
				});
			});
		});
	});

});
