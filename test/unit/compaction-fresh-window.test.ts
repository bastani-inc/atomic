/**
 * RFC §8 — Unit: terminal-rung totality, the `preserve_recent` tail exception,
 * and the urgency refusal that keeps `/compact` away from context destruction.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
	runVerbatimCompaction,
	startNewContextWindow,
} from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import type { CompactedTranscript } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { RangePlanError } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { preparation, region, runRequest, scriptedStream, testModel } from "./compaction-rung-support.js";

const MARKER = /^\(filtered \d+ lines\)$/;

function retainedLines(text: string): string[] {
	return text.split("\n").filter((line) => !MARKER.test(line));
}

test("startNewContextWindow is total across empty, single-line, and all-protected regions", () => {
	const cases = [region(0), region(1), region(1, [1]), region(8, [1, 2, 3, 4, 5, 6, 7, 8]), region(9, [2, 5, 8])];
	for (const built of cases) {
		const fresh = startNewContextWindow(preparation({ region: built }));
		// Every retained non-marker line is byte-identical to an input line, in order.
		const retained = retainedLines(fresh.text).filter((line) => line.length > 0);
		const inputOrder = built.lines.filter((line) => retained.includes(line));
		assert.deepEqual(retained, inputOrder.slice(0, retained.length));
		for (const line of retained) assert.ok(built.lines.includes(line));
	}
});

test("startNewContextWindow keeps explicit protected spans and discards everything else", () => {
	const built = region(20, [3, 4, 15]);
	const fresh = startNewContextWindow(preparation({ region: built }));
	const retained = retainedLines(fresh.text);
	assert.deepEqual(retained, ["line 3", "line 4", "line 15"]);
});

test("property: retained lines are byte-identical and in input order for arbitrary protected sets", () => {
	for (let seed = 1; seed <= 25; seed++) {
		const size = 5 + (seed % 17);
		const protectedLines: number[] = [];
		for (let line = 1; line <= size; line++) {
			if ((line * seed) % 3 === 0) protectedLines.push(line);
		}
		const built = region(size, protectedLines);
		const fresh = startNewContextWindow(preparation({ region: built }));
		const retained = retainedLines(fresh.text).filter((line) => line.length > 0);
		assert.deepEqual(
			retained,
			protectedLines.map((line) => built.lines[line - 1]),
		);
	}
});

test("the public door returns exactly a CompactedTranscript", () => {
	const fresh = startNewContextWindow(preparation({ region: region(40) }));
	// The RFC §5.1 return type: assignable to `CompactedTranscript`, with no
	// extra field observable at runtime. `keptTail` is runner bookkeeping and
	// travels on `CompactionRungResult`, not on this door.
	const transcript: CompactedTranscript = fresh;
	assert.deepEqual(Object.keys(transcript).sort(), ["keptRanges", "ranges", "stats", "text"]);
	assert.equal("keptTail" in (fresh as object), false);
});

test("the preserve_recent tail is kept when it fits under the hard input limit", async () => {
	const prep = preparation({ region: region(40), tokensBefore: 10_000 });
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	const result = await runVerbatimCompaction(
		prep,
		testModel(),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, true);
});

test("the tail is dropped only when keeping it would still exceed the hard input limit", async () => {
	// tokensBefore far exceeds the region estimate, so the tail alone is huge.
	const prep = preparation({ region: region(40), tokensBefore: 500_000 });
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	const result = await runVerbatimCompaction(
		prep,
		testModel({ contextWindow: 1_000 }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, false);
	assert.ok(result.stats.tokensAfter <= 1_000);
});

test("recoverable urgency cannot reach the fresh rung and fails honestly", async () => {
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	await assert.rejects(
		() => runVerbatimCompaction(preparation(), testModel(), runRequest({ streamFn: stream.streamFn })),
		(error: unknown) => {
			assert.ok(error instanceof RangePlanError);
			assert.equal(error.outcome?.kind, "rateLimited");
			return true;
		},
	);
});

test("load-bearing urgency reaches the fresh rung when every model fails", async () => {
	const stream = scriptedStream({ default: [{ errorMessage: "429 Too Many Requests" }] });
	const result = await runVerbatimCompaction(
		preparation(),
		testModel(),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, true);
	assert.equal(result.plannerModel, undefined);
});

test("a load-bearing fresh rung reports the dropped tail so persistence clears the boundary", async () => {
	const stream = scriptedStream({ default: [{ errorMessage: "insufficient_quota" }] });
	const result = await runVerbatimCompaction(
		preparation({ tokensBefore: 500_000 }),
		testModel({ contextWindow: 1_000 }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, false);
});
