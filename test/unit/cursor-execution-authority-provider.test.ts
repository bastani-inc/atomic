import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Context, Model, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { CursorAuthService } from "../../packages/cursor/src/auth.js";
import type { CursorCatalogCache } from "../../packages/cursor/src/catalog-cache.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider, type CursorProviderConfig, type CursorProviderHost } from "../../packages/cursor/src/provider.js";
import { CursorStreamAdapter } from "../../packages/cursor/src/stream.js";
import type { CursorAuthorizedRoute } from "../../packages/cursor/src/execution-authority.js";
import { CursorMockTransport } from "./cursor-test-helpers.js";
import { collectEvents } from "./cursor-stream-helpers.js";

const toolResultContext: Context = { messages: [{ role: "toolResult", toolCallId: "tool-1", toolName: "Read", content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 2 }] };

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const callbacks: OAuthLoginCallbacks = { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined };
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function token(subject: string, nonce: string): string {
	return `header.${Buffer.from(JSON.stringify({ sub: subject, nonce })).toString("base64url")}.signature`;
}

class QueueAuthService extends CursorAuthService {
	readonly #loginTokens: string[];
	readonly #refreshTokenValue: string;
	constructor(loginTokens: string[], refreshTokenValue = loginTokens.at(-1) ?? "") {
		super();
		this.#loginTokens = [...loginTokens];
		this.#refreshTokenValue = refreshTokenValue;
	}
	override async login(): Promise<OAuthCredentials> {
		const access = this.#loginTokens.shift();
		if (!access) throw new Error("No queued Cursor login token");
		return { access, refresh: "refresh", expires: 1 };
	}
	override async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return { ...credentials, access: this.#refreshTokenValue };
	}
}

class QueueDiscoveryService extends CursorModelDiscoveryService {
	readonly queue: Array<CursorModelCatalog | Promise<CursorModelCatalog>>;
	calls = 0;
	constructor(queue: Array<CursorModelCatalog | Promise<CursorModelCatalog>>) {
		super({ transport: new CursorMockTransport() });
		this.queue = [...queue];
	}
	override async discover(): Promise<CursorModelCatalog> {
		this.calls += 1;
		const next = this.queue.shift();
		if (!next) throw new Error("No queued Cursor catalog");
		return next;
	}
}
class MemoryCache implements CursorCatalogCache {
	catalog: CursorModelCatalog | null = null;
	clears = 0;
	saves = 0;
	load(): CursorModelCatalog | null { return this.catalog }
	save(catalog: CursorModelCatalog): void { this.catalog = catalog; this.saves += 1 }
	clear(): void { this.catalog = null; this.clears += 1 }
}

function host(): { readonly value: CursorProviderHost; readonly registrations: CursorProviderConfig[] } {
	const registrations: CursorProviderConfig[] = [];
	return { registrations, value: { registerProvider(_name, config) { registrations.push(config); }, on() {} } };
}



function realRegistryHost(): {
	readonly value: CursorProviderHost;
	readonly registrations: CursorProviderConfig[];
	readonly registry: ModelRegistry;
} {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	const registrations: CursorProviderConfig[] = [];
	return {
		registry,
		registrations,
		value: {
			registerProvider(name, config) {
				registry.registerProvider(name, {
					...config,
					models: config.models.map((model) => ({
						id: model.id,
						name: model.name,
						api: "cursor-agent" as const,
						baseUrl: model.baseUrl,
						reasoning: model.reasoning,
						input: [...model.input],
						cost: { ...model.cost },
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						compat: model.compat as Model<Api>["compat"],
					})),
				});
				registrations.push(config);
			},
			on() {},
		},
	};
}
function selectedModel(config: CursorProviderConfig, id = config.models[0]?.id): Model<Api> {
	const definition = config.models.find((candidate) => candidate.id === id);
	if (!definition) throw new Error(`Missing test Cursor route ${id ?? "<none>"}`);
	return {
		id: definition.id,
		name: definition.name,
		provider: "cursor",
		api: "cursor-agent",
		baseUrl: definition.baseUrl,
		reasoning: definition.reasoning,
		input: [...definition.input],
		cost: { ...definition.cost },
		contextWindow: definition.contextWindow,
		maxTokens: definition.maxTokens,
	};
}

