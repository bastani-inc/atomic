---
title: "Tune PostgreSQL for many agents"
sidebarTitle: "Server tuning"
description: "Server-side tuning for a PostgreSQL database shared by many Atomic agents: network distance, connections, memory and huge pages, query profiling, busy tables, compression, and upgrades."
---

This guide covers server-side tuning for the PostgreSQL instance behind your Atomic fleet. Complete [PostgreSQL setup](/storage/postgres) first.

Table names below assume the default schema (`atomic`) and no `prefix`. When a `prefix` is configured, every table name starts with it (for example, `prefix: "team_"` maps `atomic.session_sessions` to `atomic.team_session_sessions`).

## Where the time goes

Three bottlenecks typically limit multi-agent throughput on PostgreSQL:

- **Round trips:** Every save waits for the server to acknowledge it; higher network latency adds directly to every save and lock hold time.
- **Connections:** Exceeding `max_connections` rejects new work with errors.
- **Locks:** Agents writing to the same session wait in line for each other.

Run these diagnostic queries as an administrator (replace `atomic` with your database name):

Connections by state (`active` = executing a query; `idle` = open and waiting):

```sql
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY state
ORDER BY 2 DESC;
```

What non-idle connections are waiting on (`Lock` indicates contention; `Client` / `ClientRead` typically reflects network round-trip latency):

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic' AND state <> 'idle'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

Current client connections vs. `max_connections`:

```sql
SELECT count(*) AS used, current_setting('max_connections')::int AS max
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

On the database host itself, check `uptime`: if load average sits well below CPU core count while agents feel slow, the workload is waiting on network latency or locks rather than CPU.

## Put the database close to the agents

Every save waits for at least one network round trip, and transactions hold their locks across those round trips:

| Distance to PostgreSQL | Typical round trip (minimum per save) |
| --- | --- |
| Same data center | ~1 ms |
| Same region, different availability zone | ~2 ms |
| Cross-continent | ~80 ms |

Run PostgreSQL in the same region—and ideally the same availability zone—as your agents. No server parameter compensates for network distance. Also run `atomic storage migrate` after upgrades so session appends use the single-round-trip path instead of two round trips (see [After you upgrade Atomic](#after-you-upgrade-atomic)).

## Connections

Each Atomic process opens up to `maxConnections + readerMaxConnections` connections (10 by default), plus 1 wake-up connection per Intercom broker. See [Count the connections Atomic needs](/storage/postgres#count-the-connections-atomic-needs) and [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents) for sizing.

On the server:

- **`max_connections`** (requires restart): set high enough for Atomic's connections (or PgBouncer's server pool), one wake-up connection per broker, and admin/monitoring overhead.
- **Per-role cap:** cap `atomic_runtime` to PgBouncer's pool plus broker wake-ups plus a safety margin so a fleet surge cannot starve administrators (see [Connection limits](/storage/postgres/pgbouncer#connection-limits)).
- **Connection pooler:** deploy [PgBouncer](/storage/postgres/pgbouncer) when fleet demand exceeds `max_connections`.

```sql
SHOW max_connections;
ALTER ROLE atomic_runtime CONNECTION LIMIT 300;
```

## Memory

### Shared buffers

`shared_buffers` controls PostgreSQL's shared page cache (requires restart). A good starting point is 25% of host RAM (for example `shared_buffers = 8GB` on a 32 GB host). Atomic's working set usually fits comfortably inside this cache, so allocating much more rarely helps.

### Huge pages

Linux normally tracks memory in 4 KB pages, and every PostgreSQL backend keeps its own page-table entries for shared memory. With large `shared_buffers` and hundreds of connections, page tables alone can consume gigabytes. Linux 2 MB huge pages shrink those page tables by 512×.

PostgreSQL uses huge pages automatically when `huge_pages` is `try` (default) or `on` and enough huge pages are reserved at the OS level. Managed services configure huge pages for you; on self-hosted Linux:

<Steps>
  <Step title="Ask PostgreSQL how many huge pages it needs">
    Stop PostgreSQL first (`-C` reads this only while stopped), then run `postgres` as the `postgres` user (on Debian/Ubuntu, adjust `18` for your PostgreSQL version):

    ```bash
    sudo -u postgres /usr/lib/postgresql/18/bin/postgres -D /var/lib/postgresql/18/main -C shared_memory_size_in_huge_pages -c config_file=/etc/postgresql/18/main/postgresql.conf
    ```

    Elsewhere, `postgres -D <data-dir> -C shared_memory_size_in_huge_pages` is usually enough. Note the printed count (for example `4259`).
  </Step>
  <Step title="Reserve slightly more pages persistently">
    Round up with headroom (for example `4350` for `4259` needed):

    ```bash
    echo 'vm.nr_hugepages = 4350' | sudo tee /etc/sysctl.d/60-postgresql-hugepages.conf
    sudo sysctl -p /etc/sysctl.d/60-postgresql-hugepages.conf
    grep HugePages_Total /proc/meminfo
    ```
  </Step>
  <Step title="Start PostgreSQL and verify">
    ```sql
    SHOW huge_pages_status;
    ```

    Expect `on` (PostgreSQL 17+; on PostgreSQL 16, verify `HugePages_Rsvd` in `/proc/meminfo` matches the expected count).
  </Step>
</Steps>

<Note>
Reserved huge pages remain unavailable to other host processes even when PostgreSQL is stopped. To release them, stop PostgreSQL and set `vm.nr_hugepages = 0`.
</Note>

## See what is slow

Use `pg_stat_statements` to measure total and per-call execution time across all agent queries:

<Steps>
  <Step title="Preload pg_stat_statements and restart PostgreSQL">
    Add to `postgresql.conf` (or append to an existing comma-separated list):

    ```ini
    shared_preload_libraries = 'pg_stat_statements'
    ```
  </Step>
  <Step title="Create the extension as a superuser or managed-service admin">
    ```sql
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    ```
  </Step>
  <Step title="Grant stats visibility to your monitoring role">
    Without `pg_read_all_stats`, a role can inspect only its own query text:

    ```sql
    GRANT pg_read_all_stats TO atomic_owner;
    ```
  </Step>
</Steps>

Run these queries in the `atomic` database:

Top queries by total execution time (start here):

```sql
SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       left(query, 100) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

