---
title: "Run many agents on PostgreSQL with PgBouncer"
sidebarTitle: "PostgreSQL with PgBouncer"
description: "Put PgBouncer between Atomic and PostgreSQL when your agents need more connections than the server allows, with a complete configuration, checks, and fixes for common errors."
---

PgBouncer is a small server that sits between Atomic and PostgreSQL. Thousands of connections from Atomic go to PgBouncer, and PgBouncer runs their work over a few dozen connections to PostgreSQL. Use it when your agents need more connections than PostgreSQL allows.

This guide assumes you already set up the database and roles as in [PostgreSQL storage](/storage#postgresql). It uses these names, which you replace with your own:

| Name | Meaning |
| --- | --- |
| `db.internal` | The PostgreSQL server's host name |
| `pgbouncer.internal` | The PgBouncer server's host name |
| `atomic` | The database Atomic uses |
| `atomic_runtime` | The role Atomic logs in as |
| `pgbouncer_auth` | A role PgBouncer uses only to look up passwords |

## When you need PgBouncer

Every connection an Atomic process opens counts against PostgreSQL's `max_connections`. [Count the connections Atomic needs](/storage#count-the-connections-atomic-needs) with this rule:

- An agent process uses up to `maxConnections` plus `readerMaxConnections`.
- An Intercom broker uses the same, plus 1 for wake-ups.

Add these up over every machine. If the total is more than the server has to share, even with `maxConnections` at 2, you need PgBouncer.

For example, 200 CI runners each run one agent process and one Intercom broker. That is 400 processes, of which 200 are brokers. The server has `max_connections = 300`, 3 slots reserved for administrators, and 10 connections used by other clients, so 287 are left for Atomic. With the smallest settings, `maxConnections: 1` and `readerMaxConnections: 0`, the processes need 400 × 1 + 200 = 600 connections. That is twice what the server has.

With PgBouncer, those 400 processes connect to PgBouncer instead. PgBouncer shares 80 connections to PostgreSQL between them, and the 200 brokers keep one direct connection each for wake-ups. That fits in 287.

## How Atomic works with PgBouncer

**Transaction mode.** Run PgBouncer in transaction mode. In this mode, PgBouncer lends a connection to PostgreSQL to a client for one transaction, then gives it to the next client. Atomic works this way:

- Settings that Atomic changes, such as the schema it uses and its time limits, last only for the transaction that set them.
- Locks that Atomic takes are released when the transaction ends.
- A statement outside a transaction is a transaction of its own.

So nothing Atomic does depends on keeping the same connection to PostgreSQL between transactions. Do not use statement mode, which breaks transactions.

**Wake-ups need a direct connection.** An Intercom broker learns about new messages through PostgreSQL's `LISTEN` command. `LISTEN` only works on a connection that stays with the broker, and transaction mode does not keep one. So point the `listenUrl` setting straight at PostgreSQL. Each broker then holds one direct connection for wake-ups, and all other work goes through PgBouncer.

If you leave out `listenUrl`, Atomic notices that it is behind a pooler and stops waiting for wake-ups. Brokers then check the database for new messages every half second instead of every 5 seconds. Messages still arrive, a little later, and the database gets more queries.

**Prepared statements.** A prepared statement is a query that PostgreSQL parses and plans once, then runs many times. Atomic can keep its frequent queries prepared, which saves the server work, but only if the pooler keeps track of them. The Atomic setting `maxPreparedStatements` controls this:

- By default, Atomic turns prepared statements off when `listenUrl` is set or the URL's port is 6432 or 6543. Most setups need nothing more.
- To use them through PgBouncer, you need PgBouncer 1.21 or later with `max_prepared_statements` above `0`. PgBouncer 1.24 and later set it to 200 by default. Then set `maxPreparedStatements` in Atomic to `256`.

```text
agent processes ──> PgBouncer :6432 ──> PostgreSQL :5432
Intercom brokers ──> PgBouncer :6432 ──> PostgreSQL :5432
                 └── wake-ups (listenUrl) ─────> PostgreSQL :5432
```

## Set up PostgreSQL

### Connection limits

PostgreSQL needs room for:

- PgBouncer's connections: its pool size plus its reserve pool, `default_pool_size` plus `reserve_pool_size` in the configuration below.
- One wake-up connection per Intercom broker.
- Administrators, monitoring, and other applications.

Set `max_connections` to at least their sum. Changing it needs a restart of PostgreSQL. On a managed service, change the server parameter in the service's console.

To stop Atomic's direct wake-up connections from taking slots that PgBouncer needs, you can cap the runtime role. Set the cap to the number of brokers plus a margin:

```sql
ALTER ROLE atomic_runtime CONNECTION LIMIT 220;
```

The cap counts every connection the role opens, including PgBouncer's connections for that role. Raise it if PgBouncer logs `too many connections for role "atomic_runtime"`.

### A role for password lookups

PgBouncer checks each client's password against the one PostgreSQL stores, so you do not keep a second copy of every password. It runs a lookup query as a role that can do nothing else. As a superuser, connected to the `atomic` database, run:

```sql
CREATE ROLE pgbouncer_auth LOGIN PASSWORD '<auth role password>';
CREATE SCHEMA pgbouncer;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;
CREATE FUNCTION pgbouncer.get_auth(p_usename text)
  RETURNS TABLE(usename text, passwd text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT rolname::text, rolpassword FROM pg_catalog.pg_authid
  WHERE rolname = p_usename
    AND rolcanlogin AND NOT rolsuper
    AND rolname = ANY (ARRAY['atomic_runtime', 'atomic_owner'])
    AND (rolvaliduntil IS NULL OR rolvaliduntil > now())
$$;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth;
```

The function runs with the rights of the superuser who created it, so `pgbouncer_auth` can read one password at a time without reading the password table itself. It returns only the roles you list, never a superuser, so no one can log in through PgBouncer as any other role. List every role your Atomic machines log in as. Declare the result with `RETURNS TABLE`, as above: PgBouncer refuses a lookup that returns a row of empty values, and logs `auth_query response contained null user name`.

When you change a role's password with `ALTER ROLE`, PgBouncer uses the new one at once. You do not need to reload it.

Passwords must use SCRAM, PostgreSQL's default since version 14. Check with `SHOW password_encoding;`, which should say `scram-sha-256`.

### Who may connect

PostgreSQL's `pg_hba.conf` file decides which hosts may log in. Allow PgBouncer's address, and the machines that run Intercom brokers for their wake-up connections, over TLS:

```text
# TYPE   DATABASE  USER            ADDRESS          METHOD
hostssl  atomic    atomic_runtime  10.0.1.5/32      scram-sha-256
hostssl  atomic    pgbouncer_auth  10.0.1.5/32      scram-sha-256
hostssl  atomic    atomic_runtime  10.0.2.0/24      scram-sha-256
```

Here `10.0.1.5` is PgBouncer and `10.0.2.0/24` is the network of the agent machines. Reload PostgreSQL after editing the file, for example with `SELECT pg_reload_conf();`.

## Configure PgBouncer

This configuration was tested with PgBouncer 1.26.1 in Docker, and a configuration like it with PgBouncer 1.25.1 on Ubuntu in front of PostgreSQL 18. Save it as `/etc/pgbouncer/pgbouncer.ini`:

```ini
;; Which databases PgBouncer offers, and where each one really is.
;; Atomic connects to "atomic" on PgBouncer, which forwards to PostgreSQL.
[databases]
atomic = host=db.internal port=5432 dbname=atomic

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432

;; Lend a PostgreSQL connection to a client for one transaction at a time.
pool_mode = transaction

;; Clients log in with their own PostgreSQL role and password, checked with SCRAM.
;; PgBouncer looks up the stored password through pgbouncer.get_auth, logged in as pgbouncer_auth.
auth_type = scram-sha-256
auth_user = pgbouncer_auth
auth_query = SELECT usename, passwd FROM pgbouncer.get_auth($1)
;; Holds only pgbouncer_auth's own password.
auth_file = /etc/pgbouncer/userlist.txt

;; TLS between Atomic and PgBouncer. PgBouncer presents this certificate.
client_tls_sslmode = require
client_tls_cert_file = /etc/pgbouncer/tls/pgbouncer.crt
client_tls_key_file = /etc/pgbouncer/tls/pgbouncer.key

;; TLS between PgBouncer and PostgreSQL. verify-full checks the server's certificate and host name.
server_tls_sslmode = verify-full
server_tls_ca_file = /etc/pgbouncer/tls/root.crt

;; How many clients may connect to PgBouncer. Count every Atomic process's pools:
;; processes x (maxConnections + readerMaxConnections), with room to spare.
max_client_conn = 5000

;; How many connections to PostgreSQL each database and role pair may use.
default_pool_size = 80
;; Extra connections lent when a client has waited reserve_pool_timeout seconds.
reserve_pool_size = 5
reserve_pool_timeout = 3
;; A hard cap on all connections to the atomic database.
max_db_connections = 85

;; Remember up to this many prepared statements per PostgreSQL connection.
;; Atomic uses them only when its maxPreparedStatements setting is above 0.
max_prepared_statements = 200

;; Close a PostgreSQL connection unused for 10 minutes, and replace any connection after 1 hour.
server_idle_timeout = 600
server_lifetime = 3600

;; Give up on a client that waited 2 minutes for a PostgreSQL connection.
query_wait_timeout = 120

;; Roles that may run SHOW commands on PgBouncer's console.
stats_users = pgbouncer_auth
```

Save the lookup role's password as `/etc/pgbouncer/userlist.txt`, readable only by the user PgBouncer runs as:

```text
"pgbouncer_auth" "<auth role password>"
```

PgBouncer needs this password in readable form, because it logs in to PostgreSQL with it. Every other role's password stays only in PostgreSQL.

### Choose the pool sizes

- **`default_pool_size`**: how many connections to PostgreSQL PgBouncer opens for Atomic's role. Start from what PostgreSQL can spare: `max_connections`, minus the reserved slots, minus one per Intercom broker for wake-ups, minus other clients, minus `reserve_pool_size`. More is not always faster. The [PostgreSQL wiki](https://wiki.postgresql.org/wiki/Number_Of_Database_Connections) suggests about twice the number of CPU cores as a starting point, so about 32 on a 16-core server. Raise it while `cl_waiting` in `SHOW POOLS` stays above `0` and the server's CPU has room.
- **`reserve_pool_size`**: a few extra connections for bursts. PgBouncer lends them only after a client has waited `reserve_pool_timeout` seconds.
- **`max_db_connections`**: a cap on all of PgBouncer's connections to the database. Set it to `default_pool_size` plus `reserve_pool_size`.
- **`max_client_conn`**: how many connections PgBouncer accepts from clients. Connections to PgBouncer are cheap, so set it well above the number of Atomic processes times their pools. Each client connection uses a file descriptor, so raise the PgBouncer server's open-file limit (`ulimit -n`, or `LimitNOFILE` in a systemd unit) above `max_client_conn`.

- **Lock waits hold connections.** In transaction mode, a transaction that waits for a lock keeps its PostgreSQL connection while it waits. When many agents send Intercom messages at once over a slow link, those waits can fill the pool, and every other client queues behind them. If `cl_waiting` climbs while `sv_active` sits at the cap, raise `default_pool_size` and `max_db_connections`, as far as `max_connections` allows.

With PgBouncer in front, keep Atomic's `maxConnections` at its default of 8 or higher. Atomic's connections only reach PgBouncer, which queues them for its pool.

### Start PgBouncer

Start PgBouncer with the configuration file, for example `pgbouncer -d /etc/pgbouncer/pgbouncer.ini`, or through your distribution's service, `systemctl restart pgbouncer`. After a change to the file, reload it from PgBouncer's console with `RELOAD;`.

The Ubuntu and Debian service starts PgBouncer with a limit of 1024 open files, which is too low for `max_client_conn = 5000`. PgBouncer logs `kernel file descriptor limit: 1024` at start. Raise the limit with a systemd drop-in, then restart:

```ini
# /etc/systemd/system/pgbouncer.service.d/limits.conf
[Service]
LimitNOFILE=16384
```

Run `systemctl daemon-reload` and `systemctl restart pgbouncer` after creating the file.

If PgBouncer runs on the database server and connects to PostgreSQL as `127.0.0.1`, the server's certificate does not name that address. Use `server_tls_sslmode = verify-ca` there, which checks the certificate authority without the host name, or connect by the name the certificate carries.

## Configure Atomic

Point `url` at PgBouncer and `listenUrl` at PostgreSQL. Both use the runtime role and the same password. In `~/.atomic/agent/settings.json`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@pgbouncer.internal:6432/atomic",
      "listenUrl": "postgresql://atomic_runtime@db.internal:5432/atomic",
      "maxConnections": 8
    },
    "secrets": { "password": { "file": "agent/storage-token.3f2a" } }
  }
}
```

The password file is the one `atomic storage join` writes. To create the block, join with the PgBouncer URL, then add `listenUrl` and restart Intercom:

```bash
atomic storage join 'postgresql://atomic_runtime@pgbouncer.internal:6432/atomic' --password-file ~/atomic-db-password
atomic intercom restart
```

Atomic checks the certificate and host name of both PgBouncer and PostgreSQL. If PgBouncer's certificate comes from a private certificate authority, add `?sslrootcert=/path/to/root.crt` to `url`. See [TLS](/storage#tls).

The same options in an SDK app:

```typescript
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@pgbouncer.internal:6432/atomic",
	listenUrl: "postgresql://atomic_runtime@db.internal:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 8,
});
```

## Check that it works

**Atomic.** Run `atomic storage status` on an agent machine. It should report `wake-ups: LISTEN/NOTIFY`. If it reports `wake-ups: polling only, notifications do not pass the URL's transaction pooler`, `listenUrl` is missing or points at PgBouncer.

