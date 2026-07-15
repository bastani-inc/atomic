import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { resolveModelScopeWithDiagnostics } from "../src/core/model-resolver-scope.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const exactId = "cursor-grok-4.5-high";
const staleId = "grok-4.5-high";

function cursorModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function cursorRegistry(): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	registry.registerProvider("cursor", {
		baseUrl: "https://api2.cursor.sh",
		apiKey: "cursor-test-key",
		api: "cursor-agent",
		models: [cursorModel(exactId)],
	});
	return registry;
}

describe("Cursor exact model resolution", () => {
	test("resolves only the exact authenticated flat route", () => {
		const result = resolveCliModel({
			cliProvider: "cursor",
			cliModel: exactId,
			modelRegistry: cursorRegistry(),
		});
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe(exactId);
		expect(result.thinkingLevel).toBeUndefined();
	});

	test("accepts exact bare and provider-qualified current route IDs", () => {
		for (const cliModel of [exactId, `cursor/${exactId}`]) {
			const result = resolveCliModel({ cliModel, modelRegistry: cursorRegistry() });
			expect(result.model?.id).toBe(exactId);
			expect(result.error).toBeUndefined();
		}
	});

	test("preserves a thinking-like suffix when it is part of the exact flat route ID", () => {
		const id = "cursor-route:high";
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent", models: [cursorModel(id)],
		});
		expect(resolveCliModel({ cliModel: `cursor/${id}`, modelRegistry: registry }).model?.id).toBe(id);
	});

	for (const entry of [
		{ name: "explicit provider", cliProvider: "cursor", cliModel: staleId },
		{ name: "provider reference", cliModel: `cursor/${staleId}` },
		{ name: "bare legacy id", cliModel: staleId },
		{ name: "shortened id", cliModel: "cursor-grok-4.5" },
		{ name: "case-normalized id", cliModel: exactId.toUpperCase() },
		{ name: "nearest effort", cliProvider: "cursor", cliModel: "cursor-grok-4.5-medium" },
		{ name: "reasoning suffix", cliProvider: "cursor", cliModel: `${exactId}:high` },
	] as const) {
		test(`rejects a non-exact Cursor ${entry.name} without substitution`, () => {
			const result = resolveCliModel({
				...(entry.cliProvider ? { cliProvider: entry.cliProvider } : {}),
				cliModel: entry.cliModel,
				modelRegistry: cursorRegistry(),
			});
			expect(result.model).toBeUndefined();
			expect(result.error).toContain("not found");
			expect(result.error).toContain("--list-models");
			expect(result.warning).toBeUndefined();
		});
	}

	test("scope resolution accepts only an exact Cursor reference and excludes fuzzy or glob matches", async () => {
		const registry = cursorRegistry();
		const exact = await resolveModelScopeWithDiagnostics([exactId], registry);
		expect(exact.scopedModels.map((entry) => entry.model.id)).toEqual([exactId]);
		for (const pattern of [staleId, "cursor-grok-4.5", "cursor/*", exactId.toUpperCase()]) {
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);
			expect(result.scopedModels).toEqual([]);
		}
	});

	test("non-Cursor fuzzy matching remains unchanged", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("anthropic", {
			baseUrl: "https://example.invalid", apiKey: "test-key", api: "anthropic-messages",
			models: [{ ...cursorModel("claude-sonnet-4-5"), provider: "anthropic", api: "anthropic-messages", name: "Claude Sonnet" }],
		});
		const resolved = resolveCliModel({ cliModel: "sonnet", modelRegistry: registry }).model;
		expect(resolved).toBeDefined();
		expect(resolved?.provider).not.toBe("cursor");
	});

	test("registry lookup does not honor removed compatibility metadata", () => {
		const registry = cursorRegistry();
		expect(registry.find("cursor", exactId)?.id).toBe(exactId);
		expect(registry.find("cursor", staleId)).toBeUndefined();
		expect(registry.canRestoreUnknownModel("cursor")).toBe(false);
	});
});
