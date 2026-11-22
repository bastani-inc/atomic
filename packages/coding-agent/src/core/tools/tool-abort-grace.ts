import type { AgentTool, AgentToolResult } from "@bastani/atomic-agent-core";

/** How long a tool call may run on after its turn is interrupted before the turn stops waiting for it (#5486). */
export const DEFAULT_TOOL_ABORT_GRACE_MS = 10_000;
/** The longest delay a timer takes; a larger value would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

interface GraceOwnerState {
	readonly timers: Set<ReturnType<typeof setTimeout>>;
	keepAliveHolders: number;
	released: boolean;
}

const graceOwners = new WeakMap<object, GraceOwnerState>();

function graceOwnerState(owner: object): GraceOwnerState {
	let state = graceOwners.get(owner);
	if (state === undefined) {
		state = { timers: new Set(), keepAliveHolders: 0, released: false };
		graceOwners.set(owner, state);
	}
	return state;
}

function pruneGraceOwner(owner: object, state: GraceOwnerState): void {
	if (state.timers.size === 0 && state.keepAliveHolders === 0 && !state.released) {
		graceOwners.delete(owner);
	}
}

function acquireGraceKeepAlive(owner: object): () => void {
	const state = graceOwnerState(owner);
	state.keepAliveHolders += 1;
	if (!state.released) {
		for (const timer of state.timers) timer.ref?.();
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.keepAliveHolders = Math.max(0, state.keepAliveHolders - 1);
		if (state.keepAliveHolders === 0) {
			for (const timer of state.timers) timer.unref?.();
			pruneGraceOwner(owner, state);
		}
	};
}

class ObservedGracePromise<T> extends Promise<T> {
	static get [Symbol.species](): PromiseConstructor {
		return Promise;
	}

	#onObserve: (() => boolean) | undefined;

	constructor(
		executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
		onObserve: () => boolean,
	) {
		super(executor);
		this.#onObserve = onObserve;
	}

	// biome-ignore lint/suspicious/noThenProperty: Promise subclass intentionally observes await/.then() to ref grace timers only when awaited.
	override then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): Promise<TResult1 | TResult2> {
		if (this.#onObserve?.()) {
			this.#onObserve = undefined;
		}
		return super.then(onfulfilled, onrejected);
	}
}

/**
 * Wrap `promise` so that the first observation (`await`, `.then`, `.catch`, `.finally`) — when `shouldHold` permits —
 * keeps active abort-grace timers for `owner` ref'd until `promise` settles. An unobserved call (such as `void
 * session.abort()`) leaves those timers unref'd so the process can exit immediately.
 */
export function holdToolAbortGraceWhenObserved<T>(
	owner: object,
	promise: Promise<T>,
	shouldHold?: () => boolean,
): Promise<T> {
	let settled = false;
	let release: (() => void) | undefined;
	const done = (): void => {
		settled = true;
		const releaseNow = release;
		release = undefined;
		releaseNow?.();
	};
	return new ObservedGracePromise<T>(
		(resolve, reject) => {
			promise.then(
				(value) => {
					done();
					resolve(value);
				},
				(error: unknown) => {
					done();
					reject(error);
				},
			);
		},
		() => {
			if (settled) return true;
			if (shouldHold !== undefined && !shouldHold()) return false;
			release = acquireGraceKeepAlive(owner);
			return true;
		},
	);
}

/**
 * Arm an abort-grace timer tracked under `owner` (typically an `AgentSession`, across every signal its tools run under).
 * The timer starts unref'd unless an observed abort caller is actively awaiting settlement for `owner`, and is unref'd
 * again once no awaited caller remains or {@link releaseToolAbortGraceTimers} runs during disposal.
 */
