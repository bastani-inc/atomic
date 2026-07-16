import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { trustedCursorProviderSource } from "../../packages/coding-agent/test/cursor-test-provider-source.js";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { collectEvents } from "./cursor-stream-helpers.js";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const callbacks: OAuthLoginCallbacks = { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined };
function token(nonce: string): string { return `x.${Buffer.from(JSON.stringify({ sub: "active-refresh", nonce })).toString("base64url")}.x` }

class QueueAuth extends CursorAuthService {
	constructor(private readonly tokens: string[]) { super() }
	override async login(): Promise<OAuthCredentials> {
		const access = this.tokens.shift();
		if (!access) throw new Error("No queued token");
		return { access, refresh: "refresh", expires: 1 };
	}
}
class QueueDiscovery extends CursorModelDiscoveryService {
	constructor(private readonly catalogs: CursorModelCatalog[]) { super({ transport: new CursorMockTransport() }) }
	override async discover(): Promise<CursorModelCatalog> {
		const catalog = this.catalogs.shift();
		if (!catalog) throw new Error("No queued catalog");
		return catalog;
	}
}
class MemoryCache implements CursorCatalogCache {
	catalog: CursorModelCatalog | null = null;
	load(): CursorModelCatalog | null { return this.catalog }
	save(catalog: CursorModelCatalog): true { this.catalog = catalog; return true }
	clear(): void { this.catalog = null }
}
function registryHost(shouldThrow: (config: CursorProviderConfig) => boolean): {
	readonly host: CursorProviderHost; readonly registry: ModelRegistry; readonly registrations: CursorProviderConfig[];
} {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const registrations: CursorProviderConfig[] = [];
	return { registry, registrations, host: {
		registerProvider(name, config) {
			registry.registerProvider(name, {
				...config,
				models: [...config.models] as unknown as NonNullable<ProviderConfigInput["models"]>,
			}, trustedCursorProviderSource());
			registrations.push(config);
			if (shouldThrow(config)) throw new Error("selected Cursor occurrence is no longer available");
		},
		on() {},
	} };
}
function selectedOccurrence(config: CursorProviderConfig, occurrence: number): Model<Api> {
	const definition = config.models.filter((model) => model.id === "duplicate")[occurrence];
	if (!definition) throw new Error(`Missing duplicate occurrence ${occurrence}`);
	return definition as unknown as Model<Api>;
}
async function login(config: CursorProviderConfig): Promise<void> { await config.oauth.login(callbacks) }

for (const scenario of ["positive", "empty"] as const) {
	test(`active ${scenario} refresh fails closed when removed-occurrence session refresh throws`, async () => {
		const firstToken = token(`${scenario}-one`);
		const secondToken = token(`${scenario}-two`);
		let rejectRefresh = false;
		const secondModels = scenario === "positive" ? [{ id: "duplicate", maxMode: false }] : [];
		const discovery = new QueueDiscovery([
			{ source: "live", fetchedAt: 1, models: [{ id: "duplicate", maxMode: false }, { id: "duplicate", maxMode: true }] },
			{ source: "live", fetchedAt: 2, models: secondModels },
		]);
		const cache = new MemoryCache();
		const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
		const testHost = registryHost((config) => rejectRefresh && config.models.length === secondModels.length);
		const runtime = registerCursorProvider(testHost.host, {
			authService: new QueueAuth([firstToken, secondToken]), discoveryService: discovery, transport, catalogCache: cache, now: () => 2,
		});
		await login(testHost.registrations[0]!);
		const activeConfig = testHost.registrations.at(-1)!;
		const removed = selectedOccurrence(activeConfig, 1);
		rejectRefresh = true;
		await assert.rejects(login(activeConfig), /model discovery failed|selected Cursor occurrence/u);
		assert.equal(testHost.registry.getAll().filter((model) => model.provider === "cursor").length, secondModels.length);
		if (scenario === "empty") {
			assert.deepEqual(cache.catalog?.models, []);
			assert.equal(cache.catalog?.fetchedAt, 2);
		}
		const events = await collectEvents(activeConfig.streamSimple(removed, context, { apiKey: firstToken }));
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(transport.runs.length, 0);
		rejectRefresh = false;
		await runtime.dispose();
	});
}

test("a superseded authoritative empty cannot clobber a newer same-account positive catalog after async clear", async () => {
	class DeferredClearCache extends MemoryCache {
		readonly clearStarted: Promise<void>;
		#markClearStarted!: () => void;
		#releaseClear!: () => void;
		constructor() {
			super();
			this.clearStarted = new Promise((resolve) => { this.#markClearStarted = resolve; });
		}
		release(): void { this.#releaseClear(); }
		override clear(): Promise<void> {
			this.#markClearStarted();
			return new Promise((resolve) => { this.#releaseClear = () => { this.catalog = null; resolve(); }; });
		}
	}
	const firstToken = token("stale-empty");
	const secondToken = token("new-positive");
	const cache = new DeferredClearCache();
	const discovery = new QueueDiscovery([
		{ source: "live", fetchedAt: 100, models: [] },
		{ source: "live", fetchedAt: 200, models: [{ id: "new-current", maxMode: true }] },
	]);
	const testHost = registryHost(() => false);
	const runtime = registerCursorProvider(testHost.host, {
		authService: new QueueAuth([firstToken, secondToken]), discoveryService: discovery,
		transport: new CursorMockTransport(), catalogCache: cache, now: () => 200,
	});
	const staleLogin = login(testHost.registrations[0]!);
	await cache.clearStarted;
	await login(testHost.registrations.at(-1)!);
	assert.equal(testHost.registry.find("cursor", "new-current")?.id, "new-current");
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 200 });
	cache.release();
	await assert.rejects(staleLogin, /superseded/u);
	for (let index = 0; index < 20 && cache.catalog?.models[0]?.id !== "new-current"; index++) await Promise.resolve();
	assert.equal(testHost.registry.find("cursor", "new-current")?.id, "new-current");
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 200 });
	assert.equal(cache.catalog?.models[0]?.id, "new-current");
	await runtime.dispose();
});
