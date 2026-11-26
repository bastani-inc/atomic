---
title: "Tune PostgreSQL for many agents"
sidebarTitle: "Server tuning"
description: "Server-side tuning for a PostgreSQL database shared by many Atomic agents: where the time goes, distance, connections, memory, monitoring, busy tables, and what to leave alone."
---

This guide is for the person who runs the PostgreSQL server that Atomic's agents share. Use it after you set up the database as in [PostgreSQL storage](/storage/postgres).

The table names below assume Atomic's default schema, `atomic`, and no `prefix`. With a prefix, each table name starts with it, for example `atomic.team_session_sessions`.

## Where the time goes

For Atomic, a database server is rarely short of CPU or disk. The usual limits are:

- **Round trips.** Each save waits for answers from the server. The farther away the server, the longer each wait.
- **Connections.** Each server has a fixed number. When agents need more than it has, they get errors.
- **Locks.** Agents that write the same data wait for each other.

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

Distance also makes every lock wait longer, because a transaction holds its locks for its round trips.

Run the server in the same region as the agents, and ideally the same zone. No server setting makes up for distance.

## Connections

Each Atomic process opens up to `maxConnections` plus `readerMaxConnections` connections to the server, 10 by default. An Intercom broker process opens one more, for wake-ups. [Count the connections Atomic needs](/storage/postgres#count-the-connections-atomic-needs) explains the arithmetic, and [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents) shows how to size `maxConnections`.

On the server:

- **`max_connections`** is the total the server accepts. Each connection uses memory for its own work, so the server cannot accept unlimited connections. Set it high enough for Atomic's connections, or PgBouncer's pool, plus one wake-up connection per broker and room for administrators. Changing it needs a restart.
- **Per-role limits.** `ALTER ROLE atomic_runtime CONNECTION LIMIT 300;` caps one role, so a runaway fleet cannot take every slot. Count every broker's direct wake-up connection in the cap.
- **PgBouncer.** When agents need more connections than the server can give, put [PgBouncer](/storage/postgres/pgbouncer) in front.

```sql
SHOW max_connections;
ALTER ROLE atomic_runtime CONNECTION LIMIT 300;
```

## Memory

### Shared buffers

`shared_buffers` is the memory PostgreSQL keeps for table and index pages. A common starting point is a quarter of the machine's memory, for example `shared_buffers = 8GB` on a machine with 32 GB. Atomic's data is usually small enough to fit, so a larger value rarely helps. Changing it needs a restart.

### Huge pages

The operating system tracks memory in pages, usually 4 KB each. Every server process that touches shared memory keeps its own table of those pages. With 8 GB of shared buffers and hundreds of connections, those tables alone can take gigabytes. Huge pages are 2 MB each on Linux, so the tables are 512 times smaller.

PostgreSQL uses huge pages when `huge_pages` is `try` (the default) or `on`, and the operating system has enough of them reserved. With `huge_pages = try` and none reserved, `huge_pages_status` is `off`. To reserve them on Linux:

1. **Find out how many pages PostgreSQL needs.** Stop the server first, because PostgreSQL reads this setting only while it is not running. Run this as the `postgres` user, with your data directory:

   ```bash
   postgres -D /var/lib/postgresql/18/main -C shared_memory_size_in_huge_pages
   ```

   On Debian and Ubuntu, `postgres` is in `/usr/lib/postgresql/18/bin/`. Add `-c config_file=/etc/postgresql/18/main/postgresql.conf` so it reads your settings. It prints a number of pages, for example `4259`.

2. **Reserve a little more than that**, rounded up, and keep it across reboots. For example, for 4259 pages, reserve 4350:

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

Reserved huge pages are taken out of the memory other programs can use, even while PostgreSQL is stopped. To undo the reservation, stop the server and set `vm.nr_hugepages` back to `0`.

Managed services decide huge pages for you.

## See what is slow

`pg_stat_statements` is an extension that records how often each query runs and how long it takes in total. It shows which of the agents' queries take the server's time.

1. **Load it at server start.** Add this line to `postgresql.conf`, or to a file in its `conf.d` directory, and restart:

   ```ini
   shared_preload_libraries = 'pg_stat_statements'
   ```

   If the line already lists other libraries, add it to the list, separated by a comma.

2. **Create the extension** in Atomic's database, as a superuser. Atomic's owner role cannot. It gets `permission denied to create extension "pg_stat_statements"` with the hint `Must be superuser to create this extension`.

   ```sql
   CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
   ```

3. **Let your monitoring role see every query.** Without this, a role sees the text only of its own queries:

   ```sql
   GRANT pg_read_all_stats TO atomic_owner;
   ```

Run these queries in the `atomic` database.

The queries that take the most total time. Look here first:

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

PostgreSQL never changes a row in place. An update writes a new version of the row and leaves the old one behind as a dead row. A background process, autovacuum, later frees the dead rows. By default it waits until a fifth of a table is dead. On a small table that changes constantly, that can mean many dead rows between cleanups, and queries that read past them.

Tell autovacuum to clean these tables after a fixed number of dead rows instead. This takes effect at once, with no restart. For example:

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

Check dead rows and the last cleanup with:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('session_sessions', 'intercom_leases', 'snapshot_session_links');
```

To undo the settings, run `ALTER TABLE <table> RESET (autovacuum_vacuum_scale_factor, autovacuum_vacuum_threshold, autovacuum_analyze_scale_factor, autovacuum_analyze_threshold);`.

### Updates that stay on their page

When PostgreSQL writes a row's new version on the same page as the old one, and the update changes no indexed column, it can skip updating the table's indexes. This is called a HOT update, for heap-only tuple. It is faster and leaves less to clean up. It only works when the page has free space.

`fillfactor` leaves part of every page free for this. Atomic sets `fillfactor = 80` on `session_sessions` and `intercom_leases`, leaving a fifth of each page free, when you run `atomic storage migrate`. You do not set it yourself.

`fillfactor` applies to pages written after the change. To rewrite existing pages, run `VACUUM FULL` on the table, which locks it while it runs, or use `pg_repack`. This is optional.

`snapshot_session_links` gets few or no HOT updates. Its updates change a column that one of its indexes depends on, so free space does not help. The autovacuum settings above keep it small.

Check the share of HOT updates per table with:

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_percent
FROM pg_stat_user_tables
WHERE relname IN ('session_sessions', 'intercom_leases', 'snapshot_session_links');
```

### The search index (optional)

Atomic indexes session text for search with a trigram index, `atomic.session_search_trgm`. This kind of index (GIN) collects new entries in a pending list and adds them to the index in one go when the list fills up. That flush happens inside one agent's save, so that save is slow now and then.

A smaller pending list makes each flush smaller. The slowest saves get faster, and total insert time grows a little. It does not make Atomic faster overall. If occasional slow saves matter to you, shrink the list from the default 4 MB to 1 MB:

```sql
ALTER INDEX atomic.session_search_trgm SET (gin_pending_list_limit = 1024);
```

Leave the index's `fastupdate` on. Turning it off adds every entry to the index at once, which makes every insert slower.

## Settings you can usually leave alone

These settings come up in tuning advice, but rarely help Atomic:

- **`synchronous_commit`.** Keep it `on`. Turning it off can lose the last commits in a crash, and on a fast disk a commit's write takes far less time than a network round trip.
- **`commit_delay`.** It lets several commits share one disk write, which helps only when disk writes are slow.
- **`wal_compression`.** Keep the current value. It trades a little CPU for a smaller write-ahead log.
- **`io_method`.** Atomic's data usually fits in memory, so the method PostgreSQL 18 uses to read from disk rarely matters.
- **`deadlock_timeout`.** Atomic's lock waits are expected and end at its own lock timeout, so lowering it only adds work. Keep `log_lock_waits = on` to see long waits in the log.

## After you upgrade Atomic

After every Atomic upgrade, run `atomic storage migrate` once, as the owner role, before you start many agents:

```bash
atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
```

Why it matters for performance:

- **Fast starts.** An agent opens its storage quickly, in a few round trips and without taking locks, only when the database is already up to date. If it is not, each agent starts by checking and updating it, and many agents starting at once queue behind each other.
- **New steps.** `atomic storage migrate` also applies changes a runtime role without DDL rights cannot make: the sequence Intercom uses to order new leases, `fillfactor` on the busy tables, and the function that saves entries to a session in 1 round trip instead of 2. Until it runs, agents keep working, but without those gains. Agents find the function the next time they start.

## Checklist

| Step | Restart needed |
| --- | --- |
| Run the database in the same region as the agents | No |
| Size `max_connections` and per-role limits from the connection count, or put PgBouncer in front | `max_connections` only |
| Set `shared_buffers` to about a quarter of memory | Yes |
| Reserve huge pages with `vm.nr_hugepages` and check `huge_pages_status` | Yes |
| Preload `pg_stat_statements`, create it as a superuser, grant `pg_read_all_stats` | Yes |
| Set per-table autovacuum on `session_sessions`, `intercom_leases` and `snapshot_session_links` | No |
| Run `atomic storage migrate` after each Atomic upgrade | No |
| Optionally, shrink the search index's pending list | No |

On a managed service, such as Amazon RDS, Azure Database for PostgreSQL or Google Cloud SQL, the server settings above may be fixed or set through the service's own parameters. The SQL statements work the same way there, except that creating `pg_stat_statements` needs the service's administrator role.

## Related pages

- [PostgreSQL storage](/storage/postgres): set up the database and roles.
- [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents): size Atomic's connection settings.
- [Run many agents on PostgreSQL with PgBouncer](/storage/postgres/pgbouncer).
