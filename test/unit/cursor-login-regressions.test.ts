import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import { CursorModelDiscoveryError, CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const callbacks = (signal?: AbortSignal): OAuthLoginCallbacks => ({ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined, signal });
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
	const model = config.models[0] ?? {
		id: "test-exact-route", name: "Test Exact Route", api: config.api, baseUrl: config.baseUrl,
		input: ["text"], reasoning: false, contextWindow: 200_000, maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	return { ...model, provider: "cursor" } as Model<Api>;
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

test("caller cancellation fences a login-owned discovery that resolves late", async () => {
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
	resolveDiscovery?.({ source: "live", fetchedAt: 4, models: [{ id: "must-not-register", maxMode: false }] });
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
