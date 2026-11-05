import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sliceHead, sliceTail, truncateLine } from "../src/core/tools/truncate.ts";

const EMOJI = "\u{1F600}"; // two UTF-16 code units: \uD83D\uDE00

function hasLoneSurrogate(text: string): boolean {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

describe("surrogate-safe slicing (pi #11757)", () => {
	it("truncateLine does not cut an emoji in half at the limit", () => {
		const line = `${"a".repeat(499)}${EMOJI}tail`;
		const { text, wasTruncated } = truncateLine(line, 500);
		assert.equal(wasTruncated, true);
		assert.equal(text, `${"a".repeat(499)}... [truncated]`);
		assert.equal(hasLoneSurrogate(text), false);
	});

	it("truncateLine keeps an emoji that ends exactly at the limit", () => {
		const line = `${"a".repeat(498)}${EMOJI}tail`;
		assert.equal(truncateLine(line, 500).text, `${"a".repeat(498)}${EMOJI}... [truncated]`);
	});

	it("sliceHead and sliceTail never split a pair", () => {
		const text = `${EMOJI}x${EMOJI}`;
		for (let units = 0; units <= text.length + 1; units++) {
			const head = sliceHead(text, units);
			const tail = sliceTail(text, units);
			assert.equal(hasLoneSurrogate(head), false);
			assert.equal(hasLoneSurrogate(tail), false);
			assert.ok(text.startsWith(head));
			assert.ok(text.endsWith(tail));
			assert.ok(head.length >= Math.min(units, text.length) - 1);
			assert.ok(tail.length >= Math.min(units, text.length) - 1);
		}
	});

	it("sliceHead and sliceTail match slice on text without surrogates", () => {
		assert.equal(sliceHead("abcdef", 3), "abc");
		assert.equal(sliceTail("abcdef", 3), "def");
		assert.equal(sliceHead("abc", 10), "abc");
		assert.equal(sliceTail("abc", 10), "abc");
		assert.equal(sliceHead("abc", 0), "");
		assert.equal(sliceTail("abc", 0), "");
		assert.equal(sliceHead("abc", -2), "");
	});

	it("sliceHead keeps surrogates that do not form a pair across the cut", () => {
		assert.equal(sliceHead("ab\uDC00cd", 2), "ab");
		assert.equal(sliceHead("a\uDC00", 1), "a");
		assert.equal(sliceHead("ab\uD83Dxy", 3), "ab\uD83D");
		assert.equal(sliceHead("\uD83D\uD83D", 1), "\uD83D");
		assert.equal(sliceHead("\uD83D\uE000", 1), "\uD83D");
		assert.equal(sliceHead("\uE000\uDC00", 1), "\uE000");
	});

	it("sliceTail keeps surrogates that do not form a pair across the cut", () => {
		assert.equal(sliceTail("ab\uDC00cd", 3), "\uDC00cd");
		assert.equal(sliceTail("a\uDC00", 1), "\uDC00");
		assert.equal(sliceTail("\uD83Dxyz", 3), "xyz");
		assert.equal(sliceTail("\uD83D\uD83Dz", 2), "\uD83Dz");
		assert.equal(sliceTail("\uD83D\uE000z", 2), "\uE000z");
		assert.equal(sliceTail("\uE000\uDC00", 1), "\uDC00");
	});

	it("sliceHead and sliceTail drop exactly the split half of a pair", () => {
		const text = `a${EMOJI}b`;
		assert.equal(sliceHead(text, 1), "a");
		assert.equal(sliceHead(text, 2), "a");
		assert.equal(sliceHead(text, 3), `a${EMOJI}`);
		assert.equal(sliceTail(text, 1), "b");
		assert.equal(sliceTail(text, 2), "b");
		assert.equal(sliceTail(text, 3), `${EMOJI}b`);
	});

	it("treats the first and last code units of the surrogate ranges as pair halves", () => {
		for (const pair of ["\uD800\uDC00", "\uDBFF\uDFFF", "\uD83D\uDC00", "\uDBFF\uDC00"]) {
			assert.equal(sliceHead(pair, 1), "");
			assert.equal(sliceTail(pair, 1), "");
		}
	});
});