Slowest frequent queries on average:

```sql
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms,
       left(query, 100) AS query
FROM pg_stat_statements
WHERE calls > 50
ORDER BY mean_exec_time DESC
LIMIT 10;
```

Share of total execution time spent waiting on Atomic's advisory locks (`pg_advisory_xact_lock`—a high percentage means agents are contending on the same data rather than waiting on PostgreSQL):

```sql
SELECT round((100 * sum(total_exec_time) FILTER (WHERE query LIKE '%pg_advisory%')
             / nullif(sum(total_exec_time), 0))::numeric, 1) AS lock_share_percent
FROM pg_stat_statements;
```

Reset counters before starting a fresh measurement window:

```sql
SELECT pg_stat_statements_reset();
```

## Busy small tables

Three small tables receive frequent updates:

| Table | Update pattern |
| --- | --- |
| `atomic.session_sessions` | One row per session, updated on every save |
| `atomic.intercom_leases` | Broker membership and presence leases renewed every 10 seconds |
| `atomic.snapshot_session_links` | Parent/child worktree snapshot links updated as sessions append entries |

### Clean them up sooner

Because PostgreSQL uses MVCC, every update leaves a dead tuple until autovacuum reclaims it. PostgreSQL's default 20% dead-tuple ratio can let thousands of dead versions accumulate on small, hot tables.