function fabricatedModel(id: string): Model<Api> {
	return {
		id, name: id, provider: "cursor", api: "cursor-agent", baseUrl: "https://api2.cursor.sh",
		reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000, maxTokens: 64_000,
		compat: { cursorRouting: { [id]: { modelId: id, maxMode: true } } },
	} as Model<Api>;
}

async function login(config: CursorProviderConfig): Promise<void> {
	await config.oauth.login(callbacks);
}

function fabricatedAuthorization(modelId: string): CursorAuthorizedRoute {
	return {
		modelId,
		maxMode: false,
		supportsImages: false,
		authorityLease: Symbol("fabricated-authority"),
		authoritySignal: new AbortController().signal,
		credentialScope: "fabricated-scope",
		catalogGeneration: 999,
		assertCurrent() {},
	};
}

test("execution rejects retained, fabricated, and cross-account routes before transport", async () => {
	const a1 = token("account-a", "one");
	const a2 = token("account-a", "two");
	const b = token("account-b", "one");
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 1, models: [{ id: "route-a", maxMode: false }] },
		{ source: "live", fetchedAt: 2, models: [{ id: "route-b", maxMode: false }] },
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([a1, a2]), discoveryService: discovery, transport, now: () => 2,
	});
	await login(testHost.registrations[0]!);
	const retained = selectedModel(testHost.registrations.at(-1)!);
	await login(testHost.registrations.at(-1)!);
	const activeConfig = testHost.registrations.at(-1)!;
	assert.throws(
		() => runtime.streamAdapter.bindExecutionAuthority(async (candidate) => fabricatedAuthorization(candidate.id)),
		/already bound/u,
	);
	for (const [candidate, apiKey] of [[retained, a2], [fabricatedModel("fabricated"), a2], [selectedModel(activeConfig), b]] as const) {
		const events = await collectEvents(activeConfig.streamSimple(candidate, context, { apiKey }));
		assert.equal(events.at(-1)?.type, "error");
	}
	assert.equal(transport.runs.length, 0);
	await runtime.dispose();
});

test("provider registration rejects an injected adapter with pre-bound authority", async () => {
	const transport = new CursorMockTransport();
	const adapter = new CursorStreamAdapter({
		transport,
		executionAuthorizer: async (candidate) => fabricatedAuthorization(candidate.id),
	});
	assert.throws(
		() => registerCursorProvider(host().value, { transport, streamAdapter: adapter }),
		/already bound/u,
	);
	await adapter.dispose();
});


