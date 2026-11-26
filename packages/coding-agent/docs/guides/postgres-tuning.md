---
title: "Tune PostgreSQL for many agents"
sidebarTitle: "Tune PostgreSQL"
description: "Server-side tuning for a PostgreSQL database shared by many Atomic agents: where the time goes, distance, connections, memory, monitoring, busy tables, and what to leave alone."
---

This guide is for the person who runs the PostgreSQL server that Atomic's agents share. It follows what we did on a production server and measured there. Use it after you set up the database as in [PostgreSQL storage](/storage#postgresql).

**The server we tuned:** PostgreSQL 18 on a machine with 8 CPU cores, 30 GB of memory and an NVMe disk. It served up to 200 agents about 80 ms away over the network. Each section says what we measured on that server, what is general advice, and what we have not tried on managed services such as Amazon RDS, Azure or Google Cloud SQL.

The table names below assume Atomic's default schema, `atomic`, and no `prefix`. With a prefix, each table name starts with it, for example `atomic.team_session_sessions`.

## Where the time goes

For Atomic, a database server is rarely short of CPU or disk. On our server the load average stayed below 1.7 while 200 agents worked, and every query that did real work took under 60 seconds in total over a 13-minute test. The limits are:

- **Round trips.** Each save waits for answers from the server. The farther away the server, the longer each wait.
- **Connections.** Each server has a fixed number. When agents need more than it has, they get errors.
- **Locks.** Agents that write the same data wait for each other. Before Atomic's own locking was fixed, waiting for locks was 99 to 100% of the time the server spent on Atomic's queries.

To tell which one you are hitting, run these as an administrator. Replace `atomic` with your database's name.

How many connections are in use, and what they are doing. `active` means running a query, and `idle` means open but unused:

```sql
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY state
ORDER BY 2 DESC;
```

What the busy connections are waiting for. A large count with `wait_event_type` `Lock` means lock waits. `Client` with `ClientRead` means the server waits for the agent, which usually means distance:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic' AND state <> 'idle'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

How close the server is to its connection limit:

