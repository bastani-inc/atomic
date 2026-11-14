import type {
	SqliteBatchOptions,
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteTransactionOptions,
	SqliteValue,
	StorageDescriptor,
} from "./database.js";
import {
	StorageConfigError,
	StorageError,
	type StorageFailureCause,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageTransientError,
	type StorageTransientErrorCode,
	type StorageTransientOutcome,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";

type Awaitable<T> = T | Promise<T>;

/** A value as a driver returns it. Blobs may be any binary view; the facade returns them as `Uint8Array` copies. */
export type SqliteDriverValue = SqliteValue | ArrayBuffer | ArrayBufferView;

/** One statement's result as a driver returns it: column names, positional rows, and the rows it changed. */
export interface SqliteDriverResult {
	readonly columns: readonly string[];
	readonly rows: readonly ArrayLike<SqliteDriverValue>[];
	readonly changes: number;
}

/** Runs SQL on a driver connection or on an open driver transaction. */
export interface SqliteDriverExecutor {
	/** Runs one statement with positional `?` parameters. */
	execute(sql: string, params: readonly SqliteValue[]): Awaitable<SqliteDriverResult>;
	/** Runs zero or more statements that take no parameters. */
	executeMultiple(sql: string): Awaitable<void>;
}

export interface SqliteDriverTransaction extends SqliteDriverExecutor {
	commit(): Awaitable<void>;
	rollback(): Awaitable<void>;
	/** Releases the transaction after it commits or rolls back. */
	close?(): Awaitable<void>;
}

/** A driver failure that passes, as `SqliteDriver.transientFailure` recognizes it. */
export interface SqliteDriverTransientFailure {
	readonly code: StorageTransientErrorCode;
	/**
	 * `"not-applied"` when the failed request cannot have changed the database, `"unknown"` when the connection broke
	 * after the server may have applied it.
	 */
	readonly outcome: StorageTransientOutcome;
}

/** The driver calls `createSqliteDatabase` turns into a `SqliteDatabase`. */
export interface SqliteDriver extends SqliteDriverExecutor {
	/** Diagnostic identity. Its `location` passes through `redact` before the facade exposes it. */
	readonly descriptor: StorageDescriptor;
	/** Begins a write transaction that holds the database's write lock, like `BEGIN IMMEDIATE`. */
	beginTransaction(): Awaitable<SqliteDriverTransaction>;
	/**
	 * Optional. Runs the statements in order in one write transaction, in one request: all commit or none do. Provide it
	 * only when the driver sends the whole batch at once; the facade then offers `SqliteDatabase.batch`. `options` are the
	 * caller's, as `SqliteDatabase.batch` took them.
	 */
	batch?(
		statements: readonly SqliteStatement[],
		options?: SqliteBatchOptions,
	): Awaitable<readonly SqliteDriverResult[]>;
	/** Releases the connection. Called once, after accepted work drains. */
	close(): Awaitable<void>;
	/** Removes credentials from diagnostic text: the descriptor location and driver failure messages and stacks. */
	redact?(text: string): string;
	/**
	 * Optional. Recognizes a failure a driver call threw as one that passes, from the failure's own fields, before the
	 * facade redacts it. The call then fails with `StorageTransientError`, and a call that wrote nothing runs again.
	 */
	transientFailure?(failure: StorageFailureCause): SqliteDriverTransientFailure | undefined;
}

/**
 * How many times the facade runs a call that a transient failure ended before it wrote anything, the first run
 * included. A transaction runs again only when its options allow it (`retryTransientFailures`).
 */
export const STORAGE_TRANSIENT_RETRY_ATTEMPTS = 5;
/** The wait before the second run, in milliseconds; each later wait is twice as long as the one before. */
const STORAGE_TRANSIENT_RETRY_BASE_DELAY_MS = 250;
/** Each wait varies by up to this fraction either way, so processes that failed together do not retry together. */
const STORAGE_TRANSIENT_RETRY_JITTER = 0.2;

/** How long the facade waits after the failed run `attempt` (1-based) before it runs the call again. */
function transientRetryDelayMs(attempt: number): number {
	const jitter = 1 + STORAGE_TRANSIENT_RETRY_JITTER * (2 * Math.random() - 1);
	return Math.round(STORAGE_TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) * jitter);
}

