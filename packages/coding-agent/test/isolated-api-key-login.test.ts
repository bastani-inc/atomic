import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { isOAuthLoginCancelled } from "../src/core/oauth-login.ts";
import { loginIsolatedApiKeyProvider } from "../src/modes/interactive-engine/isolated-auth.ts";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.ts";

const PROVIDER = "typesafe-ai";

afterEach(() => vi.unstubAllEnvs());

async function createIsolatedRuntimes() {
	vi.stubEnv("TYPESAFE_API_KEY", "");
	const backend = new InMemoryAuthStorageBackend();
	const engineCredentials = AuthStorage.fromStorage(backend);
	const frontendCredentials = AuthStorage.fromStorage(backend);
	const engineRuntime = await ModelRuntime.create({ credentials: engineCredentials, modelsPath: null });
	const frontendRuntime = await ModelRuntime.create({ credentials: frontendCredentials, modelsPath: null });
	const engineSession = {
		modelRuntime: engineRuntime,
		scopedModels: [],
		refreshCurrentModelFromRegistry: () => {},
	} as unknown as AgentSession;
	const frontendSession = {
		modelRuntime: frontendRuntime,
		scopedModels: [],
		refreshCurrentModelFromRegistry: () => {},
	} as unknown as AgentSession;
	const providerAuth = new RpcProviderAuth();
	const saveProviderCredential = vi.fn(
		(
			provider: string,
			credential: Parameters<RpcProviderAuth["save"]>[2],
			options: Parameters<RpcProviderAuth["save"]>[3],
		) => providerAuth.save(engineSession, provider, credential, options),
	);
	return {
		engineRuntime,
		frontendRuntime,
		engineSession,
		frontendSession,
		client: { saveProviderCredential } as never,
		saveProviderCredential,
		catalog: { apply: vi.fn() },
	};
}

describe("isolated API-key login", () => {
	it("makes the key resolvable in the engine registry without a restart (#3193)", async () => {
		const { engineRuntime, frontendRuntime, frontendSession, client, saveProviderCredential, catalog } =
			await createIsolatedRuntimes();
		const engineRegistry = new ModelRegistry(engineRuntime);
		const reload = vi.spyOn(frontendRuntime, "reloadCredentials");

		const result = await loginIsolatedApiKeyProvider(frontendSession, client, catalog as never, PROVIDER, {
			signal: new AbortController().signal,
			prompt: async () => "isolated-login-key",
			notify: () => {},
		});

		expect(result).toEqual({ modelsRefreshed: true });
		expect(saveProviderCredential).toHaveBeenCalledWith(
			PROVIDER,
			{ type: "api_key", key: "isolated-login-key" },
			{ refreshCatalog: false },
		);
		expect((await engineRegistry.getProviderAuth(PROVIDER))?.auth.apiKey).toBe("isolated-login-key");
		expect(engineRuntime.hasConfiguredAuth(PROVIDER)).toBe(true);
		expect(frontendRuntime.hasConfiguredAuth(PROVIDER)).toBe(true);
		expect(catalog.apply).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledWith({ refreshAvailability: false });
	});

	it("persists nothing when the login dialog is cancelled (#3193)", async () => {
		const { engineRuntime, frontendRuntime, frontendSession, client, saveProviderCredential, catalog } =
			await createIsolatedRuntimes();
		const reload = vi.spyOn(frontendRuntime, "reloadCredentials");
		const controller = new AbortController();

		const login = loginIsolatedApiKeyProvider(frontendSession, client, catalog as never, PROVIDER, {
			signal: controller.signal,
			prompt: () => new Promise<string>(() => {}),
			notify: () => {},
		});
		controller.abort();

		await expect(login).rejects.toSatisfy((error: unknown) => isOAuthLoginCancelled(error));
		expect(saveProviderCredential).not.toHaveBeenCalled();
		expect(catalog.apply).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(engineRuntime.hasConfiguredAuth(PROVIDER)).toBe(false);
		expect(frontendRuntime.hasConfiguredAuth(PROVIDER)).toBe(false);
	});

	it("leaves both runtimes unconfigured after an engine logout (#3193)", async () => {
		const { engineRuntime, frontendRuntime, frontendSession, client, catalog } = await createIsolatedRuntimes();
		const engineRegistry = new ModelRegistry(engineRuntime);
		await loginIsolatedApiKeyProvider(frontendSession, client, catalog as never, PROVIDER, {
			signal: new AbortController().signal,
			prompt: async () => "isolated-login-key",
			notify: () => {},
		});

		await engineRuntime.logout(PROVIDER);
		await frontendRuntime.reloadCredentials({ refreshAvailability: false });

		expect(await engineRegistry.getProviderAuth(PROVIDER)).toBeUndefined();
		expect(engineRuntime.hasConfiguredAuth(PROVIDER)).toBe(false);
		expect(frontendRuntime.hasConfiguredAuth(PROVIDER)).toBe(false);
	});
});
