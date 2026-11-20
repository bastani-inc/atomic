import { DiagnosticWriter } from "./diagnostic-writer.ts";

export type LifecycleTimingLabel =
	| "process-entry"
	| "main-entry"
	| "session-opened"
	| "runtime-created"
	| "interactive-engine-spawn"
	| "engine-ready"
	| "tui-start"
	| "header-mounted"
	| "first-terminal-write"
	| "startup-coherent"
	| "startup-complete"
	| "engine-bound"
	| "engine-resources-ready"
	| "chat-output-release"
	| "interactive-input-handler-ready"
	| "interactive-first-submit"
	| "before-provider-request";

export interface LifecycleTimingRecord {
	readonly label: LifecycleTimingLabel;
	readonly atNs: bigint;
	readonly pid: number;
}

export type LifecycleTimingSink = (record: LifecycleTimingRecord) => void;

interface LifecycleTimingState {
	sink: LifecycleTimingSink | undefined;
	clock: () => bigint;
	readonly recorded: Set<LifecycleTimingLabel>;
}

const STATE_KEY = Symbol.for("@bastani/atomic/lifecycle-timings");
const globalWithLifecycleState = globalThis as typeof globalThis & {
	[STATE_KEY]?: LifecycleTimingState;
};

function getState(): LifecycleTimingState {
	const existing = globalWithLifecycleState[STATE_KEY];
	if (existing) return existing;
	const created: LifecycleTimingState = {
		sink: undefined,
		clock: process.hrtime.bigint,
		recorded: new Set(),
	};
	globalWithLifecycleState[STATE_KEY] = created;
	return created;
}

/** True only when an internal diagnostic adapter has installed a synchronous sink. */
export function isLifecycleTimingEnabled(): boolean {
	return getState().sink !== undefined;
}

/**
 * Install a process-local diagnostic sink.
 *
 * The sink must stay synchronous and must not write to the terminal. External
 * ConPTY and TCP timestamps remain authoritative; these records only attribute
 * time inside the process. Installing a sink resets the one-shot labels for a
 * new diagnostic run. The returned function restores the previous adapter.
 */
export function installLifecycleTimingSink(
	sink: LifecycleTimingSink,
	clock: () => bigint = process.hrtime.bigint,
): () => void {
	const state = getState();
	const previousSink = state.sink;
	const previousClock = state.clock;
	const previousRecorded = new Set(state.recorded);
	state.sink = sink;
	state.clock = clock;
	state.recorded.clear();
	return () => {
		state.sink = previousSink;
		state.clock = previousClock;
		state.recorded.clear();
		for (const label of previousRecorded) state.recorded.add(label);
	};
}

/** Record the first occurrence of a lifecycle boundary when diagnostics are active. */
export function markLifecycleTiming(label: LifecycleTimingLabel): void {
	const state = getState();
	const sink = state.sink;
	if (!sink || state.recorded.has(label)) return;
	state.recorded.add(label);
	try {
		sink({ label, atNs: state.clock(), pid: process.pid });
	} catch {
		// Diagnostics must never alter the startup path they observe.
	}
}

/** Variables naming the startup trace file; `PI_` is the legacy alias, as for every Atomic variable. */
const STARTUP_TRACE_ENV_NAMES = ["ATOMIC_STARTUP_TRACE", "PI_STARTUP_TRACE"] as const;

/** One line of the startup trace file. */
export interface LifecycleTraceLine {
	readonly label: LifecycleTimingLabel | "process-start";
	/** Wall-clock milliseconds since the Unix epoch, so marks of a host and its engine child line up. */
	readonly epochMs: number;
	readonly pid: number;
	readonly ppid: number;
}

let traceWriter: DiagnosticWriter | undefined;

export function lifecycleTraceWritten(): Promise<void> {
	return traceWriter?.written() ?? Promise.resolve();
}

/**
 * Write the trace lines still waiting for the writer's thread, once a quit has begun. Windows ends an isolated engine
 * as soon as its host has the quit acknowledgement, without running exit handlers, so a line still waiting then would
 * be lost. Does nothing when no trace is installed.
 */
export function flushLifecycleTraceAtQuit(): void {
	traceWriter?.flushSync();
}

/**
 * When `ATOMIC_STARTUP_TRACE` names a file, append this process's start and each lifecycle mark to it, one JSON line
 * each. A host and the engine child it starts inherit the variable, so one file holds both timelines. Lines are
 * appended off the event loop in mark order; whatever has not reached the file when the process exits is written then.
 * Does nothing when the variable is unset or another diagnostic sink is already installed. Returns the function that
 * uninstalls it.
 */
export function installLifecycleTraceFromEnv(env: NodeJS.ProcessEnv = process.env): (() => void) | undefined {
	const file = STARTUP_TRACE_ENV_NAMES.map((name) => env[name]).find((value) => value !== undefined && value !== "");
	if (!file || getState().sink) return undefined;
	const writer = new DiagnosticWriter(() => {});
	traceWriter = writer;
	const write = (label: LifecycleTraceLine["label"], epochMs: number): void => {
		const line: LifecycleTraceLine = { label, epochMs, pid: process.pid, ppid: process.ppid };
		void writer.append(file, `${JSON.stringify(line)}\n`);
	};
	const writeRemainingAtExit = (): void => writer.flushSync();
	process.once("exit", writeRemainingAtExit);
	write("process-start", performance.timeOrigin);
	const uninstallSink = installLifecycleTimingSink((record) =>
		write(record.label, performance.timeOrigin + performance.now()),
	);
	return () => {
		uninstallSink();
		process.removeListener("exit", writeRemainingAtExit);
		if (traceWriter === writer) traceWriter = undefined;
	};
}
