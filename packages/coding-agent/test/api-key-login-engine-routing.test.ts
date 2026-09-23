import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { loginIsolatedApiKeyProvider } from "../src/modes/interactive-engine/isolated-auth.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.ts";
import type { RpcModelCatalog } from "../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./suite/harness.ts";

const UNREACHABLE_CATALOG = "http://127.0.0.1:1/";

const unusedCreateRuntime = (async () => {
	throw new Error("unused runtime factory");
}) as CreateAgentSessionRuntimeFactory;

function interaction(key: string) {
	return { signal: new AbortController().signal, prompt: async () => key, notify: () => {} };
}

function emptyCatalog(): RpcModelCatalog {
	return { models: [], scopedModels: [], customAuthProviders: [], oauthProviders: [] };
}

afterEach(() => vi.unstubAllEnvs());

describe("API-key login routing", () => {
	it("persists in the engine and the frontend when the catalog is unreachable (#3193)", async () => {
		vi.stubEnv("OPENAI_API_KEY", "");
		const provider = "openai";
		const backend = new InMemoryAuthStorageBackend();
		const runtimeOptions = {
			modelsPath: null,
			catalogBaseUrl: UNREACHABLE_CATALOG,
			refreshOnCreate: false,
		} as const;
		const engineRuntime = await ModelRuntime.create({
			credentials: AuthStorage.fromStorage(backend),
			...runtimeOptions,
		});
		const frontendRuntime = await ModelRuntime.create({
			credentials: AuthStorage.fromStorage(backend),
			...runtimeOptions,
		});
		const asSession = (modelRuntime: ModelRuntime) =>
			({
				modelRuntime,
				scopedModels: [],
				refreshCurrentModelFromRegistry: () => {},
			}) as unknown as AgentSession;
		const engineSession = asSession(engineRuntime);
		const providerAuth = new RpcProviderAuth();
		const saveProviderCredential = vi.fn(
			(
				savedProvider: string,
				credential: Parameters<RpcProviderAuth["save"]>[2],
				options: Parameters<RpcProviderAuth["save"]>[3],
			) => providerAuth.save(engineSession, savedProvider, credential, options),
		);
		const catalog = { apply: vi.fn() };

		const result = await loginIsolatedApiKeyProvider(
			asSession(frontendRuntime),
			{ saveProviderCredential } as never,
			catalog as never,
			provider,
			interaction("offline-catalog-key"),
		);

		assert.deepEqual(result, { modelsRefreshed: true });
		assert.equal(engineRuntime.hasConfiguredAuth(provider), true);
		assert.equal((await engineRuntime.getAuth(provider))?.auth.apiKey, "offline-catalog-key");
		assert.equal(engineRuntime.getProviderAuthStatus(provider).configured, true);
		assert.equal(frontendRuntime.hasConfiguredAuth(provider), true);
		assert.equal(catalog.apply.mock.calls.length, 1);
	});

	it("routes IsolatedInteractiveRuntime.loginApiKeyProvider through the engine save RPC (#3193)", async () => {
		const harness = await createHarness();
		try {
			const local = new AgentSessionRuntime(
				harness.session,
				{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
				unusedCreateRuntime,
			);
			const saveProviderCredential = vi.fn(async () => emptyCatalog());
			const client = {
				onEvent: () => () => {},
				onGenerationEnded: () => () => {},
				saveProviderCredential,
			} as never;
			const runtime = new IsolatedInteractiveRuntime(local, unusedCreateRuntime, client);

			const result = await runtime.loginApiKeyProvider("typesafe", interaction("isolated-routed-key"));

			assert.deepEqual(result, { modelsRefreshed: true });
			assert.deepEqual(saveProviderCredential.mock.calls, [
				["typesafe", { type: "api_key", key: "isolated-routed-key" }, { refreshCatalog: false }],
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("logs in through the session model runtime for the base AgentSessionRuntime (#3193)", async () => {
		const login = vi.fn(async () => ({ type: "api_key", key: "base-runtime-key" }));
		const session = { modelRuntime: { login } } as unknown as AgentSession;
		const runtime = new AgentSessionRuntime(session, { cwd: ".", agentDir: "." } as never, unusedCreateRuntime);
		const loginInteraction = interaction("base-runtime-key");

		const result = await runtime.loginApiKeyProvider("typesafe", loginInteraction);

		assert.deepEqual(result, { modelsRefreshed: true });
		assert.deepEqual(login.mock.calls, [["typesafe", "api_key", loginInteraction]]);
	});
});
