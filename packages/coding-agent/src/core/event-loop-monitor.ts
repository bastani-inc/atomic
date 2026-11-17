/**
 * The opt-in event-loop block diagnostic.
 *
 * With `ATOMIC_EVENT_LOOP_BLOCK_MS` set to a positive whole number of milliseconds, the interactive host and its
 * isolated engine each append JSON lines to one file (`ATOMIC_EVENT_LOOP_BLOCK_LOG`, or `event-loop-blocks.jsonl` in
 * the agent directory):
 * - `start`: the process started watching its event loop;
 * - `block`: the event loop turned that many milliseconds or more after it was due, with the stacks of the code that
 *   held it;
 * - `delay`: the process's event-loop delay (p50, p99, max) over each phase of its life: its startup, written once it
 *   is ready for input; its session, written once it starts to quit; and its shutdown, written as it exits. A process
 *   that never becomes ready, or is ended before it can quit (as Windows ends the engine), writes the phase it was in
 *   as far as it got.
 *
 * Unset, nothing here runs: no timer, worker, profiler or histogram.
 *
 * A heartbeat timer on the main thread finds the blocks: the event loop was blocked for however much later than its
 * interval a beat runs. Stacks come from the runtime's inspector:
 * - Node: a worker thread reads the beat's timestamp from shared memory. Once it is a threshold late, the worker
 *   attaches an inspector session to the main thread and pauses it every few milliseconds until the block ends,
 *   taking the stack each time, then detaches. The debugger is attached only while a block lasts, because attached it
 *   makes every `await` several times slower; attaching it takes the main thread tens of milliseconds, inside the
 *   block it is reporting.
 * - Bun: Bun cannot pause the main thread from a worker, so the main thread keeps a sampling CPU profile, restarted
 *   every few seconds to bound its memory, and reads the samples taken during a block once the block ends.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { Profiler, Session } from "node:inspector";
import { dirname, join, resolve } from "node:path";
import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { getAgentDir, isBunRuntime } from "../config.js";
import { createModuleRequire } from "../utils/module-require.ts";

export const EVENT_LOOP_BLOCK_MS_ENV = "ATOMIC_EVENT_LOOP_BLOCK_MS";
export const EVENT_LOOP_BLOCK_LOG_ENV = "ATOMIC_EVENT_LOOP_BLOCK_LOG";
/** The log's name in the agent directory when `ATOMIC_EVENT_LOOP_BLOCK_LOG` is unset. */
export const EVENT_LOOP_BLOCK_LOG_NAME = "event-loop-blocks.jsonl";

/** The process that draws the terminal UI (and, without an isolated engine, also runs the agent), or the engine. */
export type EventLoopProcessRole = "host" | "engine";

/** How a process's records get their stacks. */
export type EventLoopStackSource = "debugger" | "profiler" | "unavailable";

/** One stack the blocking code was seen in, innermost frame first, and how many samples saw it. */
export interface EventLoopBlockStack {
	readonly count: number;
	readonly frames: readonly string[];
}

/** A frame and how many of a block's samples passed through it. */
export interface EventLoopHotFrame {
	readonly count: number;
	readonly frame: string;
}

/** The phases a process's event-loop delay is recorded in. */
export type EventLoopPhase = "startup" | "session" | "shutdown";

/** A process's event-loop delay over one phase of its life, in milliseconds past each due turn. */
export interface EventLoopDelaySummary {
	readonly durationMs: number;
	readonly ticks: number;
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
}

interface RecordBase {
	/** When the record's subject began (a block: when the loop was due to turn), as an ISO timestamp. */
	readonly at: string;
	readonly role: EventLoopProcessRole;
	readonly pid: number;
}

export type EventLoopRecord =
	| (RecordBase & {
			readonly type: "start";
			readonly runtime: "node" | "bun";
			readonly thresholdMs: number;
			readonly stacks: EventLoopStackSource;
	  })
	| (RecordBase & {
			readonly type: "block";
			readonly durationMs: number;
			readonly thresholdMs: number;
			/** Stack samples taken during the block. */
			readonly samples: number;
			/** The frames most samples passed through, the most specific first among equals: where the time went. */
			readonly hotFrames: readonly EventLoopHotFrame[];
			/** The most frequent identical stacks. */
			readonly stacks: readonly EventLoopBlockStack[];
	  })
	| (RecordBase & { readonly type: "delay"; readonly phase: EventLoopPhase } & EventLoopDelaySummary);