for (const scenario of [
	{ name: "same-account catalog generation change", firstSubject: "account-a", secondSubject: "account-a" },
	{ name: "account switch", firstSubject: "account-a", secondSubject: "account-b" },
] as const) {
	test(`paused provider tool turns reject ${scenario.name}`, async () => {
		const firstToken = token(scenario.firstSubject, "one");
		const secondToken = token(scenario.secondSubject, "two");
		const discovery = new QueueDiscoveryService([
			{ source: "live", fetchedAt: 1, models: [{ id: "same-route", maxMode: false }] },
			{ source: "live", fetchedAt: 2, models: [{ id: "same-route", maxMode: false }] },
		]);
		const transport = new CursorMockTransport({ messages: [
			{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" },
			{ type: "textDelta", text: "done" },
		] });
		const testHost = host();
		const runtime = registerCursorProvider(testHost.value, {
			authService: new QueueAuthService([firstToken, secondToken]), discoveryService: discovery, transport, now: () => 2,
		});
		await login(testHost.registrations[0]!);
		const firstConfig = testHost.registrations.at(-1)!;
		await collectEvents(firstConfig.streamSimple(selectedModel(firstConfig), context, { apiKey: firstToken, sessionId: scenario.name }));
		await login(testHost.registrations.at(-1)!);
		const activeConfig = testHost.registrations.at(-1)!;
		const events = await collectEvents(activeConfig.streamSimple(selectedModel(activeConfig), toolResultContext, { apiKey: secondToken, sessionId: scenario.name }));
		assert.equal(events.at(-1)?.type, "error");
		assert.equal(transport.runs.length, 1);
		assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 0);
		assert.equal(transport.runs[0]?.stream.cancelled, true);
		await runtime.dispose();
	});
}
test("same-account rotation uses the current route and current Max metadata", async () => {
	const a1 = token("account-a", "one");
	const a2 = token("account-a", "two");
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 1, models: [{ id: "same-route", maxMode: true }] },
		{ source: "live", fetchedAt: 2, models: [{ id: "same-route", maxMode: false }] },
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([a1, a2]), discoveryService: discovery, transport, now: () => 2,
	});
	await login(testHost.registrations[0]!);
	const retained = selectedModel(testHost.registrations.at(-1)!);
	assert.equal(retained.compat, undefined);
	await login(testHost.registrations.at(-1)!);
	await collectEvents(testHost.registrations.at(-1)!.streamSimple(retained, context, { apiKey: a2 }));
	assert.equal(transport.runs[0]?.request.maxMode, false);
	assert.equal(transport.runs[0]?.request.resolvedModelId, "same-route");
	assert.equal(discovery.calls, 2);
	await runtime.dispose();
});

test("provider registration retains duplicate rows and executes the selected occurrence metadata", async () => {
	const access = token("duplicate-account", "one");
	const discovery = new QueueDiscoveryService([{
		source: "live",
		fetchedAt: 1,
		models: [
			{ id: "duplicate-route", displayName: "First", maxMode: false },
			{ id: "duplicate-route", displayName: "Second", maxMode: true, supportsImages: true },
		],
	}]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = realRegistryHost();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([access]), discoveryService: discovery, transport, now: () => 2,
	});
	await login(testHost.registrations[0]!);
	const config = testHost.registrations.at(-1)!;
	assert.deepEqual(config.models.map((entry) => [entry.id, entry.name]), [
		["duplicate-route", "First"], ["duplicate-route", "Second"],
	]);
	const registryRows = testHost.registry.getAll().filter((entry) => entry.provider === "cursor");
	assert.deepEqual(registryRows.map((entry) => entry.name), ["First", "Second"]);
	assert.equal(testHost.registry.find("cursor", "duplicate-route"), registryRows[0]);
	await collectEvents(config.streamSimple(registryRows[0]!, context, { apiKey: access }));
	await collectEvents(config.streamSimple(registryRows[1]!, context, { apiKey: access }));
	assert.deepEqual(transport.runs.map((run) => [run.request.resolvedModelId, run.request.maxMode]), [
		["duplicate-route", false], ["duplicate-route", true],
	]);
	await runtime.dispose();
});

test("a rotated token for the same account can use a still-fresh authority without discovery", async () => {
	const a1 = token("account-a", "one");
	const a2 = token("account-a", "two");
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 1, models: [{ id: "route", maxMode: false }] },
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([a1]), discoveryService: discovery, transport, now: () => 2,
	});
	await login(testHost.registrations[0]!);
	const config = testHost.registrations.at(-1)!;
	await collectEvents(config.streamSimple(selectedModel(config), context, { apiKey: a2 }));
	assert.equal(transport.runs.length, 1);
	assert.equal(discovery.calls, 1);
	await runtime.dispose();
});

