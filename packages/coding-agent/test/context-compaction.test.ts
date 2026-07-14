import { describe, expect, it } from "vitest";
import { createNumberedRegion, reconstructCompactedTranscript, validateDeletedRanges } from "../src/core/compaction/index.ts";

describe("verbatim context compaction", () => {
	it("mechanically replaces validated deleted ranges", () => {
		const region = createNumberedRegion("[User]: task\nkeep\ndelete one\ndelete two\n[Assistant]: answer\nkept");
		const ranges = validateDeletedRanges([{ start: 3, end: 4 }], region);
		expect(reconstructCompactedTranscript(region, ranges).text).toBe("[User]: task\nkeep\n(filtered 2 lines)\n[Assistant]: answer\nkept");
	});
});
