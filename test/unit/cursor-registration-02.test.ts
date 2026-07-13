// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Api, AssistantMessageEvent, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { deriveCursorCredentialScope, type CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryError, type CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver.ts";

function jwtForSubject(subject: string, randomness: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject, randomness })).toString("base64url")}.signature`;
}
type CursorHost = Parameters<typeof registerCursorProvider>[0];
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
	const model = config.models[0];
	assert.ok(model);
	return {
		...model,
		api: model.api ?? config.api,
		baseUrl: model.baseUrl ?? config.baseUrl,
		provider: "cursor",
	};
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
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const fakeAuth = {
			async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				return { access: "access-live", refresh: "refresh-live", expires: 123 };
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return { access: "access-refreshed", refresh: credentials.refresh, expires: 456 };
			},
		} as unknown as CursorAuthService;
		const discoveryRequests: { readonly accessToken: string; readonly requestId: string; readonly signal?: AbortSignal }[] = [];
		const fakeDiscovery = {
			async discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
				discoveryRequests.push({ accessToken, requestId, signal });
				return {
					source: "live",
					fetchedAt: 42,
					models: [{ id: "composer-2", displayName: "Live Composer", supportsReasoning: true, contextWindow: 111, maxTokens: 222 }],
				};
			},
		} as unknown as CursorModelDiscoveryService;
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

		assert.deepEqual(loginCredentials, { access: "access-live", refresh: "refresh-live", expires: 123 });
		assert.deepEqual(refreshCredentials, { access: "access-refreshed", refresh: "refresh-live", expires: 456 });
		assert.equal(registrations.length, 3);
		assert.deepEqual(discoveryRequests.map((request) => request.accessToken), ["access-live", "access-refreshed"]);
		assert.equal(discoveryRequests[0]?.signal, signal);
		for (const request of discoveryRequests) {
			assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
		}
		for (const registration of registrations.slice(1)) {
			const liveComposer = registration.config.models.find((model) => model.id === "composer-2");
			assert.equal(liveComposer?.name, "Live Composer");
			assert.equal(liveComposer?.contextWindow, 111);
		}
		assert.equal(cache.saved.length, 2);
		assert.deepEqual(cache.saved.map((catalog) => catalog.fetchedAt), [42, 42]);
		await runtime.dispose();
	});
	test("login registers live-only models even when catalog cache persistence fails", async () => {
		const { host, registrations } = makeHost();
		const fakeAuth = {
			async login(): Promise<OAuthCredentials> {
				return { access: "access-live", refresh: "refresh-live", expires: 123 };
			},
		} as unknown as CursorAuthService;
		const fakeDiscovery = {
			async discover(): Promise<CursorModelCatalog> {
				return { source: "live", fetchedAt: 43, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		const refreshErrors: Error[] = [];
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
			catalogCache: new ThrowingCursorCatalogCache(),
			uuid: () => "login-cache-failure",
			onCatalogRefreshError: (error) => refreshErrors.push(error),
		});

		assert.deepEqual(await registrations[0]!.config.oauth.login(callbacks()), { access: "access-live", refresh: "refresh-live", expires: 123 });
		assert.equal(registrations.length, 2);
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "composer-2.5"), true);
		assert.deepEqual(runtime.getCatalogRefreshStatus(), {
			state: "fresh",
			fetchedAt: 43,
			error: "Cursor model catalog cache persistence failed: cursor catalog cache write failed",
		});
		assert.deepEqual(refreshErrors.map((error) => error.message), ["Cursor model catalog cache persistence failed: cursor catalog cache write failed"]);
		await runtime.dispose();
	});
	test("refresh returns rotated credentials when best-effort catalog discovery rejects", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const fakeAuth = {
			async refreshToken(_credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return { access: "rotated-access-secret", refresh: "rotated-refresh-secret", expires: 789 };
			},
		} as unknown as CursorAuthService;
		const fakeDiscovery = {
			async discover(): Promise<CursorModelCatalog> {
				throw new CursorModelDiscoveryError("CursorApiRejected", "Cursor rejected rotated-access-secret");
			},
		} as unknown as CursorModelDiscoveryService;

		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			uuid: () => "refresh-discovery",
		});
		const refreshed = await registrations[0]!.config.oauth.refreshToken({ access: "old-access", refresh: "old-refresh", expires: 0 });

		assert.deepEqual(refreshed, { access: "rotated-access-secret", refresh: "rotated-refresh-secret", expires: 789 });
		assert.equal(registrations.length, 1);
		assert.equal(cache.saved.length, 0);
		await runtime.dispose();
	});
	test("surfaces cache persistence warnings during background and print refresh", async () => {
		const notifications: string[] = [];
		const diagnostics: string[] = [];
		const discovery = {
			async discover(): Promise<CursorModelCatalog> {
				return { source: "live", fetchedAt: 44, models: [{ id: "live-after-warning" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(), discoveryService: discovery,
			catalogCache: new ThrowingCursorCatalogCache(), uuid: () => "cache-warning",
			onCatalogDiagnostic: (message) => diagnostics.push(message),
		});
		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		const registry = { getApiKeyForProvider: async () => "token" };
		await handler({}, { mode: "tui", ui: { notify: (message: string) => notifications.push(message) }, modelRegistry: registry });
		await nextTick();
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "live-after-warning"), true);
		assert.match(notifications[0] ?? "", /cache persistence failed/u);
		await handler({}, { mode: "print", modelRegistry: registry });
		assert.match(diagnostics[0] ?? "", /cache persistence failed/u);
		await runtime.dispose();
	});
	test("authenticated streams scope catalog freshness to the active credential", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const discoveryRequests: string[] = [];
		const fakeDiscovery = {
			async discover(accessToken: string): Promise<CursorModelCatalog> {
				discoveryRequests.push(accessToken);
				return { source: "live", fetchedAt: catalogNow, models: [{ id: `model-${accessToken}` }] };
			},
		} as unknown as CursorModelDiscoveryService;
		let catalogNow = 99;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			now: () => catalogNow,
			uuid: () => `request-${discoveryRequests.length + 1}`,
		});
		const config = registrations[0]!.config;
		const stream = (apiKey: string) => collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey }));

		await stream("access-a");
		await nextTick();
		await stream("access-b");
		await nextTick();
		await stream("access-b");
		await nextTick();
		assert.deepEqual(discoveryRequests, ["access-a", "access-b"]);

		catalogNow += 30 * 60 * 1000 + 1;
		await stream("access-b");
		await nextTick();
		assert.deepEqual(discoveryRequests, ["access-a", "access-b", "access-b"]);
		assert.equal(cache.saved.length, 3);
		await runtime.dispose();
	});
	test("first-use rediscovery retries after an empty or failed reference discovery", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		let attempts = 0;
		const fakeDiscovery = {
			async discover(): Promise<CursorModelCatalog> {
				attempts += 1;
				if (attempts === 1) throw new CursorModelDiscoveryError("NoUsableModels", "empty model list");
				return { source: "live", fetchedAt: 101, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			uuid: () => `retry-${attempts}`,
		});
		const config = registrations[0]!.config;

		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: "access-secret" }));
		await nextTick();
		assert.equal(attempts, 1);
		assert.equal(cache.saved.length, 0);

		await collectEvents(registrations.at(-1)!.config.streamSimple(streamModelFromConfig(registrations.at(-1)!.config), streamContext(), { apiKey: "access-secret" }));
		await nextTick();
		assert.equal(attempts, 2);
		assert.equal(registrations.at(-1)?.config.models.find((model) => model.id === "composer-2.5")?.reasoning, false);
		await runtime.dispose();
	});
	test("a superseded credential refresh cannot overwrite the active catalog", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const resolvers = new Map<string, Array<(catalog: CursorModelCatalog) => void>>();
		const discovery = {
			discover(accessToken: string): Promise<CursorModelCatalog> {
				return new Promise((resolve) => resolvers.set(accessToken, [...resolvers.get(accessToken) ?? [], resolve]));
			},
		} as unknown as CursorModelDiscoveryService;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: discovery, catalogCache: cache, now: () => 100, uuid: () => "refresh",
		});
		const config = registrations[0]!.config;
		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: "access-a" }));
		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: "access-b" }));
		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: "access-a" }));
		resolvers.get("access-a")?.[1]?.({ source: "live", fetchedAt: 110, models: [{ id: "model-a-new" }] });
		await nextTick();
		resolvers.get("access-b")?.[0]?.({ source: "live", fetchedAt: 100, models: [{ id: "model-b" }] });
		resolvers.get("access-a")?.[0]?.({ source: "live", fetchedAt: 90, models: [{ id: "model-a-old" }] });
		await nextTick();

		assert.deepEqual(cache.saved.map((catalog) => catalog.models[0]?.id), ["model-a-new"]);
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "model-a-new"), true);
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "model-a-old" || model.id === "model-b"), false);
		await runtime.dispose();
	});
	test("activating a fresh scoped cache supersedes another account's in-flight discovery", async () => {
		const tokenA = jwtForSubject("account-a", "token");
		const tokenB = jwtForSubject("account-b", "token");
		const scopeB = deriveCursorCredentialScope(tokenB);
		assert.ok(scopeB);
		const cache = new MemoryCursorCatalogCache({ source: "live", fetchedAt: 100, credentialScope: scopeB, models: [{ id: "cached-b" }] });
		let resolveA: ((catalog: CursorModelCatalog) => void) | undefined;
		const discovery = { discover(): Promise<CursorModelCatalog> { return new Promise((resolve) => { resolveA = resolve; }); } } as unknown as CursorModelDiscoveryService;
		const { host, lifecycleHandlers, registrations } = makeHost();
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: discovery, catalogCache: cache, now: () => 100, catalogCacheTtlMs: 100,
			uuid: () => "account-race",
		});
		const config = registrations[0]!.config;
		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: tokenA }));
		await nextTick();
		const start = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(start);
		await start({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => tokenB } });
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "cached-b"), true);
		resolveA?.({ source: "live", fetchedAt: 101, models: [{ id: "late-a" }] });
		await nextTick();
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "late-a"), false);
		assert.equal(cache.saved.some((catalog) => catalog.models.some((model) => model.id === "late-a")), false);
		await runtime.dispose();
	});
	test("dispose aborts pending first-use rediscovery and does not hang when discovery ignores abort", async () => {
		const { host, registrations } = makeHost();
		const discoverySignals: AbortSignal[] = [];
		const fakeDiscovery = {
			async discover(_accessToken: string, _requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
				if (signal) discoverySignals.push(signal);
				return new Promise<CursorModelCatalog>(() => {});
			},
		} as unknown as CursorModelDiscoveryService;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: fakeDiscovery,
			catalogCache: new MemoryCursorCatalogCache(),
			catalogDiscoveryDisposeTimeoutMs: 10,
			uuid: () => "dispose-rediscovery",
		});
		const config = registrations[0]!.config;

		await collectEvents(config.streamSimple(streamModelFromConfig(config), streamContext(), { apiKey: "access-secret" }));
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
	});
	test("login model discovery is best-effort like the reference provider", async () => {
		const fakeAuth = { async login(): Promise<OAuthCredentials> { return { access: "access-live", refresh: "refresh-live", expires: 123 }; } } as unknown as CursorAuthService;

		for (const code of ["Unauthorized", "CursorApiRejected", "Aborted", "NoUsableModels", "NetworkError", "ProtocolError"] as const) {
			const { host, registrations } = makeHost();
			const discovery = { async discover(): Promise<CursorModelCatalog> { throw new CursorModelDiscoveryError(code, `blocked ${code}`); } } as unknown as CursorModelDiscoveryService;
			const runtime = registerCursorProvider(host, {
				transport: new CursorMockTransport(),
				authService: fakeAuth,
				discoveryService: discovery,
				catalogCache: new MemoryCursorCatalogCache(),
				uuid: () => "request-failure",
			});
			assert.deepEqual(await registrations[0]!.config.oauth.login(callbacks()), { access: "access-live", refresh: "refresh-live", expires: 123 });
			assert.equal(registrations.length, 1);
			assert.ok(registrations[0]!.config.models.some((model) => /estimated/u.test(model.name)));
			await runtime.dispose();
		}
	});
	test("authenticated discovery ignores unscoped or future cache freshness and awaits stale refresh", async () => {
		let now = 1_050;
		const resolvers: Array<(catalog: CursorModelCatalog) => void> = [];
		const discovery = {
			discover(): Promise<CursorModelCatalog> {
				return new Promise((resolve) => resolvers.push(resolve));
			},
		} as unknown as CursorModelDiscoveryService;
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

	test("print mode awaits failed refresh, reports a diagnostic, and retains the scoped cache", async () => {
		const surfaced: string[] = [];
		const diagnostics: string[] = [];
		const discovery = { async discover(): Promise<CursorModelCatalog> { throw new Error("refresh unavailable"); } } as unknown as CursorModelDiscoveryService;
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
		assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "failed", fetchedAt: 1, error: "refresh unavailable" });
		assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "cached"), true);
		await runtime.dispose();
	});
	test("host wiring includes bundled package copy and default model resolution", () => {
		const builtins = readFileSync("packages/coding-agent/src/core/builtin-packages.ts", "utf8");
		const copyScript = readFileSync("packages/coding-agent/scripts/copy-builtin-packages.ts", "utf8");
		assert.match(builtins, /@bastani\/cursor/u);
		assert.match(copyScript, /@bastani\/cursor/u);
		assert.equal(defaultModelPerProvider.cursor, "composer-2");
		assert.equal(existsSync("packages/cursor/src/catalog-cache.ts"), true);
	});
});