test("forced refresh failure after TTL revokes models, cache, and execution authority", async () => {
	const a1 = token("ttl-account", "one");
	const a2 = token("ttl-account", "two");
	let now = 99;
	let rejectRefresh: ((error: Error) => void) | undefined;
	const pending = new Promise<CursorModelCatalog>((_resolve, reject) => { rejectRefresh = reject; });
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 0, models: [{ id: "expires", maxMode: false }] }, pending,
	]);
	const cache = new MemoryCache();
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = realRegistryHost();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([a1], a2), discoveryService: discovery, transport, catalogCache: cache,
		catalogCacheTtlMs: 100, now: () => now,
	});
	await login(testHost.registrations[0]!);
	assert.ok(testHost.registry.find("cursor", "expires"));
	const retained = selectedModel(testHost.registrations.at(-1)!);
	await testHost.registrations.at(-1)!.oauth.refreshToken({ access: a1, refresh: "refresh", expires: 1 });
	now = 100;

	rejectRefresh?.(new Error("refresh crossed TTL"));
	await tick();
	assert.deepEqual(testHost.registrations.at(-1)?.models, []);
	assert.equal(testHost.registry.find("cursor", "expires"), undefined);
	assert.equal(testHost.registry.getAll().some((model) => model.provider === "cursor"), false);
	assert.equal(cache.catalog, null);
	assert.equal(cache.clears > 0, true);
	assert.deepEqual(runtime.getCatalogRefreshStatus(), { state: "failed", error: "refresh crossed TTL" });
	const events = await collectEvents(testHost.registrations.at(-1)!.streamSimple(retained, context, { apiKey: a2 }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	await runtime.dispose();
});

test("a still-fresh committed route executes while a forced refresh is pending", async () => {
	const a1 = token("pending-account", "one");
	const a2 = token("pending-account", "two");
	let rejectRefresh: ((error: Error) => void) | undefined;
	const pending = new Promise<CursorModelCatalog>((_resolve, reject) => { rejectRefresh = reject; });
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 90, models: [{ id: "pending-route", maxMode: true }] },
		pending,
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([a1], a2), discoveryService: discovery, transport,
		catalogCacheTtlMs: 100, now: () => 100,
	});
	await login(testHost.registrations[0]!);
	const selected = selectedModel(testHost.registrations.at(-1)!);
	await testHost.registrations.at(-1)!.oauth.refreshToken({ access: a1, refresh: "refresh", expires: 1 });
	await collectEvents(testHost.registrations.at(-1)!.streamSimple(selected, context, { apiKey: a2 }));
	assert.equal(transport.runs.length, 1);
	assert.equal(transport.runs[0]?.request.maxMode, true);
	rejectRefresh?.(new Error("temporary pending failure"));
	await tick();
	await collectEvents(testHost.registrations.at(-1)!.streamSimple(selected, context, { apiKey: a2 }));
	assert.equal(transport.runs.length, 2);
	assert.equal(runtime.getCatalogRefreshStatus().state, "fresh");
	await runtime.dispose();
});

test("a temporary refresh failure retains a still-fresh same-account execution authority", async () => {
	const a1 = token("fresh-account", "one");
	const a2 = token("fresh-account", "two");
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 90, models: [{ id: "fresh-route", maxMode: false }] },
		Promise.reject(new Error("temporary refresh failure")),
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([a1], a2), discoveryService: discovery, transport,
		catalogCacheTtlMs: 100, now: () => 100,
	});
	await login(testHost.registrations[0]!);
	const config = testHost.registrations.at(-1)!;
	const selected = selectedModel(config);
	await config.oauth.refreshToken({ access: a1, refresh: "refresh", expires: 1 });
	await tick();
	assert.equal(runtime.getCatalogRefreshStatus().state, "fresh");
	await collectEvents(testHost.registrations.at(-1)!.streamSimple(selected, context, { apiKey: a2 }));
	assert.equal(transport.runs.length, 1);
	await runtime.dispose();
});


