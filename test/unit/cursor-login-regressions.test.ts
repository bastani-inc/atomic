import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import type { CursorAuthService } from "../../packages/cursor/src/auth.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryError, type CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";

const callbacks = (signal?: AbortSignal): OAuthLoginCallbacks => ({ onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined, signal });
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeHost(): { host: CursorProviderHost; registrations: CursorProviderConfig[] } {
	const registrations: CursorProviderConfig[] = [];
	return { registrations, host: { registerProvider(_name, config) { registrations.push(config); }, on() {} } };
}

function firstModel(config: CursorProviderConfig): Model<Api> {
	const model = config.models[0];
	assert.ok(model);
	return { ...model, api: model.api ?? config.api, baseUrl: model.baseUrl ?? config.baseUrl, provider: "cursor" } as Model<Api>;
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

async function drain(stream: AsyncIterable<object>): Promise<void> {
	for await (const _event of stream) {
		// Exercise the public stream path that schedules credential rediscovery.
	}
}

test("login rejects when another credential supersedes its catalog discovery", async () => {
	const accessA = "login-access-a";
	const accessB = "active-access-b";
	const pending = new Map<string, { resolve(catalog: CursorModelCatalog): void; reject(error: Error): void }>();
	const discovery = {
		discover(accessToken: string): Promise<CursorModelCatalog> {
			return new Promise((resolve, reject) => pending.set(accessToken, { resolve, reject }));
		},
	} as unknown as CursorModelDiscoveryService;
	const auth = { async login(): Promise<OAuthCredentials> { return { access: accessA, refresh: "refresh-a", expires: 123 }; } } as unknown as CursorAuthService;
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth,
		discoveryService: discovery,
		transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
		uuid: () => `request-${pending.size}`,
	});

	const login = registrations[0]!.oauth.login(callbacks());
	await nextTick();
	await drain(registrations[0]!.streamSimple(firstModel(registrations[0]!), context, { apiKey: accessB }));
	await nextTick();
	pending.get(accessB)?.resolve({ source: "live", fetchedAt: 2, models: [{ id: "model-b" }] });
	await nextTick();
	pending.get(accessA)?.reject(new CursorModelDiscoveryError("CursorApiRejected", "superseded login catalog"));

	await assert.rejects(login, /authentication succeeded, but authenticated model discovery failed/u);
	assert.equal(registrations.at(-1)?.models.some((model) => model.id === "model-b"), true);
	await runtime.dispose();
});

test("runtime disposal aborts an in-flight authenticated login discovery", async () => {
	const callbackController = new AbortController();
	let discoverySignal: AbortSignal | undefined;
	const discovery = {
		discover(_accessToken: string, _requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
			discoverySignal = signal;
			return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new CursorModelDiscoveryError("Aborted", "login discovery aborted")), { once: true }));
		},
	} as unknown as CursorModelDiscoveryService;
	const auth = { async login(): Promise<OAuthCredentials> { return { access: "login-access", refresh: "refresh", expires: 123 }; } } as unknown as CursorAuthService;
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

test("login cancellation does not invalidate an existing same-credential refresh", async () => {
	const accessToken = "shared-access";
	const pending: Array<{ signal?: AbortSignal; resolve(catalog: CursorModelCatalog): void; reject(error: Error): void }> = [];
	const discovery = {
		discover(_accessToken: string, _requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
			return new Promise((resolve, reject) => {
				pending.push({ signal, resolve, reject });
				signal?.addEventListener("abort", () => reject(new CursorModelDiscoveryError("Aborted", "caller aborted login discovery")), { once: true });
			});
		},
	} as unknown as CursorModelDiscoveryService;
	const auth = { async login(): Promise<OAuthCredentials> { return { access: accessToken, refresh: "refresh", expires: 123 }; } } as unknown as CursorAuthService;
	const { host, registrations } = makeHost();
	const runtime = registerCursorProvider(host, {
		authService: auth, discoveryService: discovery,
		transport: new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] }),
		uuid: () => `shared-${pending.length}`,
	});
	await drain(registrations[0]!.streamSimple(firstModel(registrations[0]!), context, { apiKey: accessToken }));
	await nextTick();
	const controller = new AbortController();
	const login = registrations[0]!.oauth.login(callbacks(controller.signal));
	await nextTick();

	try {
		assert.equal(pending.length, 1, "login must share the tracked same-credential producer");
		controller.abort();
		await assert.rejects(login, /authenticated model discovery failed/u);
		assert.equal(pending[0]?.signal?.aborted, false, "login cancellation must not abort the shared refresh");
		pending[0]?.resolve({ source: "live", fetchedAt: 3, models: [{ id: "shared-model" }] });
		await nextTick();
		assert.equal(registrations.at(-1)?.models.some((model) => model.id === "shared-model"), true);
		assert.equal(runtime.getCatalogRefreshStatus().state, "fresh");
	} finally {
		controller.abort();
		for (const item of pending) item.resolve({ source: "live", fetchedAt: 3, models: [{ id: "shared-model" }] });
		await login.catch(() => undefined);
		await runtime.dispose();
	}
});
