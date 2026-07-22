import { test } from "bun:test";
import assert from "node:assert/strict";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRegistry } from "../../packages/coding-agent/src/core/model-registry.js";
import { attachProviderModelReference, getProviderModelReference, providerModelsAreExactlyEqual } from "../../packages/coding-agent/src/core/provider-model-reference.js";

test("dynamic provider models carry typed references through ordinary host copies", () => {
	const registry = ModelRegistry.create(AuthStorage.inMemory(), []);
	const reference = {
		provider: "cursor",
		schemaVersion: 1,
		data: { accountScope: "cursor-account-v1:scope", routeId: " A ", maxMode: false, occurrence: 2, catalogGeneration: 4 },
	};
	registry.registerProvider("cursor", {
		name: "Cursor",
		baseUrl: "https://api2.cursor.sh",
		api: "cursor-agent",
		apiKey: "test-only-key",
		models: [{
			id: " A ",
			name: "A occurrence 2",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			providerReference: reference,
		}],
	});
	const model = registry.getAll().find((candidate) => candidate.provider === "cursor");
	assert.ok(model);
	assert.deepEqual(getProviderModelReference(model), reference);
	assert.deepEqual(getProviderModelReference({ ...model, contextWindow: 100_000 }), reference);
	assert.equal(JSON.stringify(model).includes("accountScope"), false);
});

test("exact equality honors the provider selection matcher and ignores harmless same-version metadata", () => {
	const base = { version: 1, provider: "cursor", accountScope: "cursor-account-v1:scope", routeId: "A", maxMode: "false", occurrence: 1 };
	const matchesSelection = (value: unknown): boolean => {
		if (typeof value !== "object" || value === null) return false;
		const record = value as Record<string, unknown>;
		return record.version === 1 && record.provider === "cursor" && record.accountScope === base.accountScope &&
			record.routeId === "A" && record.maxMode === "false" && record.occurrence === 1;
	};
	const reference = (selection: object) => ({ provider: "cursor", schemaVersion: 1, data: { routeId: "A", occurrence: 1 }, selection, matchesSelection });
	const left = attachProviderModelReference({ provider: "cursor", id: "A" }, reference(base));
	const right = attachProviderModelReference({ provider: "cursor", id: "A" }, reference({ ...base, extra: "ignored", legacy: 7 }));
	assert.equal(providerModelsAreExactlyEqual(left, right), true);
	const mismatched = attachProviderModelReference({ provider: "cursor", id: "A" }, reference({ ...base, occurrence: 2 }));
	assert.equal(providerModelsAreExactlyEqual(left, mismatched), false);
});

test("exact equality falls back to stable identity when transient selectors rotate", () => {
	const reference = (transportToken: string, stableRoute: string) => ({
		provider: "cursor",
		schemaVersion: 1,
		data: { transportToken },
		transportSelection: { version: 1, transportToken },
		selection: { version: 1, stableRoute },
		matchesTransportSelection: (value: unknown) =>
			typeof value === "object" && value !== null &&
			(value as { transportToken?: unknown }).transportToken === transportToken,
		matchesSelection: (value: unknown) =>
			typeof value === "object" && value !== null &&
			(value as { stableRoute?: unknown }).stableRoute === stableRoute,
	});
	const current = attachProviderModelReference({ provider: "cursor", id: "same" }, reference("old", "stable"));
	const refreshed = attachProviderModelReference({ provider: "cursor", id: "same" }, reference("new", "stable"));
	const different = attachProviderModelReference({ provider: "cursor", id: "same" }, reference("newer", "other"));

	assert.equal(providerModelsAreExactlyEqual(current, refreshed), true);
	assert.equal([refreshed].find((candidate) => providerModelsAreExactlyEqual(candidate, current)), refreshed);
	assert.equal(providerModelsAreExactlyEqual(current, different), false);
});