test("disposal cancels paused tool authority before later results can be written", async () => {
	const access = token("paused-dispose-account", "one");
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 1, models: [{ id: "paused-route", maxMode: false }] },
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "toolCall", id: "tool-1", name: "Read", argumentsJson: "{}" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([access]), discoveryService: discovery, transport, now: () => 2,
	});
	await login(testHost.registrations[0]!);
	const config = testHost.registrations.at(-1)!;
	const selected = selectedModel(config);
	await collectEvents(config.streamSimple(selected, context, { apiKey: access, sessionId: "paused-disposal" }));
	await runtime.dispose();
	const events = await collectEvents(config.streamSimple(selected, toolResultContext, { apiKey: access, sessionId: "paused-disposal" }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 1);
	assert.equal(transport.runs[0]?.stream.writtenToolResults.length, 0);
	assert.equal(transport.runs[0]?.stream.cancelled, true);
});
test("disposal closes authority immediately and leaves the provider catalog empty", async () => {
	const access = token("dispose-account", "one");
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 1, models: [{ id: "route", maxMode: false }] },
	]);
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([access]), discoveryService: discovery, transport, now: () => 2,
	});
	await login(testHost.registrations[0]!);
	const config = testHost.registrations.at(-1)!;
	const retained = selectedModel(config);
	await runtime.dispose();
	const events = await collectEvents(config.streamSimple(retained, context, { apiKey: access }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	assert.deepEqual(testHost.registrations.at(-1)?.models, []);
});

test("disposal immediately closes authority and fences abort-ignoring late discovery", async () => {
	const access = token("late-dispose-account", "one");
	let resolveLate: ((catalog: CursorModelCatalog) => void) | undefined;
	const late = new Promise<CursorModelCatalog>((resolve) => { resolveLate = resolve; });
	const discovery = new QueueDiscoveryService([
		{ source: "live", fetchedAt: 1, models: [{ id: "route", maxMode: false }] },
		late,
	]);
	const cache = new MemoryCache();
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		authService: new QueueAuthService([access], access), discoveryService: discovery, transport, catalogCache: cache,
		now: () => 2, catalogDiscoveryDisposeTimeoutMs: 1,
	});
	await login(testHost.registrations[0]!);
	const config = testHost.registrations.at(-1)!;
	const retained = selectedModel(config);
	await config.oauth.refreshToken({ access, refresh: "refresh", expires: 1 });
	const savesBeforeDisposal = cache.saves;
	const disposal = runtime.dispose();
	const events = await collectEvents(config.streamSimple(retained, context, { apiKey: access }));
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	await disposal;
	resolveLate?.({ source: "live", fetchedAt: 3, models: [{ id: "late-route", maxMode: false }] });
	await tick();
	assert.deepEqual(testHost.registrations.at(-1)?.models, []);
	assert.equal(cache.saves, savesBeforeDisposal);
	assert.notEqual(runtime.getCatalogRefreshStatus().state, "fresh");
});

test("disposal wakes an execution waiter without waiting for abort-ignoring discovery", async () => {
	const access = token("waiting-dispose-account", "one");
	let resolveLate: ((catalog: CursorModelCatalog) => void) | undefined;
	const late = new Promise<CursorModelCatalog>((resolve) => { resolveLate = resolve; });
	const discovery = new QueueDiscoveryService([late]);
	const cache = new MemoryCache();
	const transport = new CursorMockTransport({ messages: [{ type: "done", reason: "stop" }] });
	const testHost = host();
	const runtime = registerCursorProvider(testHost.value, {
		discoveryService: discovery, transport, catalogCache: cache,
		now: () => 2, catalogDiscoveryDisposeTimeoutMs: 100,
		resolveCurrentAccessToken: () => access,
	});
	const streamEvents = collectEvents(testHost.registrations[0]!.streamSimple(fabricatedModel("late-route"), context, { apiKey: access }));
	await tick();
	assert.equal(discovery.calls, 1);
	const disposal = runtime.dispose();
	const events = await streamEvents;
	assert.equal(events.at(-1)?.type, "error");
	assert.equal(transport.runs.length, 0);
	resolveLate?.({ source: "live", fetchedAt: 3, models: [{ id: "late-route", maxMode: false }] });
	await disposal;
	await tick();
	assert.deepEqual(testHost.registrations.at(-1)?.models, []);
	assert.equal(cache.saves, 0);
});
