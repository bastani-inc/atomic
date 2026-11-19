/**
 * Watches the event loop's turns while history:// work runs, and reports how long each turn held the event loop, so
 * a test can bound the work's blocking per turn on every platform.
 */
import assert from "node:assert/strict";
import { getPriority, constants as osConstants, setPriority } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";

/** A watched run may pass its limit this many times: a collection or the scheduler can stretch a few turns. */
const STALLS_ALLOWED = 3;
/** No turn may hold the event loop this long, however few do. */
const STALL_CEILING_MS = 100;

/** This thread's CPU time in milliseconds. */
export function cpuMs(): number {
	const used = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : process.cpuUsage();
	return (used.user + used.system) / 1000;
}

const CPU_CLOCK_STEP_SAMPLES = 3;
const CPU_CLOCK_STEP_SEARCH_MS = 200;

function measureCpuClockStepMs(): number {
	let step = Number.POSITIVE_INFINITY;
	let last = cpuMs();
	const searchUntil = performance.now() + CPU_CLOCK_STEP_SEARCH_MS;
	for (let seen = 0; seen < CPU_CLOCK_STEP_SAMPLES && performance.now() < searchUntil; ) {
		const now = cpuMs();
		if (now === last) continue;
		step = Math.min(step, now - last);
		last = now;
		seen++;
	}
	return Number.isFinite(step) ? step : 0;
}

/** The smallest change the thread CPU clock reports: a scheduler tick (15.6 ms) on Windows, far less elsewhere. */
export const CPU_CLOCK_STEP_MS = measureCpuClockStepMs();

export interface Interval {
	readonly start: number;
	readonly end: number;
}

export interface WatchedTurn extends Interval {
	readonly cpu: number;
}

export interface WatchedTurns {
	readonly count: number;
	/** Turns shorter than this were not kept, so no limit below it can be checked. */
	readonly keptOverMs: number;
	readonly blockedMs: readonly number[];
}

function overlapMs(turn: Interval, pauses: readonly Interval[]): number {
	return pauses.reduce(
		(sum, pause) => sum + Math.max(0, Math.min(turn.end, pause.end) - Math.max(turn.start, pause.start)),
		0,
	);
}

/**
 * If the CPU clock didn't advance, work shorter than a clock step is indistinguishable from time spent off the CPU.
 * Otherwise count wall time up to the CPU time plus one step the clock may not have charged yet. Collection pauses
 * come off wall time only: a pause can include time spent off the CPU, which CPU time never counted.
 */
export function turnBlockedMs(turn: WatchedTurn, collections: readonly Interval[], cpuClockStepMs: number): number {
	return blockedMs(turn.end - turn.start - overlapMs(turn, collections), turn.cpu, cpuClockStepMs);
}

/** The rule of turnBlockedMs, which the watcher also keeps turns by before it knows their collections. */
function blockedMs(wallMs: number, usedCpuMs: number, cpuClockStepMs: number): number {
	if (usedCpuMs === 0) return 0;
	return Math.max(0, Math.min(wallMs, usedCpuMs + cpuClockStepMs));
}

/** Raises this process's priority so other processes rarely take the CPU from a watched turn; returns the undo. */
function raiseProcessPriority(): () => void {
	const before = getPriority();
	if (before <= osConstants.priority.PRIORITY_HIGH) return () => {};
	try {
		setPriority(osConstants.priority.PRIORITY_HIGH);
	} catch {
		return () => {};
	}
	return () => setPriority(before);
}

/**
 * Starts watching the event loop's turns at raised priority. The returned stop function restores the priority and
 * reports how long each turn that could have passed `keepOverMs` held the event loop.
 */
export function watchEventLoopTurns(keepOverMs: number): () => Promise<WatchedTurns> {
	const restorePriority = raiseProcessPriority();
	const turns: WatchedTurn[] = [];
	let count = 0;
	const collections: Interval[] = [];
	const collected = (entries: readonly PerformanceEntry[]) => {
		for (const entry of entries) collections.push({ start: entry.startTime, end: entry.startTime + entry.duration });
	};
	const observer = new PerformanceObserver((list) => collected(list.getEntries()));
	observer.observe({ entryTypes: ["gc"] });
	let watching = true;
	let last = performance.now();
	let lastCpu = cpuMs();
	const turn = () => {
		const now = performance.now();
		const cpu = cpuMs();
		count++;
		// Only retain a turn that could fail an assertion, even before subtracting collection pauses. A worker can
		// leave millions of idle turns here; retaining each one makes the measurement itself allocate and stall.
		if (blockedMs(now - last, cpu - lastCpu, CPU_CLOCK_STEP_MS) > keepOverMs)
			turns.push({ start: last, end: now, cpu: cpu - lastCpu });
		if (watching) setImmediate(turn);
		// The collector's own allocation and scheduling are not work done by history://.
		last = performance.now();
		lastCpu = cpuMs();
	};
	setImmediate(turn);
	return async () => {
		try {
			watching = false;
			turn();
			await new Promise((resolve) => setTimeout(resolve, 20));
			collected(observer.takeRecords());
			observer.disconnect();
			return {
				count,
				keptOverMs: keepOverMs,
				blockedMs: turns.map((item) => turnBlockedMs(item, collections, CPU_CLOCK_STEP_MS)),
			};
		} finally {
			restorePriority();
		}
	};
}

/** Fails when more than a few watched turns held the event loop past `limitMs`, or any one held it far too long. */
export function assertFewStalls(turns: WatchedTurns, limitMs: number, what: string): void {
	assert.ok(limitMs >= turns.keptOverMs, `the watcher kept only turns over ${turns.keptOverMs} ms, not ${limitMs} ms`);
	const stalls = turns.blockedMs.filter((ms) => ms > limitMs).sort((a, b) => b - a);
	assert.ok(
		stalls.length <= STALLS_ALLOWED && (stalls[0] ?? 0) < STALL_CEILING_MS,
		`${what} held the event loop for more than ${limitMs} ms ${stalls.length} times in ${turns.count} turns: ${stalls.slice(0, 8).map(Math.round).join(", ")} ms`,
	);
}
