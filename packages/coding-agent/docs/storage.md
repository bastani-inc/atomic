# SQLite storage API

The SDK exposes an async SQLite API from `@bastani/atomic` and `@bastani/atomic/storage`. It does not change where Atomic stores sessions or workflow runs.

```ts
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";

const database = await openNodeSqliteDatabase("./data/example.sqlite");
try {
  await database.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
  await database.transaction(async (transaction) => {
    await transaction.run("INSERT INTO notes(text) VALUES (?)", "hello");
  });
  const notes = await database.all("SELECT id, text FROM notes ORDER BY id");
} finally {
  await database.close();
}
```

`exec`, `run`, `get`, and `all` return promises. Bind values through positional `?` parameters; `run` returns `{ changes }`, `get` returns a row or `undefined`, and `all` returns an array. Values may be null, number, bigint, string, or Uint8Array. Binary values are copied when the call is made, so reusing a buffer afterward does not change queued work. INTEGER values inside the safe integer range are returned as numbers; larger values are returned as bigints.

The node adapter creates parent directories and enables WAL, full synchronization, and foreign keys. Its busy timeout defaults to 5000 ms; override it with `openNodeSqliteDatabase(path, { busyTimeoutMs: 1000 })`. Use `:memory:` for an ephemeral database.

Use only the supplied transaction handle inside a transaction callback. Calling the database itself there waits behind the transaction and deadlocks. Keep callbacks short and await only handle operations. A rejected callback rolls back and preserves the rejection. A failed commit rolls back and rejects with `StorageUnavailableError`. Handles expire after their callbacks settle. Other database operations execute in call order. `close()` drains accepted work, releases the database files, and is idempotent; new calls after closing begins reject with `StoreClosedError`.

Errors are exported classes with typed fields. `StorageUnavailableError` provides `adapter`, `location`, and `cause`; stop using the affected store after this error. `StorageRollbackError` retains the original `cause` and `rollbackCause` when rollback also fails. Do not assume that transaction rolled back. Branch on error classes rather than message text.

String bindings containing U+0000 are rejected before SQL executes with `StorageInvalidTextError`. Its `parameterIndex` is zero-based and its `reason` is `"nul-character"`. This rule applies to database calls and transaction handles. Store JSON with `JSON.stringify`, which escapes NUL characters, or use `Uint8Array` for binary data containing zero bytes. This validation does not inspect SQL source or SQL-generated values.

## Bring your own driver

Atomic does not bundle remote database drivers. Install your chosen SQLite-compatible driver in your own project and wrap it as a `SqliteDatabase` from `@bastani/atomic/storage`. The interface consists of a diagnostic `descriptor`, async `exec`, `run`, `get`, `all`, `transaction(callback)`, and `close()` methods, with the return values and transaction-handle rules described above.

A wrapper must queue database operations in call order, keeping unrelated calls outside active transactions. Reject NUL text with `StorageInvalidTextError`, snapshot binary parameters before queueing, and normalize returned integers and blobs. Use `StorageUnavailableError` for driver failures, preserve callback failures, and report failed rollbacks with `StorageRollbackError`. Expire transaction handles after their callback settles. On close, reject new calls, drain accepted work, and release driver resources. Do not include credentials in diagnostics or fall back to memory after an opening failure.

### libSQL / Turso example

Install `@libsql/client` separately. Save the complete wrapper below as `storage-libsql-wrapper.ts` in your project. It accepts caller-provided credentials only. For a local file, create its parent directory first; no network or credentials are needed.

```ts
import type { SqliteDatabase } from "@bastani/atomic/storage";
import { openLibsqlDatabase } from "./storage-libsql-wrapper.js";

const database: SqliteDatabase = await openLibsqlDatabase({ url: "file:./data.sqlite" });
// For Turso instead: { url: "libsql://your-database.turso.io", authToken: token }
try {
  await database.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT)");
  await database.transaction(async (tx) => {
    await tx.run("INSERT INTO notes VALUES (?)", "hello");
  });
  const notes = await database.all("SELECT text FROM notes");
} finally {
  await database.close();
}
```

The returned value can be passed to your own SDK application code that accepts `SqliteDatabase`. This does not select a custom driver for Atomic sessions or workflow runs.

<details>
<summary>Complete wrapper</summary>

<!-- custom-driver-example -->
```ts
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
} from "@bastani/atomic/storage";

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
```
<!-- /custom-driver-example -->

</details>

## Adapter conformance

Implement `SqliteDatabase` and run the exported suite from `@bastani/atomic/storage/testing`:

```ts
import { describe, it } from "vitest";
import { registerSqliteDatabaseConformance } from "@bastani/atomic/storage/testing";

registerSqliteDatabaseConformance({ describe, it }, "my adapter", withSubject);
```

`withSubject` creates a fresh database for every case and calls the supplied callback with `{ database, reopen, withRollbackFailure }`. Clean up afterward, including on failure. `reopen()` closes and reopens the same persistent database and returns the new facade. `withRollbackFailure(error, callback)` injects a driver rollback failure only while running the callback, then restores normal behavior. Run the full suite against a persistent local database: it covers bindings, exact integers, binary snapshots, NUL rejection, transaction ordering and handle lifetime, commit/rollback failures, reopening, and close semantics.

`validateStoragePrefix(prefix)` accepts an empty prefix or ASCII letters/underscores followed by ASCII letters, digits, or underscores. It rejects names beginning with `sqlite_`, regardless of case. Validate before opening files. `renderStorageIdentifiers(domain, names, prefix)` returns an immutable name map with `wf_` for `journal` or `session_` for `sessions`. `assertStorageSchemaVersion(domain, found, supported)` rejects a mismatched stored version without changing it.
