import { describe, expect, it } from "vitest";
import { reconstructCompactedTranscript } from "../src/core/compaction/deleted-ranges.js";
import {
	SubsequenceValidationError,
	validateCompactedSubsequence,
} from "../src/core/compaction/subsequence.js";
import { createNumberedRegion } from "../src/core/compaction/transcript-serialization.js";
import { VERBATIM_COMPACTION_PREFIX } from "../src/core/messages.js";

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

	it("assigns a duplicate output line to the later protected source occurrence", () => {
		const region = createNumberedRegion("duplicate\ndrop\nduplicate\nfinal", new Set([3, 4]));
		expect([...validateCompactedSubsequence(region, "duplicate\nfinal")]).toEqual([{ start: 1, end: 2 }]);
	});

	it("assigns a blank output line to the later protected blank occurrence", () => {
		const region = createNumberedRegion("\ndrop\n\nfinal", new Set([3, 4]));
		expect([...validateCompactedSubsequence(region, "\nfinal")]).toEqual([{ start: 1, end: 2 }]);
	});

	it("assigns repeated output lines to both later protected duplicate occurrences", () => {
		const region = createNumberedRegion("duplicate\nduplicate\nduplicate\nfinal", new Set([2, 3, 4]));
		expect([...validateCompactedSubsequence(region, "duplicate\nduplicate\nfinal")]).toEqual([{ start: 1, end: 1 }]);
	});

	it("classifies an impossible protected occurrence assignment as dropped-protected-line", () => {
		const region = createNumberedRegion("duplicate\nmiddle\nduplicate", new Set([1, 3]));
		expect(reason(() => validateCompactedSubsequence(region, "duplicate"))).toBe("dropped-protected-line");
	});

	it("selects the earliest valid occurrence when multiple protected-valid assignments tie", () => {
		const region = createNumberedRegion("duplicate\nduplicate\nprotected", new Set([3]));
		expect([...validateCompactedSubsequence(region, "duplicate\nprotected")]).toEqual([{ start: 2, end: 2 }]);
	});

	it("accepts a real verbatim boundary prefix echo without changing occurrence assignment", () => {
		const region = createNumberedRegion("drop\nprotected", new Set([2]));
		expect([...validateCompactedSubsequence(region, `${VERBATIM_COMPACTION_PREFIX}protected`)]).toEqual([{ start: 1, end: 1 }]);
	});

});
