import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	getPersistedProviderSelection,
	getProviderModelReference,
	providerModelsAreExactlyEqual,
	type ProviderModelReference,
	type ProviderRefreshModelsContext,
} from "@bastani/atomic";

test("package root exports provider-owned exact model reference APIs", () => {
	assert.equal(typeof getProviderModelReference, "function");
	assert.equal(typeof getPersistedProviderSelection, "function");
	assert.equal(typeof providerModelsAreExactlyEqual, "function");
	assert.equal(getProviderModelReference({}), undefined);
	assert.equal(getPersistedProviderSelection({}), undefined);
	assert.equal(
		providerModelsAreExactlyEqual(
			{ provider: "ordinary", id: "same" },
			{ provider: "ordinary", id: "same" },
		),
		true,
	);
});

function assertPublicProviderTypes(
	reference: ProviderModelReference,
	context: ProviderRefreshModelsContext,
): void {
	assert.equal(typeof reference.provider, "string");
	assert.equal(typeof context.credentialGeneration, "number");
}

void assertPublicProviderTypes;
