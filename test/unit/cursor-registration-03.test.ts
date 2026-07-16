import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { deriveCursorCredentialScope, FileCursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderContext } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

type CursorHost = Parameters<typeof registerCursorProvider>[0];
type CursorConfig = Parameters<CursorHost["registerProvider"]>[1];
type CursorLifecycleHandler = (event?: unknown, context?: CursorProviderContext) => Promise<void> | void;

function jwtForSubject(subject: string, randomness: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject, randomness })).toString("base64url")}.signature`;
}

class TestCursorAuthService extends CursorAuthService {
	readonly #login: CursorAuthService["login"];

	constructor(login: CursorAuthService["login"]) {
		super();
		this.#login = login;
	}

	override login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return this.#login(callbacks);
	}

	override async refreshToken(): Promise<OAuthCredentials> {
		throw new Error("Unexpected Cursor token refresh in test");
	}
}

class TestCursorDiscoveryService extends CursorModelDiscoveryService {
	readonly #discover: CursorModelDiscoveryService["discover"];

	constructor(discover: CursorModelDiscoveryService["discover"]) {
		super({ transport: new CursorMockTransport() });
		this.#discover = discover;
	}

	override discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
		return this.#discover(accessToken, requestId, signal);
	}
}

function cursorAuthService(login: CursorAuthService["login"]): CursorAuthService {
	return new TestCursorAuthService(login);
}

function cursorDiscoveryService(discover: CursorModelDiscoveryService["discover"]): CursorModelDiscoveryService {
	return new TestCursorDiscoveryService(discover);
}
function makeHost(): {
	readonly host: CursorHost;
	readonly registrations: Array<{ readonly name: string; readonly config: CursorConfig }>;
	readonly lifecycleHandlers: Map<string, CursorLifecycleHandler[]>;
} {
	const registrations: Array<{ readonly name: string; readonly config: CursorConfig }> = [];
	const lifecycleHandlers = new Map<string, CursorLifecycleHandler[]>();
	return {
		registrations,
		lifecycleHandlers,
		host: {
			registerProvider: (name, config) => registrations.push({ name, config }),
			on: (event, handler) => lifecycleHandlers.set(event, [...lifecycleHandlers.get(event) ?? [], handler]),
		},
	};
}

describe("Cursor provider credential-scoped startup", () => {
	test("reuses only a fresh cache for the same stable account", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-scoped-cache-"));
		try {
			const accessToken = jwtForSubject("account-a", "first-token");
			const rotatedToken = jwtForSubject("account-a", "rotated-token");
			const scope = deriveCursorCredentialScope(accessToken);
			assert.ok(scope);
			const cache = new FileCursorCatalogCache(join(dir, "catalog.json"));
			cache.save({ source: "live", fetchedAt: 90, models: [{ id: "same-account", displayName: "Same Account", maxMode: false }] }, scope);
			let discoveryAttempts = 0;
			const discovery = cursorDiscoveryService(async () => {
				discoveryAttempts += 1;
				throw new Error("must not refresh fresh scoped cache");
			});
			const { host, lifecycleHandlers, registrations } = makeHost();
			const runtime = registerCursorProvider(host, {
				transport: new CursorMockTransport(), discoveryService: discovery, catalogCache: cache,
				catalogCacheTtlMs: 100, now: () => 100, uuid: () => "scoped",
			});
			assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "same-account"), false);
			const handler = lifecycleHandlers.get("session_start")?.[0];
			assert.ok(handler);
			await handler({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => rotatedToken } });
			assert.equal(discoveryAttempts, 0);
			assert.equal(registrations.at(-1)?.config.models.some((model) => model.id === "same-account"), true);
			await runtime.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a fresh same-account v3 snapshot bridges a temporary forced GetUsable failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-fresh-outage-"));
		try {
			const token = jwtForSubject("outage-account", "token");
			const scope = deriveCursorCredentialScope(token);
			assert.ok(scope);
			const cache = new FileCursorCatalogCache(join(dir, "catalog.json"));
			cache.save({ source: "live", fetchedAt: 90, models: [{ id: "cached-exact", maxMode: true, supportsImages: true }] }, scope);
			const auth = cursorAuthService(async () => ({ access: token, refresh: "refresh", expires: 123 }));
			const discovery = cursorDiscoveryService(async () => { throw new Error("temporary GetUsable outage"); });
			const { host, registrations } = makeHost();
			const runtime = registerCursorProvider(host, {
				transport: new CursorMockTransport(), authService: auth, discoveryService: discovery, catalogCache: cache,
				catalogCacheTtlMs: 100, now: () => 100, uuid: () => "fresh-outage",
			});
			const credentials = await registrations[0]!.config.oauth.login({
				onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined,
			});
			assert.equal(credentials.access, token);
			assert.equal(registrations.at(-1)?.config.models[0]?.id, "cached-exact");
			assert.deepEqual(runtime.getCatalogRefreshStatus(), {
				state: "fresh", fetchedAt: 90, error: "temporary GetUsable outage",
			});
			await runtime.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a successful empty GetUsable response durably invalidates a fresh cache and login succeeds", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-authoritative-empty-"));
		try {
			const token = jwtForSubject("empty-account", "token");
			const scope = deriveCursorCredentialScope(token);
			assert.ok(scope);
			const cache = new FileCursorCatalogCache(join(dir, "catalog.json"));
			cache.save({ source: "live", fetchedAt: 90, models: [{ id: "cached-must-clear", maxMode: false }] }, scope);
			const auth = cursorAuthService(async () => ({ access: token, refresh: "refresh", expires: 123 }));
			const transport = new CursorMockTransport({ models: [] });
			const refreshErrors: Error[] = [];
			const first = makeHost();
			const runtime = registerCursorProvider(first.host, {
				transport, authService: auth, discoveryService: new CursorModelDiscoveryService({ transport, now: () => 100 }), catalogCache: cache,
				catalogCacheTtlMs: 100, now: () => 100, uuid: () => "authoritative-empty",
				onCatalogRefreshError: (error) => refreshErrors.push(error),
			});
			const credentials = await first.registrations[0]!.config.oauth.login({
				onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined,
			});
			assert.equal(credentials.access, token);
			assert.deepEqual(first.registrations.at(-1)?.config.models, []);
			assert.equal(cache.load(scope), null);
			assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "empty", fetchedAt: 100 });
			assert.deepEqual(refreshErrors, []);
			assert.equal(transport.runs.length, 0);
			await runtime.dispose();

			let restartDiscoveries = 0;
			const restartTransport = new CursorMockTransport({ models: [{ id: "after-restart", maxMode: false }] });
			const restartDiscovery = cursorDiscoveryService(async (accessToken, requestId, signal) => {
				restartDiscoveries += 1;
				return new CursorModelDiscoveryService({ transport: restartTransport, now: () => 101 })
					.discover(accessToken, requestId, signal);
			});
			const second = makeHost();
			const restarted = registerCursorProvider(second.host, {
				transport: restartTransport, discoveryService: restartDiscovery, catalogCache: cache,
				catalogCacheTtlMs: 100, now: () => 101, uuid: () => "restart-after-empty",
			});
			assert.equal(second.registrations.at(-1)?.config.models.length, 0);
			const handler = second.lifecycleHandlers.get("session_start")?.[0];
			assert.ok(handler);
			await handler({}, { mode: "print", modelRegistry: { getApiKeyForProvider: async () => token } });
			assert.equal(restartDiscoveries, 1);
			assert.equal(second.registrations.at(-1)?.config.models[0]?.id, "after-restart");
			await restarted.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
