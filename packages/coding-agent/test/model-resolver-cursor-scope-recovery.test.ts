import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { recoverCursorModelScopeAfterExtensionStartup } from "../src/main-cursor-model-scope-recovery.ts";

function model(provider: "cursor" | "openai", id: string): Model<Api> {
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

function registry(): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	registry.registerProvider("openai", {
		baseUrl: "https://example.invalid",
		apiKey: "test",
		api: "openai-responses",
		models: [model("openai", "composer-2")],
	});
	return registry;
}

describe("Cursor enabled-model scope recovery", () => {
	test("awaits authenticated discovery before resolving a cold bare historical ID", async () => {
		const modelRegistry = registry();
		const selected: Model<Api>[] = [];
		const scoped: Model<Api>[][] = [];
		let discoveries = 0;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["composer-2"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() {
					discoveries += 1;
					modelRegistry.registerProvider("cursor", {
						baseUrl: "https://api2.cursor.sh",
						apiKey: "test",
						api: "cursor-agent",
						models: [model("cursor", "composer-2")],
					});
				},
				setScopedModels(entries) { scoped.push(entries.map((entry) => entry.model)); },
				async setModel(next) { selected.push(next); },
			},
		});
		expect(discoveries).toBe(1);
		expect(result?.diagnostics).toEqual([]);
		expect(scoped[0]?.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(["cursor/composer-2"]);
		expect(selected.map((entry) => `${entry.provider}/${entry.id}`)).toEqual(["cursor/composer-2"]);
	});

	test("keeps an absent historical ID out of scope without selecting another provider", async () => {
		const modelRegistry = registry();
		let selected = false;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["composer-2"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() {},
				setScopedModels() {},
				async setModel() { selected = true; },
			},
		});
		expect(result?.scopedModels).toEqual([]);
		expect(result?.diagnostics.map((entry) => entry.message).join("\n")).toContain("Cursor model IDs changed");
		expect(selected).toBe(false);
	});

	test("missing qualified Cursor scope stays fatal after discovery without suffix rewrite or default selection", async () => {
		const modelRegistry = registry();
		let selected = false;
		let scopedCount = -1;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["cursor/cursor-route:high"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() {
					modelRegistry.registerProvider("cursor", {
						baseUrl: "https://api2.cursor.sh",
						apiKey: "test",
						api: "cursor-agent",
						models: [model("cursor", "cursor-route")],
					});
				},
				setScopedModels(entries) { scopedCount = entries.length; },
				async setModel() { selected = true; },
			},
		});
		expect(result?.scopedModels).toEqual([]);
		expect(result?.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
		expect(result?.diagnostics[0]?.message).toContain("cursor/cursor-route:high");
		expect(scopedCount).toBe(0);
		expect(selected).toBe(false);
	});

	test("selects a byte-exact qualified Cursor scope whose route ends in a thinking-looking suffix", async () => {
		const modelRegistry = registry();
		const selected: string[] = [];
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["cursor/literal-route:high"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() {
					modelRegistry.registerProvider("cursor", {
						baseUrl: "https://api2.cursor.sh",
						apiKey: "test",
						api: "cursor-agent",
						models: [model("cursor", "literal-route:high")],
					});
				},
				setScopedModels() {},
				async setModel(next) { selected.push(`${next.provider}/${next.id}`); },
			},
		});
		expect(result?.diagnostics).toEqual([]);
		expect(result?.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual(["cursor/literal-route:high"]);
		expect(selected).toEqual(["cursor/literal-route:high"]);
	});

	test("does not trigger Cursor discovery for explicit non-Cursor scope", async () => {
		let discoveries = 0;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["openai/composer-2"],
			modelRegistry: registry(),
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() { discoveries += 1; },
				setScopedModels() {},
				async setModel() {},
			},
		});
		expect(result).toBeUndefined();
		expect(discoveries).toBe(0);
	});
});