```sql
SELECT count(*) AS used, current_setting('max_connections')::int AS max
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

On the machine itself, `uptime` shows the load average. If it stays well below the number of CPU cores while agents are slow, the server is waiting, not working.

## Put the database close to the agents

Saving new entries to a session takes 1 round trip once you have run `atomic storage migrate` as the owner role, and 2 before. A round trip is the time a message takes to reach the server and come back, which `ping` shows. So every save takes at least that long:

| Distance to the server | One round trip | Each save, at least | Before `atomic storage migrate` |
| --- | --- | --- | --- |
| Same data center | about 1 ms | about 1 ms | about 2 ms |
| Same region, different zone | about 2 ms | about 2 ms | about 4 ms |
| Across a continent | about 80 ms | about 80 ms | about 160 ms |

We measured this on our server with 2 round trips per save. At 80 ms, a save took 164 to 166 ms in the middle of the range (p50) with 25 to 200 agents. At about 10 ms through PgBouncer, a save took 23 ms. Distance also makes every lock wait longer, because a transaction holds its locks for its round trips.

Run the server in the same region as the agents, and ideally the same zone. No server setting makes up for distance.

## Connections

Each Atomic process opens up to `maxConnections` plus `readerMaxConnections` connections to the server, 10 by default. An Intercom broker process opens one more, for wake-ups. [Count the connections Atomic needs](/storage#count-the-connections-atomic-needs) explains the arithmetic, and [Tuning for many concurrent agents](/storage#tuning-for-many-concurrent-agents) shows how to size `maxConnections`.

On the server:

- **`max_connections`** is the total the server accepts. Each connection uses memory for its own work, so the server cannot accept unlimited connections. On our server we raised it from 300 to 400, which needs a restart. That leaves room for PgBouncer's pool, one wake-up connection per broker, and administrators.
- **Per-role limits.** `ALTER ROLE atomic_runtime CONNECTION LIMIT 300;` caps one role, so a runaway fleet cannot take every slot. We raised Atomic's role from 150 to 300, because every broker holds a direct wake-up connection.
- **PgBouncer.** When agents need more connections than the server can give, put [PgBouncer](/guides/postgres-pgbouncer) in front. With 200 agents and a 300-connection server, we had to.

```sql
SHOW max_connections;
ALTER ROLE atomic_runtime CONNECTION LIMIT 300;
```

## Memory

### Shared buffers

`shared_buffers` is the memory PostgreSQL keeps for table and index pages. A common starting point is a quarter of the machine's memory. Our server has 30 GB and uses `shared_buffers = 8GB`. Atomic's data was small enough that 99.999% of page reads came from memory, so a larger value would not have helped. Changing it needs a restart.

### Huge pages

The operating system tracks memory in pages, usually 4 KB each. Every server process that touches shared memory keeps its own table of those pages. With 8 GB of shared buffers and hundreds of connections, those tables alone can take gigabytes. Huge pages are 2 MB each on Linux, so the tables are 512 times smaller.

PostgreSQL uses huge pages when `huge_pages` is `try` (the default) or `on`, and the operating system has enough of them reserved. Our server had `huge_pages = try` but none reserved, so `huge_pages_status` was `off`. To fix that on Linux:

1. **Find out how many pages PostgreSQL needs.** Stop the server first: this setting can only be read while it is not running. Run, as the `postgres` user, with your data directory:

   ```bash
   postgres -D /var/lib/postgresql/18/main -C shared_memory_size_in_huge_pages
   ```

   On Debian and Ubuntu, `postgres` is in `/usr/lib/postgresql/18/bin/`. Add `-c config_file=/etc/postgresql/18/main/postgresql.conf` so it reads your settings. On our server it printed `4259`.

2. **Reserve a little more than that**, rounded up, and keep it across reboots. We reserved 4350, which leaves about 180 MB spare:

   ```bash
   echo 'vm.nr_hugepages = 4350' | sudo tee /etc/sysctl.d/60-postgresql-hugepages.conf
   sudo sysctl -p /etc/sysctl.d/60-postgresql-hugepages.conf
   grep HugePages_Total /proc/meminfo
   ```

3. **Start the server and check** that it uses them:

   ```sql
   SHOW huge_pages_status;
   ```

   It should say `on`. `huge_pages_status` exists in PostgreSQL 17 and later. On any version, `HugePages_Rsvd` in `/proc/meminfo` should be close to the number PostgreSQL needed.

Reserved huge pages are taken out of the memory other programs can use. On our server, available memory went from 30.0 GB to 21.7 GB, because 8.5 GB was now reserved as huge pages for PostgreSQL's shared memory. We did not measure how much page-table memory this saved. To undo it, set `vm.nr_hugepages` back to `0` after stopping the server.

Managed services decide huge pages for you. We have not checked how each one sets them.

## See what is slow

`pg_stat_statements` is an extension that records how often each query runs and how long it takes in total. It is the only way to see what hundreds of agents actually ask of the server.

1. **Load it at server start.** Add this line to `postgresql.conf`, or to a file in its `conf.d` directory, and restart:

   ```ini
   shared_preload_libraries = 'pg_stat_statements'
   ```

   If the line already lists other libraries, add it to the list, separated by a comma.

2. **Create the extension** in Atomic's database, as a superuser. Atomic's owner role cannot: it gets `permission denied to create extension "pg_stat_statements"` with the hint `Must be superuser to create this extension`.

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

3. **Let your monitoring role see every query.** Without this, a role sees the text only of its own queries:

   ```sql
   GRANT pg_read_all_stats TO atomic_owner;
   ```

Queries to run, all in the `atomic` database:

The queries that take the most total time. This is where to look first:

```sql
SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time::numeric, 2) AS mean_ms,
       left(query, 100) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

The slowest queries on average:

```sql
SELECT calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms,
       left(query, 100) AS query
FROM pg_stat_statements
WHERE calls > 50
ORDER BY mean_exec_time DESC
LIMIT 10;
```

How much of the time is lock waits. Atomic takes its locks with `pg_advisory_xact_lock`, so a large share here means agents wait for each other, not for the server:

