import assert from "node:assert/strict";
import { createHistogram } from "node:perf_hooks";
import { test } from "vitest";
import {
	assertLag,
	describeLagViolation,
	LAG_RESOLUTION_MS,
	type LagWindow,
	lagViolation,
	summarizeLag,
} from "../helpers/event-loop-lag.js";

/** A window as `monitorEventLoopDelay` records it: one delay per timer tick, the sampling interval included. */
function lagWindow(lagsMs: readonly number[], durationMs: number) {
	const histogram = createHistogram();
	for (const lag of lagsMs) histogram.record(Math.round((lag + LAG_RESOLUTION_MS) * 1e6));
	return summarizeLag(histogram, durationMs);
}

/** `count` lags spread evenly from `from` to `to` ms. */
const spread = (count: number, from: number, to: number) =>
	Array.from({ length: count }, (_, index) => from + ((to - from) * index) / Math.max(1, count - 1));

const repeat = (count: number, lagMs: number) => Array.from({ length: count }, () => lagMs);

/** A window that holds every bound, to vary one measurement at a time. */
const quietWindow: LagWindow = {
	durationMs: 10_000,
	samples: 2_000,
	p50Ms: 1,
	p99Ms: 4,
	maxMs: 40,
	tailPercentile: 99,
	tailMs: 4,
	ticksOverLimit: 0,
};

test("the run-end burst CI measured on a slow runner, two stalls over 100 ms in 89 ticks, holds the lag bounds (#3996)", () => {
	// Run 40909017355: a busy loop fires few timer ticks, so the p99 of 89 ticks is its second-largest one.
	const completion = lagWindow([...spread(87, 1, 60), 101.9, 134.1], 2_612);
	assert.equal(completion.ticksOverLimit, 0);
	assert.equal(lagViolation(completion), undefined);
});

test("a short burst that stalls on many ticks rather than one or two breaks the lag bounds", () => {
	const completion = lagWindow([...spread(80, 1, 60), ...repeat(9, 120)], 2_612);
	assert.deepEqual(lagViolation(completion), { kind: "tail", percentile: 94.4, lagMs: 120, boundMs: 100 });
});

test("one stall over the limit in the worker-startup window, with a quiet p99, holds the lag bounds (#4417)", () => {
	const startup = lagWindow([...spread(1_899, 0, 5), 322], 9_500);
	assert.equal(startup.ticksOverLimit, 1);
	assert.ok(startup.maxMs >= 322);
	assert.equal(lagViolation(startup), undefined);
});

test("stalls over the limit that repeat break the lag bounds in a window of any length, even with a low tail (#4417)", () => {
	for (const ticks of [100, 4_000]) {
		const window = lagWindow([...spread(ticks - 2, 0, 5), 260, 300], ticks * 5);
		assert.ok(window.tailMs < 10);
		assert.deepEqual(lagViolation(window), { kind: "ticks-over-limit", ticks: 2, allowed: 1, limitMs: 250 });
	}
	// A stall every second through a 9.5 s startup window.
	const sustained = lagWindow([...spread(1_891, 0, 5), ...repeat(9, 300)], 9_500);
	assert.deepEqual(lagViolation(sustained), { kind: "ticks-over-limit", ticks: 9, allowed: 1, limitMs: 250 });
});

test("a single stall that reaches the ceiling breaks the lag bounds on its own (#4417)", () => {
	const frozen = lagWindow([...spread(1_999, 0, 5), 3_000], 13_000);
	assert.equal(frozen.ticksOverLimit, 1);
	assert.ok(frozen.maxMs >= 2_999 && frozen.maxMs <= 3_005);
	assert.deepEqual(lagViolation(frozen), { kind: "ceiling", maxMs: frozen.maxMs, ceilingMs: 1_000 });
	assert.equal(lagViolation(lagWindow([...spread(1_999, 0, 5), 990], 10_000)), undefined);
});

