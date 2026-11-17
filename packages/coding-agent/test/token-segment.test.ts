import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatTokenCount, formatTokenSegment } from "../src/index.js";

describe("token segment (#5224)", () => {
	test("counts below 1000 stay plain and larger ones are compact with one decimal (#5224)", () => {
		assert.equal(formatTokenCount(240), "240");
		assert.equal(formatTokenCount(999), "999");
		assert.equal(formatTokenCount(1000), "1.0k");
		assert.equal(formatTokenCount(11_500), "11.5k");
		assert.equal(formatTokenCount(1_200_000), "1.2M");
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
