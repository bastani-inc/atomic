import assert from "node:assert/strict";
import {
	createModels,
	createProvider,
	type ImageModel,
	InMemoryModelsStore,
	type Model,
	type ModelsStore,
	type Provider,
} from "@bastani/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.js";
import {
	type DiscoverModels,
	type PersonalizeCatalog,
	REMOTE_CATALOG_MODEL_TYPES,
	withDiscoveredModels,
	withPersonalizedCatalog,
	withRemoteCatalog,
} from "../src/core/remote-catalog-provider.js";
import { makeRefreshContext } from "./helpers/refresh-context.js";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function builtinProvider(): Provider {
	return createProvider({
		id: "test-provider",
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

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(builtinProvider(), "https://pi.dev", localGeneratedAt);
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it("merges remote overrides by model type and ID while preserving catalog order", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json([
				{ ...model("static"), name: "Remote static" },
				model("new"),
				{ ...model("new"), name: "Latest new" },
				{ ...model("static"), type: "classifier", name: "Static classifier" },
			]),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }));
		assert.deepEqual(
			provider.getModels().map((entry) => [entry.id, entry.name]),
			[
				["static", "Remote static"],
				["new", "Latest new"],
			],
		);
		assert.deepEqual(
			provider.getAllModels?.().map((entry) => [entry.id, entry.name]),
			[
				["static", "Remote static"],
				["new", "Latest new"],
				["static", "Static classifier"],
			],
		);
	});

	it("preserves bundled service tiers omitted by remote catalogs and honors explicit replacements", async () => {
		const baseline = { ...model("static"), serviceTiers: [{ id: "ultrafast" as const, cost: model("static").cost }] };
		const builtin = builtinProvider();
		const provider = withRemoteCatalog({ ...builtin, getModels: () => [baseline] });
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [{ ...model("static"), name: "Cached static" }] });
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { allowNetwork: false }));
		assert.equal(provider.getModels()[0]?.name, "Cached static");
		assert.deepEqual(provider.getModels()[0]?.serviceTiers, baseline.serviceTiers);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([{ ...model("static"), serviceTiers: [] }]));
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { force: true }));
		assert.deepEqual(provider.getModels()[0]?.serviceTiers, []);
	});

	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const refresh = (force?: boolean) =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" } as const, force });
		await provider.refreshModels?.(await refresh());
		await provider.refreshModels?.(await refresh());
		await provider.refreshModels?.(await refresh(true));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`atomic/${VERSION}`),
		});
		const requested = new URL(String(fetchSpy.mock.calls[0]?.[0]));
		expect(requested.pathname).toBe("/api/models/providers/test-provider");
		expect(requested.searchParams.get("types")).toBe(REMOTE_CATALOG_MODEL_TYPES.join(","));
	});

	it("overlays image and classifier models and drops unknown model types", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						chat: { ...model("chat"), type: "chat" },
						flux: {
							type: "image",
							id: "flux",
							name: "FLUX",
							api: "openrouter-images",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							output: ["image"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						jev: {
							type: "classifier",
							id: "jev",
							name: "Jev",
							api: "typesafe-system-one",
							provider: "test-provider",
							baseUrl: "https://example.test/v1",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 64000,
						},
						clip: { ...model("clip"), type: "video" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }));

		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(models.getAllModels("test-provider").map((entry) => entry.id)).toEqual(["static", "chat", "flux", "jev"]);
		expect(models.getModelOfType("image", "test-provider", "flux")?.type).toBe("image");
		expect(models.getModelOfType("classifier", "test-provider", "jev")?.type).toBe("classifier");
		expect(models.getModel("test-provider", "flux")).toBeUndefined();
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["chat", "flux", "jev"]);
	});

	it("ignores malformed operation entries instead of replacing usable models", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			Response.json({
				invalidImage: { id: "static", type: "image" },
				invalidClassifier: { id: "judge", type: "classifier" },
				validChat: model("dynamic"),
			}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }));
		expect(provider.getAllModels?.().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();
		const refresh = (force?: boolean) =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" } as const, force });

		await provider.refreshModels?.(await refresh());
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await provider.refreshModels?.(await refresh(true));
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const refresh = (force?: boolean) =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" } as const, force });

		await provider.refreshModels?.(await refresh());
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await provider.refreshModels?.(await refresh(true));

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const refresh = (force?: boolean) =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" } as const, force });

		await provider.refreshModels?.(await refresh());
		await provider.refreshModels?.(await refresh(true));

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const refresh = (force?: boolean) =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" } as const, force });

		await provider.refreshModels?.(await refresh());
		await expect(provider.refreshModels?.(await refresh(true))).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await provider.refreshModels?.(await refresh(true));
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(
			provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
		).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});

	it("surfaces persistence failures without publishing an uncommitted catalog", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ new: model("new") }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const provider = testProvider();
		const store: ModelsStore = {
			read: async () => ({ models: [model("stale")], checkedAt: 0 }),
			write: async () => {
				throw new Error("disk full");
			},
			delete: async () => {},
		};

		await expect(
			provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
		).rejects.toThrow("disk full");
		// pi 0.84.1 persists before invoking publication.update. A failed write
		// therefore leaves the restored cached overlay visible and does not expose
		// the newly fetched catalog as if it had been committed.
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "stale"]);
	});
});

