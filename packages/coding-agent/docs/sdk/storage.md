---
title: "SDK storage backends"
sidebarTitle: "Storage backends"
description: "Configure local SQLite, JSONL, in-memory, and PostgreSQL storage for createAgentSession(), createAgentSessionRuntime(), and SessionManager."
---

By default, Atomic persists sessions in local SQLite at `~/.atomic/workflows/journal.sqlite` (`session_` table prefix). In SDK applications, you can select any built-in or remote backend per session, share one database connection across multiple sessions, or manage lifecycle explicitly through `createAgentSessionRuntime()` and `SessionManager`.

For CLI setup, database role administration, migrations, and custom drivers, see [Storage](/storage).

## Choosing a backend

| Backend | Package | How to pass it | Best for |
| --- | --- | --- | --- |
| **Local SQLite** (default) | Built into `@bastani/atomic` | `{ kind: "sqlite", path, prefix? }` or caller-owned `openNodeSqliteDatabase()` | Single-machine apps, full worktree snapshots, history search, zero external services |
| **JSONL directory** | Built into `@bastani/atomic` | `{ kind: "jsonl", dir }` or `JsonlSessionStore.open(dir, { exactDirectory: true })` | Human-readable append-only `.jsonl` files (no snapshot blobs) |
| **In-memory** | Built into `@bastani/atomic` | `SessionManager.inMemory()`, `new MemorySessionStore()`, or `{ kind: "memory" }` | Tests, ephemeral runs, or RAM-backed release/rehydrate |
| **PostgreSQL 16+** | [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) | `openPostgresDatabase()` + `{ kind: "database", database }` or `{ kind: "adapter", ... }` | Concurrent multi-machine writers, managed HA, connection poolers, cloud IAM |

### `@bastani/atomic` vs. `@bastani/atomic/storage`

`@bastani/atomic` re-exports the entire `@bastani/atomic/storage` surface, so host applications can import from either entrypoint. Import directly from `@bastani/atomic/storage` in custom storage adapters, scripts, or utilities that only need SQLite handles, path helpers, or storage errors without loading the full agent runtime.

## `createAgentSession()` recipes

Every recipe below closes its session (and any caller-owned store or database handle) inside `try`/`finally`.

### Local SQLite

Pass `{ kind: "sqlite", path, prefix? }` when you want Atomic to open the file and close it on `session.dispose()`. Open the database yourself with `openNodeSqliteDatabase()` when multiple sessions share one connection.

```typescript
import { createAgentSession, SqlSessionStore } from "@bastani/atomic";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";

// Option 1: Session-owned SQLite file (Atomic opens and closes it on dispose())
{
  const { session } = await createAgentSession({
    sessionStore: { kind: "sqlite", path: "./sessions.sqlite", prefix: "app_" },
  });
  try {
    await session.prompt("List the exported modules in src/");
  } finally {
    await session.dispose();
  }
}

// Option 2: Caller-owned SqliteDatabase shared across sessions via { kind: "database" }
// Atomic closes its internal SqlSessionStore wrapper on dispose() and leaves `database` open.
{
  const database = await openNodeSqliteDatabase("./shared.sqlite", {
    busyTimeoutMs: 5000,
    lockWaitMs: 30_000,
  });
  try {
    const { session } = await createAgentSession({
      sessionStore: { kind: "database", database, prefix: "app_" },
    });
    try {
      await session.prompt("Summarize recent commits");
    } finally {
      await session.dispose();
    }
  } finally {
    await database.close();
  }
}

// Option 3: Caller-owned SqlSessionStore (close store first, then database)
{
  const database = await openNodeSqliteDatabase("./shared.sqlite");
  try {
    const store = await SqlSessionStore.open(database, { prefix: "app_" });
    try {
      const { session } = await createAgentSession({ sessionStore: store });
      try {
        await session.prompt("Check test coverage");
      } finally {
        await session.dispose();
      }
    } finally {
      await store.close();
    }
  } finally {
    await database.close();
  }
}
```