`atomic storage migrate` (run as the owner role) automatically configures fixed dead-tuple autovacuum thresholds: `500` for `session_sessions` and `intercom_leases`, and `1000` for `snapshot_session_links`. No restart is needed, and `migrate` preserves any custom threshold you have set manually:

```sql
ALTER TABLE atomic.session_sessions SET (autovacuum_vacuum_threshold = 2000);
```

Inspect live vs. dead tuples and last cleanup time:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('session_sessions', 'intercom_leases', 'snapshot_session_links');
```

Append-only tables like `session_entries` keep PostgreSQL's default autovacuum settings.

### Updates that stay on their page

When an updated row version fits on the same 8 KB page and modifies no indexed column, PostgreSQL performs a **HOT (Heap-Only Tuple)** update—skipping index writes and reducing bloat.

`atomic storage migrate` configures this automatically:

- Sets `fillfactor = 80` on `session_sessions` and `intercom_leases`, and `fillfactor = 85` on `intercom_outbox`, leaving free space on new pages for in-place HOT updates. (Rewriting pre-existing pages via `VACUUM FULL`—which locks the table—or `pg_repack` is optional.)
- Replaces the legacy `snapshot_session_links_leaves` partial index (which filtered on `children = 0`) with `snapshot_session_links_anchored` (`WHERE anchor_seq IS NOT NULL`), built concurrently without blocking writes. Because no index references `children` anymore, parent-link `children` increments on session appends stay HOT updates whenever the page has free space. Combined with the autovacuum threshold (`1000`), this keeps `snapshot_session_links` compact and fast.

Check HOT update ratios per table:

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_percent
FROM pg_stat_user_tables
WHERE relname IN ('session_sessions', 'intercom_leases', 'intercom_outbox', 'snapshot_session_links');
```

### The search index

Atomic indexes session history text with a GIN trigram index (`atomic.session_search_trgm` on `atomic.session_search_entries`). New writes land in the GIN pending list (immediately searchable) and merge in bulk.