test("every tick at or over the limit is counted, however many there are (#4417)", () => {
	for (const over of [0, 1, 2, 3, 7, 50, 333]) {
		const lags = [...spread(2_000 - over, 0, 249), ...spread(over, 251, 900)];
		assert.equal(lagWindow(lags, 10_000).ticksOverLimit, over, `${over} ticks over the limit`);
	}
	assert.equal(lagWindow(repeat(40, 400), 16_000).ticksOverLimit, 40);
	assert.equal(lagWindow([...repeat(10, 2), 400], 450).ticksOverLimit, 1);
	assert.equal(lagWindow([...repeat(10, 2), 249], 300).ticksOverLimit, 0);
	assert.equal(lagWindow([...repeat(10, 2), 248, 252], 550).ticksOverLimit, 1);
});

test("a long window holds its 99th percentile, not its worst ticks, to the bound", () => {
	const quiet = (stallCount: number) =>
		lagWindow([...spread(2_000 - stallCount, 0, 5), ...repeat(stallCount, 120)], 10_000);
	assert.equal(lagViolation(quiet(10)), undefined);
	assert.deepEqual(lagViolation(quiet(30)), { kind: "tail", percentile: 99, lagMs: 120, boundMs: 100 });
});

test("each bound fails at its value and holds just under it (#4417)", () => {
	assert.equal(lagViolation({ ...quietWindow, tailMs: 99.9 }), undefined);
	assert.equal(lagViolation({ ...quietWindow, tailMs: 100 })?.kind, "tail");
	assert.equal(lagViolation({ ...quietWindow, ticksOverLimit: 1, maxMs: 999.9 }), undefined);
	assert.equal(lagViolation({ ...quietWindow, ticksOverLimit: 2, maxMs: 300 })?.kind, "ticks-over-limit");
	assert.equal(lagViolation({ ...quietWindow, ticksOverLimit: 1, maxMs: 1_000 })?.kind, "ceiling");
	assert.equal(lagViolation({ ...quietWindow, tailMs: Number.NaN })?.kind, "tail");
	assert.equal(lagViolation({ ...quietWindow, maxMs: Number.NaN })?.kind, "ceiling");
});

test("a violation names its window, the bound it breaks and the window's measurements (#4417)", () => {
	const window: LagWindow = { ...quietWindow, p99Ms: 4.4, maxMs: 1_200, ticksOverLimit: 3 };
	const context = "(p99 4.4 ms, max 1200 ms, 3 ticks at or over 250 ms, 2000 ticks over 10000 ms)";
	assert.equal(
		describeLagViolation("worker startup window", window, { kind: "tail", percentile: 99, lagMs: 120, boundMs: 100 }),
		`worker startup window: main-thread lag p99 120 ms exceeds 100 ms ${context}`,
	);
	assert.equal(
		describeLagViolation("worker startup window", window, {
			kind: "ticks-over-limit",
			ticks: 3,
			allowed: 1,
			limitMs: 250,
		}),
		`worker startup window: 3 main-thread stalls reached 250 ms; 1 is allowed ${context}`,
	);
	assert.equal(
		describeLagViolation("worker startup window", window, { kind: "ceiling", maxMs: 1_200, ceilingMs: 1_000 }),
		`worker startup window: main-thread lag max 1200 ms reached the 1000 ms ceiling ${context}`,
	);
});

test("the gate's assertion fails a window that breaks a bound, with its description, and passes one that holds them (#4417)", () => {
	assert.doesNotThrow(() => assertLag("completion window", { ...quietWindow, ticksOverLimit: 1, maxMs: 330 }));
	const stalled: LagWindow = { ...quietWindow, ticksOverLimit: 2, maxMs: 330 };
	const violation = lagViolation(stalled);
	assert.ok(violation !== undefined);
	assert.throws(
		() => assertLag("completion window", stalled),
		(error) =>
			error instanceof assert.AssertionError &&
			error.message === describeLagViolation("completion window", stalled, violation),
	);
});
