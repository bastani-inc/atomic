/**
 * Main-thread lag measurement and bounds for the local-worker pool load gate (test/helpers/pool-load-gate.ts).
 */
import assert from "node:assert/strict";
import { type Histogram, monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Main-thread lag bounds, asserted separately over each window the gate measures: worker startup (pool start until
 * every worker is active), the sustained traffic window, the heartbeat-only window and run completion. The p99 bound
 * fails lag that is common rather than one or two ticks (see LAG_TAIL_SAMPLES). The limit fails stalls that repeat:
 * more than LAG_TICKS_OVER_LIMIT_ALLOWED ticks at or over it. The ceiling fails a single stall long enough to be a
 * freeze on its own.
 */
export const MAIN_THREAD_LAG_P99_BOUND_MS = 100;
export const MAIN_THREAD_LAG_LIMIT_MS = 250;
/**
 * One tick per window may reach MAIN_THREAD_LAG_LIMIT_MS. While 150 workers start, a loaded runner keeps the root
 * waiting for a core: in instrumented startup windows, every stall of 200 ms or more (up to 395 ms) spent 64–87% of
 * its time in the run queue and at most 87 ms running, with no blocking I/O and no full garbage collection. One such
 * stall can cross the limit (#4417: 322 ms, with p99 at 4.4 ms); stalls that repeat cross it more than once.
 */
export const LAG_TICKS_OVER_LIMIT_ALLOWED = 1;
/** No tick may reach this, however few do: a second without a turn of the event loop is unresponsive on its own. */
export const MAIN_THREAD_LAG_CEILING_MS = 1_000;
/** Event-loop delay sampling resolution; reported lag excludes this interval. */
export const LAG_RESOLUTION_MS = 5;
/**
 * A percentile bound needs enough ticks above it to be more than one or two outliers. A busy loop fires few timer
 * ticks, and the completion window is busy by construction (150 children finish within moments of each other): CI
 * measured 89 ticks over 2,612 ms there, so its p99 was the second-largest tick and one scheduler stall on a loaded
 * runner decided it (p99 101.9 ms, max 134.1 ms, against a 100 ms bound). A window is read at its 99th percentile, or,
 * with fewer than 100 * LAG_TAIL_SAMPLES ticks, at the percentile with LAG_TAIL_SAMPLES ticks above it, so it takes
 * more than that many ticks over the bound to fail it, not one or two.
 */
export const LAG_TAIL_SAMPLES = 5;

export interface LagWindow {
	readonly durationMs: number;
	readonly samples: number;
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
	/** The percentile held to MAIN_THREAD_LAG_P99_BOUND_MS: 99, or lower when the window has few ticks. */
	readonly tailPercentile: number;
	/** Lag at `tailPercentile`. */
	readonly tailMs: number;
	/** Ticks whose lag reached MAIN_THREAD_LAG_LIMIT_MS. */
	readonly ticksOverLimit: number;
}

/** The delay `monitorEventLoopDelay` records for a tick with this much lag, in nanoseconds. */
const recordedDelay = (lagMs: number) => (lagMs + LAG_RESOLUTION_MS) * 1e6;

/** The `rank`-th smallest recorded delay, 1-based: HdrHistogram rounds `percentile / 100 * count` to the rank. */
const delayAtRank = (histogram: Histogram, rank: number) => histogram.percentile((100 * rank) / histogram.count);

/** How many recorded delays reach `delay`, found by bisecting ranks rather than reading every tick. */
function ticksReaching(histogram: Histogram, delay: number): number {
	if (!(histogram.max >= delay)) return 0;
	let first = 1;
	let last = histogram.count;
	while (first < last) {
		const middle = Math.floor((first + last) / 2);
		if (delayAtRank(histogram, middle) >= delay) last = middle;
		else first = middle + 1;
	}
	return histogram.count - first + 1;
}

/** Lag of a window from its event-loop delay histogram, in milliseconds, without the sampling interval. */
export function summarizeLag(histogram: Histogram, durationMs: number): LagWindow {
	const lag = (nanoseconds: number) => Math.round(Math.max(0, nanoseconds / 1e6 - LAG_RESOLUTION_MS) * 10) / 10;
	const tailPercentile =
		Math.round(Math.max(0, Math.min(99, 100 * (1 - LAG_TAIL_SAMPLES / histogram.count))) * 10) / 10;
	return {
		durationMs: Math.round(durationMs),
		samples: histogram.count,
		p50Ms: lag(histogram.percentile(50)),
		p99Ms: lag(histogram.percentile(99)),
		maxMs: lag(histogram.max),
		tailPercentile,
		tailMs: lag(histogram.percentile(tailPercentile)),
		ticksOverLimit: ticksReaching(histogram, recordedDelay(MAIN_THREAD_LAG_LIMIT_MS)),
	};
}

export function measureLag(): () => LagWindow {
	const histogram = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
	const startedAt = performance.now();
	histogram.enable();
	return () => {
		histogram.disable();
		return summarizeLag(histogram, performance.now() - startedAt);
	};
}

/** The bound a window breaks, with the measurement that breaks it. */
export type LagViolation =
	| {
			readonly kind: "tail";
			readonly percentile: number;
			readonly lagMs: number;
			readonly boundMs: typeof MAIN_THREAD_LAG_P99_BOUND_MS;
	  }
	| {
			readonly kind: "ticks-over-limit";
			readonly ticks: number;
			readonly allowed: typeof LAG_TICKS_OVER_LIMIT_ALLOWED;
			readonly limitMs: typeof MAIN_THREAD_LAG_LIMIT_MS;
	  }
	| {
			readonly kind: "ceiling";
			readonly maxMs: number;
			readonly ceilingMs: typeof MAIN_THREAD_LAG_CEILING_MS;
	  };

/** The first bound a window breaks, or undefined when it holds them all. */
export function lagViolation(window: LagWindow): LagViolation | undefined {
	if (!(window.tailMs < MAIN_THREAD_LAG_P99_BOUND_MS)) {
		return {
			kind: "tail",
			percentile: window.tailPercentile,
			lagMs: window.tailMs,
			boundMs: MAIN_THREAD_LAG_P99_BOUND_MS,
		};
	}
	if (window.ticksOverLimit > LAG_TICKS_OVER_LIMIT_ALLOWED) {
		return {
			kind: "ticks-over-limit",
			ticks: window.ticksOverLimit,
			allowed: LAG_TICKS_OVER_LIMIT_ALLOWED,
			limitMs: MAIN_THREAD_LAG_LIMIT_MS,
		};
	}
	if (!(window.maxMs < MAIN_THREAD_LAG_CEILING_MS)) {
		return { kind: "ceiling", maxMs: window.maxMs, ceilingMs: MAIN_THREAD_LAG_CEILING_MS };
	}
	return undefined;
}

/** A failure message for the window `name` that breaks `violation`. */
export function describeLagViolation(name: string, window: LagWindow, violation: LagViolation): string {
	const context = `p99 ${window.p99Ms} ms, max ${window.maxMs} ms, ${window.ticksOverLimit} ticks at or over ${MAIN_THREAD_LAG_LIMIT_MS} ms, ${window.samples} ticks over ${window.durationMs} ms`;
	switch (violation.kind) {
		case "tail":
			return `${name}: main-thread lag p${violation.percentile} ${violation.lagMs} ms exceeds ${violation.boundMs} ms (${context})`;
		case "ticks-over-limit":
			return `${name}: ${violation.ticks} main-thread stalls reached ${violation.limitMs} ms; ${violation.allowed} is allowed (${context})`;
		case "ceiling":
			return `${name}: main-thread lag max ${violation.maxMs} ms reached the ${violation.ceilingMs} ms ceiling (${context})`;
	}
}

/** Fails the test, naming the window `name` and the bound it breaks, unless `window` holds every bound. */
export function assertLag(name: string, window: LagWindow): void {
	const violation = lagViolation(window);
	if (violation !== undefined) assert.fail(describeLagViolation(name, window, violation));
}
