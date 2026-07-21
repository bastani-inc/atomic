import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { Args } from "../../packages/coding-agent/src/cli/args.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { prepareExplicitCliModel, resolveCliModel } from "../../packages/coding-agent/src/core/model-resolver-cli.js";
import { resolveModelScopeWithDiagnostics } from "../../packages/coding-agent/src/core/model-resolver-scope.js";
import { validateSelectedProviderModel } from "../../packages/coding-agent/src/core/model-registry-selection.js";
import { findPreferredAvailableModel } from "../../packages/coding-agent/src/core/model-resolver-defaults.js";
import { resolveAvailableProviderModel } from "../../packages/coding-agent/src/core/model-registry-available-selection.js";
import { persistProviderModelDefault } from "../../packages/coding-agent/src/core/provider-model-default.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { buildSessionOptions } from "../../packages/coding-agent/src/main-session-options.js";
import {
	getPersistedProviderSelection,
	PROVIDER_MODEL_REFERENCE,
	ProviderModelSelectionError,
	providerModelsAreExactlyEqual,
} from "../../packages/coding-agent/src/core/provider-model-reference.js";
import { mapCursorCatalogToProviderModels } from "../../packages/cursor/src/model-mapper.js";
import { CursorError } from "../../packages/cursor/src/errors.js";

function registryWithRows(rows = [
	{ modelId: "A", maxMode: false },
	{ modelId: "B", maxMode: false },
	{ modelId: "A", maxMode: false },
	{ modelId: "A", maxMode: true },
]) {
	const registry = ModelRegistry.create(AuthStorage.inMemory({ cursor: { type: "oauth", access: "stored", refresh: "stored", expires: Date.now() + 10_000 } }), []);
	registry.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://api2.cursor.sh",
		api: "cursor-agent",
		apiKey: "test-only",
		requiresExactSelectionPersistence: true,
		models: mapCursorCatalogToProviderModels({
			accountScope: "cursor-account-v1:scope",
			clientVersion: "client-v1",
			fetchedAt: 1,
			catalogGeneration: 3,
			rows,
		}),
	});
	return registry;
}

