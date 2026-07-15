import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai/compat";
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
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

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

function token(subject: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

class RecordingCache implements CursorCatalogCache {
	readonly loads: Array<string | undefined> = [];
	readonly saves: CursorModelCatalog[] = [];
	readonly clears: Array<string | undefined> = [];
	load(scope?: string): CursorModelCatalog | null { this.loads.push(scope); return null; }
	save(catalog: CursorModelCatalog, scope?: string): void { this.saves.push({ ...catalog, credentialScope: scope }); }
	clear(scope?: string): void { this.clears.push(scope); }
}

class ControlledDiscovery extends CursorModelDiscoveryService {
	readonly calls: string[] = [];
	readonly catalogs = new Map<string, CursorModelCatalog | Promise<CursorModelCatalog>>();
	onDiscover?: (accessToken: string) => void;
	constructor() { super({ transport: new CursorMockTransport() }); }
	override async discover(accessToken: string): Promise<CursorModelCatalog> {
		this.calls.push(accessToken);
		this.onDiscover?.(accessToken);
		const catalog = this.catalogs.get(accessToken);
		if (!catalog) throw new Error("No controlled Cursor catalog");
		return catalog;
	}
}

type Handler = (event?: unknown, context?: CursorProviderContext) => Promise<void> | void;

function harness(options: {
	readonly discovery: ControlledDiscovery;
	readonly transport?: CursorMockTransport;
	readonly onError?: (error: Error) => void;
	readonly resolveCurrentAccessToken?: () => Promise<string | undefined> | string | undefined;
}) {
	const registrations: CursorProviderConfig[] = [];
	const handlers = new Map<CursorProviderEvent, Handler>();
	const host: CursorProviderHost = {
		registerProvider(_name, config) { registrations.push(config); },
		on(event, handler) { handlers.set(event, handler); },
	};
	const cache = new RecordingCache();
	const transport = options.transport ?? new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const runtime = registerCursorProvider(host, {
		discoveryService: options.discovery,
		transport,
		catalogCache: cache,
		now: () => 100,
		uuid: () => `execution-credential-${options.discovery.calls.length}`,
		onCatalogRefreshError: options.onError,
		resolveCurrentAccessToken: options.resolveCurrentAccessToken,
	});
	const discover = handlers.get("model_catalog_discover");
	if (!discover) throw new Error("Cursor model catalog handler was not registered");
	return { cache, discover, registrations, runtime, transport };
}

async function publish(handler: Handler, resolver: () => Promise<string | undefined> | string | undefined): Promise<void> {
	await handler(
		{ type: "model_catalog_discover" },
		{ mode: "print", modelRegistry: { getApiKeyForProvider: resolver } },
	);
}

function selectedModel(config: CursorProviderConfig, index = 0): Model<Api> {
	const definition = config.models[index];
	if (!definition) throw new Error(`Missing Cursor model occurrence ${index}`);
	return {
		...definition,
		provider: "cursor",
		api: "cursor-agent",
		input: [...definition.input],
		cost: { ...definition.cost },
		compat: definition.compat as Model<Api>["compat"],
	} as Model<Api>;
}

function fabricatedModel(id: string): Model<Api> {
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

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("Cursor execution credential resolver epochs", () => {
	test("a delayed execution resolver cannot replace the newer lifecycle account", async () => {
		const tokenA = token("execution-obsolete-a");
		const tokenB = token("execution-current-b");
		const discovery = new ControlledDiscovery();
		discovery.catalogs.set(tokenA, { source: "live", fetchedAt: 100, models: [{ id: "route-a", maxMode: false }] });
		discovery.catalogs.set(tokenB, { source: "live", fetchedAt: 100, models: [{ id: "route-b", maxMode: true }] });
		const testHarness = harness({ discovery });
		await publish(testHarness.discover, () => tokenA);
		const configA = testHarness.registrations.at(-1)!;
		const delayedA = Promise.withResolvers<string | undefined>();
		const bothLookupsStarted = Promise.withResolvers<void>();
		let delayedCalls = 0;
		const delayedResolver = (): Promise<string | undefined> => {
			delayedCalls += 1;
			if (delayedCalls === 2) bothLookupsStarted.resolve();
			return delayedA.promise;
		};
		const obsoleteLifecycle = Promise.resolve(testHarness.discover(
			{ type: "model_catalog_discover" },
			{ mode: "print", modelRegistry: { getApiKeyForProvider: delayedResolver } },
		));
		const obsoleteExecution = collect(configA.streamSimple(selectedModel(configA), context, { apiKey: tokenA }));
		await bothLookupsStarted.promise;
		await publish(testHarness.discover, () => tokenB);
		assert.deepEqual(testHarness.registrations.at(-1)?.models.map((entry) => entry.id), ["route-b"]);
		delayedA.resolve(tokenA);
		await obsoleteLifecycle;
		const obsoleteEvents = await obsoleteExecution;
		assert.equal(obsoleteEvents.at(-1)?.type, "error");
		assert.deepEqual(discovery.calls, [tokenA, tokenB]);
		assert.deepEqual(testHarness.registrations.at(-1)?.models.map((entry) => entry.id), ["route-b"]);
		assert.deepEqual(testHarness.cache.saves.map((catalog) => catalog.models[0]?.id), ["route-a", "route-b"]);
		assert.deepEqual(testHarness.cache.clears, []);
		assert.deepEqual(testHarness.runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 100 });
		const configB = testHarness.registrations.at(-1)!;
		assert.equal((await collect(configB.streamSimple(selectedModel(configB), context, { apiKey: tokenB }))).at(-1)?.type, "done");
		await testHarness.runtime.dispose();
	});

	for (const outcome of ["missing", "rejected"] as const) {
		test(`a current ${outcome} execution lookup revokes rows, cache, and the active lease`, async () => {
			const accessToken = token(`execution-${outcome}`);
			const scope = deriveCursorCredentialScope(accessToken);
			assert.ok(scope);
			const discovery = new ControlledDiscovery();
			discovery.catalogs.set(accessToken, { source: "live", fetchedAt: 100, models: [{ id: "current-route", maxMode: false }] });
			const streamStarted = Promise.withResolvers<void>();
			const transport = new CursorMockTransport({ messageFactory: () => (async function* () {
				streamStarted.resolve();
				await new Promise<void>(() => undefined);
			})() });
			const errors: Error[] = [];
			const testHarness = harness({ discovery, transport, onError: (error) => errors.push(error) });
			let credentialState: "present" | "missing" | "rejected" = "present";
			const resolver = (): string | undefined => {
				if (credentialState === "rejected") throw new Error(`private resolver detail ${accessToken}`);
				return credentialState === "present" ? accessToken : undefined;
			};
			await publish(testHarness.discover, resolver);
			const config = testHarness.registrations.at(-1)!;
			const activeEvents = collect(config.streamSimple(selectedModel(config), context, { apiKey: accessToken }));
			await streamStarted.promise;
			credentialState = outcome;
			try {
				const rejected = await collect(config.streamSimple(selectedModel(config), context, { apiKey: accessToken }));
				assert.equal(rejected.at(-1)?.type, "error");
				assert.deepEqual(testHarness.registrations.at(-1)?.models, []);
				assert.deepEqual(testHarness.cache.clears, [scope]);
				assert.equal(testHarness.runtime.getCatalogRefreshStatus().state, "failed");
				assert.equal(testHarness.transport.runs.length, 1);
				assert.equal(testHarness.transport.runs[0]?.stream.cancelled, true);
				assert.equal(errors.length, 1);
				assert.doesNotMatch(errors[0]?.message ?? "", /private resolver detail|header\./u);
			} finally {
				await testHarness.runtime.dispose();
			}
			assert.equal((await activeEvents).at(-1)?.type, "error");
		});
	}

	for (const outcome of ["missing", "rejected"] as const) {
		test(`an obsolete ${outcome} execution lookup is inert after a newer account publishes`, async () => {
			const tokenA = token(`obsolete-${outcome}-a`);
			const tokenB = token(`obsolete-${outcome}-b`);
			const discovery = new ControlledDiscovery();
			discovery.catalogs.set(tokenA, { source: "live", fetchedAt: 100, models: [{ id: "route-a", maxMode: false }] });
			discovery.catalogs.set(tokenB, { source: "live", fetchedAt: 100, models: [{ id: "route-b", maxMode: true }] });
			const errors: Error[] = [];
			const testHarness = harness({ discovery, onError: (error) => errors.push(error) });
			await publish(testHarness.discover, () => tokenA);
			const configA = testHarness.registrations.at(-1)!;
			const delayed = Promise.withResolvers<string | undefined>();
			const bothLookupsStarted = Promise.withResolvers<void>();
			let calls = 0;
			const delayedResolver = (): Promise<string | undefined> => {
				calls += 1;
				if (calls === 2) bothLookupsStarted.resolve();
				return delayed.promise;
			};
			const obsoleteLifecycle = Promise.resolve(testHarness.discover(
				{ type: "model_catalog_discover" },
				{ mode: "print", modelRegistry: { getApiKeyForProvider: delayedResolver } },
			));
			const obsoleteExecution = collect(configA.streamSimple(selectedModel(configA), context, { apiKey: tokenA }));
			await bothLookupsStarted.promise;
			await publish(testHarness.discover, () => tokenB);
			if (outcome === "missing") delayed.resolve(undefined);
			else delayed.reject(new Error("private obsolete resolver detail"));
			await obsoleteLifecycle;
			assert.equal((await obsoleteExecution).at(-1)?.type, "error");
			assert.deepEqual(discovery.calls, [tokenA, tokenB]);
			assert.deepEqual(testHarness.registrations.at(-1)?.models.map((entry) => entry.id), ["route-b"]);
			assert.deepEqual(testHarness.cache.clears, []);
			assert.deepEqual(errors, []);
			assert.deepEqual(testHarness.runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 100 });
			const configB = testHarness.registrations.at(-1)!;
			assert.equal((await collect(configB.streamSimple(selectedModel(configB), context, { apiKey: tokenB }))).at(-1)?.type, "done");
			await testHarness.runtime.dispose();
		});
	}

	test("concurrent same-credential execution shares one cold catalog discovery", async () => {
		const accessToken = token("concurrent-execution");
		const catalog = Promise.withResolvers<CursorModelCatalog>();
		const discoveryStarted = Promise.withResolvers<void>();
		const discovery = new ControlledDiscovery();
		discovery.onDiscover = () => discoveryStarted.resolve();
		discovery.catalogs.set(accessToken, catalog.promise);
		const testHarness = harness({ discovery, resolveCurrentAccessToken: () => accessToken });
		const first = collect(testHarness.registrations[0]!.streamSimple(fabricatedModel("shared-route"), context, { apiKey: accessToken }));
		const second = collect(testHarness.registrations[0]!.streamSimple(fabricatedModel("shared-route"), context, { apiKey: accessToken }));
		await discoveryStarted.promise;
		await Promise.resolve();
		assert.deepEqual(discovery.calls, [accessToken]);
		catalog.resolve({ source: "live", fetchedAt: 100, models: [{ id: "shared-route", maxMode: true }] });
		assert.equal((await first).at(-1)?.type, "done");
		assert.equal((await second).at(-1)?.type, "done");
		assert.equal(testHarness.transport.runs.length, 2);
		await testHarness.runtime.dispose();
	});

	for (const outcome of ["selected", "rejected"] as const) {
		test(`an execution resolver settling ${outcome} after disposal is inert`, async () => {
			const accessToken = token(`disposed-${outcome}`);
			const delayed = Promise.withResolvers<string | undefined>();
			const resolverStarted = Promise.withResolvers<void>();
			const errors: Error[] = [];
			const discovery = new ControlledDiscovery();
			discovery.catalogs.set(accessToken, { source: "live", fetchedAt: 100, models: [{ id: "late-route", maxMode: false }] });
			const testHarness = harness({
				discovery,
				onError: (error) => errors.push(error),
				resolveCurrentAccessToken: () => { resolverStarted.resolve(); return delayed.promise; },
			});
			const execution = collect(testHarness.registrations[0]!.streamSimple(fabricatedModel("late-route"), context, { apiKey: accessToken }));
			await resolverStarted.promise;
			await testHarness.runtime.dispose();
			if (outcome === "selected") delayed.resolve(accessToken);
			else delayed.reject(new Error("private disposed resolver detail"));
			assert.equal((await execution).at(-1)?.type, "error");
			assert.deepEqual(discovery.calls, []);
			assert.deepEqual(testHarness.cache.saves, []);
			assert.deepEqual(testHarness.cache.clears, []);
			assert.deepEqual(errors, []);
			assert.deepEqual(testHarness.registrations.at(-1)?.models, []);
			assert.notEqual(testHarness.runtime.getCatalogRefreshStatus().state, "fresh");
		});
	}
});
