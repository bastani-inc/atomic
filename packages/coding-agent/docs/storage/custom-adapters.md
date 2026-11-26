---
title: "Custom storage adapters"
sidebarTitle: "Custom adapters"
description: "Select a storage adapter, ship one in an Atomic package, wrap your own SQL driver, implement a session store, and test it with the conformance suites."
---

Atomic opens every store other than its built-in SQLite, JSONL and in-memory stores through a storage adapter. The [PostgreSQL](/storage/postgres) backend is an adapter too. This page covers selecting an adapter, shipping one in an Atomic package, wrapping your own driver, and testing it.

## Selecting an adapter

A storage adapter is a module whose default export satisfies `StorageAdapterModule`:

```typescript
import type { StorageAdapterModule } from "@bastani/atomic/storage";

export default {
  atomicStorageAdapter: 1,
  async openDatabase(options, context) {
    return openMyDatabase({ url: String(options.url), authToken: String(options.authToken) });
  },
} satisfies StorageAdapterModule;
```

Select an adapter in `sessions.storage` or top-level `storage` in [settings](/settings#sessions), or pass `sessionStore: { kind: "adapter", module, options, secrets, prefix }` in the SDK. Relative module paths resolve from the agent directory (`~/.atomic/agent` by default). Bare package names resolve from user-scope [Atomic packages](#adapters-from-atomic-packages), host extension directories, or the agent directory, never from an embedding application's `node_modules`. Project settings follow the project trust boundary, and adapter code runs with Atomic's privileges.

Choose the installation method that matches how you open the adapter:

- **Direct SDK database handles (`{ kind: "database", database }`).** Install the package in your project with `npm install`, call `openPostgresDatabase()` or `openLibsqlDatabase()`, and pass the handle to `sessionStore: { kind: "database", database, prefix? }` or `SqlSessionStore.open(database, { prefix? })`. See [SDK session storage](/sdk/storage).
- **Adapter-resolved selections (`{ kind: "adapter", module }`, `settings.json`, `ATOMIC_STORAGE`, `ATOMIC_PROFILE=ci`).** Install the package in user scope with `atomic install npm:<package>` (without `-l`), or register a local package directory with `DefaultResourceLoader({ additionalExtensionPaths })` or `--extension`.

Adapter modules can import `@bastani/atomic/storage` and `@bastani/atomic` directly in both npm installs and standalone binaries. This works for the adapter entry file and any ES module or TypeScript file it imports relatively (including `.mjs` files and `.js` files in `"type": "module"` packages). CommonJS files outside the entry file resolve from `node_modules` instead. List `@bastani/atomic` under `peerDependencies`, not `dependencies`.

`options` holds SQLite scalar values or booleans. `secrets` maps secret names to `{ env }`, `{ file }`, or (in the SDK only) `inMemorySecret(value)` (`{ value }`), overriding same-named keys in `options`. Atomic strips one trailing `\n` or `\r\n` from `{ file }` secrets and keeps other whitespace intact. `inMemorySecret()` serializes as `[redacted]` and is refused outside the SDK (`in-memory-secret-unsupported`).

`context` provides `agentDir`, `domain: "sessions" | "intercom"`, an optional `signal`, and `secret(name)` to reread `secrets[name]` on demand. An adapter that reads fresh credentials for each new connection (such as a rotated password file) declares `liveSecrets` on its `StorageAdapterModule` (for example `liveSecrets: ["password"]`). Atomic omits names listed in `liveSecrets` from `options` and expects the adapter to call `context.secret(name)`, which throws `StorageConfigError` (`reason: "secret-missing"`) when the secret is missing from `secrets`.

Adapter hooks and lifecycle:

- Implement `openDatabase(options, context): Promise<SqliteDatabase>` for SQL-backed adapters so Atomic manages schemas, prefixes, and Intercom tables.
- Implement `openSessionStore(options, context, { prefix? })` for non-SQL session stores. When both hooks exist, `openSessionStore` takes priority for sessions.
- Missing hooks raise `StorageConfigError` (`reason: "adapter-domain-unsupported"`). Load failures raise `StorageAdapterLoadError`, and driver open failures raise `StorageUnavailableError`.
- `new StorageProvider().openSessionStore(selection, context)` opens stores programmatically (`kind`: `"memory"`, `"jsonl"`, `"sqlite"`, `"database"`, or `"adapter"`). `loadStorageAdapter(module, context, hostModules)` loads an adapter module.
- `StorageProvider` instances share one process-wide map of provider-owned databases across matching selections and close each owned database when its last returned store closes. Caller-owned `database` handles passed through `{ kind: "database", database }` are never closed by the provider.
- If opening storage fails and closing its owned database also fails, Atomic throws the original opening error with a `cleanupCause` field holding the cleanup failure.

### Adapters from Atomic packages

An [Atomic package](/packages) can bundle storage adapters and their driver dependencies by listing adapter paths under `atomic.storageAdapters` in `package.json`:

```json
{
  "name": "@example/atomic-libsql",
  "dependencies": { "@libsql/client": "0.18.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./libsql-adapter.ts"] }
}
```

Install the package with `atomic install npm:@example/atomic-libsql` and select it by package name:

```json
{
  "storage": {
    "adapter": "@example/atomic-libsql",
    "options": { "url": "libsql://team.example" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

The bare package name selects the first listed adapter. When a package exports several adapters, select one with `<package>/<name>` using the adapter filename without its extension (such as `@example/atomic-libsql/libsql-adapter`).

Host applications embedding Atomic can expose their own adapter without installing it separately. Pass the package directory via `--extension <dir>` or `additionalExtensionPaths: [packageRoot]` on `DefaultResourceLoader` before opening storage, then select `"adapter": "@example/app"` or `"@example/app/<name>"`.

Atomic resolves adapter package names in this order:

1. Extension package directories passed to the process (or inherited from the launching Atomic process).
2. Packages in effective global settings (including legacy `~/.pi/agent/settings.json` for the default agent directory). Project packages are not searched.
3. Module resolution from the agent directory.

Child processes that Atomic starts (such as subagents and the Intercom broker) automatically inherit adapters resolved from the host's packages without reloading the host package. `atomic storage status` shows the resolved path when run inside such a process, and resolves from global settings or the agent directory when run directly from a shell.

## Bring your own driver

To wrap a SQLite-compatible driver into a `SqliteDatabase`, call `createSqliteDatabase` from `@bastani/atomic/storage` with these driver hooks:

- `descriptor` provides `{ adapter, location }` for diagnostics (redacted through `redact`).
- `execute(sql, params)` runs one parameterized statement and returns `{ columns, rows, changes }`. Return integers as `bigint` to preserve 64-bit precision.
- `executeMultiple(sql)` runs zero or more unparameterized statements.
- `beginTransaction()` starts a write transaction and returns `{ execute, executeMultiple, commit, rollback, close? }`.
- `close()` releases the driver connection.
- `batch(statements)` (optional) executes `{ sql, params }` statements in one atomic write transaction sent as a single request. Provide this only when the driver sends the whole batch at once.
- `redact(text)` (optional) strips credentials from error text. Use `redactSecrets(secrets)` to build one that removes raw, URI-encoded, and decoded forms.
- `transientFailure(failure)` (optional) classifies retryable driver errors from structured fields (never message text) and returns `{ code, outcome, hop? }`. Set `outcome` to `"not-applied"` when the database cannot have changed, or `"unknown"` when the write may have committed. Set `hop: { name, failure }` when an intermediate hop such as a proxy failed before reaching the database.
- `freeBytes()` (optional) returns writable free bytes on the filesystem holding a local database file, or `undefined`.
- `openReader()` (optional) returns a driver with connections of its own on the same database, for reads. The facade exposes it as `SqliteDatabase.openReader()`. The reader gets its own call queue and closes when the main database closes.
- `concurrentTransactions` (optional) marks a driver that runs each transaction on its own connection, as the PostgreSQL adapter does. The facade then runs calls that cannot conflict at the same time. See the queue rules below.
- `pipelinedTransactions` (optional) marks a transaction connection that accepts a statement before the previous one is answered. The PostgreSQL adapter and the libSQL adapter's server connections set it. The facade then sends each statement of a transaction without waiting for the answer before it. It can also send a transaction's last writes together with its commit.
  - `beginTransaction` receives `leading`, the reads the transaction makes first. The driver may send them with the begin and answer the transaction's first calls from them.
  - If a statement sent ahead of an earlier answer, or with the commit, fails, the driver's commit must fail, so nothing commits. The transaction then fails with that statement's error.
  - A statement whose connection broke after the commit was sent reports `outcome: "unknown"`, because the commit may have applied.
- `concurrentReads` (optional) is a positive integer for a driver that runs reads on connections or streams of their own, up to that many at once. The facade then runs read-only transactions, and statements outside a transaction that `readsOnly` accepts, beside each other. Every other call still waits for each call before it, and a read waits for the writes queued before it. With `concurrentTransactions` as well, the facade runs at most this many reads at once.
- `readsOnly(sql)` (optional) says whether a statement run outside a transaction only reads. With `concurrentReads` or `concurrentTransactions`, such a statement runs beside other reads. Answer `true` only for a statement that can never write.
- On a driver with `concurrentTransactions`, a read-only transaction returns once its reads are answered. Its commit only ends the snapshot, so it finishes in the background, and `close()` waits for it.

Driver hooks may return values or promises. The facade runs one operation at a time unless the driver sets `concurrentTransactions`. It copies binary parameters on call, rejects NUL text bindings with `StorageInvalidTextError`, converts safe-range integers to `number`, expires transaction handles after settlement, and drains accepted work on `close()`. Unclassified driver errors reject with `StorageUnavailableError` (with redacted `cause`), and failed rollbacks reject with `StorageRollbackError`.

Transient retry and queue bounds:

- Recognized transient failures reject with `StorageTransientError`. Statements and batches that failed before writing retry up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` (5) times starting at 250 ms with exponential backoff and up to 20% jitter. Writes with `outcome: "unknown"` never retry automatically.
- Transactions retry (re-running their callback) only when called with `{ retryTransientFailures: true }` and only for callbacks that have no external side effects. Non-boolean values throw `StorageConfigError`. The first retried failure on a database emits a one-time process warning.
- On a driver with `concurrentTransactions`, a call waits only for earlier unfinished calls it conflicts with. Statements and batches outside a transaction, and serial transactions without a `domain`, conflict with every call. A serial transaction with a `domain` conflicts with others of the same domain. A read-only transaction waits for writes queued before it, but not for other read-only transactions or later writes. Conflicting calls run in call order, and calls that do not conflict, such as appends to different sessions, run concurrently. `fenced` transactions bypass the queue. Other drivers run one call at a time.
- While a call runs without settling, waiting priority batches (batches sent with `{ priority: true }`) fail after `STORAGE_PRIORITY_CALL_MAX_WAIT_MS` (10 seconds), and other waiting calls fail after `STORAGE_QUEUED_CALL_MAX_WAIT_MS` (60 seconds), both with `StorageUnavailableError`. On a driver with `concurrentTransactions`, only calls waiting behind the stuck call (directly or through other waiting calls) fail. Timers reset for each call that begins running.
- For shared local SQLite files, enable WAL mode with `switchToWriteAheadLog(exec, busyTimeoutMs)` from `@bastani/atomic/storage`. It retries `SQLITE_BUSY` up to `busyTimeoutMs` and retries Windows `SQLITE_IOERR_TRUNCATE` for up to 5 seconds (or `busyTimeoutMs`, whichever is shorter).

You can also implement `SqliteDatabase` directly. In either case, verify your implementation with the [conformance suite](#adapter-conformance).

### Custom driver adapter example

For production Turso or `sqld` deployments, install `@bastani/atomic-storage-libsql` (which includes abandoned-stream cleanup, namespace headers, and Windows local-file close safeguards). The minimal example below shows the `createSqliteDatabase` and `StorageAdapterModule` structure for wrapping any SQLite-compatible client:

```typescript
import { createClient, type Client, type Transaction } from "@libsql/client";
import {
  createSqliteDatabase,
  redactSecrets,
  type SqliteDatabase,
  type SqliteDriverExecutor,
  type StorageAdapterModule,
} from "@bastani/atomic/storage";

export interface CustomDriverOptions {
  url: string;
  authToken?: string;
}

function executor(connection: () => Client | Transaction): SqliteDriverExecutor {
  return {
    async execute(sql, params) {
      const result = await connection().execute({ sql, args: [...params] });
      return { columns: result.columns, rows: result.rows, changes: result.rowsAffected };
    },
    executeMultiple: (sql) => connection().executeMultiple(sql),
  };
}

export async function openCustomDatabase({ url, authToken }: CustomDriverOptions): Promise<SqliteDatabase> {
  let client: Client | undefined;
  const connection = () => (client ??= createClient({ url, authToken, intMode: "bigint" }));
  const database = createSqliteDatabase({
    descriptor: { adapter: "custom-libsql", location: url },
    redact: redactSecrets(authToken ? [authToken] : []),
    ...executor(connection),
    async beginTransaction() {
      const tx = await connection().transaction("write");
      return {
        ...executor(() => tx),
        commit: () => tx.commit(),
        rollback: () => tx.rollback(),
        close: () => tx.close(),
      };
    },
    async close() {
      client?.close();
    },
  });
  await database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export default {
  atomicStorageAdapter: 1,
  openDatabase: (options) =>
    openCustomDatabase({
      url: String(options.url),
      authToken: typeof options.authToken === "string" ? options.authToken : undefined,
    }),
} satisfies StorageAdapterModule;
```

The default export lets settings select this module as an [adapter](#selecting-an-adapter). From the SDK, call your open helper directly and pass the database to `createAgentSession`:

```typescript
import { openCustomDatabase } from "./custom-adapter.js";

const database = await openCustomDatabase({
  url: "libsql://your-database.turso.io",
  authToken: process.env.TURSO_TOKEN,
});
try {
  const { session } = await createAgentSession({
    sessionStore: { kind: "database", database, prefix: "project_" },
  });
  await session.prompt("List the failing tests");
} finally {
  await database.close();
}
```

Multiple stores can share one caller-owned `database` without closing it.

### Custom `SessionStore` contracts

Non-SQL backends can implement `openSessionStore` directly (each session has one writer):

- **Required for `history://`.** Implement `readEntryRange(id, query)` honoring `fromSeq`, `toSeq`, `seqs`, `maxChars`, `largeEntryBytes`, `skipTypes`, and `signal`. When `query.seqs` lists sequence numbers, return only the entries at those numbers. A `history://` search reads the entries it found, and the lines around them, this way, in one call. A store that returns the whole range instead still gives the same results, but reads more. Return freshly owned UTF-8 JSON buffers and `{ entries: [{ seq, entry }], throughSeq, lastSeq }` without falling back to whole-session `load()`.
- **Optional fast-path methods.** Implementing these avoids loading entire sessions into memory (stores implementing only `load()` still work with higher memory use):

| Method | Purpose |
| --- | --- |
| `readTail(id, fromSeq)` | Header and entries from `fromSeq`, plus earlier live state and omitted usage totals |
| `readRange(id, startSeq, endSeq)` | Inclusive 1-based range with `seqs`, `lastSeq`, and `epoch` |
| `findLatestCompaction(id, leafId?)` | Latest active compaction boundary, sequence, and retained start |
| `readResume(id, leafId?)` | Atomic resume snapshot (header, active branch from compaction, live state, omitted totals, `deliveryOpIds`, `lastSeq`, `lastEntryId`, `leafId`, `epoch`) |
| `findEntrySeq(id, entryId)` | 1-based entry sequence, or `undefined` |
| `readEntrySizes` / `readEntryChunk` / `readScanPage` | Byte-bounded streaming exports and remote page reads |

- **Epochs and indexes.** Keep `epoch` constant on appends, rotate it on `replace` or recreate, and reject mismatched `epoch` writes with `SessionConflictError`. Mark read-only stores `readOnly: true` to skip cleanup writes. Set `estimated: true` on `SessionSummary` when metadata is unindexed.
- **Forks and cloning.** `/fork`, `/clone`, and `SessionManager.forkFrom` stream entries in pages (same-store forks copy all branches; cross-store forks copy current context and mark the parent in another store; see [`/tree`, `/fork`, and `/clone`](/sessions#tree-fork-and-clone)).

## Adapter conformance

Validate any `SqliteDatabase` adapter against the conformance suites exported from `@bastani/atomic/storage/testing`:

```typescript
import {
  registerSqliteConnectionConformance,
  registerSqliteDatabaseConformance,
} from "@bastani/atomic/storage/testing";

// Pass your test runner's `describe` and `it` functions.
registerSqliteDatabaseConformance({ describe, it }, "my adapter", withSubject);
registerSqliteConnectionConformance({ describe, it }, "my adapter connections", withConnections);
```

- `withSubject` creates a fresh database per test case and passes `{ database, reopen, withRollbackFailure }` to the callback, cleaning up afterward. `reopen()` closes and reopens the same persistent database, and `withRollbackFailure(error, callback)` injects a rollback failure for the duration of `callback`. The suite verifies parameter binding, exact 64-bit integers, binary snapshots, NUL rejection, transaction ordering and expiration, commit and rollback errors, reopening, and close semantics.
- `withConnections` (for adapters supporting multiple connections to one database) opens two facades on the same fresh database and closes both afterward. The suite verifies concurrent write queuing and event-loop responsiveness.

Helper utilities exported from `@bastani/atomic/storage` for custom adapters:

- `validateStoragePrefix(prefix, dialect?)` validates optional table prefixes (ASCII letters, digits, and `_`, not starting with `sqlite_`, case-insensitively). Passing `"postgres"` also enforces lowercase and `POSTGRES_MAX_STORAGE_PREFIX_LENGTH` (24).
- `renderStorageIdentifiers("sessions", names, prefix)` returns a frozen map of table names with the `session_` prefix applied.
- `assertStorageSchemaVersion(domain, found, supported)` throws `StorageSchemaVersionError` when stored and supported versions differ.
