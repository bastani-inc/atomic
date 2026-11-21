/**
 * Writes into extension transpile caches that are still running: stored transforms, graph manifests and the worker
 * transforms a source checkout prepares. A module an extension imports after it started stores its transform after
 * the import has settled, so no load waits for those writes. Closing a session waits for them instead, so nothing an
 * extension started still writes into an agent directory its caller may remove once `dispose()` has resolved.
 */
const pending = new Set<Promise<unknown>>();

/** Tracks `write` until it settles, and returns it. */
export function trackTranspileCacheWrite<T>(write: Promise<T>): Promise<T> {
	pending.add(write);
	const settled = (): void => {
		pending.delete(write);
	};
	void write.then(settled, settled);
	return write;
}

/** Settles once no transpile cache write is running, including those that start while it waits. */
export async function transpileCacheWritesSettled(): Promise<void> {
	while (pending.size > 0) await Promise.allSettled(pending);
}