**PgBouncer.** Connect to PgBouncer's console, a built-in database named `pgbouncer`, as a role listed in `stats_users`:

```bash
psql -h pgbouncer.internal -p 6432 -U pgbouncer_auth pgbouncer -c 'SHOW POOLS'
```

`SHOW POOLS` prints one row per database and role. In the row for `atomic` and `atomic_runtime`:

| Column | Meaning | What to look for |
| --- | --- | --- |
| `cl_active` | Clients connected to PgBouncer | Roughly the number of Atomic connections. |
| `cl_waiting` | Clients waiting for a PostgreSQL connection | `0` most of the time. A number that stays above `0` means the pool is too small or the server too slow. |
| `sv_active` | PostgreSQL connections running a transaction | At most `default_pool_size` plus `reserve_pool_size`. |
| `sv_idle` | PostgreSQL connections ready for the next transaction | Some idle connections are normal. |
| `maxwait` | How many seconds the oldest waiting client has waited | Below a second. Higher values mean clients queue for the pool. |
| `pool_mode` | The pool mode | `transaction` |

`SHOW CLIENTS` lists each client connection, and `SHOW STATS` shows queries and wait times per database.

**PostgreSQL.** As an administrator, count the connections by application and state. PgBouncer's connections report Atomic's application name `atomic`, and each broker's wake-up connection reports `atomic-listen`:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

