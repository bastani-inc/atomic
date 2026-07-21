import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { _trySwitchToFallbackModel } from "../../packages/coding-agent/src/core/agent-session-retry.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { findInitialModel, resolveRestoredModelReference, restoreModelFromSession } from "../../packages/coding-agent/src/core/model-resolver-initial.js";
import { getPersistedProviderSelection, ProviderModelSelectionError } from "../../packages/coding-agent/src/core/provider-model-reference.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { mapCursorCatalogToProviderModels } from "../../packages/cursor/src/model-mapper.js";
import { CursorError } from "../../packages/cursor/src/errors.js";

function fixture() {
	const auth = AuthStorage.inMemory({ cursor: { type: "oauth", access: "stored", refresh: "stored", expires: Date.now() + 10_000 } });
	const registry = ModelRegistry.create(auth, []);
	registry.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://api2.cursor.sh",
		api: "cursor-agent",
		apiKey: "test-only",
		requiresExactSelectionPersistence: true,
		requiresHostOAuth: true,
		models: mapCursorCatalogToProviderModels({
			accountScope: "cursor-account-v1:scope",
			clientVersion: "client-v1",
			fetchedAt: 1,
			catalogGeneration: 1,
			rows: [{ modelId: "A", maxMode: false }, { modelId: "A", maxMode: false }],
		}),
	});
	const models = registry.getAll().filter((model) => model.provider === "cursor");
	return { auth, registry, models };
}

function unpreparedFixture() {
	const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
	let calls = 0;
	registry.registerProvider("cursor", {
		name: "Cursor", baseUrl: "https://api2.cursor.sh", api: "cursor-agent", models: [],
		requiresPreparation: true, requiresExactSelectionPersistence: true, requiresHostOAuth: true,
		refreshModels: async () => { calls += 1; throw new CursorError("AuthenticationMissing", "Cursor host OAuth is required.", { operation: "authentication" }); },
	});
	return { registry, calls: () => calls };
}

describe("Cursor versioned selection persistence", () => {
	test("saved default and session references prepare before exact restoration", async () => {
		const selection = { version: 1, provider: "cursor", accountScope: "cursor-account-v1:saved", routeId: "A", maxMode: "false", occurrence: 1 };
		for (const restore of [
			(registry: ModelRegistry) => findInitialModel({ scopedModels: [], isContinuing: false, defaultProvider: "cursor", defaultModelId: "A", defaultModelSelection: selection, modelRegistry: registry }),
			(registry: ModelRegistry) => resolveRestoredModelReference("cursor", "A", registry, selection),
		]) {
			const fixture = unpreparedFixture();
			await assert.rejects(restore(fixture.registry), (error: Error) =>
				error instanceof CursorError && error.code === "AuthenticationMissing");
			assert.equal(fixture.calls(), 1);
		}
	});

	test("settings and session context persist the exact plain selection record", () => {
		const { models } = fixture();
		const selected = models[1];
		assert.ok(selected);
		const selection = getPersistedProviderSelection(selected);
		assert.ok(selection);
		const settings = SettingsManager.inMemory();
		settings.setDefaultModelAndProvider(selected.provider, selected.id, selection);
		assert.equal(settings.getDefaultProvider(), "cursor");
		assert.equal(settings.getDefaultModel(), "A");
		assert.deepEqual(settings.getDefaultModelSelection(), selection);

		const session = SessionManager.inMemory();
		session.appendModelChange(selected.provider, selected.id, selection);
		session.appendContextWindowChange(selected.contextWindow);
		assert.deepEqual(session.buildSessionContext().model, { provider: "cursor", modelId: "A", modelSelection: selection });

		settings.setDefaultModelAndProvider("openai", "gpt", undefined);
		assert.equal(settings.getDefaultModelSelection(), undefined);
	});

	test("defaults and session restoration resolve only the saved exact occurrence", async () => {
		const { registry, models } = fixture();
		const selected = models[1];
		assert.ok(selected);
		const selection = getPersistedProviderSelection(selected);
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "cursor",
			defaultModelId: "A",
			defaultModelSelection: selection,
			modelRegistry: registry,
		});
		assert.equal(initial.model, selected);
		assert.equal(await resolveRestoredModelReference("cursor", "A", registry, selection), selected);
		await assert.rejects(
			() => resolveRestoredModelReference("cursor", "A", registry),
			(error: Error) => error instanceof ProviderModelSelectionError && error.code === "MissingSelection",
		);
	});

	test("Cursor restore failure never falls back to current or another model", async () => {
		const { auth, registry, models } = fixture();
		const current = models[0];
		assert.ok(current);
		await assert.rejects(
			() => restoreModelFromSession("cursor", "A", current, false, registry, { version: 0 }),
			ProviderModelSelectionError,
		);
		const selection = getPersistedProviderSelection(current);
		auth.remove("cursor");
		await assert.rejects(
			() => restoreModelFromSession("cursor", "A", current, false, registry, selection),
			(error: Error) => error instanceof ProviderModelSelectionError && error.code === "AuthenticationMissing",
		);
		const switched = await _trySwitchToFallbackModel.call({
			_fallbackModels: ["openai/other"],
			model: current,
			_modelRegistry: registry,
		} as never, {} as never);
		assert.equal(switched, false);
	});
});
