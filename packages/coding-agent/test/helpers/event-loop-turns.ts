/**
 * Watches the event loop's turns while history:// work runs, and reports how long each turn held the event loop, so
 * a test can bound the work's blocking per turn on every platform.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector";
import { availableParallelism, getPriority, constants as osConstants, setPriority } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";

/** A watched run may pass its limit this many times: a collection or the scheduler can stretch a few turns. */
const STALLS_ALLOWED = 3;
/** No turn may hold the event loop this long, however few do. */
const STALL_CEILING_MS = 100;
/** How often the JS stack is sampled once a watch has failed (microseconds). */
const STACK_SAMPLING_INTERVAL_US = 1000;
/** Frames of a stalled turn's commonest JS stack that a failure shows, innermost first. */
const STACK_FRAMES_SHOWN = 8;
/** Stalled turns a failure describes, longest first. */
const STALLS_DESCRIBED = 8;

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

/** A turn the watcher kept, and what it was made of, so a failure can say why the turn counted. */
export interface KeptTurn {
	/** When the turn started, in milliseconds since the watch started. */
	readonly atMs: number;
	readonly wallMs: number;
	/** The CPU time the thread's clock charged the turn. */
	readonly cpuMs: number;
	/** The part of the turn's wall time spent in garbage collections. */
	readonly collectedMs: number;
	/** How long the turn held the event loop; see `turnBlockedMs`. */
	readonly blockedMs: number;
	/**
	 * The JS stack sampled most often during the turn, innermost frame first. Only turns after the watch had already
	 * failed have one: sampling starts then, so it can never change whether a watch passes.
	 */
	readonly stack?: readonly string[];
}

/** The machine the watch ran on, as the watch saw it: whether the thread got the CPU, and how busy the process was. */
export interface WatchWindow {
	readonly wallMs: number;
	/** CPU time the watching thread was charged over the window. */
	readonly threadCpuMs: number;
	/** CPU time all the process's threads were charged over the window. */
	readonly processCpuMs: number;
	/** When stack sampling began, in milliseconds since the watch started, if the watch failed while it ran. */
	readonly sampledFromMs?: number;
}

export interface WatchedTurns {
	readonly count: number;
	/** Turns shorter than this were not kept, so no limit below it can be checked. */
	readonly keptOverMs: number;
	readonly blockedMs: readonly number[];
	/** The kept turns in the order they ran; `blockedMs` holds their `blockedMs`. */
	readonly kept: readonly KeptTurn[];
	readonly window: WatchWindow;
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

interface ProfileNode {
	readonly id: number;
	readonly callFrame: {
		readonly functionName: string;
		readonly url: string;
		readonly lineNumber: number;
	};
	readonly children?: readonly number[];
}

interface Profile {
	readonly nodes: readonly ProfileNode[];
	readonly startTime: number;
	readonly samples?: readonly number[];
	readonly timeDeltas?: readonly number[];
}

/** Samples this thread's JS stack from the moment it starts, for the turns a failed watch goes on to keep. */
class StackSampler {
	private readonly session = new Session();
	/** `performance.now()` when the profile started: the profile's own clock counts from there. */
	readonly startedAt: number;

	constructor() {
		this.session.connect();
		this.session.post("Profiler.enable");
		this.session.post("Profiler.setSamplingInterval", { interval: STACK_SAMPLING_INTERVAL_US });
		this.session.post("Profiler.start");
		this.startedAt = performance.now();
	}

	/** Stops sampling and returns, for each turn, the stack sampled most often during it. */
	stop(turns: readonly Interval[]): Promise<(readonly string[] | undefined)[]> {
		return new Promise((resolve) => {
			this.session.post("Profiler.stop", (error, result) => {
				this.session.disconnect();
				resolve(error ? turns.map(() => undefined) : this.stacks(result.profile as Profile, turns));
			});
		});
	}

