---
title: "Custom storage adapters"
sidebarTitle: "Custom adapters"
description: "Build, package, configure, and test custom SQL or SessionStore storage adapters for Atomic."
---

A **storage adapter** is a JavaScript or TypeScript module that connects Atomic to a database backend it does not support out of the box. Atomic's own [PostgreSQL](/storage/postgres) support is implemented as an adapter; only local SQLite, JSONL, and in-memory stores are built in.

Choose the adapter hook that fits your database:

| Backend type | Implement | Capabilities |
| --- | --- | --- |
| SQLite-compatible (or PostgreSQL-dialect) SQL database | `openDatabase(options, context)` returning `SqliteDatabase` | Full support for sessions, prefixes, snapshots, and multi-node Intercom |
| Non-SQL or custom document/KV database | `openSessionStore(options, context, { prefix? })` returning `SessionStore` | Sessions only (Intercom multi-node routing requires a SQL `openDatabase` adapter) |

## Selecting an adapter

An adapter module's default export satisfies `StorageAdapterModule`:

```typescript
import type { StorageAdapterModule } from "@bastani/atomic/storage";

export default {
  atomicStorageAdapter: 1,
  async openDatabase(options, context) {
    return openMyDatabase({ url: String(options.url), authToken: String(options.authToken) });
  },
} satisfies StorageAdapterModule;
```