/** How often the main thread stamps the heartbeat. A blocked loop delays the next beat by as long as it is blocked. */
const HEARTBEAT_MS = 20;
/** How often the Node watchdog worker checks the heartbeat. */
const WATCH_POLL_MS = 10;
/** Time between two stack samples of one block on Node; each pause holds the main thread for about a millisecond. */
const STACK_SAMPLE_INTERVAL_MS = 20;
/** Samples taken of one block at most, so a block of minutes costs no more than one of seconds. */
const MAX_STACK_SAMPLES = 50;
/**
 * Frames kept at each end of a deeper stack: the innermost say what ran, the outermost what started it (a module
 * load, a timer, a message handler).
 */
const STACK_END_FRAMES = 12;
/** Distinct stacks kept in a block record, most frequent first. */
const MAX_BLOCK_STACKS = 3;
/** Hot frames kept in a block record. */
const MAX_HOT_FRAMES = 10;
/**
 * How long the main thread waits for the Node worker's samples of a block it found. The worker posts them as soon as
 * it sees the next beat, so they arrive within a beat or two; a starved worker that never noticed the block sends
 * none, and the record is written without stacks.
 */
const BLOCK_SAMPLES_GRACE_MS = 1_000;
/**
 * Bun's profile sampling interval. A block at the smallest useful threshold of tens of milliseconds still gets tens of
 * samples, at a few percent of CPU while JavaScript runs (1 ms cost about twice as much); an idle loop takes none.
 */
const PROFILE_SAMPLING_INTERVAL_US = 2_000;
/** Bun's profile is restarted this often, so it holds a few seconds of samples at most. */
const PROFILE_WINDOW_MS = 5_000;
/** The delay histogram's sampling interval, Node's default. */
const DELAY_RESOLUTION_MS = 10;

/** The threshold `env` sets: a positive whole number of milliseconds, or nothing. */
export function eventLoopBlockThresholdMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[EVENT_LOOP_BLOCK_MS_ENV]?.trim();
	if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
	const thresholdMs = Number(raw);
	return thresholdMs > 0 && Number.isSafeInteger(thresholdMs) ? thresholdMs : undefined;
}

/** The log `env` selects; a relative path resolves against `cwd`. */
export function eventLoopBlockLogPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	const named = env[EVENT_LOOP_BLOCK_LOG_ENV]?.trim();
	return named ? resolve(cwd, named) : join(getAgentDir(), EVENT_LOOP_BLOCK_LOG_NAME);
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

/** A stack frame as `Error.stack` names it, from 0-based line and column numbers. */
export function formatStackFrame(functionName: string, url: string, lineNumber: number, columnNumber: number): string {
	const name = functionName || "(anonymous)";
	return url ? `${name} (${url}:${lineNumber + 1}:${columnNumber + 1})` : name;
}

/** A stack, innermost frame first, with only `STACK_END_FRAMES` kept at each end when it is deeper than both. */
export function trimStack(frames: readonly string[]): string[] {
	if (frames.length <= STACK_END_FRAMES * 2) return [...frames];
	const omitted = frames.length - STACK_END_FRAMES * 2;
	return [...frames.slice(0, STACK_END_FRAMES), `… ${omitted} frames …`, ...frames.slice(-STACK_END_FRAMES)];
}

/** Groups identical stacks, most frequent first, keeping the first `MAX_BLOCK_STACKS`. */
export function summarizeStacks(samples: readonly (readonly string[])[]): EventLoopBlockStack[] {
	const counts = new Map<string, EventLoopBlockStack>();
	for (const frames of samples) {
		const key = frames.join("\n");
		counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, frames });
	}
	return [...counts.values()].sort((left, right) => right.count - left.count).slice(0, MAX_BLOCK_STACKS);
}

/**
 * The frames the most samples passed through, keeping the first `MAX_HOT_FRAMES`. Among frames every sample passed
 * through, the innermost is the most specific answer to what held the loop, so equal counts order by depth.
 */
