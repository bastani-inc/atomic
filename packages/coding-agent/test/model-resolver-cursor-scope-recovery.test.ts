import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { recoverCursorModelScopeAfterExtensionStartup } from "../src/main-cursor-model-scope-recovery.ts";
import { registerTrustedCursorProvider } from "./cursor-test-provider-source.ts";

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
		...(provider === "cursor" ? {
			compat: { cursorRouting: { [id]: { modelId: id, maxMode: false, supportsImages: false, catalogOccurrence: 0 } } },
		} : {}),
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
	test("a bare former-legacy id needs no Cursor discovery and resolves through ordinary scope", async () => {
		const modelRegistry = registry();
		let discoveries = 0;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["composer-2"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() { discoveries += 1; },
				setScopedModels() {},
				async setModel() {},
			},
		});
		// No explicit `cursor/` reference, so Cursor discovery is not reserved; the
		// ordinary (non-Cursor) startup scope path resolves openai/composer-2.
		expect(result).toBeUndefined();
		expect(discoveries).toBe(0);
	});

	test("an explicit cursor/ scope still awaits authenticated discovery", async () => {
		const modelRegistry = registry();
		const selected: Model<Api>[] = [];
		const scoped: Model<Api>[][] = [];
		let discoveries = 0;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["cursor/composer-2"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			session: {
				async discoverExtensionModels() {
					discoveries += 1;
					registerTrustedCursorProvider(modelRegistry, {
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

	test("selectInitialModel honors the saved default and current selection over scopedModels[0]", async () => {
		const buildRegistry = (): ModelRegistry => {
			const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
			registerTrustedCursorProvider(modelRegistry, {
				baseUrl: "https://api2.cursor.sh",
				apiKey: "test",
				api: "cursor-agent",
				models: [model("cursor", "first"), model("cursor", "saved")],
			});
			return modelRegistry;
		};

		// Saved default is the second scoped entry: it is selected, not scopedModels[0].
		{
			const modelRegistry = buildRegistry();
			const selected: string[] = [];
			await recoverCursorModelScopeAfterExtensionStartup({
				patterns: ["cursor/first", "cursor/saved"],
				modelRegistry,
				mode: "print",
				selectInitialModel: true,
				savedProvider: "cursor",
				savedModelId: "saved",
				session: {
					async discoverExtensionModels() {},
					setScopedModels() {},
					async setModel(next) { selected.push(`${next.provider}/${next.id}`); },
				},
			});
			expect(selected).toEqual(["cursor/saved"]);
		}

		// The current session model, present in scope, is retained.
		{
			const modelRegistry = buildRegistry();
			const selected: string[] = [];
			await recoverCursorModelScopeAfterExtensionStartup({
				patterns: ["cursor/first", "cursor/saved"],
				modelRegistry,
				mode: "print",
				selectInitialModel: true,
				currentModel: model("cursor", "saved"),
				savedProvider: "cursor",
				savedModelId: "first",
				session: {
					async discoverExtensionModels() {},
					setScopedModels() {},
					async setModel(next) { selected.push(`${next.provider}/${next.id}`); },
				},
			});
			expect(selected).toEqual(["cursor/saved"]);
		}

		// An omitted saved default falls back to scopedModels[0].
		{
			const modelRegistry = buildRegistry();
			const selected: string[] = [];
			await recoverCursorModelScopeAfterExtensionStartup({
				patterns: ["cursor/first", "cursor/saved"],
				modelRegistry,
				mode: "print",
				selectInitialModel: true,
				session: {
					async discoverExtensionModels() {},
					setScopedModels() {},
					async setModel(next) { selected.push(`${next.provider}/${next.id}`); },
				},
			});
			expect(selected).toEqual(["cursor/first"]);
		}
	});

	test("a blank saved default id ('') is honored as present and selects the matching scoped row", async () => {
		const modelRegistry = ModelRegistry.inMemory(AuthStorage.inMemory());
		registerTrustedCursorProvider(modelRegistry, {
			baseUrl: "https://api2.cursor.sh",
			apiKey: "test",
			api: "cursor-agent",
			models: [model("cursor", "first"), model("cursor", "")],
		});
		const selected: string[] = [];
		await recoverCursorModelScopeAfterExtensionStartup({
			patterns: ["cursor/first", "cursor/"],
			modelRegistry,
			mode: "print",
			selectInitialModel: true,
			savedProvider: "cursor",
			savedModelId: "",
			session: {
				async discoverExtensionModels() {},
				setScopedModels() {},
				async setModel(next) { selected.push(`${next.provider}/${next.id}`); },
			},
		});
		expect(selected).toEqual(["cursor/"]);
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
					registerTrustedCursorProvider(modelRegistry, {
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
					registerTrustedCursorProvider(modelRegistry, {
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
	test("preserves --models Cursor bytes through authenticated scope recovery", async () => {
		const parsed = parseArgs([
			"--models",
			"cursor/   , cursor/route,CURSOR/route,cursor/literal:high,cursor/route (1m), openai/composer-2 ",
		]);
		expect(parsed.models).toEqual([
			"cursor/   ",
			" cursor/route",
			"CURSOR/route",
			"cursor/literal:high",
			"cursor/route (1m)",
			"openai/composer-2",
		]);
		const modelRegistry = registry();
		let discoveries = 0;
		const result = await recoverCursorModelScopeAfterExtensionStartup({
			patterns: parsed.models!,
			modelRegistry,
			mode: "print",
			selectInitialModel: false,
			session: {
				async discoverExtensionModels() {
					discoveries += 1;
					registerTrustedCursorProvider(modelRegistry, {
						baseUrl: "https://api2.cursor.sh",
						apiKey: "test",
						api: "cursor-agent",
						models: [model("cursor", "   "), model("cursor", "literal:high"), model("cursor", "route (1m)")],
					});
				},
				setScopedModels() {},
				async setModel() {},
			},
		});
		expect(discoveries).toBe(1);
		expect(result?.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)).toEqual([
			"cursor/   ",
			"cursor/literal:high",
			"cursor/route (1m)",
			"openai/composer-2",
		]);
	});


	test("does not trigger Cursor discovery for normalized provider qualifier bytes", async () => {
		for (const pattern of ["CURSOR/literal-route", "CuRsOr/literal-route", " cursor/literal-route", "cursor /literal-route"]) {
			let discoveries = 0;
			const result = await recoverCursorModelScopeAfterExtensionStartup({
				patterns: [pattern],
				modelRegistry: registry(),
				mode: "print",
				selectInitialModel: true,
				session: {
					async discoverExtensionModels() { discoveries += 1; },
					setScopedModels() {},
					async setModel() {},
				},
			});
			expect(result, pattern).toBeUndefined();
			expect(discoveries, pattern).toBe(0);
		}
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
