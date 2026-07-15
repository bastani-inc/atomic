import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	classifyBareCursorModelReference,
	LEGACY_CURSOR_DIRECT_MODEL_IDS,
} from "../src/core/legacy-cursor-model-ids.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const EXPECTED_SOURCE_HASH = "2b1bc12b0e155917bba637feb7b51e4bb397949e78e6ba6b5cbaf00fa2abc901";

function testModel(provider: "cursor" | "openai", id: string): Model<Api> {
	return {
		id,
		name: id,
		provider,
		api: provider === "cursor" ? "cursor-agent" : "openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function registryWith(options: { readonly cursor: boolean; readonly openai: boolean }): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	if (options.openai) {
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid",
			apiKey: "test",
			api: "openai-responses",
			models: LEGACY_CURSOR_DIRECT_MODEL_IDS.map((id) => testModel("openai", id)),
		});
	}
	if (options.cursor) {
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh",
			apiKey: "test",
			api: "cursor-agent",
			models: LEGACY_CURSOR_DIRECT_MODEL_IDS.map((id) => testModel("cursor", id)),
		});
	}
	return registry;
}

describe("legacy Cursor direct-route tombstones", () => {
	test("matches the complete 83-ID removed static catalog snapshot", () => {
		expect(LEGACY_CURSOR_DIRECT_MODEL_IDS).toHaveLength(83);
		expect(new Set(LEGACY_CURSOR_DIRECT_MODEL_IDS).size).toBe(83);
		expect(createHash("sha256").update(LEGACY_CURSOR_DIRECT_MODEL_IDS.join("\n")).digest("hex")).toBe(EXPECTED_SOURCE_HASH);
	});

	test("all source IDs are rejection-only and exact current Cursor routes take precedence", () => {
		const nonCursorOnly = registryWith({ cursor: false, openai: true });
		const currentCursor = registryWith({ cursor: true, openai: true });
		const cursorOnlyModels = LEGACY_CURSOR_DIRECT_MODEL_IDS.map((id) => testModel("cursor", id));
		const cursorOnly = { getAll: (): Model<Api>[] => cursorOnlyModels };
		for (const id of LEGACY_CURSOR_DIRECT_MODEL_IDS) {
			const rejected = resolveCliModel({ cliModel: id, modelRegistry: nonCursorOnly });
			expect(rejected.model, id).toBeUndefined();
			expect(rejected.error, id).toContain("Cursor model IDs changed");

			const current = resolveCliModel({ cliModel: id, modelRegistry: currentCursor });
			expect(current.model?.provider, id).toBe("cursor");
			expect(current.model?.id, id).toBe(id);

			const explicitOther = resolveCliModel({ cliModel: `openai/${id}`, modelRegistry: currentCursor });
			expect(explicitOther.model?.provider, id).toBe("openai");

			for (const variant of [id.toUpperCase(), `${id}-legacy-alias`]) {
				expect(classifyBareCursorModelReference(variant, cursorOnlyModels), variant).toBe("other");
				expect(resolveCliModel({ cliModel: variant, modelRegistry: cursorOnly }).model, variant).toBeUndefined();
			}
		}
	});
});
