/**
 * The planner lists deletion records in priority order (lowest continuation
 * value first). The host applies them in that order and stops at the keep
 * target plus a small tolerance, so a plan that over-deletes cannot shrink the
 * transcript far below the requested ratio.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import type { LineRange } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import {
	deleteBudget,
	KEEP_TARGET_TOLERANCE_RATIO,
	validateDeletedRanges,
} from "../../packages/coding-agent/src/core/compaction/deleted-ranges.js";
import { planDeletedLineRanges } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { borrowed, PARAMETERS, region, scriptedStream, testModel } from "./compaction-rung-support.js";

const TOTAL_LINES = 100;
const KEEP_TARGET = 50;
const BUDGET = TOTAL_LINES - KEEP_TARGET + Math.ceil(TOTAL_LINES * KEEP_TARGET_TOLERANCE_RATIO);

async function plan(
	text: string,
	stopReason: "stop" | "length",
	protectedLines: number[] = [],
	lineCount = TOTAL_LINES,
) {
	const stream = scriptedStream({ default: [{ text, stopReason }] });
	return planDeletedLineRanges(
		region(lineCount, protectedLines),
		PARAMETERS,
		borrowed(testModel(), "high"),
		KEEP_TARGET,
		{ streamFn: stream.streamFn },
	);
}

function ranges(outcome: Awaited<ReturnType<typeof plan>>): LineRange[] {
	assert.ok(outcome.kind === "ranked" || outcome.kind === "recovered", `expected success, got ${outcome.kind}`);
	return (outcome.ranges as LineRange[]).map((range) => ({ start: Number(range.start), end: Number(range.end) }));
}

function deletedCount(deleted: readonly LineRange[]): number {
	return deleted.reduce((total, range) => total + range.end - range.start + 1, 0);
}

test("the delete budget is the target delete count plus the named tolerance (#4568)", () => {
	assert.equal(BUDGET, 55);
	assert.equal(deleteBudget(TOTAL_LINES, KEEP_TARGET), BUDGET);
	assert.equal(deleteBudget(TOTAL_LINES, TOTAL_LINES), Math.ceil(TOTAL_LINES * KEEP_TARGET_TOLERANCE_RATIO));
	assert.equal(deleteBudget(1, 1), 1);
});

test("an overshooting plan is capped at the target in priority order (#4568)", async () => {
	// 41 + 30 + 10 lines would delete 81. Priority order is 60-100, then 1-30,
	// which crosses the budget after 14 lines; the third record never applies.
	const outcome = await plan("1:60,100\n1:1,30\n1:31,40\n", "stop");
	assert.equal(outcome.kind, "ranked");
	const returned = ranges(outcome);
	assert.deepEqual(returned, [
		{ start: 1, end: BUDGET - 41 },
		{ start: 60, end: 100 },
	]);
	assert.equal(deletedCount(returned), BUDGET);
});

test("the cap follows emitted order, not line order (#4568)", async () => {
	const ascending = ranges(await plan("1:1,41\n1:60,100\n", "stop"));
	const descending = ranges(await plan("1:60,100\n1:1,41\n", "stop"));
	assert.deepEqual(ascending, [
		{ start: 1, end: 41 },
		{ start: 60, end: 60 + BUDGET - 41 - 1 },
	]);
	assert.deepEqual(descending, [
		{ start: 1, end: BUDGET - 41 },
		{ start: 60, end: 100 },
	]);
});

test("an undershooting plan is applied unchanged (#4568)", async () => {
	const outcome = await plan("2:1,1\n1:70,80\n1:10,20\n1:15,25\n", "stop");
	assert.equal(outcome.kind, "ranked");
	assert.deepEqual(ranges(outcome), [
		{ start: 10, end: 25 },
		{ start: 70, end: 80 },
	]);
});

test("a plan that exactly fills the budget is applied unchanged (#4568)", async () => {
	const outcome = await plan(`1:1,${BUDGET}\n`, "stop");
	assert.deepEqual(ranges(outcome), [{ start: 1, end: BUDGET }]);
});

test("protected lines are never deleted and never spend the budget (#4568)", async () => {
	const protectedLines = [3, 4, 5, 70];
	const outcome = await plan("1:1,100\n", "stop", protectedLines);
	const returned = ranges(outcome);
	assert.equal(deletedCount(returned), BUDGET);
	for (const range of returned) {
		for (const line of protectedLines) {
			assert.ok(line < range.start || line > range.end, `protected line ${line} was returned as deletable`);
		}
	}
	assert.deepEqual(returned, [
		{ start: 1, end: 2 },
		{ start: 6, end: 58 },
	]);
});

test("overlapping and duplicate records count each line once (#4568)", async () => {
	const outcome = await plan("1:1,30\n1:1,30\n1:20,40\n", "stop");
	assert.deepEqual(ranges(outcome), [{ start: 1, end: 40 }]);
});

test("a truncated response keeps its recovered records and caps them in order (#4568)", async () => {
	const outcome = await plan("1:60,100\n1:1,30\n1:31,4", "length");
	assert.equal(outcome.kind, "recovered");
	if (outcome.kind !== "recovered") return;
	assert.equal(outcome.recoveredCount, 2);
	assert.deepEqual(ranges(outcome), [
		{ start: 1, end: BUDGET - 41 },
		{ start: 60, end: 100 },
	]);
});

test("an undershooting truncated response is recovered unchanged (#4568)", async () => {
	const outcome = await plan("1:40,50\n1:10,20\n1:3", "length");
	assert.equal(outcome.kind, "recovered");
	assert.deepEqual(ranges(outcome), [
		{ start: 10, end: 20 },
		{ start: 40, end: 50 },
	]);
});

test("validation without a limit still deletes every unprotected line (#4568)", () => {
	const built = region(TOTAL_LINES, [10]);
	const fresh = validateDeletedRanges([{ start: 1, end: TOTAL_LINES }], built);
	assert.deepEqual(
		[...fresh].map((range) => ({ start: range.start, end: range.end })),
		[
			{ start: 1, end: 9 },
			{ start: 11, end: TOTAL_LINES },
		],
	);
});

test("a zero limit deletes nothing and a limit re-validates as a no-op (#4568)", () => {
	const built = region(TOTAL_LINES, [10]);
	assert.equal(validateDeletedRanges([{ start: 1, end: 50 }], built, { maxDeletedLines: 0 }).length, 0);
	const capped = validateDeletedRanges(
		[
			{ start: 50, end: 90 },
			{ start: 1, end: 30 },
		],
		built,
		{ maxDeletedLines: 45 },
	);
	assert.deepEqual([...validateDeletedRanges([...capped], built)], [...capped]);
});
