import assert from "node:assert/strict";
import type { OAuthCredential } from "@bastani/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, test, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage, InMemoryAuthStorageBackend } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { RemoteModelCatalog } from "../src/modes/interactive-engine/remote-model-catalog.js";
import "../src/modes/interactive/interactive-auth-routing.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import type { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { createRpcModelCatalog } from "../src/modes/rpc/rpc-model-catalog.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { stubOfflineModelCatalog } from "./helpers/offline-model-catalog.js";

const BUILTIN_KEY = "groq";
const EXTENSION_KEY = "corp-key";
const BUILTIN_OAUTH = "anthropic";
const EXTENSION_OAUTH = "corp-oauth";
const MODEL_SELECTOR_HINT = "Only showing models from configured providers. Use /login to add providers.";

function storedLogin(): OAuthCredential {
	return { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 60 * 60 * 1000 };
}

function sessionOf(runtime: ModelRuntime): AgentSession {
	return {
		modelRuntime: runtime,
		scopedModels: [],
		refreshCurrentModelFromRegistry: async () => {},
	} as unknown as AgentSession;
}

/**
 * Interactive mode runs extensions only in the engine child; the host that renders /login and /model shares
 * the credential store and environment and learns about extension providers from the engine's catalog.
 */
async function isolatedRuntimes(options: { apiKeyEnv: string; storedOAuth: boolean }) {
	vi.stubEnv("GROQ_API_KEY", options.apiKeyEnv);
	vi.stubEnv("CORP_KEY_API_KEY", options.apiKeyEnv);
	vi.stubEnv("ANTHROPIC_API_KEY", "");
	vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
	stubOfflineModelCatalog();
	const store = new InMemoryAuthStorageBackend();
	const credentials = () => AuthStorage.fromStorage(store);
	if (options.storedOAuth) {
		for (const provider of [BUILTIN_OAUTH, EXTENSION_OAUTH])
			await credentials().modify(provider, async () => storedLogin());
	}
	const engine = await ModelRuntime.create({ credentials: credentials(), modelsPath: null, allowModelNetwork: false });
	const template = engine.getModels(BUILTIN_KEY)[0];
	assert.ok(template);
	engine.registerProvider(EXTENSION_KEY, {
		name: "Corp Key",
		baseUrl: "https://corp.example.test/v1",
		api: template.api,
		apiKey: "$CORP_KEY_API_KEY",
		models: [{ ...template, id: "corp-key-model", name: "Corp Key Model" }],
	});
	engine.registerProvider(EXTENSION_OAUTH, {
		baseUrl: "https://corp.example.test/v1",
		api: template.api,
		oauth: {
			name: "Corp OAuth",
			login: async () => storedLogin(),
			refreshToken: async (credential) => credential,
			getApiKey: (credential) => credential.access,
		},
		models: [{ ...template, id: "corp-oauth-model", name: "Corp OAuth Model" }],
	});
	await engine.getAvailable();
	const engineSession = sessionOf(engine);
	const host = await ModelRuntime.create({ credentials: credentials(), modelsPath: null, allowModelNetwork: false });
	await host.getAvailable();
	const hostSession = sessionOf(host);
	const client = {
		refreshModels: async () => ({ aborted: false, errors: [], ...createRpcModelCatalog(engineSession) }),
	} as unknown as RpcClient;
	const catalog = new RemoteModelCatalog(client);
	catalog.apply(createRpcModelCatalog(engineSession));
	catalog.patch(hostSession);
	return { engineSession, hostSession };
}

/** The `/login` status suffix the selector renders for each provider's options. */
function loginStatuses(session: AgentSession, providers: string[]): Record<string, string[]> {
	const options = InteractiveModeBase.prototype.getLoginProviderOptions.call({ session } as InteractiveModeBase);
	const statuses: Record<string, string[]> = {};
	for (const provider of providers) {
		const providerOptions = options.filter((option) => option.id === provider);
		assert.ok(providerOptions.length > 0, `${provider} is offered in /login`);
		const selector = new OAuthSelectorComponent(
			"login",
			session.modelRuntime,
			providerOptions,
			() => {},
			() => {},
		);
		statuses[provider] = selector
			.render(120)
			.map((line) => stripAnsi(line).trim())
			.flatMap((line) => line.match(/(✓ .*|• not configured)$/)?.[0] ?? []);
	}
	return statuses;
}

/** The providers whose models `/model` lists once its background catalog refresh settles, and whether it shows the hint. */
async function modelSelectorView(runtime: ModelRuntime, providers: string[]) {
	const listed: string[] = [];
	let hint = true;
	for (const provider of providers) {
		const selector = new ModelSelectorComponent(
			{ requestRender: () => {} } as unknown as TUI,
			undefined,
			{ getDefaultProvider: () => undefined, getDefaultModel: () => undefined } as unknown as SettingsManager,
			runtime,
			[],
			() => {},
			() => {},
			provider,
		);
		const rendered = () => stripAnsi(selector.render(200).join("\n"));
		// The refresh is offline, so it settles in milliseconds; vi.waitFor's default one second is ample.
		await vi.waitFor(() => assert.match(rendered(), /Model catalogs refreshed\./));
		hint &&= rendered().includes(MODEL_SELECTOR_HINT);
		if (rendered().includes(`[${provider}]`)) listed.push(provider);
		selector.dispose();
	}
	return { hint, listed };
}

const PROVIDERS = [BUILTIN_KEY, EXTENSION_KEY, BUILTIN_OAUTH, EXTENSION_OAUTH];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

/** The engine runs `/login` and `/model` itself outside interactive mode; the isolated host renders them in it. */
async function viewsOf(options: { apiKeyEnv: string; storedOAuth: boolean }) {
	const { engineSession, hostSession } = await isolatedRuntimes(options);
	const views = [];
	for (const session of [engineSession, hostSession]) {
		views.push({
			login: loginStatuses(session, PROVIDERS),
			model: await modelSelectorView(session.modelRuntime, PROVIDERS),
		});
	}
	return views;
}

describe("/login and /model treat extension providers like built-in ones", () => {
	test("an environment API key is configured and an OAuth provider without a login is not", async () => {
		const expected = {
			login: {
				[BUILTIN_KEY]: ["✓ env: GROQ_API_KEY"],
				[EXTENSION_KEY]: ["✓ env: CORP_KEY_API_KEY"],
				[BUILTIN_OAUTH]: ["• not configured", "• not configured"],
				[EXTENSION_OAUTH]: ["• not configured"],
			},
			model: { hint: true, listed: [BUILTIN_KEY, EXTENSION_KEY] },
		};
		assert.deepEqual(await viewsOf({ apiKeyEnv: "fake-env-key", storedOAuth: false }), [expected, expected]);
	});

	test("a stored OAuth login is configured and an API-key provider without a key is not", async () => {
		const expected = {
			login: {
				[BUILTIN_KEY]: ["• not configured"],
				[EXTENSION_KEY]: ["• not configured"],
				[BUILTIN_OAUTH]: ["✓ subscription configured", "✓ subscription configured"],
				[EXTENSION_OAUTH]: ["✓ subscription configured"],
			},
			model: { hint: true, listed: [BUILTIN_OAUTH, EXTENSION_OAUTH] },
		};
		assert.deepEqual(await viewsOf({ apiKeyEnv: "", storedOAuth: true }), [expected, expected]);
	});
});
