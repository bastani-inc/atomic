# @bastani/atomic-storage-libsql

A libSQL / [Turso](https://turso.tech) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions, workflow journals, and Intercom multi-node routing in one shared database, so several machines can use the same state. It is a separate package: install it only where you want remote storage.

## Install

```bash
atomic install npm:@bastani/atomic-storage-libsql
```

Install in user scope (without `-l`); Atomic only searches user-scope packages for storage adapters.

## Configure

Select the adapter in `~/.atomic/agent/settings.json`:

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
|---|---|---|
| `url` | yes | A `libsql://`, `https://`, `wss://`, or `file:` URL. |
| `authToken` | for remote databases | The database token. Pass it through `secrets` (`{ "file": ... }` or `{ "env": ... }`) so it stays out of settings. |

The token is redacted from error messages and diagnostics. Add a `prefix` to the `storage` block to keep projects or teams apart in one database. See [Storage](../coding-agent/docs/storage.md) for selection precedence, per-process overrides, and the other storage options.

## Use from the SDK

```ts
import { openLibsqlDatabase } from "@bastani/atomic-storage-libsql";

const database = await openLibsqlDatabase({ url: "libsql://<db>.turso.io", authToken });
```

The returned `SqliteDatabase` can be passed as SDK `sessionStore: { kind: "database", database }` or workflow `journal: { database }`.

The package ships plain ESM JavaScript with TypeScript declarations. This import works in supported Node versions without a TypeScript loader.

## License

MIT
