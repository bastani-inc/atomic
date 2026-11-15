import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.js";

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

	it("keeps the rest of a line that two fuzzy edits touch (#4893)", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"a \u201cx\u201d b \u201cy\u201d  \nkeep  \n",
			[
				{ oldText: 'b "y"', newText: "B" },
				{ oldText: 'a "x"', newText: "A" },
			],
			"f",
		);
		assert.equal(newContent, "A B  \nkeep  \n");
	});

	it("keeps trailing whitespace after fuzzy edits on separate lines (#4893)", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"\u201cone\u201d  \nmiddle  \n\u201ctwo\u201d  \n",
			[
				{ oldText: '"one"', newText: "1" },
				{ oldText: '"two"', newText: "2" },
			],
			"f",
		);
		assert.equal(newContent, "1  \nmiddle  \n2  \n");
	});

	it("preserves a length-changing Unicode normalization on the final line (#4328)", () => {
		const { newContent } = applyEditsToNormalizedContent(
			"keep  \n\ufb00 tail",
			[{ oldText: "ff", newText: "FF" }],
			"f",
		);
		assert.equal(newContent, "keep  \nFF tail");
	});
});
