import type { EvictedRun } from "../runs/foreground/run-residency.js";
import { releaseEvictedRun } from "../runs/foreground/run-residency.js";
import type { StageWaitHandoff } from "../runs/foreground/stage-wake-dispatcher.js";
import type { WorkflowUIContext } from "../shared/types.js";
import type { ToolControlRegistry, WorkflowRunControlHandle } from "./run-tool-control-registry.js";

/** How an evicted run is woken and rebuilt: what it hands over, and the owner controls to forward once it is. */
export interface EvictedRunWake {
	readonly handoff: StageWaitHandoff;
	/** Call once the rebuilt run's execution has started: controls sent while the run was evicted reach it then. */
	rebuilt(): void;
}

interface EvictedRunOwner {
	readonly runId: string;
	readonly toolControls: ToolControlRegistry;
	readonly signal?: AbortSignal | undefined;
	readonly cancellation?:
		| {
				register(runId: string, controller: AbortController): void;
				abort(runId: string, reason?: unknown): boolean;
				unregister(runId: string, expectedController?: AbortController): unknown;
		  }
		| undefined;
}

/**
 * Hold an evicted run until it is woken: a stage's calls all have results, a stage is sent a message, the caller's
 * signal aborts, or the run's owner pauses, quits or kills it. A run given a `signal` keeps the registration its caller
 * made: that controller's abort reaches the run through the signal. Otherwise a placeholder holds the registration
 * until the rebuilt execution registers its own controller over it. Meanwhile the run answers its owner's controls by
 * waking: they reach the rebuilt run once it starts. Nothing of the evicted execution stays reachable from here.
 */
export async function whileEvicted(evicted: EvictedRun, owner: EvictedRunOwner): Promise<EvictedRunWake> {
	const started = Promise.withResolvers<void>();
	const forward = async (operation: (live: WorkflowRunControlHandle) => Promise<void>): Promise<void> => {
		evicted.wake("control");
		await started.promise;
		const live = owner.toolControls.runControl(owner.runId);
		if (live !== undefined) await operation(live);
	};
	const control: WorkflowRunControlHandle = {
		paused: false,
		pause: () => forward((live) => live.pause()),
		resume: () => forward((live) => live.resume()),
		quit: () => forward((live) => live.quit()),
		settlePersistence: (settlement) => {
			void forward(async (live) => live.settlePersistence?.(settlement));
		},
		retire: () => forward(async (live) => live.retire?.()),
	};
	let killRebuilt: (() => void) | undefined;
	const cancellation = owner.signal === undefined ? owner.cancellation : undefined;
	const kill = new AbortController();
	if (cancellation !== undefined) {
		kill.signal.addEventListener("abort", () => {
			const reason: unknown = kill.signal.reason;
			killRebuilt = () => cancellation.abort(owner.runId, reason);
			evicted.wake("control");
		});
		cancellation.register(owner.runId, kill);
	}
	const onCallerAbort = (): void => evicted.wake("control");
	const unregisterControl = owner.toolControls.registerRun(owner.runId, control);
	if (owner.signal?.aborted) onCallerAbort();
	else owner.signal?.addEventListener("abort", onCallerAbort);
	try {
		await evicted.untilWoken();
	} finally {
		owner.signal?.removeEventListener("abort", onCallerAbort);
		unregisterControl();
		releaseEvictedRun(evicted);
	}
	return {
		handoff: evicted.handoff(),
		rebuilt: () => {
			killRebuilt?.();
			started.resolve();
		},
	};
}

/** Count the run's `ctx.ui` calls in flight: a run that asks its user anything is not evicted meanwhile. */
export function countUiCalls(ui: WorkflowUIContext, inFlight: { count: number }): WorkflowUIContext {
	const track = <T>(pending: Promise<T>): Promise<T> => {
		inFlight.count += 1;
		const done = (): void => {
			inFlight.count -= 1;
		};
		pending.then(done, done);
		return pending;
	};
	return {
		input: (prompt) => track(ui.input(prompt)),
		confirm: (message) => track(ui.confirm(message)),
		select: (message, options) => track(ui.select(message, options)),
		editor: (initial) => track(ui.editor(initial)),
		custom: (factory, options) => track(ui.custom(factory, options)),
	};
}
