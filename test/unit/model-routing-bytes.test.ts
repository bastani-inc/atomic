import assert from "node:assert/strict";
import { test } from "vitest";
import {
	jsonBytes,
	TRUNCATED_MARKER,
	truncateToBytes,
} from "../../packages/coding-agent/src/core/model-routing-bytes.js";

test("text that fits is returned verbatim", () => {
	assert.equal(truncateToBytes("| slug | Model |", jsonBytes("| slug | Model |")), "| slug | Model |");
});

for (const unit of ["a", "Ω", "界", "😀"]) {
	test(`cut evidence stays within the JSON byte budget without splitting ${JSON.stringify(unit)}`, () => {
		const text = unit.repeat(400);
		for (const budget of [40, 101, 257]) {
			const cut = truncateToBytes(text, budget);
			assert.ok(jsonBytes(cut) <= budget);
			assert.ok(cut.endsWith(TRUNCATED_MARKER));
			assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/u);
		}
	});
}

test("a budget below the marker yields empty text", () => {
	assert.equal(truncateToBytes("x".repeat(100), jsonBytes(TRUNCATED_MARKER) - 1), "");
});
