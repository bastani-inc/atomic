import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { describeModelRegistry } from "./model-registry-fixtures.ts";

const sonnetId = "anthropic/claude-sonnet-4";
const opusId = "anthropic/claude-opus-4";

function modelWithHeaders(id: string, headers?: Record<string, string>): Record<string, unknown> {
	return { id, headers };
}

describeModelRegistry((context) => {
	function createLayeredRegistry(...providerLayers: Array<Record<string, unknown>>) {
		const paths = providerLayers.map((providers, index) => {
			const path = join(context.tempDir, `layer-${index}-models.json`);
			writeFileSync(path, JSON.stringify({ providers }));
			return path;
		});
		return ModelRegistry.create(context.authStorage, paths);
	}

	async function resolveHeaders(registry: ModelRegistry): Promise<Record<string, string>> {
		const model = registry.find("openrouter", sonnetId);
		if (!model) throw new Error("missing layered model");
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);
		return auth.headers ?? {};
	}

	test("layered modelOverrides retain disjoint model IDs under the same provider", () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [opusId]: { name: "Primary Opus" } } } },
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Legacy Sonnet" } } } },
		);

		expect(registry.find("openrouter", sonnetId)?.name).toBe("Legacy Sonnet");
		expect(registry.find("openrouter", opusId)?.name).toBe("Primary Opus");
	});

	test("primary exact modelOverride replaces the legacy entry wholesale", () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: { maxTokens: 12_345 } } } },
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Legacy Name", cost: { input: 99 } } } } },
		);
		const model = registry.find("openrouter", sonnetId);

		expect(model?.maxTokens).toBe(12_345);
		expect(model?.name).not.toBe("Legacy Name");
		expect(model?.cost.input).not.toBe(99);
	});

	test("primary empty modelOverride suppresses legacy-only fields", () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: {} } } },
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Legacy Name" } } } },
		);

		expect(registry.find("openrouter", sonnetId)?.name).not.toBe("Legacy Name");
	});

	test("primary empty provider override map retains legacy modelOverrides", () => {
		const registry = createLayeredRegistry(
			{ openrouter: { baseUrl: "https://primary.example/v1", modelOverrides: {} } },
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Legacy Sonnet" } } } },
		);

		expect(registry.find("openrouter", sonnetId)?.name).toBe("Legacy Sonnet");
	});

	test("more than two modelOverride layers retain ordered overlays", () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Primary Sonnet" } } } },
			{ openrouter: { modelOverrides: { [opusId]: { name: "Middle Opus" } } } },
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Legacy Sonnet" } } } },
		);

		expect(registry.find("openrouter", sonnetId)?.name).toBe("Primary Sonnet");
		expect(registry.find("openrouter", opusId)?.name).toBe("Middle Opus");
	});

	test("primary exact replacement without headers clears a legacy override header", async () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Primary Name" } } } },
			{ openrouter: { modelOverrides: { [sonnetId]: { headers: { "X-Legacy": "legacy" } } } } },
		);

		expect((await resolveHeaders(registry))["X-Legacy"]).toBeUndefined();
	});

	test("a legacy custom-model header survives a primary override without headers", async () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: { name: "Primary Name" } } } },
			{ openrouter: { models: [modelWithHeaders(sonnetId, { "X-Model": "legacy-model" })] } },
		);

		expect((await resolveHeaders(registry))["X-Model"]).toBe("legacy-model");
	});

	test("a primary override header beats a retained legacy custom-model header", async () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: { headers: { "X-Layered": "primary-override" } } } } },
			{ openrouter: { models: [modelWithHeaders(sonnetId, { "X-Layered": "legacy-model" })] } },
		);

		expect((await resolveHeaders(registry))["X-Layered"]).toBe("primary-override");
	});

	test("a primary custom-model header beats a retained legacy override header", async () => {
		const registry = createLayeredRegistry(
			{ openrouter: { models: [modelWithHeaders(sonnetId, { "X-Layered": "primary-model" })] } },
			{ openrouter: { modelOverrides: { [sonnetId]: { headers: { "X-Layered": "legacy-override" } } } } },
		);

		expect((await resolveHeaders(registry))["X-Layered"]).toBe("primary-model");
	});

	test("a custom-model header wins over an override header in the same file", async () => {
		const registry = createLayeredRegistry({
			openrouter: {
				models: [modelWithHeaders(sonnetId, { "X-Layered": "same-file-model" })],
				modelOverrides: { [sonnetId]: { headers: { "X-Layered": "same-file-override" } } },
			},
		});

		expect((await resolveHeaders(registry))["X-Layered"]).toBe("same-file-model");
	});

	test("primary override headers win an exact layered override conflict", async () => {
		const registry = createLayeredRegistry(
			{ openrouter: { modelOverrides: { [sonnetId]: { headers: { "X-Layered": "primary" } } } } },
			{ openrouter: { modelOverrides: { [sonnetId]: { headers: { "X-Layered": "legacy" } } } } },
		);

		expect((await resolveHeaders(registry))["X-Layered"]).toBe("primary");
	});

	test("layered headers keep structured provider/model identities collision-free", async () => {
		const registry = createLayeredRegistry(
			{ cursor: {
				baseUrl: "https://api2.cursor.sh", apiKey: "static-key", api: "cursor-agent",
				models: [modelWithHeaders("proxy:variant-route", { "X-Static-Cursor": "ignored" })],
			} },
			{ "cursor:proxy": {
				baseUrl: "https://proxy.invalid", apiKey: "variant-key", api: "anthropic-messages",
				models: [modelWithHeaders("variant-route", { "X-Cursor-Variant": "legacy-preserved" })],
			} },
		);

		expect(registry.find("cursor", "proxy:variant-route")).toBeUndefined();
		const variant = registry.find("cursor:proxy", "variant-route");
		expect(variant).toBeDefined();
		const auth = await registry.getApiKeyAndHeaders(variant!);
		expect(auth.ok).toBe(true);
		if (auth.ok) {
			expect(auth.headers?.["X-Cursor-Variant"]).toBe("legacy-preserved");
			expect(auth.headers?.["X-Static-Cursor"]).toBeUndefined();
		}
	});

	test("extension providers receive disjoint layered modelOverrides", () => {
		const registry = createLayeredRegistry(
			{ "layered-extension": { modelOverrides: { "model-b": { name: "Primary B" } } } },
			{ "layered-extension": { modelOverrides: { "model-a": { name: "Legacy A" } } } },
		);
		registry.registerProvider("layered-extension", {
			baseUrl: "https://provider.test/v1",
			apiKey: "TEST_KEY",
			api: "openai-completions",
			models: ["model-a", "model-b"].map((id) => ({
				id,
				name: id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 4096,
			})),
		});

		expect(registry.find("layered-extension", "model-a")?.name).toBe("Legacy A");
		expect(registry.find("layered-extension", "model-b")?.name).toBe("Primary B");
	});
});
