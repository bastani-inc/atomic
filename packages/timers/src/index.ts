const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Native timers need not count suspend time. Recheck wall deadlines regularly on wake,
// rather than trusting a single native timer for the full remaining wall duration.
const WALL_CLOCK_CHECK_MS = 1_000;

export interface LongTimeout {
	clear(): void;
	ref(): LongTimeout;
	unref(): LongTimeout;
}

interface TimerOptions {
	/** An unreferenced timer does not keep Node or Bun running. Defaults to true. */
	ref?: boolean;
}

function delayOrZero(delayMs: number): number {
	return delayMs > 0 ? delayMs : 0;
}

function schedule(
	callback: () => void,
	deadline: number,
	now: () => number,
	maxDelay: number,
	{ ref = true }: TimerOptions,
): LongTimeout {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let referenced = ref;
	const handle: LongTimeout = {
		clear() {
			clearTimeout(timer);
			timer = undefined;
		},
		ref() {
			referenced = true;
			timer?.ref?.();
			return handle;
		},
		unref() {
			referenced = false;
			timer?.unref?.();
			return handle;
		},
	};
	const arm = (remaining: number) => {
		// Round up so a fractional deadline does not get truncated to an earlier millisecond.
		const delay = Math.min(Math.max(1, Math.ceil(remaining)), maxDelay);
		timer = setTimeout(() => {
			timer = undefined;
			const remaining = deadline - now();
			if (remaining > 0) arm(remaining);
			else callback();
		}, delay);
		if (!referenced) timer.unref?.();
	};
	if (deadline !== Infinity) arm(delayOrZero(deadline - now()));
	return handle;
}

/** Schedule against an absolute `performance.now()` deadline. An elapsed or NaN deadline runs next timer turn. */
export function setLongTimeoutAt(callback: () => void, deadline: number, options: TimerOptions = {}): LongTimeout {
	return schedule(callback, deadline, () => performance.now(), MAX_TIMER_DELAY_MS, options);
}

/** Negative, zero, and NaN delays run next timer turn; positive Infinity never fires. */
export function setLongTimeout(callback: () => void, delayMs: number, options?: TimerOptions): LongTimeout {
	return setLongTimeoutAt(callback, performance.now() + delayOrZero(delayMs), options);
}

/** Schedule against a Unix epoch millisecond timestamp, rechecking the wall clock on every native wake-up. */
export function setWallTimeoutAt(callback: () => void, deadline: number, options: TimerOptions = {}): LongTimeout {
	return schedule(callback, deadline, () => Date.now(), WALL_CLOCK_CHECK_MS, options);
}

/** Repeat on a monotonic cadence without replaying ticks missed while the event loop was busy. */
export function setLongInterval(callback: () => void, delayMs: number, options: TimerOptions = {}): LongTimeout {
	const step = Math.max(1, delayOrZero(delayMs));
	const origin = performance.now();
	let timer: LongTimeout;
	let referenced = options.ref;
	let nextTick = 1;
	const tick = () => {
		nextTick = Math.max(nextTick + 1, Math.floor((performance.now() - origin) / step) + 1);
		timer = setLongTimeoutAt(tick, origin + nextTick * step, { ref: referenced });
		callback();
	};
	timer = setLongTimeoutAt(tick, origin + step, options);
	const handle: LongTimeout = {
		clear: () => timer.clear(),
		ref() {
			referenced = true;
			timer.ref();
			return handle;
		},
		unref() {
			referenced = false;
			timer.unref();
			return handle;
		},
	};
	return handle;
}

/** An unreferenced deadline signal. Clear it when the operation finishes first. */
export function createTimeoutSignal(delayMs: number): { signal: AbortSignal; clear(): void } {
	const controller = new AbortController();
	const { clear } = setLongTimeout(
		() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
		delayMs,
		{ ref: false },
	);
	return { signal: controller.signal, clear };
}

interface SleepOptions extends TimerOptions {
	signal?: AbortSignal;
}

/** Wait until a `performance.now()` deadline, or reject immediately with the signal's abort reason. */
export function sleepUntil(deadline: number, { signal, ref }: SleepOptions = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const timer = setLongTimeoutAt(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			deadline,
			{ ref },
		);
		const onAbort = () => {
			timer.clear();
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function sleepFor(delayMs: number, options?: SleepOptions): Promise<void> {
	return sleepUntil(performance.now() + delayOrZero(delayMs), options);
}
