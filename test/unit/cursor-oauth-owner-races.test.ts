import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const callbacks = (signal?: AbortSignal): OAuthLoginCallbacks => ({ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined, signal });
const jwt = (subject: string, nonce: string): string => `header.${Buffer.from(JSON.stringify({ sub: subject, nonce })).toString("base64url")}.signature`;
const credentials = (access: string): OAuthCredentials => ({ access, refresh: `refresh-${access}`, expires: 123 });
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

class Auth extends CursorAuthService {
	constructor(
		readonly loginImpl: CursorAuthService["login"],
		readonly refreshImpl: CursorAuthService["refreshToken"],
	) { super(); }
	override login(value: OAuthLoginCallbacks): Promise<OAuthCredentials> { return this.loginImpl(value); }
	override refreshToken(value: OAuthCredentials): Promise<OAuthCredentials> { return this.refreshImpl(value); }
}

class Discovery extends CursorModelDiscoveryService {
	constructor(readonly impl: CursorModelDiscoveryService["discover"]) { super({ transport: new CursorMockTransport() }); }
	override discover(access: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
		return this.impl(access, requestId, signal);
	}
}

function host(): { readonly value: CursorProviderHost; readonly registrations: CursorProviderConfig[] } {
	const registrations: CursorProviderConfig[] = [];
	return { registrations, value: { registerProvider(_name, config) { registrations.push(config); }, on() {} } };
}

function selected(config: CursorProviderConfig): Model<Api> {
	const value = config.models[0];
	if (!value) throw new Error("Expected current Cursor model");
	return value as unknown as Model<Api>;
}

async function drain(stream: AsyncIterable<object>): Promise<void> {
	for await (const _event of stream) { /* consume */ }
}

test("a delayed refresh cannot roll back a newer login account", async () => {
	const tokenA = jwt("refresh-a", "old");
	const tokenB = jwt("login-b", "current");
	const refreshA = Promise.withResolvers<OAuthCredentials>();
	const refreshStarted = Promise.withResolvers<void>();
	const discoveryCalls: string[] = [];
	const saved: string[][] = [];
	const streamStarted = Promise.withResolvers<void>();
	const releaseStream = Promise.withResolvers<void>();
	const transport = new CursorMockTransport({ messageFactory: () => (async function* () {
		streamStarted.resolve();
		await releaseStream.promise;
		yield { type: "done", reason: "stop" } as const;
	})() });
	const auth = new Auth(
		async () => credentials(tokenB),
		async () => { refreshStarted.resolve(); return refreshA.promise; },
	);
	const discovery = new Discovery(async (access) => {
		discoveryCalls.push(access);
		return { source: "live", fetchedAt: 10, models: [{ id: access === tokenB ? "b-current" : "a-stale-refresh", maxMode: false }] };
	});
	const current = host();
	const runtime = registerCursorProvider(current.value, {
		authService: auth, discoveryService: discovery, transport,
		catalogCache: { load: () => null, save(catalog) { saved.push(catalog.models.map((entry) => entry.id)); }, clear() {} },
		resolveCurrentAccessToken: () => tokenB, now: () => 10, uuid: () => `owner-${discoveryCalls.length}`,
	});
	const stale = current.registrations[0]!.oauth.refreshToken(credentials(tokenA));
	await refreshStarted.promise;
	assert.equal((await current.registrations[0]!.oauth.login(callbacks())).access, tokenB);
	const active = drain(current.registrations.at(-1)!.streamSimple(selected(current.registrations.at(-1)!), context, { apiKey: tokenB }));
	await streamStarted.promise;
	refreshA.resolve(credentials(tokenA));
	await assert.rejects(stale, /superseded/u);
	assert.deepEqual(discoveryCalls, [tokenB]);
	assert.equal(current.registrations.at(-1)?.models[0]?.id, "b-current");
	assert.deepEqual(saved, [["b-current"]]);
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 10 });
	assert.equal(transport.runs[0]?.request.signal?.aborted, false);
	releaseStream.resolve();
	await active;
	assert.equal(transport.runs[0]?.stream.cancelled, false);
	await runtime.dispose();
});

