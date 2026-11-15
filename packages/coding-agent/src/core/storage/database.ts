import type { StorageDialect } from "./dialect.js";

export type SqliteValue = null | number | bigint | string | Uint8Array;
export type SqliteRow = Readonly<Record<string, SqliteValue>>;

export interface SqliteRunResult {
	readonly changes: number;
}

export interface SqliteExecutor {
	exec(sql: string): Promise<void>;
	run(sql: string, ...params: readonly SqliteValue[]): Promise<SqliteRunResult>;
	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined>;
	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]>;
}

export interface StorageDescriptor {
	readonly adapter: string;
	readonly location: string;
}

/** One statement of a batch: SQL with positional `?` parameters. */
export interface SqliteStatement {
	readonly sql: string;
	readonly params: readonly SqliteValue[];
}

/** How one write transaction waits for the database's write lock, and whether it may run again. */
export interface SqliteTransactionOptions {
	/**
	 * How long the transaction keeps waiting for the write lock while it is held and no other connection commits,
	 * instead of the connection's own lock wait. A writer whose work must not fail because another process stalled
	 * with the lock held (starved of CPU, paused by garbage collection, stopped by a signal) waits longer: the holder
	 * still commits or rolls back once it runs again. Adapters without a lock wait of their own ignore it.
	 */
	readonly lockWaitMs?: number;
	/**
	 * Lets a database from `createSqliteDatabase` run the callback again, in a new transaction, when a transient
	 * failure (`StorageTransientError`) ended the transaction before it committed, so nothing of it was written. Set it
	 * only for a callback that does nothing but use the transaction handle: anything else it does happens once per run.
	 * Other databases ignore it.
	 */
	readonly retryTransientFailures?: boolean;
	/**
	 * How the transaction excludes other writers; `{ kind: "serial" }` when absent. SQLite runs every kind as
	 * `BEGIN IMMEDIATE`; only a driver that runs transactions concurrently (Postgres) tells them apart.
	 */
	readonly concurrency?: TransactionConcurrency;
}

/** How one batch waits for a busy write lock, and whether it goes ahead of the database's queued calls. */
export interface SqliteBatchOptions {
	/**
	 * How long a batch that found the database's write lock busy keeps sending again, with growing randomized waits
	 * between tries. A busy batch wrote nothing, so sending it again is safe. Adapters without such a retry ignore it.
	 */
	readonly lockWaitMs?: number;
	/**
	 * Runs the batch before calls queued on this database that do not set it, and outside any limit the adapter puts on
	 * concurrent writes: for small writes that must not wait behind others, such as a lease renewal.
	 */
	readonly priority?: boolean;
}

/**
 * An audited fenced write path. Only `fencedPath(name)` in `fenced-paths.ts` makes one; a plain string is not one. The
 * brand is a string key, not a unique symbol, so the published declarations and the sources stay one type.
 */
export type FencedPathId = string & { readonly __atomicFencedPath: true };

/**
 * `serial`: the body runs as if it were the only writer of `domain`, or of the whole database when `domain` is absent:
 * `BEGIN IMMEDIATE` on SQLite, `BEGIN` plus that domain's transaction advisory lock on Postgres. Several prefixes may
 * share one database, so `domain` names the scope in full: a store passes one of its prefixed table names.
 * `fenced`: the body runs under READ COMMITTED and takes the row locks it relies on itself
 * (`StorageDialect.lockClause`); `audit` names the reviewed path. Identical to `serial` on SQLite.
 */
export type TransactionConcurrency =
	| { readonly kind: "serial"; readonly domain?: string }
	| { readonly kind: "fenced"; readonly audit: FencedPathId };

export interface SqliteDatabase extends SqliteExecutor {
	readonly descriptor: StorageDescriptor;
	/** The SQL dialect the database speaks; absent means SQLite. Read it through `dialectOf(database)`. */
	readonly dialect?: StorageDialect;
	transaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		options?: SqliteTransactionOptions,
	): Promise<T>;
	/**
	 * Runs the statements in order, in one write transaction, as one call to the database: all of them commit or none
	 * do. Resolves with each statement's rows. Present only when the driver can send a batch in one request, which
	 * saves a round trip per statement against a remote database.
	 */
	batch?(statements: readonly SqliteStatement[], options?: SqliteBatchOptions): Promise<SqliteRow[][]>;
	close(): Promise<void>;
}
