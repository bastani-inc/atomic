// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Api, AssistantMessageEvent, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { deriveCursorCredentialScope, type CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryError, CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

function jwtForSubject(subject: string, randomness: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject, randomness })).toString("base64url")}.signature`;
}
type CursorHost = Parameters<typeof registerCursorProvider>[0];

class TestCursorAuthService extends CursorAuthService {
	constructor(
		private readonly runLogin: CursorAuthService["login"],
		private readonly runRefresh: CursorAuthService["refreshToken"] = async (credentials) => credentials,
	) { super(); }
	override login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> { return this.runLogin(callbacks); }
	override refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> { return this.runRefresh(credentials); }
}
class TestCursorDiscoveryService extends CursorModelDiscoveryService {
	constructor(private readonly runDiscover: CursorModelDiscoveryService["discover"]) {
		super({ transport: new CursorMockTransport() });
	}
	override discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
		return this.runDiscover(accessToken, requestId, signal);
	}
}
const authService = (
	login: CursorAuthService["login"],
	refresh?: CursorAuthService["refreshToken"],
): CursorAuthService => new TestCursorAuthService(login, refresh);
const discoveryService = (discover: CursorModelDiscoveryService["discover"]): CursorModelDiscoveryService =>
	new TestCursorDiscoveryService(discover);
type CursorConfig = Parameters<CursorHost["registerProvider"]>[1];

class MemoryCursorCatalogCache implements CursorCatalogCache {
	saved: CursorModelCatalog[] = [];
	readonly #scoped = new Map<string, CursorModelCatalog>();

	constructor(private catalog: CursorModelCatalog | null = null) {
		if (catalog?.credentialScope) this.#scoped.set(catalog.credentialScope, catalog);
	}

	load(credentialScope?: string): CursorModelCatalog | null {
		return credentialScope ? this.#scoped.get(credentialScope) ?? null : this.catalog;
	}

	save(catalog: CursorModelCatalog, credentialScope?: string): void {
		const saved = credentialScope ? { ...catalog, credentialScope } : catalog;
		this.saved.push(saved);
		this.catalog = saved;
		if (credentialScope) this.#scoped.set(credentialScope, saved);
	}
}

class ThrowingCursorCatalogCache implements CursorCatalogCache {
	load(): CursorModelCatalog | null {
		return null;
	}

	save(_catalog: CursorModelCatalog): void {
		throw new Error("cursor catalog cache write failed");
	}
}

function makeHost(): {
	readonly host: CursorHost;
	readonly registrations: { readonly name: string; readonly config: CursorConfig }[];
	readonly lifecycleHandlers: Map<string, Array<(event?: unknown, context?: unknown) => Promise<void> | void>>;
	readonly shutdownHandlers: Array<(event?: unknown, context?: unknown) => Promise<void> | void>;
} {
	const registrations: { readonly name: string; readonly config: CursorConfig }[] = [];
	const lifecycleHandlers = new Map<string, Array<(event?: unknown, context?: unknown) => Promise<void> | void>>();
	const shutdownHandlers: Array<(event?: unknown, context?: unknown) => Promise<void> | void> = [];
	return {
		registrations,
		lifecycleHandlers,
		shutdownHandlers,
		host: {
			registerProvider(name, config) {
				registrations.push({ name, config });
			},
			on(event, handler) {
				const typedHandler = handler as (event?: unknown, context?: unknown) => Promise<void> | void;
				const handlers = lifecycleHandlers.get(event) ?? [];
				handlers.push(typedHandler);
				lifecycleHandlers.set(event, handlers);
				if (event === "session_shutdown") shutdownHandlers.push(typedHandler);
			},
		},
	};
}

function callbacks(signal?: AbortSignal): OAuthLoginCallbacks {
	return { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined, signal };
}

function streamModelFromConfig(config: CursorConfig): Model<Api> {
	const model = config.models[0] ?? {
		id: "test-exact-route",
		name: "Test Exact Route",
		api: config.api,
		baseUrl: config.baseUrl,
		input: ["text"],
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { cursorRouting: { "test-exact-route": { modelId: "test-exact-route", maxMode: false } } },
	};
	return { ...model, api: model.api ?? config.api, baseUrl: model.baseUrl ?? config.baseUrl, provider: "cursor" };
}

function streamContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

async function nextTick(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deterministicCursorConversationIdForSession(sessionId: string): string {
	const convKey = createHash("sha256").update(`conv:${sessionId}`).digest("hex").slice(0, 16);
	const hex = createHash("sha256").update(`cursor-conv-id:${convKey}`).digest("hex").slice(0, 32);
	const variantNibble = (0x8 | (Number.parseInt(hex[16] ?? "0", 16) & 0x3)).toString(16);
	return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `${variantNibble}${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}
