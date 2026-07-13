import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { parseModelPattern, resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const legacyId = "claude-fable-5-context-1m-max-mode-low";
const cursorFableModel = cursorModel("claude-fable-5-1m-max", "Fable 5 (1M, Max)", [
	legacyId,
	"claude-fable-5-context-1m-max-mode-medium",
]);

function cursorModel(id: string, name: string, aliases: readonly string[]): Model<Api> {
	return {
		id,
		name,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		compat: { cursorModelAliases: aliases } as Model<Api>["compat"],
	};
}

function cursorRegistry(models: readonly Model<Api>[] = [cursorFableModel]): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	registry.registerProvider("cursor", {
		baseUrl: "https://api2.cursor.sh",
		apiKey: "cursor-test-key",
		api: "cursor-agent",
		models: models.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: [...model.input],
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			compat: model.compat,
		})),
	});
	return registry;
}

describe("Cursor model compatibility aliases", () => {
	test("resolves a prior synthetic row id to its canonical mode row", () => {
		expect(parseModelPattern(legacyId, [cursorFableModel]).model).toBe(cursorFableModel);
		expect(parseModelPattern(`cursor/${legacyId}`, [cursorFableModel]).model).toBe(cursorFableModel);
	});

	test("rejects an ambiguous alias before fuzzy matching", () => {
		const models = [
			cursorModel("legacy-model-new", "Legacy model new", ["legacy-model"]),
			cursorModel("other-row", "Other row", ["legacy-model"]),
		];
		expect(parseModelPattern("legacy-model", models).model).toBeUndefined();
		expect(parseModelPattern("cursor/legacy-model", models).model).toBeUndefined();
	});

	test("keeps an exact current id authoritative over an alias", () => {
		const exact = cursorModel("legacy-model", "Current model", []);
		const aliasOwner = cursorModel("other-row", "Other row", ["legacy-model"]);
		expect(parseModelPattern("legacy-model", [aliasOwner, exact]).model).toBe(exact);
	});

	for (const entry of [
		{ name: "bare", cliModel: legacyId },
		{ name: "provider reference", cliModel: `cursor/${legacyId}` },
		{ name: "explicit provider", cliProvider: "cursor", cliModel: legacyId },
	] as const) {
		test(`resolves a legacy Cursor id through CLI ${entry.name} matching`, () => {
			const result = resolveCliModel({
				...(entry.cliProvider ? { cliProvider: entry.cliProvider } : {}),
				cliModel: entry.cliModel,
				modelRegistry: cursorRegistry(),
			});
			expect(result.error).toBeUndefined();
			expect(result.model?.id).toBe(cursorFableModel.id);
		});
	}

	test("rejects an ambiguous Cursor alias through the public CLI resolver", () => {
		const models = [
			cursorModel("legacy-model-new", "Legacy model new", ["legacy-model"]),
			cursorModel("other-row", "Other row", ["legacy-model"]),
		];
		const result = resolveCliModel({ cliProvider: "cursor", cliModel: "legacy-model", modelRegistry: cursorRegistry(models) });
		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
	});

	test("rejects an unknown Cursor id instead of fabricating a route-less model", () => {
		const result = resolveCliModel({ cliModel: "cursor/removed-cursor-model", modelRegistry: cursorRegistry() });
		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
		expect(result.warning).toBeUndefined();
	});

	test("does not permit unknown session ids for exact-routed Cursor catalogs", () => {
		expect(cursorRegistry().canRestoreUnknownModel("cursor")).toBe(false);
	});
});