	private stacks(profile: Profile, turns: readonly Interval[]): (readonly string[] | undefined)[] {
		const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
		const parents = new Map<number, number>();
		for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
		const stackOf = (id: number): string[] => {
			const frames: string[] = [];
			for (let at: number | undefined = id; at !== undefined && frames.length < STACK_FRAMES_SHOWN; ) {
				const frame = nodes.get(at)?.callFrame;
				if (frame === undefined || frame.functionName === "(root)") break;
				const file = frame.url.split(/[\\/]/).at(-1);
				frames.push(
					file ? `${frame.functionName || "(anonymous)"} (${file}:${frame.lineNumber + 1})` : frame.functionName,
				);
				at = parents.get(at);
			}
			return frames;
		};
		// The profile counts microseconds from when it started, which `startedAt` marks on this watch's clock.
		const times: number[] = [];
		let time = profile.startTime;
		for (const delta of profile.timeDeltas ?? []) {
			time += delta;
			times.push(this.startedAt + (time - profile.startTime) / 1000);
		}
		const samples = profile.samples ?? [];
		return turns.map((turn) => {
			const counts = new Map<number, number>();
			for (let index = 0; index < samples.length; index++) {
				const at = times[index]!;
				if (at < turn.start || at > turn.end) continue;
				const id = samples[index]!;
				const name = nodes.get(id)?.callFrame.functionName;
				if (name === "(idle)" || name === "(program)") continue;
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
			let commonest: number | undefined;
			for (const [id, count] of counts)
				if (commonest === undefined || count > counts.get(commonest)!) commonest = id;
			return commonest === undefined ? undefined : stackOf(commonest);
		});
	}
}

/**
 * Starts watching the event loop's turns at raised priority. The returned stop function restores the priority and
 * reports how long each turn that could have passed `keepOverMs` held the event loop.
 *
 * Once the turns seen so far already fail `assertFewStalls` at `failOverMs` (more than {@link STALLS_ALLOWED} over
 * it, or one at {@link STALL_CEILING_MS}), the watcher starts sampling the JS stack, so the failure can name the code
 * that held the later stalled turns. Before then it samples nothing: a watch that passes pays nothing for it, and no
 * sampling can tip a watch into failing. Pass `failOverMs` when the assertion will use a limit above `keepOverMs`.
 */
export function watchEventLoopTurns(keepOverMs: number, failOverMs = keepOverMs): () => Promise<WatchedTurns> {
	const restorePriority = raiseProcessPriority();
	const turns: WatchedTurn[] = [];
	let count = 0;
	const collections: Interval[] = [];
	const collected = (entries: readonly PerformanceEntry[]) => {
		for (const entry of entries) collections.push({ start: entry.startTime, end: entry.startTime + entry.duration });
	};
	const observer = new PerformanceObserver((list) => collected(list.getEntries()));
	observer.observe({ entryTypes: ["gc"] });
	// Kept turns from `judged` on have not been checked against `failOverMs` yet; see `judge`.
	let judged = 0;
	let overLimit = 0;
	let sampler: StackSampler | undefined;
	/**
	 * Checks the kept turns of earlier turns against `failOverMs`, starting the sampler once they fail the watch. A
	 * collection's entry reaches the observer only after the turn it ran in, so a kept turn is judged a turn later,
	 * when its collections are known and its blocking is what the stop function will report.
	 */
	const judge = () => {
		collected(observer.takeRecords());
		for (; judged < turns.length; judged++) {
			const blocked = turnBlockedMs(turns[judged]!, collections, CPU_CLOCK_STEP_MS);
			if (blocked > failOverMs) overLimit++;
			if (sampler === undefined && (overLimit > STALLS_ALLOWED || blocked >= STALL_CEILING_MS)) {
				try {
					sampler = new StackSampler();
				} catch {
					// Stacks are a diagnostic: a watch without them still counts its turns.
				}
			}
		}
	};
	let watching = true;
	const startedAt = performance.now();
	const startedThreadCpu = cpuMs();
	const startedProcessCpu = process.cpuUsage();
	let last = startedAt;
	let lastCpu = startedThreadCpu;
	const turn = () => {
		const now = performance.now();
		const cpu = cpuMs();
		count++;
		if (judged < turns.length) judge();
		// Only retain a turn that could fail an assertion, even before subtracting collection pauses. A worker can
		// leave millions of idle turns here; retaining each one makes the measurement itself allocate and stall.
		if (blockedMs(now - last, cpu - lastCpu, CPU_CLOCK_STEP_MS) > keepOverMs)
			turns.push({ start: last, end: now, cpu: cpu - lastCpu });
		if (watching) setImmediate(turn);
		// The collector's own allocation and scheduling, and starting the sampler, are not work done by history://.
		last = performance.now();
		lastCpu = cpuMs();
	};
	setImmediate(turn);
	return async () => {
		try {
			watching = false;
			turn();
			const wallMs = performance.now() - startedAt;
			const threadCpuMs = cpuMs() - startedThreadCpu;
			const processCpu = process.cpuUsage(startedProcessCpu);
			await new Promise((resolve) => setTimeout(resolve, 20));
			collected(observer.takeRecords());
			observer.disconnect();
			const stacks = (await sampler?.stop(turns)) ?? [];
			const kept = turns.map(
				(item, index): KeptTurn => ({
					atMs: item.start - startedAt,
					wallMs: item.end - item.start,
					cpuMs: item.cpu,
					collectedMs: overlapMs(item, collections),
					blockedMs: turnBlockedMs(item, collections, CPU_CLOCK_STEP_MS),
					...(stacks[index] === undefined ? {} : { stack: stacks[index] }),
				}),
			);
			return {
				count,
				keptOverMs: keepOverMs,
				blockedMs: kept.map((item) => item.blockedMs),
				kept,
				window: {
					wallMs,
					threadCpuMs,
					processCpuMs: (processCpu.user + processCpu.system) / 1000,
					...(sampler === undefined ? {} : { sampledFromMs: sampler.startedAt - startedAt }),
				},
			};
		} finally {
			restorePriority();
		}
	};
}

function describeStall(turn: KeptTurn): string {
	const made = `blocked ${Math.round(turn.blockedMs)} ms of ${Math.round(turn.wallMs)} ms wall, ${Math.round(turn.cpuMs)} ms on the CPU, ${Math.round(turn.collectedMs)} ms collecting`;
	const stack = turn.stack === undefined ? "" : `\n      ${turn.stack.join("\n      <- ")}`;
	return `  at +${Math.round(turn.atMs)} ms: ${made}${stack}`;
}

function describeWindow(window: WatchWindow): string {
	const percent = (part: number) => Math.round((100 * part) / Math.max(window.wallMs, 1));
	const sampling =
		window.sampledFromMs === undefined
			? "no JS stacks were sampled"
			: `JS stacks sampled from +${Math.round(window.sampledFromMs)} ms, once the watch had failed`;
	return (
		`window: ${Math.round(window.wallMs)} ms; main thread on the CPU ${percent(window.threadCpuMs)}% of it; ` +
		`process ${percent(window.processCpuMs)}% of one CPU, of ${availableParallelism()}; ` +
		`CPU clock step ${CPU_CLOCK_STEP_MS.toFixed(3)} ms; ${sampling}`
	);
}

/** Fails when more than a few watched turns held the event loop past `limitMs`, or any one held it far too long. */
export function assertFewStalls(turns: WatchedTurns, limitMs: number, what: string): void {
	assert.ok(limitMs >= turns.keptOverMs, `the watcher kept only turns over ${turns.keptOverMs} ms, not ${limitMs} ms`);
	const stalls = turns.blockedMs.filter((ms) => ms > limitMs).sort((a, b) => b - a);
	if (stalls.length <= STALLS_ALLOWED && (stalls[0] ?? 0) < STALL_CEILING_MS) return;
	const described = turns.kept
		.filter((turn) => turn.blockedMs > limitMs)
		.sort((a, b) => b.blockedMs - a.blockedMs)
		.slice(0, STALLS_DESCRIBED);
	assert.fail(
		`${what} held the event loop for more than ${limitMs} ms ${stalls.length} times in ${turns.count} turns: ${stalls.slice(0, 8).map(Math.round).join(", ")} ms\n` +
			`stalled turns, longest first:\n${described.map(describeStall).join("\n")}\n${describeWindow(turns.window)}`,
	);
}
