import type { Client, ResultSet, Row, Transaction } from "@libsql/client";
import {
	type SqliteDatabase,
	type SqliteExecutor,
	type SqliteRow,
	type SqliteValue,
	type StorageDescriptor,
	StorageAdapterLoadError,
	StorageError,
	type StorageFailureCause,
	StorageInvalidTextError,
	StorageRollbackError,
	StorageTransactionClosedError,
	StorageUnavailableError,
	StoreClosedError,
} from "../../packages/coding-agent/src/core/storage/index.js";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

function credentialRedactor(options: LibsqlDatabaseOptions): (text: string) => string {
	const secrets = [options.authToken ?? ""];
	for (const match of options.url.matchAll(/[?&]([^=&#]*)=([^&#]*)/g)) {
		const token = new URLSearchParams(match[0].slice(1)).get("authToken");
		if (token !== null) secrets.push(match[2] ?? "", token);
	}
	const userinfo = options.url.match(/\/\/([^/?#]*)@/)?.[1];
	if (userinfo !== undefined) secrets.push(...userinfo.split(":"));
	try {
		const url = new URL(options.url);
		secrets.push(url.username, url.password, ...url.searchParams.getAll("authToken"));
	} catch {}
	for (const secret of [...secrets]) {
		try {
			secrets.push(encodeURIComponent(secret));
			secrets.push(decodeURIComponent(secret));
		} catch {}
	}
	return (text) =>
		secrets
			.filter(Boolean)
			.sort((first, second) => second.length - first.length)
			.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
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

function normalizeRow(row: Row, columns: readonly string[]): SqliteRow {
	return Object.fromEntries(
		columns.map((key, index) => {
			const value = row[index];
			return [
				key,
				typeof value === "bigint" &&
				value >= -BigInt(Number.MAX_SAFE_INTEGER) &&
				value <= BigInt(Number.MAX_SAFE_INTEGER)
					? Number(value)
					: value instanceof ArrayBuffer
						? new Uint8Array(value.slice(0))
						: value,
			];
		}),
	);
}

class LibsqlDatabase implements SqliteDatabase {
	readonly descriptor: StorageDescriptor;
	private readonly client: Client;
	private readonly redact: (text: string) => string;
	private tail: Promise<void> = Promise.resolve();
	private closing = false;
	private closePromise?: Promise<void>;
	private readonly executor: SqliteExecutor;

	constructor(client: Client, descriptor: StorageDescriptor, redact: (text: string) => string) {
		this.client = client;
		this.descriptor = descriptor;
		this.redact = redact;
		this.executor = this.createExecutor(client, () => true);
	}

	private async driver<T>(operation: () => T | Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			throw new StorageUnavailableError(this.descriptor, redactCause(cause as StorageFailureCause, this.redact));
		}
	}

	private createExecutor(connection: Client | Transaction, active: () => boolean): SqliteExecutor {
		const execute = async <T>(operation: () => Promise<T>, params: readonly SqliteValue[] = []): Promise<T> => {
			if (!active()) throw new StorageTransactionClosedError();
			const invalidIndex = params.findIndex((value) => typeof value === "string" && value.includes("\0"));
			if (invalidIndex !== -1) throw new StorageInvalidTextError(invalidIndex);
			return this.driver(operation);
		};
		const statement = (sql: string, params: readonly SqliteValue[]): Promise<ResultSet> =>
			connection.execute({ sql, args: [...params] });
		return {
			exec: (sql) => execute(() => connection.executeMultiple(sql)),
			run: (sql, ...params) =>
				execute(async () => ({ changes: (await statement(sql, params)).rowsAffected }), params),
			get: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute(async () => {
					const result = await statement(sql, params);
					const row = result.rows[0];
					return row === undefined ? undefined : (normalizeRow(row, result.columns) as T);
				}, params),
			all: <T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]) =>
				execute(async () => {
					const result = await statement(sql, params);
					return result.rows.map((row) => normalizeRow(row, result.columns) as T);
				}, params),
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
		const bound = params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
		return this.enqueue(() => this.executor.run(sql, ...bound));
	}

	get<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T | undefined> {
		const bound = params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
		return this.enqueue(() => this.executor.get<T>(sql, ...bound));
	}

	all<T extends SqliteRow>(sql: string, ...params: readonly SqliteValue[]): Promise<T[]> {
		const bound = params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value));
		return this.enqueue(() => this.executor.all<T>(sql, ...bound));
	}

	transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const connection = await this.driver(() => this.client.transaction("write"));
			let active = true;
			try {
				const result = await callback(this.createExecutor(connection, () => active));
				active = false;
				await this.driver(() => connection.commit());
				return result;
			} catch (cause) {
				active = false;
				try {
					await this.driver(() => connection.rollback());
				} catch (rollbackCause) {
					throw new StorageRollbackError(cause as StorageFailureCause, rollbackCause as StorageFailureCause);
				}
				throw cause;
			} finally {
				await this.driver(() => connection.close());
			}
		});
	}

	close(): Promise<void> {
		if (!this.closePromise) {
			this.closing = true;
			this.closePromise = this.tail.then(() => this.driver(() => this.client.close()));
		}
		return this.closePromise;
	}
}

export async function openLibsqlDatabase(options: LibsqlDatabaseOptions): Promise<SqliteDatabase> {
	const config = { url: options.url, authToken: options.authToken };
	const redact = credentialRedactor(config);
	const descriptor = { adapter: "libsql", location: redact(config.url) };
	let createClient: typeof import("@libsql/client").createClient;
	try {
		({ createClient } = await import("@libsql/client"));
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", redactCause(cause as StorageFailureCause, redact));
	}
	let client: Client | undefined;
	try {
		client = createClient({ ...config, intMode: "bigint" });
		const database = new LibsqlDatabase(client, descriptor, redact);
		await database.exec("PRAGMA foreign_keys = ON");
		return database;
	} catch (cause) {
		try {
			client?.close();
		} catch {}
		throw new StorageUnavailableError(descriptor, redactCause(cause as StorageFailureCause, redact));
	}
}
