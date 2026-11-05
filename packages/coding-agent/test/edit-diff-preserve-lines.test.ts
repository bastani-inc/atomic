import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	applyReplacementsPreservingUnchangedLines,
} from "../src/core/tools/edit-diff.js";

describe("fuzzy edits keep untouched lines byte for byte", () => {
	it("keeps trailing whitespace on untouched lines before and after the edit", () => {
		const original = "keep  \nalso\t\nfoo \u201cbar\u201d\nafter  \nend";
		const { newContent } = applyEditsToNormalizedContent(
			original,
			[{ oldText: 'foo "bar"', newText: 'foo "baz"' }],
			"f",
		);
		assert.equal(newContent, 'keep  \nalso\t\nfoo "baz"\nafter  \nend');
	});

	it("keeps a final line without a newline", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"foo \u201cbar\u201d\nlast",
			[{ oldText: 'foo "bar"', newText: "x" }],
			"f",
		);
		assert.equal(newContent, "x\nlast");
	});

	it("merges two edits on the same line into one rewrite", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"a \u201cx\u201d b \u201cy\u201d  \nkeep  \n",
			[
				{ oldText: 'b "y"', newText: "B" },
				{ oldText: 'a "x"', newText: "A" },
			],
			"f",
		);
		assert.equal(newContent, "A B\nkeep  \n");
	});

	it("rewrites each touched line once when edits sit on separate lines", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"\u201cone\u201d  \nmiddle  \n\u201ctwo\u201d  \n",
			[
				{ oldText: '"one"', newText: "1" },
				{ oldText: '"two"', newText: "2" },
			],
			"f",
		);
		assert.equal(newContent, "1\nmiddle  \n2\n");
	});

	it("orders replacements itself when given out of order", () => {
		const base = "aa\nbb\ncc\n";
		const result = applyReplacementsPreservingUnchangedLines("aa \nbb \ncc \n", base, [
			{ matchIndex: 6, matchLength: 2, newText: "CC" },
			{ matchIndex: 0, matchLength: 2, newText: "AA" },
		]);
		assert.equal(result, "AA\nbb \nCC\n");
	});

	it("widens a replacement that spans lines to every line it touches", () => {
		const result = applyReplacementsPreservingUnchangedLines("x \naa \nbb \ny \n", "x\naa\nbb\ny\n", [
			{ matchIndex: 2, matchLength: 5, newText: "AB" },
		]);
		assert.equal(result, "x \nAB\ny \n");
	});

	it("preserves a length-changing Unicode normalization on the final line (#4328)", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"keep  \n\ufb00 tail",
			[{ oldText: "ff", newText: "FF" }],
			"f",
		);
		assert.equal(newContent, "keep  \nFF tail");
	});

	it("extends a shared rewrite to the end of a later multiline replacement (#4328)", () => {
		const result = applyReplacementsPreservingUnchangedLines("aa bb \ncc \nkeep \n", "aa bb\ncc\nkeep\n", [
			{ matchIndex: 0, matchLength: 2, newText: "AA" },
			{ matchIndex: 3, matchLength: 5, newText: "BC" },
		]);
		assert.equal(result, "AA BC\nkeep \n");
	});
});
