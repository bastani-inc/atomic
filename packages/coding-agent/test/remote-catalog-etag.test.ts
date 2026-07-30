import { createProvider, InMemoryModelsStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function testProvider() {
	return withRemoteCatalog(
		createProvider({
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
		}),
		"https://catalog.example.test",
	);
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog ETag revalidation", () => {
	it("sends a stored ETag and keeps the cached body on an empty 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304 }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift()!);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const refresh = { credential: { type: "api_key" as const }, store: providerStore(store), allowNetwork: true };

		await provider.refreshModels?.(refresh);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		const first = await store.read(provider.id);
		expect(first?.etag).toBe('"catalog-1"');
		await provider.refreshModels?.({ ...refresh, force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(first?.checkedAt ?? 0);
	});

	it("does not send a validator without a cached body", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ dynamic: model("dynamic") }), { status: 200 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [], checkedAt: 0, etag: '"orphan"' });

		await provider.refreshModels?.({
			credential: { type: "api_key" },
			store: providerStore(store),
			allowNetwork: true,
		});

		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
	});

	it("drops stale validators for unavailable overlays and keeps them after transient errors", async () => {
		const responses = [new Response("missing", { status: 501 }), new Response("busy", { status: 503 })];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift()!);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [model("cached")], checkedAt: 0, etag: '"one"' });
		const refresh = {
			credential: { type: "api_key" as const },
			store: providerStore(store),
			allowNetwork: true,
			force: true,
		};

		await provider.refreshModels?.(refresh);
		expect((await store.read(provider.id))?.etag).toBeUndefined();
		await store.write(provider.id, { models: [model("cached")], checkedAt: 0, etag: '"two"' });
		await expect(provider.refreshModels?.(refresh)).rejects.toThrow("503");
		expect((await store.read(provider.id))?.etag).toBe('"two"');
	});
});