The `atomic` connections should stay at or below PgBouncer's pool size, and there should be one `atomic-listen` connection per broker.

## Results from a 200-agent test

We ran 200 simulated agent runners through PgBouncer 1.25.1 to PostgreSQL 18, with a configuration like the one above: `default_pool_size = 80`, `max_db_connections = 90`, and `max_client_conn = 2000`. Each runner opened two Atomic database handles and one Intercom broker, 10 runners to a process.

| Round trip to the server | Pool | Server connections | Waiting clients | Save entries to a session, p50 / p95 | Errors |
| --- | --- | --- | --- | --- | --- |
| About 10 ms | 80 | 216 to 218: 200 for wake-ups, 13 to 18 pooled | 0 | 23 ms / 32 ms | 0 of 14,870 calls |
| About 90 ms | 80 | Pool full at 90 | Up to 661, waiting up to 14 seconds | 8.9 s / 18 s | |
| About 90 ms | 170 | Up to 170 pooled | Up to 10, no wait | 188 ms / 203 ms | 112 of 10,981 calls, all lock timeouts (`55P03`) on Intercom send, lease, claim and delivery calls |

What this shows:

- With the database close to the agents, 80 pooled connections serve 200 agents with room to spare. Only 13 to 18 were in use at a time.
- With the database far away, transactions last longer and lock waits hold connections, so the same pool fills up. A larger pool removed the queue. The remaining errors were lock timeouts between agents sending, claiming and delivering Intercom messages at once, which PgBouncer does not cause.
- Turning on prepared statements (`maxPreparedStatements: 256`) worked through PgBouncer but did not change these times. Leave it unset unless your own measurements show a gain.

