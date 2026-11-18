import { appendFileSync, mkdirSync } from "node:fs";
import type { Profiler, Session } from "node:inspector";
import { dirname, join, resolve } from "node:path";
import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { getAgentDir, isBunRuntime } from "../config.js";
import { createModuleRequire } from "../utils/module-require.js";
import { DiagnosticWriter } from "./diagnostic-writer.ts";

export const EVENT_LOOP_BLOCK_MS_ENV = "ATOMIC_EVENT_LOOP_BLOCK_MS";
export const EVENT_LOOP_BLOCK_LOG_ENV = "ATOMIC_EVENT_LOOP_BLOCK_LOG";
export const EVENT_LOOP_BLOCK_LOG_NAME = "event-loop-blocks.jsonl";

export type EventLoopProcessRole = "host" | "engine";

export type EventLoopStackSource = "debugger" | "profiler" | "unavailable";

export interface EventLoopBlockStack {
	readonly count: number;
	readonly frames: readonly string[];
}

export interface EventLoopHotFrame {
	readonly count: number;
	readonly frame: string;
}

export type EventLoopPhase = "startup" | "session" | "shutdown";

export interface EventLoopDelaySummary {
	readonly durationMs: number;
	readonly ticks: number;
	readonly p50Ms: number;
	readonly p99Ms: number;
	readonly maxMs: number;
}

interface RecordBase {
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
			readonly samples: number;
			readonly hotFrames: readonly EventLoopHotFrame[];
			readonly stacks: readonly EventLoopBlockStack[];
	  })
	| (RecordBase & { readonly type: "delay"; readonly phase: EventLoopPhase } & EventLoopDelaySummary);

const HEARTBEAT_MS = 20;
const WATCH_POLL_MS = 10;
const STACK_SAMPLE_INTERVAL_MS = 20;
const MAX_STACK_SAMPLES = 50;
const STACK_END_FRAMES = 12;
const MAX_BLOCK_STACKS = 3;
const MAX_HOT_FRAMES = 10;
const BLOCK_SAMPLES_GRACE_MS = 1_000;
const PROFILE_SAMPLING_INTERVAL_US = 2_000;
const PROFILE_WINDOW_MS = 5_000;
const DELAY_RESOLUTION_MS = 10;

export function eventLoopBlockThresholdMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env[EVENT_LOOP_BLOCK_MS_ENV]?.trim();
	if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
	const thresholdMs = Number(raw);
	return thresholdMs > 0 && Number.isSafeInteger(thresholdMs) ? thresholdMs : undefined;
}

export function eventLoopBlockLogPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
	const named = env[EVENT_LOOP_BLOCK_LOG_ENV]?.trim();
	return named ? resolve(cwd, named) : join(getAgentDir(), EVENT_LOOP_BLOCK_LOG_NAME);
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

export function formatStackFrame(functionName: string, url: string, lineNumber: number, columnNumber: number): string {
	const name = functionName || "(anonymous)";
	return url ? `${name} (${url}:${lineNumber + 1}:${columnNumber + 1})` : name;
}

export function trimStack(frames: readonly string[]): string[] {
	if (frames.length <= STACK_END_FRAMES * 2) return [...frames];
	const omitted = frames.length - STACK_END_FRAMES * 2;
	return [...frames.slice(0, STACK_END_FRAMES), `… ${omitted} frames …`, ...frames.slice(-STACK_END_FRAMES)];
}

export function summarizeStacks(samples: readonly (readonly string[])[]): EventLoopBlockStack[] {
	const counts = new Map<string, EventLoopBlockStack>();
	for (const frames of samples) {
		const key = frames.join("\n");
		counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, frames });
	}
	return [...counts.values()].sort((left, right) => right.count - left.count).slice(0, MAX_BLOCK_STACKS);
}

const nodeFunctionFrames = new WeakMap<readonly string[], readonly string[]>();

export function hotFrames(samples: readonly (readonly string[])[]): EventLoopHotFrame[] {
	const frames = new Map<string, { frame: string; count: number; depth: number }>();
	for (const stack of samples) {
		const counted = new Set<string>();
		for (const [depth, frame] of stack.entries()) {
			if (frame.startsWith("… ")) continue;
			const key =
				nodeFunctionFrames.get(stack)?.[depth] ??
				(frame.startsWith("(anonymous)") ? frame : frame.replace(/:\d+:\d+\)$/, ")"));
			if (counted.has(key)) continue;
			counted.add(key);
			const seen = frames.get(key);
			frames.set(key, {
				frame: seen?.frame ?? frame,
				count: (seen?.count ?? 0) + 1,
				depth: (seen?.depth ?? 0) + depth,
			});
		}
	}
	return [...frames.values()]
		.sort((left, right) => right.count - left.count || left.depth / left.count - right.depth / right.count)
		.slice(0, MAX_HOT_FRAMES)
		.map(({ frame, count }) => ({ count, frame }));
}

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

