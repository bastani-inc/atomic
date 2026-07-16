import { describe, expect, it } from "vitest";
import { reconstructCompactedTranscript } from "../src/core/compaction/deleted-ranges.js";
import {
	SubsequenceValidationError,
	validateCompactedSubsequence,
} from "../src/core/compaction/subsequence.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";

const SOURCE = "[User]: task one\nkeep me\ndrop me 1\ndrop me 2\n[Assistant]: answer\nfinal line";

function protectedRegion() {
	// Protect the user header, the assistant answer, and the final line.
	return createNumberedRegion(SOURCE, new Set([1, 5, 6]));
}

function reason(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		if (error instanceof SubsequenceValidationError) return error.reason;
		throw error;
	}
	throw new Error("expected SubsequenceValidationError");
}

describe("validateCompactedSubsequence", () => {
	it("accepts an ordered byte-identical subsequence and reconstructs canonical markers", () => {
		const region = protectedRegion();
		const ranges = validateCompactedSubsequence(region, "[User]: task one\n[Assistant]: answer\nfinal line");
		expect([...ranges]).toEqual([{ start: 2, end: 4 }]);
		const rebuilt = reconstructCompactedTranscript(region, ranges);
		expect(rebuilt.text).toBe("[User]: task one\n(filtered 3 lines)\n[Assistant]: answer\nfinal line");
	});

	it("ignores model-emitted filtered markers and the boundary prefix echo", () => {
		const region = protectedRegion();
		const ranges = validateCompactedSubsequence(
			region,
			"[User]: task one\n(filtered 999 lines)\n[Assistant]: answer\nfinal line",
		);
		expect([...ranges]).toEqual([{ start: 2, end: 4 }]);
	});

	it("rejects a rewritten line", () => {
		expect(reason(() => validateCompactedSubsequence(protectedRegion(), "[User]: task ONE\n[Assistant]: answer\nfinal line"))).toBe("unmatched-line");
	});

	it("rejects reordered lines", () => {
		expect(reason(() => validateCompactedSubsequence(protectedRegion(), "[Assistant]: answer\n[User]: task one\nfinal line"))).toBe("unmatched-line");
	});

	it("rejects a duplicated line", () => {
		expect(reason(() => validateCompactedSubsequence(protectedRegion(), "[User]: task one\nkeep me\nkeep me\n[Assistant]: answer\nfinal line"))).toBe("unmatched-line");
	});

	it("rejects dropping any protected line", () => {
		expect(reason(() => validateCompactedSubsequence(protectedRegion(), "[User]: task one\nfinal line"))).toBe("dropped-protected-line");
	});

	it("rejects reproducing the whole region with no deletion", () => {
		expect(reason(() => validateCompactedSubsequence(protectedRegion(), SOURCE))).toBe("insufficient-deletion");
	});

	it("rejects an output that reproduces nothing when nothing is protected", () => {
		const region = createNumberedRegion(SOURCE);
		expect(reason(() => validateCompactedSubsequence(region, "(filtered 4 lines)"))).toBe("empty-reproduction");
	});
});