test("out-of-order refreshes retain only the newest refresh owner", async () => {
	const tokenA = jwt("refresh-a", "one");
	const tokenB = jwt("refresh-b", "two");
	const authA = Promise.withResolvers<OAuthCredentials>();
	const catalogB = Promise.withResolvers<CursorModelCatalog>();
	const savedB = Promise.withResolvers<void>();
	let refreshCalls = 0;
	const discoveryCalls: string[] = [];
	const auth = new Auth(async () => { throw new Error("unexpected login"); }, async () => {
		refreshCalls += 1;
		return refreshCalls === 1 ? authA.promise : credentials(tokenB);
	});
	const discovery = new Discovery((access) => {
		discoveryCalls.push(access);
		return access === tokenB ? catalogB.promise : Promise.resolve({ source: "live", fetchedAt: 1, models: [{ id: "a-stale", maxMode: false }] });
	});
	const current = host();
	const runtime = registerCursorProvider(current.value, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: { load: () => null, save(catalog) { if (catalog.models[0]?.id === "b-current") savedB.resolve(); }, clear() {} },
		now: () => 2, uuid: () => `refresh-${refreshCalls}`,
	});
	const stale = current.registrations[0]!.oauth.refreshToken(credentials(tokenA));
	const newest = current.registrations[0]!.oauth.refreshToken(credentials(tokenB));
	assert.equal((await newest).access, tokenB);
	catalogB.resolve({ source: "live", fetchedAt: 2, models: [{ id: "b-current", maxMode: true }] });
	await savedB.promise;
	authA.resolve(credentials(tokenA));
	await assert.rejects(stale, /superseded/u);
	assert.deepEqual(discoveryCalls, [tokenB]);
	assert.equal(current.registrations.at(-1)?.models[0]?.id, "b-current");
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 2 });
	await runtime.dispose();
});

test("cancelling the current adopted login owner fences its login-owned producer", async () => {
	const token = jwt("shared-login", "same");
	const catalog = Promise.withResolvers<CursorModelCatalog>();
	const started = Promise.withResolvers<void>();
	const waiterAttached = Promise.withResolvers<void>();
	let signal: AbortSignal | undefined;
	let saves = 0;
	const discovery = new Discovery((_access, _request, value) => {
		signal = value;
		started.resolve();
		return catalog.promise;
	});
	const auth = new Auth(async () => credentials(token), async () => { throw new Error("unexpected refresh"); });
	const current = host();
	const runtime = registerCursorProvider(current.value, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: { load: () => null, save() { saves += 1; }, clear() {} }, uuid: () => "shared-owner",
	});
	const loginA = current.registrations[0]!.oauth.login(callbacks());
	await started.promise;
	const controllerB = new AbortController();
	const add = controllerB.signal.addEventListener.bind(controllerB.signal);
	Object.defineProperty(controllerB.signal, "addEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
		add(type, listener, options);
		if (type === "abort") waiterAttached.resolve();
	} });
	const loginB = current.registrations[0]!.oauth.login(callbacks(controllerB.signal));
	await waiterAttached.promise;
	controllerB.abort(new Error("cancel current B"));
	await assert.rejects(loginB, /cancel|authenticated model discovery failed/u);
	assert.equal(signal?.aborted, true);
	catalog.resolve({ source: "live", fetchedAt: 3, models: [{ id: "must-not-publish", maxMode: false }] });
	await assert.rejects(loginA, /superseded/u);
	assert.equal(current.registrations.at(-1)?.models.length, 0);
	assert.equal(saves, 0);
	assert.notEqual(runtime.getCatalogRefreshStatus().state, "fresh");
	await runtime.dispose();
});

test("a rejected adopted producer remains observed and inert after current-owner cancellation", async () => {
	const token = jwt("shared-login-reject", "same");
	const catalog = Promise.withResolvers<CursorModelCatalog>();
	const started = Promise.withResolvers<void>();
	const waiterAttached = Promise.withResolvers<void>();
	let producerSignal: AbortSignal | undefined;
	let unhandled: object | undefined;
	const onUnhandled = (reason: object): void => { unhandled = reason; };
	process.on("unhandledRejection", onUnhandled);
	const current = host();
	const runtime = registerCursorProvider(current.value, {
		authService: new Auth(async () => credentials(token), async () => { throw new Error("unexpected refresh"); }),
		discoveryService: new Discovery((_access, _request, signal) => { producerSignal = signal; started.resolve(); return catalog.promise; }),
		transport: new CursorMockTransport(), catalogCache: { load: () => null, save() {}, clear() {} }, uuid: () => "shared-owner-reject",
	});
	try {
		const loginA = current.registrations[0]!.oauth.login(callbacks());
		await started.promise;
		const controllerB = new AbortController();
		const add = controllerB.signal.addEventListener.bind(controllerB.signal);
		Object.defineProperty(controllerB.signal, "addEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
			add(type, listener, options);
			if (type === "abort") waiterAttached.resolve();
		} });
		const loginB = current.registrations[0]!.oauth.login(callbacks(controllerB.signal));
		await waiterAttached.promise;
		controllerB.abort(new Error("cancel current B"));
		await assert.rejects(loginB, /cancel|authenticated model discovery failed/u);
		assert.equal(producerSignal?.aborted, true);
		catalog.reject(new Error("late producer rejection"));
		await assert.rejects(loginA, /superseded/u);
		await Promise.resolve();
		assert.equal(unhandled, undefined);
		assert.equal(current.registrations.at(-1)?.models.length, 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		await runtime.dispose();
	}
});
