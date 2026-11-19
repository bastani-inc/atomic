import { appendFileSync, mkdirSync } from "node:fs";
import type { Profiler, Session } from "node:inspector";
import { dirname, join, resolve } from "node:path";
import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { getAgentDir, isBunRuntime } from "../config.js";
import { createModuleRequire } from "../utils/module-require.js";
import { DiagnosticWriter } from "./diagnostic-writer.ts";

export const EVENT_LOOP_BLOCK_MS_ENV = "ATOMIC_EVENT_LOOP_BLOCK_MS";
export const EVENT_LOOP_BLOCK_LOG_ENV = "ATOMIC_EVENT_LOOP_BLOCK_LOG";
export const EVENT_LOOP_BLOCK_STACKS_ENV = "ATOMIC_EVENT_LOOP_BLOCK_STACKS";
export const EVENT_LOOP_BLOCK_LOG_NAME = "event-loop-blocks.jsonl";

export type EventLoopProcessRole = "host" | "engine";

export type EventLoopStackSource = "debugger" | "profiler" | "unavailable" | "disabled";

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
const STACK_END_FRAMES = 12;
const MAX_BLOCK_STACKS = 3;
const MAX_HOT_FRAMES = 10;
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

// CPU-profile frames already name the function's definition, not the sampled instruction's location.
const definitionLocatedStacks = new WeakSet<readonly string[]>();

export function hotFrames(samples: readonly (readonly string[])[]): EventLoopHotFrame[] {
	const frames = new Map<string, { frame: string; count: number; depth: number }>();
	for (const stack of samples) {
		const counted = new Set<string>();
		for (const [depth, frame] of stack.entries()) {
			if (frame.startsWith("… ")) continue;
			const key =
				definitionLocatedStacks.has(stack) || frame.startsWith("(anonymous)")
					? frame
					: frame.replace(/:\d+:\d+\)$/, ")");
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
		const stack = trimStack(frames);
		definitionLocatedStacks.add(stack);
		stacks.push(stack);
	}
	return stacks;
}

interface StackSampler {
	readonly source: EventLoopStackSource;
	readonly ready?: Promise<void>;
	stacksOf(sinceUs: number, untilUs: number): Promise<readonly (readonly string[])[]>;
	beat(nowUs: number): void;
	exit(): void;
}

class ProfileSampler implements StackSampler {
	readonly source = "profiler";
	private startedUs = 0;
	private observedUs: number;
	private queue: Promise<void> = Promise.resolve();
	private collectionScheduled = false;
	private completed: Profiler.Profile[] = [];
	private readonly requests: {
		readonly sinceUs: number;
		readonly untilUs: number;
		readonly settle: (stacks: readonly (readonly string[])[]) => void;
	}[] = [];

	private readonly session: Session;
	private readonly profileTimeOffsetUs: number;

	constructor(session: Session, nowUs: number) {
		this.session = session;
		this.observedUs = nowUs;
		// Node profiles use the monotonic process clock; Bun profiles already use epoch microseconds.
		this.profileTimeOffsetUs = isBunRuntime ? 0 : epochUs() - Number(process.hrtime.bigint() / 1000n);
		session.post("Profiler.enable");
		session.post("Profiler.setSamplingInterval", { interval: PROFILE_SAMPLING_INTERVAL_US });
		this.restart(nowUs);
	}

	beat(nowUs: number): void {
		this.observedUs = nowUs;
		if (!this.collectionScheduled && this.requests.length === 0) this.releaseObservedProfiles();
		if (nowUs - this.startedUs >= PROFILE_WINDOW_MS * 1000) this.scheduleCollection();
	}

	stacksOf(sinceUs: number, untilUs: number): Promise<readonly (readonly string[])[]> {
		return new Promise((settle) => {
			this.requests.push({ sinceUs, untilUs, settle });
			this.scheduleCollection();
		});
	}

	exit(): void {}