## Common errors

Atomic reports these as `StorageUnavailableError` or `StorageTransientError`. The message below is the error's cause, which Atomic prints with the error. The first four were reproduced through PgBouncer 1.26.1 with the configuration above, and seen again with PgBouncer 1.25.1 on a production server. The two PostgreSQL messages were reproduced against PostgreSQL 16. The `bouncer config error` and file-limit rows were seen on that production server.

| Message | Cause | Fix |
| --- | --- | --- |
| `no more connections allowed (max_client_conn)` | More clients connected to PgBouncer than `max_client_conn` allows. | Raise `max_client_conn`, and the open-file limit with it. |
| `query_wait_timeout` | A client waited `query_wait_timeout` seconds for a PostgreSQL connection. | Check `cl_waiting` and `maxwait` in `SHOW POOLS`. Raise `default_pool_size` if PostgreSQL has room, or look for long transactions with the queries in [Tuning](/storage#check-the-effect). |
| `SSL required` | Atomic connected without TLS. Atomic leaves TLS off for addresses on the same machine, such as `localhost`. | Add `?sslmode=verify-full&sslrootcert=/path/to/root.crt` to `url`. |
| `SASL authentication failed` | The password is wrong, the role does not exist, or the database is not listed in `[databases]`. | Check the password file, the role, and the database name. Check that the lookup function exists in that database. |
| `wake-ups: polling only, notifications do not pass the URL's transaction pooler` in `atomic storage status` | `listenUrl` is missing or points at PgBouncer. | Set `listenUrl` to PostgreSQL's own address. |
| `too many connections for role "atomic_runtime"` | The role's `CONNECTION LIMIT` is lower than PgBouncer's pool plus the brokers' wake-up connections. | Raise the limit, or lower `default_pool_size`. |
| `sorry, too many clients already` | PostgreSQL's `max_connections` is lower than PgBouncer's pool plus the wake-up and other connections. | Raise `max_connections`, or lower `default_pool_size` and `max_db_connections`. |
| `prepared statement "atomic_…" does not exist` | Atomic's `maxPreparedStatements` is above `0`, but PgBouncer does not keep prepared statements: it is older than 1.21, or `max_prepared_statements` is `0`. | Set `max_prepared_statements` above `0` in PgBouncer, or set `maxPreparedStatements` to `0` in Atomic. |
| `unsupported startup parameter: <name>` | A client sent a connection setting that PgBouncer does not forward. Atomic sends only `application_name`, which PgBouncer forwards. | Add the name to `ignore_startup_parameters` for other clients that need it, such as `extra_float_digits` for Java clients. Never add `application_name`. |
| `bouncer config error`, with `auth_query response contained null user name` in PgBouncer's log | The lookup function returned a row of empty values for an unknown role. | Declare the function with `RETURNS TABLE`, as in [A role for password lookups](#a-role-for-password-lookups). |
| `kernel file descriptor limit: 1024` in PgBouncer's log | The service's open-file limit is below `max_client_conn`. | Raise `LimitNOFILE`, as in [Start PgBouncer](#start-pgbouncer). |

## Managed services

These services include a pooler of their own. We have not tested Atomic through them. The notes come from each service's documentation.

- **Supabase.** The shared pooler, Supavisor, runs transaction mode on port 6543. Point `url` at port 6543 and `listenUrl` at the direct connection on port 5432. Supavisor does not keep prepared statements, so leave `maxPreparedStatements` at its default, which is `0` on port 6543.
- **Neon.** The pooled host name ends in `-pooler` and runs PgBouncer in transaction mode. Point `url` at the pooled host and `listenUrl` at the same host name without `-pooler`.
- **Azure Database for PostgreSQL Flexible Server.** Turn on the built-in PgBouncer with the `pgbouncer.enabled` server parameter, on General Purpose and Memory Optimized tiers. It listens on port 6432 of the same host. Point `listenUrl` at port 5432.
- **Amazon RDS Proxy.** RDS Proxy does not pass `LISTEN`, so point `listenUrl` at the database instance's own endpoint. RDS Proxy may keep a client on one database connection ("pinning") when it sees session settings. We have not checked whether Atomic's statements cause pinning. Watch the proxy's pinning metrics in CloudWatch.

On a managed service where you cannot create a superuser function, use the service's pooler instead of `auth_query`, or list each role's password in PgBouncer's `auth_file`.

## Related pages

- [Tuning for many concurrent agents](/storage#tuning-for-many-concurrent-agents): count connections and size `maxConnections`.
- [Tune PostgreSQL for many agents](/guides/postgres-tuning): the server-side settings that go with PgBouncer.
- [Connection poolers](/storage#connection-poolers) and [Wake-ups](/storage#wake-ups) in the storage guide.
- [PgBouncer's configuration reference](https://www.pgbouncer.org/config.html).
