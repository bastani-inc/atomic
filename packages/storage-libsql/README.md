# @bastani/atomic-storage-libsql

A libSQL and [Turso](https://turso.tech) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions and Intercom multi-node routing in one shared database so multiple machines can share state. Install it only when you want remote libSQL storage.

## Install

Install the adapter in user scope (without `-l`). Atomic searches only user-scope packages for storage adapters.

```bash
atomic install npm:@bastani/atomic-storage-libsql
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

`atomic storage join` tests the connection with `SELECT 1` before writing anything, saves the token in a mode-`600` file under `~/.atomic/agent/`, and writes the `storage` block in `~/.atomic/agent/settings.json`. To share Intercom across machines while keeping personal sessions local, run `atomic team join <url> --token-file <path>` instead. Run `atomic storage migrate` when upgrading schemas on a shared database.

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
| `url` | Yes | A `libsql://`, `https://`, `http://`, `wss://`, `ws://`, or `file:` URL. (`atomic storage join` accepts `libsql://`, `https://`, `wss://`, or an absolute `file:` URL.) |
| `authToken` | For remote databases | Database auth token. Pass it through `secrets` (`{ "file": ... }` or `{ "env": ... }`) so it stays out of `settings.json`. |
| `namespace` | No | A self-hosted `sqld` namespace (`sqld --enable-namespaces`), sent as the `x-namespace` header. Requires a `libsql:`, `https:`, or `http:` URL. |

Atomic redacts auth tokens from error messages and diagnostics. Add a `prefix` to the `storage` block to isolate projects or teams inside one database. See [Storage](https://docs.bastani.ai/storage) for selection precedence, per-process overrides, and additional storage options.

## Concurrency and retries

- **Local `file:` databases:** The adapter enables write-ahead logging (WAL) on first open (creating `-wal` and `-shm` sidecar files) with a 5-second busy timeout, matching Atomic's built-in SQLite stores. A statement waits up to 5 seconds for another process's lock instead of failing immediately with `SQLITE_BUSY`. If another connection commits while a single statement, single-statement `exec`, batch, or transaction start is waiting, the adapter retries it; multi-statement `exec` calls are not retried. Open a local file through only one SQLite library at a time so concurrent readers do not observe stale WAL state.
- **Remote `sqld` servers:** When `sqld` hits a WAL checkpoint, it returns `SQLITE_BUSY` immediately without running the write. The adapter retries single statements, single-statement `exec` calls, batches, and transaction starts with jittered exponential backoff for up to 5 seconds within a 10-second wall-clock ceiling (one 5-second lock timeout plus one 5-second checkpoint window). For self-hosted `sqld`, run with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`).

## Use from the SDK

```typescript
import { openLibsqlDatabase } from "@bastani/atomic-storage-libsql";

const authToken = process.env.TURSO_AUTH_TOKEN;
const database = await openLibsqlDatabase({
	url: "libsql://<db>.turso.io",
	authToken,
});
```

`openLibsqlDatabase()` also accepts `namespace` and `headers` (extra request headers, redacted from errors) for `libsql:`, `https:`, and `http:` URLs. Pass the returned `SqliteDatabase` to Atomic's SDK as `sessionStore: { kind: "database", database }`. Batches are sent to the server in one request.

The package ships plain ESM JavaScript with TypeScript declarations and works directly in supported Node.js versions without a TypeScript loader.

## License

MIT. See [LICENSE](LICENSE).