Select an adapter in `sessions.storage` or top-level `storage` in [settings](/settings#sessions), or pass `sessionStore: { kind: "adapter", module, options, secrets, prefix }` in the SDK. Relative module paths resolve from the agent directory (`~/.atomic/agent` by default). Bare package names resolve from user-scope [Atomic packages](#adapters-from-atomic-packages), host extension directories, or the agent directory—never from an embedding app's `node_modules`.

<Warning>
Adapter modules execute code with Atomic's full OS privileges. Project-level storage settings follow Atomic's [project trust boundary](/security)—review adapter packages carefully before trusting a project.
</Warning>

Match installation method to how you open the adapter:

- **Direct SDK handles (`{ kind: "database", database }`):** install the adapter in your app with `npm install`, call its opener (such as `openPostgresDatabase()`), and pass the handle to `sessionStore: { kind: "database", database, prefix? }` or `SqlSessionStore.open(database, { prefix? })`. See [SDK session storage](/sdk/storage).
- **Adapter-resolved selections (`{ kind: "adapter", module }`, `settings.json`, or `ATOMIC_STORAGE`):** install in user scope with `atomic install npm:<package>` (without `-l`), or register a local package directory via `--extension <dir>` or `DefaultResourceLoader({ additionalExtensionPaths })`.

<Note>
**Packaging imports:** Adapters can import `@bastani/atomic/storage` and `@bastani/atomic` directly in both npm installs and standalone binaries—both in the adapter entry file and in any ES module or TypeScript file it imports relatively (`.ts`, `.mjs`, or `.js` under `"type": "module"`). CommonJS files outside the entry file resolve from `node_modules`. Declare `@bastani/atomic` in `peerDependencies`, never `dependencies`.
</Note>

### Options, secrets, and lifecycle

- **`options` and `secrets`:** `options` accepts `string | number | boolean | null`. `secrets` maps secret names to `{ env }`, `{ file }`, or (SDK only) `inMemorySecret(value)` (`{ value }`), overriding same-named keys in `options`. Atomic strips one trailing `\n` or `\r\n` from `{ file }` secrets and leaves other whitespace intact. `inMemorySecret()` serializes as `[redacted]` and is refused outside the SDK (`in-memory-secret-unsupported`).
- **`context` and `liveSecrets`:** `context` supplies `{ agentDir, domain: "sessions" | "intercom", signal?, secret(name) }`. Adapters that re-read rotating credentials per connection declare `liveSecrets` on `StorageAdapterModule` (for example `liveSecrets: ["password"]`): Atomic omits those names from `options` and expects the adapter to call `await context.secret(name)`, which throws `StorageConfigError` (`secret-missing`) if absent from `secrets`.
- **Hook priority and errors:** When an adapter exports both `openDatabase` and `openSessionStore`, `openSessionStore` takes priority for `"sessions"` while `openDatabase` handles `"intercom"`. Missing hooks throw `StorageConfigError` (`adapter-domain-unsupported`); module load failures throw `StorageAdapterLoadError`; connection failures throw `StorageUnavailableError`.
- **Programmatic pooling (`StorageProvider`):** `new StorageProvider().openSessionStore(selection, context)` opens `"memory"`, `"jsonl"`, `"sqlite"`, `"database"`, or `"adapter"` stores programmatically (`loadStorageAdapter(module, context, hostModules)` loads an adapter module directly). `StorageProvider` shares one process-wide map of provider-owned databases across matching selections and closes an owned database when its last returned store closes. Caller-owned handles (`{ kind: "database", database }`) are never closed by the provider. If opening fails and closing an owned database also fails, Atomic throws the opening error with `cleanupCause` set.

### Adapters from Atomic packages

An [Atomic package](/packages) can bundle adapters and their driver dependencies under `atomic.storageAdapters` in `package.json`:

```json
{
  "name": "@example/atomic-mydb",
  "dependencies": { "mydb-client": "^2.0.0" },
  "peerDependencies": { "@bastani/atomic": "*" },
  "atomic": { "storageAdapters": ["./mydb-adapter.ts"] }
}
```

Install with `atomic install npm:@example/atomic-mydb` and reference it by package name:

```json
{
  "storage": {
    "adapter": "@example/atomic-mydb",
    "options": { "url": "mydb://db.example.com/atomic" },
    "secrets": { "authToken": { "file": "mydb-token" } }
  }
}
```

A bare package name selects the first listed adapter. For multi-adapter packages, select `<package>/<file-stem>` (filename without extension, such as `@example/atomic-mydb/mydb-adapter`).

Host applications can expose an adapter without installing it globally by passing the package directory via `--extension <dir>` or `DefaultResourceLoader({ additionalExtensionPaths: [packageRoot] })` before opening storage, then referencing `"@example/app"` or `"@example/app/<name>"`.

Resolution order for bare adapter package names:

1. Extension package directories passed to the process (or inherited from the launching Atomic process).
2. Packages in effective global settings (including legacy `~/.pi/agent/settings.json` for the default agent directory). Project packages are never searched.
3. Module resolution from the agent directory.

Child processes launched by Atomic (subagents and the Intercom broker) inherit resolved host adapters automatically without reloading host packages.

## Bring your own driver

Wrap any SQLite-compatible (or PostgreSQL-dialect) driver into a `SqliteDatabase` with `createSqliteDatabase(driver)` from `@bastani/atomic/storage`. Driver hooks may return sync values or promises.

### Required `SqliteDriver` hooks

| Hook | Signature / behavior |
| --- | --- |
| `descriptor` | `{ adapter: string; location: string }` for diagnostics (`location` is passed through `redact`). |
| `execute(sql, params)` | Runs one parameterized statement and returns `{ columns, rows, changes }`. Return integers as `bigint` to preserve 64-bit precision. |
| `executeMultiple(sql)` | Runs zero or more unparameterized SQL statements. |
| `beginTransaction(options?)` | Starts a transaction and returns `{ execute, executeMultiple, commit, rollback, close? }`. |
| `close()` | Releases driver connections after accepted work drains. |

### Optional resilience, metadata, and concurrency hooks

| Hook | Purpose |
| --- | --- |
| `dialect` | `StorageDialect` spoken by the backend (`sqliteDialect` when omitted, or `postgresDialect` from `@bastani/atomic/storage`). |
| `batch(statements, options?)` | Runs `{ sql, params }[]` atomically in a single write request (`options`: `{ lockWaitMs?, priority? }`). Provide only when the driver sends the whole batch in one round trip. |
| `redact(text)` | Strips secrets from diagnostic locations and error text. Build one with `redactSecrets(secrets)` to cover raw, URI-encoded, and decoded forms. |
| `transientFailure(failure)` | Classifies retryable driver errors from structured fields (never message text) into `{ code, outcome: "not-applied" \| "unknown", hop?: { name, failure } }`. Set `outcome: "not-applied"` only when the database could not have changed; set `hop` when an intermediate proxy failed before reaching the server. |
| `lockBusy(failure)` | Recognizes a `batch()` write-lock contention error that wrote nothing; Atomic retries outside its queue with randomized backoff up to `lockWaitMs`. |
| `payloadLimits` | `{ value?: number; response?: number }` byte limits reported in `StoragePayloadTooLargeError`. |
| `notifications` | `StorageNotifications` (`notify`, `listen`, `state`, optional `send`) for push wake-ups such as PostgreSQL `LISTEN`/`NOTIFY`. |
| `freeBytes()` | Returns writable free bytes on the filesystem holding a local database file, or `undefined`. |
| `openReader()` | Returns a read-only driver on dedicated connections (`SqliteDatabase.openReader()`). Reads through it wait for that store's own in-flight writes to the same data so read-your-writes holds, and it closes automatically with the main handle. |
| `takeOpenedCatalog()` | Returns the schema catalog read during initial connection open once (`StorageOpenedCatalog`), skipping duplicate schema queries on store open. |
| `databaseIdentity()` | Returns a canonical identity string shared only by handles targeting the exact same database and schema (or `undefined` when unknown, such as in memory). |
| `concurrentTransactions` | Set `true` if each transaction runs on its own connection (as in PostgreSQL) so non-conflicting transactions run in parallel. |
| `concurrentReads` | Positive integer capping concurrent read-only transactions and read-only statements on drivers with dedicated read connections/streams. |
| `readsOnly(sql)` | Returns `true` only when a statement run outside a transaction can never write; enables parallel read execution under `concurrentReads` or `concurrentTransactions`. |
| `pipelinedTransactions` | Set `true` if a transaction connection accepts statements before prior responses arrive, allowing Atomic to pipeline statements and batch final writes with `COMMIT`. |

### Transaction options and concurrency scopes

When Atomic calls `beginTransaction(options)`, `options` (`SqliteDriverTransactionOptions`) specifies how to lock and pipeline the transaction:

- **`concurrency` (`TransactionConcurrency`, always set):**
  - `{ kind: "serial", domain?: string }` (default): runs as the sole writer for the whole database (when `domain` is absent) or for a named scope `domain` (a store passes a prefixed table name so independent domains or prefixes run in parallel on `concurrentTransactions` drivers).
  - `{ kind: "fenced", audit, excludesSerial?: boolean }`: runs under `READ COMMITTED` and locks only the rows the body touches; with `excludesSerial: true`, also excludes whole-database `serial` transactions. SQLite drivers treat both kinds as `BEGIN IMMEDIATE`.
- **`readOnly`:** Opens a consistent read snapshot without taking a write lock. On `concurrentTransactions` drivers, a read-only transaction resolves once its reads finish and commits in the background (`close()` awaits it).
- **`lockWaitMs`:** Per-transaction lock wait override.
- **`relaxedDurability`:** When `true` (never set on read-only transactions), the write is repeatable and losing it in a server crash is harmless (such as a lease heartbeat), so the driver may acknowledge commit before flushing to disk (for example `synchronous_commit = off` on PostgreSQL).
- **Pipelining hints (`leading`, `leadingOnly`, `onCommit`, `lockIfLeadingFinds`):** On `pipelinedTransactions` drivers, Atomic may supply initial statements in `leading` to send alongside `BEGIN` (or commit immediately behind them when `leadingOnly: true`, calling `onCommit?.()` right before writing `COMMIT` so any later connection drop keeps `outcome: "unknown"`). `lockIfLeadingFinds` lets a `serial` domain transaction acquire locks in its first leading read only if a row matches. If any pipelined statement fails, `commit()` must fail so nothing commits.

### Facade guarantees, retries, and queue bounds

`createSqliteDatabase` automatically copies `Uint8Array` bindings on call, rejects NUL (`U+0000`) strings with `StorageInvalidTextError`, converts safe-range integers to `number`, expires transaction handles once settled, wraps unclassified driver errors in `StorageUnavailableError` (redacted), and rejects failed rollbacks with `StorageRollbackError`.

- **Transient retries:** Recognized transient failures reject with `StorageTransientError`. Statements and batches that failed before writing make up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` (**5**) total attempts—1 initial attempt plus up to 4 retries—starting at 250 ms with exponential backoff and up to 20% jitter. Writes with `outcome: "unknown"` never retry automatically.
- **Transaction retries:** Transactions re-run their callback only when called with `{ retryTransientFailures: true }` (use only for side-effect-free callbacks; non-boolean values throw `StorageConfigError`). The first retry on a database emits a one-time process warning.
- **Call queue scheduling:** Without `concurrentTransactions`, calls execute one at a time. With `concurrentTransactions`, a call waits only for earlier unfinished calls it conflicts with: standalone statements/batches and whole-database `serial` transactions (no `domain`) conflict with all calls; `serial` transactions with a `domain` conflict only with matching domains (and whole-database calls); read-only transactions wait for earlier writes but run in parallel with other reads and later writes.
- **Stuck-call bounds:** While an active call stalls without settling, queued priority batches (`{ priority: true }`) fail after `STORAGE_PRIORITY_CALL_MAX_WAIT_MS` (10 seconds) and ordinary queued calls fail after `STORAGE_QUEUED_CALL_MAX_WAIT_MS` (60 seconds), both with `StorageUnavailableError` (with `concurrentTransactions`, only calls blocked behind the stalled call fail).
- **WAL helper for local SQLite files:** Call `switchToWriteAheadLog(exec, busyTimeoutMs)` from `@bastani/atomic/storage` to enable WAL with retries on `SQLITE_BUSY` and Windows `SQLITE_IOERR_TRUNCATE` (up to `min(5000, busyTimeoutMs)` ms).

You can also implement `SqliteDatabase` directly. Either way, validate your implementation with the [conformance suite](#adapter-conformance).

### Custom driver adapter example

This complete example wraps Node.js's built-in `node:sqlite` driver to show how `createSqliteDatabase` and `StorageAdapterModule` fit together. Save as `custom-adapter.ts`:

```typescript
import { DatabaseSync } from "node:sqlite";
import {
  createSqliteDatabase,
  type SqliteDatabase,
  type SqliteDriverExecutor,
  type SqliteValue,
  type StorageAdapterModule,
} from "@bastani/atomic/storage";

export interface CustomDriverOptions {
  path: string;
}

const WRITES = /^\s*(insert|update|delete|replace)\b/i;

function executor(connection: DatabaseSync): SqliteDriverExecutor {
  return {
    execute(sql, params) {
      const statement = connection.prepare(sql);
      statement.setReadBigInts(true);
      const columns = statement.columns().map((column) => column.name);
      if (columns.length === 0) {
        const { changes } = statement.run(...params);
        return { columns, rows: [], changes: Number(changes) };
      }
      statement.setReturnArrays(true);
      const rows = statement.all(...params) as unknown as SqliteValue[][];
      if (!WRITES.test(sql)) return { columns, rows, changes: 0 };
      const { changes } = connection.prepare("SELECT changes() AS changes").get() as { changes: number };
      return { columns, rows, changes };
    },
    executeMultiple: (sql) => connection.exec(sql),
  };
}

export async function openCustomDatabase({ path }: CustomDriverOptions): Promise<SqliteDatabase> {
  const connection = new DatabaseSync(path);
  const database = createSqliteDatabase({
    descriptor: { adapter: "custom-node-sqlite", location: path },
    ...executor(connection),
    beginTransaction() {
      connection.exec("BEGIN IMMEDIATE");
      return {
        ...executor(connection),
        commit: () => connection.exec("COMMIT"),
        rollback: () => connection.exec("ROLLBACK"),
      };
    },
    close() {
      connection.close();
    },
  });
  await database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export default {
  atomicStorageAdapter: 1,
  openDatabase: (options) => openCustomDatabase({ path: String(options.path) }),
} satisfies StorageAdapterModule;
```

Use it through settings as an [adapter](#selecting-an-adapter), or pass a caller-owned handle directly in the SDK:

```typescript
import { createAgentSession } from "@bastani/atomic";
import { openCustomDatabase } from "./custom-adapter.js";

const database = await openCustomDatabase({ path: "./sessions.sqlite" });
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

Non-SQL backends implement `openSessionStore` returning a `SessionStore` (imported from `@bastani/atomic/storage`). Required methods are `create`, `append`, `replace`, `load`, `readHeader`, `delete`, `list`, `findMostRecent`, and `close`.

#### Required for `history://` reads

Implement `readEntryRange` to power `history://` reads and search without loading entire sessions into memory:

```typescript
import type {
  SessionEntriesPage,
  SessionEntriesQuery,
  SessionStore,
} from "@bastani/atomic/storage";

// Query and response shapes:
// SessionEntriesQuery: {
//   fromSeq: number;
//   toSeq: number;
//   seqs?: readonly number[];       // specific ascending sequence numbers to return in one call
//   maxChars?: number;              // stop page before exceeding this character budget (unless first entry)
//   largeEntryBytes?: number;       // byte threshold for streaming rawChunks on oversized entries
//   skipTypes?: readonly string[];  // entry types to omit from the page
//   signal?: AbortSignal;
// }
// SessionEntriesPage: {
//   lastSeq: number;
//   throughSeq: number;
//   entries: readonly { seq: number; entry: SessionEntry; rawChunks?: readonly Uint8Array[]; rawFormatVersion?: number }[];
// }
```

When `query.seqs` is provided, return only entries at those sequence numbers so `history://` search fetches matches and surrounding context in a single call (returning the whole `[fromSeq, toSeq]` range remains valid but reads more). Return freshly owned UTF-8 buffers for `rawChunks` rather than falling back to whole-session `load()`.

#### Optional capability hooks

| Hook / property | Purpose |
| --- | --- |
| `putBlob(sessionId, data)` / `getBlob(sessionId, hash)` | Store and retrieve SHA-256 content-addressed tool output files (`tool-output://`); omitted stores throw `SessionBlobError` (`blobs-unsupported`). |
| `snapshotBlobs` (`SnapshotBlobStore`) | Content-addressed storage for [worktree snapshots](/worktree-snapshots); omit to disable snapshots. |
| `openMarkers` (`SessionOpenMarkerStore`) | Cross-host open-session tracking (`put`, `remove`, `list`) for delete protection and upgrade gating; falls back to local agent-dir files when omitted. |
| `chatRecords` | Reader-only chat metadata (such as subagent child records) stored outside the conversation tree. |
| `searchIndex` (`SessionSearchIndex`) | Indexed full-text search backing `history://` queries. |
| `createFork(header, entries, source, location?)` | Optimized or receipt-preserving fork creation (return `undefined` to fall back to standard copying). |
| `updateHeader(header, options)` | Update session header metadata in place (rotates `epoch`) without rewriting entries. |
| `releaseSession(sessionId)` | Advisory hint that no live handle holds the session, allowing in-memory stores to spill history to disk until reopened. |

#### Optional fast-path read hooks

Stores implementing only `load()` still work, but implementing these methods avoids loading full session history into RAM:

| Method signature | Purpose |
| --- | --- |
| `readTail(sessionId, fromSeq): Promise<SessionTail>` | Header and entries from `fromSeq`, plus prior live state and omitted usage totals. |
| `readRange(sessionId, startSeq, endSeq, expectedEpoch?): Promise<SessionEntryRange>` | Inclusive 1-based entry range returning `entries`, `seqs`, `lastSeq`, and `epoch`. |
| `findLatestCompaction(sessionId, leafId?): Promise<SessionCompactionPoint \| undefined>` | Latest active compaction boundary, its sequence, and retained tail start sequence. |
| `readResume(sessionId, leafId?, options?): Promise<SessionResume>` | Single-call resume snapshot: header, active branch from compaction, live state, omitted totals, `recovery` (`SessionRecoveryState` carrying `admissionDigests`, `intercomDeliveredIds`, and optional `deliveryOpIds` for deduplicating replayed deliveries), `lastSeq`, `lastEntryId`, `leafId`, and `epoch`. |
| `readResumeAt(sessionId, leafId, throughSeq, options?): Promise<SessionResume>` | Resume snapshot bounded to a specific historical watermark (`throughSeq`). |
| `findEntrySeq(sessionId, entryId): Promise<number \| undefined>` | 1-based sequence number for an entry ID, or `undefined`. |
| `readEntrySizes(sessionId, startSeq, endSeq, limit?): Promise<SessionEntrySizes>` | Entry byte sizes for sizing paged history reads before decoding payloads. |
| `readEntryChunk(reference, offset, bytes?): Promise<Uint8Array>` | Stream raw UTF-8 bytes of an `OversizedSessionEntry` in chunks (rejects stale `epoch`). |
| `readScanPage(sessionId, startSeq, endSeq, epoch, limit, options?): Promise<SessionScanPage>` | Single-read byte-bounded forward scan page (with header, `epoch`, `lastSeq`, `throughSeq`, and optional oversized references) used by exports and remote readers. |
| `readTreeOutline(sessionId, fromSeq, toSeq, epoch?)` | Body-free tree structure metadata for `/tree` navigation without reading message content. |
| `readBranchSpan(sessionId, cut)` | Contiguous range on a single branch without reading sibling branches. |
| `readSnapshotCut(sessionId, options?)` | Index lookup locating `worktree_snapshot` entries without scanning bodies. |
| `readSelectedPage(sessionId, seqs, epoch, options?)` | Byte-bounded page of specific ascending sequences (forward or backward). |
| `readForkWindow(sessionId, entryId, options?)` | Active branch window and labels needed to fork from a specific entry. |

#### Epochs, read-only stores, and forks

- **Epochs:** Keep `epoch` constant across `append()` calls, rotate it on `replace()`, `updateHeader()`, or recreation, and reject writes with a mismatched `epoch` using `SessionConflictError`.
- **Read-only and estimated summaries:** Mark read-only stores so cleanup writes are skipped, and set `estimated: true` on `SessionSummary` when metadata is unindexed.
- **Forks and cloning:** `/fork`, `/clone`, and `SessionManager.forkFrom()` stream entries in pages (same-store forks copy all branches; cross-store forks copy active context and set `parentInOtherStore: true`; see [`/tree`, `/fork`, and `/clone`](/sessions#tree-fork-and-clone)).

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

- `withSubject` creates a fresh database per test and passes `{ database, reopen, withRollbackFailure }` to the callback, cleaning up afterward (`reopen()` closes and reopens the persistent database; `withRollbackFailure(error, callback)` injects a rollback failure). Verifies parameter binding, 64-bit integer precision, binary snapshots, NUL rejection, transaction ordering/expiration, commit/rollback errors, reopen persistence, and close semantics.
- `withConnections` (for multi-connection adapters) opens two handles on one fresh database and closes both afterward. Verifies concurrent write queuing and event-loop responsiveness.

Helper utilities exported from `@bastani/atomic/storage`:

- `validateStoragePrefix(prefix, dialect?)`: validates optional table prefixes (ASCII letters, digits, `_`; cannot start with `sqlite_`, case-insensitively). Passing `"postgres"` also enforces lowercase and `POSTGRES_MAX_STORAGE_PREFIX_LENGTH` (24).
- `renderStorageIdentifiers("sessions", names, prefix)`: returns a frozen map of table names with the `session_` prefix applied.
- `assertStorageSchemaVersion(domain, found, supported)`: throws `StorageSchemaVersionError` when stored and supported versions mismatch.
