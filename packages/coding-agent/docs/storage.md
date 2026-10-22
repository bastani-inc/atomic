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

## Turso and libSQL

`@bastani/atomic-storage-libsql` is the maintained adapter for Turso and other libSQL databases. It stores sessions, workflow runs, and Intercom's multi-node routing in the database. Install it once per machine, in user scope so Atomic can find it:

```bash
atomic install npm:@bastani/atomic-storage-libsql
```

Then select it in `~/.atomic/agent/settings.json`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-libsql",
    "options": { "url": "libsql://<db>.turso.io" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

Save the token with `turso db tokens create <db> > turso-token` and keep it readable only by you (`chmod 600`); a trailing newline is ignored. A relative `file` resolves against Atomic home, normally `~/.atomic`. Use `{ "env": "TURSO_TOKEN" }` instead to read it from an environment variable. For a local database file, use a `file:` URL such as `file:/home/me/shared.sqlite` and omit `secrets`. Every machine that uses the same `storage` block shares the same sessions, workflow runs, and Intercom routing; add a `prefix` to keep projects or teams apart. See [Sharing storage across hosts](#sharing-storage-across-hosts).

Like any [adapter](#selecting-an-adapter), it runs with Atomic's privileges. To use a different driver, adapt it with [Bring your own driver](#bring-your-own-driver).

### Joining a machine to a shared database

Instead of editing settings by hand, install the adapter and join the database:

```bash
atomic install npm:@bastani/atomic-storage-libsql
turso db tokens create <db> > ~/turso-token
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

`atomic storage join <url> --token-file <path> [--prefix <prefix>]`:

1. reads the token and removes surrounding whitespace; an empty token is an error;
2. connects with `@bastani/atomic-storage-libsql` and runs `SELECT 1`. It creates no tables and changes no data; sessions, workflow runs, and Intercom brokers create their own tables when they first use the database;
3. stores the token in `~/.atomic/agent/storage-token` (in the agent directory under `ATOMIC_CODING_AGENT_DIR`), readable only by you (mode 600). Your token file is left as it is, and can be deleted;
4. writes only the top-level `storage` key of the global settings, `~/.atomic/agent/settings.json`, with the adapter, the URL, the token file, and the prefix. Every other setting keeps its value;
5. lists the environment variables and settings that take precedence over the new selection, and says whether the running Intercom broker still uses its previous one.

Nothing is written when the token is empty or the connection fails. When the adapter is not installed, the command prints the `atomic install` command to run first. A `file:` URL needs no `--token-file`. The `libsql://`, `https://`, and `wss://` schemes are accepted. A URL that contains the token itself, as a user name, a password, or an `authToken` parameter, is refused: pass the token with `--token-file` so it stays out of settings and output.

The running Intercom broker keeps the selection it started with. `atomic intercom restart` replaces it: connected sessions reconnect within a few seconds and start a broker that reads the new selection. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

### Checking the selected storage

`atomic storage status` shows, for sessions, workflow runs, and Intercom:

- the selected storage and where the selection comes from: an environment variable, project settings, global settings (`storage`, `sessions.storage`, or `workflows.journal`), or the default. Selections that are set but outranked are listed as `overrides`. See [Selecting storage per process](#selecting-storage-per-process) for the order;
- whether the adapter loads, and from which installed package;
- whether the database answers a `SELECT 1`. A local SQLite file that does not exist yet is not created, and no table is created or changed;
- for Intercom, whether a broker started now would route across machines, and how many brokers are live in the shared database;
- whether an Intercom broker is running, how many sessions it serves, whether it uses the current selection, and its multi-node routing state.

It also notes project settings that are not applied because the project is not trusted, and a project `storage` setting, which Intercom never uses. Run it in the project directory to see that project's selection. `--json` prints the same report as JSON. The command exits 1 when a selection is invalid, an adapter cannot load, or a database does not answer.

When the shared `storage` selection (global settings, `--storage`, or `ATOMIC_STORAGE`) names an adapter that the running Atomic cannot load, interactive and print sessions warn at startup, naming the adapter and the cause. The Intercom broker would otherwise leave multi-node routing off with only a line in its log.

## Bring your own driver

Atomic does not bundle remote database drivers. Install your chosen SQLite-compatible driver and turn it into a `SqliteDatabase` with `createSqliteDatabase` from `@bastani/atomic/storage`. You supply the driver calls:

- `descriptor`: the diagnostic `{ adapter, location }`. The facade passes `location` through `redact`.
- `execute(sql, params)`: runs one statement with positional parameters and returns `{ columns, rows, changes }`, where each row lists its values in column order. Return integers as `bigint` to keep large values exact.
- `executeMultiple(sql)`: runs zero or more statements that take no parameters.
- `beginTransaction()`: begins a write transaction and returns its own `execute` and `executeMultiple`, plus `commit()`, `rollback()`, and an optional `close()` that releases it afterward.
- `close()`: releases the connection.
- `redact(text)`, optional: removes credentials from diagnostic text. `redactSecrets(secrets)` builds one that also removes each secret's URI-encoded and decoded forms, longest first.

Driver calls may return values or promises. The returned facade follows the rules described above: it queues operations in call order and keeps them outside active transactions, snapshots binary parameters when a call is made, rejects NUL text with `StorageInvalidTextError` before SQL runs, returns safe-range integers as numbers and blobs as `Uint8Array` copies, expires transaction handles when their callback settles, and closes the driver once after draining accepted work. A failed driver call rejects with `StorageUnavailableError`, whose `cause` is the driver error with credentials redacted. A failed rollback rejects with `StorageRollbackError`, and callback failures are preserved. Do not fall back to memory after an opening failure.

You can also implement `SqliteDatabase` yourself by following the same rules. Either way, run the [conformance suite](#adapter-conformance) against it.

### libSQL / Turso example

This module is a complete adapter. Install `@libsql/client` where the module can import it, for example as a dependency of an [Atomic package](#adapters-from-atomic-packages). It accepts caller-provided credentials only. For a local file, create its parent directory first; no network or credentials are needed.

{/* custom-driver-example */}
```ts
import type { Client, Transaction } from "@libsql/client";
import {
	createSqliteDatabase,
	redactSecrets,
	type SqliteDatabase,
	type SqliteDriverExecutor,
	type StorageAdapterModule,
	StorageAdapterLoadError,
	type StorageFailureCause,
} from "@bastani/atomic/storage";

export interface LibsqlDatabaseOptions {
	url: string;
	authToken?: string;
}

/** Credentials a libSQL URL can carry: its userinfo and every `authToken` query value. */
function urlCredentials(url: string): string[] {
	const secrets: string[] = [];
	for (const match of url.matchAll(/[?&]([^=&#]*)=([^&#]*)/g)) {
		const token = new URLSearchParams(match[0].slice(1)).get("authToken");
		if (token !== null) secrets.push(match[2] ?? "", token);
	}
	const userinfo = url.match(/\/\/([^/?#]*)@/)?.[1];
	if (userinfo !== undefined) secrets.push(...userinfo.split(":"));
	return secrets;
}

function statements(connection: () => Client | Transaction): SqliteDriverExecutor {
	return {
		async execute(sql, params) {
			const result = await connection().execute({ sql, args: [...params] });
			return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
		},
		executeMultiple: (sql) => connection().executeMultiple(sql),
	};
}

export async function openLibsqlDatabase({ url, authToken }: LibsqlDatabaseOptions): Promise<SqliteDatabase> {
	let createClient: typeof import("@libsql/client").createClient;
	try {
		({ createClient } = await import("@libsql/client"));
	} catch (cause) {
		throw new StorageAdapterLoadError("@libsql/client", cause as StorageFailureCause);
	}
	let client: Client | undefined;
	// Create the client inside a driver call, so the facade redacts credentials from its failures.
	const connection = () => (client ??= createClient({ url, authToken, intMode: "bigint" }));
	const database = createSqliteDatabase({
		descriptor: { adapter: "libsql", location: url },
		redact: redactSecrets([authToken ?? "", ...urlCredentials(url)]),
		...statements(connection),
		async beginTransaction() {
			const transaction = await connection().transaction("write");
			return {
				...statements(() => transaction),
				commit: () => transaction.commit(),
				rollback: () => transaction.rollback(),
				close: () => transaction.close(),
			};
		},
		close: () => client?.close(),
	});
	try {
		await database.exec("PRAGMA foreign_keys = ON");
		return database;
	} catch (error) {
		await database.close().catch(() => {});
		throw error;
	}
}

export default {
	atomicStorageAdapter: 1,
	openDatabase: (options) =>
		openLibsqlDatabase({
			url: String(options.url),
			authToken: typeof options.authToken === "string" ? options.authToken : undefined,
		}),
} satisfies StorageAdapterModule;
```
{/* /custom-driver-example */}

Its default export lets settings select it as an [adapter](#selecting-an-adapter). From the SDK, call `openLibsqlDatabase` directly:

```ts
import { openLibsqlDatabase } from "./libsql-adapter.js";

const database = await openLibsqlDatabase({ url: "file:./data.sqlite" });
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

Pass the returned facade as SDK `sessionStore: { kind: "database", database, prefix: "project_" }` or workflow `journal: { database, prefix: "project_" }`. Both can use the same facade without closing your database.

## Selecting an adapter

An adapter is a module whose default export is a `StorageAdapterModule`, like the libSQL example above:

```ts
import type { StorageAdapterModule } from "@bastani/atomic/storage";

export default {
  atomicStorageAdapter: 1,
  async openDatabase(options, context) {
    return openMyDatabase({ url: String(options.url), authToken: String(options.authToken) });
  },
} satisfies StorageAdapterModule;
```

Select it with `sessions.storage: { "adapter": "./storage/libsql-adapter.ts" }`, `workflows.journal`, or shared top-level `storage` in [settings](/settings#workflow-storage). SDK sessions accept `sessionStore: { kind: "adapter", module, options, secrets, prefix }`; workflow runs accept `journal: { adapter, options, secrets, prefix }`. Relative module paths resolve from the agent directory, normally `~/.atomic/agent`; absolute module paths also work. A package name selects an adapter from an [installed Atomic package](#adapters-from-atomic-packages), or otherwise resolves from the agent directory. Project settings follow the same trust boundary as project extensions. A module executes with Atomic's privileges.

Adapter modules import `@bastani/atomic/storage` and `@bastani/atomic` from the running Atomic, in the npm package and the standalone binary alike, exactly as extensions do. They need no installed or linked copy of Atomic, and Atomic recognizes the storage errors they throw. List `@bastani/atomic` in an adapter package's `peerDependencies`, not its `dependencies`.

`options` is an object of SQLite scalar values or booleans. In JSON settings use strings, numbers, booleans, or null. `secrets` maps option names to `{ env }` or `{ file }`, and resolved values override same-named options. A `{ file }` secret is read as written, except that one trailing line ending (`\n` or `\r\n`) is removed, so a token saved with `turso db tokens create <db> > token` works as is. Other whitespace is kept. Keep credentials out of `options` and database descriptors. `context` contains `agentDir`, `domain: "sessions" | "journal" | "intercom"`, and an optional `signal`. Intercom brokers open the top-level `storage` selection with `domain: "intercom"` through `openDatabase`.

A SQLite adapter implements `openDatabase(options, context): Promise<SqliteDatabase>`. Atomic applies its domain schema and optional table prefix. A full adapter can instead implement `openSessionStore(options, context, storage)` or `openRunJournal(options, context, storage)`; the domain hook takes priority over `openDatabase`. The typed third argument is `{ readonly prefix?: string }`. Domain adapters must honor this prefix to isolate selected stores. A missing domain/database hook raises `StorageConfigError` with reason `"adapter-domain-unsupported"`. Load failures and invalid module contracts raise `StorageAdapterLoadError`; driver opening failures raise `StorageUnavailableError`. None selects memory as a fallback.

The exported `StorageProvider` can open either domain explicitly. Construct it with `{ memory: (descriptor) => new MemoryRunJournal(descriptor), sql: SqlRunJournal.open }` from `@bastani/atomic/workflows`, then call `openSessionStore(selection, context)` or `openRunJournal(selection, context)`. For sessions alone, `new StorageProvider()` needs no journal factories. `StorageSelection` uses `kind: "memory"`, `"jsonl"` with `dir` for sessions only, `"sqlite"` with `path`, `"database"` with a caller-owned facade, or `"adapter"` with `module`, optional options/secrets/prefix.

One provider shares a database for matching owned SQLite or adapter selections. Close every returned store; the last store closes the owned database. Closing a store is idempotent. A caller-owned `database` is never closed by the provider. A full domain adapter owns its returned store's lifecycle. Invalid configuration stops selection, and a configured persistent store that cannot open never becomes an in-memory store.

If opening storage fails and closing its owned database also fails, the original typed opening error is thrown with a `cleanupCause` field containing the cleanup failure. Inspect both errors when diagnosing the failed open.

Factory-created journal headers record a credential-free `storage` descriptor for diagnostics. Full domain adapters are responsible for recording their own safe descriptor. Directly supplied journals and their caller-provided headers are not rewritten.

### Adapters from Atomic packages

An [Atomic package](/packages) can provide storage adapters, so `atomic install` brings an adapter together with its driver and the driver's dependencies. List the adapter modules, relative to the package root, under `storageAdapters` in the package manifest:

```json
{
  "name": "@example/atomic-libsql",
  "dependencies": { "@libsql/client": "0.18.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./libsql-adapter.ts"] }
}
```

Install it with `atomic install npm:@example/atomic-libsql` and select it by package name:

```json
{
  "storage": {
    "adapter": "@example/atomic-libsql",
    "options": { "url": "libsql://team.example" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

The package name selects the package's first listed adapter. When a package lists several, select one with `<package>/<name>`, where `<name>` is the adapter file's name without its extension, for example `@example/atomic-libsql/libsql-adapter`. Atomic searches the packages in your user settings, which `atomic install` writes without `-l`; project packages are not searched. When no installed package lists a matching adapter, the name resolves from the agent directory as before.

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

The Intercom broker an Atomic process starts uses the same selection for multi-node routing: `--storage`, `--storage-file`, or `ATOMIC_STORAGE` from that process outranks the top-level `storage` setting, and a broker started by a process without them reads settings. One broker serves every session in an agent directory, so it keeps the selection of the process that started it until it exits or `atomic intercom restart` replaces it. Project settings never select the broker's storage.

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

By default, sessions and workflow runs live in a local file that serves one machine. To share them across machines, for example several service replicas or a CI fleet, select the same remote SQLite-compatible database on every host through an [adapter](#selecting-an-adapter), such as the [Turso / libSQL package](#turso-and-libsql). Installing the adapter as an [Atomic package](#adapters-from-atomic-packages) lets every host use the same `storage` block. Give each project or tenant its own `prefix`. Do not put the local SQLite file on a network filesystem; use a database driver instead.

With a shared journal:

- Any host can inspect any run with `status` or `stages` without taking ownership.
- Each run has one executor at a time. A run whose owner is alive cannot be claimed from another host. After its owner crashes and stops renewing its lease for about two minutes, the run appears as `crashed` and any host can resume it. Concurrent resume attempts admit one executor.
- Lease expiry uses the database clock, so clock differences between hosts do not affect ownership.
- A displaced executor cannot save new checkpoints; its writes fail with `StaleLeaseError`.

Selecting the same top-level `storage` on every host, in global settings or with `--storage`, `--storage-file`, or `ATOMIC_STORAGE`, also lets Intercom sessions on different hosts message each other; `sessions.storage` and `workflows.journal` alone do not. Brokers route through the database, so Intercom message bodies are stored there until shortly after they are delivered. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

The database stores sessions, workflow checkpoints, and, when Intercom brokers share it, Intercom messages and session routing state. To resume a run on another host, that host also needs the same workflow definition and the run's original working directory, including any worktrees and artifacts the run uses. Effects that were not checkpointed may run again after a takeover, so make external effects idempotent. Every checkpoint commits before it is reported, so a remote database adds network latency to each durable `ctx.*` step. Backends may also enforce payload limits that raise `StoragePayloadTooLargeError`.

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