export function hotFrames(samples: readonly (readonly string[])[]): EventLoopHotFrame[] {
	const frames = new Map<string, { count: number; depth: number }>();
	for (const stack of samples) {
		for (const [depth, frame] of [...new Set(stack)].entries()) {
			if (frame.startsWith("… ")) continue;
			const seen = frames.get(frame);
			frames.set(frame, { count: (seen?.count ?? 0) + 1, depth: (seen?.depth ?? 0) + depth });
		}
	}
	return [...frames.entries()]
		.sort(([, left], [, right]) => right.count - left.count || left.depth / left.count - right.depth / right.count)
		.slice(0, MAX_HOT_FRAMES)
		.map(([frame, { count }]) => ({ count, frame }));
}

/**
 * The stacks of the samples `profile` took between `fromUs` and `untilUs`, innermost frame first. Bun's profile times
 * are epoch microseconds, as `performance.timeOrigin + performance.now()` reads them.
 */
export function profileStacksBetween(profile: Profiler.Profile, fromUs: number, untilUs: number): string[][] {
	const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
	const parents = new Map<number, number>();
	for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
	const stacks: string[][] = [];
	const samples = profile.samples ?? [];
	let at = profile.startTime;
	for (let index = 0; index < samples.length; index++) {
		at += profile.timeDeltas?.[index] ?? 0;
		if (at < fromUs || at > untilUs) continue;
		const frames: string[] = [];
		for (let id: number | undefined = samples[index]; id !== undefined; id = parents.get(id)) {
			const node = nodes.get(id);
			if (node === undefined || parents.get(id) === undefined) break;
			const { functionName, url, lineNumber, columnNumber } = node.callFrame;
			frames.push(formatStackFrame(functionName, url, lineNumber, columnNumber));
		}
		stacks.push(trimStack(frames));
	}
	return stacks;
}

/** A frame the Node worker read from a paused main thread: function name, script URL, 0-based line and column. */
type WorkerFrame = readonly [string, string, number, number];

interface WorkerBlockSamples {
	/** The heartbeat stamp, epoch microseconds, the block followed. */
	readonly sinceUs: number;
	readonly samples: readonly (readonly WorkerFrame[])[];
}

/** Slots of the Int32 state the Node main thread and its watchdog share. */
const WatchdogState = {
	/** Set by the main thread as it exits: the watchdog detaches and starts nothing more. */
	Exiting: 0,
	/** Set by the watchdog while its inspector session is attached to the main thread. */
	Attached: 1,
} as const;

/**
 * How long an exiting Node process waits for its watchdog to detach. Node prints "Waiting for the debugger to
 * disconnect..." to stderr (the terminal) when a process exits with an inspector session attached, as it is when the
 * process exits inside a block the watchdog is sampling. The watchdog checks every `WATCH_POLL_MS`.
 */
const DETACH_ON_EXIT_MS = 100;

/**
 * The Node watchdog worker, evaluated as CommonJS so it needs no file of its own in any install layout. It reads the
 * main thread's heartbeat stamp; once the stamp is a threshold late it attaches the debugger to the main thread and
 * pauses it every `sampleIntervalMs` for its stack, and when the next beat arrives it detaches and posts the stacks.
 * A sample taken once the heartbeat has moved on belongs to later code, and is dropped.
 */