```sql
SELECT round((100 * sum(total_exec_time) FILTER (WHERE query LIKE '%pg_advisory%')
             / nullif(sum(total_exec_time), 0))::numeric, 1) AS lock_share_percent
FROM pg_stat_statements;
```

To start a new measurement, clear the counters:

```sql
SELECT pg_stat_statements_reset();
```

## Busy small tables

A few of Atomic's tables are small but change constantly:

| Table | What changes it |
| --- | --- |
| `atomic.session_sessions` | One row per session, updated on every save |
| `atomic.intercom_leases` | Leases that Intercom brokers renew every few seconds |
| `atomic.snapshot_session_links` | Links between sessions and worktree snapshots, updated when sessions change |

### Clean them up sooner

PostgreSQL never changes a row in place. An update writes a new version of the row and leaves the old one behind as a dead row. A background process, autovacuum, later frees the dead rows. By default it waits until a fifth of a table is dead, which on a small table that changes constantly can mean many dead rows between cleanups, and queries that read past them.

Tell autovacuum to clean these tables after a fixed number of dead rows instead. This takes effect at once, with no restart. These are the settings we use:

```sql
ALTER TABLE atomic.session_sessions SET (
  autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 500);
ALTER TABLE atomic.intercom_leases SET (
  autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 500);
ALTER TABLE atomic.snapshot_session_links SET (
  autovacuum_vacuum_scale_factor = 0, autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0, autovacuum_analyze_threshold = 1000);
```

On our server, `snapshot_session_links` had 13,444 dead rows before the change. Autovacuum cleaned it 21 seconds later, leaving none. Check dead rows and the last cleanup with:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('session_sessions', 'intercom_leases', 'snapshot_session_links');
```

To undo the settings, run `ALTER TABLE <table> RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);`.

### Updates that stay on their page

When PostgreSQL writes a row's new version on the same page as the old one, and the update changes no indexed column, it can skip updating the table's indexes. This is called a HOT update, for heap-only tuple. It is faster and leaves less to clean up. It only works when the page has free space.

`fillfactor` leaves part of every page free for this. Atomic sets `fillfactor = 80` on `session_sessions` and `intercom_leases`, leaving a fifth of each page free, when you run `atomic storage migrate`. You do not set it yourself.

| Table | Share of updates that were HOT before | After `fillfactor = 80` | Where we measured |
| --- | --- | --- | --- |
| `session_sessions` | 92% | 94.5% | 300 sessions, in a test database |
| `intercom_leases` | 70 to 76% | about 90%, and the table half the size | 600 leases, in a test database |
| `session_sessions` | 71% on our server, misses on full pages | not yet measured there | production server |

`fillfactor` applies to pages written after the change. To rewrite existing pages, run `VACUUM FULL` on the table, which locks it while it runs, or use `pg_repack`. This is optional.

`snapshot_session_links` gets no HOT updates at all: 0 of 5,785 on our server. Its updates change a column that one of its indexes depends on, so free space does not help. The autovacuum settings above keep it small.

Check the share of HOT updates per table with:

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_percent
FROM pg_stat_user_tables
WHERE relname IN ('session_sessions', 'intercom_leases', 'snapshot_session_links');
```

### The search index (optional)

Atomic indexes session text for search with a trigram index, `atomic.session_search_trgm`. This kind of index (GIN) collects new entries in a pending list and adds them to the index in one go when the list fills up. That flush happens inside one agent's save, so that save is slow now and then.

A smaller pending list makes the flushes smaller. In a benchmark of 460 inserts on PostgreSQL 16, run once per setting on a busy test machine, not on our server:

| Index setting | Insert p50 | Insert p99 | Slowest insert | Total insert time | Search |
| --- | --- | --- | --- | --- | --- |
| Default, 4 MB pending list | 1.96 ms | 22.9 ms | 26.5 ms | 1,122 ms | 0.83 ms |
| `gin_pending_list_limit = 1024` (1 MB) | 1.92 ms | 13.7 ms | 15.5 ms | 1,225 ms | 0.81 ms |
| `gin_pending_list_limit = 256` | 2.08 ms | 11.6 ms | 17.3 ms | 1,713 ms | 0.83 ms |
| `fastupdate = off` | 10.6 ms | 32.6 ms | 45.1 ms | 5,114 ms | 0.47 ms |

