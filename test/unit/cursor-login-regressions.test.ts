import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { CursorModelDiscoveryError, CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const callbacks = (signal?: AbortSignal): OAuthLoginCallbacks => ({ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined, signal });
function trackAbortListeners(signal: AbortSignal): () => number {
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	let count = 0;
	Object.defineProperty(signal, "addEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
		if (type === "abort") count += 1;
		add(type, listener, options);
	} });
	Object.defineProperty(signal, "removeEventListener", { configurable: true, value(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
		if (type === "abort") count -= 1;
		remove(type, listener, options);
	} });
	return () => count;
}
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const jwtForSubject = (subject: string, nonce: string): string =>
	`header.${Buffer.from(JSON.stringify({ sub: subject, nonce })).toString("base64url")}.signature`;

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

class TestCursorAuthService extends CursorAuthService {
	readonly #login: CursorAuthService["login"];
	readonly #refreshToken: CursorAuthService["refreshToken"];

	constructor(options: {
		readonly login?: CursorAuthService["login"];
		readonly refreshToken?: CursorAuthService["refreshToken"];
	}) {
		super();
		this.#login = options.login ?? (async () => { throw new Error("Unexpected Cursor login in test"); });
		this.#refreshToken = options.refreshToken ?? (async () => { throw new Error("Unexpected Cursor token refresh in test"); });
	}

	override login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return this.#login(callbacks);
	}

	override refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return this.#refreshToken(credentials);
	}
}

function cursorDiscoveryService(service: { readonly discover: CursorModelDiscoveryService["discover"] }): CursorModelDiscoveryService {
	return new TestCursorDiscoveryService(service.discover);
}

function cursorAuthService(options: ConstructorParameters<typeof TestCursorAuthService>[0]): CursorAuthService {
	return new TestCursorAuthService(options);
}
function makeHost(): { host: CursorProviderHost; registrations: CursorProviderConfig[] } {
	const registrations: CursorProviderConfig[] = [];
	return { registrations, host: { registerProvider(_name, config) { registrations.push(config); }, on() {} } };
}

function firstModel(config: CursorProviderConfig): Model<Api> {
	const current = config.models[0];
	if (current) return current as unknown as Model<Api>;
	return {
		id: "test-exact-route", name: "Test Exact Route", provider: "cursor", api: config.api, baseUrl: config.baseUrl,
		input: ["text"], reasoning: false, contextWindow: 200_000, maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

async function drain(stream: AsyncIterable<object>): Promise<void> {
	for await (const _event of stream) {
		// Exercise the public stream path that schedules credential rediscovery.
	}
}

test("a cross-account stream cannot supersede login catalog discovery", async () => {
	const accessA = jwtForSubject("account-a", "login");
	const accessB = jwtForSubject("account-b", "stream");
	const pending = new Map<string, { resolve(catalog: CursorModelCatalog): void; reject(error: Error): void }>();
	const discovery = cursorDiscoveryService({
		discover: (accessToken: string): Promise<CursorModelCatalog> =>
			new Promise((resolve, reject) => pending.set(accessToken, { resolve, reject })),
	});
	const auth = cursorAuthService({ login: async () => ({ access: accessA, refresh: "refresh-a", expires: 123 }) });
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery,
		transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }), uuid: () => `request-${pending.size}`,
	});
	const login = registrations[0]!.oauth.login(callbacks());
	await nextTick();
	await drain(registrations[0]!.streamSimple(firstModel(registrations[0]!), context, { apiKey: accessB }));
	assert.equal(pending.has(accessB), false);
	pending.get(accessA)?.resolve({ source: "live", fetchedAt: 2, models: [{ id: "model-a", maxMode: false }] });
	await login;
	assert.equal(registrations.at(-1)?.models.some((model) => model.id === "model-a"), true);
	await runtime.dispose();
});

