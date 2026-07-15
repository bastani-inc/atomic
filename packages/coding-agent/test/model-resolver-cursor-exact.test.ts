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

	test("bare legacy Cursor IDs cannot fall through to another provider", () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" }],
		});
		const rejected = resolveCliModel({ cliModel: "composer-2", modelRegistry: registry });
		expect(rejected.model).toBeUndefined();
		expect(rejected.error).toContain("Cursor model IDs changed");

		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: [cursorModel("composer-2")],
		});
		const current = resolveCliModel({ cliModel: "composer-2", modelRegistry: registry });
		expect(current.model?.provider).toBe("cursor");
	});

	test("explicit non-Cursor provider intent overrides rejection-only tombstones", () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" }],
		});
		expect(resolveCliModel({ cliProvider: "openai", cliModel: "composer-2", modelRegistry: registry }).model?.provider).toBe("openai");
	});

	test("scope resolution accepts only an exact Cursor reference and excludes fuzzy or glob matches", async () => {
		const registry = cursorRegistry();
		const exact = await resolveModelScopeWithDiagnostics([exactId], registry);
		expect(exact.scopedModels.map((entry) => entry.model.id)).toEqual([exactId]);
		for (const pattern of [staleId, "cursor-grok-4.5", "cursor/*", exactId.toUpperCase()]) {
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);
			expect(result.scopedModels).toEqual([]);
		}
	});

	test("enabled-model scope preserves exact provider-qualified Cursor route syntax", async () => {
		const ids = ["cursor-route", "cursor-route:high", "cursor-route (1m)", " cursor-spaced ", "cursor/nested/route"];
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: ids.map(cursorModel),
		});

		for (const id of ids.slice(1)) {
			const result = await resolveModelScopeWithDiagnostics([`cursor/${id}`], registry);
			expect(result.scopedModels).toHaveLength(1);
			expect(result.scopedModels[0]?.model.id).toBe(id);
			expect(result.scopedModels[0]?.thinkingLevel).toBeUndefined();
			expect(result.diagnostics).toEqual([]);
		}

		for (const pattern of ["cursor/cursor-route:medium", "cursor/cursor-route (2m)", "cursor/CURSOR-ROUTE", "cursor/cursor-*", "cursor/cursor-rou"]) {
			const result = await resolveModelScopeWithDiagnostics([pattern], registry);
			expect(result.scopedModels).toEqual([]);
			expect(result.diagnostics).toHaveLength(1);
			expect(result.diagnostics[0]?.type).toBe("error");
			expect(result.diagnostics[0]?.message).toContain("reselect");
		}
	});

	test("enabled-model scope gives exact Cursor routes precedence over rejection-only tombstones", async () => {
		const registry = cursorRegistry();
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid", apiKey: "test", api: "openai-responses",
			models: [{ ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" }],
		});
		const rejected = await resolveModelScopeWithDiagnostics(["composer-2"], registry);
		expect(rejected.scopedModels).toEqual([]);
		expect(rejected.diagnostics.map((entry) => entry.message).join("\n")).toContain("Cursor model IDs changed");

		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh", apiKey: "cursor-test-key", api: "cursor-agent",
			models: [cursorModel("composer-2")],
		});
		const current = await resolveModelScopeWithDiagnostics(["composer-2"], registry);
		expect(current.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["cursor/composer-2"]);

		const explicitOther = await resolveModelScopeWithDiagnostics(["openai/composer-2"], registry);
		expect(explicitOther.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["openai/composer-2"]);
	});

	test("enabled-model scope preserves ordinary non-Cursor fuzzy and glob behavior", async () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider("anthropic", {
			baseUrl: "https://example.invalid", apiKey: "test-key", api: "anthropic-messages",
			models: [{ ...cursorModel("claude-sonnet-4-5"), provider: "anthropic", api: "anthropic-messages", name: "Claude Sonnet" }],
		});
		const result = await resolveModelScopeWithDiagnostics(["sonnet", "anthropic/*"], registry);
		expect(result.scopedModels.map((entry) => entry.model.provider)).toEqual(["anthropic"]);
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
