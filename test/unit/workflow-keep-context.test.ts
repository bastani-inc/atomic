import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { validateDeletedRanges } from "../../packages/coding-agent/src/core/compaction/deleted-ranges.js";
import { createNumberedRegion } from "../../packages/coding-agent/src/core/compaction/transcript-serialization.js";
import { keepContext } from "../../packages/workflows/src/authoring/keep-context.js";

/**
 * The helper is only worth anything if what it emits is what compaction protects. These assert
 * the round trip rather than the string shape, so a change to either side fails here.
 */
describe("keepContext authoring primitive", () => {
	test("wraps text in the tags compaction protects", () => {
		assert.equal(keepContext("Research only."), "<keepContext>\nResearch only.\n</keepContext>");
	});

	test("trims surrounding whitespace so the tags own their own lines", () => {
		assert.equal(keepContext("\n  Research only.  \n"), "<keepContext>\nResearch only.\n</keepContext>");
	});

	test("is idempotent so composing already-wrapped text does not nest", () => {
		const once = keepContext("Do not implement.");
		assert.equal(keepContext(once), once);
	});

	test("preserves internal line structure", () => {
		assert.equal(keepContext("first\nsecond"), "<keepContext>\nfirst\nsecond\n</keepContext>");
	});

	test("every emitted line is protected by compaction", () => {
		const prompt = `noise before\n${keepContext("Research only.\nDo not implement code changes.")}\nnoise after`;
		const region = createNumberedRegion(prompt);

		assert.deepEqual(
			[...(region.protectedLineNumbers ?? [])].sort((a, b) => a - b),
			[2, 3, 4, 5],
		);
	});

	test("a whole-region deletion request cannot remove the wrapped span", () => {
		const prompt = `noise before\n${keepContext("Do not implement code changes.")}\nnoise after`;
		const region = createNumberedRegion(prompt);

		const ranges = [...validateDeletedRanges([{ start: 1, end: region.lines.length }], region)];

		assert.deepEqual(ranges, [
			{ start: 1, end: 1 },
			{ start: 5, end: 5 },
		]);
	});
});
