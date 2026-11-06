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

	const pop = (): WakeEntry | undefined => {
		const top = heap[0];
		const last = heap.pop();
		if (top === undefined || last === undefined || heap.length === 0) return top;
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
			const entry = pop()!;
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
				const onAbort = (): void => {
					scheduled.cancel();
					reject(signal.reason);
				};
				const scheduled = schedule(ms, () => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				});
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		get pending() {
			return live;
		},
	};
}

/** The process-wide dispatcher every built-in source and subscription uses. */
export const sharedWakeDispatcher = createWakeDispatcher();
