import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { loginIsolatedApiKeyProvider } from "../src/modes/interactive-engine/isolated-auth.js";
import { RemoteModelCatalog } from "../src/modes/interactive-engine/remote-model-catalog.js";
import "../src/modes/interactive/interactive-auth-routing.js";
import type { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { createRpcModelCatalog } from "../src/modes/rpc/rpc-model-catalog.js";
import { RpcProviderAuth } from "../src/modes/rpc/rpc-provider-auth.js";

const BUILTIN = "groq";
const EXTENSION = "corp-key";

afterEach(() => {
	vi.unstubAllEnvs();
});

function sessionOf(runtime: ModelRuntime): AgentSession {
	return {
		modelRuntime: runtime,
		scopedModels: [],
		refreshCurrentModelFromRegistry: async () => {},
	} as unknown as AgentSession;
}

/**
 * Interactive sessions run extensions only in the engine child. The host shares the credential store and
 * environment but has no extension providers, and learns about them from the engine's model catalog.
 */
async function isolatedRuntimes(apiKeyEnv: string) {
	vi.stubEnv("GROQ_API_KEY", apiKeyEnv);
	vi.stubEnv("CORP_KEY_API_KEY", apiKeyEnv);
	const store = new InMemoryAuthStorageBackend();
	const engine = await ModelRuntime.create({ credentials: AuthStorage.fromStorage(store), modelsPath: null });
	const template = engine.getModels(BUILTIN)[0];
	assert.ok(template);
	engine.registerProvider(EXTENSION, {
		name: "Corp Key",
		baseUrl: "https://corp.example.test/v1",
		api: template.api,
		apiKey: "$CORP_KEY_API_KEY",
		models: [{ ...template, id: "corp-model", name: "Corp Model" }],
	});
	await engine.getAvailable();
	const host = await ModelRuntime.create({ credentials: AuthStorage.fromStorage(store), modelsPath: null });
	await host.getAvailable();
	const engineSession = sessionOf(engine);
	const hostSession = sessionOf(host);
	const catalog = new RemoteModelCatalog({} as RpcClient);
	catalog.apply(createRpcModelCatalog(engineSession));
	catalog.patch(hostSession);
	return { engine, host, engineSession, hostSession, catalog };
}

function loginOptions(session: AgentSession) {
	return InteractiveModeBase.prototype.getLoginProviderOptions.call({ session } as InteractiveModeBase, "api_key");
}

function logoutOptions(session: AgentSession) {
	return InteractiveModeBase.prototype.getLogoutProviderOptions.call({ session } as InteractiveModeBase);
}

describe("an isolated host shows extension provider auth like a built-in's", () => {
	test("reports an extension provider's environment key as configured", async () => {
		const { host } = await isolatedRuntimes("fake-env-key");

		assert.deepEqual(host.getProviderAuthStatus(BUILTIN), {
			configured: true,
			source: "environment",
			label: "GROQ_API_KEY",
		});
		assert.deepEqual(host.getProviderAuthStatus(EXTENSION), {
			configured: true,
			source: "environment",
			label: "CORP_KEY_API_KEY",
		});
	});

	test("reports an extension provider without credentials as not configured", async () => {
		const { host } = await isolatedRuntimes("");

		assert.deepEqual(host.getProviderAuthStatus(BUILTIN), { configured: false });
		assert.deepEqual(host.getProviderAuthStatus(EXTENSION), { configured: false });
		assert.equal(host.hasConfiguredAuth(EXTENSION), false);
	});

	test("lists an extension API-key provider in /login", async () => {
		const { hostSession } = await isolatedRuntimes("");

		const options = loginOptions(hostSession);
		assert.ok(options.some((option) => option.id === BUILTIN));
		assert.deepEqual(
			options.find((option) => option.id === EXTENSION),
			{ id: EXTENSION, name: "Corp Key", authType: "api_key" },
		);
	});

	test("logs in to an extension API-key provider through the engine and then offers /logout", async () => {
		const { engine, engineSession, host, hostSession, catalog } = await isolatedRuntimes("");
		const prompts: string[] = [];
		const engineAuth = new RpcProviderAuth({
			open: async (request) => {
				prompts.push(request.title);
				return { value: "fake-corp-key" };
			},
		});
		const client = {
			loginProvider: (provider: string) => engineAuth.login(engineSession, provider),
		} as unknown as RpcClient;

		await loginIsolatedApiKeyProvider(hostSession, client, catalog, EXTENSION, {
			signal: new AbortController().signal,
			prompt: async () => {
				throw new Error("the engine asks for the key");
			},
			notify: () => {},
		});

		assert.deepEqual(prompts, ["Enter API key"]);
		assert.equal((await engine.getAuth(EXTENSION))?.auth.apiKey, "fake-corp-key");
		assert.deepEqual(host.getProviderAuthStatus(EXTENSION), { configured: true, source: "stored" });
		assert.deepEqual(
			logoutOptions(hostSession).find((option) => option.id === EXTENSION),
			{ id: EXTENSION, name: "Corp Key", authType: "api_key" },
		);
	});
});