test("a stale cross-account login cannot cancel a newer published account or its active stream", async () => {
	const accessA = jwtForSubject("stale-account-a", "login-a");
	const accessB = jwtForSubject("current-account-b", "login-b");
	const catalogA = Promise.withResolvers<CursorModelCatalog>();
	const catalogB = Promise.withResolvers<CursorModelCatalog>();
	const startedA = Promise.withResolvers<void>();
	const startedB = Promise.withResolvers<void>();
	const signals = new Map<string, AbortSignal | undefined>();
	const discovery = cursorDiscoveryService({
		discover(accessToken, _requestId, signal) {
			signals.set(accessToken, signal);
			if (accessToken === accessA) { startedA.resolve(); return catalogA.promise; }
			startedB.resolve();
			return catalogB.promise;
		},
	});
	let authCalls = 0;
	const auth = cursorAuthService({
		login: async () => {
			authCalls += 1;
			return { access: authCalls === 1 ? accessA : accessB, refresh: `refresh-${authCalls}`, expires: 123 };
		},
	});
	const streamStarted = Promise.withResolvers<void>();
	const releaseStream = Promise.withResolvers<void>();
	const transport = new CursorMockTransport({ messageFactory: () => (async function* () {
		streamStarted.resolve();
		await releaseStream.promise;
		yield { type: "done", reason: "stop" } as const;
	})() });
	const savedIds: string[][] = [];
	const refreshErrors: Error[] = [];
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport,
		catalogCache: { load: () => null, save: (catalog) => { savedIds.push(catalog.models.map((model) => model.id)); }, clear() {} },
		resolveCurrentAccessToken: () => accessB, now: () => 100, uuid: () => `owner-${authCalls}-${savedIds.length}`,
		onCatalogRefreshError: (error) => refreshErrors.push(error),
	});
	const controllerA = new AbortController();
	const abortListenerCount = trackAbortListeners(controllerA.signal);
	const loginA = registrations[0]!.oauth.login(callbacks(controllerA.signal));
	await startedA.promise;
	const loginB = registrations[0]!.oauth.login(callbacks());
	await startedB.promise;
	catalogB.resolve({ source: "live", fetchedAt: 100, models: [{ id: "b-route", maxMode: false }] });
	assert.equal((await loginB).access, accessB);
	const bModel = firstModel(registrations.at(-1)!);
	const activeStream = drain(registrations.at(-1)!.streamSimple(bModel, context, { apiKey: accessB }));
	await streamStarted.promise;
	assert.equal(transport.runs[0]?.request.signal?.aborted, false);

	controllerA.abort();
	await assert.rejects(loginA, /superseded|authenticated model discovery failed/u);
	assert.equal(abortListenerCount(), 0);
	assert.equal(registrations.at(-1)?.models[0]?.id, "b-route");
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 100 });
	assert.deepEqual(savedIds.at(-1), ["b-route"]);
	assert.equal(signals.get(accessB)?.aborted, false);
	assert.equal(transport.runs[0]?.request.signal?.aborted, false);
	assert.equal(transport.runs[0]?.stream.cancelled, false);

	catalogA.reject(new CursorModelDiscoveryError("ProtocolError", "stale A failed late"));
	await Promise.resolve();
	assert.equal(registrations.at(-1)?.models[0]?.id, "b-route");
	assert.deepEqual(savedIds.at(-1), ["b-route"]);
	assert.deepEqual(refreshErrors, []);
	releaseStream.resolve();
	await activeStream;
	assert.equal(transport.runs[0]?.stream.cancelled, false);
	await runtime.dispose();
});

test("a stale same-token login cannot abort the producer shared by the current login owner", async () => {
	const accessToken = jwtForSubject("shared-login-owner", "same-token");
	const catalog = Promise.withResolvers<CursorModelCatalog>();
	const discoveryStarted = Promise.withResolvers<void>();
	let discoveryCalls = 0;
	let producerSignal: AbortSignal | undefined;
	const discovery = cursorDiscoveryService({
		discover(_accessToken, _requestId, signal) {
			discoveryCalls += 1;
			producerSignal = signal;
			discoveryStarted.resolve();
			return catalog.promise;
		},
	});
	const auth = cursorAuthService({ login: async () => ({ access: accessToken, refresh: "refresh", expires: 123 }) });
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: { load: () => null, save() {}, clear() {} }, now: () => 4, uuid: () => `shared-owner-${discoveryCalls}`,
	});
	const controllerA = new AbortController();
	const loginA = registrations[0]!.oauth.login(callbacks(controllerA.signal));
	await discoveryStarted.promise;
	const loginB = registrations[0]!.oauth.login(callbacks());
	await Promise.resolve();
	assert.equal(discoveryCalls, 1);
	controllerA.abort();
	await assert.rejects(loginA, /superseded/u);
	assert.equal(producerSignal?.aborted, false);
	catalog.resolve({ source: "live", fetchedAt: 4, models: [{ id: "shared-owner-route", maxMode: false }] });
	assert.equal((await loginB).access, accessToken);
	assert.equal(registrations.at(-1)?.models[0]?.id, "shared-owner-route");
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 4 });
	await runtime.dispose();
});

