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

/** How a transaction takes its snapshot or write lock, and whether it may run again. */
export interface SqliteTransactionOptions {
	/** @internal A consistent read snapshot without a writer lock. The callback must only read. */
	readonly readOnly?: boolean;
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
	 * `BEGIN IMMEDIATE` unless `readOnly` is set; only a driver that runs transactions concurrently (Postgres) tells them apart.
	 */
	readonly concurrency?: TransactionConcurrency;
	/**
	 * @internal The statements the callback makes first, in this order, before it acts on any answer. A driver whose
	 * transactions are pipelined sends them with the transaction's start, so they cost no round trip of their own, and
	 * starts the callback once they are answered; each call of the callback that makes the next of them gets its answer.
	 * Name only reads: a call that differs from the next of them ends the lead, and the answers of the rest go unused,
	 * though they ran. A write may lead only as the callback's first call, made on every run whatever it reads, such as a
	 * fenced path's one guarded write: it never runs unused. Other drivers ignore it.
	 */
	readonly leading?: readonly SqliteStatement[];
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
 * `fenced`: the body runs under READ COMMITTED and takes the row locks it relies on itself. With `excludesSerial`, it
 * also waits for and excludes `serial` transactions without a domain, as a `serial` transaction with a domain does,
 * for a body whose check a whole-database writer (such as snapshot garbage collection) could otherwise race
 * (`StorageDialect.lockClause`); `audit` names the reviewed path. Identical to `serial` on SQLite.
 */
export type TransactionConcurrency =
	| { readonly kind: "serial"; readonly domain?: string }
	| { readonly kind: "fenced"; readonly audit: FencedPathId; readonly excludesSerial?: boolean };

/**
 * What a database's listening connection is doing: `listening`, notifications arrive; `connecting`, it is not known yet;
 * `unavailable`, none arrive, and pollers find the work: `pooler` when the endpoint is a transaction pooler (a
 * notification sent through the database did not reach the listening session), `connection-failed` when the listening
 * connection could not be opened or broke.
 */
export type StorageListenerState =
	| { readonly status: "listening" }
	| { readonly status: "connecting" }
	| { readonly status: "unavailable"; readonly reason: "pooler" | "connection-failed" };

/**
 * `notification`: a transaction that ran `notify(channel, payload)` committed. `listening`: the listening connection
 * began listening again after it was unavailable, so notifications sent meanwhile were lost.
 */
export type StorageNotificationEvent =
	| { readonly kind: "notification"; readonly payload: string }
	| { readonly kind: "listening" };

export interface StorageNotificationSubscription {
	/** Stops delivering events to this listener; idempotent. */
	close(): void;
}

/**
 * Wake-ups through the database (#5103): Postgres `LISTEN`/`NOTIFY`. A notification is only a hint that a poller would
 * find the same work at its next poll; notifications are lost while the listening connection is down, and through a
 * transaction pooler none arrive, so a store that sends them keeps its poll.
 */
export interface StorageNotifications {
	/**
	 * A statement that sends `payload` to the listeners of `channel` when the transaction it runs in commits, and never
	 * when it rolls back: run it in the transaction of the write it announces. `channel` is a name such as
	 * `<prefix>pool_ready`; the database shortens a long one the same way for `notify` and `listen`.
	 */
	notify(channel: string, payload: string): SqliteStatement;
	/** Delivers `channel`'s events to `listener`, on one listening connection the database shares between channels. */
	listen(channel: string, listener: (event: StorageNotificationEvent) => void): StorageNotificationSubscription;
	/** Opens the listening connection when it is not open, and resolves with its state once the first attempt settled. */
	state(): Promise<StorageListenerState>;
}

/**
 * @internal What a driver read of its schema in its open's own round trip (#6560): the rows of the catalog read
 * `readStorageSchemaCatalog` makes (`kind` `relation`, `trigger` or `column`, with `name` and `detail`) and the
 * versions `ledger` records, as rows of `domain` and `version`; `versions` is undefined when the ledger did not exist.
 */
export interface StorageOpenedCatalog {
	readonly ledger: string;
	readonly rows: readonly SqliteRow[];
	readonly versions: readonly SqliteRow[] | undefined;
}

export interface SqliteDatabase extends SqliteExecutor {
	/**
	 * True when the connection refuses writes, as `openNodeSqliteDatabase(path, { readOnly: true })` sets it, so opening a
	 * session store skips a cleanup write that would fail. Optional: a read-only connection that leaves it unset still
	 * opens a session store, whose failed cleanup is ignored.
	 */
	readonly readOnly?: boolean;
	readonly descriptor: StorageDescriptor;
	/**
	 * @internal Which database this handle reaches, for comparison only: two handles this process opened answer the same
	 * string only when a transaction of either reads and writes the very tables the other does (the same adapter, server
	 * or file, database, schema or namespace). Undefined, or absent, where that cannot be told, as for a database in
	 * memory: such a handle is the same database as itself alone.
	 */
	databaseIdentity?(): string | undefined;
	/** @internal Checks whether this embedded connection can prepare a JSONB extraction without issuing a read. */
	supportsJsonbExtract?(): Promise<boolean>;
	/** The SQL dialect the database speaks; absent means SQLite. Read it through `dialectOf(database)`. */
	readonly dialect?: StorageDialect;
	/** Wake-ups through the database; present only on a database that delivers them (Postgres). */
	readonly notifications?: StorageNotifications;
	/**
	 * The bytes this process may still write on the file system that holds the database's file (where a link to the file
	 * points, and where its write-ahead log goes), as a SQLite or libSQL file database reports them. Absent, or resolving
	 * undefined, when this process cannot see the database's disk (a server, memory) or the file system does not say.
	 */
	freeBytes?(): Promise<number | undefined>;
	/** @internal Run one short maintenance transaction only if this handle, its writer gate and the database lock
	 * are immediately available. A backend without no-wait admission leaves this absent. */
	tryMaintenance?(callback: (transaction: SqliteExecutor) => Promise<void>): Promise<boolean>;
	/** Opens a separate handle on this same database for reads. It has its own call queue; the caller must close it. */
	openReader?(): Promise<SqliteDatabase>;
	/**
	 * @internal The schema the driver read when it opened, given once: the first store open answers its schema checks
	 * from it instead of reading the catalog again. Undefined after the first call, and where the driver read none.
	 */
	takeOpenedCatalog?(): StorageOpenedCatalog | undefined;
	transaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		options?: SqliteTransactionOptions,
	): Promise<T>;
	/**
	 * @internal Runs `statement` by itself as one request that commits on its own, queued in this process as a
	 * transaction of `concurrency` is: behind the calls such a transaction waits for, and ahead of the calls that wait
	 * for it. The statement takes on the server whatever locks it needs itself, such as a function that takes the
	 * domain's advisory locks. A transient failure that applied nothing runs it again. Resolves with its rows. Present
	 * only where the driver runs transactions concurrently (PostgreSQL).
	 */
	autocommit?(statement: SqliteStatement, concurrency: TransactionConcurrency): Promise<SqliteRow[]>;
	/**
	 * Runs the statements in order, in one write transaction, as one call to the database: all of them commit or none
	 * do. Resolves with each statement's rows. Present only when the driver can send a batch in one request, which
	 * saves a round trip per statement against a remote database.
	 */
	batch?(statements: readonly SqliteStatement[], options?: SqliteBatchOptions): Promise<SqliteRow[][]>;
	close(): Promise<void>;
}
