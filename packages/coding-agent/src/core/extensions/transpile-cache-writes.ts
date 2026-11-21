import { asyncScope } from "../async-scope.ts";

/**
 * Writes into extension transpile caches that are still running: stored transforms, graph manifests and the worker
 * transforms a source checkout prepares. A module an extension imports after it started stores its transform after
 * the import has settled, so no load waits for those writes. Each write belongs to the session whose work started it,
 * and closing that session waits a few seconds for them, so nothing its extensions started still writes into an
 * agent directory its caller may remove once `dispose()` has resolved. A write that is not finished by then is left
 * to finish on its own, as before; another session's writes are never waited for.
 */

/** How long closing a session waits for the transpile cache writes its work started. */
export const TRANSPILE_CACHE_WRITE_WAIT_MS = 5_000;

// Weak, so work an owner leaves behind (a timer, say) does not keep the owner alive.
const owners = asyncScope<WeakRef<object>>();
const owned = new WeakMap<object, Set<Promise<unknown>>>();

/**
 * Runs `operation` as `owner`'s work: the transpile cache writes it starts are `owner`'s. With `inherit`, work that
 * already has an owner keeps it.
 */
export function withTranspileCacheWriteOwner<T>(
	owner: object,
	operation: () => T,
	options: { inherit?: boolean } = {},
): T {
	const inherited = options.inherit ? owners.getStore()?.deref() : undefined;
	return owners.run(new WeakRef(inherited ?? owner), operation);
}

/** Tracks `write` as the current owner's until it settles, and returns it. */
export function trackTranspileCacheWrite<T>(write: Promise<T>): Promise<T> {
	const owner = owners.getStore()?.deref();
	if (owner === undefined) return write;
	let writes = owned.get(owner);
	if (writes === undefined) {
		writes = new Set();
		owned.set(owner, writes);
	}
	const pending = writes;
	pending.add(write);
	const settled = (): void => {
		pending.delete(write);
	};
	void write.then(settled, settled);
	return write;
}

/**
 * Waits up to `limitMs` until none of `owner`'s transpile cache writes is running, including those that start while it
 * waits. Returns how many are still running then.
 */
export async function transpileCacheWritesSettled(owner: object, limitMs: number): Promise<number> {
	const writes = owned.get(owner);
	if (!writes?.size) return 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), limitMs);
	});
	try {
		while (writes.size > 0) {
			const settled = Promise.allSettled(writes).then(() => "settled" as const);
			if ((await Promise.race([settled, expired])) === "expired") break;
		}
		return writes.size;
	} finally {
		clearTimeout(timer);
	}
}