test("a login that authenticates late cannot replace the newer login owner", async () => {
	const accessA = jwtForSubject("late-auth-a", "a");
	const accessB = jwtForSubject("current-auth-b", "b");
	const authA = Promise.withResolvers<OAuthCredentials>();
	let authCalls = 0;
	const auth = cursorAuthService({
		login: async () => {
			authCalls += 1;
			return authCalls === 1 ? authA.promise : { access: accessB, refresh: "refresh-b", expires: 123 };
		},
	});
	const discoveryCalls: string[] = [];
	const discovery = cursorDiscoveryService({
		async discover(accessToken) {
			discoveryCalls.push(accessToken);
			return { source: "live", fetchedAt: 8, models: [{ id: "b-auth-route", maxMode: false }] };
		},
	});
	const savedIds: string[][] = [];
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: { load: () => null, save: (catalog) => { savedIds.push(catalog.models.map((model) => model.id)); }, clear() {} },
		now: () => 8, uuid: () => `late-auth-${discoveryCalls.length}`,
	});
	const loginA = registrations[0]!.oauth.login(callbacks());
	const loginB = registrations[0]!.oauth.login(callbacks());
	assert.equal((await loginB).access, accessB);
	assert.deepEqual(discoveryCalls, [accessB]);
	authA.resolve({ access: accessA, refresh: "refresh-a", expires: 123 });
	await assert.rejects(loginA, /superseded/u);
	assert.deepEqual(discoveryCalls, [accessB]);
	assert.equal(registrations.at(-1)?.models[0]?.id, "b-auth-route");
	assert.deepEqual(savedIds, [["b-auth-route"]]);
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "fresh", fetchedAt: 8 });
	await runtime.dispose();
});

test("a discovery that settles after a newer login invocation cannot publish before the newer authentication finishes", async () => {
	const accessA = jwtForSubject("stale-publish-a", "a");
	const accessB = jwtForSubject("current-publish-b", "b");
	const catalogA = Promise.withResolvers<CursorModelCatalog>();
	const authB = Promise.withResolvers<OAuthCredentials>();
	const startedA = Promise.withResolvers<void>();
	let authCalls = 0;
	const auth = cursorAuthService({
		login: async () => {
			authCalls += 1;
			return authCalls === 1 ? { access: accessA, refresh: "refresh-a", expires: 123 } : authB.promise;
		},
	});
	const discovery = cursorDiscoveryService({
		discover(accessToken) {
			if (accessToken === accessA) { startedA.resolve(); return catalogA.promise; }
			return Promise.resolve({ source: "live", fetchedAt: 10, models: [{ id: "current-b-route", maxMode: false }] });
		},
	});
	const savedIds: string[][] = [];
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: { load: () => null, save: (catalog) => { savedIds.push(catalog.models.map((model) => model.id)); }, clear() {} },
		now: () => 10, uuid: () => `stale-publish-${savedIds.length}`,
	});
	const loginA = registrations[0]!.oauth.login(callbacks());
	await startedA.promise;
	const loginB = registrations[0]!.oauth.login(callbacks());
	catalogA.resolve({ source: "live", fetchedAt: 9, models: [{ id: "must-not-publish-a", maxMode: false }] });
	await assert.rejects(loginA, /superseded/u);
	assert.equal(registrations.at(-1)?.models.some((model) => model.id === "must-not-publish-a"), false);
	assert.deepEqual(savedIds, []);
	authB.resolve({ access: accessB, refresh: "refresh-b", expires: 123 });
	assert.equal((await loginB).access, accessB);
	assert.equal(registrations.at(-1)?.models[0]?.id, "current-b-route");
	assert.deepEqual(savedIds, [["current-b-route"]]);
	await runtime.dispose();
});

test("authoritative empty login waits for ordered durable cache invalidation", async () => {
	const accessToken = jwtForSubject("empty-awaits-cache", "token");
	const clearStarted = Promise.withResolvers<void>();
	const releaseClear = Promise.withResolvers<void>();
	const auth = cursorAuthService({ login: async () => ({ access: accessToken, refresh: "refresh", expires: 123 }) });
	const discovery = cursorDiscoveryService({
		async discover() { return { source: "live", fetchedAt: 11, models: [] }; },
	});
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: {
			load: () => null, save: () => true,
			async clear() { clearStarted.resolve(); await releaseClear.promise; },
		},
		now: () => 11, uuid: () => "empty-awaits-cache",
	});
	let settled = false;
	const login = registrations[0]!.oauth.login(callbacks()).then((credentials) => { settled = true; return credentials; });
	await clearStarted.promise;
	await Promise.resolve();
	assert.equal(settled, false);
	releaseClear.resolve();
	assert.equal((await login).access, accessToken);
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "empty", fetchedAt: 11 });
	await runtime.dispose();
});

