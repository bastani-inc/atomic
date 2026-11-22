import type { SqliteExecutor, SqliteStatement } from "./database.js";

/**
 * A statement of a sequence, run with `run`; with `script`, SQL text of one or more statements without parameters,
 * run as `exec` runs it.
 */
export interface SequencedStatement extends SqliteStatement {
	readonly script?: boolean;
}

/**
 * The most statements one request of a sequence carries, so a message to the connection's thread stays small: a
 * sequence of no more is sent as one request, at once.
 */
export const MAX_SEQUENCE_REQUEST_STATEMENTS = 256;

/** Statements run as one sequence: `repeat` first, then `statements` in order, each with `run` (or `exec`). */
export interface SqliteSequence {
	/**
	 * `statement` run up to `times` times, each run between two reads of `SELECT total_changes() AS changes`, stopping
	 * after the first run that changed fewer than `minChanges` rows in all: how SQLite's full-text `merge` command tells
	 * whether it did any work.
	 */
	readonly repeat?: { readonly statement: SqliteStatement; readonly times: number; readonly minChanges: number };
	/** Taken a request's worth at a time, so a long sequence is never held in memory, or sent, all at once. */
	readonly statements: Iterable<SequencedStatement>;
	/**
	 * Read before each run of `repeat` and before each statement, where a caller running them one at a time would call
	 * `signal.throwIfAborted()`: once it has aborted nothing more runs, and the sequence rejects with `signal.reason`.
	 */
	readonly signal?: AbortSignal;
}

/**
 * Runs a sequence in as few calls to the connection as its size allows, with exactly the statements, in the same order,
 * that running them one at a time would: it stops at the first statement that fails, with that statement's error, and
 * runs nothing after it. Resolves with how many runs of `repeat` changed `minChanges` rows or more.
 */
export type RunSequence = (sequence: SqliteSequence) => Promise<number>;

/** A sequence runner, with the statement methods it stands for as the executor had them when it was offered. */
interface OfferedSequences {
	readonly run: RunSequence;
	readonly statements: Pick<SqliteExecutor, "run" | "get">;
}

// Shared across module reloads, as the transaction handles are.
const SEQUENCES = Symbol.for("atomic-storage/statement-sequences@1");
const sequenceBag = globalThis as typeof globalThis &
	Record<symbol, WeakMap<SqliteExecutor, OfferedSequences> | undefined>;
const sequences = sequenceBag[SEQUENCES] ?? new WeakMap<SqliteExecutor, OfferedSequences>();
sequenceBag[SEQUENCES] = sequences;

/** Lets `executor`, and not a wrapper around it, run sequences through `run`. */
export function offerSequences(executor: SqliteExecutor, run: RunSequence): void {
	sequences.set(executor, { run, statements: { run: executor.run, get: executor.get } });
}

/**
 * How `executor` runs a sequence in one call to its connection, where that saves a round trip per statement (a
 * transaction of a SQLite file connection on a thread of its own); undefined for any other executor, including a
 * wrapper around such a one or one whose `run` or `get` was replaced, whose own methods must see each statement.
 */
export function sequenceRunner(executor: SqliteExecutor): RunSequence | undefined {
	const offered = sequences.get(executor);
	if (offered === undefined) return undefined;
	const { statements } = offered;
	return executor.run === statements.run && executor.get === statements.get ? offered.run : undefined;
}
