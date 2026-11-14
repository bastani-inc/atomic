import type { SharedStoreHealth } from "./shared-pool-types.js";

/** The warnings the libSQL storage adapter emits when a server stops answering writes, and when it answers again. */
const WRITES_STALLED = "ATOMIC_LIBSQL_WRITES_STALLED";
const WRITES_RECOVERED = "ATOMIC_LIBSQL_WRITES_RECOVERED";

/** How long a status read may take before status reports the store `unknown` instead of waiting (#4768). */
export const STATUS_READ_TIMEOUT_MS = 5_000;

/** What fleet status says when it cannot read the shared store, in the words of the libSQL adapter's stall warning. */
export const SHARED_STORE_HINT =
	"If the shared store is sqld: sqld 0.24.33 and earlier can stop taking writes from every client until it restarts (https://github.com/tursodatabase/libsql/issues/2286); start sqld with --checkpoint-interval-s 60 (SQLD_CHECKPOINT_INTERVAL_S=60) to avoid it, and restart it now if writes stay stuck.";

/** A status read that did not finish within {@link STATUS_READ_TIMEOUT_MS}. */
export class SharedStoreStatusTimeoutError extends Error {
	override readonly name = "SharedStoreStatusTimeoutError";
	constructor(timeoutMs: number) {
		super(`The shared store did not answer within ${timeoutMs / 1000} s.`);
	}
}

/** `text` without the query, fragment or user info of any URL in it, where a credential could sit. */
export function withoutUrlCredentials(text: string): string {
	return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@]*@)?([^\s?#]*)(?:[?#][^\s]*)?/gi, "$1$2");
}

/** The libSQL adapter's last write-stall warning in this process, until the warning that writes get through again. */
let stalled: string | undefined;
process.on("warning", (warning: Error & { readonly code?: string }) => {
	if (warning.code === WRITES_STALLED) stalled = withoutUrlCredentials(warning.message);
	else if (warning.code === WRITES_RECOVERED) stalled = undefined;
});

/** The shared store as this process last saw it answer: `degraded` after a stall warning, else `ok`. */
export function sharedStoreHealth(): SharedStoreHealth {
	return stalled === undefined ? { state: "ok" } : { state: "degraded", message: stalled };
}

/** The store a status read could not read, with why and how to recover from a store that stopped taking writes. */
export function unknownSharedStore(error: unknown): SharedStoreHealth & {
	readonly state: "unknown";
	readonly message: string;
	readonly hint: string;
} {
	return { state: "unknown", message: withoutUrlCredentials((error as Error).message), hint: SHARED_STORE_HINT };
}

/**
 * `read`, or a {@link SharedStoreStatusTimeoutError} once it took {@link STATUS_READ_TIMEOUT_MS}: a status read never
 * waits on a store that stopped answering. A read that finishes later is dropped.
 */
export async function withinStatusBudget<T>(read: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new SharedStoreStatusTimeoutError(STATUS_READ_TIMEOUT_MS)),
			STATUS_READ_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([read, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