describe("personalized catalog provider", () => {
	const imageModel: ImageModel<"openrouter-images"> = {
		type: "image",
		id: "image",
		name: "image",
		api: "openrouter-images",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};

	it.each(["HTTP 500", "transport", "invalid JSON"])(
		"personalizes and replaces stale limits and prices after a pi.dev %s failure",
		async (failure) => {
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
				if (failure === "transport") throw new TypeError("connection refused");
				return new Response("unavailable", { status: failure === "HTTP 500" ? 500 : 200 });
			});
			const store = new InMemoryModelsStore();
			await store.write("test-provider", {
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
			const provider = withPersonalizedCatalog(builtinProvider(), personalize);
			await provider.refreshModels?.(await makeRefreshContext(store, provider.id));
			assert.equal(fetchSpy.mock.calls.length, failure === "invalid JSON" ? 1 : 3);
			assert.equal(personalize.mock.calls.length, 1);
			assert.deepEqual(provider.getModels(), personalized);
			assert.deepEqual((await store.read(provider.id))?.models, personalized);
		},
	);

	it("does not personalize or persist after the overlay request is cancelled", async () => {
		const controller = new AbortController();
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			controller.abort();
			throw new DOMException("cancelled", "AbortError");
		});
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write("test-provider", saved);
		const personalize = vi.fn<PersonalizeCatalog>(async () => [model("static")]);
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { signal: controller.signal }));
		assert.equal(personalize.mock.calls.length, 0);
		assert.deepEqual(await store.read(provider.id), saved);
		assert.deepEqual(provider.getModels(), saved.models);
	});

	it("surfaces persistence failure after overlay fallback without publishing the new list", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection refused"));
		const saved = { models: [model("allowed")], checkedAt: 1 };
		const store: ModelsStore = {
			read: async () => saved,
			write: async () => {
				throw new Error("disk full");
			},
			delete: async () => {},
		};
		const provider = withPersonalizedCatalog(builtinProvider(), async () => [model("static")]);
		await assert.rejects(provider.refreshModels!(await makeRefreshContext(store, provider.id)), /disk full/);
		assert.deepEqual(provider.getModels(), saved.models);
		assert.deepEqual(await store.read(provider.id), saved);
	});

	it("personalizes the built-in models plus a newer pi.dev catalog and saves the result", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json([model("remote")], { headers: { "last-modified": new Date(2_000).toUTCString() } }),
		);
		const seen: string[][] = [];
		const personalize: PersonalizeCatalog = async (catalog) => {
			seen.push(catalog.map((entry) => entry.id));
			return catalog.filter((entry) => entry.id === "remote");
		};
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(builtinProvider(), personalize, "https://pi.dev", 1_000);

		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }));

		expect(seen).toEqual([["static", "remote"]]);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["remote"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["remote"]);
	});

	it("keeps the saved list and saves nothing when personalization fails", async () => {
		// Saving the catalog without personalization would replace the key's list with every model.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
		const store = new InMemoryModelsStore();
		const saved = { models: [model("allowed")], checkedAt: 1 };
		await store.write("test-provider", saved);
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("user models request failed");
		};
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);

		await expect(
			provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } })),
		).rejects.toThrow("user models request failed");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["allowed"]);
		expect(await store.read(provider.id)).toEqual(saved);
	});

	it("restores a saved list as is, and falls back to the built-in models only when it is empty", async () => {
		const personalize: PersonalizeCatalog = async () => {
			throw new Error("not used offline");
		};
		const store = new InMemoryModelsStore();
		const provider = withPersonalizedCatalog(builtinProvider(), personalize);
		const offline = () =>
			makeRefreshContext(store, provider.id, { credential: { type: "api_key" }, allowNetwork: false });

		// Versions before per-key lists stored the plain pi.dev catalog here, and saved an empty list
		// after a missing pi.dev catalog or a failed first request. Only such an entry can be empty.
		await store.write(provider.id, { models: [], checkedAt: 1 });
		await provider.refreshModels?.(await offline());
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		// A key that may use no chat models keeps its image models and shows no chat models.
		await store.write(provider.id, { models: [imageModel], checkedAt: 1 });
		await provider.refreshModels?.(await offline());
		expect(provider.getModels()).toEqual([]);
		expect(provider.getAllModels?.().map((entry) => entry.id)).toEqual(["image"]);
	});
});

