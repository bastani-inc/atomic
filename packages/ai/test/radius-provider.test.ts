import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { radiusProvider } from "../src/providers/radius.ts";
import { getRadiusModelsFromConfig, type RadiusGatewayConfig } from "../src/providers/radius-config.ts";

function radiusConfig(): RadiusGatewayConfig {
	return {
		baseUrl: "https://radius.example/v1",
		models: [
			{
				id: "balanced",
				name: "Fresh Balanced",
				reasoning: true,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
				contextWindow: 424242,
				maxTokens: 32000,
			},
			{
				id: "organization-only",
				name: "Organization Only",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16000,
			},
		],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Radius provider catalogs", () => {
	it("ships a static public catalog for the default gateway", () => {
		const provider = radiusProvider();
		expect(provider.getModels().length).toBeGreaterThan(0);
		expect(provider.getModels()).toContainEqual(
			expect.objectContaining({ id: "balanced", provider: "radius", api: "pi-messages" }),
		);
	});

	it("does not apply the public Radius catalog to custom gateways", () => {
		const provider = radiusProvider({ id: "radius-dev", gateway: "http://localhost:8788" });
		expect(provider.getModels()).toEqual([]);
	});

	it("replaces the static public catalog with refreshed models", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(radiusConfig()), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials });
		models.setProvider(radiusProvider());

		const result = await models.refresh({ providers: ["radius"] });

		expect(result.errors).toEqual(new Map());
		expect(models.getModel("radius", "balanced")).toMatchObject({
			name: "Fresh Balanced",
			baseUrl: "https://radius.example/v1",
			contextWindow: 424242,
		});
		expect(models.getModel("radius", "organization-only")).toBeDefined();
		assert.deepEqual(
			models.getModels("radius").map((model) => model.id),
			["balanced", "organization-only"],
		);
	});

	it("replaces the static public catalog with a cached catalog without network access", async () => {
		const store = new InMemoryModelsStore();
		await store.write("radius", {
			models: getRadiusModelsFromConfig("radius", radiusConfig()),
			checkedAt: Date.now(),
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(radiusProvider());

		await models.refresh({ providers: ["radius"], allowNetwork: false });

		expect(models.getModel("radius", "balanced")?.name).toBe("Fresh Balanced");
		expect(models.getModel("radius", "organization-only")).toBeDefined();
		assert.deepEqual(
			models.getModels("radius").map((model) => model.id),
			["balanced", "organization-only"],
		);
	});

	it.each([false, true])("exposes no models for an empty catalog, cached=%s", async (cached) => {
		const store = new InMemoryModelsStore();
		if (cached) await store.write("radius", { models: [], checkedAt: Date.now() });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ baseUrl: "https://radius.example/v1", models: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("radius", async () => ({ type: "api_key", key: "radius-key" }));
		const models = createModels({ credentials, modelsStore: store });
		models.setProvider(radiusProvider());
		const result = await models.refresh({ providers: ["radius"], allowNetwork: !cached });
		assert.deepEqual(result.errors, new Map());
		assert.deepEqual(models.getModels("radius"), []);
	});
});
