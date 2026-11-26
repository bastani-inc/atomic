import assert from "node:assert/strict";
import { test } from "vitest";
import {
	reparentedSegments,
	splitSegment,
} from "../../packages/coding-agent/src/core/storage/session/fork-detach-map.js";

test("a detach page takes the first rows of a segment and leaves the rest mapping the same child seqs", () => {
	// Child seqs 4-8 are P's seqs 11-15.
	const segment = { sourceId: "P", fromSeq: 11, toSeq: 15, baseSeq: 3 };
	assert.deepEqual(splitSegment(segment, 2), {
		page: { sourceId: "P", fromSeq: 11, toSeq: 12, baseSeq: 3 },
		rest: { sourceId: "P", fromSeq: 13, toSeq: 15, baseSeq: 5 },
	});
	assert.deepEqual(splitSegment(segment, 5), { page: segment, rest: undefined });
	assert.deepEqual(splitSegment(segment, 50), { page: segment, rest: undefined });
});

test("a sibling of a prefix fork is re-pointed at the detached child's rows, other sources kept", () => {
	// P forked from A at 3 and wrote 4-6; C forked from P at 6, S forked from P at 5.
	const c = [
		{ sourceId: "A", fromSeq: 1, toSeq: 3, baseSeq: 0 },
		{ sourceId: "P", fromSeq: 4, toSeq: 6, baseSeq: 3 },
	];
	const s = [
		{ sourceId: "A", fromSeq: 1, toSeq: 3, baseSeq: 0 },
		{ sourceId: "P", fromSeq: 4, toSeq: 5, baseSeq: 3 },
	];
	assert.deepEqual(
		reparentedSegments(
			s,
			"P",
			"C",
			c.filter((segment) => segment.sourceId === "P"),
		),
		[
			{ sourceId: "A", fromSeq: 1, toSeq: 3, baseSeq: 0 },
			{ sourceId: "C", fromSeq: 4, toSeq: 5, baseSeq: 3 },
		],
	);
});

test("a sibling that read rows a branch fork skipped stays on the parent", () => {
	// C is a branch fork of P without P's rows 2-3: C's seq 1 is P's 1, C's 2-4 are P's 4-6.
	const cOnP = [
		{ sourceId: "P", fromSeq: 1, toSeq: 1, baseSeq: 0 },
		{ sourceId: "P", fromSeq: 4, toSeq: 6, baseSeq: 1 },
	];
	assert.equal(reparentedSegments([{ sourceId: "P", fromSeq: 1, toSeq: 5, baseSeq: 0 }], "P", "C", cOnP), undefined);
	// Only P's row 1 is C's row 1; a sibling reading just it is re-pointed.
	assert.deepEqual(reparentedSegments([{ sourceId: "P", fromSeq: 1, toSeq: 1, baseSeq: 0 }], "P", "C", cOnP), [
		{ sourceId: "C", fromSeq: 1, toSeq: 1, baseSeq: 0 },
	]);
});

test("a sibling that forked past the detached child's cut-off stays on the parent", () => {
	const cOnP = [{ sourceId: "P", fromSeq: 1, toSeq: 4, baseSeq: 0 }];
	assert.equal(reparentedSegments([{ sourceId: "P", fromSeq: 1, toSeq: 9, baseSeq: 0 }], "P", "C", cOnP), undefined);
	// At the cut-off itself it is re-pointed.
	assert.deepEqual(reparentedSegments([{ sourceId: "P", fromSeq: 1, toSeq: 4, baseSeq: 0 }], "P", "C", cOnP), [
		{ sourceId: "C", fromSeq: 1, toSeq: 4, baseSeq: 0 },
	]);
});

test("a fork of the detached child reads all of its history from the child once re-pointed", () => {
	// C forked P at 4 and wrote 5-6; D forked C at 6, its segments composed down to P's rows and C's own.
	const cOnP = [{ sourceId: "P", fromSeq: 1, toSeq: 4, baseSeq: 0 }];
	const d = [
		{ sourceId: "P", fromSeq: 1, toSeq: 4, baseSeq: 0 },
		{ sourceId: "C", fromSeq: 5, toSeq: 6, baseSeq: 4 },
	];
	assert.deepEqual(reparentedSegments(d, "P", "C", cOnP), [{ sourceId: "C", fromSeq: 1, toSeq: 6, baseSeq: 0 }]);
});
