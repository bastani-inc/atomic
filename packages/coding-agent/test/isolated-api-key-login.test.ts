import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { isOAuthLoginCancelled } from "../src/core/oauth-login.ts";
import { loginIsolatedApiKeyProvider } from "../src/modes/interactive-engine/isolated-auth.ts";
import { RemoteModelCatalog } from "../src/modes/interactive-engine/remote-model-catalog.ts";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.ts";

const PROVIDER = "typesafe";

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
	const client = { saveProviderCredential } as never;
	const catalog = new RemoteModelCatalog(client);
	const apply = vi.spyOn(catalog, "apply");
	return {
		engineRuntime,
		frontendRuntime,
		engineSession,
		frontendSession,
		client,
		saveProviderCredential,
		catalog,
		apply,
	};
}

describe("isolated API-key login", () => {
	it("rejects the obsolete provider ID before prompting or saving", async () => {
		const { frontendSession, client, saveProviderCredential, catalog, apply } = await createIsolatedRuntimes();
		const prompt = vi.fn(async () => "unused-test-key");
		await expect(
			loginIsolatedApiKeyProvider(frontendSession, client, catalog, "typesafe-ai", {
				signal: new AbortController().signal,
				prompt,
				notify: () => {},
			}),
		).rejects.toThrow("Provider does not support api_key login: typesafe-ai");
		expect(prompt).not.toHaveBeenCalled();
		expect(saveProviderCredential).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it("makes the key resolvable in the engine registry without a restart (#3193)", async () => {
		const { engineRuntime, frontendRuntime, frontendSession, client, saveProviderCredential, catalog, apply } =
			await createIsolatedRuntimes();
		const engineRegistry = new ModelRegistry(engineRuntime);
		const reload = vi.spyOn(frontendRuntime, "reloadCredentials");

		const result = await loginIsolatedApiKeyProvider(frontendSession, client, catalog, PROVIDER, {
			signal: new AbortController().signal,
			prompt: async () => "isolated-login-key",
			notify: () => {},
		});

		expect(result).toEqual({ modelsRefreshed: true });
		expect(saveProviderCredential).toHaveBeenCalledWith(
			"typesafe",
			{ type: "api_key", key: "isolated-login-key" },
			{ refreshCatalog: false },
		);
		expect((await engineRegistry.getProviderAuth(PROVIDER))?.auth.apiKey).toBe("isolated-login-key");
		expect(engineRuntime.hasConfiguredAuth(PROVIDER)).toBe(true);
		expect(frontendRuntime.hasConfiguredAuth(PROVIDER)).toBe(true);
		expect(apply).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledWith({ refreshAvailability: false });
	});

	it.each(["frontend", "engine"] as const)(
		"keeps a newer scope when %s API-key acquisition returns an older catalog (#5224)",
		async (acquisition) => {
			const { frontendSession, frontendRuntime } = await createIsolatedRuntimes();
			const initialModel = frontendRuntime.getModels("openai")[0];
			assert.ok(initialModel);
			const nextModel = { ...initialModel, id: "next-scoped-model" };
			const acquiredModel = { ...initialModel, id: "acquired-model" };
			const provider = acquisition === "frontend" ? PROVIDER : "engine-only";
			const initialCatalog = {
				models: [initialModel, nextModel],
				scopedModels: [{ model: initialModel }],
				customAuthProviders: [{ id: provider, name: "API-key provider" }],
				oauthProviders: [],
			};
			const request = vi.fn(async () => {
				assert.equal(getScopeSnapshot.mock.calls.length, 1);
				await catalog.syncScopedModels([{ model: nextModel }], async () => ({
					...initialCatalog,
					scopedModels: [{ model: nextModel }],
				}));
				return {
					...initialCatalog,
					provider,
					cancelled: false as const,
					models: [...initialCatalog.models, acquiredModel],
				};
			});
			const client = { saveProviderCredential: request, loginProvider: request } as never;
			const catalog = new RemoteModelCatalog(client);
			catalog.apply(initialCatalog);
			catalog.patch(frontendSession);
			const getScopeSnapshot = vi.spyOn(catalog, "getScopeSnapshot");
			const apply = vi.spyOn(catalog, "apply");

			await loginIsolatedApiKeyProvider(frontendSession, client, catalog, provider, {
				signal: new AbortController().signal,
				prompt: async () => "isolated-login-key",
				notify: () => {},
			});

			assert.deepEqual(frontendSession.scopedModels, [{ model: nextModel }]);
			assert.equal(request.mock.calls.length, 1);
			assert.equal(getScopeSnapshot.mock.calls.length, 1);
			assert.equal(apply.mock.lastCall?.[1], getScopeSnapshot.mock.results[0]?.value);
			assert.deepEqual(frontendRuntime.getModel(acquiredModel.provider, acquiredModel.id), acquiredModel);
		},
	);

	it("persists nothing when the login dialog is cancelled (#3193)", async () => {
		const { engineRuntime, frontendRuntime, frontendSession, client, saveProviderCredential, catalog, apply } =
			await createIsolatedRuntimes();
		const reload = vi.spyOn(frontendRuntime, "reloadCredentials");
		const controller = new AbortController();

		const login = loginIsolatedApiKeyProvider(frontendSession, client, catalog, PROVIDER, {
			signal: controller.signal,
			prompt: () => new Promise<string>(() => {}),
			notify: () => {},
		});
		controller.abort();

		await expect(login).rejects.toSatisfy((error: unknown) => isOAuthLoginCancelled(error));
		expect(saveProviderCredential).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		expect(engineRuntime.hasConfiguredAuth(PROVIDER)).toBe(false);
		expect(frontendRuntime.hasConfiguredAuth(PROVIDER)).toBe(false);
	});

	it("leaves both runtimes unconfigured after an engine logout (#3193)", async () => {
		const { engineRuntime, frontendRuntime, frontendSession, client, catalog } = await createIsolatedRuntimes();
		const engineRegistry = new ModelRegistry(engineRuntime);
		await loginIsolatedApiKeyProvider(frontendSession, client, catalog, PROVIDER, {
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
