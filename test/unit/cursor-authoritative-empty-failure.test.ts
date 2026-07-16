import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { trustedCursorProviderSource } from "../../packages/coding-agent/test/cursor-test-provider-source.js";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { deriveCursorCredentialScope, FileCursorCatalogCache, type CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderContext, type CursorProviderEvent, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const token = (subject: string): string => `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
const callbacks: OAuthLoginCallbacks = { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined };

class Auth extends CursorAuthService {
	constructor(readonly access: string) { super(); }
	override async login(): Promise<OAuthCredentials> { return { access: this.access, refresh: "refresh", expires: 123 }; }
	override async refreshToken(): Promise<OAuthCredentials> { throw new Error("unexpected refresh"); }
}

class Discovery extends CursorModelDiscoveryService {
	readonly calls: string[] = [];
	constructor(readonly catalog: CursorModelCatalog) { super({ transport: new CursorMockTransport() }); }
	override async discover(access: string): Promise<CursorModelCatalog> { this.calls.push(access); return this.catalog; }
}

class FailingClearCache implements CursorCatalogCache {
	catalog: CursorModelCatalog | null;
	readonly failSave: boolean;
	clearCalls = 0;
	saveCalls = 0;
	constructor(catalog: CursorModelCatalog, failSave = false) { this.catalog = catalog; this.failSave = failSave; }
	load(scope?: string): CursorModelCatalog | null { return scope !== undefined && this.catalog?.credentialScope === scope ? this.catalog : null; }
	save(catalog: CursorModelCatalog): void {
		this.saveCalls += 1;
		if (this.failSave) throw new Error("save rejected");
		this.catalog = catalog;
	}
	clear(): void { this.clearCalls += 1; throw new Error("clear rejected"); }
}

class AsyncRejectingClearFileCache extends FileCursorCatalogCache {
	override async clear(): Promise<void> { throw new Error("clear rejected"); }
}

class RejectingClearAndMarkerFileCache extends FileCursorCatalogCache {
	override clear(): void { throw new Error("clear rejected"); }
	override save(catalog: CursorModelCatalog, scope?: string) {
		if (catalog.models.length === 0) throw new Error("marker rejected");
		return super.save(catalog, scope);
	}
}

function harness(): {
	readonly host: CursorProviderHost;
	readonly registry: ModelRegistry;
	readonly registrations: CursorProviderConfig[];
	readonly handlers: Map<CursorProviderEvent, (event?: unknown, context?: CursorProviderContext) => Promise<void> | void>;
} {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const registrations: CursorProviderConfig[] = [];
	const handlers = new Map<CursorProviderEvent, (event?: unknown, context?: CursorProviderContext) => Promise<void> | void>();
	return {
		registry, registrations, handlers,
		host: {
			registerProvider(name, config) {
				registry.registerProvider(name, { ...config, api: "cursor-agent", models: config.models.map((entry) => ({ ...entry, input: [...entry.input], cost: { ...entry.cost }, compat: entry.compat as Model<Api>["compat"] })) }, trustedCursorProviderSource());
				registrations.push(config);
			},
			on(event, handler) { handlers.set(event, handler); },
		},
	};
}

async function restartDiscovery(input: {
	readonly access: string;
	readonly cache: CursorCatalogCache;
	readonly catalog: CursorModelCatalog;
}): Promise<{ calls: readonly string[]; ids: readonly string[] }> {
	const discovery = new Discovery(input.catalog);
	const current = harness();
	const runtime = registerCursorProvider(current.host, {
		discoveryService: discovery, transport: new CursorMockTransport(), catalogCache: input.cache,
		catalogCacheTtlMs: 1_000, now: () => input.catalog.fetchedAt,
		resolveCurrentAccessToken: () => input.access, uuid: () => "restart-empty-failure",
	});
	const start = current.handlers.get("session_start");
	assert.ok(start);
	await start({}, { mode: "print", modelRegistry: { getApiKeyForProvider: () => input.access } });
	const ids = current.registry.getAll().filter((entry) => entry.provider === "cursor").map((entry) => entry.id);
	await runtime.dispose();
	return { calls: discovery.calls, ids };
}

test("authoritative empty falls back to a durable marker when clear rejects", async () => {
	const access = token("clear-reject-marker");
	const scope = deriveCursorCredentialScope(access);
	assert.ok(scope);
	const cache = new FailingClearCache({ source: "live", fetchedAt: 90, credentialScope: scope, models: [{ id: "stale", maxMode: false }] });
	const current = harness();
	const runtime = registerCursorProvider(current.host, {
		authService: new Auth(access), discoveryService: new Discovery({ source: "live", fetchedAt: 100, models: [] }),
		transport: new CursorMockTransport(), catalogCache: cache, now: () => 100, uuid: () => "empty-clear-reject",
	});
	assert.equal((await current.registrations[0]!.oauth.login(callbacks)).access, access);
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "empty", fetchedAt: 100 });
	assert.equal(cache.clearCalls, 1);
	assert.equal(cache.saveCalls, 1);
	assert.deepEqual(cache.catalog?.models, []);
	await runtime.dispose();
	const restarted = await restartDiscovery({ access, cache, catalog: { source: "live", fetchedAt: 101, models: [{ id: "replacement", maxMode: true }] } });
	assert.deepEqual(restarted.calls, [access]);
	assert.deepEqual(restarted.ids, ["replacement"]);
});

test("authoritative empty overrides a future positive record and restart still calls GetUsable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-authoritative-empty-order-"));
	try {
		const access = token("future-positive-clear-reject");
		const scope = deriveCursorCredentialScope(access);
		assert.ok(scope);
		const path = join(dir, "catalog.json");
		const cache = new AsyncRejectingClearFileCache(path);
		cache.save({
			source: "live", fetchedAt: 10_000, credentialScope: scope,
			models: [{ id: "future-stale-route", maxMode: false }],
		}, scope);
		const current = harness();
		const runtime = registerCursorProvider(current.host, {
			authService: new Auth(access),
			discoveryService: new Discovery({ source: "live", fetchedAt: 100, models: [] }),
			transport: new CursorMockTransport(), catalogCache: cache, now: () => 100,
			uuid: () => "future-empty-clear-reject",
		});
		assert.equal((await current.registrations[0]!.oauth.login(callbacks)).access, access);
		assert.equal(current.registry.find("cursor", "future-stale-route"), undefined);
		assert.equal(cache.load(scope), null);
		await runtime.dispose();

		const delayedWriter = new FileCursorCatalogCache(path);
		delayedWriter.save({
			source: "live", fetchedAt: 90, credentialScope: scope,
			models: [{ id: "delayed-stale-route", maxMode: false }],
		}, scope);
		assert.equal(delayedWriter.load(scope), null, "a delayed positive save must not replace the newer empty marker");

		const reconstructed = new FileCursorCatalogCache(path);
		const restarted = await restartDiscovery({
			access,
			cache: reconstructed,
			catalog: { source: "live", fetchedAt: 10_100, models: [{ id: "replacement-after-restart", maxMode: true }] },
		});
		assert.deepEqual(restarted.calls, [access], "restart must call GetUsable instead of trusting the future stale route");
		assert.deepEqual(restarted.ids, ["replacement-after-restart"]);
		assert.equal(restarted.ids.some((id) => id === "future-stale-route" || id === "delayed-stale-route"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("double invalidation failure rejects login and preserves a same-cache restart tombstone", async () => {
	const access = token("clear-and-save-reject");
	const scope = deriveCursorCredentialScope(access);
	assert.ok(scope);
	const cache = new FailingClearCache({ source: "live", fetchedAt: 90, credentialScope: scope, models: [{ id: "must-never-resurrect", maxMode: false }] }, true);
	const current = harness();
	const runtime = registerCursorProvider(current.host, {
		authService: new Auth(access), discoveryService: new Discovery({ source: "live", fetchedAt: 100, models: [] }),
		transport: new CursorMockTransport(), catalogCache: cache, now: () => 100, uuid: () => "empty-double-failure",
	});
	await assert.rejects(current.registrations[0]!.oauth.login(callbacks), /authenticated model discovery failed|cache clear failed/u);
	assert.equal(current.registry.find("cursor", "must-never-resurrect"), undefined);
	assert.equal(runtime.getCatalogRefreshStatus().state, "failed");
	await runtime.dispose();
	const restarted = await restartDiscovery({ access, cache, catalog: { source: "live", fetchedAt: 101, models: [{ id: "recovered", maxMode: false }] } });
	assert.deepEqual(restarted.calls, [access]);
	assert.deepEqual(restarted.ids, ["recovered"]);
});

test("a skipped positive replacement keeps the failed-invalidation tombstone through clock catch-up", async () => {
	const dir = mkdtempSync(join(tmpdir(), "atomic-cursor-skipped-replacement-"));
	try {
		const access = token("skipped-positive-replacement");
		const scope = deriveCursorCredentialScope(access);
		assert.ok(scope);
		const cache = new RejectingClearAndMarkerFileCache(join(dir, "catalog.json"));
		await cache.save({
			source: "live", fetchedAt: 10_000, credentialScope: scope,
			models: [{ id: "future-stale-10k", maxMode: false }],
		}, scope);

		const current = harness();
		const runtime = registerCursorProvider(current.host, {
			authService: new Auth(access),
			discoveryService: new Discovery({ source: "live", fetchedAt: 100, models: [] }),
			transport: new CursorMockTransport(), catalogCache: cache, now: () => 100,
			uuid: () => "double-failure-before-skipped-positive",
		});
		await assert.rejects(current.registrations[0]!.oauth.login(callbacks), /authenticated model discovery failed|cache clear failed/u);
		await runtime.dispose();

		const attempted = await restartDiscovery({
			access, cache,
			catalog: { source: "live", fetchedAt: 200, models: [{ id: "valid-but-skipped-200", maxMode: false }] },
		});
		assert.deepEqual(attempted.calls, [access]);
		assert.deepEqual(attempted.ids, ["valid-but-skipped-200"]);
		assert.equal(cache.load(scope)?.models[0]?.id, "future-stale-10k", "the file cache must preserve ordinary positive ordering");

		const caughtUp = await restartDiscovery({
			access, cache,
			catalog: { source: "live", fetchedAt: 10_100, models: [{ id: "fresh-after-catch-up", maxMode: true }] },
		});
		assert.deepEqual(caughtUp.calls, [access], "the retained tombstone must force GetUsable after clock catch-up");
		assert.deepEqual(caughtUp.ids, ["fresh-after-catch-up"]);
		assert.equal(caughtUp.ids.includes("future-stale-10k"), false);

		const released = await restartDiscovery({
			access, cache,
			catalog: { source: "live", fetchedAt: 10_101, models: [{ id: "must-not-run", maxMode: false }] },
		});
		assert.deepEqual(released.calls, [], "a positive that actually lands must release the tombstone");
		assert.deepEqual(released.ids, ["fresh-after-catch-up"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
