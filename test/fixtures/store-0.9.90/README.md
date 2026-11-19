# Store 0.9.90 (generated)

The database Atomic 0.9.90, the last release with workflows, writes when every store it has opens on it: sessions, the
worktree snapshot index, Intercom, the workflow run journal and the worker pool. Later releases never open the
workflow tables (`wf_*`); `test/helpers/legacy-store-0990.ts` replays this SQL so tests can check that they leave
such a database, and the snapshots its runs reference, as they found it.

- `sqlite.sql`: every table, row, index and trigger of a SQLite database, one statement a line, under no prefix. It
  holds one session, one internal workflow-stage session, and one paused run whose checkpoint references two snapshot
  blobs. A full-text index's shadow tables are left to its `CREATE VIRTUAL TABLE`.
- `postgres.sql`: the same stores on PostgreSQL 16, in schema `atomic`, as `pg_dump --schema=atomic --no-owner
  --no-privileges --inserts --column-inserts` writes it.
- `generate.ts.txt`: the script that wrote both, run with Bun from a checkout of tag `0.9.90`
  (`2f49186f4ebc77231c129ad28aa9e26c7b17071d`) after `npm ci && npm run build`:

```sh
bun generate.ts sqlite.sql postgresql://postgres@127.0.0.1:5432/postgres skip   # SQLite only
bun generate.ts sqlite.sql postgresql://postgres@127.0.0.1:5432/postgres done   # also populates the database, then:
pg_dump -U postgres -d postgres --schema=atomic --no-owner --no-privileges --inserts --column-inserts > postgres.sql
```

Do not edit the files; regenerate them from the tag. Biome ignores `test/fixtures/**`.
