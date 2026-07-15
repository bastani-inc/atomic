import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { recoverCursorCliModelAfterExtensionStartup, recoverUnresolvedCursorCliModel, type CursorStartupRecoveryRuntime } from "../../packages/coding-agent/src/main-cursor-model-recovery.js";
import type { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";

function cursorModel(id: string): Model<Api> {
	return {
		provider: "cursor",
		id,
		name: id,
		api: "cursor-agent",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as Model<Api>;
}

function reselectionError(reference: string): { readonly type: "error"; readonly message: string } {
	return {
		type: "error",
		message: `Model "${reference}" not found. Cursor model IDs changed; reselect an exact model with --list-models.`,
	};
}

test("retries an unresolved authenticated Cursor CLI row after blocking discovery", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected: Model<Api> | undefined;
	let contextWindow: number | undefined;
	let discoveries = 0;
	const notFound = 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.';
	const warning = { type: "warning" as const, message: "keep me" };

	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "Cursor/composer-2.5-fast",
		cliContextWindow: 1_000_000,
		diagnostics: [{ type: "error", message: notFound }, warning],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: (value) => { contextWindow = value; },
		},
		discoverModels: async () => {
			discoveries += 1;
			models = [cursorModel("default"), cursorModel("composer-2.5-fast")];
		},
	});

	assert.equal(discoveries, 1);
	assert.equal(selected?.id, "composer-2.5-fast");
	assert.equal(contextWindow, 1_000_000);
	assert.deepEqual(diagnostics, [warning]);
});

test("drops a stale unknown-provider diagnostic when discovery already raced ahead", async () => {
	const exact = cursorModel("gpt-5.2");
	const registry = { getAll: () => [exact] } as ModelRegistry;
	let selected: Model<Api> | undefined;
	const warning = { type: "warning" as const, message: "keep me" };
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "gpt-5.2",
		diagnostics: [
			{ type: "error", message: 'Unknown provider "cursor". Use --list-models to see available providers/models.' },
			warning,
		],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, exact);
	assert.deepEqual(diagnostics, [warning]);
});

test("drops a stale breaking-ID diagnostic when a provider-scoped exact route is current", async () => {
	const exact = cursorModel("gpt-5.2");
	let selected: Model<Api> | undefined;
	const stale = reselectionError("cursor/gpt-5.2");
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "gpt-5.2",
		diagnostics: [stale],
		modelRegistry: { getAll: () => [exact] },
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, exact);
	assert.deepEqual(diagnostics, []);
});

test("preserves the fatal diagnostic when authenticated discovery cannot resolve the exact row", async () => {
	const registry = { getAll: () => [cursorModel("default")] } as ModelRegistry;
	const error = { type: "error" as const, message: 'Model "cursor/missing" not found. Use --list-models to see available models.' };
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/missing",
		diagnostics: [error],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => undefined,
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/missing")]);
});

test("recovers a valid model with a case-insensitive --provider Cursor flag", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected: Model<Api> | undefined;
	const error = { type: "error" as const, message: 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.' };
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "Cursor",
		cliModel: "cursor/composer-2.5-fast",
		diagnostics: [error],
		modelRegistry: registry,
		session: {
			setModel: async (model) => { selected = model; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => {
			models = [cursorModel("default"), cursorModel("composer-2.5-fast")];
		},
	});
	assert.equal(selected?.id, "composer-2.5-fast");
	assert.deepEqual(diagnostics, []);
});

test("does not recover a fuzzy or similar Cursor model ID", async () => {
	let models = [cursorModel("default"), cursorModel("gpt-5.2-codex-fast")];
	const registry = { getAll: () => models } as ModelRegistry;
	const error = reselectionError("cursor/gpt-5.2-cod");
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "Cursor",
		cliModel: "gpt-5.2-cod",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => {
			models = [cursorModel("default"), cursorModel("gpt-5.2-codex-fast")];
		},
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [error]);
});

test("rejects an exact compatibility-only Cursor ID absent from authenticated discovery", async () => {
	let models = [cursorModel("claude-4-sonnet-thinking")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "cursor",
		cliModel: "claude-4-sonnet-thinking",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => { models = [cursorModel("default")]; },
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/claude-4-sonnet-thinking")]);
});

test("does not recover a case-normalized Cursor route ID", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliProvider: "Cursor",
		cliModel: "CURSOR-GROK-4.5-HIGH",
		diagnostics: [],
		modelRegistry: registry,
		session: {
			setModel: async () => { selected = true; },
			setContextWindow: () => undefined,
		},
		discoverModels: async () => { models = [cursorModel("cursor-grok-4.5-high")]; },
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/CURSOR-GROK-4.5-HIGH")]);
});

test("reports an invalid deferred context window as a startup diagnostic", async () => {
	let models = [cursorModel("default")];
	const registry = { getAll: () => models } as ModelRegistry;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "cursor/composer-2.5-fast",
		cliContextWindow: 12_345,
		diagnostics: [{ type: "error", message: 'Model "cursor/composer-2.5-fast" not found. Use --list-models to see available models.' }],
		modelRegistry: registry,
		session: {
			setModel: async () => undefined,
			setContextWindow: () => { throw new Error("Context window 12345 is not supported by cursor/composer-2.5-fast."); },
		},
		discoverModels: async () => { models = [cursorModel("default"), cursorModel("composer-2.5-fast")]; },
	});
	assert.deepEqual(diagnostics, [{ type: "error", message: "Context window 12345 is not supported by cursor/composer-2.5-fast." }]);
});

test("bare legacy ID waits for discovery and selects only a current exact Cursor row", async () => {
	const other = { ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" } as Model<Api>;
	let models = [other];
	let selected: Model<Api> | undefined;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "composer-2", diagnostics: [], modelRegistry: { getAll: () => models },
		session: { setModel: async (model) => { selected = model; }, setContextWindow: () => undefined },
		discoverModels: async () => { models = [other, cursorModel("composer-2")]; },
	});
	assert.equal(selected?.provider, "cursor");
	assert.deepEqual(diagnostics, []);
});

test("bare legacy ID cannot fall back when discovery does not return it", async () => {
	const other = { ...cursorModel("composer-2"), provider: "openai", api: "openai-responses" } as Model<Api>;
	let selected = false;
	const diagnostics = await recoverUnresolvedCursorCliModel({
		cliModel: "composer-2", diagnostics: [], modelRegistry: { getAll: () => [other] },
		session: { setModel: async () => { selected = true; }, setContextWindow: () => undefined },
		discoverModels: async () => undefined,
	});
	assert.equal(selected, false);
	assert.deepEqual(diagnostics, [reselectionError("cursor/composer-2")]);
});

test("persisted Cursor reselection failures are fatal in every CLI startup mode", async () => {
	const message = "Could not restore Cursor model cursor/old-route. Cursor model IDs changed; reselect an exact model with --list-models.";
	const runtime = {
		modelFallbackMessage: message,
		diagnostics: [],
		services: { modelRegistry: { getAll: () => [] } },
		session: {
			setModel: async () => undefined,
			setContextWindow: () => undefined,
			discoverExtensionModels: async () => undefined,
		},
	} satisfies CursorStartupRecoveryRuntime;
	for (const mode of ["interactive", "print", "json", "rpc"] as const) {
		const diagnostics = await recoverCursorCliModelAfterExtensionStartup({}, runtime, mode);
		assert.deepEqual(diagnostics, [{ type: "error", message }]);
	}
});
