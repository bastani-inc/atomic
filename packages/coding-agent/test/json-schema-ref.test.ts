import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveSchemaRef } from "../src/utils/json-schema-ref.js";

const item = { type: "string" };
const root = { $defs: { item, "a/b": item, "c~d": item, "e f": item } };

test("resolveSchemaRef resolves local references with escaped segments (earendil-works/pi#11803)", () => {
	assert.equal(resolveSchemaRef("#", root), root);
	assert.equal(resolveSchemaRef("#/$defs/item", root), item);
	assert.equal(resolveSchemaRef("#/$defs/a~1b", root), item);
	assert.equal(resolveSchemaRef("#/$defs/c~0d", root), item);
	assert.equal(resolveSchemaRef("#/$defs/e%20f", root), item);
});

test("resolveSchemaRef returns undefined for remote, missing and malformed references (earendil-works/pi#11803)", () => {
	assert.equal(resolveSchemaRef("other.json#/$defs/item", root), undefined);
	assert.equal(resolveSchemaRef("#/$defs/missing", root), undefined);
	assert.equal(resolveSchemaRef("#/$defs/%E0%A4%A", root), undefined);
});

test("resolveSchemaRef resolves array indexes and empty keys as JSON Pointers do", () => {
	const first = { type: "string" };
	const second = { type: "number" };
	const unnamed = { type: "boolean" };
	const schema = { anyOf: [first, second], $defs: { "": unnamed }, "": item };
	assert.equal(resolveSchemaRef("#/anyOf/1", schema), second);
	assert.equal(resolveSchemaRef("#/$defs/", schema), unnamed);
	assert.equal(resolveSchemaRef("#/", schema), item);
	for (const ref of ["#/anyOf/2", "#/anyOf/01"]) {
		assert.equal(resolveSchemaRef(ref, schema), undefined, ref);
	}
});
