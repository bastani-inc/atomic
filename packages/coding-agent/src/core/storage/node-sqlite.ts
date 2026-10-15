import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteExecutor, SqliteRow, SqliteValue, StorageDescriptor } from "./database.js";
import {
	type StorageFailureCause,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "./errors.js";

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

	constructor(connection: DatabaseSync, descriptor: StorageDescriptor) {
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
		return this.enqueue(() => this.executor.run(sql, ...params));
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		return this.enqueue(() => this.executor.get<T>(sql, ...params));
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		return this.enqueue(() => this.executor.all<T>(sql, ...params));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
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
		});
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.tail.then(() => this.driver(() => this.connection.close()));
		}
		return this.closePromise;
	}
}

export async function openNodeSqliteDatabase(
	path: string,
	{ busyTimeoutMs = 5000 }: { busyTimeoutMs?: number } = {},
): Promise<SqliteDatabase> {
	const descriptor = { adapter: "node-sqlite", location: path };
	let connection: DatabaseSync | undefined;
	try {
		if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
		connection = new DatabaseSync(path);
		connection.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
		connection.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
		return new NodeSqliteDatabase(connection, descriptor);
	} catch (cause) {
		try {
			connection?.close();
		} catch {
			// Preserve the opening failure if cleanup also fails.
		}
		throw new StorageUnavailableError(descriptor, cause as StorageFailureCause);
	}
}
