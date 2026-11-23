import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, getGraphemeCellRange, sliceByColumn, sliceWithWidth } from "../src/utils.ts";

// https://github.com/earendil-works/pi/issues/10169
describe("sliceByColumn ANSI order regression", () => {
	it("keeps a reset at the slice start after earlier style codes", () => {
		const line = "\x1b[32mfoo\x1b[39m bar";
		assert.strictEqual(sliceByColumn(line, 3, 4, true), "\x1b[32m\x1b[39m bar");
	});

	it("does not leak color into text after a highlighted token", () => {
		const line = "Another \x1b[35malpha\x1b[39m line with \x1b[35mbeta\x1b[39m later.";
		const after = sliceByColumn(line, 13, 100, true);
		assert.strictEqual(after, "\x1b[35m\x1b[39m line with \x1b[35mbeta\x1b[39m later.");
	});

	it("matches segmenter behavior across printable ASCII, ANSI styles, overlap bounds, and Unicode", () => {
		const styled = "\x1b[48;5;236m\x1b[36mconst x = 42;\x1b[39m // comment\x1b[0m";
		assert.deepStrictEqual(sliceWithWidth(styled, 0, 5, true), {
			text: "\x1b[48;5;236m\x1b[36mconst",
			width: 5,
		});
		assert.deepStrictEqual(sliceWithWidth(styled, 6, 7, true), {
			text: "\x1b[48;5;236m\x1b[36mx = 42;",
			width: 7,
		});
		assert.deepStrictEqual(sliceWithWidth(styled, 50, 5, true), { text: "", width: 0 });
		assert.deepStrictEqual(getGraphemeCellRange(styled, 0), { start: 0, end: 1 });
		assert.deepStrictEqual(getGraphemeCellRange(styled, 23), { start: 23, end: 24 });
		assert.strictEqual(getGraphemeCellRange(styled, 24), undefined);
		// Wide CJK & combining marks still use grapheme ranges
		assert.deepStrictEqual(getGraphemeCellRange("ab中cd", 2), { start: 2, end: 4 });
		assert.deepStrictEqual(getGraphemeCellRange("ab中cd", 3), { start: 2, end: 4 });
		assert.deepStrictEqual(getGraphemeCellRange("e\u0301x", 0), { start: 0, end: 1 });

		// extractSegments normal and overlapping (beforeEnd > afterStart)
		assert.deepStrictEqual(extractSegments("\x1b[31mhello world\x1b[0m", 5, 8, 3, true), {
			before: "\x1b[31mhello",
			beforeWidth: 5,
			after: "\x1b[31mrld",
			afterWidth: 3,
		});
		assert.deepStrictEqual(extractSegments("\x1b[31mabcdef\x1b[0m", 4, 2, 4, true), {
			before: "\x1b[31mabcd",
			beforeWidth: 4,
			after: "\x1b[31mef",
			afterWidth: 2,
		});
		// When afterLen > 0 and beforeEnd > afterEnd, stops at afterEnd just like the grapheme path.
		assert.deepStrictEqual(extractSegments("\x1b[31mhello\x1b[0m", 9, 1, 1, false), {
			before: "\x1b[31mhe",
			beforeWidth: 2,
			after: "",
			afterWidth: 0,
		});
	});
});
