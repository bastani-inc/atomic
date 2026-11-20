import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatTokenCount, formatTokenSegment } from "../src/index.js";

describe("token segment (#5224)", () => {
	test("counts below 1,000 stay whole and larger ones show one decimal and a unit", () => {
		for (const [count, expected] of [
			[0, "0"],
			[240, "240"],
			[999, "999"],
			[1_000, "1.0k"],
			[1_150, "1.2k"],
			[11_500, "11.5k"],
			[99_949, "99.9k"],
			[99_950, "100.0k"],
			[248_600, "248.6k"],
			[999_949, "999.9k"],
			[999_950, "1.0M"],
			[1_000_000, "1.0M"],
			[1_200_000, "1.2M"],
			[9_999_999, "10.0M"],
			[1_000_000_000, "1.0B"],
			[999_949_999_999, "999.9B"],
			[999_950_000_000, "1.0T"],
			[Number.MAX_SAFE_INTEGER, "9.0Q"],
		] as const)
			assert.equal(formatTokenCount(count), expected, `token count ${count}`);
	});

	test("fractional counts round to whole tokens and malformed counts show 0", () => {
		assert.equal(formatTokenCount(0.1 + 0.2), "0");
		assert.equal(formatTokenCount(999.4), "999");
		assert.equal(formatTokenCount(999.5), "1.0k");
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) assert.equal(formatTokenCount(value), "0");
	});

	test("a request still waiting for its first block points up, anything after it points down (#5224)", () => {
		assert.equal(formatTokenSegment({ mode: "requesting", count: 1_234 }), "↑ 1.2k tokens");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 1_234 }), "↓ 1.2k tokens");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 1_200_000 }), "↓ 1.2M tokens");
	});

	test("the segment is hidden while nothing has been counted (#5224)", () => {
		assert.equal(formatTokenSegment({ mode: "requesting", count: 0 }), "");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 0 }), "");
	});
});
