import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ProviderConfig } from "@bastani/atomic";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import registerCursorProvider, { createCursorProviderExtension } from "../index.ts";
import { createCursorDebugLogger, redactCursorDebugValue } from "../debug.ts";
import type { CursorProxyBridge } from "../proxy.ts";

interface HandlerContext {
	sessionManager: { getSessionId(): string };
	modelRegistry?: { authStorage?: { get(provider: string): unknown; getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined> } };
}

type Registration = { name: string; config: ProviderConfig };
type Handler = (event: { payload?: unknown; provider?: string; modelId?: string }, ctx: HandlerContext) => unknown;

function createPiStub(): { pi: ExtensionAPI; registrations: Registration[]; unregisters: string[]; handlers: Map<string, Handler[]> } {
	const registrations: Registration[] = [];
	const unregisters: string[] = [];
	const handlers = new Map<string, Handler[]>();
	const pi = {
		registerProvider(name: string, config: ProviderConfig) {
			registrations.push({ name, config });
		},
		unregisterProvider(name: string) {
			unregisters.push(name);
		},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	return { pi, registrations, unregisters, handlers };
}

function noopBridge(): CursorProxyBridge {
	return { async *chatCompletions() {} };
}

async function emitSessionStart(handlers: Map<string, Handler[]>, ctx: HandlerContext): Promise<void> {
	await Promise.all((handlers.get("session_start") ?? []).map((handler) => handler({}, ctx)));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Cursor provider facade", () => {
	it("registers auth-only provider at startup without fake selectable models", async () => {
		const { pi, registrations } = createPiStub();
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
		});

		await extension(pi);

		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.name).toBe("cursor");
		expect(registrations[0]?.config).toMatchObject({
			name: "Cursor",
			oauth: expect.objectContaining({ name: "Cursor" }),
		});
		expect(registrations[0]?.config.models ?? []).toHaveLength(0);
		expect(registrations[0]?.config.baseUrl).toBeUndefined();
		expect(registrations[0]?.config.api).toBeUndefined();
	});

	it("re-registers discovered live models after login and refresh", async () => {
		const { pi, registrations } = createPiStub();
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async () => ({
				source: "live",
				models: [{ id: "live-model", name: "Live Model", reasoning: true, contextWindow: 10, maxTokens: 5 }],
			}),
			login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 60_000 }),
			refresh: async () => ({ access: "refresh-access", refresh: "refresh-refresh", expires: Date.now() + 60_000 }),
		});

		await extension(pi);
		const oauth = registrations[0]?.config.oauth;
		expect(oauth).toBeDefined();
		await oauth!.login({} as never);
		await oauth!.refreshToken({ access: "old", refresh: "old-refresh", expires: 0 });

		expect(registrations.map((registration) => registration.config.models?.[0]?.id ?? null)).toEqual([
			null,
			"live-model",
			"live-model",
		]);
		expect(registrations.at(-1)?.config).toMatchObject({
			baseUrl: "http://127.0.0.1:31337/v1",
			api: "openai-completions",
			authHeader: false,
		});
	});

	it("re-registers auth-only when discovery has no live or cached models", async () => {
		const { pi, registrations, unregisters } = createPiStub();
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async () => ({ source: "fallback", models: [], warning: "Cursor returned no usable models" }),
			login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 60_000 }),
		});

		await extension(pi);
		await registrations[0]!.config.oauth!.login({} as never);

		expect(unregisters).toEqual(["cursor"]);
		expect(registrations).toHaveLength(2);
		expect(registrations.at(-1)?.config.models ?? []).toHaveLength(0);
		expect(registrations.at(-1)?.config.baseUrl).toBeUndefined();
	});

	it("clears token A models and re-registers auth-only when token B discovery fails", async () => {
		const { pi, registrations, unregisters } = createPiStub();
		const fallbackModelsByToken: Record<string, string[]> = {};
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async (accessToken, _bridge, fallbackModels) => {
				fallbackModelsByToken[accessToken] = fallbackModels.map((model) => model.id);
				if (accessToken === "token-a") return { source: "live", models: [{ id: "model-a", name: "Model A", reasoning: false, contextWindow: 10, maxTokens: 5 }] };
				return { source: "fallback", models: [], warning: "Cursor discovery failed" };
			},
			login: async () => ({ access: "token-a", refresh: "refresh-a", expires: Date.now() + 60_000 }),
			refresh: async () => ({ access: "token-b", refresh: "refresh-b", expires: Date.now() + 60_000 }),
		});

		await extension(pi);
		const oauth = registrations[0]!.config.oauth!;
		await oauth.login({} as never);
		await oauth.refreshToken!({ access: "token-a", refresh: "refresh-a", expires: Date.now() + 60_000 });

		expect(fallbackModelsByToken["token-a"]).toEqual([]);
		expect(fallbackModelsByToken["token-b"]).toEqual([]);
		expect(unregisters).toEqual(["cursor"]);
		expect(registrations.map((registration) => registration.config.models?.[0]?.id ?? null)).toEqual([null, "model-a", null]);
		expect(registrations.at(-1)?.config.baseUrl).toBeUndefined();
	});

	it("allows same-token discovery failures to reuse current registered models as fallback", async () => {
		const { pi, registrations, unregisters } = createPiStub();
		const fallbackModelIds: string[][] = [];
		let discoverCalls = 0;
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async (_accessToken, _bridge, fallbackModels) => {
				fallbackModelIds.push(fallbackModels.map((model) => model.id));
				discoverCalls++;
				if (discoverCalls === 1) return { source: "live", models: [{ id: "model-a", name: "Model A", reasoning: false, contextWindow: 10, maxTokens: 5 }] };
				return { source: "fallback", models: fallbackModels, warning: "Cursor discovery failed" };
			},
			login: async () => ({ access: "token-a", refresh: "refresh-a", expires: Date.now() + 60_000 }),
			refresh: async () => ({ access: "token-a", refresh: "refresh-a-2", expires: Date.now() + 60_000 }),
		});

		await extension(pi);
		const oauth = registrations[0]!.config.oauth!;
		await oauth.login({} as never);
		await oauth.refreshToken!({ access: "token-a", refresh: "refresh-a", expires: Date.now() + 60_000 });

		expect(fallbackModelIds).toEqual([[], ["model-a"]]);
		expect(unregisters).toEqual([]);
		expect(registrations.map((registration) => registration.config.models?.[0]?.id ?? null)).toEqual([null, "model-a", "model-a"]);
	});

	it("hydrates stored unexpired Cursor OAuth credentials on session_start", async () => {
		const { pi, registrations, handlers } = createPiStub();
		let discoveredAccessToken = "";
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async (accessToken) => {
				discoveredAccessToken = accessToken;
				return { source: "live", models: [{ id: "stored-model", name: "Stored Model", reasoning: false, contextWindow: 10, maxTokens: 5 }] };
			},
		});

		await extension(pi);
		await emitSessionStart(handlers, {
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { authStorage: { get: () => ({ type: "oauth", access: "stored-access", refresh: "stored-refresh", expires: Date.now() + 60_000 }), getApiKey: async () => undefined } },
		});

		expect(discoveredAccessToken).toBe("stored-access");
		expect(registrations.map((registration) => registration.config.models?.[0]?.id ?? null)).toEqual([null, "stored-model"]);
	});

	it("keeps startup auth-only when no stored Cursor OAuth credentials exist", async () => {
		const { pi, registrations, handlers } = createPiStub();
		let discoverCalls = 0;
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async () => {
				discoverCalls++;
				return { source: "live", models: [] };
			},
		});

		await extension(pi);
		await emitSessionStart(handlers, {
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { authStorage: { get: () => undefined, getApiKey: async () => undefined } },
		});

		expect(discoverCalls).toBe(0);
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.config.models ?? []).toHaveLength(0);
	});

	it("uses AuthStorage refresh path for expired stored Cursor credentials without duplicate same-process discovery", async () => {
		const { pi, registrations, handlers } = createPiStub();
		let getApiKeyCalls = 0;
		let discoverCalls = 0;
		const discoveredAccessTokens: string[] = [];
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			refresh: async () => ({ access: "refreshed-access", refresh: "refreshed-refresh", expires: Date.now() + 60_000 }),
			discoverModels: async (accessToken) => {
				discoverCalls++;
				discoveredAccessTokens.push(accessToken);
				return { source: "live", models: [{ id: "refreshed-model", name: "Refreshed Model", reasoning: false, contextWindow: 10, maxTokens: 5 }] };
			},
		});

		await extension(pi);
		const oauth = registrations[0]!.config.oauth!;
		await emitSessionStart(handlers, {
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: {
				authStorage: {
					get: () => ({ type: "oauth", access: "expired-access", refresh: "expired-refresh", expires: Date.now() - 1 }),
					getApiKey: async (_provider, options) => {
						getApiKeyCalls++;
						expect(options).toEqual({ includeFallback: false });
						const refreshed = await oauth.refreshToken!({ access: "expired-access", refresh: "expired-refresh", expires: 0 });
						return oauth.getApiKey!(refreshed);
					},
				},
			},
		});

		expect(getApiKeyCalls).toBe(1);
		expect(discoverCalls).toBe(1);
		expect(discoveredAccessTokens).toEqual(["refreshed-access"]);
		expect(registrations.at(-1)?.config.models?.[0]?.id).toBe("refreshed-model");
	});

	it("re-registers discovered models after another process refreshes expired stored Cursor credentials", async () => {
		const { pi, registrations, handlers } = createPiStub();
		let getApiKeyCalls = 0;
		let storedCredentials = { type: "oauth", access: "expired-access", refresh: "expired-refresh", expires: Date.now() - 1 };
		const discoveredAccessTokens: string[] = [];
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async (accessToken) => {
				discoveredAccessTokens.push(accessToken);
				return { source: "live", models: [{ id: "cross-process-model", name: "Cross Process Model", reasoning: false, contextWindow: 10, maxTokens: 5 }] };
			},
		});

		await extension(pi);
		await emitSessionStart(handlers, {
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: {
				authStorage: {
					get: () => storedCredentials,
					getApiKey: async (_provider, options) => {
						getApiKeyCalls++;
						expect(options).toEqual({ includeFallback: false });
						storedCredentials = { type: "oauth", access: "other-process-access", refresh: "other-process-refresh", expires: Date.now() + 60_000 };
						return "proxy-secret-from-storage";
					},
				},
			},
		});

		expect(getApiKeyCalls).toBe(1);
		expect(discoveredAccessTokens).toEqual(["other-process-access"]);
		expect(registrations.map((registration) => registration.config.models?.[0]?.id ?? null)).toEqual([null, "cross-process-model"]);
	});

	it("dedupes duplicate session_start hydration for the same token", async () => {
		const { pi, registrations, handlers } = createPiStub();
		let discoverCalls = 0;
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async () => {
				discoverCalls++;
				return { source: "live", models: [{ id: "stored-model", name: "Stored Model", reasoning: false, contextWindow: 10, maxTokens: 5 }] };
			},
		});

		await extension(pi);
		const ctx = {
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { authStorage: { get: () => ({ type: "oauth", access: "stored-access", refresh: "stored-refresh", expires: Date.now() + 60_000 }), getApiKey: async () => undefined } },
		};
		await emitSessionStart(handlers, ctx);
		await emitSessionStart(handlers, ctx);

		expect(discoverCalls).toBe(1);
		expect(registrations.map((registration) => registration.config.models?.[0]?.id ?? null)).toEqual([null, "stored-model"]);
	});

	it("keeps auth-only registration and redacted warning when startup discovery fails", async () => {
		const { pi, registrations, unregisters, handlers } = createPiStub();
		const debugEvents: unknown[] = [];
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			debug: (event, details) => debugEvents.push({ event, details }),
			discoverModels: async () => ({ source: "fallback", models: [], warning: "discovery failed without token" }),
		});

		await extension(pi);
		await emitSessionStart(handlers, {
			sessionManager: { getSessionId: () => "session" },
			modelRegistry: { authStorage: { get: () => ({ type: "oauth", access: "secret-access-token", refresh: "secret-refresh", expires: Date.now() + 60_000 }), getApiKey: async () => undefined } },
		});

		expect(unregisters).toEqual(["cursor"]);
		expect(registrations).toHaveLength(2);
		expect(registrations.at(-1)?.config.models ?? []).toHaveLength(0);
		expect(JSON.stringify(debugEvents)).not.toContain("secret-access-token");
		expect(JSON.stringify(debugEvents)).not.toContain("secret-refresh");
		expect(JSON.stringify(debugEvents)).toContain("model-discovery-warning");
	});

	it("injects the real Atomic session id before cursor model requests", async () => {
		const { pi, registrations, handlers } = createPiStub();
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async () => ({
				source: "live",
				models: [{ id: "live-model", name: "Live Model", reasoning: false, contextWindow: 10, maxTokens: 5 }],
			}),
			login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 60_000 }),
		});

		await extension(pi);
		await registrations[0]!.config.oauth!.login({} as never);
		const result = handlers.get("before_provider_request")![0]!({ payload: { model: "live-model", messages: [] }, provider: "cursor", modelId: "live-model" }, {
			sessionManager: { getSessionId: () => "atomic-session-123" },
		});

		expect(result).toMatchObject({ model: "live-model", pi_session_id: "atomic-session-123" });
	});

	it("does not inject session ids for non-Cursor provider requests", async () => {
		const { pi, registrations, handlers } = createPiStub();
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			discoverModels: async () => ({
				source: "live",
				models: [{ id: "live-model", name: "Live Model", reasoning: false, contextWindow: 10, maxTokens: 5 }],
			}),
			login: async () => ({ access: "login-access", refresh: "login-refresh", expires: Date.now() + 60_000 }),
		});

		await extension(pi);
		await registrations[0]!.config.oauth!.login({} as never);
		const result = handlers.get("before_provider_request")![0]!(
			{ payload: { model: "live-model", messages: [] }, provider: "openai", modelId: "live-model" },
			{ sessionManager: { getSessionId: () => "atomic-session-123" } },
		);

		expect(result).toBeUndefined();
	});

	it("clears Cursor bridge state for the current Atomic session after successful tree navigation", async () => {
		const { pi, handlers } = createPiStub();
		const clearedSessions: string[] = [];
		const debugEvents: string[] = [];
		const extension = createCursorProviderExtension({
			bridge: { async *chatCompletions() {}, clearSession: (sessionId: string) => clearedSessions.push(sessionId) },
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
			debug: (event) => debugEvents.push(event),
		});

		await extension(pi);
		handlers.get("session_before_tree")![0]!({}, { sessionManager: { getSessionId: () => "atomic-session-before" } });
		handlers.get("session_tree")![0]!({}, { sessionManager: { getSessionId: () => "atomic-session-current" } });

		expect(clearedSessions).toEqual(["atomic-session-current"]);
		expect(debugEvents).toContain("session-tree-boundary-pending");
		expect(debugEvents.filter((event) => event === "session-state-cleared")).toHaveLength(1);
	});

	it("does not require injected test bridges to expose clearSession", async () => {
		const { pi, handlers } = createPiStub();
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async () => ({ baseUrl: "http://127.0.0.1:31337/v1", close() {} }),
		});

		await extension(pi);
		expect(() => handlers.get("session_tree")![0]!({}, { sessionManager: { getSessionId: () => "atomic-session-current" } })).not.toThrow();
	});

	it("returns the process proxy secret as the provider API key without exposing the Cursor access token", async () => {
		const { pi, registrations } = createPiStub();
		let observedSecret = "";
		const extension = createCursorProviderExtension({
			bridge: noopBridge(),
			startProxy: async (_bridge, _accessToken, proxySecret) => {
				observedSecret = proxySecret();
				return { baseUrl: "http://127.0.0.1:31337/v1", close() {} };
			},
		});

		await extension(pi);
		const apiKey = registrations[0]!.config.oauth!.getApiKey!({ access: "cursor-access-token" } as OAuthCredentials);

		expect(apiKey).toBe(observedSecret);
		expect(apiKey).not.toBe("cursor-access-token");
		expect(apiKey.length).toBeGreaterThan(10);
	});

	it("redacts credentials, authorization headers, and base64-ish payloads in debug output", () => {
		const redacted = redactCursorDebugValue({
			access: "access-token-value",
			refreshToken: "refresh-token-value",
			headers: { authorization: "Bearer secret" },
			image: "data:image/png;base64," + "a".repeat(80),
		});

		expect(JSON.stringify(redacted)).not.toContain("access-token-value");
		expect(JSON.stringify(redacted)).not.toContain("refresh-token-value");
		expect(JSON.stringify(redacted)).not.toContain("Bearer secret");
		expect(JSON.stringify(redacted)).toContain("[REDACTED");

		const lines: string[] = [];
		const logger = createCursorDebugLogger({ enabled: true, sink: (line) => lines.push(line) });
		logger("refresh", { accessToken: "super-secret-token" });
		expect(lines.join("\n")).not.toContain("super-secret-token");
	});
});
