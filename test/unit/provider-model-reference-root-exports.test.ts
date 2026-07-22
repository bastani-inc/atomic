import { test } from "bun:test";
import assert from "node:assert/strict";
import {
	getPersistedProviderSelection,
	getProviderModelReference,
	getProviderTransportSelection,
	providerModelsAreExactlyEqual,
	type ProviderModelReference,
	type ProviderRefreshModelsContext,
	type RpcModel,
} from "@bastani/atomic";

test("package root exports provider-owned exact model reference APIs", () => {
	assert.equal(typeof getProviderModelReference, "function");
	assert.equal(typeof getPersistedProviderSelection, "function");
	assert.equal(typeof getProviderTransportSelection, "function");
	assert.equal(typeof providerModelsAreExactlyEqual, "function");
	assert.equal(getProviderModelReference({}), undefined);
	assert.equal(getPersistedProviderSelection({}), undefined);
	assert.equal(getProviderTransportSelection({}), undefined);
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
	model: RpcModel,
): void {
	assert.equal(typeof reference.provider, "string");
	assert.equal(typeof context.credentialGeneration, "number");
	assert.equal(typeof model.provider, "string");
}

void assertPublicProviderTypes;