A 1 MB list halved the slowest inserts for 9% more total insert time. It does not make Atomic faster overall. If occasional slow saves matter to you, apply it:

```sql
ALTER INDEX atomic.session_search_trgm SET (gin_pending_list_limit = 1024);
```

## What we checked and left alone

These settings come up in tuning advice. We measured each on our server and kept the default or the existing value:

- **`synchronous_commit = on`.** Turning it off makes commits return before they reach the disk, so a crash can lose the last commits. On our server's NVMe disk, writing the write-ahead log to disk (fsync) took 0.37 ms on average: 7,394 of them took 2.7 seconds in total. That is small next to a round trip, so there is nothing to gain.
- **`commit_delay`.** It makes commits wait a little so several can share one fsync. With 0.37 ms fsyncs, there is nothing to share.
- **`wal_compression`.** We kept `zstd`, which was already set. It makes the write-ahead log smaller at a small CPU cost, and the CPU was idle.
- **`io_method`.** PostgreSQL 18 can read from disk with `worker` (the default) or `io_uring`. With 99.999% of reads served from memory, the disk is rarely read, so we kept `worker`.
- **The search index's pending list.** See [The search index](#the-search-index-optional). It trades total insert time for fewer slow inserts, and does not raise throughput.
- **`deadlock_timeout`.** Atomic's lock waits are expected and end at its own lock timeout, so lowering it only adds work. Keep `log_lock_waits = on` to see long waits in the log.

We did not change `effective_cache_size`, `random_page_cost`, `max_wal_size` or `idle_in_transaction_session_timeout`. Their existing values worked.

## After you upgrade Atomic

After every Atomic upgrade, run `atomic storage migrate` once, as the owner role, before you start many agents:

```bash
atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
```

Why it matters for performance:

- **Fast starts.** An agent opens its storage quickly, in a few round trips and without taking locks, only when the database is already up to date. If it is not, each agent starts by checking and updating it, and many agents starting at once queue behind each other.
- **New steps.** `atomic storage migrate` also applies changes a runtime role without DDL rights cannot make: the sequence Intercom uses to order new leases, `fillfactor` on the busy tables, and the function that saves entries to a session in 1 round trip instead of 2. Until it runs, agents keep working, but without those gains. Agents find the function the next time they start.

## Checklist

| Step | Restart needed | Measured on our server |
| --- | --- | --- |
| Run the database in the same region as the agents | — | Yes: 2 round trips per save, 1 after `atomic storage migrate` |
| Size `max_connections` and per-role limits from the connection count, or put PgBouncer in front | `max_connections` only | Yes: raised 300 to 400, role 150 to 300 |
| Set `shared_buffers` to about a quarter of memory | Yes | Kept 8 GB of 30 GB |
| Reserve huge pages with `vm.nr_hugepages` and check `huge_pages_status` | Yes | Yes: `on`, 4259 pages needed, 4350 reserved |
| Preload `pg_stat_statements`, create it as a superuser, grant `pg_read_all_stats` | Yes | Yes |
| Set per-table autovacuum on `session_sessions`, `intercom_leases` and `snapshot_session_links` | No | Yes |
| Run `atomic storage migrate` after each Atomic upgrade | No | Yes |
| Optionally, shrink the search index's pending list | No | In a benchmark only |
| Leave `synchronous_commit`, `commit_delay`, `wal_compression` and `io_method` as they are | — | Yes |

On a managed service, the server settings above may be fixed or set through the service's own parameters. We have not tested this guide on Amazon RDS, Azure Database for PostgreSQL or Google Cloud SQL. The SQL statements work the same way there, except that creating `pg_stat_statements` needs the service's administrator role.

## Related pages

- [PostgreSQL storage](/storage#postgresql): set up the database and roles.
- [Tuning for many concurrent agents](/storage#tuning-for-many-concurrent-agents): size Atomic's connection settings.
- [Run many agents on PostgreSQL with PgBouncer](/guides/postgres-pgbouncer).
