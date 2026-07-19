import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { getOAuthProvider } from "../src/core/oauth-provider-bridge.ts";
import { describe, expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";


describeModelRegistry((context) => {
	const { providerConfig, getModelsForProvider, writeRawModelsJson, openAiModel, emptyContext } = context;
	describe("dynamic provider lifecycle", () => {
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

		test("failed registerProvider does not persist invalid streamSimple config", async () => {
			const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			await expect(registry.refresh()).resolves.toBeDefined();
		});

		test("failed registerProvider does not remove existing provider models", async () => {
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
			await expect(registry.refresh()).resolves.toBeDefined();
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
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
			test("baseUrl-only override keeps built-in provider models after refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				await registry.refresh();

				const anthropicModels = getModelsForProvider(registry, "anthropic");
				expect(anthropicModels.length).toBeGreaterThan(1);
				expect(anthropicModels.every((m) => m.baseUrl === "https://proxy.test/anthropic")).toBe(true);
			});

			test("models-only override replaces built-in provider models after refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				await registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://custom.test/anthropic");
			});

			test("models plus baseUrl override replaces built-in provider models after refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				await registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://proxy.test/anthropic");
			});

			test("models-only custom provider registration survives refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				await registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
			});

			test("baseUrl-only override keeps custom provider models after refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { baseUrl: "https://proxy.test/custom" });
				await registry.refresh();

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
				await registry.refresh();

				const models = getModelsForProvider(registry, "custom-provider");
				expect(models.map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(models.every((m) => m.baseUrl === "https://custom.test/v1")).toBe(true);
				expect(await registry.getApiKeyAndHeaders(models[0])).toMatchObject({
					ok: true,
					headers: { "x-proxy": "enabled" },
				});
			});

			test("async catalog refresh publishes successful results only after completion", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });

				const refresh = registry.refresh();
				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["old"]);
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "new" }]).models!);
				const result = await refresh;

				expect(result.aborted).toBe(false);
				expect(result.errors.size).toBe(0);
				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["new"]);
			});

			test("unrelated registration does not discard an in-flight provider refresh", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });
				const refresh = registry.refresh();

				registry.registerProvider("anthropic", { headers: { "x-unrelated": "yes" } });
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "new" }]).models!);
				const result = await refresh;

				expect(result.aborted).toBe(false);
				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["new"]);
			});


			test("async catalog refresh returns partial provider errors without discarding successes", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const good = providerConfig("https://good.test/v1", [{ id: "old-good" }]);
				const bad = providerConfig("https://bad.test/v1", [{ id: "old-bad" }]);
				registry.registerProvider("good", {
					...good,
					refreshModels: async () => providerConfig("https://good.test/v1", [{ id: "new-good" }]).models!,
				});
				registry.registerProvider("bad", { ...bad, refreshModels: async () => { throw new Error("catalog failed"); } });

				const result = await registry.refresh();

				expect(result.errors.get("bad")?.message).toBe("catalog failed");
				expect(getModelsForProvider(registry, "good").map((model) => model.id)).toEqual(["new-good"]);
				expect(getModelsForProvider(registry, "bad").map((model) => model.id)).toEqual(["old-bad"]);
			});

			test("stale refresh completion cannot resurrect an unregistered provider", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });
				const staleRefresh = registry.refresh();

				registry.unregisterProvider("dynamic");
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "resurrected" }]).models!);
				await staleRefresh;

				expect(registry.find("dynamic", "resurrected")).toBeUndefined();
			});

			test("stale refresh completion cannot overwrite a re-registered provider", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });
				const staleRefresh = registry.refresh();

				registry.registerProvider("dynamic", {
					...providerConfig("https://manual.test/v1", [{ id: "manual" }]),
					refreshModels: async () => providerConfig("https://manual.test/v1", [{ id: "manual" }]).models!,
				});
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "stale" }]).models!);
				await staleRefresh;

				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["manual"]);
			});

			test("async catalog refresh times out and retains the stale snapshot", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://slow.test/v1", [{ id: "cached" }]);
				registry.registerProvider("slow", {
					...initial,
					refreshModels: async () => new Promise<NonNullable<typeof initial.models>>(() => {}),
				});

				const result = await registry.refresh({ timeoutMs: 5 });

				expect(result.aborted).toBe(true);
				expect(getModelsForProvider(registry, "slow").map((model) => model.id)).toEqual(["cached"]);
			});

			test("pre-aborted refresh returns without invoking providers", async () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://slow.test/v1", [{ id: "cached" }]);
				let called = false;
				registry.registerProvider("slow", {
					...initial,
					refreshModels: async () => {
						called = true;
						return initial.models!;
					},
				});
				const controller = new AbortController();
				controller.abort();

				const result = await registry.refresh({ signal: controller.signal, timeoutMs: 100 });

				expect(result.aborted).toBe(true);
				expect(called).toBe(false);
				expect(registry.find("slow", "cached")).toBeDefined();
			});

			test("additive provider overrides retain built-in credential filtering", () => {
				const registry = ModelRegistry.create(context.authStorage, context.modelsJsonPath);
				const allowed = registry.getAll().find((model) => model.provider === "github-copilot")!;
				context.authStorage.set("github-copilot", {
					type: "oauth",
					refresh: "r",
					access: "a",
					expires: Date.now() + 60_000,
					availableModelIds: [allowed.id],
				});
				const availableIds = () => registry.getAvailable()
					.filter((model) => model.provider === "github-copilot")
					.map((model) => model.id);
				expect(availableIds()).toEqual([allowed.id]);

				registry.registerProvider("github-copilot", { headers: { "x-test": "1" } });

				expect(availableIds()).toEqual([allowed.id]);
			});
		});
	});

});
