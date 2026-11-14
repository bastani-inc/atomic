import {
	type SqliteExecutor,
	type SqliteRow,
	type SqliteStatement,
	StorageTransientError,
} from "@bastani/atomic/storage";
import type { SqlPoolBatchOptions, SqlPoolStorage } from "./internal.js";
import { JOURNAL_TRANSACTION } from "./internal.js";

/** The message a fence that no longer holds aborts its batch with. */
const FENCE_MESSAGE = "atomic-pool-fence";
/** The first wait before a write whose fence broke plans again; each later wait may be twice as long. */
const FENCE_RETRY_BASE_MS = 5;
/** The longest wait between two plans of one write. */
const FENCE_RETRY_MAX_MS = 1000;
/**
 * How many times one write is planned again after a request whose outcome is unknown, such as one the server left
 * unanswered. A server that keeps failing so is unreachable, and the failure goes to the caller, which waits it out.
 */
const UNKNOWN_OUTCOME_REPLANS = 2;

export function poolFenceTable(runs: string): string {
	return `${runs}_pool_fence`;
}

/**
 * The table a pool batch's fences insert into when what the write decided on no longer holds: its trigger aborts the
 * batch, so nothing of the batch is written. It never holds a row.
 */
export function poolFenceSchema(runs: string): string {
	const fence = poolFenceTable(runs);
	return `CREATE TABLE IF NOT EXISTS ${fence}(reason TEXT);
	CREATE TRIGGER IF NOT EXISTS ${fence}_abort BEFORE INSERT ON ${fence} BEGIN SELECT RAISE(ABORT, '${FENCE_MESSAGE}'); END;`;
}

/** A pool write planned from what a read saw, sent to the database as one request. */
export interface PoolWrite<T> {
	/**
	 * Queries that each return a row while what the plan decided on still holds, checked first in the request: when one
	 * returns none, nothing is written and the write is planned again from a new read.
	 */
	readonly fences?: readonly SqliteStatement[];
	readonly writes: readonly SqliteStatement[];
	/** Read after the writes, in the same request. */
	readonly reads?: readonly SqliteStatement[];
	/** The write's outcome, from the rows of `reads`, one array per read. */
	readonly result: (rows: readonly SqliteRow[][]) => T;
}

/** What a write plan decided: an outcome that needs no write, or the write to send. */
export type PoolWritePlan<T> = { readonly done: T } | PoolWrite<T>;

/**
 * Plans a pool write from what `read` sees. `optimistic` is true only for the first plan of a batched write: such a
 * plan may skip reads whose checks its fences repeat, so a write expected to succeed costs one request, and leaves the
 * typed refusal to the plan that follows a broken fence. Every other plan reads and checks everything itself.
 */
export type PoolWritePlanner<T> = (
	read: SqliteExecutor,
	optimistic: boolean,
	/** The previous send's outcome is unknown: it may have committed, and the plan finds out first what it did. */
	afterUnknown: boolean,
) => Promise<PoolWritePlan<T>>;

/**
 * Whether `error` is a batch a fence aborted: the trigger's message, read along the cause chain, where every SQLite
 * driver puts the message a trigger raised.
 */
function isFenceAbort(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
		const { message, cause } = current as { readonly message?: unknown; readonly cause?: unknown };
		if (typeof message === "string" && message.includes(FENCE_MESSAGE)) return true;
		current = cause;
	}
	return false;
}

/**
 * One pool write that never holds the write lock across a round trip (#4768). On a database that sends a batch in one
 * request, `plan` reads outside the lock, and its fences, writes and reads go as one batch: a fence that no longer
 * holds aborts it, and the write is planned again from a new read after a short random wait, for up to the journal's
 * lock wait (a fence that keeps breaking means other writers keep changing what it decides on). A request the server
 * left unanswered or lost is planned again the same way, a few times, so a stuck server fails the write rather than
 * hanging it. Without batches, as for a node:sqlite journal, `plan` reads inside one write transaction and its writes
 * and reads follow in it, as every pool write did before; its fences need no check there.
 */
export async function guardedPoolWrite<T>(
	storage: SqlPoolStorage,
	plan: PoolWritePlanner<T>,
	options?: SqlPoolBatchOptions,
): Promise<T> {
	const batch = storage.batch;
	if (batch === undefined)
		return storage.transaction(async (tx) => {
			const planned = await plan(tx, false, false);
			if ("done" in planned) return planned.done;
			for (const write of planned.writes) await tx.run(write.sql, ...write.params);
			const rows: SqliteRow[][] = [];
			for (const read of planned.reads ?? []) rows.push(await tx.all(read.sql, ...read.params));
			return planned.result(rows);
		});
	const fence = poolFenceTable(storage.tables.runs);
	const deadline = Date.now() + (JOURNAL_TRANSACTION.lockWaitMs ?? 0);
	let unknownOutcomes = 0;
	let afterUnknown = false;
	for (let attempt = 0; ; attempt++) {
		const replay = afterUnknown;
		const planned = await storage.read((read) => plan(read, attempt === 0, replay));
		if ("done" in planned) return planned.done;
		const fences = (planned.fences ?? []).map(
			(statement): SqliteStatement => ({
				sql: `INSERT INTO ${fence}(reason) SELECT NULL WHERE NOT EXISTS (${statement.sql})`,
				params: statement.params,
			}),
		);
		const reads = planned.reads ?? [];
		try {
			const rows = await batch([...fences, ...planned.writes, ...reads], options);
			return planned.result(rows.slice(rows.length - reads.length));
		} catch (error) {
			// A request the server never answered, or one whose connection broke, may or may not have committed: the next
			// plan reads which, and every planned write is fenced so that repeating one that committed changes nothing.
			// Other failures, a server refusing connections included, go to the caller.
			const unknown =
				error instanceof StorageTransientError &&
				error.outcome === "unknown" &&
				++unknownOutcomes <= UNKNOWN_OUTCOME_REPLANS;
			if (!(isFenceAbort(error) || unknown) || Date.now() >= deadline) throw error;
			afterUnknown = unknown;
		}
		const bound = Math.min(FENCE_RETRY_MAX_MS, FENCE_RETRY_BASE_MS * 2 ** Math.min(attempt, 16));
		await new Promise((resolve) => setTimeout(resolve, Math.random() * bound));
	}
}