`atomic storage migrate` sets `gin_pending_list_limit` to **64 MB** (replacing PostgreSQL's 4 MB default or any previous 1 MB limit) so foreground writes rarely trigger an inline merge, and configures autovacuum on `atomic.session_search_entries` to run after every **1,000** inserted rows so pending entries flush regularly. Agents connecting as the index owner also clean the pending list asynchronously in the background; agents connecting as the least-privilege `atomic_runtime` role rely on autovacuum to perform those merges—so **keep autovacuum enabled**. Search indexing does not hold session write locks.

<Warning>
Leave `fastupdate = on` on `atomic.session_search_trgm`. Turning `fastupdate` off forces every write straight into the GIN tree and slows search indexing dramatically.
</Warning>

Verify the index and table storage parameters:

```sql
SELECT relname, reloptions
FROM pg_class
WHERE relname IN ('session_search_trgm', 'session_search_entries');
```

Inspect pending-list size (each page is 8 KB; creating `pgstattuple` requires a superuser or managed-service admin):

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;
SELECT pending_pages, pending_tuples FROM pgstatginindex('atomic.session_search_trgm');
```

### Intercom's wake-up notices

When a broker sends a cross-host message, it writes a short wake-up hint to `atomic.intercom_wakeups` alongside the durable message in `atomic.intercom_outbox`. Atomic marks `intercom_wakeups` as `UNLOGGED` (either on creation or during `atomic storage migrate`) to eliminate WAL writes and disk flushes for ephemeral hints.

Normally, brokers receive `LISTEN/NOTIFY` notifications immediately and poll `intercom_wakeups` every **5 seconds** (or every **0.5 seconds** if `LISTEN/NOTIFY` is unavailable; see [Wake-ups](/storage/postgres#wake-ups)). If PostgreSQL crashes or fails over to a standby, the unlogged `intercom_wakeups` table empties—losing only hints while messages remain safely in `intercom_outbox`. Independently of wake-up hints, every broker scans `intercom_outbox` directly every **30 seconds** as a backup safety net, so every message still arrives within at most 30 seconds.

## Compression of large values

`atomic storage migrate` automatically switches large text, JSON, and binary columns (`session_entries`, chunk tables, snapshot blobs, chat records, and `intercom_outbox`) from PostgreSQL's default `pglz` compression to **`lz4`** whenever the server supports it (standard in most PostgreSQL 14+ builds).

`lz4` compresses and decompresses roughly 2–4× faster than `pglz`—especially on already-compressed content like images and archives—for only a few percent more disk space on plain text, while avoiding the ~2× storage overhead of disabling compression (`SET STORAGE EXTERNAL`). Existing rows remain readable as-is; new writes use `lz4`. If your server was compiled without `lz4`, `migrate` reports this and leaves columns unchanged.

Check active compression methods on `session_entries` (`NULL` means a value was small enough to store inline uncompressed):

```sql
SELECT pg_column_compression(entry_json) AS method, count(*)
FROM atomic.session_entries GROUP BY 1;
```

## Settings you can usually leave alone

- **`synchronous_commit`:** Keep `on` server-wide so crashes cannot drop committed session entries or messages. Atomic already sets `synchronous_commit = off` per transaction for repeatable broker lease heartbeats (every 10 seconds), where losing one write is harmless.
- **`wal_compression`:** Keep your server default.
- **`deadlock_timeout`:** Leave at default; Atomic's expected lock waits use its own timeouts. Keeping `log_lock_waits = on` is helpful for diagnosing long waits.

## After you upgrade Atomic

Run `atomic storage migrate` once as the owner role after every Atomic upgrade, before launching your agent fleet:

```bash
atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
```

Running `migrate` as the owner role ensures:

- **Fast startup:** Agents open an up-to-date database in a couple of round trips with no schema-init contention.
- **Owner-only optimizations and lazy objects:** Applies `fillfactor`, autovacuum thresholds, `lz4` compression, search index tuning, unlogged `intercom_wakeups`, the concurrent `snapshot_session_links_anchored` index rebuild (up to a 6-hour statement timeout for large tables without blocking writes), the single-round-trip session append function, and lazily initialized tables (fork staging, chat records, Intercom ended-child queue). Each table tuning `ALTER TABLE` uses a 2-second `lock_timeout` and gracefully skips busy tables without failing the migration—re-run later if any table was skipped.
- **Faster resume with worktree snapshots:** The migration fills and indexes the small snapshot fields Atomic compares when resuming sessions that launched many subagents. New stores usually build the index on first open; large existing stores leave it to `atomic storage migrate`. The backfill can take time on a large database, but the index builds concurrently. Sessions can still resume using the unindexed path until the migration finishes. If interrupted, rerun the same command as the owner.

## Checklist

| Step | Restart required |
| --- | --- |
| Run PostgreSQL in the same region (ideally same zone) as your agents | No |
| Size `max_connections` and `atomic_runtime` `CONNECTION LIMIT`, or deploy PgBouncer | `max_connections` only |
| Set `shared_buffers` to ~25% of host RAM | Yes |
| Reserve Linux huge pages (`vm.nr_hugepages`) and verify `huge_pages_status` | Yes |
| Preload and create `pg_stat_statements`; grant `pg_read_all_stats` | Yes |
| Run `atomic storage migrate` as owner after every Atomic upgrade | No |
| Keep autovacuum enabled so search pending lists merge under runtime roles | No |

On managed services (Amazon RDS, Azure Database for PostgreSQL, Google Cloud SQL), adjust server settings through parameter groups or console controls; SQL statements work identically (creating extensions requires the managed admin role).

## Related pages

- [PostgreSQL setup](/storage/postgres): database roles, TLS, proxies, and troubleshooting.
- [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents): client pool arithmetic and `maxConnections`.
- [Use PgBouncer with PostgreSQL](/storage/postgres/pgbouncer): transaction pooling configuration and health checks.
