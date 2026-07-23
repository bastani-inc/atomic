export interface RetrySchedulerTimers {
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
}

export interface RetryScheduler {
	has(key: string): boolean;
	attempt(key: string): number;
	schedule(key: string, callback: () => void): boolean;
	clear(key: string): void;
	clearAll(): void;
}

export function createRetryScheduler(
	timers: RetrySchedulerTimers,
	baseDelayMs: number,
	maxDelayMs: number,
): RetryScheduler {
	const pending = new Map<string, ReturnType<typeof setTimeout>>();
	const attempts = new Map<string, number>();
	const clear = (key: string) => {
		const timer = pending.get(key);
		if (timer) timers.clearTimeout(timer);
		pending.delete(key);
		attempts.delete(key);
	};
	return {
		has: (key) => pending.has(key),
		attempt: (key) => attempts.get(key) ?? 0,
		schedule(key, callback) {
			if (pending.has(key)) return false;
			const attempt = (attempts.get(key) ?? 0) + 1;
			attempts.set(key, attempt);
			const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 30));
			const timer = timers.setTimeout(() => {
				pending.delete(key);
				callback();
			}, delay);
			timer.unref?.();
			pending.set(key, timer);
			return true;
		},
		clear,
		clearAll() {
			for (const key of [...pending.keys()]) clear(key);
		},
	};
}
