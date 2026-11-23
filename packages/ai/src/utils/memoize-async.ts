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
