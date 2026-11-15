import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createModels,
	createProvider,
	type ImageModel,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelsStore,
	type OAuthAuth,
	type Provider,
} from "@bastani/atomic-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearRemoteCatalogCache,
	DEFAULT_CATALOG_BASE_URL,
	type DiscoverModels,
	type PersonalizeCatalog,
	withDiscoveredModels,
	withPersonalizedCatalog,
	withRemoteCatalog,
} from "../src/core/remote-catalog-provider.js";
import { makeRefreshContext } from "./helpers/refresh-context.js";

/** The provider the fake catalogs describe: models.dev lists Groq, and the shared transform maps it. */
const PROVIDER_ID = "groq";
const BASE_URL = "https://catalog.test";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: "https://api.groq.com/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

/** A models.dev `api.json` listing the given Groq models. */
function modelsDevCatalog(
	entries: Record<string, { name?: string; context?: number; input?: number; tool_call?: boolean }>,
): object {
	const models = Object.fromEntries(
		Object.entries(entries).map(([id, entry]) => [
			id,
			{
				id,
				name: entry.name ?? id,
				tool_call: entry.tool_call ?? true,
				reasoning: false,
				modalities: { input: ["text"], output: ["text"] },
				cost: { input: entry.input ?? 1, output: 2 },
				limit: { context: entry.context ?? 1000, output: 100 },
			},
		]),
	);
	return { [PROVIDER_ID]: { id: PROVIDER_ID, models } };
}

function catalogResponse(entries: Parameters<typeof modelsDevCatalog>[0], lastModifiedMs = 2_000): Response {
	return Response.json(modelsDevCatalog(entries), {
		headers: { "last-modified": new Date(lastModifiedMs).toUTCString() },
	});
}

function builtinProvider(): Provider {
	return createProvider({
		id: PROVIDER_ID,
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models: [model("static")],
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});
}

function testProvider(localGeneratedAt = 1_000, baseUrl = BASE_URL) {
	return withRemoteCatalog(builtinProvider(), baseUrl, localGeneratedAt);
}

