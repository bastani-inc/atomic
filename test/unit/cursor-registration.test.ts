import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import type { CursorAuthService } from "../../packages/cursor/src/auth.js";
import type { CursorModelCatalog } from "../../packages/cursor/src/model-mapper.js";
import { CursorModelDiscoveryError, type CursorModelDiscoveryService } from "../../packages/cursor/src/models.js";
import { registerCursorProvider } from "../../packages/cursor/src/provider.js";
import { CursorMockTransport } from "../../packages/cursor/src/transport.js";

type CursorHost = Parameters<typeof registerCursorProvider>[0];
type CursorConfig = Parameters<CursorHost["registerProvider"]>[1];

describe("Cursor provider registration", () => {
	test("registers Cursor as an experimental OAuth provider with estimated models and streamSimple", async () => {
		const registrations: { readonly name: string; readonly config: CursorConfig }[] = [];
		const shutdownHandlers: (() => Promise<void> | void)[] = [];
		const host: CursorHost = {
			registerProvider(name, config) {
				registrations.push({ name, config });
			},
			on(_event, handler) {
				shutdownHandlers.push(handler);
			},
		};

		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), uuid: () => "request-1" });
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0]?.name, "cursor");
		const config = registrations[0]?.config;
		assert.equal(config?.name, "Cursor");
		assert.equal(config?.oauth.name, "Cursor (experimental)");
		assert.equal(config?.api, "cursor-agent");
		assert.equal(typeof config?.streamSimple, "function");
		assert.ok(config?.models.some((model) => model.id === "composer-2" && /estimated/u.test(model.name)));
		assert.equal(shutdownHandlers.length, 1);
		await runtime.dispose();
	});

	test("login and refresh use the production UUID generator and re-register the live catalog", async () => {
		const registrations: { readonly name: string; readonly config: CursorConfig }[] = [];
		const host: CursorHost = {
			registerProvider(name, config) {
				registrations.push({ name, config });
			},
			on() {},
		};
		const fakeAuth = {
			async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
				return { access: "access-live", refresh: "refresh-live", expires: 123 };
			},
			async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
				return { access: "access-refreshed", refresh: credentials.refresh, expires: 456 };
			},
		} as unknown as CursorAuthService;
		const discoveryRequests: { readonly accessToken: string; readonly requestId: string; readonly signal?: AbortSignal }[] = [];
		const fakeDiscovery = {
			async discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
				discoveryRequests.push({ accessToken, requestId, signal });
				return {
					source: "live",
					fetchedAt: 42,
					models: [{ id: "composer-2", displayName: "Live Composer", supportsReasoning: true, contextWindow: 111, maxTokens: 222 }],
				};
			},
		} as unknown as CursorModelDiscoveryService;
		const signal = new AbortController().signal;

		const runtime = registerCursorProvider(host, {
			transport: new CursorMockTransport(),
			authService: fakeAuth,
			discoveryService: fakeDiscovery,
		});
		const loginCredentials = await registrations.at(-1)?.config.oauth.login({
			onAuth() {},
			onDeviceCode() {},
			onPrompt: async () => "",
			onSelect: async () => undefined,
			signal,
		});
		const refreshCredentials = await registrations.at(-1)?.config.oauth.refreshToken(loginCredentials ?? { access: "", refresh: "", expires: 0 });

		assert.deepEqual(loginCredentials, { access: "access-live", refresh: "refresh-live", expires: 123 });
		assert.deepEqual(refreshCredentials, { access: "access-refreshed", refresh: "refresh-live", expires: 456 });
		assert.equal(registrations.length, 3);
		assert.deepEqual(discoveryRequests.map((request) => request.accessToken), ["access-live", "access-refreshed"]);
		assert.equal(discoveryRequests[0]?.signal, signal);
		for (const request of discoveryRequests) {
			assert.match(request.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
		}
		for (const registration of registrations.slice(1)) {
			const liveComposer = registration.config.models.find((model) => model.id === "composer-2");
			assert.equal(liveComposer?.name, "Live Composer");
			assert.equal(liveComposer?.contextWindow, 111);
		}
		await runtime.dispose();
	});

	test("login discovery rethrows auth rejection/cancellation and falls back for network discovery failures", async () => {
		const makeHost = (): { readonly host: CursorHost; readonly registrations: { readonly name: string; readonly config: CursorConfig }[] } => {
			const registrations: { readonly name: string; readonly config: CursorConfig }[] = [];
			return {
				registrations,
				host: {
					registerProvider(name, config) {
						registrations.push({ name, config });
					},
					on() {},
				},
			};
		};
		const fakeAuth = { async login(): Promise<OAuthCredentials> { return { access: "access-live", refresh: "refresh-live", expires: 123 }; } } as unknown as CursorAuthService;
		const callbacks: OAuthLoginCallbacks = { onAuth() {}, onDeviceCode() {}, onPrompt: async () => "", onSelect: async () => undefined };

		for (const code of ["Unauthorized", "CursorApiRejected", "Aborted", "NoUsableModels"] as const) {
			const { host, registrations } = makeHost();
			const discovery = { async discover(): Promise<CursorModelCatalog> { throw new CursorModelDiscoveryError(code, `blocked ${code}`); } } as unknown as CursorModelDiscoveryService;
			const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), authService: fakeAuth, discoveryService: discovery, uuid: () => "request-failure" });
			await assert.rejects(() => registrations[0]!.config.oauth.login(callbacks), (error: Error) => error.message.includes(code));
			assert.equal(registrations.length, 1);
			await runtime.dispose();
		}

		const { host, registrations } = makeHost();
		const discovery = { async discover(): Promise<CursorModelCatalog> { throw new CursorModelDiscoveryError("NetworkError", "temporary network failure"); } } as unknown as CursorModelDiscoveryService;
		const runtime = registerCursorProvider(host, { transport: new CursorMockTransport(), authService: fakeAuth, discoveryService: discovery, uuid: () => "request-network" });
		await registrations[0]!.config.oauth.login(callbacks);
		assert.equal(registrations.length, 2);
		assert.ok(registrations[1]!.config.models.some((model) => /estimated/u.test(model.name)));
		await runtime.dispose();
	});

	test("host wiring includes bundled package copy and default model resolution", () => {
		const builtins = readFileSync("packages/coding-agent/src/core/builtin-packages.ts", "utf8");
		const copyScript = readFileSync("packages/coding-agent/scripts/copy-builtin-packages.ts", "utf8");
		const resolver = readFileSync("packages/coding-agent/src/core/model-resolver.ts", "utf8");
		assert.match(builtins, /@bastani\/cursor/u);
		assert.match(copyScript, /@bastani\/cursor/u);
		assert.match(resolver, /cursor:\s*"composer-2"/u);
	});
});
