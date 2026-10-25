import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue, StorageDescriptor } from "./database.js";
import {
	StorageAdapterLoadError,
	type StorageFailureCause,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";

interface TransactionGates {
	readonly files: Map<string, Promise<void>>;
	readonly connections: WeakMap<DatabaseSync, Promise<void>>;
}

// Share gates across module reloads as well as adapter instances. Only live queues retain file identities.
const TRANSACTION_GATES = Symbol.for("atomic-storage/node-sqlite-transaction-gates@1");
const gateBag = globalThis as typeof globalThis & Record<symbol, TransactionGates | undefined>;
const gates: TransactionGates = gateBag[TRANSACTION_GATES] ?? { files: new Map(), connections: new WeakMap() };
gateBag[TRANSACTION_GATES] = gates;

function gateTransaction<T>(identity: string | DatabaseSync, operation: () => Promise<T>): Promise<T> {
	const prior = typeof identity === "string" ? gates.files.get(identity) : gates.connections.get(identity);
	const result = (prior ?? Promise.resolve()).then(operation);
	const settled = result.then(
		() => {},
		() => {},
	);
	if (typeof identity === "string") gates.files.set(identity, settled);
	else gates.connections.set(identity, settled);
	void settled.then(() => {
		if (typeof identity === "string") {
			if (gates.files.get(identity) === settled) gates.files.delete(identity);
		} else if (gates.connections.get(identity) === settled) gates.connections.delete(identity);
	});
	return result;
}

/** Copies binary parameters so queued work binds the bytes the caller passed, not later buffer contents. */
function snapshotParams(params: readonly SqliteValue[]): SqliteValue[] {
	return params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
}

/**
 * Bun's `DatabaseSync.close()` defers closing the file until garbage collection finalizes every statement the
 * connection prepared, so the database, WAL and shared-memory files stay open (and locked on Windows). The adapter
 * keeps no statement references, so a synchronous collection finalizes them and releases the files. Node finalizes
 * statements inside `close()` and has no `Bun` global.
 */
function finalizeReleasedStatements(): void {
	(globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
}

/** Default for how long a transaction keeps retrying `BEGIN IMMEDIATE` while another connection holds the write lock. */
const DEFAULT_NODE_SQLITE_LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_BASE_DELAY_MS = 25;
const LOCK_RETRY_MAX_DELAY_MS = 1_000;

/** SQLITE_BUSY, including its extended codes: another connection holds the lock this statement needs. */
function isSqliteBusy(cause: unknown): boolean {
	const code = (cause as { errcode?: unknown } | null | undefined)?.errcode;
	return typeof code === "number" && (code & 0xff) === 5;
}

/** The driver's own reason, kept in the error message so it survives relays that forward only `message`. */
function sqliteFailureDetail(cause: unknown): string | undefined {
	if (!(cause instanceof Error) || cause.message === "") return undefined;
	const code = (cause as { errcode?: unknown }).errcode;
	return typeof code === "number" ? `${cause.message} (SQLite code ${code})` : cause.message;
}

function unavailable(descriptor: StorageDescriptor, cause: unknown, detail = sqliteFailureDetail(cause)) {
	return new StorageUnavailableError(descriptor, cause as StorageFailureCause, detail);
}

function normalizeRow(row: Record<string, SqliteValue>): SqliteRow {
	return Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key,
			typeof value === "bigint" &&
			value >= -BigInt(Number.MAX_SAFE_INTEGER) &&
			value <= BigInt(Number.MAX_SAFE_INTEGER)
				? Number(value)
				: value instanceof Uint8Array
					? new Uint8Array(value)
					: value,
		]),
	);
}

class NodeSqliteDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	private readonly connection: DatabaseSync;
	private tail: Promise<void> = Promise.resolve();
	private closing = false;
	private closePromise?: Promise<void>;
	private readonly executor: SqliteExecutor;

	private readonly ownsConnection: boolean;
	private readonly transactionIdentity: string | DatabaseSync;
	private readonly lockWaitMs: number;

	constructor(
		connection: DatabaseSync,
		descriptor: StorageDescriptor,
		ownsConnection = true,
		transactionIdentity: string | DatabaseSync = connection,
		lockWaitMs = DEFAULT_NODE_SQLITE_LOCK_WAIT_MS,
	) {
		this.lockWaitMs = lockWaitMs;
		this.transactionIdentity = transactionIdentity;
		this.ownsConnection = ownsConnection;
		this.connection = connection;
		this.descriptor = descriptor;
		this.executor = this.createExecutor(() => true);
	}

	private driver<T>(operation: () => T): T {
		try {
			return operation();
		} catch (cause) {
			throw unavailable(this.descriptor, cause);
		}
	}

	/**
	 * Takes the write lock. `busy_timeout` waits synchronously, which blocks this process's event loop and cannot
	 * outlast a writer in another process that holds the lock longer (a loaded workflow journal does). Nothing has
	 * run yet when `BEGIN IMMEDIATE` reports SQLITE_BUSY, so it is retried after yielding until `lockWaitMs`
	 * has passed; every other failure, and a lock still held at the deadline, rejects at once with its cause.
	 */
	private async begin(): Promise<void> {
		const started = Date.now();
		for (let attempt = 0; ; attempt += 1) {
			try {
				await this.executor.exec("BEGIN IMMEDIATE");
				return;
			} catch (error) {
				const cause = error instanceof StorageUnavailableError ? error.cause : undefined;
				if (!isSqliteBusy(cause)) throw error;
				const remaining = started + this.lockWaitMs - Date.now();
				if (remaining <= 0) {
					throw unavailable(
						this.descriptor,
						cause,
						`${sqliteFailureDetail(cause)}; gave up after waiting ${Date.now() - started} ms for the write lock`,
					);
				}
				const backoff = Math.min(LOCK_RETRY_MAX_DELAY_MS, LOCK_RETRY_BASE_DELAY_MS * 2 ** attempt);
				await new Promise((resolve) =>
					setTimeout(resolve, Math.min(remaining, backoff * (0.5 + Math.random() / 2))),
				);
			}
		}
	}

	private createExecutor(active: () => boolean): SqliteExecutor {
		const execute = async <T>(operation: () => T, params: readonly SqliteValue[] = []): Promise<T> => {
			if (!active()) throw new StorageTransactionClosedError();
			const invalidIndex = params.findIndex((value) => typeof value === "string" && value.includes("\0"));
			if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
			return this.driver(operation);
		};
		const statement = (sql: string) => {
			const prepared = this.connection.prepare(sql);
			prepared.setReadBigInts(true);
			return prepared;
		};
		return {
			exec: (sql) => execute(() => this.connection.exec(sql)),
			run: (sql, ...params) => execute(() => ({ changes: Number(statement(sql).run(...params).changes) }), params),
			get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute(() => {
					const row = statement(sql).get(...params);
					return row === undefined ? undefined : (normalizeRow(row) as T);
				}, params),
			all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute(
					() =>
						statement(sql)
							.all(...params)
							.map((row) => normalizeRow(row) as T),
					params,
				),
		};
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new StoreClosedError(this.descriptor));
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => {},
			() => {},
		);
		return result;
	}

	exec(sql: string): Promise<void> {
		return this.enqueue(() => this.executor.exec(sql));
	}

	run(sql: string, ...params: readonly SqliteValue[]) {
		const bound = snapshotParams(params);
		return this.enqueue(() => this.executor.run(sql, ...bound));
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		const bound = snapshotParams(params);
		return this.enqueue(() => this.executor.get<T>(sql, ...bound));
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		const bound = snapshotParams(params);
		return this.enqueue(() => this.executor.all<T>(sql, ...bound));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.enqueue(() =>
			gateTransaction(this.transactionIdentity, async () => {
				await this.begin();
				let active = true;
				const transaction = this.createExecutor(() => active);
				try {
					const result = await callback(transaction);
					active = false;
					await this.executor.exec("COMMIT");
					return result;
				} catch (cause) {
					active = false;
					try {
						await this.executor.exec("ROLLBACK");
					} catch (rollbackCause) {
						throw new StorageRollbackError(cause as StorageFailureCause, rollbackCause as StorageFailureCause);
					}
					throw cause;
				}
			}),
		);
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.tail.then(() =>
				this.driver(() => {
					if (this.ownsConnection) this.connection.close();
					finalizeReleasedStatements();
				}),
			);
		}
		return this.closePromise;
	}
}

export async function openNodeSqliteDatabase(
	path: string,
	{
		busyTimeoutMs = 5000,
		lockWaitMs = DEFAULT_NODE_SQLITE_LOCK_WAIT_MS,
		readOnly = false,
	}: { busyTimeoutMs?: number; lockWaitMs?: number; readOnly?: boolean } = {},
): Promise<SqliteDatabase> {
	const descriptor = { adapter: "node-sqlite", location: path };
	// Load node:sqlite on first open: importing it prints Node's experimental warning, which every importer of the
	// package entry point would otherwise see.
	let Database: typeof DatabaseSync;
	try {
		({ DatabaseSync: Database } = await import("node:sqlite"));
	} catch (cause) {
		throw new StorageAdapterLoadError("node:sqlite", cause as StorageFailureCause);
	}
	let connection: DatabaseSync | undefined;
	try {
		if (!readOnly && path !== ":memory:") await mkdir(dirname(path), { recursive: true });
		connection = new Database(path, { readOnly });
		connection.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
		if (!readOnly) connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		const location = connection.location();
		const identity = location === null ? connection : await realpath(location);
		return new NodeSqliteDatabase(connection, descriptor, true, identity, lockWaitMs);
	} catch (cause) {
		try {
			connection?.close();
		} catch {
			// Preserve the opening failure if cleanup also fails.
		}
		throw unavailable(descriptor, cause);
	}
}

export function wrapNodeSqliteDatabase(connection: DatabaseSync): SqliteDatabase {
	const descriptor = { adapter: "node-sqlite", location: ":memory:" };
	try {
		descriptor.location = connection.location() || ":memory:";
		connection.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON",
		);
		return new NodeSqliteDatabase(connection, descriptor, false);
	} catch (cause) {
		throw unavailable(descriptor, cause);
	}
}
