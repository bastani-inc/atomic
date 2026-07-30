/**
 * ConcurrencyLimiter — simple semaphore for per-run stage concurrency.
 *
 * Limits how many stage methods can execute simultaneously within a single run.
 * Callers `await limiter.acquire()` before starting, then call `release()` in a
 * finally block when done. The `run()` helper composes both automatically.
 */

export class ConcurrencyLimiter {
	private _running = 0;
	private readonly _queue: Array<() => void> = [];

	constructor(readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new RangeError(`ConcurrencyLimiter: limit must be a positive integer, got ${limit}`);
		}
	}

	/** Current number of in-flight tasks. */
	get running(): number {
		return this._running;
	}

	/** Number of tasks waiting for a slot. */
	get queued(): number {
		return this._queue.length;
	}

	/**
	 * Acquire a slot.  Resolves immediately when capacity is available; otherwise
	 * queues the caller until a slot is released.
	 */
	acquire(): Promise<void> {
		if (this._running < this.limit) {
			this._running++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this._queue.push(resolve);
		});
	}

	/**
	 * Release a slot.  If callers are queued, the next one is unblocked.
	 */
	release(): void {
		const next = this._queue.shift();
		if (next !== undefined) {
			// Keep _running the same — we're handing the slot directly to the next waiter.
			next();
		} else {
			this._running--;
		}
	}

	/**
	 * Convenience wrapper: acquires a slot, runs `fn`, releases on completion.
	 * Rethrows any error thrown by `fn` after releasing.
	 */
	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}
}

/**
 * Create a per-run ConcurrencyLimiter from a resolved config value.
 * Falls back to the library default (4) when `defaultConcurrency` is absent.
 */
export function createRunLimiter(defaultConcurrency?: number): ConcurrencyLimiter {
	return new ConcurrencyLimiter(defaultConcurrency ?? 4);
}
