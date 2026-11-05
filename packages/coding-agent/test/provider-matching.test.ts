import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { findMatchingProviders } from "../src/core/provider-matching.js";

const providers = [
	{ id: "first", name: "Shared Name", authType: "oauth" },
	{ id: "first", name: "Shared Name", authType: "api_key" },
	{ id: "other", name: "FIRST", authType: "api_key" },
	{ id: "second", name: "Second Provider", authType: "oauth" },
];

describe("provider reference matching", () => {
	test("matches IDs and display names case-insensitively with surrounding whitespace", () => {
		assert.deepEqual(findMatchingProviders(providers, "  sEcOnD  "), [providers[3]]);
		assert.deepEqual(findMatchingProviders(providers, "\tSECOND PROVIDER\n"), [providers[3]]);
		assert.deepEqual(findMatchingProviders([{ id: "MixedCase", name: "x" }], "mixedcase"), [
			{ id: "MixedCase", name: "x" },
		]);
	});

	test("keeps all matching providers and auth methods in input order", () => {
		const matched = findMatchingProviders(providers, "first");
		assert.deepEqual(matched, providers.slice(0, 3));
		assert.equal(matched[0], providers[0]);
		assert.equal(matched[1]?.authType, "api_key");
		assert.deepEqual(findMatchingProviders(providers, "shared name"), providers.slice(0, 2));
	});

	test("does not fuzzy-match unknown or partial references", () => {
		assert.deepEqual(findMatchingProviders(providers, "unknown"), []);
		assert.deepEqual(findMatchingProviders(providers, "sec"), []);
		assert.deepEqual(findMatchingProviders([], "first"), []);
	});

	test("never matches an empty reference, even against empty display names", () => {
		assert.deepEqual(findMatchingProviders([{ id: "unnamed", name: "" }], ""), []);
		assert.deepEqual(findMatchingProviders([{ id: "", name: "" }], " \t "), []);
		assert.deepEqual(findMatchingProviders(providers, " \t "), []);
	});
});
