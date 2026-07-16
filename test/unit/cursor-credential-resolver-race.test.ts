import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai/compat";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import { deriveCursorCredentialScope } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import {
	type CursorProviderConfig,
	type CursorProviderEvent,
	type CursorProviderHost,
	registerCursorProvider,
} from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

function jwtForSubject(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

class RecordingCache implements CursorCatalogCache {
	readonly loads: Array<string | undefined> = [];
	readonly saves: CursorModelCatalog[] = [];
	readonly clears: Array<string | undefined> = [];
	load(scope?: string): CursorModelCatalog | null { this.loads.push(scope); return null; }
	save(catalog: CursorModelCatalog, scope?: string): void {
		this.saves.push(scope ? { ...catalog, credentialScope: scope } : catalog);
	}
	clear(scope?: string): void { this.clears.push(scope); }
}

class TestDiscoveryService extends CursorModelDiscoveryService {
	constructor(private readonly run: (token: string) => Promise<CursorModelCatalog>) {
		super({ transport: new CursorMockTransport() });
	}
	override discover(token: string): Promise<CursorModelCatalog> { return this.run(token); }
}

type Handler = Parameters<CursorProviderHost["on"]>[1];

function providerHarness(discover: (token: string) => Promise<CursorModelCatalog>, onError?: (error: Error) => void) {
	const registrations: CursorProviderConfig[] = [];
	const handlers = new Map<CursorProviderEvent, Handler>();
	const host: CursorProviderHost = {
		registerProvider(_name, config) { registrations.push(config); },
		on(event, handler) { handlers.set(event, handler); },
	};
	const cache = new RecordingCache();
	const runtime = registerCursorProvider(host, {
		transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
		discoveryService: new TestDiscoveryService(discover),
		catalogCache: cache,
		now: () => 100,
		uuid: () => "resolver-race",
		onCatalogRefreshError: onError,
	});
	const handler = handlers.get("model_catalog_discover");
	if (!handler) throw new Error("Cursor model catalog handler was not registered");
	return { cache, handler, registrations, runtime };
}

function streamModel(config: CursorProviderConfig): Model<Api> {
	const model = config.models[0];
	if (!model) throw new Error("Expected a registered Cursor model");
	return model as unknown as Model<Api>;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

const streamContext: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

describe("stored Cursor credential resolver epochs", () => {
	test("a delayed obsolete resolver cannot replace the newer account catalog, cache, or authority", async () => {
		const tokenA = jwtForSubject("obsolete-account");
		const tokenB = jwtForSubject("current-account");
		const scopeB = deriveCursorCredentialScope(tokenB);
		assert.ok(scopeB);
		const credentialA = deferred<string | undefined>();
		const discoveryTokens: string[] = [];
		const harness = providerHarness(async (token) => {
			discoveryTokens.push(token);
			return {
				source: "live", fetchedAt: 100,
				models: [{ id: token === tokenB ? "current-b" : "obsolete-a", maxMode: false }],
			};
		});
		const oldAttempt = Promise.resolve(harness.handler(
			{ type: "model_catalog_discover" },
			{ mode: "print", modelRegistry: { getApiKeyForProvider: () => credentialA.promise } },
		));
		await Promise.resolve();
		await harness.handler(
			{ type: "model_catalog_discover" },
			{ mode: "print", modelRegistry: { getApiKeyForProvider: () => tokenB } },
		);
		const currentConfig = harness.registrations.at(-1);
		if (!currentConfig?.models.some((model) => model.id === "current-b")) {
			throw new Error("Expected the current account catalog");
		}
		credentialA.resolve(tokenA);
		await oldAttempt;

		assert.deepEqual(discoveryTokens, [tokenB]);
		assert.deepEqual(harness.cache.loads, [scopeB]);
		assert.deepEqual(harness.cache.saves.map((catalog) => catalog.models[0]?.id), ["current-b"]);
		assert.deepEqual(harness.cache.clears, []);
		assert.equal(harness.registrations.at(-1)?.models.some((model) => model.id === "current-b"), true);
		assert.deepEqual(harness.runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 100 });
		const events = await collect(currentConfig.streamSimple(
			streamModel(currentConfig), streamContext, { apiKey: tokenB },
		));
		assert.equal(events.some((event) => event.type === "done"), true);
		await harness.runtime.dispose();
	});

	for (const outcome of ["missing", "rejected"] as const) {
		test(`an obsolete ${outcome} resolver cannot revoke or warn over the current account`, async () => {
			const tokenB = jwtForSubject(`current-${outcome}`);
			const credentialA = deferred<string | undefined>();
			const errors: Error[] = [];
			const notifications: string[] = [];
			const harness = providerHarness(async () => ({
				source: "live", fetchedAt: 100, models: [{ id: "current-b", maxMode: false }],
			}), (error) => errors.push(error));
			const oldAttempt = Promise.resolve(harness.handler(
				{ type: "model_catalog_discover" },
				{ mode: "print", ui: { notify: (message) => notifications.push(message) }, modelRegistry: { getApiKeyForProvider: () => credentialA.promise } },
			));
			await Promise.resolve();
			await harness.handler(
				{ type: "model_catalog_discover" },
				{ mode: "print", modelRegistry: { getApiKeyForProvider: () => tokenB } },
			);
			if (outcome === "missing") credentialA.resolve(undefined);
			else credentialA.reject(new Error("obsolete lookup failed"));
			await oldAttempt;
			assert.equal(harness.registrations.at(-1)?.models.some((model) => model.id === "current-b"), true);
			assert.deepEqual(harness.cache.clears, []);
			assert.deepEqual(errors, []);
			assert.deepEqual(notifications, []);
			assert.deepEqual(harness.runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 100 });
			await harness.runtime.dispose();
		});
	}

	test("a credential resolver settling after disposal is inert", async () => {
		const credential = deferred<string | undefined>();
		const errors: Error[] = [];
		const notifications: string[] = [];
		const harness = providerHarness(async () => ({
			source: "live", fetchedAt: 100, models: [{ id: "late", maxMode: false }],
		}), (error) => errors.push(error));
		const attempt = Promise.resolve(harness.handler(
			{ type: "model_catalog_discover" },
			{ mode: "print", ui: { notify: (message) => notifications.push(message) }, modelRegistry: { getApiKeyForProvider: () => credential.promise } },
		));
		await Promise.resolve();
		await harness.runtime.dispose();
		credential.reject(new Error("late obsolete rejection"));
		await attempt;
		assert.deepEqual(errors, []);
		assert.deepEqual(notifications, []);
		assert.deepEqual(harness.cache.saves, []);
		assert.deepEqual(harness.runtime.getCatalogRefreshStatus(), { state: "idle" });
	});
});
