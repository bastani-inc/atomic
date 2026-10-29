/**
 * Main-thread lag measurement and bounds for the local-worker pool load gate (test/helpers/pool-load-gate.ts).
 */
import { type Histogram, monitorEventLoopDelay } from "node:perf_hooks";

/**
 * Main-thread lag bounds, asserted separately over each window the gate measures: worker startup (pool start until
 * every worker is active), the sustained traffic window, the heartbeat-only window and run completion. The max bound
 * fails a single stall; the p99 bound fails lag that is common rather than one or two ticks (see LAG_TAIL_SAMPLES).
 */
export const MAIN_THREAD_LAG_P99_BOUND_MS = 100;
export const MAIN_THREAD_LAG_MAX_BOUND_MS = 250;
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

/** Why a window breaks the lag bounds, or undefined when it holds them. */
export function lagViolation(name: string, window: LagWindow): string | undefined {
	const context = `${window.samples} ticks over ${window.durationMs} ms`;
	if (!(window.tailMs < MAIN_THREAD_LAG_P99_BOUND_MS)) {
		return `${name}: main-thread lag p${window.tailPercentile} ${window.tailMs} ms exceeds ${MAIN_THREAD_LAG_P99_BOUND_MS} ms (p99 ${window.p99Ms} ms, max ${window.maxMs} ms, ${context})`;
	}
	if (!(window.maxMs < MAIN_THREAD_LAG_MAX_BOUND_MS)) {
		return `${name}: main-thread lag max ${window.maxMs} ms exceeds ${MAIN_THREAD_LAG_MAX_BOUND_MS} ms (p99 ${window.p99Ms} ms, ${context})`;
	}
	return undefined;
}