type WorkerFrame = readonly [string, string, number, number, number, number];

interface WorkerBlockSamples {
	readonly sinceUs: number;
	readonly samples: readonly (readonly WorkerFrame[])[];
}

const WatchdogState = {
	Exiting: 0,
	Attached: 1,
} as const;

const DETACH_ON_EXIT_MS = 100;

const WATCHDOG_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { Session } = require("node:inspector");
const { heartbeatMs, thresholdMs, pollMs, sampleIntervalMs, maxSamples } = workerData;
const stamp = new BigInt64Array(workerData.stamp);
const state = new Int32Array(workerData.state);
const readStamp = () => Number(Atomics.load(stamp, 0));
const nowUs = () => (performance.timeOrigin + performance.now()) * 1000;
let block;
let pauseRequest;
let ready = false;
const session = new Session();
const urls = new Map();
Atomics.store(state, ${WatchdogState.Attached}, 1);
if (Atomics.load(state, ${WatchdogState.Exiting}) === 1) {
	Atomics.store(state, ${WatchdogState.Attached}, 0);
	process.exit(0);
}
session.connectToMainThread();
session.on("Debugger.scriptParsed", ({ params }) => urls.set(params.scriptId, params.url));
session.on("Debugger.paused", ({ params }) => {
	const current = pauseRequest;
	if (current === undefined) return;
	pauseRequest = undefined;
	session.post("Debugger.resume");
	if (block === current && readStamp() === current.sinceUs) {
		current.samples.push(params.callFrames.map((frame) => [
			frame.functionName,
			frame.url || urls.get(frame.location.scriptId) || "",
			frame.location.lineNumber,
			frame.location.columnNumber ?? 0,
			frame.functionLocation?.lineNumber ?? frame.location.lineNumber,
			frame.functionLocation?.columnNumber ?? frame.location.columnNumber ?? 0,
		]));
	}
	current.pausing = false;
	current.nextPauseUs = nowUs() + sampleIntervalMs * 1000;
});
// Enabling the debugger walks every loaded script and can itself hold the main thread. Do it once during
// diagnostic startup, not in response to a stall. Do not retain source for scripts the runtime has collected.
session.post("Debugger.enable", { maxScriptsCacheSize: 0 }, (error) => {
	ready = !error;
	parentPort.postMessage({ initialized: true });
});
setInterval(() => {
	if (Atomics.load(state, ${WatchdogState.Exiting}) === 1) {
		if (Atomics.load(state, ${WatchdogState.Attached}) === 1) session.disconnect();
		Atomics.store(state, ${WatchdogState.Attached}, 0);
		return;
	}
	if (!ready) return;
	const sinceUs = readStamp();
	if (block !== undefined && sinceUs !== block.sinceUs) {
		const ended = block;
		block = undefined;
		parentPort.postMessage({ sinceUs: ended.sinceUs, samples: ended.samples });
	}
	if (block === undefined) {
		if (sinceUs === 0 || (nowUs() - sinceUs) / 1000 - heartbeatMs < thresholdMs) return;
		block = { sinceUs, samples: [], pausing: false, nextPauseUs: 0 };
	}
	if (pauseRequest === undefined && !block.pausing && block.samples.length < maxSamples && nowUs() >= block.nextPauseUs) {
		const current = block;
		current.pausing = true;
		pauseRequest = current;
		session.post("Debugger.pause", (error) => {
			if (error && pauseRequest === current) {
				pauseRequest = undefined;
				current.pausing = false;
			}
		});
	}
}, pollMs);
`;

interface StackSampler {
	readonly source: EventLoopStackSource;
	readonly ready?: Promise<void>;
	stacksOf(sinceUs: number, untilUs: number): Promise<readonly (readonly string[])[]>;
	beat(nowUs: number): void;
	exit(): void;
}

class DebuggerSampler implements StackSampler {
	readonly source = "debugger";
	readonly ready: Promise<void>;
	private readonly stamp = new BigInt64Array(new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT));
	private readonly state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
	private readonly arrived = new Map<number, readonly (readonly string[])[]>();
	private readonly waiting = new Map<number, (stacks: readonly (readonly string[])[]) => void>();

	constructor(thresholdMs: number) {
		const initialized = Promise.withResolvers<void>();
		this.ready = initialized.promise;
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
		const finishInitialization = () => {
			worker.unref();
			initialized.resolve();
		};
		worker.on("message", (message: WorkerBlockSamples | { readonly initialized: true }) => {
			if ("initialized" in message) {
				finishInitialization();
				return;
			}
			const { sinceUs, samples } = message;
			const stacks = samples.map((frames) => {
				const stack = trimStack(
					frames.map(([name, url, line, column]) => formatStackFrame(name, url, line, column)),
				);
				nodeFunctionFrames.set(
					stack,
					trimStack(frames.map(([name, url, , , line, column]) => formatStackFrame(name, url, line, column))),
				);
				return stack;
			});
			const waiter = this.waiting.get(sinceUs);
			if (waiter === undefined) this.arrived.set(sinceUs, stacks);
			else waiter(stacks);
		});
		const ended = () => {
			Atomics.store(this.state, WatchdogState.Attached, 0);
			finishInitialization();
		};
		worker.on("error", ended);
		worker.on("exit", ended);
	}

	beat(nowUs: number): void {
		Atomics.store(this.stamp, 0, BigInt(nowUs));
		for (const sinceUs of this.arrived.keys()) {
			if (nowUs - sinceUs > BLOCK_SAMPLES_GRACE_MS * 1000) this.arrived.delete(sinceUs);
		}
	}

	exit(): void {
		Atomics.store(this.state, WatchdogState.Exiting, 1);
		const deadline = performance.now() + DETACH_ON_EXIT_MS;
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

class ProfileSampler implements StackSampler {
	readonly source = "profiler";
	private startedUs = 0;
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

function startDelayHistogram(): IntervalHistogram {
	const histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
	histogram.enable();
	return histogram;
}

class EventLoopMonitor {
	private histogram: IntervalHistogram;
	private readonly writer = new DiagnosticWriter(() => {});
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
		this.histogram = startDelayHistogram();
		this.sampler = createSampler(thresholdMs, this.lastBeatUs);
		this.sampler.beat(this.lastBeatUs);
		setInterval(() => this.beat(), HEARTBEAT_MS).unref();
		process.once("exit", () => {
			const lateMs = (epochUs() - this.lastBeatUs) / 1000 - HEARTBEAT_MS;
			this.sampler.exit();
			if (lateMs >= this.thresholdMs) this.writeAtQuit(this.blockRecord(this.lastBeatUs, lateMs, []));
			this.writeAtQuit(this.delayRecord(lateMs));
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

	whenReady(): Promise<void> {
		return this.sampler.ready ?? Promise.resolve();
	}

	enter(next: EventLoopPhase): void {
		if (PHASES.indexOf(next) <= PHASES.indexOf(this.phase)) return;
		const lateMs = this.beat();
		const ended = this.delayRecord(lateMs);
		if (next === "shutdown") this.writeAtQuit(ended);
		else this.write(ended);
		this.histogram.disable();
		this.histogram = startDelayHistogram();
		this.phase = next;
		this.phaseStartedUs = epochUs();
	}

	private beat(): number {
		const nowUs = epochUs();
		const sinceUs = this.lastBeatUs;
		this.lastBeatUs = nowUs;
		const durationMs = (nowUs - sinceUs) / 1000 - HEARTBEAT_MS;
		if (durationMs >= this.thresholdMs) {
			void this.sampler
				.stacksOf(sinceUs, nowUs)
				.then((samples) => this.write(this.blockRecord(sinceUs, durationMs, samples)));
		}
		this.sampler.beat(nowUs);
		return durationMs;
	}

	private blockRecord(sinceUs: number, durationMs: number, samples: readonly (readonly string[])[]): EventLoopRecord {
		return {
			type: "block",
			at: new Date(sinceUs / 1000 + HEARTBEAT_MS).toISOString(),
			role: this.role,
			pid: process.pid,
			durationMs: roundMs(durationMs),
			thresholdMs: this.thresholdMs,
			samples: samples.length,
			hotFrames: hotFrames(samples),
			stacks: summarizeStacks(samples),
		};
	}

	private delayRecord(lateMs = 0): EventLoopRecord {
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
			maxMs: Math.max(ticks === 0 ? 0 : lagMs(this.histogram.max), roundMs(lateMs)),
		};
	}

	private write(record: EventLoopRecord): void {
		void this.writer.append(this.logPath, `${JSON.stringify(record)}\n`);
	}

	private writeAtQuit(record: EventLoopRecord): void {
		this.writer.flushSync();
		try {
			appendFileSync(this.logPath, `${JSON.stringify(record)}\n`);
		} catch {}
	}
}

let monitor: EventLoopMonitor | undefined;

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

/** Finish opt-in diagnostic setup before the CLI exposes its interactive input surface. */
export function waitForEventLoopMonitorReady(): Promise<void> {
	return monitor?.whenReady() ?? Promise.resolve();
}

export function markEventLoopStartupComplete(): void {
	monitor?.enter("session");
}

export function markEventLoopShutdown(): void {
	monitor?.enter("shutdown");
}
