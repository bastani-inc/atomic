import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { FileModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { builtInExtensions } from "../../packages/coding-agent/src/extensions/index.js";
import { LlamaClient, llamaInferenceUrl, normalizeLlamaServerUrl } from "../../packages/coding-agent/src/extensions/llama/client.js";
import { createLlamaProvider, toLlamaModel } from "../../packages/coding-agent/src/extensions/llama/provider.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function jsonResponse(value: object, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(handler, { preconnect: () => {} });
}

describe("llama.cpp router client", () => {
	test("normalizes inference URLs and strips a trailing v1", () => {
		assert.equal(normalizeLlamaServerUrl(" https://localhost:8080/v1/ "), "https://localhost:8080");
		assert.equal(llamaInferenceUrl("http://localhost:8080/"), "http://localhost:8080/v1");
		assert.throws(() => normalizeLlamaServerUrl("ftp://localhost/model"), /http or https/);
	});

	test("rejects a plain llama-server catalog without router status metadata", async () => {
		globalThis.fetch = mockFetch(async () => jsonResponse({ data: [{ id: "model.gguf" }] }));
		await assert.rejects(new LlamaClient("http://localhost:8080").list(), /router mode/);
	});
});

describe("llama.cpp provider", () => {
	test("maps loaded model metadata to context-sized, zero-cost OpenAI models", () => {
		const mapped = toLlamaModel({
			id: "vision.gguf",
			status: { value: "loaded" },
			architecture: { input_modalities: ["text", "image"] },
			meta: { n_ctx: 8192 },
		}, "http://localhost:8080");
		assert.equal(mapped.baseUrl, "http://localhost:8080/v1");
		assert.deepEqual(mapped.input, ["text", "image"]);
		assert.equal(mapped.contextWindow, 8192);
		assert.equal(mapped.maxTokens, 8192);
		assert.deepEqual(mapped.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal(toLlamaModel({ id: "large", status: { value: "loaded" }, meta: { n_ctx: 32768 } }, "http://localhost").maxTokens, 32768);
		assert.equal(toLlamaModel({ id: "fallback", status: { value: "loaded" } }, "http://localhost").contextWindow, 128000);
	});

	test("dynamic refresh exposes only loaded models through the configured provider", async () => {
		globalThis.fetch = mockFetch(async () => jsonResponse({ data: [
			{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 4096 } },
			{ id: "idle", status: { value: "unloaded" } },
		] }));
		const storage = AuthStorage.inMemory({
			"llama.cpp": { type: "api_key", key: "local", env: { LLAMA_BASE_URL: "http://localhost:8080" } },
		});
		const runtime = await ModelRuntime.create({ credentials: storage, modelsPath: null });
		runtime.registerProvider("llama.cpp", createLlamaProvider().config);
		await runtime.refresh({ allowNetwork: false });
		const result = await runtime.refresh({ allowNetwork: true });
		assert.equal(result.errors.size, 0);
		const models = runtime.getModels("llama.cpp");
		assert.deepEqual(models.map((model) => model.id), ["loaded"]);
		const auth = await runtime.getAuth(models[0]!);
		assert.equal(auth?.auth.apiKey, "local");
		assert.equal(models[0]?.baseUrl, "http://127.0.0.1:8080/v1");
	});

	test("persists the loaded catalog and restores it before a later network refresh", async () => {
		globalThis.fetch = mockFetch(async () => jsonResponse({ data: [
			{ id: "cached", status: { value: "loaded" }, meta: { n_ctx: 65536 } },
		] }));
		const backing = new InMemoryModelsStore();
		const store = {
			read: () => backing.read("llama.cpp"),
			write: (entry: Parameters<InMemoryModelsStore["write"]>[1]) => backing.write("llama.cpp", entry),
			delete: () => backing.delete("llama.cpp"),
		};
		const credential = { type: "api_key" as const, key: "local", env: { LLAMA_BASE_URL: "http://localhost:8080" } };
		const first = createLlamaProvider().config;
		const refreshed = await first.refreshModels?.({ credential, store, allowNetwork: true });
		assert.equal(refreshed?.[0]?.id, "cached");
		assert.equal((await backing.read("llama.cpp"))?.models[0]?.maxTokens, 65536);

		globalThis.fetch = mockFetch(async () => { throw new Error("offline"); });
		const restarted = createLlamaProvider().config;
		const restored = await restarted.refreshModels?.({ credential, store, allowNetwork: false });
		assert.equal(restored?.[0]?.id, "cached");
		assert.equal(restored?.[0]?.maxTokens, 65536);
	});

	test("keeps a validated cached catalog visible when the first online refresh after restart fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-llama-restart-"));
		try {
			const auth = AuthStorage.inMemory({
				"llama.cpp": { type: "api_key", key: "local", env: { LLAMA_BASE_URL: "http://localhost:8080" } },
			});
			globalThis.fetch = mockFetch(async () => jsonResponse({ data: [
				{ id: "cached-on-restart", status: { value: "loaded" }, meta: { n_ctx: 65536 } },
			] }));
			const first = await ModelRuntime.create({ credentials: auth, modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
			first.registerProvider("llama.cpp", createLlamaProvider().config);
			await first.refresh({ allowNetwork: false });
			assert.equal((await first.refresh({ allowNetwork: true })).errors.size, 0);

			globalThis.fetch = mockFetch(async () => { throw new Error("router offline"); });
			const restarted = await ModelRuntime.create({ credentials: auth, modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
			restarted.registerProvider("llama.cpp", createLlamaProvider().config);
			await restarted.refresh({ allowNetwork: false });
			const result = await restarted.refresh({ allowNetwork: true });

			assert.equal(result.errors.get("llama.cpp")?.message, "router offline");
			assert.deepEqual(
				restarted.getModels().filter((model) => model.provider === "llama.cpp").map((model) => model.id),
				["cached-on-restart"],
			);
			assert.equal(restarted.getModel("llama.cpp", "cached-on-restart")?.maxTokens, 65536);

			globalThis.fetch = mockFetch(async () => jsonResponse({ data: [
				{ id: "fresh-after-restart", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
			] }));
			assert.equal((await restarted.refresh({ allowNetwork: true })).errors.size, 0);
			assert.deepEqual(
				restarted.getModels().filter((model) => model.provider === "llama.cpp").map((model) => model.id),
				["fresh-after-restart"],
			);
			assert.equal(restarted.getModel("llama.cpp", "cached-on-restart"), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports an online failure without publishing models when no cache exists", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-llama-empty-"));
		try {
			const auth = AuthStorage.inMemory({
				"llama.cpp": { type: "api_key", key: "local", env: { LLAMA_BASE_URL: "http://localhost:8080" } },
			});
			globalThis.fetch = mockFetch(async () => { throw new Error("router offline"); });
			const registry = await ModelRuntime.create({ credentials: auth, modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
			registry.registerProvider("llama.cpp", createLlamaProvider().config);
			await registry.refresh({ allowNetwork: false });

			const result = await registry.refresh({ allowNetwork: true });

			assert.equal(result.errors.get("llama.cpp")?.message, "router offline");
			assert.equal(registry.getModels().some((model) => model.provider === "llama.cpp"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects cached entries for the wrong provider or API during failed-refresh recovery", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-llama-invalid-"));
		try {
			const valid = toLlamaModel({ id: "invalid", status: { value: "loaded" } }, "http://localhost:8080");
			await new FileModelsStore(join(root, "models-store.json")).write("llama.cpp", {
				models: [{ ...valid, provider: "other" }, { ...valid, api: "anthropic-messages" }],
				checkedAt: 0,
			});
			const auth = AuthStorage.inMemory({
				"llama.cpp": { type: "api_key", key: "local", env: { LLAMA_BASE_URL: "http://localhost:8080" } },
			});
			globalThis.fetch = mockFetch(async () => { throw new Error("router offline"); });
			const registry = await ModelRuntime.create({ credentials: auth, modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
			registry.registerProvider("llama.cpp", createLlamaProvider().config);
			await registry.refresh({ allowNetwork: false });

			const result = await registry.refresh({ allowNetwork: true });

			assert.equal(result.errors.get("llama.cpp")?.message, "router offline");
			assert.equal(registry.getModels().some((model) => model.provider === "llama.cpp"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("built-in inline extension", () => {
	test("loads with a stable hidden name", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-llama-inline-"));
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: [],
			extensionFactories: builtInExtensions,
		});
		await loader.reload();
		const extension = loader.getExtensions().extensions.find((entry) => entry.path === "<inline:llama.cpp>");
		assert.ok(extension);
		assert.equal(extension.hidden, true);
		assert.equal(extension.commands.has("llama"), true);
		assert.deepEqual(loader.getExtensions().errors, []);
	});

	test("plain factories retain numeric names while descriptors propagate hidden", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-inline-"));
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: SettingsManager.inMemory(),
			builtinPackagePaths: [],
			extensionFactories: [() => {}, { name: "named", hidden: true, factory: () => {} }],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().extensions.map(({ path, hidden }) => ({ path, hidden })), [
			{ path: "<inline:1>", hidden: undefined },
			{ path: "<inline:named>", hidden: true },
		]);
	});
});

// Keep the auth-storage import exercised against the newly optional key shape.
test("provider metadata credentials remain backward compatible", async () => {
	const storage = AuthStorage.inMemory({ old: { type: "api_key", key: "legacy" }, local: { type: "api_key", env: { LLAMA_BASE_URL: "http://localhost" } } });
	assert.equal((await storage.read("old"))?.type, "api_key");
	assert.deepEqual(await storage.read("local"), { type: "api_key", env: { LLAMA_BASE_URL: "http://localhost" } });
});
