# @bastani/atomic-storage-libsql

A libSQL and [Turso](https://turso.tech) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions and Intercom multi-node routing in one shared database so multiple machines can share state. Install it only when you want remote libSQL storage.

## Install

Choose the installation method that matches how you use the adapter:

- **CLI, `settings.json`, `ATOMIC_STORAGE`, `ATOMIC_PROFILE=ci`, `teamProfileSelection()`, and SDK `{ kind: "adapter" }` selections.** Install the adapter in user scope (without `-l`). Atomic searches user-scope packages, host extension directories, and the agent directory for adapter modules, not an embedding application's `node_modules`:

```bash
atomic install npm:@bastani/atomic-storage-libsql
```

- **Node.js and TypeScript SDK apps (`openLibsqlDatabase()` with `{ kind: "database", database }`).** Install the package directly in your project alongside `@bastani/atomic`:

```bash
npm install @bastani/atomic-storage-libsql
```

## Configure

### Join with the CLI

Create a database token, join the database, restart the Intercom broker, and verify the active selection:

```bash
turso db tokens create <db> > ~/turso-token
chmod 600 ~/turso-token
atomic storage join libsql://<db>.turso.io --token-file ~/turso-token
atomic intercom restart
atomic storage status
```

`atomic storage join` tests the connection with `SELECT 1` before writing anything, saves the token in a mode-`600` file under `~/.atomic/agent/`, and writes the `storage` block in `~/.atomic/agent/settings.json`. To share Intercom across machines while keeping personal sessions local, run `atomic team join <url> --token-file <path>` instead (see [Set up teams and CI](https://docs.bastani.ai/guides/team-setup)). Run `atomic storage migrate` when upgrading schemas on a shared database.

### Configure settings manually

You can also configure `~/.atomic/agent/settings.json` directly:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-libsql",
    "options": { "url": "libsql://<db>.turso.io" },
    "secrets": { "authToken": { "file": "turso-token" } }
  }
}
```

```bash
turso db tokens create <db> > ~/.atomic/turso-token
chmod 600 ~/.atomic/turso-token
```

| Option | Required | Description |
| --- | --- | --- |
| `url` | Yes | A `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or `file:` URL. `atomic storage join` and `atomic team join` accept `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or an absolute `file:` URL (prefer TLS schemes for remote hosts; `http://` and `ws://` work for local or private-network `sqld`). Embedded credentials (`username`, `password`, or an `authToken=` query parameter) are rejected by `join` and `team join` (`credential-in-url`). |
| `authToken` | For remote databases | Database auth token. Pass it through `secrets` (`{ "file": ... }`, `{ "env": ... }`, or `inMemorySecret()` in SDK `{ kind: "adapter" }` selections) so it stays out of `settings.json`. |
| `namespace` | No | A self-hosted `sqld` namespace (`sqld --enable-namespaces`), sent as the `x-namespace` header. Requires a `libsql:`, `https:`, or `http:` URL. |
| `keepAliveMs` | No | How long an idle connection to the server stays open for the next request, in milliseconds. Unset keeps Node.js's default of about 4 seconds. Raise it only for a server that keeps idle connections open longer, such as a self-hosted `sqld`, to skip a new connection and TLS handshake after each pause. Leave it unset for Turso, which closes idle connections after 5 seconds; a longer value makes writes fail when the server drops a connection just as it is reused. Applies to `libsql:`, `https:`, and `http:` URLs, on Node.js and on Bun 1.4.3 or later; `wss:` and `ws:` URLs keep one connection open anyway. |
| `concurrency` | No | On a libSQL server, how many reads one connection runs at the same time: read-only transactions, such as session loads, and single `SELECT` statements. A positive integer; default `20`. Raise it when many agents in one process read at once; writes still run one at a time whatever its value. Atomic opens a main connection and a separate reader connection, and each has this limit. Has no effect on `file:` databases. `0` is refused rather than treated as "no limit". |

Atomic redacts auth tokens from error messages and diagnostics. Add a `prefix` to the `storage` block to isolate projects or teams inside one database. Prefixes must match `[A-Za-z_][A-Za-z0-9_]*` and cannot start with `sqlite_` (case-insensitive); invalid prefixes throw `StoragePrefixError`. See [Storage backends](https://docs.bastani.ai/storage) and [`@bastani/atomic-storage-libsql`](https://docs.bastani.ai/libraries/storage-libsql) for selection precedence, per-process overrides, and additional storage options.

## Concurrency and retries

- **Local `file:` databases:** The adapter enables write-ahead logging (WAL) on first open (creating `-wal` and `-shm` sidecar files) with a 5-second busy timeout, matching Atomic's built-in SQLite stores. A statement waits up to 5 seconds for another process's lock instead of failing immediately with `SQLITE_BUSY`. If another connection commits while a single statement, single-statement `exec`, batch, or transaction start is waiting, the adapter retries it; multi-statement `exec` calls are not retried. Open a local file through only one SQLite library at a time so concurrent readers do not observe stale WAL state.
- **Remote `sqld` servers:** When `sqld` hits a WAL checkpoint, it returns `SQLITE_BUSY` immediately without running the write. The adapter retries single statements, single-statement `exec` calls, batches, and transaction starts with jittered exponential backoff for up to 5 seconds within a 10-second wall-clock ceiling (one 5-second lock timeout plus one 5-second checkpoint window). For self-hosted `sqld`, run with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`).
- **Server transactions:** A transaction on a server sends its statements without waiting for each answer. Its first reads go with its `BEGIN`, and its last writes go with its `COMMIT`, so saving entries to a session takes 2 requests. The commit runs only if every write before it succeeded. If a statement fails while later ones are already on their way, nothing in the transaction commits. If the caller handles a failure before it sends the next statement, the rest of the transaction can still commit, as in SQLite.
- **Idle connections:** Over HTTP, Node.js closes a connection after about 4 seconds without a request, and the next request opens a new one, with a new TLS handshake for `https:`. That suits Turso, which closes idle connections after 5 seconds. Bun keeps an idle connection for at least 8 seconds, so a request after a pause of about 5 seconds could go out on a connection Turso was closing and fail with `ECONNRESET`, its outcome unknown. On Bun 1.4.3 and later, including the `atomic` binary, the adapter therefore closes its connection after the same 4 seconds without an answer, and the next request opens a new one. Requests less than 4 seconds apart, as in an active turn, keep reusing one connection. For a self-hosted `sqld`, which keeps idle connections open, set `keepAliveMs` (for example `60000`) to keep reusing one connection across pauses, on either runtime. A `wss:` URL keeps one WebSocket open instead, renewed about once a minute.
- **Readers:** `openReader()` returns a handle for reads with its own client, for local files and servers. Its reads do not wait behind the main handle's calls. Closing the database also closes its readers.
- **Reads at the same time:** on a server, reads made at once run at the same time, up to `concurrency` per connection: each read-only transaction, and each single `SELECT` made while another is under way, gets a stream of its own. A read still waits for the writes made before it, and a write waits for the reads made before it, so writes keep running one at a time in the order they were made. A local `file:` database runs one call at a time, because its reads run on the calling thread.
- **Throughput:** A libSQL database has one writer at a time, whatever the settings. Keep the database close to the agents, and give each team its own database, because a `prefix` shares its database's writer. For many agents writing at once from many machines, use PostgreSQL, behind [PgBouncer](https://docs.bastani.ai/storage/postgres/pgbouncer) when the agents need more connections than the server allows. See [Tuning for many concurrent agents](https://docs.bastani.ai/storage/libsql#tuning-for-many-concurrent-agents).

## Use from the SDK

Install `@bastani/atomic` and `@bastani/atomic-storage-libsql` with `npm install`, open a `SqliteDatabase` with `openLibsqlDatabase()`, and pass it to `createAgentSession()` via `sessionStore: { kind: "database", database, prefix? }`:

```typescript
import { createAgentSession } from "@bastani/atomic";
import { openLibsqlDatabase } from "@bastani/atomic-storage-libsql";

const database = await openLibsqlDatabase({
	url: "libsql://<db>.turso.io",
	authToken: process.env.TURSO_AUTH_TOKEN,
});
try {
	const { session } = await createAgentSession({
		sessionStore: { kind: "database", database, prefix: "team_" },
	});
	try {
		await session.prompt("Summarize the failing tests");
	} finally {
		await session.dispose();
	}
} finally {
	await database.close();
}
```

`openLibsqlDatabase()` also accepts `namespace` and `headers` (extra request headers, redacted from errors) for `libsql:`, `https:`, and `http:` URLs. Batches are sent to the server in one request.

`session.dispose()` closes the `SqlSessionStore` wrapper opened for `{ kind: "database", database }` and leaves your caller-owned `database` open so multiple sessions can share one handle. Close `database` in a `finally` block after all sessions are disposed. If you open `SqlSessionStore.open(database, { prefix })` directly, close the store once before closing `database`.

The package ships plain ESM JavaScript with TypeScript declarations and works directly in supported Node.js versions without a TypeScript loader. See [SDK session storage](https://docs.bastani.ai/sdk/storage), [`@bastani/atomic-storage-libsql`](https://docs.bastani.ai/libraries/storage-libsql), and [Set up teams and CI](https://docs.bastani.ai/guides/team-setup) for full SDK recipes, store ownership rules, and team or CI setup.

## License

MIT. See [LICENSE](LICENSE).
