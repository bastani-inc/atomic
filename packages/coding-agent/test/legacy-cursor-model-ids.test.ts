import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { classifyBareCursorModelReference } from "../src/core/legacy-cursor-model-ids.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { registerTrustedCursorProvider } from "./cursor-test-provider-source.ts";

// Former static Cursor direct-route IDs. They carry no special meaning anymore:
// GetUsable is the sole executable authority, so a bare reference is only a
// current Cursor route when a live lowercase `cursor` row matches it exactly.
const FORMER_LEGACY_IDS = ["composer-2", "composer-1.5", "composer-2-fast"] as const;

function testModel(provider: string, id: string): Model<Api> {
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
		...(provider === "cursor" ? { compat: { cursorRouting: { [id]: { modelId: id, maxMode: false, supportsImages: false, catalogOccurrence: 0 } } } } : {}),
	} as Model<Api>;
}

function registryWith(options: { readonly cursor: boolean; readonly openai: boolean }): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	if (options.openai) {
		registry.registerProvider("openai", {
			baseUrl: "https://example.invalid",
			apiKey: "test",
			api: "openai-responses",
			models: FORMER_LEGACY_IDS.map((id) => testModel("openai", id)),
		});
	}
	if (options.cursor) {
		registerTrustedCursorProvider(registry, {
			baseUrl: "https://api2.cursor.sh",
			apiKey: "test",
			api: "cursor-agent",
			models: FORMER_LEGACY_IDS.map((id) => testModel("cursor", id)),
		});
	}
	return registry;
}

describe("bare Cursor reference classification (no static tombstones)", () => {
	test("a bare former-legacy id resolves as an ordinary non-Cursor row when no live Cursor route matches", () => {
		const nonCursorOnly = registryWith({ cursor: false, openai: true });
		for (const id of FORMER_LEGACY_IDS) {
			const resolved = resolveCliModel({ cliModel: id, modelRegistry: nonCursorOnly });
			expect(resolved.model?.provider, id).toBe("openai");
			expect(resolved.model?.id, id).toBe(id);
			expect(resolved.error, id).toBeUndefined();
		}
	});

	test("a bare id that matches a live exact Cursor route still resolves to Cursor", () => {
		const currentCursor = registryWith({ cursor: true, openai: true });
		for (const id of FORMER_LEGACY_IDS) {
			const current = resolveCliModel({ cliModel: id, modelRegistry: currentCursor });
			// Both an openai and a cursor row exist; the classifier prefers the
			// exact live Cursor row for a bare reference.
			expect(current.model?.provider, id).toBe("cursor");
			expect(current.model?.id, id).toBe(id);
		}
	});

	test("classifyBareCursorModelReference is dynamic: current-cursor only for exact live lowercase rows", () => {
		const cursorRows = FORMER_LEGACY_IDS.map((id) => testModel("cursor", id));
		expect(classifyBareCursorModelReference("composer-2", cursorRows)).toBe("current-cursor");
		expect(classifyBareCursorModelReference("not-a-live-route", cursorRows)).toBe("other");
		// A slash-bearing reference is never a bare Cursor reference.
		expect(classifyBareCursorModelReference("cursor/composer-2", cursorRows)).toBe("other");
	});

	test("custom case-variant Cursor provider rows are ordinary non-Cursor identities, not Cursor tombstones", () => {
		for (const provider of ["Cursor", "CURSOR", " cursor", "cursor "]) {
			expect(classifyBareCursorModelReference("composer-2", [testModel(provider, "composer-2")]), provider)
				.toBe("other");
		}
	});
});