const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Session } = require("node:inspector");
const { heartbeatMs, thresholdMs, pollMs, sampleIntervalMs, maxSamples } = workerData;
const stamp = new BigInt64Array(workerData.stamp);
const state = new Int32Array(workerData.state);
const readStamp = () => Number(Atomics.load(stamp, 0));
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;
let block;
function begin(sinceUs) {
	const session = new Session();
	session.connectToMainThread();
	Atomics.store(state, ${WatchdogState.Attached}, 1);
	const urls = new Map();
	const current = { sinceUs, session, samples: [], pausing: false, nextPauseUs: 0 };
	session.on("Debugger.scriptParsed", ({ params }) => urls.set(params.scriptId, params.url));
	session.on("Debugger.paused", ({ params }) => {
		session.post("Debugger.resume");
		if (block === current && readStamp() === sinceUs) {
			current.samples.push(params.callFrames.map((frame) => [
				frame.functionName,
				frame.url || urls.get(frame.location.scriptId) || "",
				frame.location.lineNumber,
				frame.location.columnNumber ?? 0,
			]));
		}
		current.pausing = false;
		current.nextPauseUs = nowUs() + sampleIntervalMs * 1000;
	});
	session.post("Debugger.enable");
	return current;
}
function detach() {
	block.session.disconnect();
	Atomics.store(state, ${WatchdogState.Attached}, 0);
	const ended = block;
	block = undefined;
	return ended;
}
setInterval(() => {
	if (Atomics.load(state, ${WatchdogState.Exiting}) === 1) {
		if (block !== undefined) detach();
		return;
	}
	const sinceUs = readStamp();
	if (block !== undefined && sinceUs !== block.sinceUs) {
		const ended = detach();
		parentPort.postMessage({ sinceUs: ended.sinceUs, samples: ended.samples });
	}
	if (block === undefined) {
		if (sinceUs === 0 || (nowUs() - sinceUs) / 1000 - heartbeatMs < thresholdMs) return;
		block = begin(sinceUs);
	}
	if (!block.pausing && block.samples.length < maxSamples && nowUs() >= block.nextPauseUs) {
		block.pausing = true;
		block.session.post("Debugger.pause");
	}
}, pollMs);
`;

/** Where a block's stacks come from. */
interface StackSampler {
	readonly source: EventLoopStackSource;
	/** The stacks sampled between the beat at `sinceUs` and the one at `untilUs` that followed the block. */
	stacksOf(sinceUs: number, untilUs: number): Promise<readonly (readonly string[])[]>;
	/** Called on every heartbeat with the time it ran. */
	beat(nowUs: number): void;
	/** Called as the process exits. */
	exit(): void;
}

/** Node: the watchdog worker samples the main thread while a block lasts. */
class DebuggerSampler implements StackSampler {
	readonly source = "debugger";
	private readonly stamp = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
	private readonly state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
	private readonly arrived = new Map<number, readonly (readonly string[])[]>();
	private readonly waiting = new Map<number, (stacks: readonly (readonly string[])[]) => void>();

	constructor(thresholdMs: number) {
		const worker = new Worker(WATCHDOG_SOURCE, {
			eval: true,
			workerData: {
				stamp: this.stamp.buffer,
				state: this.state.buffer,
				heartbeatMs: HEARTBEAT_MS,
				thresholdMs,
				pollMs: WATCH_POLL_MS,
				sampleIntervalMs: STACK_SAMPLE_INTERVAL_MS,
				maxSamples: MAX_STACK_SAMPLES,
			},
		});
		worker.on("message", ({ sinceUs, samples }: WorkerBlockSamples) => {
			const stacks = samples.map((frames) => trimStack(frames.map((frame) => formatStackFrame(...frame))));
			const waiter = this.waiting.get(sinceUs);
			if (waiter === undefined) this.arrived.set(sinceUs, stacks);
			else waiter(stacks);
		});
		// A watchdog that fails costs the records their stacks, never the process.
		worker.on("error", () => {});
		// After the listeners: adding a message listener to an unreferenced worker references it again.
		worker.unref();
	}

	beat(nowUs: number): void {
		Atomics.store(this.stamp, 0, BigInt(nowUs));
		// Samples of a block the main thread measured under the threshold (the clocks differ by a little) are never asked for.
		for (const sinceUs of this.arrived.keys()) {
			if (nowUs - sinceUs > BLOCK_SAMPLES_GRACE_MS * 1000) this.arrived.delete(sinceUs);
		}
	}

	exit(): void {
		Atomics.store(this.state, WatchdogState.Exiting, 1);
		const deadline = performance.now() + DETACH_ON_EXIT_MS;
		// A busy wait in JavaScript, not Atomics.wait: the detach is carried out by this thread, between statements.
		while (Atomics.load(this.state, WatchdogState.Attached) === 1 && performance.now() < deadline) {}
	}

	stacksOf(sinceUs: number): Promise<readonly (readonly string[])[]> {
		const arrived = this.arrived.get(sinceUs);
		if (arrived !== undefined) {
			this.arrived.delete(sinceUs);
			return Promise.resolve(arrived);
		}
		return new Promise((settle) => {
			const timer = setTimeout(() => done([]), BLOCK_SAMPLES_GRACE_MS);
			timer.unref();
			const done = (stacks: readonly (readonly string[])[]) => {
				clearTimeout(timer);
				this.waiting.delete(sinceUs);
				settle(stacks);
			};
			this.waiting.set(sinceUs, done);
		});
	}
}

/** Bun: a rolling sampling profile of the main thread, read once a block has ended. */
class ProfileSampler implements StackSampler {
	readonly source = "profiler";
	private startedUs = 0;
	/** Profile stops and restarts, one at a time. */
	private queue: Promise<unknown> = Promise.resolve();

	private readonly session: Session;

	constructor(session: Session, nowUs: number) {
		this.session = session;
		session.post("Profiler.enable");
		session.post("Profiler.setSamplingInterval", { interval: PROFILE_SAMPLING_INTERVAL_US });
		this.restart(nowUs);
	}

	beat(nowUs: number): void {
		if (nowUs - this.startedUs < PROFILE_WINDOW_MS * 1000) return;
		this.startedUs = nowUs;
		this.queue = this.queue.then(() => this.stop()).then(() => this.restart(nowUs));
	}

	stacksOf(sinceUs: number, untilUs: number): Promise<readonly (readonly string[])[]> {
		const stacks = this.queue
			.then(() => this.stop())
			.then((profile) => {
				this.restart(untilUs);
				return profile === undefined ? [] : profileStacksBetween(profile, sinceUs, untilUs);
			});
		this.queue = stacks;
		return stacks;
	}

	exit(): void {}

	private restart(nowUs: number): void {
		this.startedUs = nowUs;
		this.session.post("Profiler.start");
	}

	private stop(): Promise<Profiler.Profile | undefined> {
		return new Promise((settle) =>
			this.session.post("Profiler.stop", (error, result) => settle(error ? undefined : result.profile)),
		);
	}
}

/** Without a working inspector, blocks are still recorded, with no stacks. */
const noStacks: StackSampler = {
	source: "unavailable",
	stacksOf: () => Promise.resolve([]),
	beat: () => {},
	exit: () => {},
};

function createSampler(thresholdMs: number, nowUs: number): StackSampler {
	try {
		if (!isBunRuntime) return new DebuggerSampler(thresholdMs);
		const { Session: InspectorSession } = createModuleRequire(import.meta.url)("node:inspector") as {
			Session: typeof Session;
		};
		const session = new InspectorSession();
		session.connect();
		return new ProfileSampler(session, nowUs);
	} catch {
		return noStacks;
	}
}

const epochUs = () => Math.round((performance.timeOrigin + performance.now()) * 1000);

const PHASES: readonly EventLoopPhase[] = ["startup", "session", "shutdown"];

class EventLoopMonitor {
	private readonly histogram: IntervalHistogram;
	private readonly pending: string[] = [];
	private draining: Promise<void> | undefined;
	private readonly sampler: StackSampler;
	private lastBeatUs: number;
	private phase: EventLoopPhase = "startup";
	private phaseStartedUs: number;

	private readonly role: EventLoopProcessRole;
	private readonly thresholdMs: number;
	private readonly logPath: string;

	constructor(role: EventLoopProcessRole, thresholdMs: number, logPath: string) {
		this.role = role;
		this.thresholdMs = thresholdMs;
		this.logPath = logPath;
		this.lastBeatUs = epochUs();
		this.phaseStartedUs = this.lastBeatUs;
		this.histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
		this.histogram.enable();
		this.sampler = createSampler(thresholdMs, this.lastBeatUs);
		this.sampler.beat(this.lastBeatUs);
		setInterval(() => this.beat(), HEARTBEAT_MS).unref();
		process.once("exit", () => {
			this.sampler.exit();
			this.writeAtQuit(this.delayRecord());
		});
		this.write({
			type: "start",
			at: new Date(this.lastBeatUs / 1000).toISOString(),
			role,
			pid: process.pid,
			runtime: isBunRuntime ? "bun" : "node",
			thresholdMs,
			stacks: this.sampler.source,
		});
	}

	/** Writes the phase that ends here and starts `next`, unless the process is already past it. */
	enter(next: EventLoopPhase): void {
		if (PHASES.indexOf(next) <= PHASES.indexOf(this.phase)) return;
		const ended = this.delayRecord();
		if (next === "shutdown") this.writeAtQuit(ended);
		else this.write(ended);
		this.histogram.reset();
		this.phase = next;
		this.phaseStartedUs = epochUs();
	}

	private beat(): void {
		const nowUs = epochUs();
		const sinceUs = this.lastBeatUs;
		this.lastBeatUs = nowUs;
		const durationMs = (nowUs - sinceUs) / 1000 - HEARTBEAT_MS;
		if (durationMs >= this.thresholdMs) {
			void this.sampler.stacksOf(sinceUs, nowUs).then((samples) =>
				this.write({
					type: "block",
					at: new Date(sinceUs / 1000 + HEARTBEAT_MS).toISOString(),
					role: this.role,
					pid: process.pid,
					durationMs: roundMs(durationMs),
					thresholdMs: this.thresholdMs,
					samples: samples.length,
					hotFrames: hotFrames(samples),
					stacks: summarizeStacks(samples),
				}),
			);
		}
		this.sampler.beat(nowUs);
	}

	private delayRecord(): EventLoopRecord {
		// Node records each tick's whole interval, Bun only how late it was.
		const lagMs = (nanoseconds: number) =>
			roundMs(Math.max(0, nanoseconds / 1e6 - (isBunRuntime ? 0 : DELAY_RESOLUTION_MS)));
		const ticks = this.histogram.count;
		return {
			type: "delay",
			at: new Date(this.phaseStartedUs / 1000).toISOString(),
			role: this.role,
			pid: process.pid,
			phase: this.phase,
			durationMs: roundMs((epochUs() - this.phaseStartedUs) / 1000),
			ticks,
			p50Ms: ticks === 0 ? 0 : lagMs(this.histogram.percentile(50)),
			p99Ms: ticks === 0 ? 0 : lagMs(this.histogram.percentile(99)),
			maxMs: ticks === 0 ? 0 : lagMs(this.histogram.max),
		};
	}

	/** Records written while the session runs: appended in order without blocking the loop they measure. */
	private write(record: EventLoopRecord): void {
		this.pending.push(`${JSON.stringify(record)}\n`);
		if (this.draining === undefined) this.draining = this.drain();
	}

	private async drain(): Promise<void> {
		while (this.pending.length > 0) {
			const chunk = this.pending.splice(0).join("");
			try {
				await appendFile(this.logPath, chunk);
			} catch {
				// The log was writable at start; a later failure loses those records, never the session.
			}
		}
		this.draining = undefined;
	}

	/**
	 * Records written as the process quits, synchronously: Windows ends the engine as soon as its host quits, before an
	 * asynchronous write could land. Anything still queued is written first, in order.
	 */
	private writeAtQuit(record: EventLoopRecord): void {
		const chunk = [...this.pending.splice(0), `${JSON.stringify(record)}\n`].join("");
		try {
			appendFileSync(this.logPath, chunk);
		} catch {
			// As above: a lost record, never a lost session.
		}
	}
}

let monitor: EventLoopMonitor | undefined;

/**
 * Starts the event-loop block diagnostic in this process when `ATOMIC_EVENT_LOOP_BLOCK_MS` asks for it, and returns
 * whether it did. Otherwise it returns false having started nothing. A relative `ATOMIC_EVENT_LOOP_BLOCK_LOG` is made
 * absolute in this process's environment, so an engine started in another directory writes to the same file.
 */
export function startEventLoopMonitor(role: EventLoopProcessRole, env: NodeJS.ProcessEnv = process.env): boolean {
	if (monitor !== undefined) return true;
	const thresholdMs = eventLoopBlockThresholdMs(env);
	if (thresholdMs === undefined) return false;
	const logPath = eventLoopBlockLogPath(env);
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, "");
	} catch (error) {
		console.warn(
			`The event-loop block log ${logPath} cannot be written, so blocks are not recorded: ${String(error)}`,
		);
		return false;
	}
	if (env[EVENT_LOOP_BLOCK_LOG_ENV]?.trim()) env[EVENT_LOOP_BLOCK_LOG_ENV] = logPath;
	monitor = new EventLoopMonitor(role, thresholdMs, logPath);
	return true;
}

/** Ends the startup phase of the event-loop delay record: the process is ready for input. */
export function markEventLoopStartupComplete(): void {
	monitor?.enter("session");
}

/**
 * Ends the session phase of the event-loop delay record: the process has started to quit. The engine calls it when the
 * host announces a quit, because Windows ends the engine without letting it exit on its own.
 */
export function markEventLoopShutdown(): void {
	monitor?.enter("shutdown");
}