test("runtime disposal aborts an in-flight authenticated login discovery", async () => {
	const callbackController = new AbortController();
	let discoverySignal: AbortSignal | undefined;
	const discovery = cursorDiscoveryService({
		discover(_accessToken, _requestId, signal) {
			discoverySignal = signal;
			return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new CursorModelDiscoveryError("Aborted", "login discovery aborted")), { once: true }));
		},
	});
	const auth = cursorAuthService({ login: async () => ({ access: "login-access", refresh: "refresh", expires: 123 }) });
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogDiscoveryDisposeTimeoutMs: 5, uuid: () => "login-dispose",
	});
	const login = registrations[0]!.oauth.login(callbacks(callbackController.signal));
	await nextTick();
	assert.equal(discoverySignal?.aborted, false);

	try {
		await runtime.dispose();
		assert.equal(discoverySignal?.aborted, true);
	} finally {
		callbackController.abort();
		await login.catch(() => undefined);
	}
});

test("caller cancellation fences an authoritative empty login discovery that resolves late", async () => {
	const controller = new AbortController();
	let resolveDiscovery: ((catalog: CursorModelCatalog) => void) | undefined;
	let discoverySignal: AbortSignal | undefined;
	let cacheSaves = 0;
	const discovery = cursorDiscoveryService({
		discover(_accessToken, _requestId, signal) {
			discoverySignal = signal;
			return new Promise((resolve) => { resolveDiscovery = resolve; });
		},
	});
	const auth = cursorAuthService({ login: async () => ({ access: "owned-login-access", refresh: "refresh", expires: 123 }) });
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery, transport: new CursorMockTransport(),
		catalogCache: { load: () => null, save: () => { cacheSaves += 1; } },
		uuid: () => "owned-login",
	});
	const login = registrations[0]!.oauth.login(callbacks(controller.signal));
	await nextTick();
	controller.abort();
	await assert.rejects(login, /authenticated model discovery failed/u);
	assert.equal(discoverySignal?.aborted, true);
	resolveDiscovery?.({ source: "live", fetchedAt: 4, models: [] });
	await nextTick();
	assert.equal(registrations.at(-1)?.models.length, 0);
	assert.equal(cacheSaves, 0);
	assert.equal(runtime.getCatalogRefreshStatus().state, "failed");
	await runtime.dispose();
});

test("login cancellation does not invalidate an existing same-credential refresh", async () => {
	const accessToken = jwtForSubject("shared-account", "token");
	const pending: Array<{ signal?: AbortSignal; resolve(catalog: CursorModelCatalog): void; reject(error: Error): void }> = [];
	const discovery = cursorDiscoveryService({
		discover(_accessToken, _requestId, signal) {
			return new Promise((resolve, reject) => {
				pending.push({ signal, resolve, reject });
				signal?.addEventListener("abort", () => reject(new CursorModelDiscoveryError("Aborted", "caller aborted login discovery")), { once: true });
			});
		},
	});
	const auth = cursorAuthService({ login: async () => ({ access: accessToken, refresh: "refresh", expires: 123 }) });
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery,
		transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
		uuid: () => `shared-${pending.length}`,
		catalogCache: { load: () => null, save() {}, clear() {} },
		now: () => 3,
		resolveCurrentAccessToken: () => accessToken,
	});
	const selectedModel = firstModel(registrations[0]!);
	assert.equal(selectedModel.compat, undefined, "positive execution must not carry caller-supplied Cursor routing");
	const initialStream = drain(registrations[0]!.streamSimple(selectedModel, context, { apiKey: accessToken }));
	await nextTick();
	const controller = new AbortController();
	const login = registrations[0]!.oauth.login(callbacks(controller.signal));
	await nextTick();

	try {
		assert.equal(pending.length, 1, "login must share the tracked same-credential producer");
		controller.abort();
		await assert.rejects(login, /authenticated model discovery failed/u);
		assert.equal(pending[0]?.signal?.aborted, false, "login cancellation must not abort the shared refresh");
		pending[0]?.resolve({ source: "live", fetchedAt: 3, models: [{ id: "test-exact-route", maxMode: false }] });
		await initialStream;
		await nextTick();
		assert.equal(registrations.at(-1)?.models.some((model) => model.id === "test-exact-route"), true);
		assert.equal(runtime.getCatalogRefreshStatus().state, "fresh");
	} finally {
		controller.abort();
		for (const item of pending) item.resolve({ source: "live", fetchedAt: 3, models: [{ id: "shared-model", maxMode: false }] });
		await login.catch(() => undefined);
		await runtime.dispose();
	}
});
