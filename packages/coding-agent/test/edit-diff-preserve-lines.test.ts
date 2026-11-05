import { describe, expect, it } from "vitest";
import {
	applyEditsToNormalizedContent,
	applyReplacementsPreservingUnchangedLines,
} from "../src/core/tools/edit-diff.ts";

describe("fuzzy edits keep untouched lines byte for byte", () => {
	it("keeps trailing whitespace on untouched lines before and after the edit", () => {
		const original = "keep  \nalso\t\nfoo \u201cbar\u201d\nafter  \nend";
		const { newContent } = applyEditsToNormalizedContent(
			original,
			[{ oldText: 'foo "bar"', newText: 'foo "baz"' }],
			"f",
		);
		expect(newContent).toBe('keep  \nalso\t\nfoo "baz"\nafter  \nend');
	});

	it("keeps a final line without a newline", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"foo \u201cbar\u201d\nlast",
			[{ oldText: 'foo "bar"', newText: "x" }],
			"f",
		);
		expect(newContent).toBe("x\nlast");
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
		expect(newContent).toBe("A B\nkeep  \n");
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
		expect(newContent).toBe("1\nmiddle  \n2\n");
	});

	it("orders replacements itself when given out of order", () => {
		const base = "aa\nbb\ncc\n";
		const result = applyReplacementsPreservingUnchangedLines("aa \nbb \ncc \n", base, [
			{ matchIndex: 6, matchLength: 2, newText: "CC" },
			{ matchIndex: 0, matchLength: 2, newText: "AA" },
		]);
		expect(result).toBe("AA\nbb \nCC\n");
	});

	it("widens a replacement that spans lines to every line it touches", () => {
		const result = applyReplacementsPreservingUnchangedLines("x \naa \nbb \ny \n", "x\naa\nbb\ny\n", [
			{ matchIndex: 2, matchLength: 5, newText: "AB" },
		]);
		expect(result).toBe("x \nAB\ny \n");
	});
});