	private scheduleCollection(): void {
		if (this.collectionScheduled) return;
		this.collectionScheduled = true;
		this.queue = this.queue.then(async () => {
			// Requests arriving after this stop may need samples from the newly started profile.
			const batch = this.requests.splice(0);
			const profile = await this.stop();
			if (profile !== undefined) this.completed.push(profile);
			for (const request of batch) {
				request.settle(
					this.completed.flatMap((completed) =>
						profileStacksBetween(
							completed,
							request.sinceUs - this.profileTimeOffsetUs,
							request.untilUs - this.profileTimeOffsetUs,
						),
					),
				);
			}
			this.releaseObservedProfiles();
			this.collectionScheduled = false;
			if (this.requests.length > 0) this.scheduleCollection();
		});
	}

	private releaseObservedProfiles(): void {
		// A phase can end before the next timer discovers a later stall in the same task. Keep that unread tail,
		// including a rotation's tail, until every window through the last observed heartbeat has been served.
		const nextWindowUs = this.requests[0]?.sinceUs ?? this.observedUs + HEARTBEAT_MS * 1000;
		this.completed = this.completed.filter((profile) => profile.endTime + this.profileTimeOffsetUs >= nextWindowUs);
	}

	private restart(nowUs: number): void {
		this.startedUs = nowUs;
		this.session.post("Profiler.start");
	}

	private stop(): Promise<Profiler.Profile | undefined> {
		if (isBunRuntime) {
			// Bun's optional callback is deferred even though post returns its result synchronously.
			const stopProfile = this.session.post as unknown as (method: "Profiler.stop") => {
				readonly profile: Profiler.Profile;
			};
			let profile: Profiler.Profile | undefined;
			try {
				profile = stopProfile.call(this.session, "Profiler.stop").profile;
			} catch {}
			this.restart(epochUs());
			return Promise.resolve(profile);
		}
		return new Promise((settle) =>
			this.session.post("Profiler.stop", (error, result) => {
				// Resume collection before another user microtask can run between stop and result processing.
				this.restart(epochUs());
				settle(error ? undefined : result.profile);
			}),
		);
	}
}

const noStacks: StackSampler = {
	source: "unavailable",
	stacksOf: () => Promise.resolve([]),
	beat: () => {},
	exit: () => {},
};

const delayOnly: StackSampler = { ...noStacks, source: "disabled" };

function createSampler(nowUs: number): StackSampler {
	try {
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
	private maxBeatDelayMs = 0;

	private readonly role: EventLoopProcessRole;
	private readonly thresholdMs: number;
	private readonly logPath: string;

	constructor(role: EventLoopProcessRole, thresholdMs: number, logPath: string, collectStacks: boolean) {
		this.role = role;
		this.thresholdMs = thresholdMs;
		this.logPath = logPath;
		this.lastBeatUs = epochUs();
		this.phaseStartedUs = this.lastBeatUs;
		this.histogram = startDelayHistogram();
		this.sampler = collectStacks ? createSampler(this.lastBeatUs) : delayOnly;
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
		this.maxBeatDelayMs = 0;
		this.phase = next;
		this.phaseStartedUs = epochUs();
	}

	private beat(): number {
		const nowUs = epochUs();
		const sinceUs = this.lastBeatUs;
		this.lastBeatUs = nowUs;
		const durationMs = (nowUs - sinceUs) / 1000 - HEARTBEAT_MS;
		this.maxBeatDelayMs = Math.max(this.maxBeatDelayMs, durationMs);
		if (durationMs >= this.thresholdMs) {
			void this.sampler
				.stacksOf(sinceUs + HEARTBEAT_MS * 1000, nowUs)
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
			maxMs: Math.max(ticks === 0 ? 0 : lagMs(this.histogram.max), roundMs(this.maxBeatDelayMs), roundMs(lateMs)),
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
	const collectStacks = env[EVENT_LOOP_BLOCK_STACKS_ENV]?.trim() !== "0";
	monitor = new EventLoopMonitor(role, thresholdMs, logPath, collectStacks);
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
