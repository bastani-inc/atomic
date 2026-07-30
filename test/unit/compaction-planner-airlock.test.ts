/**
 * The planner is the single airlock where untrusted model text becomes trusted
 * line numbers. Its stated guarantee — "never returns unvalidated ranges" — has
 * to hold on the returned value, not merely be re-established downstream.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import type { LineRange } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { planDeletedLineRanges } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { borrowed, PARAMETERS, region, scriptedStream, testModel } from "./compaction-rung-support.js";

async function plan(text: string, stopReason: "stop" | "length", protectedLines: number[] = [], lineCount = 40) {
	const stream = scriptedStream({ default: [{ text, stopReason }] });
	return planDeletedLineRanges(region(lineCount, protectedLines), PARAMETERS, borrowed(testModel(), "high"), 20, {
		streamFn: stream.streamFn,
	});
}

function ranges(outcome: Awaited<ReturnType<typeof plan>>): LineRange[] {
	assert.ok(outcome.kind === "ranked" || outcome.kind === "recovered", `expected success, got ${outcome.kind}`);
	return (outcome.ranges as LineRange[]).map((range) => ({ start: Number(range.start), end: Number(range.end) }));
}

test("ranked ranges come back normalized, sorted, and merged", async () => {
	// Deliberately reversed endpoints, out of order, and overlapping.
	const outcome = await plan("20,10\n5,8\n7,12\n", "stop");
	assert.equal(outcome.kind, "ranked");
	assert.deepEqual(ranges(outcome), [{ start: 5, end: 20 }]);
});

test("ranked ranges are clamped to the region bounds", async () => {
	const outcome = await plan("0,3\n30,900\n", "stop", [], 40);
	assert.deepEqual(ranges(outcome), [
		{ start: 1, end: 3 },
		{ start: 30, end: 40 },
	]);
});

test("ranked ranges never contain a protected line", async () => {
	const outcome = await plan("1,20\n", "stop", [5, 6, 15]);
	const returned = ranges(outcome);
	assert.deepEqual(returned, [
		{ start: 1, end: 4 },
		{ start: 7, end: 14 },
		{ start: 16, end: 20 },
	]);
	for (const range of returned) {
		for (let line = range.start; line <= range.end; line++) {
			assert.ok(![5, 6, 15].includes(line), `protected line ${line} was returned as deletable`);
		}
	}
});

test("recovered ranges from a truncated response are validated too", async () => {
	// The trailing fragment is discarded, the reversed record is normalized, and
	// the protected line is split around.
	const outcome = await plan("30,25\n1,20\n40,", "length", [10]);
	assert.equal(outcome.kind, "recovered");
	assert.deepEqual(ranges(outcome), [
		{ start: 1, end: 9 },
		{ start: 11, end: 20 },
		{ start: 25, end: 30 },
	]);
});

test("output that validates to nothing is unusable, never an empty success", async () => {
	// Every named line is protected, so validation leaves no deletable range.
	const outcome = await plan("1,3\n", "stop", [1, 2, 3]);
	assert.deepEqual(outcome, { kind: "unusable", category: "no_usable_ranges", excerpt: "1,3\n" });
});

test("re-validating the returned ranges is a no-op", async () => {
	// The runner keeps its own final validation as defense in depth; that second
	// pass must not move a boundary the airlock already settled.
	const { validateDeletedRanges } = await import("../../packages/coding-agent/src/core/compaction/deleted-ranges.js");
	const built = region(40, [5, 6, 15]);
	const outcome = await plan("20,10\n1,20\n0,3\n", "stop", [5, 6, 15]);
	const first = ranges(outcome);
	const second = [...validateDeletedRanges(first, built)];
	assert.deepEqual(second, first);
});