### JSONL directory

Selection objects (`{ kind: "jsonl", dir }`) open `JsonlSessionStore.open(dir, { exactDirectory: true })`, writing flat `<timestamp>_<hash>.jsonl` files directly inside `dir` (matching `--session-dir`). Calling `JsonlSessionStore.open(dir)` directly defaults `exactDirectory` to `false`, creating per-working-directory subdirectories (`--<encoded-cwd>--/*.jsonl`). Pass `{ exactDirectory: true }` when you want both paths to read the same layout.

```typescript
import { createAgentSession, JsonlSessionStore } from "@bastani/atomic";

// Option 1: Session-owned flat directory layout (exactDirectory: true)
{
  const { session } = await createAgentSession({
    sessionStore: { kind: "jsonl", dir: "./sessions" },
  });
  try {
    await session.prompt("Explain package.json scripts");
  } finally {
    await session.dispose();
  }
}

// Option 2: Caller-owned JsonlSessionStore
// Omit `exactDirectory` (or pass `false`) for per-cwd subdirectories under `./shared-jsonl`.
{
  const store = await JsonlSessionStore.open("./shared-jsonl", { exactDirectory: true });
  try {
    const { session } = await createAgentSession({ sessionStore: store });
    try {
      await session.prompt("Audit tsconfig.json");
    } finally {
      await session.dispose();
    }
  } finally {
    await store.close();
  }
}
```

### In-memory

Atomic offers three in-memory configurations with different release and rehydrate behavior:

1. **`SessionManager.inMemory()`:** Ephemeral private session with no external store handle. Cannot be released and rehydrated (`not-reopenable`).
2. **Caller-owned `new MemorySessionStore()`:** Keeps session history in process RAM across `session.release()` and `runtime.rehydrate()` without writing anything to disk. You own the store and close it with `await store.close()`.
3. **Disk-spilling memory store via `resolveSessionStore(cwd, { agentDir, sessionStore: { kind: "memory" } })`:** Writes released session history to private owner-only files (`0700`/`0600`) under `<agentDir>/released-history/` to free RAM while idle, cleaning up files on close and process exit (throws `SessionSpillError` if a spill file is missing or corrupt).

Passing `{ kind: "memory" }` or `storage: { memory: true }` directly to `createAgentSession()` creates a session-owned memory store that is closed and discarded on `dispose()`, so it cannot be rehydrated after release.

```typescript
import {
  createAgentSession,
  getAgentDir,
  MemorySessionStore,
  resolveSessionStore,
  SessionManager,
} from "@bastani/atomic";

// 1. Ephemeral private session (no persistence, not reopenable)
{
  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
  });
  try {
    await session.prompt("Return a one-line summary of README.md");
  } finally {
    await session.dispose();
  }
}

// 2. Caller-owned MemorySessionStore (stays in RAM across release() / rehydrate())
{
  const store = new MemorySessionStore();
  try {
    const { session } = await createAgentSession({ sessionStore: store });
    try {
      await session.prompt("Inspect src/index.ts");
    } finally {
      await session.dispose();
    }
  } finally {
    await store.close();
  }
}

// 3. Disk-spilling memory store (spills released history under <agentDir>/released-history/)
{
  const store = await resolveSessionStore(process.cwd(), {
    agentDir: getAgentDir(),
    sessionStore: { kind: "memory" },
  });
  try {
    const { session } = await createAgentSession({ sessionStore: store });
    try {
      await session.prompt("Analyze build logs");
    } finally {
      await session.dispose();
    }
  } finally {
    await store.close();
  }
}
```

### PostgreSQL 16+

Install the optional adapter alongside `@bastani/atomic`:

```bash
npm install @bastani/atomic-storage-postgres @bastani/atomic
```

Before connecting from an SDK host:

- **PostgreSQL version:** Atomic needs **PostgreSQL 16 or newer**.
- **Table prefix rules:** On PostgreSQL, `prefix` must be **lowercase** and at most **24 characters** (`POSTGRES_MAX_STORAGE_PREFIX_LENGTH`). Uppercase or oversized prefixes fail with `StoragePrefixError`.
- **Owner-role migrations:** Run `atomic storage migrate` once as the database owner role before connecting with a least-privilege runtime role. See [Set up the database](/storage/postgres#set-up-the-database).

**Option A — Caller-owned `openPostgresDatabase()` (recommended for SDK hosts sharing one pool):**

Pass a username-only URL (embedded passwords are rejected with `credential-in-url`). Supply `password` as a string or an async callback invoked per new connection for secret rotation, or use cloud IAM with `auth: "azure-entra" | "aws-iam" | "gcp-iam"` (omitting `password` — passing both fails with `conflicting-token`).

```typescript
import { readFile } from "node:fs/promises";
import { createAgentSession } from "@bastani/atomic";
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

// Password auth with rotated secret file
const database = await openPostgresDatabase({
  url: "postgresql://atomic_runtime@db.example.com:5432/atomic",
  password: async () => (await readFile("/run/secrets/postgres-password", "utf8")).trim(),
});
try {
  const { session } = await createAgentSession({
    sessionStore: { kind: "database", database, prefix: "app_" },
  });
  try {
    await session.prompt("Summarize open pull requests");
  } finally {
    await session.dispose();
  }
} finally {
  await database.close();
}

// Cloud IAM auth (install @azure/identity, @aws-sdk/rds-signer, or google-auth-library)
const iamDatabase = await openPostgresDatabase({
  url: "postgresql://atomic-hosts@atomic.postgres.database.azure.com/atomic?sslmode=verify-full",
  auth: "azure-entra", // or "aws-iam" | "gcp-iam"
});
try {
  const { session } = await createAgentSession({
    sessionStore: { kind: "database", database: iamDatabase, prefix: "app_" },
  });
  try {
    await session.prompt("Verify staging migrations");
  } finally {
    await session.dispose();
  }
} finally {
  await iamDatabase.close();
}
```

See [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) for `maxConnections`, `statementTimeoutMs`, `idleTimeoutMs`, `listenUrl`, `schema`, `proxy`, `socket`, `sdkSearchPaths`, TLS, and cloud IAM role setup.

**Option B — Adapter selection `{ kind: "adapter", module: POSTGRES_ADAPTER_PACKAGE, ... }`:**

Use `{ kind: "adapter" }` when you want Atomic to open and close the adapter per session, or to reuse the same selection shape as `settings.json`. Pass credentials through `secrets` (`{ env }`, `{ file }`, or SDK-only `inMemorySecret(value)` whose value serializes as `[redacted]` and is never passed to child processes).

```typescript
import { createAgentSession, inMemorySecret, POSTGRES_ADAPTER_PACKAGE } from "@bastani/atomic";

const { session } = await createAgentSession({
  sessionStore: {
    kind: "adapter",
    module: POSTGRES_ADAPTER_PACKAGE,
    options: { url: "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    secrets: {
      // Choose one secret source: { env: "PGPASSWORD" }, { file: "postgres-password" }, or inMemorySecret(...)
      password: { env: "PGPASSWORD" },
    },
    prefix: "app_",
  },
});
try {
  await session.prompt("Check database health");
} finally {
  await session.dispose();
}

// SDK-only secret held only in memory (never written to disk or passed to child processes)
const { session: ephemeralSecretSession } = await createAgentSession({
  sessionStore: {
    kind: "adapter",
    module: POSTGRES_ADAPTER_PACKAGE,
    options: { url: "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    secrets: { password: inMemorySecret(process.env.PGPASSWORD!) },
    prefix: "app_",
  },
});
try {
  await ephemeralSecretSession.prompt("Inspect latest error logs");
} finally {
  await ephemeralSecretSession.dispose();
}
```

> **Module resolution for `{ kind: "adapter" }`:** Atomic resolves adapter package names from user-scope packages installed with `atomic install` (`~/.atomic/agent/npm`), paths passed in `DefaultResourceLoader({ additionalExtensionPaths: [packageRoot] })`, or relative to `agentDir` — **not** from your application's local `node_modules`. If your app installed `@bastani/atomic-storage-postgres` only with `npm install`, use **Option A** (`openPostgresDatabase()`), install the package in user scope (`atomic install npm:@bastani/atomic-storage-postgres`), pass its directory via `additionalExtensionPaths`, or pass a resolved file path (`fileURLToPath(import.meta.resolve(POSTGRES_ADAPTER_PACKAGE))`).

> Atomic 0.10.11 removed libSQL and Turso support, including `@bastani/atomic-storage-libsql`, `teamProfileSelection()`, and `LIBSQL_ADAPTER_PACKAGE`. To move sessions off libSQL, see [Moving off libSQL](/storage#moving-off-libsql).

## `createAgentSessionRuntime()` and `SessionManager` with explicit stores

Neither `createAgentSessionRuntime()` nor `createAgentSessionFromServices()` takes `sessionStore` or `storage` directly. Both take a pre-opened `sessionManager: SessionManager`, and every later `newSession()`, `switchSession()`, `fork()`, and `rehydrate()` call inherits the store from `sessionManager.getSessionStore()`.

Use these explicit-store `SessionManager` methods to open, resume, and inspect sessions against any `SessionStore` (`SqlSessionStore`, `JsonlSessionStore`, `MemorySessionStore`, or a store from `resolveSessionStore()`):

```typescript
// Create a new session in `store`
const created = await SessionManager.create(store, cwd);

// Open a specific session by ID
const opened = await SessionManager.open(store, sessionId);

// Resume the most recent session for `cwd` in `store` (or create one if none exists)
const recent = await SessionManager.continueRecent(store, cwd);

// List sessions for one working directory in `store`
const projectSessions = await SessionManager.list(cwd, store);

// List sessions across all working directories in `store`
// Note: pass `store` (or omit the argument for the active resolved store).
// Passing a string path like `process.cwd()` scans that path as a JSONL directory instead.
const allSessions = await SessionManager.listAll(store);
```

### Complete runtime recipe with `services` reuse, `release()`, and `rehydrate()`

Reuse the `services` argument passed to your `CreateAgentSessionRuntimeFactory` so `runtime.rehydrate()` shares the existing `ResourceLoader`, `ModelRuntime`, and `SettingsManager` when the rehydrated session matches `cwd`. Tear down resources in strict reverse order: `runtime.dispose()` → `store.close()` → `database.close()`.

```typescript
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SqlSessionStore,
} from "@bastani/atomic";
import { openNodeSqliteDatabase } from "@bastani/atomic/storage";

const cwd = process.cwd();
const agentDir = getAgentDir();

// Swap openNodeSqliteDatabase() for openPostgresDatabase()
// to run the exact same runtime against PostgreSQL.
const database = await openNodeSqliteDatabase("./runtime-sessions.sqlite");
try {
  const store = await SqlSessionStore.open(database, { prefix: "app_" });
  try {
    const sessionManager = await SessionManager.continueRecent(store, cwd);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({
      cwd: targetCwd,
      agentDir: targetAgentDir,
      sessionManager: targetSessionManager,
      sessionStartEvent,
      services: incomingServices,
    }) => {
      const services =
        incomingServices ??
        (await createAgentSessionServices({ cwd: targetCwd, agentDir: targetAgentDir }));
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager: targetSessionManager,
          sessionStartEvent,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager,
    });
    try {
      await runtime.session.prompt("Inspect the failing integration test");

      // Free memory while idle, then restore on demand
      const released = await runtime.session.release();
      const live = await runtime.rehydrate(released.sessionId);
      await live.prompt("Here is the latest CI log; continue from where you stopped.");
      await live.release();
    } finally {
      await runtime.dispose();
    }
  } finally {
    await store.close();
  }
} finally {
  await database.close();
}
```

### Store ownership and teardown rules

- **Strict close order:** Always close in order `await runtime.dispose()` (or `await session.dispose()`) → `await store.close()` → `await database.close()`.
- **`SqlSessionStore.close()` semantics:** Closing a `SqlSessionStore` leaves the underlying caller-owned `SqliteDatabase` open so other stores can continue using it, and calling `store.close()` a second time throws `StoreClosedError`. (Stores opened by `StorageProvider` wrap `close()` idempotently and close provider-owned databases when the last store closes.)
- **Avoid implicit store ownership with `SessionManager.create(cwd)`:** Calling `SessionManager.create(cwd)` or `SessionManager.continueRecent(cwd)` without a `SessionStore` resolves and opens an internal store on your behalf, and neither `createAgentSession()` nor `createAgentSessionRuntime()` closes that internally opened store on `dispose()`. In long-lived SDK hosts, always open the `SessionStore` explicitly (or pass `sessionStore`/`storage` directly to `createAgentSession()`) so no store handles or worker threads leak.
- **Await every write:** Await every `SessionManager` mutation (`appendMessage`, `appendCustomEntry`, `appendSessionInfo`, etc.) — there is no `flush()`. See [`SessionManager` API](/session-format#sessionmanager-api).

## `resolveSessionStore()`, `StorageProvider`, and precedence

### `resolveSessionStore(cwd, options?)`

`resolveSessionStore(cwd, options?: SessionStorageOptions)` resolves storage from your options, process environment, settings, or default SQLite and returns an open `SessionStore`. You own the returned store and must call `await store.close()` when finished.

| `SessionStorageOptions` field | Type | Purpose |
| --- | --- | --- |
| `agentDir` | `string` | Override the agent directory (default `getAgentDir()`). |
| `settings` | `Settings` | Pre-loaded settings object (skips reading `settings.json`). |
| `sessionStore` | `SessionStore \| StorageSelection` | Explicit store instance (returned as-is) or tagged selection object. |
| `noSession` | `boolean` | Open a disk-spilling in-memory store (`{ kind: "memory" }`). |
| `sessionDir` | `string` | Open a flat JSONL store (`exactDirectory: true`) at this directory. |
| `sessionStorePath` | `string` | Open a local SQLite database at this file path. |
| `sessionPrefix` | `string` | Optional table prefix used with `sessionStorePath`. |

### `StorageProvider`

Use `new StorageProvider()` from `@bastani/atomic/storage` when you want programmatic pool sharing across selections without reading `settings.json`:

```typescript
import { getAgentDir } from "@bastani/atomic";
import { StorageProvider } from "@bastani/atomic/storage";

const provider = new StorageProvider();
const store = await provider.openSessionStore(
  { kind: "sqlite", path: "./shared.sqlite", prefix: "worker_" },
  { agentDir: getAgentDir(), domain: "sessions" },
);
try {
  // Use `store` with SessionManager.create(store, cwd) or createAgentSession({ sessionStore: store })
} finally {
  await store.close(); // Idempotent; closes the shared database when the last store closes
}
```

- Matching selections on `StorageProvider` share one opened database handle and close it when the last store closes.
- Caller-owned `{ kind: "database", database }` handles are never closed by `StorageProvider`.
- Opening `{ kind: "memory" }` through `StorageProvider` enables `<agentDir>/released-history/` spilling on `releaseSession()`.

### `sessionStore` vs. `storage` precedence

When `createAgentSession()` chooses a session store, the first source set wins:

1. `sessionManager` (caller-owned `SessionManager`).
2. `sessionStore` (either a `SessionStore` instance or a tagged `StorageSelection`: `{ kind: "sqlite", path, prefix? }`, `{ kind: "jsonl", dir }`, `{ kind: "memory" }`, `{ kind: "database", database, prefix? }`, or `{ kind: "adapter", module, options?, secrets?, prefix? }`).
3. `storage` (`settings.json` shape: `{ path, prefix? }`, `{ database, prefix? }`, `{ memory: true }`, or `{ adapter, options?, secrets?, prefix? }`. Does not accept `{ dir }`; use `sessionStore: { kind: "jsonl", dir }` for JSONL).
4. Process overrides (`ATOMIC_SESSIONS_STORAGE`, `ATOMIC_STORAGE`, `--storage`, `--storage-file`; see [Selecting storage per process](/storage#selecting-storage-per-process)).
5. Settings (`sessions.storage`, then top-level `storage`).
6. Default local SQLite (`~/.atomic/workflows/journal.sqlite`).

A configured persistent store never silently falls back to memory when it fails to open.

## Handling `StorageError` and `Session*Error`

Branch on exported guards and error classes rather than parsing error messages:

```typescript
import {
  isRetryableStorageError,
  isStorageConfigError,
  isStorageTransientError,
  SessionAlreadyOpenError,
  SessionConflictError,
  SessionNotFoundError,
} from "@bastani/atomic";

async function runWithStorageHandling(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (isStorageConfigError(error)) {
      // Invalid option, flag, env var, prefix, or missing database privilege — do not retry.
      console.error(`Fix ${error.source} field ${error.field}: ${error.reason}`, error.hint ?? "");
      throw error;
    }

    if (isStorageTransientError(error)) {
      // Temporary server, network, proxy, or lock failure.
      if (error.outcome === "not-applied") {
        // Nothing was written — safe to retry after backoff.
        console.warn(`Transient ${error.code} after ${error.attempts} attempts; retrying`);
      } else {
        // outcome === "unknown" — the write may have committed; read state back before retrying.
        console.warn(`Ambiguous ${error.code} (${error.hop ?? "database"}); inspect state before retry`);
      }
      throw error;
    }

    if (isRetryableStorageError(error)) {
      // Walks up to 8 cause levels (catches StorageWriteLockTimeoutError and retryable SessionSpillError).
      console.warn("Retryable storage failure:", error);
      throw error;
    }

    if (error instanceof SessionAlreadyOpenError) {
      // Another live process holds this session claim (CLI exits with code 75).
      console.error(`Session ${error.sessionId} is open in pid ${error.pid} on ${error.host}`);
      return;
    }

    if (error instanceof SessionConflictError) {
      // Another writer advanced the session sequence — reopen before writing again.
      console.warn(
        `Session ${error.sessionId} advanced from seq ${error.expectedSeq} to ${error.actualSeq}; reopen`,
      );
      throw error;
    }

    if (error instanceof SessionNotFoundError) {
      console.error(`Session ${error.sessionId} does not exist in this store`);
      return;
    }

    throw error;
  }
}
```

For the full list of storage error classes, cross-process `serializeStorageError()` / `rehydrateStorageError()`, and team setup errors, see [Storage errors](/storage#storage-errors) and [Session and storage errors](/sdk/reference#session-and-storage-errors).

## Related docs

- [Operator storage setup](/storage): PostgreSQL roles, TLS, proxies, poolers, migrations, `atomic storage` commands, and custom drivers.
- [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres): PostgreSQL adapter options, cloud IAM, and SQL helpers.
- [SDK overview](/sdk): `createAgentSession()`, workspaces, Intercom policies, and lifecycle hooks.
- [SDK API reference](/sdk/reference): Full options, loaders, run modes, and exports.
- [`SessionManager` API](/session-format#sessionmanager-api): Entry types, tree navigation, and session append methods.
