import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { type TruncationResult, truncateHead, truncateTail } from "../src/core/tools/truncate.js";

function outcome(result: TruncationResult) {
	return {
		content: result.content,
		truncated: result.truncated,
		truncatedBy: result.truncatedBy,
		outputLines: result.outputLines,
		outputBytes: result.outputBytes,
	};
}

describe.each([
	["truncateHead", truncateHead],
	["truncateTail", truncateTail],
] as const)("%s", (_name, truncate) => {
	it("does not report truncation when only the trailing newline exceeds the byte limit", () => {
		assert.deepEqual(outcome(truncate("abc\n", { maxBytes: 3 })), {
			content: "abc",
			truncated: false,
			truncatedBy: null,
			outputLines: 1,
			outputBytes: 3,
		});
		assert.deepEqual(outcome(truncate("a\nb\n", { maxBytes: 3 })), {
			content: "a\nb",
			truncated: false,
			truncatedBy: null,
			outputLines: 2,
			outputBytes: 3,
		});
	});

	it("does not report truncation without a line limit when only the trailing newline exceeds the byte limit", () => {
		const result = truncate("ab\ncd\n", { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: 5 });
		assert.equal(result.truncated, false);
		assert.equal(result.truncatedBy, null);
		assert.equal(result.content, "ab\ncd");
	});

	it("keeps content untouched when it fits including its trailing newline", () => {
		assert.deepEqual(outcome(truncate("abc\n", { maxBytes: 4 })), {
			content: "abc\n",
			truncated: false,
			truncatedBy: null,
			outputLines: 1,
			outputBytes: 4,
		});
	});

	it("reports the line limit when only lines were cut", () => {
		const result = truncate("a\nb\nc\n", { maxLines: 2 });
		assert.equal(result.truncated, true);
		assert.equal(result.truncatedBy, "lines");
		assert.equal(result.outputLines, 2);
	});

	it("reports the byte limit when a line one byte past the limit is cut", () => {
		const result = truncate("ab\nc\n", { maxBytes: 3 });
		assert.equal(result.truncated, true);
		assert.equal(result.truncatedBy, "bytes");
		assert.equal(result.outputLines, 1);
	});
});

describe("truncateTail", () => {
	it("reports the byte limit when the only kept line is cut to fit, even at the line limit", () => {
		const result = truncateTail("aaaaa", { maxLines: 1, maxBytes: 3 });
		assert.equal(result.content, "aaa");
		assert.equal(result.lastLinePartial, true);
		assert.equal(result.truncated, true);
		assert.equal(result.truncatedBy, "bytes");
	});
});
