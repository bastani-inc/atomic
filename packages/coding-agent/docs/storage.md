# SQLite storage API

The SDK exposes an async SQLite API from `@bastani/atomic` and `@bastani/atomic/storage`. Sessions default to the local file `~/.atomic/workflows/journal.sqlite`, with `session_` table prefixes. Workflow runs default to the [workflow journal store](#the-workflow-journal-store) in `~/.atomic/workflows/journal/`, one logical journal that Atomic splits into shard files by itself. Use [storage settings](/settings#sessions) to choose a different file, explicit JSONL sessions, explicit memory, or an adapter module, or [select storage per process](#selecting-storage-per-process) without editing settings. A failed persistent store never falls back to memory.

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

The node adapter creates parent directories and enables WAL, full synchronization, and foreign keys. Its busy timeout defaults to 5000 ms; override it with `openNodeSqliteDatabase(path, { busyTimeoutMs: 1000 })`. Use `:memory:` for an ephemeral database. Pass `{ readOnly: true }` to inspect an existing file without creating it or changing its journal mode.

Transactions from separate `openNodeSqliteDatabase` connections to the same file queue asynchronously within one process; symlink paths refer to the same queue. Separate in-memory databases remain independent. Wrap a caller-owned connection consistently: its transaction queue is shared by wrappers of that connection, not by other connections to its file.

Writers in different processes take a file's write lock in turn, first come, first served. A writer that finds the lock held waits in a queue directory next to the database (`<file>-writers`), and the writer that releases the lock wakes the next one at once. Transactions requested on one connection while it waits or commits share one lock acquisition and one commit. `groupCommitHoldMs` bounds how long one acquisition runs them before other processes get the lock: `openNodeSqliteDatabase(path, { groupCommitHoldMs: 50 })`. It defaults to 100 ms (`DEFAULT_GROUP_COMMIT_HOLD_MS`), must be a finite number of milliseconds of 0 or more, and `0` commits each transaction on its own; an invalid value throws `StorageConfigError` before anything is opened. A transaction gives up with `StorageWriteLockTimeoutError` only when the lock stays held for its whole lock wait while no other connection commits. The lock wait is `lockWaitMs` (default 30000 ms), or a transaction's own `{ lockWaitMs }` option.

`getWriterQueueStats(database)` reports how a handle from `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase` used the write lock over the last 10 seconds: `lockHeldRatio` (the share of that time it held the lock, 0 to 1), `waiters` (writers in any process waiting for the lock now), `p50WaitMs` and `p95WaitMs` (how long its acquisitions waited for the lock), and `commitsPerSecond`. Other handles throw `StorageUnsupportedOperationError`, and a writers' queue directory that cannot be read throws `StorageWriterQueueUnusableError`.

Waiting writers watch separate release notices next to their queue entries. A writer that cannot watch (for example because the Linux limits `fs.inotify.max_user_instances` or `fs.inotify.max_user_watches` are used up) retries every 20 ms instead, within its connection's lock wait. A writer that cannot notify the next one, because it cannot read the queue directory or touch the waiting writer's notice, still commits; the waiting writer then takes the lock at its next check, at most 250 ms later. An entry or notice that cannot be removed stays in its directory. An abandoned entry is ignored; a writer's own entry left behind on leaving can delay other writers until it becomes stale, about two seconds after its last refresh. A writable connection also keeps a record of when it holds the write lock in `<file>-holders`, so a writer that gives up waiting can name the process holding it; when that record cannot be created or written, the writer may name no holder. Transactions keep working through all four, and the connection records each as a `StorageWriterQueueDegradedError`, once per reason: raise the watch limits for the first, make both `<file>-writers` and `<file>-wakes` directories readable and writable for the second, remove abandoned entries by hand or make the directories writable for the third, and make `<file>-holders` readable and writable for the fourth. `getWriterQueueDegradation(database)` returns the recorded errors in the order they first happened, an empty array while the queue is healthy and for in-memory and wrapped handles, and throws `StorageUnsupportedOperationError` for other handles. The connection also emits each as a process warning (`process.on("warning")`), which Atomic's own processes suppress, so an SDK host reads the record instead of relying on the warning. In Atomic's own processes, [debug mode](/development#debugging) writes each recorded degradation to the debug log. A transaction fails with `StorageWriterQueueUnusableError`, a `StorageUnavailableError`, when the queue directories cannot be read or written, or when it has to wait and cannot add its entry.

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

Start a self-hosted sqld with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`). sqld 0.24.33 and earlier can stop taking writes from every client under concurrent writes when it checkpoints its write-ahead log after a commit ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)). Reads keep working, and only a restart clears it. A checkpoint on an interval instead avoids that. When writes stop this way, Atomic prints a warning naming the issue after its writes have gone unanswered three times in a row.

For a self-hosted sqld started with `--enable-namespaces`, add `"namespace": "<name>"` to `options`; the adapter sends it as the `x-namespace` header, so each namespace is its own database with its own token. `namespace` needs a `libsql:`, `https:`, or `http:` URL. SDK callers can also pass extra request `headers` to `openLibsqlDatabase`; their values are redacted from errors.

Save the token with `turso db tokens create <db> > turso-token` and keep it readable only by you (`chmod 600`); a trailing newline is ignored. A relative `file` resolves against Atomic home, normally `~/.atomic`. Use `{ "env": "TURSO_TOKEN" }` instead to read it from an environment variable. For a local database file, use a `file:` URL such as `file:/home/me/shared.sqlite` and omit `secrets`. Every machine that uses the same `storage` block shares the same sessions, workflow runs, and Intercom routing; add a `prefix` to keep projects or teams apart. See [Sharing storage across hosts](#sharing-storage-across-hosts).

A process that stops for a while in the middle of a write, for example one paused by a signal, starved of CPU, or on a laptop that slept, can find on resuming that the server expired its idle stream or rolled back its transaction; a server that is restarting refuses connections for a moment. A request the server leaves unanswered for 30 seconds is abandoned and reported the same way, with `outcome: "unknown"`. The adapter reports these as `StorageTransientError`, and a statement, a batch, or a workflow journal or session write that they ended before it wrote anything runs again, up to five times over about four seconds. A write whose connection broke after the server may have applied it is never sent again: it fails with `StorageTransientError` and `outcome: "unknown"`. Workflow runs that still fail this way can be continued with `/workflow resume`.

Like any [adapter](#selecting-an-adapter), it runs with Atomic's privileges. To use a different driver, adapt it with [Bring your own driver](#bring-your-own-driver).

SDK callers can import `openLibsqlDatabase` from `@bastani/atomic-storage-libsql` directly. The package ships plain ESM JavaScript and TypeScript declarations, so supported Node versions need no TypeScript loader.

### Joining a machine to a shared database

To share workflow runs and Intercom with a team while your sessions stay on your machine, use `atomic team join` instead: it runs the same checks and token handling, also pins `sessions.storage` to the local store, and restarts the Intercom broker. See [Team and CI setup](/guides/team-setup).

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
3. stores the token in a new `~/.atomic/agent/storage-token.<id>` file (in the agent directory under `ATOMIC_CODING_AGENT_DIR`), readable only by you (mode 600). When the current selection already references such a file holding the same token, that file is kept and reused, so joining again leaves settings unchanged. Your input token file and tokens used by previous selections are left as they are;
4. writes only the top-level `storage` key of the global settings, `~/.atomic/agent/settings.json`, with the adapter, the URL, the token file, and the prefix. Every other setting keeps its value;
5. lists the environment variables and settings that take precedence over the new selection, and says whether the running Intercom broker still uses its previous one.

Nothing is written when the token is empty or the connection fails. If saving settings fails, the new token file is removed and the previous token remains untouched. Previous token files are kept after a successful join too, so already-running sessions can continue using them; remove them only after those sessions stop and no settings reference them. When the adapter is not installed, the command prints the `atomic install` command to run first. An absolute `file:` URL, such as `file:///home/me/shared.sqlite`, needs no `--token-file`; relative file URLs are refused so another working directory cannot select a different database. The `libsql://`, `https://`, and `wss://` schemes are accepted. A URL that contains the token itself, as a user name, a password, or an `authToken` parameter, is refused: pass the token with `--token-file` so it stays out of settings and output.

After storage is saved, a problem reading project settings only affects the final override report: the command warns you and still exits successfully. Fix the reported settings error, then run `atomic storage status` to inspect the effective selection.

The running Intercom broker keeps the selection it started with. `atomic intercom restart` replaces it: connected sessions reconnect within a few seconds and start a broker that reads the new selection. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

### Checking the selected storage

`atomic storage status` shows, for sessions, workflow runs, and Intercom:

- the selected storage and where the selection comes from: an environment variable, project settings, global settings (`storage`, `sessions.storage`, or `workflows.journal`), or the default. Selections that are set but outranked are listed as `overrides`. See [Selecting storage per process](#selecting-storage-per-process) for the order;
- whether the adapter loads, and from which installed package;
- whether the database answers a `SELECT 1`. Local SQLite files, including adapter `file:` URLs, are checked through a read-only SQLite connection instead of an adapter hook that could create the file. Missing files are reported without creating them; no journal mode or table is changed. Relative adapter `file:` URLs are not probed: use an absolute URL to identify the file unambiguously;
- for Intercom, whether a broker started now would route across machines, and how many brokers are live in the shared database;
- whether an Intercom broker is running, how many sessions it serves, whether it uses the current selection, and its multi-node routing state.

It also notes project settings that are not applied because the project is not trusted, and a project `storage` setting, which Intercom never uses. Run it in the project directory to see that project's selection. `--json` prints the same report as JSON. The command reports settings load errors instead of silently checking defaults, and exits 1 when settings cannot load, a selection is invalid, an adapter cannot load, or a database does not answer. Adapter loading, database operations, and connection cleanup each have a 15-second wait limit, so a stalled close cannot leave the command waiting indefinitely.

When the shared `storage` selection (global settings, `--storage`, or `ATOMIC_STORAGE`) names an adapter that the running Atomic cannot load, interactive and print sessions warn at startup, naming the adapter and the cause. The Intercom broker would otherwise leave multi-node routing off with only a line in its log.

## The workflow journal store

With no journal selected, workflow runs go to the journal store in `~/.atomic/workflows/journal/` (under the agent directory's parent when `ATOMIC_CODING_AGENT_DIR` is set). It is one logical journal: a small catalog, `catalog.sqlite`, and SQLite shard files, `shard-0001.sqlite` and up. You never choose or create these files. `{}` as `workflows.journal` or `ATOMIC_WORKFLOWS_JOURNAL` also selects the store.

- Each root run, with everything recorded for its child runs and its local workers, lives on one shard, so runs on different shards never wait for each other's write lock.
- A new root goes to a shard with no running root. When every shard has one, Atomic adds a shard, up to 32. Runs never move to another shard on their own. A shard file that is lost stops taking new roots, and its runs fail with `shard-missing` until the file is restored.
- Status, stages, resume, attach, fork, `history://` and the resume picker find any run ID through the catalog, whichever shard holds it.
- Local workers and their coordinator open only their root's shard.

`atomic storage status` shows the store with its shard and adopted journal counts, every shard file, native or adopted, that no longer exists (`shard-missing`) or cannot be opened (`shard-open-failed`), and journals the store skipped. The command exits with status 1 while any shard file is unavailable.

### Adopting existing journal files

Runs recorded in other journal files, such as a file selected earlier with `ATOMIC_WORKFLOW_JOURNAL_PATH`, become visible and resumable from the store once you adopt the file:

```sh
atomic storage adopt ~/campaigns/journal-1/journal.sqlite ~/campaigns/journal-2
```

Each path is a journal `.sqlite` file, or a directory holding `journal.sqlite`. Adoption registers the file in place: nothing is copied, and its runs keep writing to it when resumed. An adopted file takes no new runs. Every path is checked before the first one is registered, and a failed check registers nothing. Adopting a file that is already registered does nothing.

Adoption also follows the journal files that the adopted runs were written to and adopts each one that is still a journal. The store itself adopts `~/.atomic/workflows/journal.sqlite`, the default journal of earlier Atomic versions, the first time it opens, when that file holds workflow runs. Files that cannot be adopted are recorded with the reason and shown by `atomic storage status`. Pass `--no-discover` to register only the given paths.

`atomic storage consolidate` moves finished runs (completed, failed or cancelled) out of adopted files into the store's own shards. It leaves a run where it is when another process holds its lease, when it ran local workers (their pool state stays in its file), or when it uses the table format of Atomic before 0.9.38. Each run moves separately, and the old copy is deleted only after the new shard is checked to hold every event.

If the command is interrupted, run it again to finish or undo the move. A missing shard file is reported as `shard-unavailable`; restore that file before retrying. An interrupted consolidation can also leave a fence that blocks recovery for two minutes. If a run is reported as `conflict` while that fence is fresh, retry after two minutes.

Concurrent consolidation and resume preserve committed checkpoints. A run whose resume takes over during a move is reported as `leased`. If the resume wrote to the new shard, the catalog keeps that shard selected even after the resume releases its lease. When the two copies have conflicting histories, both are kept and the run is reported as `conflict`. The command exits `1` when any run was left because of an error (`shard-unavailable`, `conflict`), and `0` for other skipped runs.

From the SDK, `adoptJournals(directory, paths)` and `consolidateJournalStore(directory)` do the same, and `JournalCatalog.open(directory)` reads the catalog. `defaultJournalStoreDirectory(agentDir)` gives the store's directory.

```ts
import { adoptJournals, defaultJournalStoreDirectory, isJournalAdoptError } from "@bastani/atomic/storage";

try {
  const report = await adoptJournals(defaultJournalStoreDirectory(agentDir), ["/srv/old/journal.sqlite"]);
  console.log(report.adopted, report.discovered);
} catch (error) {
  if (isJournalAdoptError(error)) console.error(error.message, error.hint);
  else throw error;
}
```

Each entry of `report.discovered` names the journal that referenced it and, when it was skipped, the `reason`. `consolidateJournalStore` reports each run as `moved`, with the shard it moved `to`, or `skipped` with a `reason`, and for `conflict` or `shard-unavailable` the typed `error`. When adoption, consolidation or opening the catalog fails and closing a file then fails too, the original typed error is thrown with the close failure as its `cleanupCause`.

A `skipped` result means consolidation did not finish, not that the run stayed in its original file. When another process resumed the destination during a move, the catalog keeps that destination selected. Check the catalog's current location before comparing copies or retrying consolidation.

### Exporting and importing sessions and workflow runs

`atomic storage export <dir>` writes sessions and workflow runs to JSONL files, and `atomic storage import <dir>` restores them. Session storage and the journal stay the working stores; the files are only how sessions and runs travel between machines, for example through a cache or a persisted directory that holds only text.

```sh
atomic storage export <dir> [--sessions] [--workflows] [--run <id>]... [--unfinished] [--limit <n>] [--since <time>]
atomic storage import <dir> [--sessions] [--workflows]
```

#### Layout

```text
<dir>/
  sessions/<sessionId>.jsonl   one session per file
  workflows/<runId>.jsonl      one workflow run per file
```

Both commands cover both kinds by default. `--sessions` or `--workflows` limits them to one kind; give both for both. Import reads only `*.jsonl` files in `<dir>/sessions` and `<dir>/workflows`. It ignores every other file, including files at the top level of `<dir>` and temporary files left by an interrupted export. A missing subdirectory holds nothing to import.

#### Export

Export writes every session and every run by default. These options select what it writes:

- `--run <id>` selects workflow runs by ID. Repeat it for more. An unknown ID fails the export before any file is written.
- `--unfinished` selects workflow runs that are not completed, failed or cancelled.
- `--limit <n>` keeps the newest `n` workflow runs by creation time, and the `n` most recently modified sessions.
- `--since <time>` keeps sessions modified at or after `<time>`, a date such as `2026-11-01` or a date and time such as `2026-11-01T09:30:00Z`.

`--run` and `--unfinished` need workflow runs in the export, and `--since` needs sessions, so combining them with only the other kind is an error. Sessions include every project's sessions and workflow stage sessions.

Each file is written to a temporary file in its directory and renamed into place, so a crash never leaves a partial `.jsonl` file. The same state always produces the same bytes. A file that already holds them is not rewritten, so unchanged sessions and runs produce no diff. Export never deletes files; prune old ones yourself.

A workflow run that `atomic storage consolidate` moves while an export reads it is read again from its new shard. A run that still cannot be exported is reported with its reason, for example a run in the journal format of Atomic before 0.9.38, which you convert by resuming it once.

#### Import

Import checks every file of both kinds before it writes anything. It also compares every session and run with the copy this machine already has. A malformed file, an unknown version, or a session or run that continued differently here fails the import with the file and line, and nothing is written.

- A session or run this machine does not have is added.
- A session whose earlier entries it has gets the file's later entries. A run whose earlier events it has gets the file's later events.
- A session or run it already has in full is left unchanged.

Importing the same files again therefore adds nothing, and a newer export supersedes an older one. Sessions are matched by their ID, as `atomic --import` matches them. Their entries are compared by `id`, `parentId` and `type`. Runs are compared by the event fields listed under [Workflow run files](#workflow-run-files-version-1).

Import takes the write lock of every journal file it writes runs to, and compares the runs again under those locks before it writes anything. If another process changed a run since the first check, for example a resume took its lease, the import fails and nothing is written. It writes sessions after the runs. Session storage has no lock that an import can hold, so each session write checks that the session is still as the import found it. If an import fails after it wrote part of its files, it exits `1` and lists what it imported and what it did not. Run the same import again to finish; it imports only what is missing.

After import, sessions resolve for `--session`, `/resume` and `history://sessions`. Runs resolve by ID for status, resume, attach, fork and `history://workflows`.

Leases, local-worker pool state and worktree snapshot contents of workflow runs are not exported. An imported run has no owner: a run that was running when it was exported is an interrupted run here. The resume picker and `/workflow resume` offer it once it has completed at least one step. Import refuses to add events to a run that a process on this machine renewed the lease of in the last two minutes, because that run may still be running here. Resume treats a run whose working directory differs from the current one as a run from another project, so restore the checkout at the same path.

#### Which storage they use

Both commands follow `ATOMIC_CODING_AGENT_DIR` and the storage selection in effect for the current directory. Sessions come from the session storage a session started here would use: the default database, a session directory, a SQLite file or an adapter. Workflow runs come from the journal store or a journal file selected through `workflows.journal.path`, `ATOMIC_WORKFLOW_JOURNAL_PATH` or a `path` selection.

A kind kept in a shared libSQL or Turso database is refused with a message, because every machine joined to it already reads it. Without `--sessions` or `--workflows`, the commands skip that kind with a note and handle the other one. Sessions kept only in memory are refused the same way.

#### Session files

A session file is a format-4 session, the format JSONL session storage keeps and `atomic --import <file>` reads. Line 1 is the header, and every later line is one entry, in append order:

```json
{"type":"session","version":4,"id":"…","createdAt":"2026-11-12T09:30:00.000Z","cwd":"/repo"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-11-12T09:30:05.000Z","message":{"role":"user","content":"…"}}
```

The file holds every entry, not only the current branch. Tool outputs kept as session blobs and worktree snapshot contents are carried inline as base64, each once, as `/export <file>.jsonl` carries them. Import checks each against its SHA-256.

A file whose header has another version is refused with the version it has and the version this Atomic reads.

#### Workflow run files (version 1)

Each line is one JSON object with a string `type`. Line 1 is the run's header:

```json
{"type":"atomic.workflow-run","version":1,"runId":"…","name":"deploy","cwd":"/repo","createdAt":1794540399185,"status":"running","events":42,"header":{"runId":"…","inputs":{}}}
```

`status` is the run's latest status, `events` is the number of lines that follow, and `header` is the run header recorded when the run was created. Every later line is one journal event, in sequence order:

```json
{"type":"CheckpointRecorded","seq":2,"epoch":1,"key":"[\"CheckpointRecorded\",\"tool\",\"build\"]","at":1794540401653,"payload":{"kind":"tool","output":"…"}}
```

A file of a newer version is refused with the version it has and the version this Atomic reads.

#### What a tool may rewrite

A tool may change string values, such as replacing secrets with `***`. Import does not checksum string contents, so a redacted file imports as the session or run it came from. Keep every line a JSON object, and do not add, remove or reorder lines or fields.

In session files, leave these unchanged:

- Header: `type`, `version`, `id` and `createdAt`. `cwd` decides which project the session belongs to.
- Entries: `id`, `parentId` and `type`. Import compares them with the copy this machine already has.
- `base64` values and `blobs` objects. Each is checked against its hash, and a changed one fails the import. A redacted secret inside them is base64-encoded, so a plain text replacement does not match it; leave those secrets in place or do not export the session.

In workflow run files, import checks these fields exactly:

- Header: `type`, `version`, `runId` (also `header.runId`), `createdAt` and `events`. `name` names the workflow that resume runs, and `cwd` and `status` decide where and whether it resumes, so leave them unchanged too.
- Events: `type` (a known event type), `seq` (1, 2, 3, … without gaps), `epoch`, `key` (unique within the run) and `at`. Import compares these with the copy this machine already has to tell an older export, a newer export and a run that continued differently apart. A `StatusChanged` event must keep a string `payload.status`.

Strings inside `payload` and the header's `header` object may change.

#### Persisting sessions and workflow runs between machines

On a CI runner that restores a directory at the start of a job and saves it at the end:

```sh
# Start of the job, after restoring $STATE_DIR
mkdir -p "$STATE_DIR" && atomic storage import "$STATE_DIR"

# ... run Atomic ...

# End of the job, before saving $STATE_DIR
atomic storage export "$STATE_DIR"
```

To carry only runs that can still be resumed, export with `--unfinished`. An interrupted run imported this way resumes with `/workflow resume <runId>` in the next job. A session imported this way continues with `atomic --session <id>`. Add `--since` or `--limit` to keep the saved directory small.

### When to select a journal

Select a journal file only to isolate runs, for example in tests or a sandbox: `workflows.journal.path`, `ATOMIC_WORKFLOW_JOURNAL_PATH`, `RunOpts.journal` and `createAgentSession({ journal })` keep working as one file. You do not need separate journals for performance: the store already keeps concurrent roots apart. A shared libSQL or Turso database stays one selection; the adapter scales it.

A journal selection does not move sessions. Sessions, including workflow stage sessions, follow `sessions.storage` or the shared `storage`. Set one of those to the same file if you want sessions and runs stored together.

`admission.userLimits` counts across the runs of one database, so it needs an explicit journal file: set `workflows.journal.path` and use that path as `userDatabase`.

## Bring your own driver

Atomic does not bundle remote database drivers. Install your chosen SQLite-compatible driver and turn it into a `SqliteDatabase` with `createSqliteDatabase` from `@bastani/atomic/storage`. You supply the driver calls:

- `descriptor`: the diagnostic `{ adapter, location }`. The facade passes `location` through `redact`.
- `execute(sql, params)`: runs one statement with positional parameters and returns `{ columns, rows, changes }`, where each row lists its values in column order. Return integers as `bigint` to keep large values exact.
- `executeMultiple(sql)`: runs zero or more statements that take no parameters.
- `beginTransaction()`: begins a write transaction and returns its own `execute` and `executeMultiple`, plus `commit()`, `rollback()`, and an optional `close()` that releases it afterward.
- `close()`: releases the connection.
- `batch(statements)`, optional: runs `{ sql, params }` statements in order in one write transaction, sent as one request, and returns each statement's result; all of them commit or none do. Provide it only when your driver sends the whole batch at once. The facade then offers `SqliteDatabase.batch`, and workflow journals write a batch of events with one request instead of one per statement.
- `redact(text)`, optional: removes credentials from diagnostic text. `redactSecrets(secrets)` builds one that also removes each secret's URI-encoded and decoded forms, longest first.
- `transientFailure(failure)`, optional: recognizes a failure your driver threw as one that passes, from the failure's own fields (never its message), and returns `{ code, outcome }`. `code` is one of the `StorageTransientError` codes below; `outcome` is `"not-applied"` when the failed request cannot have changed the database and `"unknown"` when the connection broke after the server may have applied it. The facade calls it with the unredacted failure.

Driver calls may return values or promises. The returned facade follows the rules described above: it queues operations in call order and keeps them outside active transactions, snapshots binary parameters when a call is made, rejects NUL text with `StorageInvalidTextError` before SQL runs, returns safe-range integers as numbers and blobs as `Uint8Array` copies, expires transaction handles when their callback settles, and closes the driver once after draining accepted work. A failed driver call rejects with `StorageUnavailableError`, whose `cause` is the driver error with credentials redacted. A failed rollback rejects with `StorageRollbackError`, and callback failures are preserved. Do not fall back to memory after an opening failure.

When `transientFailure` recognizes a failure, the call rejects with `StorageTransientError` instead. A statement or batch that such a failure ended before it wrote anything runs again after 250 ms, then after waits that double, each varying by up to a fifth, up to `STORAGE_TRANSIENT_RETRY_ATTEMPTS` (5) runs in all. A failure inside an open transaction ends that transaction uncommitted, so the transaction counts as not applied whatever the request; only a commit, a batch, or a statement outside a transaction can be `"unknown"`, and such a call never runs again. A transaction runs again, callback included, only when you pass `{ retryTransientFailures: true }`: set it only for callbacks that do nothing but use the transaction handle. It runs again when the callback fails after a transient failure, or when the commit itself fails without having written anything; once the callback has returned, a failure the callback caught no longer counts, so a commit that may have applied, or that failed for a reason the driver does not recognize, never runs again. A value that is not a boolean rejects with `StorageConfigError` (field `retryTransientFailures`) before anything runs. Closing the database stops the waits and rejects with the last failure. The first failure a database runs a call again after is emitted once as a process warning.

For a local file that several processes share, switch it to the write-ahead log with `switchToWriteAheadLog(exec, busyTimeoutMs)` from `@bastani/atomic/storage`, passing a call that runs SQL on the database, such as `(sql) => database.exec(sql)`, and the connection's busy timeout. SQLite does not wait for another connection's lock while it changes a file's journal mode, so a plain `PRAGMA journal_mode = WAL` fails at once with `SQLITE_BUSY` while another process writes the file or switches it at the same moment. The helper retries `SQLITE_BUSY` until `busyTimeoutMs` has passed, as other statements wait. It also retries `SQLITE_IOERR_TRUNCATE` for at most 5 seconds or `busyTimeoutMs`, whichever is shorter. This can occur on Windows just after another process using the database exits. Other failures are thrown immediately, and a zero busy timeout disables both waits.

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
	// Scan each key/value once, including malformed URLs, without retrying a growing suffix at every '?'.
	for (let index = 0; index < url.length; index++) {
		if (url[index] !== "?" && url[index] !== "&") continue;
		const start = ++index;
		while (index < url.length && !"?&=#".includes(url[index]!)) index++;
		if (url[index] === "=") {
			const valueStart = ++index;
			while (index < url.length && url[index] !== "&" && url[index] !== "#") index++;
			const token = new URLSearchParams(url.slice(start, index)).get("authToken");
			if (token !== null) secrets.push(url.slice(valueStart, index), token);
		}
		index--;
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

Select it with `sessions.storage: { "adapter": "./storage/libsql-adapter.ts" }`, `workflows.journal`, or shared top-level `storage` in [settings](/settings#workflow-storage). SDK sessions accept `sessionStore: { kind: "adapter", module, options, secrets, prefix }`; workflow runs accept `journal: { adapter, options, secrets, prefix }`. Relative module paths resolve from the agent directory, normally `~/.atomic/agent`; absolute module paths also work. A package name selects an adapter from an [Atomic package](#adapters-from-atomic-packages) that the host loaded or that is installed, or otherwise resolves from the agent directory. Project settings follow the same trust boundary as project extensions. A module executes with Atomic's privileges.

Adapter modules import `@bastani/atomic/storage` and `@bastani/atomic` from the running Atomic, in the npm package and the standalone binary alike, exactly as extensions do. This covers the adapter's entry file and the ES module and TypeScript files it imports by relative path, including `.mjs` files and `.js` files in a `"type": "module"` package. CommonJS files other than the entry file, such as a `.cjs` file or a `.js` file outside a `"type": "module"` package, resolve these specifiers from `node_modules` instead. Import the module in an ES module file and pass it to them. Adapters need no installed or linked copy of Atomic, and Atomic recognizes the storage errors they throw. List `@bastani/atomic` in an adapter package's `peerDependencies`, not its `dependencies`.

When Atomic loads an adapter to open a workflow journal, the adapter's files can also import `@bastani/atomic/workflows` and get the running Atomic's workflows module. An `openRunJournal` hook can build on `SqlRunJournal`, and errors such as `StaleLeaseError` pass Atomic's `instanceof` checks. This holds when the same adapter module also serves sessions, for example through `sessions.storage` and `workflows.journal`. Adapters loaded only for sessions or Intercom do not get this module.

`options` is an object of SQLite scalar values or booleans. In JSON settings use strings, numbers, booleans, or null. `secrets` maps option names to `{ env }` or `{ file }`, and resolved values override same-named options. A `{ file }` secret is read as written, except that one trailing line ending (`\n` or `\r\n`) is removed, so a token saved with `turso db tokens create <db> > token` works as is. Other whitespace is kept. Keep credentials out of `options` and database descriptors. `context` contains `agentDir`, `domain: "sessions" | "journal" | "intercom"`, and an optional `signal`. Intercom brokers open the top-level `storage` selection with `domain: "intercom"` through `openDatabase`.

A SQLite adapter implements `openDatabase(options, context): Promise<SqliteDatabase>`. Atomic applies its domain schema and optional table prefix. A full adapter can instead implement `openSessionStore(options, context, storage)` or `openRunJournal(options, context, storage)`; the domain hook takes priority over `openDatabase`. The typed third argument is `{ readonly prefix?: string }`. Domain adapters must honor this prefix to isolate selected stores. A missing domain/database hook raises `StorageConfigError` with reason `"adapter-domain-unsupported"`. Load failures and invalid module contracts raise `StorageAdapterLoadError`; driver opening failures raise `StorageUnavailableError`. None selects memory as a fallback.

The exported `StorageProvider` can open either domain explicitly. Construct it with `{ memory: (descriptor) => new MemoryRunJournal(descriptor), sql: SqlRunJournal.open }` from `@bastani/atomic/workflows`, then call `openSessionStore(selection, context)` or `openRunJournal(selection, context)`. Add `hostModules: { "@bastani/atomic/workflows": workflows }` to give journal adapters your copy of the workflows module; `loadStorageAdapter(module, context, hostModules)` accepts the same map. For sessions alone, `new StorageProvider()` needs no journal factories. `StorageSelection` uses `kind: "memory"`, `"jsonl"` with `dir` for sessions only, `"sqlite"` with `path`, `"database"` with a caller-owned facade, or `"adapter"` with `module`, optional options/secrets/prefix.

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

The package name selects the package's first listed adapter. When a package lists several, select one with `<package>/<name>`, where `<name>` is the adapter file's name without its extension, for example `@example/atomic-libsql/libsql-adapter`.

An application that embeds Atomic can select an adapter from its own package the same way, without installing it. Pass the package directory as an extension path, with `--extension <dir>` on the command line or `additionalExtensionPaths: [packageRoot]` on the SDK's `DefaultResourceLoader`, and select `"adapter": "@example/app"` or `"@example/app/<name>"` in settings, `--storage`, `--storage-file`, or the [storage variables](#selecting-storage-per-process). The selection then keeps working when the application is reinstalled in another location. Only package directories the process was given to load as code count. Construct the loader before opening any storage that names the package.

Atomic looks up a package name in this order:

1. Package directories the process was given as extension paths, in the order given, and those of the Atomic process that started it.
2. Packages in your effective global settings, including legacy `~/.pi/agent/settings.json` settings where applicable. An explicit agent directory does not inherit packages from another home. `atomic install` writes user settings without `-l`; project packages are not searched.
3. The agent directory, which resolves the name as a module specifier, as before.

Processes that Atomic starts, such as local workflow workers, child workflow processes, and the Intercom broker, receive the adapter modules resolved from the host's packages in the `ATOMIC_HOST_STORAGE_ADAPTERS` variable. They open the same storage by the same name without loading the host's package. The variable holds absolute module paths, so like a storage variable that names a module, it should only come from a process you trust. `atomic storage status` shows the resolved module (`from <path>`) when it runs in such a process. Run directly from a shell, it does not load the host's package, so it can only resolve the name from settings packages or the agent directory.

## Selecting storage per process

A host that starts Atomic processes, for example a supervisor that launches `atomic --mode rpc` children, can select storage for those processes alone. Each option holds the same JSON selection the settings accept, including `adapter`, `options`, `secrets`, and `prefix`:

| Option | Applies to | Same form as |
|---|---|---|
| `--storage '<json>'` | Sessions and workflow runs | Shared `storage` setting |
| `--storage-file <path>` | Sessions and workflow runs; reads the JSON from a file | Shared `storage` setting |
| `ATOMIC_STORAGE` | Sessions and workflow runs | Shared `storage` setting |
| `ATOMIC_SESSIONS_STORAGE` | Sessions only; also accepts `{ "dir": "..." }` | `sessions.storage` |
| `ATOMIC_WORKFLOWS_JOURNAL` | Workflow runs only | `workflows.journal` |
| `ATOMIC_PROFILE=ci` with `ATOMIC_TEAM_URL` and `ATOMIC_TEAM_TOKEN` or `ATOMIC_TEAM_TOKEN_FILE` (and optionally `ATOMIC_TEAM_PREFIX`) | Sessions, workflow runs, and Intercom on the team database | A `team join` selection, without the local sessions pin |

```bash
ATOMIC_STORAGE='{"adapter":"@example/atomic-sqlite","options":{"url":"libsql://team.example"},"secrets":{"authToken":{"env":"TEAM_DB_TOKEN"}},"prefix":"svc_"}' \
  atomic --mode rpc

atomic --mode rpc --storage-file /etc/atomic/storage.json
```

An adapter selected by package name can come from a package the host passes with `--extension <dir>` (see [Adapters from Atomic packages](#adapters-from-atomic-packages)), so the selection holds no absolute module path.

Nothing is written to settings. A process started without these options keeps using its settings, so an interactive `atomic` and an RPC child started with `ATOMIC_STORAGE` in the same account each keep their own sessions and workflow runs, and `/resume` in each lists only its own store. `--storage` and `--storage-file` cannot be combined. The interactive CLI passes its `--storage` selection to its background engine process. Other processes that Atomic starts inherit the environment variables but not the flag.

The Intercom broker an Atomic process starts uses the same selection for multi-node routing: `--storage`, `--storage-file`, `ATOMIC_STORAGE`, or `ATOMIC_PROFILE=ci` from that process outranks the top-level `storage` setting, and a broker started by a process without them reads settings. One broker serves every session in an agent directory, so it keeps the selection of the process that started it until it exits or `atomic intercom restart` replaces it. Project settings never select the broker's storage.

Precedence for each domain, highest first:

| Sessions | Workflow runs |
|---|---|
| SDK `sessionStore` | SDK `RunOpts.journal` or `createAgentSession({ journal })` |
| SDK `createAgentSession({ storage })` | SDK `createAgentSession({ storage })` |
| `--session-store`, `--no-session`, or `--session-dir` | |
| `--storage` or `--storage-file` | `--storage` or `--storage-file` |
| `ATOMIC_SESSIONS_STORAGE` or `ATOMIC_CODING_AGENT_SESSION_DIR` | `ATOMIC_WORKFLOWS_JOURNAL` or `ATOMIC_WORKFLOW_JOURNAL_PATH` |
| `ATOMIC_STORAGE` | `ATOMIC_STORAGE` |
| `ATOMIC_PROFILE=ci` | `ATOMIC_PROFILE=ci` |
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

`ATOMIC_PROFILE=ci` is checked at the same points. Its selection references the token by variable (`{ "env": "ATOMIC_TEAM_TOKEN" }`) or by the token file's absolute path, so child processes, including the Intercom broker, read it themselves. A team variable without `ATOMIC_PROFILE`, or `ATOMIC_PROFILE=ci` without its URL or token, raises `TeamProfileConfigError` (a `StorageConfigError`) with code `"incomplete-profile"` and every missing variable in `missing`; an unknown profile, a bad URL, an unreadable or empty token file, or an invalid prefix raise it with their own codes. While the profile selects a store, that is unless `--storage` or `ATOMIC_STORAGE` outranks it, startup and `createAgentSession()` fail with `TeamProfileError` code `"adapter-not-installed"` before any store opens when the libSQL adapter cannot be loaded. See [Team and CI setup](/guides/team-setup#ci-and-swarms).

These options come from the process that starts Atomic, so they are not subject to [project trust](/security) the way project settings are. An adapter module runs code with Atomic's privileges: select only modules you trust. Pass credentials through `secrets` rather than `options`. SDK callers can also hold a token in memory with `{ "value": token }`, which `inMemorySecret(token)` and `teamProfileSelection({ token })` create: it serializes as `[redacted]`, is never written anywhere, and a selection from settings, a flag, or an environment variable that contains one raises `StorageConfigError` (`"in-memory-secret-unsupported"` from settings, `"invalid-selection"` from JSON). Local workflow workers cannot reopen such a selection; use `{ "file" }` or `{ "env" }` for pooled runs. Command-line arguments can be visible to other local users, so prefer `--storage-file` or an environment variable when the selection itself is sensitive.

## Sharing storage across hosts

By default, sessions and workflow runs live in a local file that serves one machine. To share them across machines, for example several service replicas or a CI fleet, select the same remote SQLite-compatible database on every host through an [adapter](#selecting-an-adapter), such as the [Turso / libSQL package](#turso-and-libsql). Installing the adapter as an [Atomic package](#adapters-from-atomic-packages) lets every host use the same `storage` block. Give each project or tenant its own `prefix`. Do not put the local SQLite file on a network filesystem; use a database driver instead.

With a shared journal:

- Any host can inspect any run with `status` or `stages` without taking ownership.
- Each run has one executor at a time. A run whose owner is alive cannot be claimed from another host. After its owner crashes and stops renewing its lease for about two minutes, the run appears as `crashed` and any host can resume it. Concurrent resume attempts admit one executor.
- Lease expiry uses the database clock, so clock differences between hosts do not affect ownership.
- A displaced executor cannot save new checkpoints; its writes fail with `StaleLeaseError`.

Selecting the same top-level `storage` on every host, in global settings or with `--storage`, `--storage-file`, or `ATOMIC_STORAGE`, also lets Intercom sessions on different hosts message each other; `sessions.storage` and `workflows.journal` alone do not. Brokers route through the database, so Intercom message bodies are stored there until shortly after they are delivered. See [Running Intercom across machines](/intercom/operations#running-intercom-across-machines).

The database stores sessions, the oversized tool results of agents released while they waited (in `session_blobs` and `session_blob_chunks`, deleted with their session and never touched by snapshot collection; a blob is stored as rows of at most 1 MiB, so a libSQL server's row size limit, 5 MB by default in sqld, never applies to it), workflow checkpoints, the patch and bundle content of [worktree snapshots](/worktree-snapshots) (one `snapshot_blobs` table shared by both, stored once per content hash), and, when Intercom brokers share it, Intercom messages and session routing state. Anyone who can read it can read all of that: treat database access as full read access. `atomic team join` keeps each person's sessions out of it by pinning `sessions.storage` to the local store; see [Team and CI setup](/guides/team-setup#security). A session resumed on another host continues in a matching checkout of its repository or in a fresh worktree restored from its snapshot; see [Resume on any machine](/guides/resume-on-any-machine). To resume a run on another host, that host also needs the same workflow definition; a run's Git checkouts are restored from their snapshots, while artifacts outside any repository are not. Effects that were not checkpointed may run again after a takeover, so make external effects idempotent. Every checkpoint commits before it is reported, so a remote database adds network latency to each durable `ctx.*` step. Backends may also enforce payload limits that raise `StoragePayloadTooLargeError`.

[Local workflow workers](/workflows/operations#local-workflow-workers) work on a shared journal: by default the workers run on the machine that runs the root and open the same database, and the pool keeps its work queue and leases in a SQLite file on that machine, so a pooled run resumes on the machine where it started. A root started with `workers: { placement: "shared" }` keeps its pool in the shared journal instead, runs its children on worker hosts on other machines too, and resumes on any machine; see [Workers on other hosts](/workflows/operations#workers-on-other-hosts).

Scale by running more workflows, not by splitting one: a single run and a single session each have one writer. The built-in journal uses SQLite SQL, so `openDatabase` adapters need a SQLite-compatible driver. For another kind of database, implement `openRunJournal` and `openSessionStore` and validate them with the conformance suites below.

## Storage errors

Use error classes and their fields, not message matching. Configuration and facade errors are exported from `@bastani/atomic/storage`. `@bastani/atomic/workflows` exports the journal contract's error classes.

| Error | Fields and response |
|---|---|
| `StorageConfigError` | `code` `"invalid-config"`; `source`, `field`, `reason` identify an invalid selected option, and `hint`, when present, says what to pass instead. Correct that selection; Atomic does not try a lower-precedence store. |
| `StorageAdapterLoadError` | `module`, `cause`. Check installation and the module's default export. |
| `StorageUnavailableError` | `adapter`, `location`, `cause`. Restore access to the selected store before retrying. |
| `StoragePrefixError` | `prefix`, `reason`. Use a valid non-reserved prefix. |
| `StorageSchemaVersionError` | `domain`, `found`, `supported`. Use a supported database; Atomic does not migrate an unknown schema. |
| `StoreClosedError` / `StorageTransactionClosedError` | The store is closing/closed, or the transaction callback has ended. Open a new store or use the live callback handle. |
| `StorageRollbackError` | `cause`, `rollbackCause`. Do not assume the transaction rolled back. |
| `StorageOutcomeUnknownError` | `domain`, `id`, `key`. A driver cannot confirm the write outcome; inspect the keyed record before retrying. |
| `StoragePayloadTooLargeError` | `limitBytes`, `actualBytes`. Reduce the payload for that backend. |
| `StorageInvalidTextError` | `parameterIndex`, `reason`. Remove NUL from scalar text bindings or encode the value as JSON/binary. |
| `TeamProfileConfigError` | A `StorageConfigError` for an invalid team input; `code` equals `reason`. See [Team setup errors](#team-setup-errors). |
| `TeamProfileError` | A team setup operation failed after its inputs were accepted. See [Team setup errors](#team-setup-errors). |

These storage errors carry a stable `code` and a `hint` with the remedy:

| Class | Code | When | Fields | What to do |
|---|---|---|---|---|
| `StorageWriteLockTimeoutError` (a `StorageUnavailableError`) | `write-lock-timeout` | A node-sqlite transaction waited its whole lock wait while another connection held the write lock and nothing committed. Nothing of the transaction ran. | `adapter`, `location`, `timeoutMs` (the lock wait), `elapsedMs` (how long nothing committed), `phase` (`"queued"` behind older writers, or `"acquiring"`), `holderPid` and `holderHeldMs` when known, `retryable: true`, `cause` (the SQLite busy error, when it tried the lock) | Check the holding process, which may be stopped or starved of CPU, or pass a longer `lockWaitMs`. Retrying later is safe. |
| `StorageUnsupportedOperationError` | `unsupported-operation` | `getWriterQueueStats` or `getWriterQueueDegradation` received a handle that `openNodeSqliteDatabase` or `wrapNodeSqliteDatabase` did not return. | `operation` (`"getWriterQueueStats"` or `"getWriterQueueDegradation"`), `adapter`, `location` | Pass a node-sqlite handle. |
| `StorageWriterQueueDegradedError` | `writer-queue-degraded` | Not thrown: recorded once per reason on the connection (read with `getWriterQueueDegradation`) and emitted once as a process warning. A waiting writer could not watch its release notice (`watch-unavailable`), a writer letting go of the lock could not read the queue or notify the next writer (`wake-failed`), an entry or notice could not be removed on leaving or after abandonment (`stale-ticket-kept`), or the connection could not keep its record of holding the write lock in `<file>-holders`, so a writer that gives up waiting may not name the holder (`holder-record-unavailable`). | `reason` (`"watch-unavailable"`, `"wake-failed"`, `"stale-ticket-kept"`, or `"holder-record-unavailable"`), `adapter`, `location`, `cause`, and a `hint` for the reason | Raise the file-watch limits; make the `<file>-writers`, `<file>-wakes` and `<file>-holders` directories readable and writable; or remove abandoned entries by hand. A live entry left behind can delay the queue until it becomes stale. |
| `StorageWriterQueueUnusableError` (a `StorageUnavailableError`) | `writer-queue-unusable` | A node-sqlite transaction could not read the `<file>-writers` directory, or add, refresh, or read an entry or its release notice. Nothing of the transaction ran. | `adapter`, `location`, `errno` (such as `"EACCES"`) when the cause has one, `cause` | Make the `<file>-writers` and `<file>-wakes` directories readable and writable for every process that writes the database. |
| `StorageTransientError` (a `StorageUnavailableError`) | `stream-expired`, `transaction-timeout`, `connection-refused`, `connection-lost` | A call to a database server failed for a reason that passes: the server expired an idle stream, for example of a process stopped mid-transaction (`stream-expired`); it rolled back a transaction that kept the write lock while another writer waited (`transaction-timeout`); no connection could be made (`connection-refused`); or the connection broke during the request (`connection-lost`). Thrown after the call ran up to five times when it wrote nothing, or at once when its outcome is unknown. | `adapter`, `location`, `outcome` (`"not-applied"`, nothing was written; or `"unknown"`, the write may have been applied), `attempts` (the run that failed), `retryable: true`, `cause` (the driver failure, credentials redacted) | Check that the server is reachable and the process is not stopped or starved of CPU, then retry. With `outcome: "unknown"`, read the write back before retrying one that is not idempotent. |
| `SessionBlobError` | `blobs-unsupported` | The session store has no `putBlob` and `getBlob` (a session directory, or a custom store without them), and an import, fork, branch or `tool-output://` read needs them. Nothing was written. | `sessionId`, `adapter` | Keep the session in a SQLite or libSQL session store, or give the custom store `putBlob` and `getBlob`. |
| `SessionBlobError` | `blob-missing` | A `tool-output://<sha256>` URL names a blob the current session does not hold. A copy, fork or export that finds blobs missing from its source carries on without them and reports this once as a process warning (an `onMissingBlob` function passed to `copySessionBlobs` or `inlineToolOutput` receives it instead). | `sessionId`, `hash` (the first missing one), `missing` (how many, when a copy or export reports it) | The output is gone, for example because the export it came from left it out; run the tool again. |
| `SessionBlobError` | `blob-incomplete` | The store holds a blob's record but lost part of its content. | `sessionId`, `hash`, `bytes` | The store lost part of this output; run the tool again. |
| `SessionBlobError` | `blob-corrupt` | An imported session file carries tool output whose content does not have the SHA-256 it is recorded under. Nothing was written. | `sessionId`, `hash`, `actualHash` | Export the session again from its source. |
| `SessionSpillError` | `spill-read-failed` | A `MemorySessionStore` could not read a released session's history back from its file, under the agent directory's `released-history` directory, on a load, a wake or a listing. `retryable` is `true` for `EMFILE`, `ENFILE`, `EAGAIN`, `EBUSY` and `EINTR`; a listing fails with a retryable one and leaves out a session that met any other. | `directory`, `sessionId`, `bytes`, `errno`, `cause` | Check that the agent directory is readable and the process has file descriptors to spare, then reopen the session. |
| `SessionSpillError` | `spill-missing` | A released session's file is gone, or holds less than was written to it, so its history is lost. Never reported as `SessionNotFoundError`. A listing leaves the session out and records this once for it. | `directory`, `sessionId`, `bytes`, `foundBytes` (when the file still exists), `errno` | Leave the agent directory's `released-history` directory alone while Atomic runs, or keep sessions in a SQLite session store. |
| `SessionSpillError` | `spill-corrupt` | A released session's file has an unexpected length, fails to parse, or does not match the incremental FNV-1a checksum kept in memory, so its history is lost. The checksum detects accidental edits, including same-length valid JSON changes; it is not protection against malicious tampering. A listing leaves the session out and records this once for it. | `directory`, `sessionId`, `bytes`, `foundBytes` (when its size changed), `cause` (the parse failure, when there is one) | Leave the agent directory's `released-history` directory alone while Atomic runs, or keep sessions in a SQLite session store. |
| `SessionSpillError` | `spill-write-failed` | Not thrown: recorded once on the store and emitted once as a process warning (`process.on("warning")`). A released session's history could not be written to its file; it stays in memory and nothing is lost. | `directory`, `sessionId`, `bytes`, `errno`, `cause` | Free space on the agent directory's disk or make it writable; the next release tries again. |
| `SessionSpillError` | `spill-dir-refused` | Not thrown: recorded once, as above. The directory for released sessions' files could not be created under the agent directory; released sessions keep their history in memory, and the store tries again no more than once a minute. | `directory`, `errno` | Make the agent directory writable by this account. |
| `SessionSpillError` | `spill-cleanup-failed` | Not thrown: recorded once, as above. A deleted or replaced session's file, or a closed store's directory, could not be removed. | `directory`, `sessionId` (for one session's file), `errno`, `cause` | Nothing in the store is affected; the process's directory is removed when it exits, or by the next start's sweep once it is gone. |

Each has a guard that also recognizes a copy from another module instance or process: `isStorageConfigError`, `isStorageWriteLockTimeoutError`, `isStorageUnsupportedOperationError`, `isStorageWriterQueueDegradedError`, `isStorageWriterQueueUnusableError`, and `isStorageTransientError` (`STORAGE_TRANSIENT_ERROR_CODES` lists its codes). `isStorageError(error)` matches any storage error on this page, including a rehydrated one, and a copy of one of these coded errors. `findStorageWriteLockTimeoutError(error)` and `isRetryableStorageError(error)` look through up to eight levels of `cause`. To pass a storage error to another process, send `serializeStorageError(error)` as JSON and call `rehydrateStorageError` on the other side: any of the storage errors on this page comes back as the same class with the same message, fields, cause chain, `rollbackCause`, and `cleanupCause`. Only scalar facts travel, so a `StorageSchemaVersionError` whose `found` was a bigint or binary value comes back with `found: null`. A storage error the receiving version does not know becomes a `StorageError` that keeps the original `name`, `code`, and fields.
Each has a guard that also recognizes a copy from another module instance or process: `isStorageConfigError`, `isStorageWriteLockTimeoutError`, `isStorageUnsupportedOperationError`, `isStorageWriterQueueDegradedError`, `isStorageWriterQueueUnusableError`, `isSessionBlobError`, and `isSessionSpillError`. `SESSION_BLOB_ERROR_CODES` lists `SessionBlobError`'s codes, none of which is retryable; `SESSION_SPILL_ERROR_CODES` lists `SessionSpillError`'s. `isStorageError(error)` matches any storage error on this page, including a rehydrated one, and a copy of one of these coded errors. `findStorageWriteLockTimeoutError(error)` and `isRetryableStorageError(error)` look through up to eight levels of `cause`. To pass a storage error to another process, send `serializeStorageError(error)` as JSON and call `rehydrateStorageError` on the other side: any of the storage errors on this page comes back as the same class with the same message, fields, cause chain, `rollbackCause`, and `cleanupCause`. Only scalar facts travel, so a `StorageSchemaVersionError` whose `found` was a bigint or binary value comes back with `found: null`. A storage error the receiving version does not know becomes a `StorageError` that keeps the original `name`, `code`, and fields.

Session operations can raise `SessionNotFoundError` or `SessionExistsError` with `sessionId`; `SessionIdMismatchError` with `requested` and `found`; and `SessionConflictError` with `sessionId`, `expectedSeq`, and `actualSeq`. Keep one writer per session. After a conflict, reopen the session rather than writing from stale state.

`SessionFormatVersionError` identifies `path`, `found`, and `supported`; `SessionInvalidTextError` identifies `field` and `reason`, and `SessionInvalidTimestampError` adds `value`. A JSONL append whose rollback also fails raises `JsonlStoragePoisonedError` with `location`, `cause`, and `rollbackCause`; stop using that store and inspect the file before reopening. These failures never silently select another store.

When a running session cannot save a message, Atomic reports `could not persist the <role> message: <cause>` once and stops that run: it sends no further model request, starts no tool call after the failure, and does not retry, fall back, or compact on top of the unsaved message. `-p` and `--mode json` print the error on stderr as `Extension error (<session>): …` and exit 1; `-p` still prints the answer the run received. An interactive session shows the error and stays open; each later prompt tries to save again. Messages that could not be saved are missing from the session file. A `Session conflict` cause usually means another process wrote to the same session, for example a second run that continued it with `--continue`; reopen the session before writing to it again.

Journal errors include:

| Error | Fields and response |
|---|---|
| `StaleLeaseError` | `code: "stale_lease"`, `runId`, `heldEpoch`, `currentEpoch`, `hint`. Stop writing under stale ownership. `isStaleLeaseError(error)` also recognizes one from another process. |
| `JournalCasConflictError` | `runId`, `expectedSeq`, `actualSeq`. Reload the run before retrying a conflicting operation. |
| `RunNotFoundError` | `runId`. Check the selected journal and ID. |
| `JournalSchemaVersionError` | `domain`, `found`, `supported`. No automatic schema migration. |
| `JournalInvalidTextError` | `field`, `reason`. Identifiers must be well-formed Unicode without NUL. JSON payload text is not restricted this way. |
| `JournalCounterRangeError` | `runId`, `field`, `value`, `reason`. Sequence and epoch counters must remain non-negative safe integers. |
| `JournalMetaCorruptError` | `path`, `rowCount`. Inspect or restore the affected database. |
| `JournalClosedError` | Open another journal before issuing new operations. |

Journal store errors are exported from `@bastani/atomic/storage` with their code unions and guards (`isJournalStoreError`, `isJournalCatalogError`, `isJournalShardUnavailableError`, `isJournalAdoptError`, and `isRetryableJournalStoreError`, which walks the cause chain). Each has a stable `code`, JSON-safe `fields`, a `hint` naming what to do, and `retryable`. All extend `JournalStoreError`, which extends `StorageError`. `serializeJournalStoreError` and `rehydrateJournalStoreError` carry them between processes.

| Error | Code | When | Fields | What to do |
|---|---|---|---|---|
| `JournalCatalogError` | `catalog-unavailable` | The catalog cannot be opened or read | `catalogPath`, `detail` | Make the store directory readable and writable and free disk space |
| | `schema-version` | A newer Atomic wrote the catalog | `found`, `supported` | Upgrade Atomic |
| | `corrupt` | The catalog breaks a consistency rule | `rule` | Move `catalog.sqlite` aside, then adopt every `shard-*.sqlite` file in the store directory again |
| | `write-failed` | A catalog write failed; retryable when another process held the lock | `phase`, `runId`, `detail` | Free disk space or wait for the lock; checkpoints already written stay on their shard |
| | `run-conflict` | `consolidate` found different histories for a run | `runId`, `shardPath` | Compare both preserved copies and check the catalog's current location; a concurrent resume may have kept the run on the destination |
| | `run-moved` | A consolidation moved a run while it was read and its new shard did not continue the history; retryable | `runId`, `shardId`, `shardPath`, `lastSeq` | Read the run again |
| | `run-not-found` | No run with this ID is in this machine's storage | `runId`, `selection`, `localOnly` | With local-only storage, join the machine that ran it with `atomic team join <url> --token-file <path>`, or adopt an older journal file |
| `JournalShardUnavailableError` | `shard-missing` | The file holding a run is gone | `shardId`, `shardPath`, `runId` | Restore the file at that path; its runs stay registered there |
| | `shard-open-failed` | The file cannot be opened; retryable when it was locked | `shardId`, `shardPath`, `detail` | Check permissions and free disk space |
| `JournalAdoptError` | `path-not-found` | The path does not exist | `path` | Pass a journal file or its directory |
| | `not-a-journal` | Not SQLite, no workflow tables, the store's own catalog, or a directory without `journal.sqlite` | `path`, `reason` | Pass a journal file |
| | `schema-version` | The journal's schema is not supported | `found`, `supported` | Adopt it with the Atomic version that wrote it |
| | `run-conflict` | A run in it is already in the store elsewhere, for example a second copy of one journal | `runId`, `existingPath` | Adopt only one copy |

A failed adoption registers nothing. A listing skips a shard that cannot be opened instead of failing; using one of its runs raises `JournalShardUnavailableError`.

Workflow execution can also fail with `JournalOwnershipError` with `runId` and `holderId`, `JournalBackendClosedError`, `JournalOperationAbortedError` with `runId` and optional `cause`, or `JournalExecutionRetiredError` with `runId`. Stop work after losing ownership or cancellation; do not keep using a closed or retired execution. A local database failure does not justify deleting a journal or shard file; restore access to it instead.

Session listings accept an `AbortSignal`. Cancellation rejects with the original `signal.reason`, including a custom reason, rather than wrapping it as a storage failure. Callers can compare the caught value to `signal.reason`. With `controller.abort()`, the reason is the standard `AbortError`.

### Team setup errors

`joinTeam()`, `leaveTeam()`, `getTeamProfile()` (all three return promises), `teamProfileSelection()`, `atomic storage join`, `atomic team`, and the `ATOMIC_PROFILE=ci` startup check throw these classes from `@bastani/atomic/storage`. Branch on `code`; the guards `isTeamProfileError()`, `isTeamProfileTimeoutError()`, and `isTeamProfileConfigError()` also recognize errors by `name` and `code` across processes, and `isRetryableTeamProfileError()` checks an error and its causes, up to eight levels. Each message ends with its `hint`, which is also a field. Messages and fields name variables, flags, and files, never a token.

`TeamProfileConfigError` (a `StorageConfigError`; fields `source` (`"sdk"`, `"cli"`, or `"env"`), `field`, `code`, `reason`, `hint`, optional `path` and `missing`; `retryable: false`). Nothing was changed; fix the named input.

| Code | When |
|---|---|
| `unknown-profile` | `ATOMIC_PROFILE` or the SDK `profile` is not `ci`. |
| `incomplete-profile` | A team variable is set without `ATOMIC_PROFILE`, or `ATOMIC_PROFILE=ci` lacks its URL or token. `missing` lists every variable to set. |
| `missing-url` | No database URL was passed. |
| `unsupported-url` | The URL is not `libsql://`, `https://`, `wss://`, or `file:`. |
| `relative-file-url` | A `file:` URL is relative. |
| `credential-in-url` | The URL contains a user name, password, or `authToken`. |
| `missing-token` | A non-`file:` URL has no token, or `tokenEnv` names an unset variable. |
| `conflicting-token` | More than one token source was passed. |
| `unreadable-token-file` | The token file cannot be read; `path` names it. |
| `relative-token-file` | `ATOMIC_TEAM_TOKEN_FILE` is a relative path, which the processes Atomic starts would resolve against their own working directory. |
| `empty-token` | The token, token file, or `tokenEnv` name is empty. |
| `invalid-prefix` | The prefix does not match the storage prefix rules. |
| `unknown-command`, `unknown-option`, `missing-value`, `unexpected-argument` | `atomic team` was called with arguments it does not take. |

`TeamProfileError` (fields `code`, `subject`, `hint`, optional `detail` and `cause`, and `retryable`):

| Code | When | What to do |
|---|---|---|
| `settings-unreadable` | The settings file cannot be read or parsed; `subject` names it, and `detail` gives the file-system error code or where the JSON breaks, never the file's content. Nothing was changed. | Fix the file, then run again. |
| `adapter-not-installed` | The libSQL adapter cannot be loaded. Nothing was changed. | Run `atomic install npm:@bastani/atomic-storage-libsql`. |
| `connection-failed` | The database refused or failed `SELECT 1`; `retryable: true`. Nothing was changed. | Check the URL, the token, and the network, then retry. |
| `connection-timeout` | The database did not answer within 15 seconds. Thrown as `TeamProfileTimeoutError`, a `TeamProfileError` with `timeoutMs`, `elapsedMs`, and `phase` (`"connect"`); `retryable: true`. Nothing was changed. | Check that the database is reachable from this machine, then retry. |
| `token-write-failed` | The private token file could not be written. Nothing was changed. | Make the agent directory writable. |
| `settings-write-failed` | Settings could not be written, for example because the disk is full; the previous selection and its token are kept. Settings files are replaced whole, so a failed or interrupted write never leaves a partial file. A settings file that cannot be replaced, such as a single file mounted into a container, is written in place instead. | Make the settings file writable or free space. |
| `settings-locked` | Another process held the settings lock; `retryable: true`. Nothing was changed. | Retry in a few seconds; a lock left by a killed process expires after 10 seconds. |
| `broker-restart-failed` | Returned in `broker`, not thrown: settings were saved but the Intercom broker did not restart; `retryable: true`. | Run `atomic intercom restart`. |
| `token-delete-failed` | `leaveTeam` removed the settings but could not delete the token file. | Delete the file yourself. |

`SHARED_STORAGE_JOIN_HINT` holds the command that joins a machine to the team's database, `atomic team join <url> --token-file <path>`, for hints that point there.

To pass a team error between processes, `serializeTeamError(error)` returns its JSON form (`name`, `code`, `message`, `hint`, `fields`, and up to eight levels of `cause`, never a token), and `rehydrateTeamError(json)` turns it back into an instance of the same class, so `instanceof` and the guards still work. A team error in the cause chain, including one created in another realm whose fields have their documented types, is serialized the same way and comes back as its own class with its fields, so `isRetryableTeamProfileError()` gives the same answer on both sides. Causes outside the team error family retain only their name and code, not their original message, which might quote settings or credentials. An unknown `name` becomes a `TeamProfileError` that keeps that `name`, `code`, and `retryable`.

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
