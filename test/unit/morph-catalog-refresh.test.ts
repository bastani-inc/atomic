import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

test.each(["ambient", "stored"] as const)(
	"keeps the static Morph compactor available without catalog requests using %s credentials (#3470)",
	async (source) => {
		vi.stubEnv("MORPH_API_KEY", source === "ambient" ? "test-morph-key" : undefined);
		const requested: string[] = [];
		vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			requested.push(url.origin + url.pathname);
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(
				source === "stored" ? { morph: { type: "api_key", key: "test-morph-key" } } : {},
			),
			modelsPath: null,
		});
		const result = await runtime.refresh({ providers: ["morph"], allowNetwork: true });
		assert.equal(result.errors.size, 0);
		assert.deepEqual(requested, []);
		assert.equal(runtime.getModels("morph").length, 0);
		assert.equal(runtime.getAllModels("morph").find((model) => model.id === "morph-compactor")?.type, "compactor");
		assert.ok(await runtime.getAuth("morph"));
	},
);
