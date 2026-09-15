import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { resolveRunIdTarget } from "../../packages/workflows/src/shared/run-id.js";

describe("workflow UUID selectors", () => {
	const first = "2603abcd-1111-4222-8333-123456789abc";
	const second = "2603abcd-9999-4222-8333-123456789abc";

	test("resolves full UUIDs and unique 8-hex prefixes", () => {
		// Regression: #2603 — short selectors are allowed only at the fixed UUID prefix length.
		assert.deepEqual(resolveRunIdTarget(first, [first]), { kind: "exact", runId: first });
		assert.deepEqual(resolveRunIdTarget("2603ABCD", [first]), { kind: "unique_prefix", runId: first });
	});

	test("reports collisions, missing prefixes, and malformed truncations", () => {
		// Regression: #2603 — never pick the first run when an 8-hex prefix collides.
		const ambiguous = resolveRunIdTarget("2603abcd", [first, second]);
		assert.equal(ambiguous.kind, "ambiguous");
		if (ambiguous.kind === "ambiguous") {
			assert.deepEqual(ambiguous.matches, [first, second]);
			assert.match(ambiguous.message, /Use the full UUID/);
		}
		assert.deepEqual(resolveRunIdTarget("deadbeef", [first]), { kind: "not_found" });
		assert.equal(resolveRunIdTarget("2603abc", [first]).kind, "malformed");
		assert.equal(resolveRunIdTarget("2603abcg", [first]).kind, "malformed");
	});
});