export function armToolAbortGraceTimer(
	owner: object | undefined,
	graceMs: number,
	onExpire: () => void,
): ReturnType<typeof setTimeout> {
	const state = owner === undefined ? undefined : graceOwnerState(owner);
	const timer = setTimeout(() => {
		if (owner !== undefined && state !== undefined) {
			state.timers.delete(timer);
			pruneGraceOwner(owner, state);
		}
		onExpire();
	}, graceMs);
	if (state !== undefined) {
		state.timers.add(timer);
		if (state.released || state.keepAliveHolders === 0) timer.unref?.();
	} else {
		timer.unref?.();
	}
	return timer;
}

/** Clear an abort-grace timer armed through {@link armToolAbortGraceTimer}. */
export function clearToolAbortGraceTimer(
	owner: object | undefined,
	timer: ReturnType<typeof setTimeout> | undefined,
): void {
	if (timer === undefined) return;
	clearTimeout(timer);
	if (owner === undefined) return;
	const state = graceOwners.get(owner);
	if (state === undefined) return;
	state.timers.delete(timer);
	pruneGraceOwner(owner, state);
}

/** Unref all active and future abort-grace timers for `owner` once disposal has moved past its abort step. */
export function releaseToolAbortGraceTimers(owner: object | undefined): void {
	if (owner === undefined) return;
	const state = graceOwnerState(owner);
	state.released = true;
	for (const timer of state.timers) timer.unref?.();
	state.timers.clear();
}

/** `ATOMIC_TOOL_ABORT_GRACE_MS` when it is a whole number of milliseconds, otherwise the default. */
export function toolAbortGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = env.ATOMIC_TOOL_ABORT_GRACE_MS?.trim();
	return value !== undefined && /^\d+$/.test(value)
		? Math.min(Number(value), MAX_TIMER_MS)
		: DEFAULT_TOOL_ABORT_GRACE_MS;
}

function seconds(ms: number): string {
	const value = Number((ms / 1000).toFixed(3));
	return `${value} second${value === 1 ? "" : "s"}`;
}

/** The result a call gets when its interrupted turn stops waiting for it. */
export function abandonedToolResult(toolName: string, graceMs: number): AgentToolResult<undefined> {
	return {
		content: [
			{
				type: "text",
				text: `Operation aborted: ${toolName} did not stop within ${seconds(graceMs)} after the turn was interrupted. It may still be running, but any later result is discarded.`,
			},
		],
		details: undefined,
		isError: true,
	};
}

/**
 * `tool`, whose calls answer at most a grace period after their turn is interrupted (#5486). A call still running then
 * gets {@link abandonedToolResult}, so the turn can end. A call that stops within the grace keeps its own result.
 */
export function withToolAbortGrace(tool: AgentTool, owner?: object): AgentTool {
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate, ...rest) => {
			let running: ReturnType<AgentTool["execute"]>;
			try {
				running = tool.execute(toolCallId, params, signal, onUpdate, ...rest);
			} catch (error) {
				return Promise.reject(error);
			}
			if (signal === undefined) return running;
			const timerOwner = owner ?? signal;
			const guarded = new Promise<AgentToolResult<unknown>>((resolve, reject) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const startGrace = () => {
					const graceMs = toolAbortGraceMs();
					timer = armToolAbortGraceTimer(timerOwner, graceMs, () =>
						resolve(abandonedToolResult(tool.name, graceMs)),
					);
				};
				const settle = () => {
					clearToolAbortGraceTimer(timerOwner, timer);
					timer = undefined;
					signal.removeEventListener("abort", startGrace);
				};
				if (signal.aborted) startGrace();
				else signal.addEventListener("abort", startGrace, { once: true });
				running.then(
					(result) => {
						settle();
						resolve(result);
					},
					(error: unknown) => {
						settle();
						reject(error);
					},
				);
			});
			// Standalone callers without an AgentSession owner keep their own awaited execute() call alive through grace.
			return owner === undefined ? holdToolAbortGraceWhenObserved(signal, guarded) : guarded;
		},
	};
}
