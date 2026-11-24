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

Atomic redacts auth tokens from error messages and diagnostics. Add a `prefix` to the `storage` block to isolate projects or teams inside one database. Prefixes must match `[A-Za-z_][A-Za-z0-9_]*` and cannot start with `sqlite_` (case-insensitive); invalid prefixes throw `StoragePrefixError`. See [Storage backends](https://docs.bastani.ai/storage) and [`@bastani/atomic-storage-libsql`](https://docs.bastani.ai/libraries/storage-libsql) for selection precedence, per-process overrides, and additional storage options.

## Concurrency and retries

- **Local `file:` databases:** The adapter enables write-ahead logging (WAL) on first open (creating `-wal` and `-shm` sidecar files) with a 5-second busy timeout, matching Atomic's built-in SQLite stores. A statement waits up to 5 seconds for another process's lock instead of failing immediately with `SQLITE_BUSY`. If another connection commits while a single statement, single-statement `exec`, batch, or transaction start is waiting, the adapter retries it; multi-statement `exec` calls are not retried. Open a local file through only one SQLite library at a time so concurrent readers do not observe stale WAL state.
- **Remote `sqld` servers:** When `sqld` hits a WAL checkpoint, it returns `SQLITE_BUSY` immediately without running the write. The adapter retries single statements, single-statement `exec` calls, batches, and transaction starts with jittered exponential backoff for up to 5 seconds within a 10-second wall-clock ceiling (one 5-second lock timeout plus one 5-second checkpoint window). For self-hosted `sqld`, run with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`).

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
