import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import type { ProviderConfigInput } from "../../packages/coding-agent/src/core/model-registry-types.js";
import { trustedCursorProviderSource } from "../../packages/coding-agent/test/cursor-test-provider-source.js";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type {
	CursorExecutionAuthorityScheduler,
	CursorExecutionAuthorityTimer,
} from "../../packages/cursor/src/execution-authority.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import {
	registerCursorProvider,
	type CursorProviderConfig,
	type CursorProviderContext,
	type CursorProviderEvent,
	type CursorProviderHost,
} from "../../packages/cursor/src/provider.js";
import type {
	CursorAgentTransport,
	CursorRunRequest,
	CursorRunStream,
	CursorServerMessage,
	CursorToolResultMessage,
	CursorTransportLifecycleSnapshot,
	CursorWriteOptions,
} from "../../packages/cursor/src/transport.js";
import { collectEvents } from "./cursor-stream-helpers.js";
async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Cursor lifecycle condition");
		await tick();
	}
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function token(subject: string, nonce: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject, nonce })).toString("base64url")}.signature`;
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
		compat: { cursorRouting: { [id]: { modelId: id, maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
	} as Model<Api>;
}

class DeferredDiscovery extends CursorModelDiscoveryService {
	readonly calls: string[] = [];
	readonly #catalogs = new Map<string, Promise<CursorModelCatalog>>();
	constructor() { super({ transport: new RecordingTransport() }); }
	set(accessToken: string, catalog: CursorModelCatalog | Promise<CursorModelCatalog>): void {
		this.#catalogs.set(accessToken, Promise.resolve(catalog));
	}
	override async discover(accessToken: string): Promise<CursorModelCatalog> {
		this.calls.push(accessToken);
		const catalog = this.#catalogs.get(accessToken);
		if (!catalog) throw new Error("No queued catalog for credential");
		return catalog;
	}
}

class CompletedStream implements CursorRunStream {
	readonly id = "completed";
	readonly messages = (async function* () { yield { type: "done", reason: "stop" } as const; })();
	async writeToolResult(_result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {}
	async cancel(): Promise<void> {}
	async close(): Promise<void> {}
}

class RecordingTransport implements CursorAgentTransport {
	readonly runs: CursorRunRequest[] = [];
	async getUsableModels(): Promise<readonly []> { return []; }
	async run(request: CursorRunRequest): Promise<CursorRunStream> { this.runs.push(request); return new CompletedStream(); }
	async dispose(): Promise<void> {}
	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot { return { openStreams: 0, cancelledStreams: 0, closedStreams: 0 }; }
}

class StalledMessages implements AsyncIterable<CursorServerMessage>, AsyncIterator<CursorServerMessage> {
	readonly releaseReturn = Promise.withResolvers<void>();
	returnCalls = 0;
	[Symbol.asyncIterator](): AsyncIterator<CursorServerMessage> { return this; }
	async next(): Promise<IteratorResult<CursorServerMessage>> { return new Promise(() => {}); }
	async return(): Promise<IteratorResult<CursorServerMessage>> {
		this.returnCalls += 1;
		await this.releaseReturn.promise;
		return { done: true, value: undefined };
	}
}
class StalledStream implements CursorRunStream {
	readonly id = "stalled-runtime-disposal";
	readonly messages = new StalledMessages();
	readonly releaseCancel = Promise.withResolvers<void>();
	cancelCalls = 0;
	async writeToolResult(_result: CursorToolResultMessage, _options?: CursorWriteOptions): Promise<void> {}
	async cancel(): Promise<void> { this.cancelCalls += 1; await this.releaseCancel.promise; }
	async close(): Promise<void> { await new Promise<void>(() => {}); }
}
class StalledTransport implements CursorAgentTransport {
	readonly stream = new StalledStream();
	runs = 0;
	async getUsableModels(): Promise<readonly []> { return []; }
	async run(): Promise<CursorRunStream> { this.runs += 1; return this.stream; }
	async dispose(): Promise<void> {}
	getLifecycleSnapshot(): CursorTransportLifecycleSnapshot { return { openStreams: this.runs, cancelledStreams: 0, closedStreams: 0 }; }
}

class MemoryCache implements CursorCatalogCache {
	catalog: CursorModelCatalog | null = null;
	clears: string[] = [];
	load(scope?: string): CursorModelCatalog | null { return this.catalog?.credentialScope === scope ? this.catalog : null; }
	save(catalog: CursorModelCatalog): void { this.catalog = catalog; }
	clear(scope?: string): void | Promise<void> { this.clears.push(scope ?? ""); this.catalog = null; }
}


class RejectingClearCache extends MemoryCache {
	override clear(scope?: string): Promise<void> {
		super.clear(scope);
		return Promise.reject(new Error("async cache clear failed"));
	}
}

interface ManualTimer extends CursorExecutionAuthorityTimer {
	readonly callback: () => void;
	cancelled: boolean;
}
class ManualScheduler implements CursorExecutionAuthorityScheduler {
	readonly timers: ManualTimer[] = [];
	schedule(callback: () => void): CursorExecutionAuthorityTimer {
		const timer: ManualTimer = { callback, cancelled: false, cancel() { this.cancelled = true; } };
		this.timers.push(timer);
		return timer;
	}
	clear(timer: CursorExecutionAuthorityTimer): void { timer.cancel(); }
}

function harness(): {
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
					models: [...config.models] as unknown as NonNullable<ProviderConfigInput["models"]>,
				}, trustedCursorProviderSource());
				registrations.push(config);
			},
			on(event, handler) { handlers.set(event, handler); },
		},
	};
}

async function events(stream: AssistantMessageEventStream): Promise<readonly { readonly type: string }[]> {
	return collectEvents(stream);
}

test("execution activates only the host-selected account and joins its in-flight discovery", async () => {
	const accountA = token("account-a", "one");
	const accountB = token("account-b", "one");
	let currentToken = accountA;
	const discovery = new DeferredDiscovery();
	discovery.set(accountA, { source: "live", fetchedAt: Date.now(), models: [{ id: "a-only", maxMode: false }] });
	const bCatalog = Promise.withResolvers<CursorModelCatalog>();
	discovery.set(accountB, bCatalog.promise);
	const transport = new RecordingTransport();
	const testHarness = harness();
	const runtime = registerCursorProvider(testHarness.host, {
		discoveryService: discovery,
		transport,
		resolveCurrentAccessToken: () => currentToken,
		catalogCache: new MemoryCache(),
	});
	const discover = testHarness.handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({ type: "model_catalog_discover" }, { mode: "print", modelRegistry: { getApiKeyForProvider: () => currentToken } });
	assert.ok(testHarness.registry.find("cursor", "a-only"));

	currentToken = accountB;
	const config = testHarness.registrations.at(-1)!;
	let settledEvents: readonly { readonly type: string }[] | undefined;
	const streamEvents = events(config.streamSimple(model("shared-b"), context, { apiKey: accountB })).then((value) => {
		settledEvents = value;
		return value;
	});
	await waitUntil(() => discovery.calls.some((value) => value === accountB) || settledEvents !== undefined);
	assert.equal(settledEvents, undefined, `stream failed before account-B discovery: ${JSON.stringify(settledEvents)}`);
	const hostDiscovery = Promise.resolve(discover(
		{ type: "model_catalog_discover" },
		{ mode: "print", modelRegistry: { getApiKeyForProvider: () => currentToken } },
	));
	await tick();
	assert.equal(discovery.calls.filter((value) => value === accountB).length, 1);
	assert.equal(testHarness.registry.find("cursor", "a-only"), undefined);
	bCatalog.resolve({ source: "live", fetchedAt: Date.now(), models: [{ id: "shared-b", maxMode: true, supportsImages: true }] });
	await hostDiscovery;
	const rejectedClone = await streamEvents;
	assert.equal(rejectedClone.at(-1)?.type, "error");
	const currentB = testHarness.registry.find("cursor", "shared-b")!;
	const result = await events(testHarness.registrations.at(-1)!.streamSimple(currentB, context, { apiKey: accountB }));
	assert.deepEqual(currentB.input, ["text", "image"]);
	assert.equal(result.at(-1)?.type, "done");
	assert.equal(transport.runs.at(-1)?.maxMode, true);
	assert.ok(testHarness.registry.find("cursor", "shared-b"));
	assert.equal(testHarness.registry.getAll().filter((entry) => entry.provider === "cursor").length, 1);

	const callsBeforeStale = discovery.calls.length;
	const stale = await events(testHarness.registrations.at(-1)!.streamSimple(model("a-only"), context, { apiKey: accountA }));
	assert.equal(stale.at(-1)?.type, "error");
	assert.equal(discovery.calls.length, callsBeforeStale);
	const accountC = token("account-c", "one");
	discovery.set(accountC, { source: "live", fetchedAt: Date.now(), models: [{ id: "c-other", maxMode: false }] });
	currentToken = accountC;
	const runsBeforeMissing = transport.runs.length;
	const missing = await events(testHarness.registrations.at(-1)!.streamSimple(model("missing-c"), context, { apiKey: accountC }));
	assert.equal(missing.at(-1)?.type, "error");
	assert.equal(transport.runs.length, runsBeforeMissing);
	assert.ok(testHarness.registry.find("cursor", "c-other"));
	assert.equal(testHarness.registry.find("cursor", "shared-b"), undefined);
	await runtime.dispose();
});


test("cold execution rejects a stale caller credential before discovery or catalog mutation", async () => {
	const staleAccount = token("cold-stale", "one");
	const selectedAccount = token("cold-selected", "one");
	let currentToken: string | undefined = selectedAccount;
	const discovery = new DeferredDiscovery();
	discovery.set(staleAccount, { source: "live", fetchedAt: Date.now(), models: [{ id: "stale-route", maxMode: false }] });
	discovery.set(selectedAccount, { source: "live", fetchedAt: Date.now(), models: [{ id: "selected-route", maxMode: true }] });
	const transport = new RecordingTransport();
	const cache = new MemoryCache();
	const testHarness = harness();
	const runtime = registerCursorProvider(testHarness.host, {
		discoveryService: discovery,
		transport,
		catalogCache: cache,
		resolveCurrentAccessToken: () => currentToken,
	});

	const stale = await events(testHarness.registrations.at(-1)!.streamSimple(model("stale-route"), context, { apiKey: staleAccount }));
	assert.equal(stale.at(-1)?.type, "error");
	assert.deepEqual(discovery.calls, []);
	assert.equal(transport.runs.length, 0);
	assert.equal(testHarness.registry.getAll().some((entry) => entry.provider === "cursor"), false);
	assert.equal(cache.catalog, null);

	const copied = await events(testHarness.registrations.at(-1)!.streamSimple(model("selected-route"), context, { apiKey: selectedAccount }));
	assert.equal(copied.at(-1)?.type, "error");
	assert.deepEqual(discovery.calls, [selectedAccount]);
	const selectedModel = testHarness.registry.find("cursor", "selected-route")!;
	const selected = await events(testHarness.registrations.at(-1)!.streamSimple(selectedModel, context, { apiKey: selectedAccount }));
	assert.equal(selected.at(-1)?.type, "done");
	assert.equal(transport.runs.length, 1);
	assert.equal(transport.runs[0]?.maxMode, true);

	currentToken = undefined;
	const noHostCredential = await events(testHarness.registrations.at(-1)!.streamSimple(model("selected-route"), context, { apiKey: selectedAccount }));
	assert.equal(noHostCredential.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 1);
	await runtime.dispose();
});


test("current-account discovery failure leaves no executable routes or stale-account fallback", async () => {
	const accountA = token("failure-a", "one");
	const accountB = token("failure-b", "one");
	let currentToken = accountA;
	const discovery = new DeferredDiscovery();
	discovery.set(accountA, { source: "live", fetchedAt: Date.now(), models: [{ id: "shared-route", maxMode: false }] });
	const bCatalog = Promise.withResolvers<CursorModelCatalog>();
	discovery.set(accountB, bCatalog.promise);
	const transport = new RecordingTransport();
	const testHarness = harness();
	const runtime = registerCursorProvider(testHarness.host, {
		discoveryService: discovery,
		transport,
		catalogCache: new MemoryCache(),
		resolveCurrentAccessToken: () => currentToken,
	});
	const discover = testHarness.handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({ type: "model_catalog_discover" }, { mode: "print", modelRegistry: { getApiKeyForProvider: () => currentToken } });
	assert.ok(testHarness.registry.find("cursor", "shared-route"));

	currentToken = accountB;
	const pendingEvents = events(testHarness.registrations.at(-1)!.streamSimple(model("shared-route"), context, { apiKey: accountB }));
	await waitUntil(() => discovery.calls.includes(accountB));
	assert.equal(testHarness.registry.getAll().some((entry) => entry.provider === "cursor"), false);
	bCatalog.reject(new Error("account B catalog unavailable"));
	const failed = await pendingEvents;

	assert.equal(failed.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	assert.equal(testHarness.registry.getAll().some((entry) => entry.provider === "cursor"), false);
	assert.equal(runtime.getCatalogRefreshStatus().state, "failed");
	const callsBeforeStale = discovery.calls.length;
	const stale = await events(testHarness.registrations.at(-1)!.streamSimple(model("shared-route"), context, { apiKey: accountA }));
	assert.equal(stale.at(-1)?.type, "error");
	assert.equal(discovery.calls.length, callsBeforeStale);
	await runtime.dispose();
});
test("silent TTL expiry removes real registry rows, cache state, and an active stream while ignoring a stale timer", async () => {
	const accountA = token("ttl-a", "one");
	const accountB = token("ttl-b", "one");
	let currentToken = accountA;
	let now = 0;
	const scheduler = new ManualScheduler();
	const discovery = new DeferredDiscovery();
	discovery.set(accountA, { source: "live", fetchedAt: 0, models: [{ id: "a-route", maxMode: false }] });
	discovery.set(accountB, { source: "live", fetchedAt: 1, models: [{ id: "b-route", maxMode: true }] });
	const cache = new MemoryCache();
	const transport = new StalledTransport();
	const testHarness = harness();
	const runtime = registerCursorProvider(testHarness.host, {
		discoveryService: discovery,
		transport,
		catalogCache: cache,
		catalogCacheTtlMs: 10,
		now: () => now,
		executionAuthorityScheduler: scheduler,
		resolveCurrentAccessToken: () => currentToken,
	});
	const discover = testHarness.handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({ type: "model_catalog_discover" }, { mode: "print", modelRegistry: { getApiKeyForProvider: () => currentToken } });
	const oldTimer = scheduler.timers.at(-1);
	assert.ok(oldTimer);
	assert.ok(testHarness.registry.find("cursor", "a-route"));

	currentToken = accountB;
	now = 1;
	await discover({ type: "model_catalog_discover" }, { mode: "print", modelRegistry: { getApiKeyForProvider: () => currentToken } });
	assert.ok(testHarness.registry.find("cursor", "b-route"));
	oldTimer.callback();
	assert.ok(testHarness.registry.find("cursor", "b-route"), "stale account-A timer must not clear account B");

	const currentTimer = scheduler.timers.at(-1);
	assert.ok(currentTimer);
	const activeModel = testHarness.registry.find("cursor", "b-route")!;
	const activeEvents = events(testHarness.registrations.at(-1)!.streamSimple(activeModel, context, { apiKey: accountB }));
	await waitUntil(() => transport.runs === 1);
	now = 11;
	currentTimer.callback();
	assert.equal(cache.catalog, null, "expiry must invoke the scoped cache clear before its callback returns");
	assert.equal(cache.clears.length > 0, true);
	const expiredEvents = await activeEvents;

	assert.equal(expiredEvents.at(-1)?.type, "error");
	assert.equal(transport.stream.cancelCalls, 1);
	assert.equal(transport.stream.messages.returnCalls, 1);
	assert.equal(runtime.streamAdapter.getLifecycleSnapshot().activeTurns, 0);
	assert.equal(testHarness.registry.find("cursor", "b-route"), undefined);
	assert.equal(testHarness.registry.getAll().some((entry) => entry.provider === "cursor"), false);
	assert.equal(runtime.getCatalogRefreshStatus().state, "failed");
	assert.equal(runtime.getCatalogRefreshStatus().fetchedAt, undefined);
	transport.stream.messages.releaseReturn.resolve();
	transport.stream.releaseCancel.resolve();
	await runtime.dispose();
});

test("provider disposal is bounded and detaches permanently stalled cleanup", async () => {
	const accessToken = token("dispose-bound", "one");
	const discovery = new DeferredDiscovery();
	discovery.set(accessToken, { source: "live", fetchedAt: Date.now(), models: [{ id: "dispose-route", maxMode: false }] });
	const transport = new StalledTransport();
	const testHarness = harness();
	const runtime = registerCursorProvider(testHarness.host, {
		discoveryService: discovery,
		transport,
		catalogCache: new MemoryCache(),
		resolveCurrentAccessToken: () => accessToken,
		streamDisposeGraceMs: 5,
	});
	const discover = testHarness.handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({ type: "model_catalog_discover" }, { mode: "print", modelRegistry: { getApiKeyForProvider: () => accessToken } });
	assert.ok(testHarness.registry.find("cursor", "dispose-route"));
	const disposeModel = testHarness.registry.find("cursor", "dispose-route")!;
	const streamEvents = events(testHarness.registrations.at(-1)!.streamSimple(disposeModel, context, { apiKey: accessToken }));
	await waitUntil(() => transport.runs === 1);

	await Promise.race([
		runtime.dispose(),
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("provider disposal exceeded its bound")), 100)),
	]);
	assert.equal(runtime.streamAdapter.getLifecycleSnapshot().activeTurns, 0);
	assert.equal(runtime.streamAdapter.getPendingCleanupCount(), 0);
	assert.equal(transport.stream.messages.returnCalls, 1);
	assert.equal(transport.stream.cancelCalls, 1);
	assert.equal(testHarness.registry.find("cursor", "dispose-route"), undefined);
	assert.notEqual(runtime.getCatalogRefreshStatus().state, "fresh");
	const result = await streamEvents;
	assert.equal(result.at(-1)?.type, "error");
});

test("TTL expiry contains asynchronous cache-clear failures after immediate invalidation", async () => {
	const accessToken = token("ttl-clear-failure", "one");
	let now = 0;
	const scheduler = new ManualScheduler();
	const discovery = new DeferredDiscovery();
	discovery.set(accessToken, { source: "live", fetchedAt: 0, models: [{ id: "ttl-route", maxMode: false }] });
	const cache = new RejectingClearCache();
	const errors: Error[] = [];
	const testHarness = harness();
	const runtime = registerCursorProvider(testHarness.host, {
		discoveryService: discovery,
		transport: new RecordingTransport(),
		catalogCache: cache,
		catalogCacheTtlMs: 10,
		now: () => now,
		executionAuthorityScheduler: scheduler,
		resolveCurrentAccessToken: () => accessToken,
		onCatalogRefreshError: (error) => errors.push(error),
	});
	const discover = testHarness.handlers.get("model_catalog_discover");
	assert.ok(discover);
	await discover({ type: "model_catalog_discover" }, { mode: "print", modelRegistry: { getApiKeyForProvider: () => accessToken } });
	const timer = scheduler.timers.at(-1);
	assert.ok(timer);
	now = 10;
	timer.callback();
	assert.equal(cache.catalog, null);
	assert.equal(testHarness.registry.find("cursor", "ttl-route"), undefined);
	await tick();
	assert.equal(errors.some((error) => error.message === "Cursor model catalog cache clear failed."), true);
	await runtime.dispose();
});

for (const credentialFailure of ["missing", "throws"] as const) {
	test(`stored-credential discovery fails closed when the host credential ${credentialFailure}`, async () => {
		const accessToken = token(`logout-${credentialFailure}`, "secret-nonce");
		let credentialState: string | undefined = accessToken;
		const discovery = new DeferredDiscovery();
		discovery.set(accessToken, { source: "live", fetchedAt: Date.now(), models: [{ id: "logout-route", maxMode: false }] });
		const cache = new MemoryCache();
		const transport = new RecordingTransport();
		const testHarness = harness();
		const runtime = registerCursorProvider(testHarness.host, { discoveryService: discovery, transport, catalogCache: cache });
		const discover = testHarness.handlers.get("model_catalog_discover");
		assert.ok(discover);
		const getCredential = (): string | undefined => {
			if (credentialFailure === "throws" && credentialState === undefined) throw new Error(`secret resolver detail ${accessToken}`);
			return credentialState;
		};
		const discoveryContext = { mode: "print" as const, modelRegistry: { getApiKeyForProvider: getCredential } };
		await discover({ type: "model_catalog_discover" }, discoveryContext);
		assert.ok(testHarness.registry.find("cursor", "logout-route"));
		assert.notEqual(cache.catalog, null);

		credentialState = undefined;
		await assert.rejects(
			Promise.resolve(discover({ type: "model_catalog_discover" }, discoveryContext)),
			(error: Error) => /log in again.*reselect/i.test(error.message) && !error.message.includes(accessToken) && !error.message.includes("secret resolver detail"),
		);
		assert.equal(testHarness.registry.find("cursor", "logout-route"), undefined);
		assert.equal(cache.catalog, null);
		assert.equal(runtime.getCatalogRefreshStatus().state, "failed");
		const stale = await events(testHarness.registrations.at(-1)!.streamSimple(model("logout-route"), context, { apiKey: accessToken }));
		assert.equal(stale.at(-1)?.type, "error");
		assert.equal(transport.runs.length, 0);
		await runtime.dispose();
	});
}