function oauthProvider(refresh: OAuthAuth["refresh"]): Provider {
	return {
		...builtinProvider(),
		auth: {
			oauth: {
				name: "Test OAuth",
				login: async () => {
					throw new Error("not used");
				},
				refresh,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	};
}

async function staleOAuthCredentials(providerId: string): Promise<InMemoryCredentialStore> {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(providerId, async () => ({
		type: "oauth",
		access: "expired",
		refresh: "revoked",
		expires: 0,
	}));
	return credentials;
}

const ids = (provider: Provider) => provider.getModels().map((entry) => entry.id);

afterEach(() => {
	vi.restoreAllMocks();
	clearRemoteCatalogCache();
});

describe("models.dev catalog refresh", () => {
	it("defaults to models.dev and never to a pi.dev endpoint (#5174)", () => {
		expect(DEFAULT_CATALOG_BASE_URL).toBe("https://models.dev");
	});

	it("refreshes from a models.dev server through the build's transform, then keeps the bundled catalog when it is down (#5174)", async () => {
		let up = true;
		const requests: string[] = [];
		const server: Server = createServer((request, response) => {
			requests.push(request.url ?? "");
			if (!up) {
				response.writeHead(503).end("down");
				return;
			}
			response.writeHead(200, {
				"content-type": "application/json",
				"last-modified": new Date(2_000).toUTCString(),
			});
			response.end(
				JSON.stringify(
					modelsDevCatalog({
						static: { name: "Static from models.dev", context: 64_000 },
						fresh: { name: "Fresh", input: 3 },
						"no-tools": { tool_call: false },
					}),
				),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const store = new InMemoryModelsStore();
			const provider = testProvider(1_000, baseUrl);
			await provider.refreshModels?.(
				await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }),
			);
			expect(requests).toEqual(["/api.json"]);
			expect(ids(provider)).toEqual(["static", "fresh"]);
			const refreshed = provider.getModels().find((entry) => entry.id === "static");
			expect(refreshed).toMatchObject({ name: "Static from models.dev", contextWindow: 64_000, provider: "groq" });
			expect(provider.getModels().find((entry) => entry.id === "fresh")?.cost.input).toBe(3);

			// A new process with the server down: the saved overlay is used offline, and a failed download keeps the
			// bundled catalog plus the saved overlay instead of dropping models.
			up = false;
			clearRemoteCatalogCache();
			const restarted = testProvider(1_000, baseUrl);
			await expect(
				restarted.refreshModels?.(
					await makeRefreshContext(store, restarted.id, { credential: { type: "api_key" }, force: true }),
				),
			).rejects.toThrow(/503/);
			expect(ids(restarted)).toEqual(["static", "fresh"]);

			// With nothing saved and the server down, the bundled catalog stays.
			clearRemoteCatalogCache();
			const fresh = testProvider(1_000, baseUrl);
			await expect(
				fresh.refreshModels?.(
					await makeRefreshContext(new InMemoryModelsStore(), fresh.id, { credential: { type: "api_key" } }),
				),
			).rejects.toThrow(/503/);
			expect(ids(fresh)).toEqual(["static"]);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("downloads the catalog once for every provider refreshing together and observes the refresh interval", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({ dynamic: {} }));
		const store = new InMemoryModelsStore();
		const first = testProvider();
		const second = testProvider();
		await Promise.all(
			[first, second].map(async (provider) =>
				provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
			),
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(`${BASE_URL}/api.json`);

		// Within the interval nothing is downloaded.
		clearRemoteCatalogCache();
		await first.refreshModels?.(await makeRefreshContext(store, first.id, { credential: { type: "api_key" } }));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		await first.refreshModels?.(
			await makeRefreshContext(store, first.id, { credential: { type: "api_key" }, force: true }),
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(ids(first)).toEqual(["static", "dynamic"]);
	});

	it("prefers the newer of the bundled and downloaded catalogs", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({ dynamic: {} }, 500));
		const provider = testProvider(1_000);
		await provider.refreshModels?.(
			await makeRefreshContext(new InMemoryModelsStore(), provider.id, { credential: { type: "api_key" } }),
		);
		expect(ids(provider)).toEqual(["static"]);
	});

	it("treats a server without the catalog (404, 501) as no overlay instead of a failed refresh", async () => {
		for (const status of [404, 501]) {
			clearRemoteCatalogCache();
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("missing", { status }));
			const store = new InMemoryModelsStore();
			const provider = testProvider();
			await expect(
				provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
			).resolves.toBeUndefined();
			expect(ids(provider)).toEqual(["static"]);
		}
	});

	it("rejects a response that is not a models.dev catalog and keeps the stored overlay", async () => {
		const store = new InMemoryModelsStore();
		await store.write(PROVIDER_ID, { models: [model("saved")], checkedAt: 0, lastModified: 2_000 });
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([model("pi-shaped")]));
		const provider = testProvider();
		await expect(
			provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
		).rejects.toThrow(/not a models.dev catalog/);
		expect(ids(provider)).toEqual(["static", "saved"]);
	});

	it("downloads the catalog without refreshing a stale OAuth login", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({ dynamic: {} }));
		const oauthRefresh = vi.fn(async (): Promise<never> => {
			throw new Error("invalid_grant");
		});
		const provider = withRemoteCatalog(oauthProvider(oauthRefresh), BASE_URL, 1_000);
		const models = createModels({
			credentials: await staleOAuthCredentials(provider.id),
			modelsStore: new InMemoryModelsStore(),
		});
		models.setProvider(provider);

		expect((await models.refresh({ force: true })).errors.size).toBe(0);
		expect(oauthRefresh).not.toHaveBeenCalled();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(ids(provider)).toEqual(["static", "dynamic"]);
	});

	it("surfaces a stale OAuth login as the provider's refresh error when the catalog needs the credential", async () => {
		const oauthRefresh = vi.fn(async (): Promise<never> => {
			throw new Error("invalid_grant");
		});
		const discover = vi.fn<DiscoverModels>(async () => []);
		const personalize = vi.fn<PersonalizeCatalog>(async (catalog) => catalog);
		const discovering = withDiscoveredModels(withRemoteCatalog(oauthProvider(oauthRefresh), BASE_URL), discover);
		const personalized = withPersonalizedCatalog(oauthProvider(oauthRefresh), personalize, BASE_URL);

		for (const provider of [discovering, personalized]) {
			const models = createModels({
				credentials: await staleOAuthCredentials(provider.id),
				modelsStore: new InMemoryModelsStore(),
			});
			models.setProvider(provider);
			const result = await models.refresh({ force: true });
			expect(result.errors.get(provider.id)).toMatchObject({ name: "ModelsError", code: "oauth" });
		}
		expect(oauthRefresh).toHaveBeenCalledTimes(2);
		expect(discover).not.toHaveBeenCalled();
		expect(personalize).not.toHaveBeenCalled();
	});

	it("surfaces persistence failures without publishing an uncommitted catalog", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({ new: {} }));
		const provider = testProvider();
		const store: ModelsStore = {
			read: async () => ({ models: [model("stale")], checkedAt: 0, lastModified: 2_000 }),
			write: async () => {
				throw new Error("disk full");
			},
			delete: async () => {},
		};
		await expect(
			provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
		).rejects.toThrow("disk full");
		expect(ids(provider)).toEqual(["static", "stale"]);
	});
});

