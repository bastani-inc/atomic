export type LifecycleTimingLabel =
	| "process-entry"
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
