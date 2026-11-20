import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatTokenCount, formatTokenSegment } from "../src/index.js";

describe("token segment (#5224)", () => {
	test("counts below 1000 stay plain and larger ones use compact units (#5224)", () => {
		assert.equal(formatTokenCount(240), "240");
		assert.equal(formatTokenCount(999), "999");
		assert.equal(formatTokenCount(1000), "1k");
		assert.equal(formatTokenCount(11_500), "11.5k");
	});

	test("thousands use a lowercase k, and millions and billions an uppercase M and B, which no elapsed time uses", () => {
		for (const [count, expected] of [
			[999, "999"],
			[1_000, "1k"],
			[999_499, "999.5k"],
			[999_500, "999.5k"],
			[999_949, "999.9k"],
			[999_950, "1M"],
			[1_000_000, "1M"],
			[1_200_000, "1.2M"],
			[9_999_999, "10M"],
			[1_000_000_000, "1B"],
			[1_000_000_000_000, "1T"],
		] as const)
			assert.equal(formatTokenCount(count), expected, `token count ${count}`);
		assert.equal(formatTokenSegment({ mode: "receiving", count: 1_200_000 }), "↓ 1.2M tokens");
	});

	test("a request still waiting for its first block points up, anything after it points down (#5224)", () => {
		assert.equal(formatTokenSegment({ mode: "requesting", count: 1_234 }), "↑ 1.2k tokens");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 1_234 }), "↓ 1.2k tokens");
	});

	test("the segment is hidden while nothing has been counted (#5224)", () => {
		assert.equal(formatTokenSegment({ mode: "requesting", count: 0 }), "");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 0 }), "");
	});
});
