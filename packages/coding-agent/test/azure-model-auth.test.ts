import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";

const legacyProvider = "azure-openai-responses";
const directories: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function configuredRuntime(source: "extension" | "models.json") {
	const config = {
		api: "openai-completions" as const,
		baseUrl: "https://azure.test/openai/v1",
		models: [
			{
				id: "deployment",
				name: "Deployment",
				headers: { "x-deployment-token": "$DEPLOYMENT_TOKEN" },
				reasoning: false,
				input: ["text" as const],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
	};
	let modelsPath: string | null = null;
	if (source === "models.json") {
		const directory = mkdtempSync(join(tmpdir(), "azure-model-auth-"));
		directories.push(directory);
		modelsPath = join(directory, "models.json");
		writeFileSync(modelsPath, JSON.stringify({ providers: { [legacyProvider]: config } }));
	}
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({ azure: { type: "api_key", key: "test-key" } }),
		modelsPath,
		allowModelNetwork: false,
	});
	if (source === "extension") runtime.registerProvider(legacyProvider, config);
	const canonical = runtime.getModel("azure", "deployment");
	assert.ok(canonical);
	const legacy = Object.freeze({ ...canonical, provider: legacyProvider });
	return { runtime, canonical, legacy };
}

for (const source of ["extension", "models.json"] as const) {
	test(`legacy Azure model objects preserve ${source} model-specific auth headers`, async () => {
		const { runtime, canonical, legacy } = await configuredRuntime(source);
		const overrides = { env: { DEPLOYMENT_TOKEN: "deployment-secret" } };
		for (const resolve of [runtime.getAuth.bind(runtime), runtime.getRequestAuth.bind(runtime)]) {
			const canonicalAuth = await resolve(canonical, overrides);
			assert.equal(canonicalAuth?.auth.headers?.["x-deployment-token"], "deployment-secret");
			assert.deepEqual(await resolve(legacy, overrides), canonicalAuth);
		}
		assert.equal(legacy.provider, legacyProvider);
	});

	for (const method of ["stream", "streamSimple"] as const) {
		test(`${method} preserves ${source} model-specific headers for legacy Azure model objects`, async () => {
			const { runtime, canonical, legacy } = await configuredRuntime(source);
			const captured: Headers[] = [];
			vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
				captured.push(new Headers(init?.headers));
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			});
			for (const model of [canonical, legacy]) {
				const result = await runtime[method](
					model,
					{ messages: [] },
					{
						env: { DEPLOYMENT_TOKEN: "deployment-secret" },
					},
				).result();
				assert.equal(result.stopReason, "stop", result.errorMessage);
				assert.equal(result.provider, "azure");
			}
			assert.equal(captured.length, 2);
			for (const headers of captured) assert.equal(headers.get("x-deployment-token"), "deployment-secret");
			assert.deepEqual([...captured[1]], [...captured[0]]);
			assert.equal(legacy.provider, legacyProvider);
		});
	}
}
