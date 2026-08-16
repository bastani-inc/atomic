import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";

/** Reach the catalog pass a `ModelRuntime.refresh()` runs, without a network. */
interface RuntimeInternals {
	models: { refresh(options?: { signal?: AbortSignal }): Promise<ModelsRefreshResult> };
}

async function createOfflineRuntime(credentials: AuthStorage): Promise<ModelRuntime> {
	return ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
}

async function loginWithApiKey(runtime: ModelRuntime, providerId: string, key: string): Promise<void> {
	await runtime.login(providerId, "api_key", { prompt: async () => key, notify: () => {} });
}

async function waitForPasses(observed: readonly unknown[], count: number): Promise<void> {
	for (let attempt = 0; attempt < 200 && observed.length < count; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

beforeEach(() => {
	// Every catalog pass here is local: the assertions are about which pass a
	// caller joins, never about a live endpoint.
	vi.stubEnv("ATOMIC_OFFLINE", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("model catalog refresh across a credential change", () => {
	it("counts a login, a logout, and a runtime key as catalog-input changes", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await createOfflineRuntime(credentials);
		const start = runtime.getCatalogInputsGeneration();

		await loginWithApiKey(runtime, "anthropic", "sk-login-key");
		const afterLogin = runtime.getCatalogInputsGeneration();
		expect(afterLogin).toBeGreaterThan(start);

		await runtime.setRuntimeApiKey("openai", "sk-runtime-key", {});
		const afterRuntimeKey = runtime.getCatalogInputsGeneration();
		expect(afterRuntimeKey).toBeGreaterThan(afterLogin);

		await runtime.logout("anthropic");
		const afterLogout = runtime.getCatalogInputsGeneration();
		expect(afterLogout).toBeGreaterThan(afterRuntimeKey);

		// A registration replaces a provider every later pass composes from, so it
		// is the same class of change as a credential write and bumps the same
		// counter rather than needing a key field of its own.
		runtime.registerProvider("registered", {
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
			apiKey: "sk-registered",
			models: [{ id: "registered-model" }],
		});
		const afterRegistration = runtime.getCatalogInputsGeneration();
		expect(afterRegistration).toBeGreaterThan(afterLogout);

		runtime.unregisterProvider("registered");
		expect(runtime.getCatalogInputsGeneration()).toBeGreaterThan(afterRegistration);
	});

	it("holds the generation still when nothing changed", async () => {
		const runtime = await createOfflineRuntime(AuthStorage.inMemory());
		const generation = runtime.getCatalogInputsGeneration();

		await runtime.refresh({ allowNetwork: false });

		// A refresh reads the inputs; it does not change them. If it bumped, no two
		// callers could ever share a pass.
		expect(runtime.getCatalogInputsGeneration()).toBe(generation);
	});

	it("does not answer a post-login selector with the pass that was running during login", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await createOfflineRuntime(credentials);
		const internals = runtime as unknown as RuntimeInternals;

		// What each catalog pass would resolve for the provider being logged in.
		// The pre-login pass sees nothing; only a pass started after the credential
		// lands can put that provider's models in front of the user.
		const credentialPerPass: Array<string | undefined> = [];
		let releaseFirstPass!: () => void;
		const firstPassGate = new Promise<void>((resolve) => {
			releaseFirstPass = resolve;
		});
		vi.spyOn(internals.models, "refresh").mockImplementation(async () => {
			const stored = await credentials.read("anthropic");
			credentialPerPass.push(stored?.type === "api_key" ? stored.key : undefined);
			if (credentialPerPass.length === 1) await firstPassGate;
			return { aborted: false, errors: new Map<string, Error>() };
		});

		const startupController = new AbortController();
		const startupRefresh = refreshModelCatalogs(runtime, { signal: startupController.signal });
		await waitForPasses(credentialPerPass, 1);
		expect(credentialPerPass).toEqual([undefined]);

		// Atomic's API-key login publishes the credential and deliberately skips its
		// own catalog refresh (interactive-auth-login.ts), so the next selector's
		// refresh is the only thing that can surface the provider's models.
		await loginWithApiKey(runtime, "anthropic", "sk-new-key");

		const selectorController = new AbortController();
		const selectorRefresh = refreshModelCatalogs(runtime, { signal: selectorController.signal });
		await waitForPasses(credentialPerPass, 2);

		expect(credentialPerPass).toEqual([undefined, "sk-new-key"]);
		await expect(selectorRefresh).resolves.toMatchObject({ aborted: false });

		releaseFirstPass();
		await expect(startupRefresh).resolves.toMatchObject({ aborted: false });
	});
});