describe("Cursor host exact selection", () => {
	test("explicit Cursor CLI resolution prepares and surfaces missing host OAuth", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("cursor", {
			name: "Cursor", baseUrl: "https://api2.cursor.sh", api: "cursor-agent", models: [],
			requiresPreparation: true, requiresExactSelectionPersistence: true, requiresHostOAuth: true,
			refreshModels: async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); },
		});
		await assert.rejects(prepareExplicitCliModel({ cliProvider: "cursor", cliModel: "live", modelRegistry: registry }),
			(error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
		assert.equal(calls, 1);
	});

	test("explicit Cursor scope prepares before reading the catalog", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		let calls = 0;
		registry.registerProvider("cursor", {
			name: "Cursor", baseUrl: "https://api2.cursor.sh", api: "cursor-agent", models: [],
			requiresPreparation: true, requiresExactSelectionPersistence: true, requiresHostOAuth: true,
			refreshModels: async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); },
		});
		await assert.rejects(resolveModelScopeWithDiagnostics(["cursor/*"], registry),
			(error: Error) => error instanceof CursorError && error.code === "AuthenticationMissing");
		assert.equal(calls, 1);
	});

	test("keeps A/B/A occurrences distinct while public IDs remain verbatim", () => {
		const registry = registryWithRows();
		const models = registry.getAll().filter((model) => model.provider === "cursor");
		assert.deepEqual(models.map((model) => model.id), ["A", "B", "A", "A"]);
		assert.notDeepEqual(getPersistedProviderSelection(models[0]), getPersistedProviderSelection(models[2]));
		assert.equal(providerModelsAreExactlyEqual(models[0], models[2]), false);
		const displayOnly = { ...models[0] };
		delete (displayOnly as Record<PropertyKey, unknown>)[PROVIDER_MODEL_REFERENCE];
		assert.throws(() => validateSelectedProviderModel(displayOnly, registry), (error: Error) =>
			error instanceof ProviderModelSelectionError && error.code === "MissingSelection");
		assert.equal(providerModelsAreExactlyEqual(models[0], { ...models[0] }), true);
	});

	test("provider and model ID resolves unique exact and rejects duplicate ambiguity", () => {
		const registry = registryWithRows();
		assert.equal(registry.resolveExactModel("cursor", "B").id, "B");
		assert.throws(
			() => registry.resolveExactModel("cursor", "A"),
			(error: Error) => error instanceof ProviderModelSelectionError && error.code === "AmbiguousSelection",
		);
		assert.throws(
			() => registry.resolveExactModel("cursor", "missing"),
			(error: Error) => error instanceof ProviderModelSelectionError && error.code === "UnsupportedSelection",
		);
	});

	test("CLI exact selection never fuzzily chooses a Cursor occurrence", () => {
		const registry = registryWithRows();
		assert.equal(resolveCliModel({ cliProvider: "cursor", cliModel: "B", modelRegistry: registry }).model?.id, "B");
		assert.match(resolveCliModel({ cliProvider: "cursor", cliModel: "A", modelRegistry: registry }).error ?? "", /multiple|occurrences/iu);
		assert.match(resolveCliModel({ cliModel: "A", modelRegistry: registry }).error ?? "", /identities|occurrences/iu);
		assert.equal(resolveCliModel({ cliModel: "B", modelRegistry: registry }).model?.id, "B");
		assert.match(resolveCliModel({ cliProvider: "cursor", cliModel: "a", modelRegistry: registry }).error ?? "", /not in the current authoritative catalog/iu);
	});

	test("scoped globs retain every exact occurrence while literal duplicate scope is ambiguous", async () => {
		const registry = registryWithRows();
		const glob = await resolveModelScopeWithDiagnostics(["cursor/*"], registry);
		assert.deepEqual(glob.scopedModels.map((item) => item.model.id), ["A", "B", "A", "A"]);
		assert.equal(new Set(glob.scopedModels.map((item) => JSON.stringify(getPersistedProviderSelection(item.model)))).size, 4);
		const duplicate = await resolveModelScopeWithDiagnostics(["cursor/A"], registry);
		assert.deepEqual(duplicate.scopedModels, []);
		assert.match(duplicate.diagnostics[0]?.message ?? "", /occurrences/iu);
	});

	test("saved scoped defaults use exact selection identity and never first-match invalid records", () => {
		const registry = registryWithRows();
		const models = registry.getAll().filter((model) => model.provider === "cursor");
		const selected = models[2];
		assert.ok(selected);
		const settings = SettingsManager.inMemory();
		settings.setDefaultModelAndProvider("cursor", "A", getPersistedProviderSelection(selected));
		const scoped = models.map((model) => ({ model }));
		assert.equal(buildSessionOptions({} as Args, scoped, false, registry, settings).options.model, selected);
		settings.setDefaultModelAndProvider("cursor", "A", { version: 0 });
		const invalid = buildSessionOptions({} as Args, scoped, false, registry, settings);
		assert.equal(invalid.options.model, undefined);
		assert.equal(invalid.diagnostics[0]?.type, "error");
	});

	test("restores exact identity while ignoring harmless same-version metadata", () => {
		const registry = registryWithRows();
		const models = registry.getAll().filter((model) => model.provider === "cursor");
		const exact = getPersistedProviderSelection(models[2]);
		assert.ok(exact);
		assert.equal(registry.restoreExactModel("cursor", "A", exact), models[2]);
		const record = exact as Record<string, unknown>;
		for (const metadata of [{ note: "harmless" }, { legacyAlias: "ignored" }, { nested: { future: true } }]) {
			assert.equal(registry.restoreExactModel("cursor", "A", { ...record, ...metadata }), models[2]);
		}
		for (const mismatch of [
			{ ...record, accountScope: "cursor-account-v1:other" },
			{ ...record, routeId: "B" },
			{ ...record, version: 0 },
		]) assert.throws(() => registry.restoreExactModel("cursor", "A", mismatch), ProviderModelSelectionError);
		const { occurrence: _occurrence, ...missingOccurrence } = record;
		assert.throws(() => registry.restoreExactModel("cursor", "A", missingOccurrence), ProviderModelSelectionError);
		const occurrenceMissing = registryWithRows([{ modelId: "A", maxMode: false }]);
		assert.throws(() => occurrenceMissing.restoreExactModel("cursor", "A", exact), ProviderModelSelectionError);
		const maxMissing = registryWithRows([{ modelId: "A", maxMode: true }]);
		assert.throws(() => maxMissing.restoreExactModel("cursor", "A", exact), ProviderModelSelectionError);
		assert.throws(() => registry.restoreExactModel("cursor", "A", undefined), (error: Error) =>
			error instanceof ProviderModelSelectionError && error.code === "MissingSelection");
	});

	test("opaque routes are session-exact but never implicit, glob-selected, or persistable", async () => {
		const registry = registryWithRows([{ modelId: "runtime", maxMode: false }]);
		registry.registerProvider("cursor", {
			name: "Cursor", baseUrl: "https://api2.cursor.sh", api: "cursor-agent", apiKey: "test-only",
			requiresExactSelectionPersistence: true,
			models: mapCursorCatalogToProviderModels({
				accountScope: "cursor-runtime-v1:ephemeral", clientVersion: "client-v1", fetchedAt: 1,
				catalogGeneration: 4, selectionPersistence: false, rows: [{ modelId: "runtime", maxMode: false }],
			}),
		});
		const runtime = registry.resolveExactModel("cursor", "runtime");
		assert.equal(validateSelectedProviderModel(runtime, registry), runtime);
		assert.equal(findPreferredAvailableModel([runtime]), undefined);
		for (const selection of [undefined, { version: 1, provider: "cursor", accountScope: "old", routeId: "runtime", maxMode: "false", occurrence: 1 }]) {
			assert.throws(() => registry.restoreExactModel("cursor", "runtime", selection), (error: Error) =>
				error instanceof ProviderModelSelectionError && error.code === "PersistenceUnavailable");
		}
		const settings = SettingsManager.inMemory();
		assert.equal(persistProviderModelDefault(settings, registry, runtime), false);
		assert.equal(settings.getDefaultProvider(), undefined);
		assert.equal(settings.getDefaultModel(), undefined);
		assert.deepEqual((await resolveModelScopeWithDiagnostics(["cursor/*"], registry)).scopedModels, []);
	});

	test("provider-less exact resolution never case-folds or hijacks an ordinary same-ID model", async () => {
		const registry = registryWithRows([{ modelId: "Shared", maxMode: false }]);
		registry.registerProvider("ordinary", {
			name: "Ordinary", baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "test-only",
			models: [{ id: "Shared", name: "Shared", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }],
		});
		assert.match(resolveCliModel({ cliModel: "Shared", modelRegistry: registry }).error ?? "", /exact model identities/iu);
		assert.equal(resolveCliModel({ cliModel: "shared", modelRegistry: registry }).model?.provider, "ordinary");
		assert.match(resolveCliModel({ cliModel: "Cursor/Shared", modelRegistry: registry }).error ?? "", /not found/iu);
		const scope = await resolveModelScopeWithDiagnostics(["shared", "CURSOR/*"], registry);
		assert.equal(scope.scopedModels[0]?.model.provider, "ordinary");
		assert.equal(scope.scopedModels.some((item) => item.model.provider === "cursor"), false);
	});

	test("exact Cursor prefix and glob cannot be hijacked by an ordinary case-variant provider", async () => {
		const registry = registryWithRows([{ modelId: "exact-only", maxMode: false }]);
		registry.registerProvider("Cursor", {
			name: "Ordinary case variant", baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "test-only",
			models: [{ id: "ordinary-only", name: "Ordinary", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }],
		});
		const exactMiss = resolveCliModel({ cliModel: "cursor/ordinary-only", modelRegistry: registry });
		assert.equal(exactMiss.model, undefined);
		assert.match(exactMiss.error ?? "", /authoritative catalog/iu);
		assert.equal(resolveCliModel({ cliModel: "Cursor/ordinary-only", modelRegistry: registry }).model?.provider, "Cursor");
		const scope = await resolveModelScopeWithDiagnostics(["cursor/*"], registry);
		assert.deepEqual(scope.scopedModels.map(({ model }) => `${model.provider}/${model.id}`), ["cursor/exact-only"]);
	});

	test("authoritative-empty Cursor still owns exact CLI prefixes and qualified globs", async () => {
		const registry = registryWithRows([]);
		registry.registerProvider("Cursor", {
			name: "Ordinary case variant", baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "test-only",
			models: [{ id: "ordinary-only", name: "Ordinary", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }],
		});
		const exactMiss = resolveCliModel({ cliModel: "cursor/ordinary-only", modelRegistry: registry });
		assert.equal(exactMiss.model, undefined);
		assert.match(exactMiss.error ?? "", /authoritative catalog/iu);
		const scope = await resolveModelScopeWithDiagnostics(["cursor/*"], registry);
		assert.deepEqual(scope.scopedModels, []);
		assert.match(scope.diagnostics[0]?.message ?? "", /No models match/iu);
	});

	test("ordinary duplicate CLI, scope, and available RPC selection retain first-match behavior", async () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		const definition = { id: "same", name: "Same", reasoning: false, input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 };
		for (const provider of ["ordinary-a", "ordinary-b"]) registry.registerProvider(provider, {
			name: provider, baseUrl: "https://example.invalid", api: "openai-completions", apiKey: "test-only", models: [definition],
		});
		assert.equal(resolveCliModel({ cliModel: "same", modelRegistry: registry }).model?.provider, "ordinary-a");
		assert.equal((await resolveModelScopeWithDiagnostics(["same"], registry)).scopedModels[0]?.model.provider, "ordinary-a");
		const available = registry.getAvailable();
		assert.equal(resolveAvailableProviderModel(available, "ordinary-a", "same", false).provider, "ordinary-a");
		assert.throws(() => resolveAvailableProviderModel([], "ordinary-a", "same", false), ProviderModelSelectionError);
	});

	test("preserves ordinary non-Cursor provider plus model ID restoration", () => {
		const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
		registry.registerProvider("custom", {
			name: "Custom",
			baseUrl: "https://example.invalid",
			api: "openai-completions",
			apiKey: "test-only",
			models: [{ id: "same", name: "Same", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }],
		});
		assert.equal(registry.restoreExactModel("custom", "same", undefined).id, "same");
	});
});