describe("personalized catalog provider", () => {
	const imageModel: ImageModel<"openrouter-images"> = {
		type: "image",
		id: "image",
		name: "image",
		api: "openrouter-images",
		provider: PROVIDER_ID,
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	it.each(["HTTP 500", "transport", "invalid JSON"])(
		"personalizes and replaces stale limits and prices after a catalog %s failure",
		async (failure) => {
			vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
				if (failure === "transport") throw new TypeError("connection refused");
				return new Response("unavailable", { status: failure === "HTTP 500" ? 500 : 200 });
			});
			const store = new InMemoryModelsStore();
			await store.write(PROVIDER_ID, {
				models: [
					{ ...model("static"), contextWindow: 500, cost: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 } },
				],
				checkedAt: 1,
			});
			const personalized = [
				{ ...model("static"), contextWindow: 64000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
			];
			const personalize = vi.fn<PersonalizeCatalog>(async (catalog) => {
				assert.deepEqual(catalog, [model("static")]);
				return personalized;
			});
			const provider = withPersonalizedCatalog(builtinProvider(), personalize, BASE_URL);
			await provider.refreshModels?.(await makeRefreshContext(store, provider.id));
			assert.equal(personalize.mock.calls.length, 1);
			assert.deepEqual(provider.getModels(), personalized);
			assert.deepEqual((await store.read(provider.id))?.models, personalized);
		},
	);

	it("does not personalize or persist after the refresh is cancelled", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			controller.abort();
			return new Promise<Response>(() => {});
		});
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write(PROVIDER_ID, saved);
		const personalize = vi.fn<PersonalizeCatalog>(async () => [model("static")]);
		const provider = withPersonalizedCatalog(builtinProvider(), personalize, BASE_URL);
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { signal: controller.signal }));
		assert.equal(personalize.mock.calls.length, 0);
		assert.deepEqual(await store.read(provider.id), saved);
		assert.deepEqual(provider.getModels(), saved.models);
	});

	it("personalizes the built-in models plus a newer downloaded catalog and saves the result", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({ remote: {} }));
		const seen: string[][] = [];
		const personalize: PersonalizeCatalog = async (catalog) => {
			seen.push(catalog.map((entry) => entry.id));
			return catalog.filter((entry) => entry.id === "remote");
		};
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(builtinProvider(), personalize, BASE_URL, 1_000);
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }));
		expect(seen).toEqual([["static", "remote"]]);
		expect(ids(provider)).toEqual(["remote"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["remote"]);
	});

	it("keeps the saved list and saves nothing when personalization fails", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("not found", { status: 404 }));
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write(PROVIDER_ID, saved);
		const provider = withPersonalizedCatalog(
			builtinProvider(),
			async () => {
				throw new Error("user models request failed");
			},
			BASE_URL,
		);
		await expect(
			provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
		).rejects.toThrow("user models request failed");
		expect(ids(provider)).toEqual(["allowed"]);
		expect(await store.read(provider.id)).toEqual(saved);
	});

	it("restores a saved list as is, and falls back to the built-in models only when it is empty", async () => {
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(
			builtinProvider(),
			async () => {
				throw new Error("not used offline");
			},
			BASE_URL,
		);
		const offline = () =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" }, allowNetwork: false });
		await store.write(provider.id, { models: [], checkedAt: 1 });
		await provider.refreshModels?.(await offline());
		expect(ids(provider)).toEqual(["static"]);
		await store.write(provider.id, { models: [imageModel], checkedAt: 1 });
		await provider.refreshModels?.(await offline());
		expect(provider.getModels()).toEqual([]);
		expect(provider.getAllModels?.().map((entry) => entry.id)).toEqual(["image"]);
	});
});

