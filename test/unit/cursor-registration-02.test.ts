// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { FileCursorCatalogCache, parseCursorCatalogCacheRecord, toCursorCatalogCacheRecord, type CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryError, type CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { defaultModelPerProvider } from "../../packages/coding-agent/src/core/model-resolver.ts";

type CursorHost = Parameters<typeof registerCursorProvider>[0];
type CursorConfig = Parameters<CursorHost["registerProvider"]>[1];

class MemoryCursorCatalogCache implements CursorCatalogCache {
	saved: CursorModelCatalog[] = [];

	constructor(private catalog: CursorModelCatalog | null = null) {}

	load(): CursorModelCatalog | null {
		return this.catalog;
	}

	save(catalog: CursorModelCatalog): void {
		this.saved.push(catalog);
		this.catalog = catalog;
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
	test("login keeps live-only models out of memory when catalog cache persistence fails", async () => {
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
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
			catalogCache: new ThrowingCursorCatalogCache(),
			uuid: () => "login-cache-failure",
		});

		assert.deepEqual(await registrations[0]!.config.oauth.login(callbacks()), { access: "access-live", refresh: "refresh-live", expires: 123 });
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0]?.config.models.some((model) => model.id === "composer-2.5"), false);
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
	test("first authenticated stream schedules one tracked rediscovery task and writes the live cache", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const discoveryRequests: { readonly accessToken: string; readonly requestId: string; readonly signal?: AbortSignal }[] = [];
		const fakeDiscovery = {
			async discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
				discoveryRequests.push({ accessToken, requestId, signal });
				return {
					source: "live",
					fetchedAt: 99,
					models: [{ id: "composer-2", displayName: "Rediscovered Composer", supportsReasoning: true, contextWindow: 333, maxTokens: 444 }],
				};
			},
		} as unknown as CursorModelDiscoveryService;
		let uuidCounter = 0;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			uuid: () => `request-${++uuidCounter}`,
		});
		const config = registrations[0]!.config;
		const model = streamModelFromConfig(config);

		await collectEvents(config.streamSimple(model, streamContext(), { apiKey: "access-secret" }));
		await collectEvents(config.streamSimple(model, streamContext(), { apiKey: "access-secret-2" }));
		await nextTick();

		assert.equal(discoveryRequests.length, 1);
		assert.deepEqual(discoveryRequests.map((request) => request.accessToken), ["access-secret"]);
		assert.equal(cache.saved.length, 1);
		assert.equal(registrations.at(-1)?.config.models.find((registeredModel) => registeredModel.id === "composer-2")?.name, "Rediscovered Composer");
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
		assert.equal(registrations.at(-1)?.config.models.find((model) => model.id === "composer-2.5")?.reasoning, true);
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
	test("host wiring includes bundled package copy and default model resolution", () => {
		const builtins = readFileSync("packages/coding-agent/src/core/builtin-packages.ts", "utf8");
		const copyScript = readFileSync("packages/coding-agent/scripts/copy-builtin-packages.ts", "utf8");
		assert.match(builtins, /@bastani\/cursor/u);
		assert.match(copyScript, /@bastani\/cursor/u);
		assert.equal(defaultModelPerProvider.cursor, "composer-2");
		assert.equal(existsSync("packages/cursor/src/catalog-cache.ts"), true);
	});
});
