# SQLite storage API

The SDK exposes an async SQLite API from `@bastani/atomic` and `@bastani/atomic/storage`. Sessions and workflow runs default to one local file, `~/.atomic/workflows/journal.sqlite`, with `session_` and `wf_` table prefixes. Use [storage settings](/settings#sessions) to choose a different file, explicit JSONL sessions, explicit memory, or an adapter module, or [select storage per process](#selecting-storage-per-process) without editing settings. A failed persistent store never falls back to memory.

For CLI storage selection and resume commands, see [Choosing a store](/sessions#choosing-a-store).

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

Transactions from separate `openNodeSqliteDatabase` connections to the same file queue asynchronously within one process; symlink paths refer to the same queue. Separate in-memory databases remain independent. SQLite locking and the busy timeout still govern contention from other processes. Wrap a caller-owned connection consistently: its transaction queue is shared by wrappers of that connection, not by other connections to its file.

Use `wrapNodeSqliteDatabase(connection)` to adapt an existing `node:sqlite` `DatabaseSync`. Closing that facade drains its accepted work but leaves your connection open. Route concurrent work through the same facade rather than issuing raw connection commands while a facade transaction is active.

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

Pass the returned facade as SDK `sessionStore: { kind: "database", database, prefix: "project_" }` or workflow `journal: { database, prefix: "project_" }`. Both can use the same facade without closing your database. To select it from settings, expose `openLibsqlDatabase` through an adapter module as described below.

<details>
<summary>Complete wrapper</summary>

{/* custom-driver-example */}
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
			connection.execute({
				sql,
				args: params.map((value) => (value instanceof Uint8Array ? new Uint8Array(value) : value)),
			});
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
{/* /custom-driver-example */}

</details>

## Selecting an adapter

Install your driver separately and export a default `StorageAdapterModule` from your module:

```ts
import type { StorageAdapterModule } from "@bastani/atomic/storage";
import { openLibsqlDatabase } from "./storage-libsql-wrapper.js";

export default {
  atomicStorageAdapter: 1,
  async openDatabase(options, context) {
    return openLibsqlDatabase({ url: String(options.url), authToken: String(options.authToken) });
  },
} satisfies StorageAdapterModule;
```

Select it with `sessions.storage: { "adapter": "@example/atomic-sqlite" }`, `workflows.journal`, or shared top-level `storage` in [settings](/settings#workflow-storage). SDK sessions accept `sessionStore: { kind: "adapter", module, options, secrets, prefix }`; workflow runs accept `journal: { adapter, options, secrets, prefix }`. Module specifiers resolve from the agent directory, normally `~/.atomic/agent`; absolute module paths also work. Project settings follow the same trust boundary as project extensions. A module executes with Atomic's privileges.

`options` is an object of SQLite scalar values or booleans. In JSON settings use strings, numbers, booleans, or null. `secrets` maps option names to `{ env }` or `{ file }`; resolved values override same-named options without trimming file contents. Keep credentials out of `options` and database descriptors. `context` contains `agentDir`, `domain: "sessions" | "journal" | "intercom"`, and an optional `signal`. Intercom brokers open the top-level `storage` selection with `domain: "intercom"` through `openDatabase`.

A SQLite adapter implements `openDatabase(options, context): Promise<SqliteDatabase>`. Atomic applies its domain schema and optional table prefix. A full adapter can instead implement `openSessionStore(options, context, storage)` or `openRunJournal(options, context, storage)`; the domain hook takes priority over `openDatabase`. The typed third argument is `{ readonly prefix?: string }`. Domain adapters must honor this prefix to isolate selected stores. A missing domain/database hook raises `StorageConfigError` with reason `"adapter-domain-unsupported"`. Load failures and invalid module contracts raise `StorageAdapterLoadError`; driver opening failures raise `StorageUnavailableError`. None selects memory as a fallback.

The exported `StorageProvider` can open either domain explicitly. Construct it with `{ memory: (descriptor) => new MemoryRunJournal(descriptor), sql: SqlRunJournal.open }` from `@bastani/atomic/workflows`, then call `openSessionStore(selection, context)` or `openRunJournal(selection, context)`. For sessions alone, `new StorageProvider()` needs no journal factories. `StorageSelection` uses `kind: "memory"`, `"jsonl"` with `dir` for sessions only, `"sqlite"` with `path`, `"database"` with a caller-owned facade, or `"adapter"` with `module`, optional options/secrets/prefix.

One provider shares a database for matching owned SQLite or adapter selections. Close every returned store; the last store closes the owned database. Closing a store is idempotent. A caller-owned `database` is never closed by the provider. A full domain adapter owns its returned store's lifecycle. Invalid configuration stops selection, and a configured persistent store that cannot open never becomes an in-memory store.

If opening storage fails and closing its owned database also fails, the original typed opening error is thrown with a `cleanupCause` field containing the cleanup failure. Inspect both errors when diagnosing the failed open.

Factory-created journal headers record a credential-free `storage` descriptor for diagnostics. Full domain adapters are responsible for recording their own safe descriptor. Directly supplied journals and their caller-provided headers are not rewritten.

## Selecting storage per process

A host that starts Atomic processes, for example a supervisor that launches `atomic --mode rpc` children, can select storage for those processes alone. Each option holds the same JSON selection the settings accept, including `adapter`, `options`, `secrets`, and `prefix`:

| Option | Applies to | Same form as |
|---|---|---|
| `--storage '<json>'` | Sessions and workflow runs | Shared `storage` setting |
| `--storage-file <path>` | Sessions and workflow runs; reads the JSON from a file | Shared `storage` setting |
| `ATOMIC_STORAGE` | Sessions and workflow runs | Shared `storage` setting |
| `ATOMIC_SESSIONS_STORAGE` | Sessions only; also accepts `{ "dir": "..." }` | `sessions.storage` |
| `ATOMIC_WORKFLOWS_JOURNAL` | Workflow runs only | `workflows.journal` |

```bash
ATOMIC_STORAGE='{"adapter":"@example/atomic-sqlite","options":{"url":"libsql://team.example"},"secrets":{"authToken":{"env":"TEAM_DB_TOKEN"}},"prefix":"svc_"}' \
  atomic --mode rpc

atomic --mode rpc --storage-file /etc/atomic/storage.json
```

Nothing is written to settings. A process started without these options keeps using its settings, so an interactive `atomic` and an RPC child started with `ATOMIC_STORAGE` in the same account each keep their own sessions and workflow runs, and `/resume` in each lists only its own store. `--storage` and `--storage-file` cannot be combined. The interactive CLI passes its `--storage` selection to its background engine process. Other processes that Atomic starts inherit the environment variables but not the flag.

Precedence for each domain, highest first:

| Sessions | Workflow runs |
|---|---|
| SDK `sessionStore` | SDK `RunOpts.journal` or `createAgentSession({ journal })` |
| `--session-store`, `--no-session`, or `--session-dir` | |
| `--storage` or `--storage-file` | `--storage` or `--storage-file` |
| `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR` | `ATOMIC_WORKFLOWS_JOURNAL` or `ATOMIC_WORKFLOW_JOURNAL_PATH` |
| `ATOMIC_STORAGE` | `ATOMIC_STORAGE` |
| `sessions.storage` setting | `workflows.journal` setting |
| Shared `storage` setting | Shared `storage` setting |
| Default SQLite file | Default SQLite file |

How the options combine with the path overrides:

- The session flags are more specific than `--storage`. With `atomic --session-dir ./sessions --storage '{...}'`, sessions use `./sessions` and workflow runs use the `--storage` selection.
- A path variable overrides `ATOMIC_STORAGE` for its domain. For example, `ATOMIC_WORKFLOW_JOURNAL_PATH` moves only the workflow runs.
- `ATOMIC_SESSIONS_STORAGE` with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR`, or `ATOMIC_WORKFLOWS_JOURNAL` with a non-empty `ATOMIC_WORKFLOW_JOURNAL_PATH`, is a conflict. Startup fails with `StorageConfigError` whose `source` is `"env"`, whose `field` names both variables, and whose `reason` is `"conflicting-overrides"`. Unset one of them.
- `--storage` or `--storage-file` with a non-empty `ATOMIC_CODING_AGENT_SESSION_DIR` or `ATOMIC_WORKFLOW_JOURNAL_PATH` is also a conflict, with `source` `"cli"`, because the flag would otherwise silently override the variable. Unset the variable, or for sessions pass a session flag such as `--session-dir`, which takes precedence over both.

Relative `path`, `dir`, and `secrets.file` values resolve against Atomic home, normally `~/.atomic`, and relative adapter module specifiers resolve from the agent directory, exactly as in settings and regardless of the working directory. A relative `--storage-file` path resolves against the working directory. Empty variables are ignored. `ATOMIC_CODING_AGENT_SESSION_DIR` and `ATOMIC_WORKFLOW_JOURNAL_PATH` keep their existing behavior.

At startup, before any session starts and in every mode including RPC, the CLI validates `--storage` or `--storage-file` and every set `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, and `ATOMIC_WORKFLOWS_JOURNAL`, even one that a flag or another variable outranks. `createAgentSession()` validates the same set variables before it creates a session, even when the host supplies `sessionManager` or `sessionStore`. Invalid JSON, a selection that does not match the settings schema, or an unreadable `--storage-file` raises `StorageConfigError` with `source` `"env"` or `"cli"`, a `field` naming the variable or flag, and a `reason` such as `"invalid-json"`, `"invalid-selection"`, or `"unreadable-file"`. A missing `{ "env": ... }` secret reports `"secret-env-missing"` against the selection's variable or flag when the store opens. Atomic never falls back to settings or another store. Errors name the variable or flag, never the selection text or a resolved secret.

These options come from the process that starts Atomic, so they are not subject to [project trust](/security) the way project settings are. An adapter module runs code with Atomic's privileges: select only modules you trust. Pass credentials through `secrets` rather than `options`. Command-line arguments can be visible to other local users, so prefer `--storage-file` or an environment variable when the selection itself is sensitive.

## Sharing storage across hosts

By default, sessions and workflow runs live in a local file that serves one machine. To share them across machines, for example several service replicas or a CI fleet, select the same remote SQLite-compatible database on every host through an [adapter](#selecting-an-adapter), such as the libSQL/Turso wrapper above. Give each project or tenant its own `prefix`. Do not put the local SQLite file on a network filesystem; use a database driver instead.

With a shared journal:

- Any host can inspect any run with `status` or `stages` without taking ownership.
- Each run has one executor at a time. A run whose owner is alive cannot be claimed from another host. After its owner crashes and stops renewing its lease for about two minutes, the run appears as `crashed` and any host can resume it. Concurrent resume attempts admit one executor.
- Lease expiry uses the database clock, so clock differences between hosts do not affect ownership.
- A displaced executor cannot save new checkpoints; its writes fail with `StaleLeaseError`.

The database stores sessions and workflow checkpoints only. To resume a run on another host, that host also needs the same workflow definition and the run's original working directory, including any worktrees and artifacts the run uses. Effects that were not checkpointed may run again after a takeover, so make external effects idempotent. Every checkpoint commits before it is reported, so a remote database adds network latency to each durable `ctx.*` step. Backends may also enforce payload limits that raise `StoragePayloadTooLargeError`.

Scale by running more workflows, not by splitting one: a single run and a single session each have one writer. The built-in journal uses SQLite SQL, so `openDatabase` adapters need a SQLite-compatible driver. For another kind of database, implement `openRunJournal` and `openSessionStore` and validate them with the conformance suites below.

## Storage errors

Use error classes and their fields, not message matching. Configuration and facade errors are exported from `@bastani/atomic/storage`. `@bastani/atomic/workflows` exports the journal contract's error classes.

| Error | Fields and response |
|---|---|
| `StorageConfigError` | `source`, `field`, `reason` identify an invalid selected option. Correct that selection; Atomic does not try a lower-precedence store. |
| `StorageAdapterLoadError` | `module`, `cause`. Check installation and the module's default export. |
| `StorageUnavailableError` | `adapter`, `location`, `cause`. Restore access to the selected store before retrying. |
| `StoragePrefixError` | `prefix`, `reason`. Use a valid non-reserved prefix. |
| `StorageSchemaVersionError` | `domain`, `found`, `supported`. Use a supported database; Atomic does not migrate an unknown schema. |
| `StoreClosedError` / `StorageTransactionClosedError` | The store is closing/closed, or the transaction callback has ended. Open a new store or use the live callback handle. |
| `StorageRollbackError` | `cause`, `rollbackCause`. Do not assume the transaction rolled back. |
| `StorageOutcomeUnknownError` | `domain`, `id`, `key`. A driver cannot confirm the write outcome; inspect the keyed record before retrying. |
| `StoragePayloadTooLargeError` | `limitBytes`, `actualBytes`. Reduce the payload for that backend. |
| `StorageInvalidTextError` | `parameterIndex`, `reason`. Remove NUL from scalar text bindings or encode the value as JSON/binary. |

Session operations can raise `SessionNotFoundError` or `SessionExistsError` with `sessionId`; `SessionIdMismatchError` with `requested` and `found`; and `SessionConflictError` with `sessionId`, `expectedSeq`, and `actualSeq`. Keep one writer per session. After a conflict, reopen the session rather than writing from stale state.

`SessionFormatVersionError` identifies `path`, `found`, and `supported`; `SessionInvalidTextError` identifies `field` and `reason`, and `SessionInvalidTimestampError` adds `value`. A JSONL append whose rollback also fails raises `JsonlStoragePoisonedError` with `location`, `cause`, and `rollbackCause`; stop using that store and inspect the file before reopening. These failures never silently select another store.

Journal errors include:

| Error | Fields and response |
|---|---|
| `StaleLeaseError` | `runId`, `heldEpoch`, `currentEpoch`. Stop writing under stale ownership. |
| `JournalCasConflictError` | `runId`, `expectedSeq`, `actualSeq`. Reload the run before retrying a conflicting operation. |
| `RunNotFoundError` | `runId`. Check the selected journal and ID. |
| `JournalSchemaVersionError` | `domain`, `found`, `supported`. No automatic schema migration. |
| `JournalInvalidTextError` | `field`, `reason`. Identifiers must be well-formed Unicode without NUL. JSON payload text is not restricted this way. |
| `JournalCounterRangeError` | `runId`, `field`, `value`, `reason`. Sequence and epoch counters must remain non-negative safe integers. |
| `JournalMetaCorruptError` | `path`, `rowCount`. Inspect or restore the affected database. |
| `JournalClosedError` | Open another journal before issuing new operations. |

Workflow execution can also fail with `JournalOwnershipError` with `runId` and `holderId`, `JournalBackendClosedError`, `JournalOperationAbortedError` with `runId` and optional `cause`, or `JournalExecutionRetiredError` with `runId`. Stop work after losing ownership or cancellation; do not keep using a closed or retired execution. A local database failure does not justify deleting the shared file, which may hold both session and workflow history.

## Adapter conformance

Implement `SqliteDatabase` and run the exported suite from `@bastani/atomic/storage/testing`:

```ts
import { describe, it } from "vitest";
import { registerSqliteDatabaseConformance } from "@bastani/atomic/storage/testing";

registerSqliteDatabaseConformance({ describe, it }, "my adapter", withSubject);
```

`withSubject` creates a fresh database for every case and calls the supplied callback with `{ database, reopen, withRollbackFailure }`. Clean up afterward, including on failure. `reopen()` closes and reopens the same persistent database and returns the new facade. `withRollbackFailure(error, callback)` injects a driver rollback failure only while running the callback, then restores normal behavior. Run the full suite against a persistent local database: it covers bindings, exact integers, binary snapshots, NUL rejection, transaction ordering and handle lifetime, commit/rollback failures, reopening, and close semantics.

For adapters supporting multiple connections to one database, also run `registerSqliteConnectionConformance({ describe, it }, "my adapter connections", withConnections)`. The fixture must open two facades on the same fresh database, pass both to the callback, and close both afterward. This checks concurrent transaction writes and event-loop responsiveness while one callback yields.

`validateStoragePrefix(prefix)` accepts an empty prefix or ASCII letters/underscores followed by ASCII letters, digits, or underscores. It rejects names beginning with `sqlite_`, regardless of case. Validate before opening files. `renderStorageIdentifiers(domain, names, prefix)` returns an immutable name map with `wf_` for `journal` or `session_` for `sessions`. `assertStorageSchemaVersion(domain, found, supported)` rejects a mismatched stored version without changing it.
