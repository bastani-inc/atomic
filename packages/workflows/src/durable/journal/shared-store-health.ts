import type { SharedStoreWrites } from "./internal.js";
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

/**
 * The event the libSQL adapter emits on `process` as a server stops answering writes and answers them again. Atomic's
 * CLI silences `process.emitWarning`, so status listens for it as well as for the adapter's warnings.
 */
const WRITE_HEALTH_EVENT = "atomic-libsql-write-health";

/** The libSQL adapter's last write-stall report in this process, until the report that writes get through again. */
let stalled: string | undefined;
function noteWriteHealth(health: { readonly stalled: boolean; readonly message: string }): void {
	stalled = health.stalled ? withoutUrlCredentials(health.message) : undefined;
}
process.on("warning", (warning: Error & { readonly code?: string }) => {
	if (warning.code === WRITES_STALLED) noteWriteHealth({ stalled: true, message: warning.message });
	else if (warning.code === WRITES_RECOVERED) noteWriteHealth({ stalled: false, message: warning.message });
});
process.on(WRITE_HEALTH_EVENT, noteWriteHealth);

/** The shared store as this process last saw it answer: `degraded` after a stall warning, else `ok`. */
export function sharedStoreHealth(): SharedStoreHealth {
	return stalled === undefined ? { state: "ok" } : { state: "degraded", message: stalled };
}

/** How long one of this process's writes may wait for the shared store before status reports it degraded (#4768). */
export const STORE_WRITE_STALL_MS = 10_000;
/** How many of this process's writes in a row the shared store may refuse before status reports it degraded. */
export const STORE_WRITE_FAILURES = 3;

export { SharedStoreWrites } from "./internal.js";

/** How long a status reader's write probe may wait for the store to commit it before status reports it degraded. */
export const STORE_PROBE_TIMEOUT_MS = 2_000;

/** How a write probe ended: committed, unanswered within {@link STORE_PROBE_TIMEOUT_MS}, or failed. */
export type SharedStoreProbe = "committed" | "timed-out" | { readonly failure: Error };

/**
 * Runs `write`, a write that changes nothing, for at most {@link STORE_PROBE_TIMEOUT_MS} (#4768). Only a reader whose
 * journal serves nothing else probes: a journal runs one call at a time, so a probe the store leaves unanswered holds
 * up every call after it. A probe that settles after it timed out is dropped.
 */
export async function probeSharedStoreWrite(write: () => Promise<unknown>): Promise<SharedStoreProbe> {
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<"timed-out">((resolve) => {
		timer = setTimeout(() => resolve("timed-out"), STORE_PROBE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([write().then(() => "committed" as const), timedOut]);
	} catch (error) {
		return { failure: error as Error };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The shared store's health (#4768), the one detector of a store that stopped committing writes, from what this
 * process saw. First match wins:
 * - one of this process's writes waited {@link STORE_WRITE_STALL_MS}, or a write `probe` did not commit within
 *   {@link STORE_PROBE_TIMEOUT_MS}: `degraded`, as a wedged sqld leaves writes;
 * - the status read, a bounded read probe, ran out of {@link STATUS_READ_TIMEOUT_MS}: `degraded`;
 * - the write probe failed, or the store failed {@link STORE_WRITE_FAILURES} writes in a row: `degraded` while hosts
 *   are registered, whose work it holds up, else `unknown`;
 * - the status read failed: `unknown`;
 * - else the libSQL adapter's own report, `degraded` after a stall it reported, or `ok`.
 * Every degraded or unknown store this function finds carries {@link SHARED_STORE_HINT}.
 */
export function classifySharedStoreHealth(observed: {
	readonly writes?: SharedStoreWrites;
	readonly hostsRegistered: boolean;
	readonly readFailure?: Error;
	readonly probe?: SharedStoreProbe;
}): SharedStoreHealth {
	const found = (state: "degraded" | "unknown", message: string) => ({
		state,
		message: withoutUrlCredentials(message),
		hint: SHARED_STORE_HINT,
	});
	const waitedMs = observed.writes?.oldestWaitingMs();
	if (waitedMs !== undefined && waitedMs >= STORE_WRITE_STALL_MS)
		return found(
			"degraded",
			`A write has waited more than ${STORE_WRITE_STALL_MS / 1000} s for the shared store to commit it.`,
		);
	const probe = observed.probe;
	if (probe === "timed-out")
		return found("degraded", `The shared store did not commit a write within ${STORE_PROBE_TIMEOUT_MS / 1000} s.`);
	if (observed.readFailure instanceof SharedStoreStatusTimeoutError)
		return found("degraded", observed.readFailure.message);
	if (probe !== undefined && probe !== "committed")
		return found(
			observed.hostsRegistered ? "degraded" : "unknown",
			`The shared store refused a write: ${probe.failure.message}`,
		);
	const writes = observed.writes;
	if (writes !== undefined && writes.failuresInRow >= STORE_WRITE_FAILURES)
		return found(
			observed.hostsRegistered ? "degraded" : "unknown",
			`The shared store failed ${writes.failuresInRow} writes in a row: ${writes.lastFailure!.message}`,
		);
	if (observed.readFailure !== undefined) return found("unknown", observed.readFailure.message);
	return sharedStoreHealth();
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
