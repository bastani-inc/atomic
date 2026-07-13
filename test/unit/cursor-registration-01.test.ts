// @ts-nocheck
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { deriveCursorCredentialScope, FileCursorCatalogCache, parseCursorCatalogCacheRecord, toCursorCatalogCacheRecord, type CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
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
	test("registers Cursor OAuth provider with estimated models and streamSimple", async () => {
		const { host, registrations, shutdownHandlers } = makeHost();

		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			catalogCache: new MemoryCursorCatalogCache(),
			uuid: () => "request-1",
		});
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0]?.name, "cursor");
		const config = registrations[0]?.config;
		assert.equal(config?.name, "Cursor");
		assert.equal(config?.oauth.name, "Cursor (Experimental)");
		assert.equal(config?.api, "cursor-agent");
		assert.equal(typeof config?.streamSimple, "function");
		assert.ok(config?.models.some((model) => model.id === "composer-2" && /estimated/u.test(model.name)));
		assert.equal(shutdownHandlers.length, 1);
		await runtime.dispose();
	});
	test("registers reference lifecycle cleanup hooks for Cursor session state", async () => {
		const { host, lifecycleHandlers } = makeHost();
		const transport = new CursorMockTransport();
		const runtime = registerCursorProvider(host, {
			transport,
			catalogCache: new MemoryCursorCatalogCache(),
			uuid: () => "request-lifecycle",
		});

		for (const event of ["session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"] as const) {
			const handler = lifecycleHandlers.get(event)?.[0];
			assert.ok(handler, `missing ${event} cleanup handler`);
			await handler({}, { sessionManager: { getSessionId: () => `session-${event}` } });
		}

		assert.deepEqual(transport.discardedConversations, [
			deterministicCursorConversationIdForSession("session-session_before_switch"),
			deterministicCursorConversationIdForSession("session-session_before_fork"),
			deterministicCursorConversationIdForSession("session-session_before_tree"),
			deterministicCursorConversationIdForSession("session-session_shutdown"),
		]);
		await runtime.dispose();
	});
	test("does not register an unscoped cached catalog before credentials are known", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache({
			source: "live",
			fetchedAt: 55,
			models: [{ id: "composer-2", displayName: "Cached Composer", supportsReasoning: true, contextWindow: 1234, maxTokens: 567 }],
		});

		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), catalogCache: cache, uuid: () => "startup-cache" });

		assert.equal(registrations.length, 1);
		const fallbackComposer = registrations[0]?.config.models.find((model) => model.id === "composer-2");
		assert.match(fallbackComposer?.name ?? "", /estimated fallback/u);
		assert.notEqual(fallbackComposer?.contextWindow, 1234);
		await runtime.dispose();
	});
	test("unscoped live-only cache entries cannot replace the startup fallback", async () => {
		const { host, registrations } = makeHost();
		const cache = new MemoryCursorCatalogCache({
			source: "live",
			fetchedAt: 56,
			models: [{ id: "composer-2.5", displayName: "Composer 2.5", contextWindow: 1234, maxTokens: 567 }],
		});

		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), catalogCache: cache, uuid: () => "startup-cache-no-default" });

		assert.equal(registrations[0]?.config.models.some((model) => model.id === "composer-2.5"), false);
		assert.equal(registrations[0]?.config.models.some((model) => /estimated fallback/u.test(model.name)), true);
		await runtime.dispose();
	});
	test("login-persisted live-only models are available to the same account after restart", async () => {
		const cache = new MemoryCursorCatalogCache();
		const accessToken = jwtForSubject("login-account", "first");
		const rotatedToken = jwtForSubject("login-account", "rotated");
		const authService = {
			async login(): Promise<OAuthCredentials> {
				return { access: accessToken, refresh: "refresh-live-only", expires: 123 };
			},
		} as unknown as CursorAuthService;
		const discoveryService = {
			async discover(): Promise<CursorModelCatalog> {
				return { source: "live", fetchedAt: 57, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		const first = makeHost();
		const firstRuntime = registerCursorProvider(first.host, {
			transport: new CursorMockTransport(), authService, discoveryService, catalogCache: cache,
			now: () => 60, catalogCacheTtlMs: 100, uuid: () => "login-live-only",
		});

		await first.registrations[0]!.config.oauth.login(callbacks());
		await firstRuntime.dispose();

		const second = makeHost();
		const secondRuntime = registerCursorProvider(second.host, {
			transport: new CursorMockTransport(), catalogCache: cache, now: () => 60,
			catalogCacheTtlMs: 100, uuid: () => "restart-live-only",
		});
		const start = second.lifecycleHandlers.get("session_start")?.[0];
		assert.ok(start);
		await start({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => rotatedToken } });

		assert.equal(cache.saved.length, 1);
		assert.equal(second.registrations.at(-1)?.config.models.find((model) => model.id === "composer-2.5")?.name, "Composer 2.5");
		assert.deepEqual(second.registrations.at(-1)?.config.models.map((model) => model.id), ["composer-2.5"]);
		await secondRuntime.dispose();
	});
	test("session_start discovers live models from stored Cursor OAuth credentials when cache is missing", async () => {
		const { host, registrations, lifecycleHandlers } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const discoveryRequests: { readonly accessToken: string; readonly requestId: string }[] = [];
		const fakeDiscovery = {
			async discover(accessToken: string, requestId: string): Promise<CursorModelCatalog> {
				discoveryRequests.push({ accessToken, requestId });
				return { source: "live", fetchedAt: 202, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			discoveryService: fakeDiscovery,
			catalogCache: cache,
			uuid: () => "session-start-discovery",
		});

		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		await handler({}, { modelRegistry: { getApiKeyForProvider: async (provider: string) => provider === "cursor" ? "stored-access" : undefined } });
		await nextTick();

		assert.deepEqual(discoveryRequests, [{ accessToken: "stored-access", requestId: "session-start-discovery" }]);
		assert.equal(cache.saved.length, 1);
		assert.equal(registrations.at(-1)?.config.models.find((model) => model.id === "composer-2.5")?.name, "Composer 2.5");
		await runtime.dispose();
	});
	test("session_shutdown flushes pending stored-credential discovery to the live catalog cache", async () => {
		const { host, registrations, lifecycleHandlers } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		let resolveDiscovery: ((catalog: CursorModelCatalog) => void) | undefined;
		const discoveryStarted = new Promise<void>((resolveStarted) => {
			const fakeDiscovery = {
				async discover(): Promise<CursorModelCatalog> {
					resolveStarted();
					return new Promise<CursorModelCatalog>((resolve) => {
						resolveDiscovery = resolve;
					});
				},
			} as unknown as CursorModelDiscoveryService;
			registerCursorProvider(host, {
				transport: new CursorMockTransport(),
				discoveryService: fakeDiscovery,
				catalogCache: cache,
				catalogDiscoveryDisposeTimeoutMs: 250,
				uuid: () => "session-shutdown-flush",
			});
		});
		const startHandler = lifecycleHandlers.get("session_start")?.[0];
		const shutdownHandler = lifecycleHandlers.get("session_shutdown")?.[0];
		assert.ok(startHandler);
		assert.ok(shutdownHandler);

		await startHandler({}, { modelRegistry: { getApiKeyForProvider: async (provider: string) => provider === "cursor" ? "stored-access" : undefined } });
		await discoveryStarted;
		setTimeout(() => {
			resolveDiscovery?.({ source: "live", fetchedAt: 205, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] });
		}, 0);
		await shutdownHandler({}, { sessionManager: { getSessionId: () => "shutdown-session" } });

		assert.equal(cache.saved.length, 1);
		assert.equal(registrations.at(-1)?.config.models.find((model) => model.id === "composer-2.5")?.name, "Composer 2.5");
	});
	test("session_shutdown still disposes runtime when session cleanup fails", async () => {
		class ThrowingDiscardTransport extends CursorMockTransport {
			disposeCalled = false;

			override async dispose(): Promise<void> {
				this.disposeCalled = true;
				await super.dispose();
			}

			override discardConversation(_conversationId: string): void {
				throw new Error("discard failed");
			}
		}

		const { host, lifecycleHandlers } = makeHost();
		const cache = new MemoryCursorCatalogCache();
		const transport = new ThrowingDiscardTransport();
		let resolveDiscovery: ((catalog: CursorModelCatalog) => void) | undefined;
		const discoveryStarted = new Promise<void>((resolveStarted) => {
			const fakeDiscovery = {
				async discover(): Promise<CursorModelCatalog> {
					resolveStarted();
					return new Promise<CursorModelCatalog>((resolve) => {
						resolveDiscovery = resolve;
					});
				},
			} as unknown as CursorModelDiscoveryService;
			registerCursorProvider(host, {
				transport,
				discoveryService: fakeDiscovery,
				catalogCache: cache,
				catalogDiscoveryDisposeTimeoutMs: 250,
				uuid: () => "session-shutdown-cleanup-fails",
			});
		});
		const startHandler = lifecycleHandlers.get("session_start")?.[0];
		const shutdownHandler = lifecycleHandlers.get("session_shutdown")?.[0];
		assert.ok(startHandler);
		assert.ok(shutdownHandler);

		await startHandler({}, { modelRegistry: { getApiKeyForProvider: async (provider: string) => provider === "cursor" ? "stored-access" : undefined } });
		await discoveryStarted;
		setTimeout(() => {
			resolveDiscovery?.({ source: "live", fetchedAt: 206, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] });
		}, 0);

		await assert.rejects(
			async () => {
				await shutdownHandler({}, { sessionManager: { getSessionId: () => "cleanup-throws" } });
			},
			/discard failed/u,
		);
		assert.equal(cache.saved.length, 1);
		assert.equal(transport.disposeCalled, true);
	});
	test("session_start skips live model discovery without stored Cursor credentials", async () => {
		const { host, registrations, lifecycleHandlers } = makeHost();
		let discoveryAttempts = 0;
		const fakeDiscovery = {
			async discover(): Promise<CursorModelCatalog> {
				discoveryAttempts += 1;
				return { source: "live", fetchedAt: 203, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			discoveryService: fakeDiscovery,
			catalogCache: new MemoryCursorCatalogCache(),
			uuid: () => "session-start-no-token",
		});

		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		await handler({}, { modelRegistry: { getApiKeyForProvider: async () => undefined } });
		await nextTick();

		assert.equal(discoveryAttempts, 0);
		assert.equal(registrations.length, 1);
		await runtime.dispose();
	});
	test("stored-credential live model discovery is deduped by access token", async () => {
		const { host, lifecycleHandlers } = makeHost();
		const discoveryRequests: string[] = [];
		const fakeDiscovery = {
			async discover(accessToken: string): Promise<CursorModelCatalog> {
				discoveryRequests.push(accessToken);
				return { source: "live", fetchedAt: 204, models: [{ id: "composer-2.5", displayName: "Composer 2.5" }] };
			},
		} as unknown as CursorModelDiscoveryService;
		let token = "stored-access-1";
		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			discoveryService: fakeDiscovery,
			catalogCache: new MemoryCursorCatalogCache(),
			uuid: () => "session-start-dedupe",
		});
		const handler = lifecycleHandlers.get("session_start")?.[0];
		assert.ok(handler);
		const context = { modelRegistry: { getApiKeyForProvider: async () => token } };

		await handler({}, context);
		await handler({}, context);
		await nextTick();
		assert.deepEqual(discoveryRequests, ["stored-access-1"]);

		token = "stored-access-2";
		await handler({}, context);
		await nextTick();
		assert.deepEqual(discoveryRequests, ["stored-access-1", "stored-access-2"]);
		await runtime.dispose();
	});
	test("catalog cache isolates live catalogs by stable credential scope and writes no credentials", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-cache-"));
		try {
			const cachePath = join(dir, "catalog.json");
			const cache = new FileCursorCatalogCache(cachePath);
			assert.equal(cache.load(), null);

			writeFileSync(cachePath, "{not json", "utf8");
			assert.equal(cache.load(), null);

			const liveCatalog: CursorModelCatalog = {
				source: "live",
				fetchedAt: 77,
				models: [
					{
						id: "composer-2",
						displayName: "Live Composer",
						supportsReasoning: true,
						contextWindow: 200_000,
						maxTokens: 64_000,
						accessToken: "access-secret",
						refreshToken: "refresh-secret",
					} as CursorModelCatalog["models"][number] & { accessToken: string; refreshToken: string },
				],
			};
			const accessToken = jwtForSubject("account-a", "rotation-a");
			const rotatedToken = jwtForSubject("account-a", "rotation-b");
			const otherToken = jwtForSubject("account-b", "rotation-a");
			const scope = deriveCursorCredentialScope(accessToken);
			assert.ok(scope);
			assert.equal(deriveCursorCredentialScope(rotatedToken), scope);
			assert.notEqual(deriveCursorCredentialScope(otherToken), scope);
			cache.save(liveCatalog, scope);

			const scopedPath = `${cachePath}.${scope}`;
			const raw = readFileSync(scopedPath, "utf8");
			assert.match(raw, /"version"\s*:\s*2/u);
			assert.match(raw, /"fetchedAt"\s*:\s*77/u);
			assert.match(raw, new RegExp(`"credentialScope"\\s*:\\s*"${scope}"`, "u"));
			assert.doesNotMatch(raw, /access-secret|refresh-secret|account-a|rotation-a|"source"|"note"/u);
			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".tmp")), false);
			assert.equal(cache.load(deriveCursorCredentialScope(otherToken)), null);
			assert.equal(readdirSync(dir).some((entry) => entry.endsWith(".lock")), false);
			assert.deepEqual(cache.load(scope), {
				source: "live",
				fetchedAt: 77,
				credentialScope: scope,
				models: [{ id: "composer-2", displayName: "Live Composer", contextWindow: 200_000, maxTokens: 64_000, supportsReasoning: true }],
			});

			cache.save({ source: "live", fetchedAt: 80, models: [{ id: "newer" }] }, scope);
			cache.save({ source: "live", fetchedAt: 79, models: [{ id: "older" }] }, scope);
			assert.equal(cache.load(scope)?.models[0]?.id, "newer");
			cache.save({ source: "live", fetchedAt: 80, models: [{ id: "equal-time-loser" }] }, scope);
			assert.equal(cache.load(scope)?.models[0]?.id, "newer");

			writeFileSync(cachePath, JSON.stringify({
				version: 1,
				fetchedAt: 88,
				models: [
					{ id: "still-valid", displayName: "Still Valid" },
					{ id: "bad-display", displayName: 123 },
					{ displayName: "missing id" },
				],
			}), "utf8");
			assert.deepEqual(cache.load(), {
				source: "live",
				fetchedAt: 88,
				models: [{ id: "still-valid", displayName: "Still Valid", metadataProvenance: "legacy-cache" }],
			});

			const sanitizedRecord = toCursorCatalogCacheRecord({
				source: "live",
				fetchedAt: 89,
				models: [
					{ id: "save-valid", displayName: "Save Valid" },
					{ id: "save-bad", displayName: 123 } as CursorModelCatalog["models"][number] & { displayName: number },
				],
			});
			assert.deepEqual(sanitizedRecord?.models, [{ id: "save-valid", displayName: "Save Valid" }]);
			assert.deepEqual(parseCursorCatalogCacheRecord(sanitizedRecord), {
				source: "live",
				fetchedAt: 89,
				models: [{ id: "save-valid", displayName: "Save Valid" }],
			});

			writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: "bad", models: [] }), "utf8");
			assert.equal(cache.load(), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
