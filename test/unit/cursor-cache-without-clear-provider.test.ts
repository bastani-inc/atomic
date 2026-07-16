import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { trustedCursorProviderSource } from "../../packages/coding-agent/test/cursor-test-provider-source.js";
import { deriveCursorCredentialScope, type CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import {
	registerCursorProvider,
	type CursorProviderConfig,
	type CursorProviderContext,
	type CursorProviderEvent,
	type CursorProviderHost,
} from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { collectEvents } from "./cursor-stream-helpers.js";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function token(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		provider: "cursor",
		api: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

class CacheWithoutClear implements CursorCatalogCache {
	catalog: CursorModelCatalog | null = null;
	readonly loads: string[] = [];
	readonly saves: string[] = [];
	load(scope?: string): CursorModelCatalog | null {
		if (scope === undefined) return null;
		this.loads.push(scope);
		return this.catalog?.credentialScope === scope ? this.catalog : null;
	}
	save(catalog: CursorModelCatalog, scope?: string): void {
		this.saves.push(scope ?? "");
		this.catalog = catalog;
	}
}

class MutableDiscovery extends CursorModelDiscoveryService {
	readonly calls: string[] = [];
	catalog: CursorModelCatalog;
	constructor(catalog: CursorModelCatalog) {
		super({ transport: new CursorMockTransport() });
		this.catalog = catalog;
	}
	override async discover(accessToken: string): Promise<CursorModelCatalog> {
		this.calls.push(accessToken);
		return this.catalog;
	}
}

function providerHarness(): {
	readonly host: CursorProviderHost;
	readonly registrations: CursorProviderConfig[];
	readonly handlers: Map<CursorProviderEvent, (event?: unknown, context?: CursorProviderContext) => Promise<void> | void>;
	readonly registry: ModelRegistry;
} {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const registrations: CursorProviderConfig[] = [];
	const handlers = new Map<CursorProviderEvent, (event?: unknown, context?: CursorProviderContext) => Promise<void> | void>();
	return {
		registry,
		registrations,
		handlers,
		host: {
			registerProvider(name, config) {
				registry.registerProvider(name, {
					...config,
					models: config.models.map((entry) => ({
						...entry,
						api: "cursor-agent" as const,
						input: [...entry.input],
						cost: { ...entry.cost },
						compat: entry.compat as Model<Api>["compat"],
					})),
				}, trustedCursorProviderSource());
				registrations.push(config);
			},
			on(event, handler) { handlers.set(event, handler); },
		},
	};
}

test("same-account reauthentication cannot reload revoked data when cache clear is unavailable", async () => {
	const accessToken = token("no-clear-reauth");
	let currentToken: string | undefined = accessToken;
	const discovery = new MutableDiscovery({
		source: "live", fetchedAt: Date.now(), models: [{ id: "revoked-route", maxMode: false }],
	});
	const cache = new CacheWithoutClear();
	const harness = providerHarness();
	const runtime = registerCursorProvider(harness.host, {
		discoveryService: discovery,
		transport: new CursorMockTransport(),
		catalogCache: cache,
		resolveCurrentAccessToken: () => currentToken,
	});
	const discover = harness.handlers.get("model_catalog_discover");
	assert.ok(discover);
	const contextFor = (): CursorProviderContext => ({
		mode: "print", modelRegistry: { getApiKeyForProvider: () => currentToken },
	});

	await discover({ type: "model_catalog_discover" }, contextFor());
	assert.ok(harness.registry.find("cursor", "revoked-route"));
	assert.equal(cache.catalog?.models[0]?.id, "revoked-route");

	currentToken = undefined;
	const revoked = await collectEvents(harness.registrations.at(-1)!.streamSimple(
		model("revoked-route"), context, { apiKey: accessToken },
	));
	assert.equal(revoked.at(-1)?.type, "error");
	assert.equal(harness.registry.find("cursor", "revoked-route"), undefined);
	assert.equal(cache.catalog?.models[0]?.id, "revoked-route", "the injected cache has no physical clear");
	const registrationCountAfterRevocation = harness.registrations.length;

	currentToken = accessToken;
	discovery.catalog = {
		source: "live", fetchedAt: Date.now() + 1, models: [{ id: "replacement-route", maxMode: true }],
	};
	await discover({ type: "model_catalog_discover" }, contextFor());

	assert.deepEqual(discovery.calls, [accessToken, accessToken], "reauthentication must discover instead of loading revoked data");
	assert.equal(
		harness.registrations.slice(registrationCountAfterRevocation)
			.some((registration) => registration.models.some((entry) => entry.id === "revoked-route")),
		false,
	);
	assert.ok(harness.registry.find("cursor", "replacement-route"));
	assert.equal(cache.catalog?.models[0]?.id, "replacement-route");
	await runtime.dispose();
});

test("authoritative empty persists a non-reusable marker when cache clear is unavailable", async () => {
	const accessToken = token("no-clear-authoritative-empty");
	const scope = deriveCursorCredentialScope(accessToken);
	assert.ok(scope);
	const cache = new CacheWithoutClear();
	cache.catalog = {
		source: "live", fetchedAt: 0, credentialScope: scope,
		models: [{ id: "stale-before-empty", maxMode: false }],
	};
	const emptyDiscovery = new MutableDiscovery({ source: "live", fetchedAt: 100, models: [] });
	const first = providerHarness();
	const runtime = registerCursorProvider(first.host, {
		discoveryService: emptyDiscovery, transport: new CursorMockTransport(), catalogCache: cache,
		catalogCacheTtlMs: 10, now: () => 100, resolveCurrentAccessToken: () => accessToken,
	});
	const discover = first.handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({}, { mode: "print", modelRegistry: { getApiKeyForProvider: () => accessToken } });
	assert.deepEqual(first.registry.getAll().filter((entry) => entry.provider === "cursor"), []);
	assert.deepEqual(cache.catalog?.models, [], "the required save stores a durable empty marker");
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "empty", fetchedAt: 100 });
	await runtime.dispose();

	const replacementDiscovery = new MutableDiscovery({
		source: "live", fetchedAt: 101, models: [{ id: "replacement-after-empty", maxMode: true }],
	});
	const second = providerHarness();
	const restarted = registerCursorProvider(second.host, {
		discoveryService: replacementDiscovery, transport: new CursorMockTransport(), catalogCache: cache,
		catalogCacheTtlMs: 10, now: () => 101, resolveCurrentAccessToken: () => accessToken,
	});
	const restartDiscover = second.handlers.get("model_catalog_discover");
	assert.ok(restartDiscover);
	await restartDiscover({}, { mode: "print", modelRegistry: { getApiKeyForProvider: () => accessToken } });
	assert.deepEqual(replacementDiscovery.calls, [accessToken]);
	assert.equal(second.registry.find("cursor", "stale-before-empty"), undefined);
	assert.ok(second.registry.find("cursor", "replacement-after-empty"));
	await restarted.dispose();
});