describe("Cursor provider registration", () => {
	test("login and refresh use the production UUID generator, re-register live catalogs, and write the cache", async () => {
		const accessLive = jwtForSubject("login-live", "access-live");
		const accessRefreshed = jwtForSubject("login-live", "access-refreshed");
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const fakeAuth = authService(
			async () => ({ access: accessLive, refresh: "refresh-live", expires: 123 }),
			async (credentials) => ({ access: accessRefreshed, refresh: credentials.refresh, expires: 456 }),
		);
		const discoveryRequests: { readonly accessToken: string; readonly requestId: string; readonly signal?: AbortSignal }[] = [];
		const fakeDiscovery = discoveryService(async (accessToken, requestId, signal) => {
			discoveryRequests.push({ accessToken, requestId, signal });
			return {
				source: "live",
				fetchedAt: 42,
				models: [{ id: "composer-2", displayName: "Live Composer", supportsReasoning: true, contextWindow: 111, maxTokens: 222 }],
			};
		});
		const signal = new AbortController().signal;

		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
			catalogCache: cache,
		});
		const loginCredentials = await registrations.at(-1)?.config.oauth.login(callbacks(signal));
		const refreshCredentials = await registrations.at(-1)?.config.oauth.refreshToken(loginCredentials ?? { access: "", refresh: "", expires: 0 });
		await nextTick();

		assert.deepEqual(loginCredentials, { access: accessLive, refresh: "refresh-live", expires: 123 });
		assert.deepEqual(refreshCredentials, { access: accessRefreshed, refresh: "refresh-live", expires: 456 });
		assert.deepEqual(discoveryRequests.map((request) => request.accessToken), [accessLive, accessRefreshed]);
		assert.equal(discoveryRequests[0]?.signal?.aborted, false);
		for (const request of discoveryRequests) {
			assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
		}
		const liveRegistrations = registrations.filter((registration) => registration.config.models.length > 0);
		assert.equal(liveRegistrations.length, 2);
		for (const registration of liveRegistrations) {
			const liveComposer = registration.config.models.find((model) => model.id === "composer-2");
			assert.equal(liveComposer?.name, "Live Composer");
			assert.equal(liveComposer?.contextWindow, 200_000);
		}
		assert.equal(cache.saved.length, 2);
		assert.deepEqual(cache.saved.map((catalog) => catalog.fetchedAt), [42, 42]);
		await runtime.dispose();
	});
	test("login registers live-only models even when catalog cache persistence fails", async () => {
		const accessLive = jwtForSubject("login-cache-failure", "access-live");
		const { host, registrations } = makeHost();
		const fakeAuth = authService(async () => ({ access: accessLive, refresh: "refresh-live", expires: 123 }));
		const fakeDiscovery = discoveryService(async () => (
			{ source: "live", fetchedAt: 43, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] }
		));
		const refreshErrors: Error[] = [];
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
			catalogCache: new ThrowingCursorCatalogCache(),
			uuid: () => "login-cache-failure",
			onCatalogRefreshError: (error) => refreshErrors.push(error),
		});

		assert.deepEqual(await registrations[0]!.config.oauth.login(callbacks()), { access: accessLive, refresh: "refresh-live", expires: 123 });
		assert.equal(registrations.filter((registration) => registration.config.models.length > 0).length, 1);
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "composer-2.5"), true);
		assert.deepEqual(runtime.getCatalogRefreshStatus(), {
			state: "fresh",
			fetchedAt: 43,
			error: "Cursor model catalog cache persistence failed.",
		});
		assert.deepEqual(refreshErrors.map((error) => error.message), ["Cursor model catalog cache persistence failed."]);
		await runtime.dispose();
	});
	test("refresh returns rotated credentials when best-effort catalog discovery rejects", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const fakeAuth = authService(
			async () => { throw new Error("Unexpected Cursor login in test"); },
			async () => ({ access: "rotated-access-secret", refresh: "rotated-refresh-secret", expires: 789 }),
		);
		const fakeDiscovery = discoveryService(async () => {
			throw new CursorModelDiscoveryError("CursorApiRejected", "Cursor rejected rotated-access-secret");
		});

		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			uuid: () => "refresh-discovery",
		});
		const refreshed = await registrations[0]!.config.oauth.refreshToken({ access: "old-access", refresh: "old-refresh", expires: 0 });

		assert.deepEqual(refreshed, { access: "rotated-access-secret", refresh: "rotated-refresh-secret", expires: 789 });
		assert.equal(registrations.every((registration) => registration.config.models.length === 0), true);
		assert.equal(cache.saved.length, 0);
		await runtime.dispose();
	});
	test("surfaces cache persistence warnings during background and print refresh", async () => {
		const accessToken = jwtForSubject("cache-warning", "token");
		const notifications: string[] = [];
		const diagnostics: string[] = [];
		const discovery = discoveryService(async () => (
			{ source: "live", fetchedAt: 44, models: [{ id: "live-after-warning" }] }
		));
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(), discoveryService: discovery,
			catalogCache: new ThrowingCursorCatalogCache(), uuid: () => "cache-warning",
			now: () => 44,
			onCatalogDiagnostic: (message) => diagnostics.push(message),
		});
		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		const registry = { getApiKeyForProvider: async () => accessToken };
		await handler({}, { mode: "tui", ui: { notify: (message: string) => notifications.push(message) }, modelRegistry: registry });
		await nextTick();
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "live-after-warning"), true);
		assert.match(notifications[0] ?? "", /cache persistence failed/u);
		await handler({}, { mode: "print", modelRegistry: registry });
		assert.match(diagnostics[0] ?? "", /cache persistence failed/u);
		await runtime.dispose();
	});
	test("a later current nonempty first-use discovery may repopulate after authoritative empty", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const accessToken = jwtForSubject("retry-account", "token");
		let attempts = 0;
		const fakeDiscovery = discoveryService(async () => {
			attempts += 1;
			if (attempts === 1) return { source: "live", fetchedAt: 100, models: [] };
			return { source: "live", fetchedAt: 101, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
		});
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			uuid: () => `retry-${attempts}`,
			now: () => 101,
			resolveCurrentAccessToken: () => accessToken,
		});
		const config = registrations[0]!.config;

		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: accessToken }));
		await nextTick();
		assert.equal(attempts, 2);
		assert.deepEqual(cache.saved[0]?.models, []);
		assert.equal(cache.saved.at(-1)?.models[0]?.id, "composer-2.5");

		await collectEvents(registrations.at(-1)!.config.streamSimple(streamModelFromConfig(registrations.at(-1)!.config), streamContext(), { apiKey: accessToken }));
		await nextTick();
		assert.equal(attempts, 2);
		assert.equal(registrations.at(-1)?.config.models.find((model) => model.id === "composer-2.5")?.reasoning, false);
		await runtime.dispose();
	});
	test("superseded empty and nonempty refreshes cannot overwrite the active catalog", async () => {
		const tokenA = jwtForSubject("account-a", "token");
		const tokenB = jwtForSubject("account-b", "token");
		const { host, registrations, lifecycleHandlers } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const resolvers = new Map<string, Array<(catalog: CursorModelCatalog) => void>>();
		const discovery = discoveryService((accessToken) =>
			new Promise((resolve) => resolvers.set(accessToken, [...resolvers.get(accessToken) ?? [], resolve]))
		);
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(), discoveryService: discovery, catalogCache: cache, now: () => 100, uuid: () => "refresh",
		});
		const start = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(start);
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => tokenA } });
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => tokenB } });
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => tokenA } });
		resolvers.get(tokenA)?.[1]?.({ source: "live", fetchedAt: 110, models: [{ id: "model-a-new" }] });
		await nextTick();
		resolvers.get(tokenB)?.[0]?.({ source: "live", fetchedAt: 100, models: [] });
		resolvers.get(tokenA)?.[0]?.({ source: "live", fetchedAt: 90, models: [{ id: "model-a-old" }] });
		await nextTick();
		assert.deepEqual(cache.saved.map((catalog) => catalog.models[0]?.id), ["model-a-new"]);
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "model-a-new"), true);
		await runtime.dispose();
	});
	test("activating a fresh scoped cache supersedes another account's in-flight discovery", async () => {
		const tokenA = jwtForSubject("account-a", "token");
		const tokenB = jwtForSubject("account-b", "token");
		const scopeB = deriveCursorCredentialScope(tokenB);
		assert.ok(scopeB);
		const cache = new MemoryCursorCatalogCache({ source: "live", fetchedAt: 100, credentialScope: scopeB, models: [{ id: "cached-b" }] });
		let resolveA: ((catalog: CursorModelCatalog) => void) | undefined;
		const discovery = discoveryService(() => new Promise((resolve) => { resolveA = resolve; }));
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: discovery, catalogCache: cache, now: () => 100, catalogCacheTtlMs: 100,
			uuid: () => "account-race",
		});
		const start = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(start);
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => tokenA } });
		await nextTick();
		await start({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => tokenB } });
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "cached-b"), true);
		resolveA?.({ source: "live", fetchedAt: 101, models: [{ id: "late-a" }] });
		await nextTick();
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "late-a"), false);
		assert.equal(cache.saved.some((catalog) => catalog.models.some((model) => model.id === "late-a")), false);
		await runtime.dispose();
	});
	test("dispose fences an abort-ignoring authoritative empty rediscovery that resolves late", async () => {
		const { host, registrations, lifecycleHandlers } = makeHost();
		const discoverySignals: AbortSignal[] = [];
		let resolveDiscovery: ((catalog: CursorModelCatalog) => void) | undefined;
		const fakeDiscovery = discoveryService(async (_accessToken, _requestId, signal) => {
			if (signal) discoverySignals.push(signal);
			return new Promise<CursorModelCatalog>((resolve) => { resolveDiscovery = resolve; });
		});
		const cache = new MemoryCursorCatalogCache();
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			catalogDiscoveryDisposeTimeoutMs: 10,
			uuid: () => "dispose-rediscovery",
		});
		const start = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(start);
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => jwtForSubject("dispose", "token") } });
		await nextTick();
		assert.equal(discoverySignals.length, 1);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				runtime.dispose(),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error("runtime dispose hung on cursor rediscovery")), 250);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		assert.equal(discoverySignals[0]?.aborted, true);
		resolveDiscovery?.({ source: "live", fetchedAt: 500, models: [] });
		await nextTick();
		assert.deepEqual(registrations.at(-1)?.config.models, []);
		assert.equal(cache.saved.length, 0);
		assert.notEqual(runtime.getCatalogRefreshStatus().state, "fresh");
	});
	test("login rejects rather than presenting estimated models after authenticated discovery fails", async () => {
		const accessToken = "authenticated-access-secret";
		const fakeAuth = authService(async () => ({ access: accessToken, refresh: "refresh-live", expires: 123 }));
		const { host, registrations } = makeHost();
		const discovery = discoveryService(async () => {
			throw new CursorModelDiscoveryError("CursorApiRejected", `Cursor rejected ${accessToken}`);
		});
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(), authService: fakeAuth, discoveryService: discovery,
			catalogCache: new MemoryCursorCatalogCache(), uuid: () => "request-failure",
		});

		await assert.rejects(
			registrations[0]!.config.oauth.login(callbacks()),
			(error: Error) => {
				assert.match(error.message, /authentication succeeded, but authenticated model discovery failed/u);
				assert.doesNotMatch(error.message, new RegExp(accessToken, "u"));
				return true;
			},
		);
		assert.equal(registrations.at(-1)?.config.models.length, 0);
		await runtime.dispose();
	});
	test("authenticated discovery ignores unscoped or future cache freshness and awaits stale refresh", async () => {
		let now = 1_050;
		const resolvers: Array<(catalog: CursorModelCatalog) => void> = [];
		const discovery = discoveryService(() => new Promise((resolve) => resolvers.push(resolve)));
		const cache = new MemoryCursorCatalogCache({ source: "live", fetchedAt: 2_000, models: [{ id: "cached", displayName: "Cached" }] });
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), discoveryService: discovery, catalogCache: cache, catalogCacheTtlMs: 100, now: () => now, uuid: () => "ttl" });
		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		const context = { mode: "print" as const, modelRegistry: { getApiKeyForProvider: async () => "token" } };
		const initial = Promise.resolve(handler({}, context));
		await nextTick();
		assert.equal(resolvers.length, 1, "a credential-free cache cannot prove account freshness");
		resolvers[0]?.({ source: "live", fetchedAt: now, models: [{ id: "initial-live", displayName: "Initial live" }] });
		await initial;
		await handler({}, context);
		assert.equal(resolvers.length, 1, "same-credential refresh stays deduplicated within the TTL");

		now = 1_151;
		let settled = false;
		const pending = Promise.resolve(handler({}, context)).then(() => { settled = true; });
		await nextTick();
		assert.equal(settled, false, "list timing must await stale discovery");
		resolvers[1]?.({ source: "live", fetchedAt: now, models: [{ id: "fresh", displayName: "Fresh" }] });
		await pending;
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "fresh"), true);
		await runtime.dispose();
	});

	test("print mode rejects a stale scoped cache after failed refresh", async () => {
		const surfaced: string[] = [];
		const diagnostics: string[] = [];
		const discovery = discoveryService(async () => { throw new Error("refresh unavailable"); });
		const notifications: string[] = [];
		const token = jwtForSubject("cached-account", "token");
		const scope = deriveCursorCredentialScope(token);
		assert.ok(scope);
		const cache = new MemoryCursorCatalogCache({ source: "live", fetchedAt: 1, credentialScope: scope, models: [{ id: "cached", displayName: "Cached" }] });
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(), discoveryService: discovery, catalogCache: cache,
			catalogCacheTtlMs: 1, now: () => 10, onCatalogRefreshError: (error) => surfaced.push(error.message),
			onCatalogDiagnostic: (message) => diagnostics.push(message), uuid: () => "failed",
		});
		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		await handler({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => token } });
		assert.deepEqual(diagnostics, ["Cursor model refresh warning: refresh unavailable"]);
		await handler({}, { mode: "tui", ui: { notify: (message: string) => notifications.push(message) }, modelRegistry: { getApiKeyForProvider: async () => token } });
		await nextTick();
		assert.match(notifications[0] ?? "", /refresh unavailable/u);
		assert.deepEqual(surfaced, ["refresh unavailable", "refresh unavailable"]);
		assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "failed", error: "refresh unavailable" });
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "cached"), false);
		await runtime.dispose();
	});
	test("a stale nonempty refresh cannot overwrite a newer authoritative empty catalog", async () => {
		const tokenA = jwtForSubject("stale-nonempty-a", "token");
		const tokenB = jwtForSubject("current-empty-b", "token");
		const pending = new Map<string, PromiseWithResolvers<CursorModelCatalog>>();
		const discovery = discoveryService((accessToken) => {
			const gate = Promise.withResolvers<CursorModelCatalog>();
			pending.set(accessToken, gate);
			return gate.promise;
		});
		const cache = new MemoryCursorCatalogCache();
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), discoveryService: discovery, catalogCache: cache, now: () => 12 });
		const start = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(start);
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => tokenA } });
		await start({}, { mode: "tui", modelRegistry: { getApiKeyForProvider: async () => tokenB } });
		pending.get(tokenB)?.resolve({ source: "live", fetchedAt: 12, models: [] });
		await nextTick();
		pending.get(tokenA)?.resolve({ source: "live", fetchedAt: 13, models: [{ id: "stale-a-route" }] });
		await nextTick();
		assert.deepEqual(registrations.at(-1)?.config.models, []);
		assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "empty", fetchedAt: 12 });
		assert.deepEqual(cache.saved.map((entry) => entry.models), [[]]);
		await runtime.dispose();
	});
});
