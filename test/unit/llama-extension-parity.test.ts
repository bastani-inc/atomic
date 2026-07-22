import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
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
	test("maps loaded model metadata to capped, zero-cost OpenAI models", () => {
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
		assert.equal(toLlamaModel({ id: "large", status: { value: "loaded" }, meta: { n_ctx: 32768 } }, "http://localhost").maxTokens, 16384);
		assert.equal(toLlamaModel({ id: "fallback", status: { value: "loaded" } }, "http://localhost").contextWindow, 128000);
	});

	test("custom login validates the router and stores normalized URL plus optional key", async () => {
		let requestedUrl = "";
		globalThis.fetch = mockFetch(async (input) => {
			requestedUrl = String(input);
			return jsonResponse({ data: [{ id: "local", status: { value: "loaded" } }] });
		});
		const auth = createLlamaProvider().config.auth?.apiKey;
		assert.ok(auth);
		const answers = ["http://localhost:9000/v1/", "secret"];
		const credential = await auth.login({
			signal: new AbortController().signal,
			prompt: async () => answers.shift() ?? "",
		});
		assert.equal(requestedUrl, "http://localhost:9000/models");
		assert.deepEqual(credential, {
			type: "api_key",
			key: "secret",
			env: { LLAMA_BASE_URL: "http://localhost:9000" },
		});
	});

	test("dynamic refresh exposes only loaded models and resolves stored URL metadata", async () => {
		globalThis.fetch = mockFetch(async () => jsonResponse({ data: [
			{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 4096 } },
			{ id: "idle", status: { value: "unloaded" } },
		] }));
		const storage = AuthStorage.inMemory({
			"llama.cpp": { type: "api_key", env: { LLAMA_BASE_URL: "http://localhost:8080" } },
		});
		const registry = ModelRegistry.inMemory(storage);
		registry.registerProvider("llama.cpp", createLlamaProvider().config);
		assert.deepEqual(registry.getCustomApiKeyAuthProviders(), [{ id: "llama.cpp", name: "llama.cpp server" }]);
		const result = await registry.refresh();
		assert.equal(result.errors.size, 0);
		const models = registry.getAll().filter((model) => model.provider === "llama.cpp");
		assert.deepEqual(models.map((model) => model.id), ["loaded"]);
		const auth = await registry.getApiKeyAndHeaders(models[0]!);
		assert.deepEqual(auth, { ok: true, apiKey: "local", headers: undefined, baseUrl: "http://localhost:8080/v1" });
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
test("provider metadata credentials remain backward compatible", () => {
	const storage = AuthStorage.inMemory({ old: { type: "api_key", key: "legacy" }, local: { type: "api_key", env: { LLAMA_BASE_URL: "http://localhost" } } });
	assert.equal(storage.get("old")?.type, "api_key");
	assert.deepEqual(storage.get("local"), { type: "api_key", env: { LLAMA_BASE_URL: "http://localhost" } });
});