describe("discovered models provider", () => {
	const discoveredModel = (id: string): Model<"openai-completions"> => ({ ...model(id), discovered: true });
	const ids = (provider: Provider) => provider.getModels().map((entry) => entry.id);

	function discoveringProvider(discover: DiscoverModels, localGeneratedAt = 1_000): Provider {
		return withDiscoveredModels(withRemoteCatalog(builtinProvider(), "https://pi.dev", localGeneratedAt), discover);
	}

	function stubCatalogOverlay(response: () => Response) {
		return vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
	}

	it("adds discovered models after the catalog and restores them offline beside the catalog overlay", async () => {
		const fetchSpy = stubCatalogOverlay(() =>
			Response.json([model("remote")], { headers: { "last-modified": new Date(2_000).toUTCString() } }),
		);
		const seen: string[][] = [];
		const discover = vi.fn<DiscoverModels>(async (catalog) => {
			seen.push(catalog.map((entry) => entry.id));
			return [discoveredModel("found")];
		});
		const store = new InMemoryModelsStore();
		const online = discoveringProvider(discover);
		await online.refreshModels?.(await makeRefreshContext(store, online.id, { credential: { type: "api_key" } }));

		assert.deepEqual(seen, [["static", "remote"]]);
		assert.deepEqual(ids(online), ["static", "remote", "found"]);
		const saved = await store.read(online.id);
		assert.deepEqual(
			saved?.models.map((entry) => entry.id),
			["remote", "found"],
		);
		assert.equal(saved?.lastModified, 2_000);

		fetchSpy.mockClear();
		const restarted = discoveringProvider(async () => {
			throw new Error("not used offline");
		});
		await restarted.refreshModels?.(await makeRefreshContext(store, restarted.id, { allowNetwork: false }));
		assert.deepEqual(ids(restarted), ["static", "remote", "found"]);
		assert.equal(fetchSpy.mock.calls.length, 0);
	});

	it("keeps the catalog entry when a discovered model has the same ID", async () => {
		stubCatalogOverlay(() => new Response("not found", { status: 404 }));
		const provider = discoveringProvider(async () => [{ ...discoveredModel("static"), name: "Account static" }]);
		const store = new InMemoryModelsStore();
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } }));
		assert.deepEqual(provider.getModels(), [model("static")]);
	});

	it("keeps saved discovered models while the catalog overlay refreshes on its own schedule", async () => {
		const fetchSpy = stubCatalogOverlay(() =>
			Response.json([model("remote")], { headers: { "last-modified": new Date(2_000).toUTCString() } }),
		);
		const store = new InMemoryModelsStore();
		const first = discoveringProvider(async () => [discoveredModel("found")]);
		await first.refreshModels?.(await makeRefreshContext(store, first.id, { credential: { type: "api_key" } }));

		const second = discoveringProvider(async () => [discoveredModel("found"), discoveredModel("newer")]);
		await second.refreshModels?.(await makeRefreshContext(store, second.id, { credential: { type: "api_key" } }));
		// The overlay was checked moments ago, so only discovery ran.
		assert.equal(fetchSpy.mock.calls.length, 1);
		assert.deepEqual(ids(second), ["static", "remote", "found", "newer"]);
		assert.deepEqual(
			(await store.read(second.id))?.models.map((entry) => entry.id),
			["remote", "found", "newer"],
		);
	});

	it("still discovers when the catalog overlay request fails, then reports that failure", async () => {
		stubCatalogOverlay(() => new Response("unavailable", { status: 503 }));
		const store = new InMemoryModelsStore();
		const provider = discoveringProvider(async () => [discoveredModel("found")]);
		const context = await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } });
		await assert.rejects(
			async () => provider.refreshModels?.(context),
			/Model catalog request failed for test-provider: 503/,
		);
		assert.deepEqual(ids(provider), ["static", "found"]);
		assert.deepEqual(
			(await store.read(provider.id))?.models.map((entry) => entry.id),
			["found"],
		);
	});

	it("keeps the saved discovered models when discovery fails", async () => {
		stubCatalogOverlay(() => new Response("not found", { status: 404 }));
		const store = new InMemoryModelsStore();
		await store.write("test-provider", { models: [discoveredModel("found")], checkedAt: 1 });
		const provider = discoveringProvider(async () => {
			throw new Error("account list unavailable");
		});
		const context = await makeRefreshContext(store, provider.id, { credential: { type: "api_key" } });
		await assert.rejects(async () => provider.refreshModels?.(context), /account list unavailable/);
		assert.deepEqual(ids(provider), ["static", "found"]);
		assert.deepEqual(
			(await store.read(provider.id))?.models.map((entry) => entry.id),
			["found"],
		);
	});

	it("does not discover without the network", async () => {
		const discover = vi.fn<DiscoverModels>(async () => [discoveredModel("found")]);
		const store = new InMemoryModelsStore();
		const provider = discoveringProvider(discover);
		await provider.refreshModels?.(await makeRefreshContext(store, provider.id, { allowNetwork: false }));
		assert.equal(discover.mock.calls.length, 0);
		assert.deepEqual(ids(provider), ["static"]);
	});
});
