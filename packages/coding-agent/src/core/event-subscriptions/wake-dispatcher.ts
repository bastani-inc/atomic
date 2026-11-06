/**
 * One owner of waiting for every event source and subscription in the process.
 *
 * Sources and rate admission never hold their own timers: they schedule a wake here, and the dispatcher keeps a
 * single timer for the earliest one. An idle subscription therefore costs one heap entry, not a timer. Deadlines run
 * on a monotonic clock, so a wall-clock jump neither stalls nor rushes a wake.
 */

export interface ScheduledWake {
	cancel(): void;
}

export interface WakeDispatcher {
	/** Wall-clock time in epoch ms, for event ids and payloads. */
	now(): number;
	/** Monotonic time in ms. Wall-clock jumps do not move it; deadlines and rate windows use it. */
	elapsed(): number;
	/** Calls `wake` once after `delayMs` of monotonic time, unless cancelled first. */
	schedule(delayMs: number, wake: () => void): ScheduledWake;
	/** Resolves after `ms`, or rejects with the signal's reason when it aborts first. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The clocks and the one timer a dispatcher runs on. Tests pass a manual host. */
export interface WakeTimerHost {
	now(): number;
	elapsed(): number;
	setTimer(callback: () => void, ms: number): { cancel(): void };
}

interface WakeEntry {
	readonly at: number;
	readonly sequence: number;
	readonly wake: () => void;
	cancelled: boolean;
}

const systemTimerHost: WakeTimerHost = {
	now: () => Date.now(),
	elapsed: () => performance.now(),
	setTimer: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		return { cancel: () => clearTimeout(timer) };
	},
};

/** Abort callbacks registered on owned signals; their owner runs them, so the signal itself holds no listener. */
const ownedAborts = new WeakMap<AbortSignal, Set<() => void>>();

export interface OwnedAbortController {
	readonly signal: AbortSignal;
	/** Aborts the signal, then runs every callback registered through `whenAborted`. */
	abort(reason?: unknown): void;
}

/**
 * An abort controller that owns the waiting on its signal: `whenAborted` registers callbacks with it instead of adding
 * listeners to the signal. The subscription engine starts its sources with such a signal, so a sleeping source or a
 * listening webhook holds no abort listener of its own.
 */
export function createOwnedAbortController(): OwnedAbortController {
	const controller = new AbortController();
	const callbacks = new Set<() => void>();
	ownedAborts.set(controller.signal, callbacks);
	return {
		signal: controller.signal,
		abort(reason) {
			if (controller.signal.aborted) return;
			controller.abort(reason);
			const pending = [...callbacks];
			callbacks.clear();
			for (const callback of pending) callback();
		},
	};
}

/**
 * Calls `onAbort` once when `signal` aborts, at once when it already has, and returns a function that stops watching.
 * A signal from `createOwnedAbortController` gets no listener; any other signal gets a one-shot abort listener.
 */
export function whenAborted(signal: AbortSignal, onAbort: () => void): () => void {
	if (signal.aborted) {
		onAbort();
		return () => {};
	}
	const owned = ownedAborts.get(signal);
	if (owned !== undefined) {
		owned.add(onAbort);
		return () => {
			owned.delete(onAbort);
		};
	}
	signal.addEventListener("abort", onAbort, { once: true });
	return () => signal.removeEventListener("abort", onAbort);
}

function before(left: WakeEntry, right: WakeEntry): boolean {
	return left.at < right.at || (left.at === right.at && left.sequence < right.sequence);
}

/** A min-heap of wakes driven by one host timer. */
export function createWakeDispatcher(host: WakeTimerHost = systemTimerHost): WakeDispatcher & {
	/** Scheduled wakes still pending, for leak checks. */
	readonly pending: number;
} {
	const heap: WakeEntry[] = [];
	let sequence = 0;
	let live = 0;
	let timer: { readonly at: number; readonly handle: { cancel(): void } } | undefined;

	const push = (entry: WakeEntry): void => {
		heap.push(entry);
		let index = heap.length - 1;
		while (index > 0) {
			const parent = (index - 1) >> 1;
			if (!before(heap[index]!, heap[parent]!)) break;
			[heap[index], heap[parent]] = [heap[parent]!, heap[index]!];
			index = parent;
		}
	};

	/** Removes the earliest entry. Callers check that the heap is not empty. */
	const pop = (): WakeEntry => {
		const top = heap[0]!;
		const last = heap.pop()!;
		if (heap.length === 0) return top;
		heap[0] = last;
		let index = 0;
		for (;;) {
			const left = index * 2 + 1;
			const right = left + 1;
			let smallest = index;
			if (left < heap.length && before(heap[left]!, heap[smallest]!)) smallest = left;
			if (right < heap.length && before(heap[right]!, heap[smallest]!)) smallest = right;
			if (smallest === index) break;
			[heap[index], heap[smallest]] = [heap[smallest]!, heap[index]!];
			index = smallest;
		}
		return top;
	};

	const arm = (): void => {
		while (heap[0]?.cancelled === true) pop();
		const next = heap[0];
		if (next === undefined) {
			timer?.handle.cancel();
			timer = undefined;
			return;
		}
		if (timer !== undefined && timer.at <= next.at) return;
		timer?.handle.cancel();
		timer = { at: next.at, handle: host.setTimer(fire, Math.max(0, next.at - host.elapsed())) };
	};

	function fire(): void {
		timer = undefined;
		const now = host.elapsed();
		const due: WakeEntry[] = [];
		while (heap[0] !== undefined && (heap[0].cancelled || heap[0].at <= now)) {
			const entry = pop();
			if (!entry.cancelled) due.push(entry);
		}
		arm();
		for (const entry of due) {
			live -= 1;
			entry.cancelled = true;
			entry.wake();
		}
	}

	const schedule = (delayMs: number, wake: () => void): ScheduledWake => {
		const entry: WakeEntry = {
			at: host.elapsed() + Math.max(0, delayMs),
			sequence: sequence++,
			wake,
			cancelled: false,
		};
		live += 1;
		push(entry);
		arm();
		return {
			cancel: () => {
				if (entry.cancelled) return;
				entry.cancelled = true;
				live -= 1;
				arm();
			},
		};
	};

	return {
		now: () => host.now(),
		elapsed: () => host.elapsed(),
		schedule,
		sleep: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				const scheduled = schedule(ms, () => {
					stopWatching();
					resolve();
				});
				const stopWatching = whenAborted(signal, () => {
					scheduled.cancel();
					reject(signal.reason);
				});
			}),
		get pending() {
			return live;
		},
	};
}

/** The process-wide dispatcher every built-in source and subscription uses. */
export const sharedWakeDispatcher = createWakeDispatcher();
