import { describe, expect, test, vi } from "vitest";
import { describeModelRegistry } from "./model-registry-fixtures.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

describeModelRegistry((context) => {
	const { providerConfig, getModelsForProvider, writeRawModelsJson } = context;
	describe("dynamic provider lifecycle", () => {
		test("getProviderDisplayName resolves registered, OAuth, built-in, and fallback names", async () => {
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

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
							samplingParams: { top_p: 0.5, min_p: 0.1 },
							headers: { "X-Override": "override", "X-Shared": "override" },
						},
					},
				},
			});
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
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
						maxTokens: 4096,
						samplingParams: { top_p: 0.9, top_k: 40 },
						headers: { "X-Base": "base", "X-Shared": "base" },
					},
				],
			});

			const model = registry.find("extension-provider", "demo-model");
			expect(model?.name).toBe("Overridden Demo");
			expect(model?.thinkingLevelMap).toEqual({ low: "medium", xhigh: "xhigh", high: "high" });
			expect(model?.contextWindow).toBe(128000);
			expect(model?.samplingParams).toEqual({ top_p: 0.5, top_k: 40, min_p: 0.1 });
			if (!model) throw new Error("missing extension model");
			expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
				ok: true,
				headers: { "X-Base": "base", "X-Override": "override", "X-Shared": "base" },
			});
		});

		test("failed registerProvider does not persist invalid streamSimple config", async () => {
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			// ModelRegistry.refresh now returns pi's ModelsRefreshResult rather than void.
			// A rejected registration must leave a clean refresh behind it.
			const afterFailedRegistration = await registry.refresh();
			expect(afterFailedRegistration.aborted).toBe(false);
			expect(afterFailedRegistration.errors.size).toBe(0);
		});

		test("failed registerProvider does not remove existing provider models", async () => {
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

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
			const afterFailedReregistration = await registry.refresh();
			expect(afterFailedReregistration.aborted).toBe(false);
			expect(afterFailedReregistration.errors.size).toBe(0);
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("unregisterProvider removes custom OAuth provider and restores built-in OAuth provider", async () => {
			const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

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

			expect(registry.getProvider("anthropic")?.auth.oauth?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(registry.getProvider("anthropic")?.auth.oauth?.name).not.toBe("Custom Anthropic OAuth");
		});

		describe("dynamic provider override persistence", () => {
			test("baseUrl-only override keeps built-in provider models after refresh", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				await getModelRuntime(registry).refresh({ allowNetwork: false });

				const anthropicModels = getModelsForProvider(registry, "anthropic");
				expect(anthropicModels.length).toBeGreaterThan(1);
				expect(anthropicModels.every((m) => m.baseUrl === "https://proxy.test/anthropic")).toBe(true);
			});

			test("models-only override replaces built-in provider models after refresh", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				await getModelRuntime(registry).refresh({ allowNetwork: false });

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://custom.test/anthropic");
			});

			test("models plus baseUrl override replaces built-in provider models after refresh", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				await getModelRuntime(registry).refresh({ allowNetwork: false });

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://proxy.test/anthropic");
			});

			test("models-only custom provider registration survives refresh", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				await getModelRuntime(registry).refresh({ allowNetwork: false });

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual([
					"custom-a",
					"custom-b",
				]);
			});

			test("baseUrl-only override keeps custom provider models after refresh", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { baseUrl: "https://proxy.test/custom" });
				await getModelRuntime(registry).refresh({ allowNetwork: false });

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
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { headers: { "x-proxy": "enabled" } });
				await getModelRuntime(registry).refresh({ allowNetwork: false });

				const models = getModelsForProvider(registry, "custom-provider");
				expect(models.map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(models.every((m) => m.baseUrl === "https://custom.test/v1")).toBe(true);
				expect(await registry.getApiKeyAndHeaders(models[0])).toMatchObject({
					ok: true,
					headers: { "x-proxy": "enabled" },
				});
			});

			test("async catalog refresh publishes successful results only after completion", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });

				const refresh = getModelRuntime(registry).refresh();
				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["old"]);
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "new" }]).models!);
				const result = await refresh;

				expect(result.aborted).toBe(false);
				expect(result.errors.size).toBe(0);
				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["new"]);
			});

			test("unrelated registration does not discard an in-flight provider refresh", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });
				const refresh = getModelRuntime(registry).refresh();

				registry.registerProvider("anthropic", { headers: { "x-unrelated": "yes" } });
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "new" }]).models!);
				const result = await refresh;

				expect(result.aborted).toBe(false);
				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["new"]);
			});

			test("async catalog refresh returns partial provider errors without discarding successes", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const good = providerConfig("https://good.test/v1", [{ id: "old-good" }]);
				const bad = providerConfig("https://bad.test/v1", [{ id: "old-bad" }]);
				registry.registerProvider("good", {
					...good,
					refreshModels: async () => providerConfig("https://good.test/v1", [{ id: "new-good" }]).models!,
				});
				registry.registerProvider("bad", {
					...bad,
					refreshModels: async ({ allowNetwork }) => {
						if (!allowNetwork) return;
						throw new Error("catalog failed");
					},
				});

				const result = await getModelRuntime(registry).refresh({ allowNetwork: true });

				expect(result.errors.get("bad")?.message).toBe("catalog failed");
				expect(getModelsForProvider(registry, "good").map((model) => model.id)).toEqual(["new-good"]);
				expect(getModelsForProvider(registry, "bad").map((model) => model.id)).toEqual(["old-bad"]);
			});

			test("stale refresh completion cannot resurrect an unregistered provider", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let resolveRefresh!: (models: NonNullable<typeof initial.models>) => void;
				const pending = new Promise<NonNullable<typeof initial.models>>((resolve) => (resolveRefresh = resolve));
				registry.registerProvider("dynamic", { ...initial, refreshModels: () => pending });
				const staleRefresh = getModelRuntime(registry).refresh();

				registry.unregisterProvider("dynamic");
				resolveRefresh(providerConfig("https://dynamic.test/v1", [{ id: "resurrected" }]).models!);
				await staleRefresh;

				expect(registry.find("dynamic", "resurrected")).toBeUndefined();
			});

			test("stale refresh completion cannot overwrite a re-registered provider or shared cache", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://dynamic.test/v1", [{ id: "old" }]);
				let releaseStale!: () => void;
				let markAllStaleStarted!: () => void;
				let markAllStaleFinished!: () => void;
				const staleGate = new Promise<void>((resolve) => {
					releaseStale = resolve;
				});
				const allStaleStarted = new Promise<void>((resolve) => {
					markAllStaleStarted = resolve;
				});
				const allStaleFinished = new Promise<void>((resolve) => {
					markAllStaleFinished = resolve;
				});
				let staleStartCount = 0;
				let staleFinishCount = 0;
				let persistedAfterStale: string[] | undefined;
				registry.registerProvider("dynamic", {
					...initial,
					refreshModels: async ({ publish, signal }) => {
						staleStartCount += 1;
						if (staleStartCount === 2) markAllStaleStarted();
						await staleGate;
						const staleModels = providerConfig("https://dynamic.test/v1", [{ id: "stale-store" }]).models!;
						if (!signal.aborted) {
							const published = await publish({ persist: { models: staleModels, checkedAt: Date.now() } });
							if (published) persistedAfterStale = staleModels.map((model) => model.id);
						}
						staleFinishCount += 1;
						if (staleFinishCount === 2) markAllStaleFinished();
					},
				});
				const staleRefresh = getModelRuntime(registry).refresh();
				const supersededStaleRefresh = getModelRuntime(registry).refresh();
				await allStaleStarted;

				const freshModels = providerConfig("https://manual.test/v1", [{ id: "manual" }]).models!;
				registry.registerProvider("dynamic", {
					...providerConfig("https://manual.test/v1", [{ id: "manual" }]),
					refreshModels: async ({ publish }) => {
						await publish({ persist: { models: freshModels, checkedAt: Date.now() } });
					},
				});
				await getModelRuntime(registry).refresh();
				releaseStale();
				await Promise.all([staleRefresh, supersededStaleRefresh, allStaleFinished]);

				expect(getModelsForProvider(registry, "dynamic").map((model) => model.id)).toEqual(["manual"]);
				// Re-registration supersedes both stale refresh generations, so their
				// generation-checked publications cannot update the shared cache.
				expect(persistedAfterStale).toBeUndefined();
			});

			test("pre-aborted refresh returns without invoking providers", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const initial = providerConfig("https://slow.test/v1", [{ id: "cached" }]);
				let calls = 0;
				registry.registerProvider("slow", {
					...initial,
					refreshModels: async () => {
						calls += 1;
						return initial.models!;
					},
				});
				await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
				calls = 0;
				const controller = new AbortController();
				controller.abort();

				const result = await getModelRuntime(registry).refresh({ signal: controller.signal });

				expect(result.aborted).toBe(true);
				expect(calls).toBe(0);
				expect(registry.find("slow", "cached")).toBeDefined();
			});

			test("additive provider overrides retain built-in credential filtering", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const allowed = registry.getAll().find((model) => model.provider === "github-copilot")!;
				await context.authStorage.modify("github-copilot", async () => ({
					type: "oauth",
					refresh: "r",
					access: "a",
					expires: Date.now() + 60_000,
					availableModelIds: [allowed.id],
				}));
				await getModelRuntime(registry).refresh({ allowNetwork: false });
				const availableIds = () =>
					registry
						.getAvailable()
						.filter((model) => model.provider === "github-copilot")
						.map((model) => model.id);
				expect(availableIds()).toEqual([allowed.id]);

				registry.registerProvider("github-copilot", { headers: { "x-test": "1" } });

				// The provisional snapshot the registration publishes synchronously is the
				// exact trigger: an already-configured provider must keep its credential
				// filtering instead of being widened back to its whole built-in catalog.
				expect(availableIds()).toEqual([allowed.id]);
				await getModelRuntime(registry).refresh({ allowNetwork: false });

				expect(availableIds()).toEqual([allowed.id]);
			});

			test("a superseded availability pass leaves credential filtering in place", async () => {
				const registry = await createModelRegistry(context.authStorage, context.modelsJsonPath);
				const allowed = registry.getAll().find((model) => model.provider === "github-copilot")!;
				await context.authStorage.modify("github-copilot", async () => ({
					type: "oauth",
					refresh: "r",
					access: "a",
					expires: Date.now() + 60_000,
					availableModelIds: [allowed.id],
				}));
				const runtime = getModelRuntime(registry);
				await runtime.refresh({ allowNetwork: false });
				const availableIds = () =>
					registry
						.getAvailable()
						.filter((model) => model.provider === "github-copilot")
						.map((model) => model.id);
				expect(availableIds()).toEqual([allowed.id]);

				// The second pass supersedes the first, so the first publishes nothing;
				// the projection it rebuilt models against must still be the filtered one.
				const first = runtime.refresh({ allowNetwork: false });
				const second = runtime.refresh({ allowNetwork: false });
				await first;

				expect(availableIds()).toEqual([allowed.id]);
				await second;
				expect(availableIds()).toEqual([allowed.id]);
			});
		});
	});
});
