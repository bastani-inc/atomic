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
