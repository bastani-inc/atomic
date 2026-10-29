import assert from "node:assert/strict";
import { createHistogram } from "node:perf_hooks";
import { test } from "vitest";
import { LAG_RESOLUTION_MS, lagViolation, summarizeLag } from "../helpers/event-loop-lag.js";

/** A window as `monitorEventLoopDelay` records it: one delay per timer tick, the sampling interval included. */
function lagWindow(lagsMs: readonly number[], durationMs: number) {
	const histogram = createHistogram();
	for (const lag of lagsMs) histogram.record(Math.round((lag + LAG_RESOLUTION_MS) * 1e6));
	return summarizeLag(histogram, durationMs);
}

/** `count` lags spread evenly from `from` to `to` ms. */
const spread = (count: number, from: number, to: number) =>
	Array.from({ length: count }, (_, index) => from + ((to - from) * index) / (count - 1));

test("the run-end burst CI measured on a slow runner, two stalls over 100 ms in 89 ticks, holds the lag bounds (#3996)", () => {
	// Run 40909017355: a busy loop fires few timer ticks, so the p99 of 89 ticks is its second-largest one.
	const completion = lagWindow([...spread(87, 1, 60), 101.9, 134.1], 2_612);
	assert.equal(lagViolation("completion window", completion), undefined);
});

test("a short burst that stalls on many ticks rather than one or two breaks the lag bounds", () => {
	const completion = lagWindow([...spread(80, 1, 60), ...Array.from({ length: 9 }, () => 120)], 2_612);
	assert.match(lagViolation("completion window", completion) ?? "", /^completion window: main-thread lag/);
});

test("a single stall past the max bound breaks it in a window of any length", () => {
	const traffic = lagWindow([...spread(3_999, 0, 5), 260], 20_000);
	assert.match(lagViolation("sustained traffic window", traffic) ?? "", /main-thread lag max 260/);
});

test("a long window holds its 99th percentile, not its worst ticks, to the bound", () => {
	const stalls = (count: number) => Array.from({ length: count }, () => 120);
	const quiet = (stallCount: number) =>
		lagWindow([...spread(2_000 - stallCount, 0, 5), ...stalls(stallCount)], 10_000);
	assert.equal(lagViolation("heartbeat-only window", quiet(10)), undefined);
	assert.match(lagViolation("heartbeat-only window", quiet(30)) ?? "", /main-thread lag p99 120/);
});