/** One run of a call: which run it is, and the first transient failure it met. */
interface Attempt {
	readonly number: number;
	transient?: StorageTransientError;
}

/**
 * A redactor that replaces every non-empty secret, and its URI-encoded and URI-decoded forms, with `[redacted]`.
 * Longer secrets are replaced first, so a secret that contains another is removed whole.
 */
export function redactSecrets(secrets: Iterable<string>): (text: string) => string {
	const variants = new Set<string>();
	for (const secret of secrets) {
		variants.add(secret);
		try {
			variants.add(encodeURIComponent(secret));
		} catch {}
		try {
			variants.add(decodeURIComponent(secret));
		} catch {}
	}
	const ordered = [...variants].filter(Boolean).sort((first, second) => second.length - first.length);
	return (text) => ordered.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
}

function redactCause(cause: StorageFailureCause, redact: (text: string) => string): StorageFailureCause {
	if (typeof cause === "string") return redact(cause);
	if (!(cause instanceof Error)) return cause;
	const nested = cause.cause as StorageFailureCause;
	const safeCause = redactCause(nested, redact);
	const message = redact(cause.message);
	const stack = cause.stack === undefined ? undefined : redact(cause.stack);
	if (message === cause.message && stack === cause.stack && safeCause === nested) return cause;
	const safe = new StorageError(message, { cause: safeCause });
	safe.stack = stack;
	return safe;
}

function snapshotParams(params: readonly SqliteValue[]): SqliteValue[] {
	return params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
}

function normalizeValue(value: SqliteDriverValue): SqliteValue {
	if (typeof value === "bigint") {
		return value >= -BigInt(Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value;
	}
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
	return value;
}

function normalizeRow(row: ArrayLike<SqliteDriverValue>, columns: readonly string[]): SqliteRow {
	return Object.fromEntries(columns.map((column, index) => [column, normalizeValue(row[index] ?? null)]));
}

/** Rejects a `retryTransientFailures` that is not a boolean, before the transaction is queued. */
function retriesTransientFailures(options: SqliteTransactionOptions | undefined): boolean {
	const retry = options?.retryTransientFailures;
	if (retry !== undefined && typeof retry !== "boolean")
		throw new StorageConfigError(
			"sdk",
			"retryTransientFailures",
			"boolean-required",
			"Pass true or false, or omit it",
		);
	return retry === true;
}

/** Serializes operations in call order; a failed operation does not stop the ones queued after it. */
class CallQueue {
	private tail: Promise<void> = Promise.resolve();

	push<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	drained(): Promise<void> {
		return this.tail;
	}
}

/**
 * Runs operations one at a time, in call order within each lane: an operation of the priority lane runs before every
 * waiting operation of the normal lane. A failed operation does not stop the ones queued after it.
 */
class LaneQueue {
	private readonly normal: (() => Promise<void>)[] = [];
	private readonly priority: (() => Promise<void>)[] = [];
	private running = false;
	private idle: (() => void)[] = [];

	push<T>(operation: () => Promise<T>, priority = false): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			(priority ? this.priority : this.normal).push(() => Promise.resolve().then(operation).then(resolve, reject));
			this.next();
		});
	}

	drained(): Promise<void> {
		if (!this.running && this.normal.length === 0 && this.priority.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.idle.push(resolve));
	}

	private next(): void {
		if (this.running) return;
		const operation = this.priority.shift() ?? this.normal.shift();
		if (operation === undefined) {
			const idle = this.idle;
			this.idle = [];
			for (const resolve of idle) resolve();
			return;
		}
		this.running = true;
		// Started on a later microtask, as a promise chain starts it, never inside the call that queued it.
		void operation().finally(() => {
			this.running = false;
			this.next();
		});
	}
}

class DriverDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	private readonly driver: SqliteDriver;
	private readonly redact: (text: string) => string;
	private readonly queue = new LaneQueue();
	private closePromise?: Promise<void>;
	/** Ends the wait before a call runs again, when closing begins during it. */
	private wakeRetry?: () => void;
	private retryReported = false;
	private readonly executor: SqliteExecutor;
	readonly batch?: (statements: readonly SqliteStatement[], options?: SqliteBatchOptions) => Promise<SqliteRow[][]>;

	constructor(driver: SqliteDriver, redact: (text: string) => string) {
		this.driver = driver;
		this.redact = redact;
		this.descriptor = { adapter: driver.descriptor.adapter, location: redact(driver.descriptor.location) };
		this.executor = this.createExecutor(
			driver,
			(operation) => {
				if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
				return this.queue.push(() => this.retrying(operation, true));
			},
			true,
		);
		const batch = driver.batch?.bind(driver);
		if (batch) this.batch = (statements, options) => this.runBatch(batch, statements, options);
	}

	private runBatch(
		batch: NonNullable<SqliteDriver["batch"]>,
		statements: readonly SqliteStatement[],
		options: SqliteBatchOptions | undefined,
	): Promise<SqliteRow[][]> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		const bound = statements.map((statement) => ({ sql: statement.sql, params: snapshotParams(statement.params) }));
		const passed = options === undefined ? undefined : { ...options };
		return this.queue.push(
			() =>
				this.retrying(async (attempt) => {
					for (const statement of bound) {
						const invalidIndex = statement.params.findIndex(
							(value) => typeof value === "string" && value.includes("\0"),
						);
						if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
					}
					const results = await this.call(() => batch(bound, passed), attempt, true);
					return results.map((result) => result.rows.map((row) => normalizeRow(row, result.columns)));
				}, true),
			passed?.priority === true,
		);
	}

	/**
	 * Runs `operation` again while a transient failure ended its run before it wrote anything, waiting longer before
	 * each run, and only when `replay` allows it. Gives up with the last run's failure after
	 * `STORAGE_TRANSIENT_RETRY_ATTEMPTS` runs, or once closing begins.
	 */
	private async retrying<T>(operation: (attempt: Attempt) => Promise<T>, replay: boolean): Promise<T> {
		for (let number = 1; ; number++) {
			const attempt: Attempt = { number };
			try {
				return await operation(attempt);
			} catch (failure) {
				const transient = attempt.transient;
				if (!replay || transient?.outcome !== "not-applied" || !(await this.backoff(transient))) throw failure;
			}
		}
	}

	/**
	 * Waits before the run after `failure`'s, and says whether to run again: not after the last run, nor once closing
	 * begins, which also ends a wait under way. The first transient failure that makes the database run a call again is
	 * emitted as a process warning.
	 */
	private async backoff(failure: StorageTransientError): Promise<boolean> {
		if (failure.attempts >= STORAGE_TRANSIENT_RETRY_ATTEMPTS || this.closePromise) return false;
		if (!this.retryReported) {
			this.retryReported = true;
			process.emitWarning(failure);
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, transientRetryDelayMs(failure.attempts));
			this.wakeRetry = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.wakeRetry = undefined;
		return this.closePromise === undefined;
	}

	/**
	 * Maps a driver failure to `StorageUnavailableError` with a credential-free cause: a `StorageTransientError` when
	 * the driver recognizes it and the call belongs to an `attempt`. `applies` says whether the call commits on its
	 * own; a failed call inside an open transaction applied nothing, whatever the driver says of the request.
	 */
	private async call<T>(operation: () => Awaitable<T>, attempt?: Attempt, applies = false): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			const safe = redactCause(cause as StorageFailureCause, this.redact);
			if (attempt !== undefined) {
				const transient = this.driver.transientFailure?.(cause as StorageFailureCause);
				if (transient !== undefined) {
					const failure = new StorageTransientError(
						this.descriptor,
						{
							code: transient.code,
							outcome: applies ? transient.outcome : "not-applied",
							attempts: attempt.number,
						},
						safe,
					);
					attempt.transient ??= failure;
					throw failure;
				}
			}
			throw new StorageUnavailableError(this.descriptor, safe);
		}
	}

	private createExecutor(
		connection: SqliteDriverExecutor,
		admit: <T>(operation: (attempt: Attempt) => Promise<T>) => Promise<T>,
		applies: boolean,
	): SqliteExecutor {
		const statement = (sql: string, params: readonly SqliteValue[]) => {
			const bound = snapshotParams(params);
			return admit(async (attempt) => {
				const invalidIndex = bound.findIndex((value) => typeof value === "string" && value.includes("\0"));
				if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
				return this.call(() => connection.execute(sql, bound), attempt, applies);
			});
		};
		return {
			exec: (sql) => admit((attempt) => this.call(() => connection.executeMultiple(sql), attempt, applies)),
			run: async (sql, ...params) => ({ changes: (await statement(sql, params)).changes }),
			get: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const result = await statement(sql, params);
				const row = result.rows[0];
				return row === undefined ? undefined : (normalizeRow(row, result.columns) as T);
			},
			all: async <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) => {
				const result = await statement(sql, params);
				return result.rows.map((row) => normalizeRow(row, result.columns) as T);
			},
		};
	}

	exec(sql: string): Promise<void> {
		return this.executor.exec(sql);
	}

	run(sql: string, ...params: readonly SqliteValue[]) {
		return this.executor.run(sql, ...params);
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		return this.executor.get<T>(sql, ...params);
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		return this.executor.all<T>(sql, ...params);
	}

	transaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		options?: SqliteTransactionOptions,
	): Promise<T> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		let replay: boolean;
		try {
			replay = retriesTransientFailures(options);
		} catch (error) {
			return Promise.reject(error);
		}
		return this.queue.push(() => this.retrying((attempt) => this.runTransaction(callback, attempt), replay));
	}

	private async runTransaction<T>(
		callback: (transaction: SqliteExecutor) => Promise<T>,
		attempt: Attempt,
	): Promise<T> {
		const connection = await this.call(() => this.driver.beginTransaction(), attempt);
		const handleQueue = new CallQueue();
		let active = true;
		let result: T;
		const handle = this.createExecutor(
			connection,
			(operation) =>
				active ? handleQueue.push(() => operation(attempt)) : Promise.reject(new StorageTransactionClosedError()),
			false,
		);
		const close = () => this.call(() => connection.close?.());
		try {
			try {
				result = await callback(handle);
			} finally {
				active = false;
				await handleQueue.drained();
			}
			// Once the callback has returned, the commit's own failure decides whether the transaction runs again: a commit
			// that may have applied, or that failed for a reason the driver does not recognize, never does, whatever the
			// callback met before it. A committed transaction never runs again either.
			attempt.transient = undefined;
			await this.call(() => connection.commit(), attempt, true);
		} catch (cause) {
			let failure = cause as StorageFailureCause;
			try {
				await this.call(() => connection.rollback());
			} catch (rollbackCause) {
				failure = new StorageRollbackError(failure, rollbackCause as StorageFailureCause);
			}
			// Cleanup must not replace a callback, commit, or rollback failure.
			await close().catch(() => {});
			throw failure;
		}
		await close();
		return result;
	}

	close(): Promise<void> {
		this.closePromise ??= this.queue.drained().then(() => this.call(() => this.driver.close()));
		this.wakeRetry?.();
		return this.closePromise;
	}
}

/**
 * Wraps a SQLite-compatible driver as a `SqliteDatabase`. The facade queues operations in call order and keeps them
 * outside active transactions, snapshots binary parameters at call time, rejects NUL text, returns safe-range integers
 * as numbers and blobs as `Uint8Array` copies, expires transaction handles when their callback settles, maps driver
 * failures to `StorageUnavailableError` with credentials redacted, and reports failed rollbacks with
 * `StorageRollbackError`. A failure the driver recognizes as transient is a `StorageTransientError`; a statement, a
 * batch, or a transaction whose options allow it runs again, up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` times in all,
 * while such a failure ended it before it wrote anything. Closing rejects new calls, stops those retries, drains
 * accepted work, then closes the driver once.
 */
export function createSqliteDatabase(driver: SqliteDriver): SqliteDatabase {
	return new DriverDatabase(driver, driver.redact?.bind(driver) ?? ((text) => text));
}
