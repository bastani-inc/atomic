/**
 * A load-bearing compaction must complete even when the compactable region is
 * below the planner minimum.
 *
 * One oversized tool result can push the whole context past the provider hard
 * input limit while leaving very few compactable lines. Refusing to prepare a
 * boundary there made the "always completes" guarantee hollow: the fresh rung
 * and its tail-drop rule became unreachable and the mid-turn gate then refused
 * the follow-up request.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { runVerbatimCompaction } from "../../packages/coding-agent/src/core/compaction/compaction-runner.js";
import { MIN_COMPACTABLE_REGION_LINES } from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { RangePlanError } from "../../packages/coding-agent/src/core/compaction/range-planner.js";
import { preparation, region, runRequest, scriptedStream, testModel } from "../unit/compaction-rung-support.js";

const smallRegion = () => region(MIN_COMPACTABLE_REGION_LINES - 1);

test("a load-bearing small region reaches fresh without invoking any planner", async () => {
	const stream = scriptedStream({ default: [{ text: "1,5\n" }] });
	const result = await runVerbatimCompaction(
		preparation({ region: smallRegion() }),
		testModel(),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);

	assert.equal(result.rung, "fresh");
	// Changing models cannot make the same region large enough, so no request is sent.
	assert.equal(stream.calls.length, 0);
	assert.equal(result.plannerModel, undefined);
});

test("a load-bearing small region drops an oversized protected tail", async () => {
	const stream = scriptedStream({ default: [{ text: "1,5\n" }] });
	const result = await runVerbatimCompaction(
		// A tail far larger than the tiny region and the hard limit alike.
		preparation({ region: smallRegion(), tokensBefore: 500_000 }),
		testModel({ contextWindow: 1_000 }),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);

	assert.equal(result.rung, "fresh");
	assert.equal(result.keptTail, false);
	assert.ok(result.stats.tokensAfter <= 1_000, `tokensAfter ${result.stats.tokensAfter} still exceeds the limit`);
	assert.equal(stream.calls.length, 0);
});

test("a recoverable small region is refused, never cleared", async () => {
	const stream = scriptedStream({ default: [{ text: "1,5\n" }] });
	await assert.rejects(
		() =>
			runVerbatimCompaction(
				preparation({ region: smallRegion() }),
				testModel(),
				runRequest({ streamFn: stream.streamFn }),
			),
		(error: unknown) => {
			assert.ok(error instanceof RangePlanError);
			return true;
		},
	);
	assert.equal(stream.calls.length, 0);
});

test("a region at the planner minimum is still planned normally", async () => {
	const stream = scriptedStream({ default: [{ text: "1,5\n" }] });
	const result = await runVerbatimCompaction(
		preparation({ region: region(MIN_COMPACTABLE_REGION_LINES) }),
		testModel(),
		runRequest({ streamFn: stream.streamFn, urgency: "load_bearing" }),
	);
	assert.equal(result.rung, "planned");
	assert.equal(stream.calls.length, 1);
});
