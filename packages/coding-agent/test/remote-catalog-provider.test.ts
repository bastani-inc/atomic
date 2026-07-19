import { createProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

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

function providerStore(store: InMemoryModelsStore) {
	return {
		read: () => store.read("test-provider"),
		write: (entry: Parameters<InMemoryModelsStore["write"]>[1]) => store.write("test-provider", entry),
		delete: () => store.delete("test-provider"),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it("persists keyed catalogs, sends version headers, observes TTL, and supports forced refresh", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => { throw new Error("not used"); },
					streamSimple: () => { throw new Error("not used"); },
				},
			}),
			"https://catalog.example.test",
		);
		const store = new InMemoryModelsStore();
		const context = { credential: { type: "api_key" as const }, store: providerStore(store), allowNetwork: true };

		await provider.refreshModels?.(context);
		await provider.refreshModels?.(context);
		await provider.refreshModels?.({ ...context, force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`atomic/${VERSION}`),
		});
	});

	it("retains cached models on errors and treats 501 routes as unavailable overlays", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify([model("cached")]), { status: 200 }))
			.mockResolvedValueOnce(new Response("failure", { status: 503 }))
			.mockResolvedValueOnce(new Response("not implemented", { status: 501 }));
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => { throw new Error("not used"); },
					streamSimple: () => { throw new Error("not used"); },
				},
			}),
			"https://catalog.example.test",
		);
		const store = new InMemoryModelsStore();
		const context = { credential: { type: "api_key" as const }, store: providerStore(store), allowNetwork: true };

		await provider.refreshModels?.(context);
		await store.write(provider.id, { models: [model("cached")], checkedAt: 0 });
		await expect(provider.refreshModels?.(context)).rejects.toThrow("503");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
		await expect(provider.refreshModels?.(context)).resolves.toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("does not publish refreshed models when persistence fails", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([model("new")]), { status: 200 }));
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => { throw new Error("not used"); },
					streamSimple: () => { throw new Error("not used"); },
				},
			}),
			"https://catalog.example.test",
		);
		const store = {
			read: async () => ({ models: [model("stale")], checkedAt: 0 }),
			write: async () => { throw new Error("disk full"); },
			delete: async () => {},
		};

		await expect(provider.refreshModels?.({
			credential: { type: "api_key" },
			store,
			allowNetwork: true,
		})).rejects.toThrow("disk full");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "stale"]);
	});

	it("allows retry after an aborted request ignores its signal", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async () => new Promise<Response>(() => {}))
			.mockResolvedValueOnce(new Response("not found", { status: 404 }));
		const provider = withRemoteCatalog(
			createProvider({
				id: "test-provider",
				auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
				models: [model("static")],
				api: {
					stream: () => { throw new Error("not used"); },
					streamSimple: () => { throw new Error("not used"); },
				},
			}),
			"https://catalog.example.test",
		);
		const store = new InMemoryModelsStore();
		const controller = new AbortController();
		const context = { credential: { type: "api_key" as const }, store: providerStore(store), allowNetwork: true };
		const first = provider.refreshModels?.({ ...context, signal: controller.signal });
		await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

		controller.abort();
		await expect(first).resolves.toBeUndefined();
		await expect(provider.refreshModels?.({ ...context, force: true })).resolves.toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("prevents an aborted stale read from overwriting a newer catalog", async () => {
		type StoredEntry = Awaited<ReturnType<InMemoryModelsStore["read"]>>;
		let resolveOldRead!: (entry: StoredEntry) => void;
		const oldRead = new Promise<StoredEntry>((resolve) => { resolveOldRead = resolve; });
		let readCount = 0;
		const store = {
			read: async () => {
				readCount += 1;
				return readCount === 1
					? oldRead
					: { models: [model("fresh")], checkedAt: Date.now() };
			},
			write: async () => {},
			delete: async () => {},
		};
		const provider = withRemoteCatalog(createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => { throw new Error("not used"); },
				streamSimple: () => { throw new Error("not used"); },
			},
		}));
		const controller = new AbortController();
		const context = { credential: { type: "api_key" as const }, store, allowNetwork: false };
		const staleRefresh = provider.refreshModels?.({ ...context, signal: controller.signal });
		await vi.waitFor(() => expect(readCount).toBe(1));

		controller.abort();
		await expect(staleRefresh).resolves.toBeUndefined();
		await provider.refreshModels?.(context);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);

		resolveOldRead({ models: [model("stale")], checkedAt: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);
	});

	it("keeps an aborted pending write fenced before a newer refresh persists", async () => {
		type StoredEntry = NonNullable<Awaited<ReturnType<InMemoryModelsStore["read"]>>>;
		let persisted: StoredEntry | undefined;
		let resolveFirstWrite!: () => void;
		const firstWriteGate = new Promise<void>((resolve) => { resolveFirstWrite = resolve; });
		let writeCount = 0;
		const store = {
			read: async () => persisted,
			write: async (entry: StoredEntry) => {
				writeCount += 1;
				if (writeCount === 1) await firstWriteGate;
				persisted = entry;
			},
			delete: async () => { persisted = undefined; },
		};
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify([model("stale")]), { status: 200 }))
			.mockResolvedValueOnce(new Response(JSON.stringify([model("fresh")]), { status: 200 }));
		const provider = withRemoteCatalog(createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => { throw new Error("not used"); },
				streamSimple: () => { throw new Error("not used"); },
			},
		}));
		const context = { credential: { type: "api_key" as const }, store, allowNetwork: true, force: true };
		const controller = new AbortController();
		const staleRefresh = provider.refreshModels?.({ ...context, signal: controller.signal });
		await vi.waitFor(() => expect(writeCount).toBe(1));

		controller.abort();
		let staleSettled = false;
		void staleRefresh?.then(() => { staleSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(staleSettled).toBe(false);
		const overlappingRetry = provider.refreshModels?.(context);
		expect(overlappingRetry).not.toBe(staleRefresh);
		expect(writeCount).toBe(1);

		resolveFirstWrite();
		await overlappingRetry;
		expect(persisted?.models.map((entry) => entry.id)).toEqual(["fresh"]);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);
	});

	it("escalates a forced network refresh over an in-flight cache restore", async () => {
		let resolveCacheRead!: () => void;
		const cacheReadGate = new Promise<void>((resolve) => { resolveCacheRead = resolve; });
		const backingStore = new InMemoryModelsStore();
		await backingStore.write("test-provider", { models: [model("cached")], checkedAt: Date.now() });
		let readCount = 0;
		const store = {
			read: async () => {
				readCount += 1;
				if (readCount === 1) await cacheReadGate;
				return backingStore.read("test-provider");
			},
			write: (entry: Parameters<InMemoryModelsStore["write"]>[1]) => backingStore.write("test-provider", entry),
			delete: () => backingStore.delete("test-provider"),
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([model("fresh")]), { status: 200 }),
		);
		const provider = withRemoteCatalog(createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => { throw new Error("not used"); },
				streamSimple: () => { throw new Error("not used"); },
			},
		}));
		const credential = { type: "api_key" as const };
		const cacheRestore = provider.refreshModels?.({ credential, store, allowNetwork: false });
		await vi.waitFor(() => expect(readCount).toBe(1));
		const forcedRefresh = provider.refreshModels?.({ credential, store, allowNetwork: true, force: true });

		resolveCacheRead();
		await cacheRestore;
		await forcedRefresh;
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);
	});

	it("runs a forced escalation after the weaker cache restore rejects", async () => {
		let resolveCacheRead!: () => void;
		const cacheReadGate = new Promise<void>((resolve) => { resolveCacheRead = resolve; });
		let readCount = 0;
		const store = {
			read: async () => {
				readCount += 1;
				if (readCount === 1) {
					await cacheReadGate;
					throw new Error("transient cache read");
				}
				return undefined;
			},
			write: async () => {},
			delete: async () => {},
		};
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([model("fresh")]), { status: 200 }),
		);
		const provider = withRemoteCatalog(createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => { throw new Error("not used"); },
				streamSimple: () => { throw new Error("not used"); },
			},
		}));
		const credential = { type: "api_key" as const };
		const cacheRestore = provider.refreshModels?.({ credential, store, allowNetwork: false });
		await vi.waitFor(() => expect(readCount).toBe(1));
		const forcedRefresh = provider.refreshModels?.({ credential, store, allowNetwork: true, force: true });

		resolveCacheRead();
		await expect(cacheRestore).rejects.toThrow("transient cache read");
		await expect(forcedRefresh).resolves.toBeUndefined();
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);
	});
});