describe("discovered models provider", () => {
	const discoveredModel = (id: string): Model<"openai-completions"> => ({ ...model(id), discovered: true });

	function discoveringProvider(discover: DiscoverModels): Provider {
		return withDiscoveredModels(withRemoteCatalog(builtinProvider(), BASE_URL, 1_000), discover);
	}

	it("adds discovered models after the catalog and restores them offline beside the catalog overlay", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({ remote: {} }));
		const seen: string[][] = [];
		const store = new InMemoryModelsStore();
		const online = discoveringProvider(async (catalog) => {
			seen.push(catalog.map((entry) => entry.id));
			return [discoveredModel("found")];
		});
		await online.refreshModels?.(await makeRefreshContext(store, online.id, { credential: { type: "api_key" } }));
		assert.deepEqual(seen, [["static", "remote"]]);
		assert.deepEqual(ids(online), ["static", "remote", "found"]);
		assert.equal((await store.read(online.id))?.lastModified, 2_000);

		fetchSpy.mockClear();
		const restarted = discoveringProvider(async () => {
			throw new Error("not used offline");
		});
		await restarted.refreshModels?.(await makeRefreshContext(store, restarted.id, { allowNetwork: false }));
		assert.deepEqual(ids(restarted), ["static", "remote", "found"]);
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it("keeps the catalog entry when a discovered model has the same ID", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => catalogResponse({}));
		const provider = discoveringProvider(async () => [{ ...discoveredModel("static"), name: "Account static" }]);
		await provider.refreshModels?.(
			await makeRefreshContext(new InMemoryModelsStore(), provider.id, { credential: { type: "api_key" } }),
		);
		assert.deepEqual(provider.getModels(), [model("static")]);
	});

	it("still discovers when the catalog download fails, then reports that failure", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("unavailable", { status: 503 }));
		const store = new InMemoryModelsStore();
		const provider = discoveringProvider(async () => [discoveredModel("found")]);
		const context = await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } });
		await assert.rejects(async () => provider.refreshModels?.(context), /503/);
		assert.deepEqual(ids(provider), ["static", "found"]);
	});

	it("does not discover without the network", async () => {
		const discover = vi.fn<DiscoverModels>(async () => [discoveredModel("found")]);
		const provider = discoveringProvider(discover);
		await provider.refreshModels?.(
			await makeRefreshContext(new InMemoryModelsStore(), provider.id, { allowNetwork: false }),
		);
		assert.equal(discover.mock.calls.length, 0);
		assert.deepEqual(ids(provider), ["static"]);
	});
});
