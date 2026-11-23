export interface MemoizeAsyncOptions<T> {
	/**
	 * Whether a resolved value should stay cached. Defaults to caching every resolved value.
	 * Returning `false` clears the slot once the in-flight load settles (if still current) so the
	 * next call retries instead of keeping a transient fallback value.
	 */
	readonly shouldCache?: (value: T) => boolean;
}

export interface MemoizedAsync<T> {
	(): Promise<T>;
	/** Returns the cached resolved value synchronously if loaded and retained, else `undefined`. */
	peek(): T | undefined;
	/** Clears any cached or in-flight load without letting superseded loads repopulate it. */
	reset(): void;
}

/**
 * Memoizes a zero-argument asynchronous loader with single-flight coalescing while never caching
 * rejected loads or synchronous throws. Only the currently cached flight can clear or populate the
 * slot, so a settled superseded flight after {@link MemoizedAsync.reset} never clobbers a newer load.
 */
export function memoizeAsync<T>(load: () => Promise<T>, options?: MemoizeAsyncOptions<T>): MemoizedAsync<T> {
	const shouldCache = options?.shouldCache;
	let pending: Promise<T> | undefined;
	let resolved: { readonly value: T } | undefined;

	const get = ((): Promise<T> => {
		if (pending !== undefined) return pending;
		let current: Promise<T>;
		try {
			current = Promise.resolve(load());
		} catch (error) {
			return Promise.reject(error);
		}
		const tracked: Promise<T> = current
			.then((value) => {
				if (pending === tracked) {
					if (shouldCache && !shouldCache(value)) {
						pending = undefined;
					} else {
						resolved = { value };
					}
				}
				return value;
			})
			.catch((error: unknown) => {
				if (pending === tracked) {
					pending = undefined;
					resolved = undefined;
				}
				throw error;
			});
		pending = tracked;
		return tracked;
	}) as MemoizedAsync<T>;

	get.peek = (): T | undefined => resolved?.value;
	get.reset = (): void => {
		pending = undefined;
		resolved = undefined;
	};
	return get;
}

export interface MemoizedAsyncByKey<K, T> {
	(key: K): Promise<T>;
	/** Clears one cached key, or all cached keys when called with no arguments. */
	reset(key?: K): void;
}

/**
 * Keyed variant of {@link memoizeAsync} with per-key single-flight coalescing and identity-checked
 * clearing on rejection, synchronous throw, or when `shouldCache(value)` returns `false`.
 */
export function memoizeAsyncByKey<K, T>(
	load: (key: K) => Promise<T>,
	options?: MemoizeAsyncOptions<T>,
): MemoizedAsyncByKey<K, T> {
	const shouldCache = options?.shouldCache;
	const entries = new Map<K, Promise<T>>();

	const get = ((key: K): Promise<T> => {
		const existing = entries.get(key);
		if (existing !== undefined) return existing;
		let current: Promise<T>;
		try {
			current = Promise.resolve(load(key));
		} catch (error) {
			return Promise.reject(error);
		}
		const tracked: Promise<T> = (
			shouldCache
				? current.then((value) => {
						if (!shouldCache(value) && entries.get(key) === tracked) {
							entries.delete(key);
						}
						return value;
					})
				: current
		).catch((error: unknown) => {
			if (entries.get(key) === tracked) {
				entries.delete(key);
			}
			throw error;
		});
		entries.set(key, tracked);
		return tracked;
	}) as MemoizedAsyncByKey<K, T>;

	get.reset = (...args: [] | [key: K]): void => {
		if (args.length === 0) entries.clear();
		else entries.delete(args[0]);
	};
	return get;
}
