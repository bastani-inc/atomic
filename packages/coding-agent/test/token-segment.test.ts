import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatTokenCount, formatTokenSegment } from "../src/index.js";

describe("token segment", () => {
	test("counts below 1000 stay plain and larger ones are compact lowercase with one decimal", () => {
		assert.equal(formatTokenCount(240), "240");
		assert.equal(formatTokenCount(999), "999");
		assert.equal(formatTokenCount(1000), "1k");
		assert.equal(formatTokenCount(11_500), "11.5k");
		assert.equal(formatTokenCount(1_200_000), "1.2m");
	});

	test("a request still waiting for its first block points up, anything after it points down", () => {
		assert.equal(formatTokenSegment({ mode: "requesting", count: 1_234 }), "↑ 1.2k tokens");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 1_234 }), "↓ 1.2k tokens");
	});

	test("the segment is hidden while nothing has been counted", () => {
		assert.equal(formatTokenSegment({ mode: "requesting", count: 0 }), "");
		assert.equal(formatTokenSegment({ mode: "receiving", count: 0 }), "");
	});
});
