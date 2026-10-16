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

	constructor(
		connection: DatabaseSync,
		descriptor: StorageDescriptor,
		ownsConnection = true,
		transactionIdentity: string | DatabaseSync = connection,
	) {
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
			throw new StorageUnavailableError(this.descriptor, cause as StorageFailureCause);
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
				await this.executor.exec("BEGIN IMMEDIATE");
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
	{ busyTimeoutMs = 5000 }: { busyTimeoutMs?: number } = {},
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
		if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
		connection = new Database(path);
		connection.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
		connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		const location = connection.location();
		const identity = location === null ? connection : await realpath(location);
		return new NodeSqliteDatabase(connection, descriptor, true, identity);
	} catch (cause) {
		try {
			connection?.close();
		} catch {
			// Preserve the opening failure if cleanup also fails.
		}
		throw new StorageUnavailableError(descriptor, cause as StorageFailureCause);
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
		throw new StorageUnavailableError(descriptor, cause as StorageFailureCause);
	}
}
