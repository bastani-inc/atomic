import type {
	SqliteDatabase,
	SqliteExecutor,
	SqliteRow,
	SqliteStatement,
	SqliteValue,
	StorageDescriptor,
} from "./database.js";
import {
	StorageError,
	type StorageFailureCause,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
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

/** The driver calls `createSqliteDatabase` turns into a `SqliteDatabase`. */
export interface SqliteDriver extends SqliteDriverExecutor {
	/** Diagnostic identity. Its `location` passes through `redact` before the facade exposes it. */
	readonly descriptor: StorageDescriptor;
	/** Begins a write transaction that holds the database's write lock, like `BEGIN IMMEDIATE`. */
	beginTransaction(): Awaitable<SqliteDriverTransaction>;
	/**
	 * Optional. Runs the statements in order in one write transaction, in one request: all commit or none do. Provide it
	 * only when the driver sends the whole batch at once; the facade then offers `SqliteDatabase.batch`.
	 */
	batch?(statements: readonly SqliteStatement[]): Awaitable<readonly SqliteDriverResult[]>;
	/** Releases the connection. Called once, after accepted work drains. */
	close(): Awaitable<void>;
	/** Removes credentials from diagnostic text: the descriptor location and driver failure messages and stacks. */
	redact?(text: string): string;
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

class DriverDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	private readonly driver: SqliteDriver;
	private readonly redact: (text: string) => string;
	private readonly queue = new CallQueue();
	private closePromise?: Promise<void>;
	private readonly executor: SqliteExecutor;
	readonly batch?: (statements: readonly SqliteStatement[]) => Promise<SqliteRow[][]>;

	constructor(driver: SqliteDriver, redact: (text: string) => string) {
		this.driver = driver;
		this.redact = redact;
		this.descriptor = { adapter: driver.descriptor.adapter, location: redact(driver.descriptor.location) };
		this.executor = this.createExecutor(driver, (operation) => {
			if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
			return this.queue.push(operation);
		});
		const batch = driver.batch?.bind(driver);
		if (batch) this.batch = (statements) => this.runBatch(batch, statements);
	}

	private runBatch(
		batch: NonNullable<SqliteDriver["batch"]>,
		statements: readonly SqliteStatement[],
	): Promise<SqliteRow[][]> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		const bound = statements.map((statement) => ({ sql: statement.sql, params: snapshotParams(statement.params) }));
		return this.queue.push(async () => {
			for (const statement of bound) {
				const invalidIndex = statement.params.findIndex(
					(value) => typeof value === "string" && value.includes("\0"),
				);
				if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
			}
			const results = await this.call(() => batch(bound));
			return results.map((result) => result.rows.map((row) => normalizeRow(row, result.columns)));
		});
	}

	/** Maps a driver failure to `StorageUnavailableError` with a credential-free cause. */
	private async call<T>(operation: () => Awaitable<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, redactCause(cause as StorageFailureCause, this.redact));
		}
	}

	private createExecutor(
		connection: SqliteDriverExecutor,
		admit: <T>(operation: () => Promise<T>) => Promise<T>,
	): SqliteExecutor {
		const statement = (sql: string, params: readonly SqliteValue[]) => {
			const bound = snapshotParams(params);
			return admit(async () => {
				const invalidIndex = bound.findIndex((value) => typeof value === "string" && value.includes("\0"));
				if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
				return this.call(() => connection.execute(sql, bound));
			});
		};
		return {
			exec: (sql) => admit(() => this.call(() => connection.executeMultiple(sql))),
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

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		if (this.closePromise) return Promise.reject(new StoreClosedError(this.descriptor));
		return this.queue.push(async () => {
			const connection = await this.call(() => this.driver.beginTransaction());
			const handleQueue = new CallQueue();
			let active = true;
			let result: T;
			const handle = this.createExecutor(connection, (operation) =>
				active ? handleQueue.push(operation) : Promise.reject(new StorageTransactionClosedError()),
			);
			const close = () => this.call(() => connection.close?.());
			try {
				try {
					result = await callback(handle);
				} finally {
					active = false;
					await handleQueue.drained();
				}
				await this.call(() => connection.commit());
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
		});
	}

	close(): Promise<void> {
		this.closePromise ??= this.queue.drained().then(() => this.call(() => this.driver.close()));
		return this.closePromise;
	}
}

/**
 * Wraps a SQLite-compatible driver as a `SqliteDatabase`. The facade queues operations in call order and keeps them
 * outside active transactions, snapshots binary parameters at call time, rejects NUL text, returns safe-range integers
 * as numbers and blobs as `Uint8Array` copies, expires transaction handles when their callback settles, maps driver
 * failures to `StorageUnavailableError` with credentials redacted, and reports failed rollbacks with
 * `StorageRollbackError`. Closing rejects new calls, drains accepted work, then closes the driver once.
 */
export function createSqliteDatabase(driver: SqliteDriver): SqliteDatabase {
	return new DriverDatabase(driver, driver.redact?.bind(driver) ?? ((text) => text));
}
