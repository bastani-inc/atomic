---
title: "Use PgBouncer with PostgreSQL"
sidebarTitle: "PgBouncer"
description: "Run PgBouncer in transaction mode between Atomic and PostgreSQL when agent processes exceed the server's connection limit, with TLS, SCRAM auth, pool sizing, and checks."
---

PgBouncer is a lightweight connection pooler that sits between Atomic and PostgreSQL. Thousands of client connections from Atomic terminate at PgBouncer, which multiplexes their transactions over a few dozen server connections to PostgreSQL.

This guide builds on [PostgreSQL setup](/storage/postgres) and uses these placeholder names:

| Placeholder | Meaning |
| --- | --- |
| `db.example.com` | PostgreSQL server hostname |
| `pgbouncer.example.com` | PgBouncer server hostname |
| `atomic` | Atomic database name |
| `atomic_runtime` | Runtime role that agent machines connect as |
| `pgbouncer_auth` | Restricted lookup role PgBouncer uses to verify passwords |

## When you need PgBouncer

Every connection an Atomic process opens counts against PostgreSQL's `max_connections` ([count your connections](/storage/postgres#count-the-connections-atomic-needs)):

- **Agent process:** up to `maxConnections + readerMaxConnections`
- **Intercom broker:** up to `maxConnections + readerMaxConnections + 1` (for wake-ups)

If PostgreSQL cannot spare at least `maxConnections: 2` per process across your fleet, deploy PgBouncer.

**Example:** 150 CI runners each run 1 agent and 1 Intercom broker (300 processes, 150 brokers) against a server with `max_connections = 300`, 3 reserved admin slots, and 10 non-Atomic clients (287 slots available). Even at `maxConnections: 1` and `readerMaxConnections: 0`, the fleet needs `300 + 150 = 450` connections. With PgBouncer, all 300 processes connect to PgBouncer, the 150 brokers hold 1 direct wake-up connection each (`287 − 150 = 137` slots left), and PgBouncer multiplexes all 300 processes over an 85-connection server pool (`80 + 5` reserve, totaling 235 server connections).

## How Atomic works with PgBouncer

**Transaction mode.** Run PgBouncer with `pool_mode = transaction`. PgBouncer lends a PostgreSQL backend connection to a client for one transaction and returns it to the pool as soon as the transaction commits or rolls back. Atomic scopes every session setting (`search_path`, timeouts) and advisory lock to the transaction, so nothing depends on pinning a backend connection between transactions.

<Warning>
Never use `pool_mode = statement` with Atomic—statement pooling breaks multi-statement transactions.
</Warning>

**Direct wake-ups via `listenUrl`.** Intercom brokers receive instant message notices via PostgreSQL `LISTEN`/`NOTIFY`, which requires a persistent backend connection that transaction pooling cannot maintain. Point `listenUrl` directly at PostgreSQL so each broker opens one direct `atomic-listen` connection while all other queries flow through PgBouncer.

If you omit `listenUrl`, Atomic detects the pooler and falls back to polling wake-up hints every 0.5 seconds (instead of instant notifications with a 5-second hint poll and 30-second backup outbox scan). Messages still arrive, at slightly higher latency and query volume.

**Prepared statements.** PostgreSQL plans a prepared statement once and reuses the plan. PgBouncer 1.21+ tracks prepared statements across transaction pooling when `max_prepared_statements > 0` (PgBouncer 1.24+ defaults this to `200`). Atomic probes PgBouncer on its first connection and configures prepared statements automatically:

- **PgBouncer 1.21+ with `max_prepared_statements > 0`:** enabled automatically.
- **Older PgBouncer, `max_prepared_statements = 0`, Supavisor, or unknown poolers:** disabled automatically to avoid missing-statement errors.
- **Pooler on a port other than `6432` or `6543`:** Atomic may not infer a pooler automatically—set `listenUrl` or `maxPreparedStatements: 0`.

Setting `maxPreparedStatements` explicitly overrides auto-detection (`0` forces off, `256` forces on). If PgBouncer's `max_prepared_statements` is later lowered to `0` at runtime, Atomic retries the failed query once and disables prepared statements for the remainder of the process.

```text
agent processes ──> PgBouncer :6432 ──> PostgreSQL :5432
Intercom brokers ──> PgBouncer :6432 ──> PostgreSQL :5432
                 └── wake-ups (listenUrl) ─────> PostgreSQL :5432
```

## Set up PostgreSQL

### Connection limits

Size PostgreSQL's `max_connections` (requires restart) to cover:

- PgBouncer's server pool (`default_pool_size + reserve_pool_size`)
- One wake-up connection per Intercom broker (when using `listenUrl`)
- Administrators, monitoring, and other applications

Cap `atomic_runtime` so a runaway fleet cannot exhaust admin slots. The cap includes both PgBouncer's pooled connections for `atomic_runtime` and direct broker wake-up connections (for the 150-runner example: `85 + 150 = 235`, plus margin):

```sql
ALTER ROLE atomic_runtime CONNECTION LIMIT 250;
```

Raise this cap if PgBouncer logs `too many connections for role "atomic_runtime"`.

### A role for password lookups

Instead of duplicating user passwords in PgBouncer, configure `auth_query` with a restricted lookup role (`pgbouncer_auth`). Creating this function requires a superuser; on managed services without superuser access, use the provider's built-in pooler or list roles in PgBouncer's `auth_file`.

Connected to the `atomic` database as a superuser, run:

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

`SECURITY DEFINER` lets `pgbouncer_auth` look up only the allowlisted non-superuser roles without direct access to `pg_authid`. List every role Atomic machines log in as, and keep `RETURNS TABLE`—a scalar/record null row causes PgBouncer to log `auth_query response contained null user name`. Password changes via `ALTER ROLE` take effect immediately without reloading PgBouncer. Verify SCRAM encoding with `SHOW password_encoding;` (`scram-sha-256`).

### Who may connect

Allow PgBouncer, agent hosts (for direct `listenUrl` wake-ups), and your migration host over TLS in `pg_hba.conf`, then reload with `SELECT pg_reload_conf();`:

```text
# TYPE   DATABASE  USER            ADDRESS          METHOD
hostssl  atomic    atomic_runtime  10.0.1.5/32      scram-sha-256
hostssl  atomic    pgbouncer_auth  10.0.1.5/32      scram-sha-256
hostssl  atomic    atomic_runtime  10.0.2.0/24      scram-sha-256
hostssl  atomic    atomic_owner    10.0.3.10/32     scram-sha-256
```

Here `10.0.1.5` is PgBouncer, `10.0.2.0/24` is the agent subnet, and `10.0.3.10` runs `atomic storage migrate` directly against PostgreSQL on port `5432` (never through PgBouncer).

## Configure PgBouncer

Save this configuration (for PgBouncer 1.21+) as `/etc/pgbouncer/pgbouncer.ini`:

```ini
;; Which databases PgBouncer offers, and where each one really is.
;; Atomic connects to "atomic" on PgBouncer, which forwards to PostgreSQL.
[databases]
atomic = host=db.example.com port=5432 dbname=atomic

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

;; TLS between Atomic and PgBouncer. PgBouncer presents this certificate, which must name pgbouncer.example.com.
client_tls_sslmode = require
client_tls_cert_file = /etc/pgbouncer/tls/pgbouncer.crt
client_tls_key_file = /etc/pgbouncer/tls/pgbouncer.key

;; TLS between PgBouncer and PostgreSQL. verify-full checks the server's certificate and host name.
;; root.crt is the certificate authority that signed PostgreSQL's certificate.
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
;; Atomic finds this setting and uses prepared statements when it is above 0.
max_prepared_statements = 200

;; Close a PostgreSQL connection unused for 10 minutes, and replace any connection after 1 hour.
server_idle_timeout = 600
server_lifetime = 3600

;; Give up on a client that waited 2 minutes for a PostgreSQL connection.
query_wait_timeout = 120

;; Roles that may run SHOW commands on PgBouncer's console.
stats_users = pgbouncer_auth
```

Save `pgbouncer_auth`'s password in `/etc/pgbouncer/userlist.txt`, readable only by the PgBouncer service user:

```text
"pgbouncer_auth" "<auth role password>"
```

Only `pgbouncer_auth` needs its password in `userlist.txt`; all other role passwords remain solely inside PostgreSQL.

### Choose the pool sizes

- **`default_pool_size`:** Server connections PgBouncer opens for `atomic_runtime`. Must not exceed PostgreSQL's remaining capacity (`max_connections` minus reserved slots, broker wake-ups, other clients, and `reserve_pool_size`—132 in the 150-runner example). Start near 2× server CPU cores (for example `32` on a 16-core server; `80` above assumes ~40 cores) and raise only if `cl_waiting > 0` in `SHOW POOLS` while PostgreSQL CPU has headroom. Higher network latency between agents and PostgreSQL requires a slightly larger pool.
- **`reserve_pool_size`:** Burst slots lent after a client waits `reserve_pool_timeout` seconds.
- **`max_db_connections`:** Hard cap on total server connections for `atomic` (`default_pool_size + reserve_pool_size`).
- **`max_client_conn`:** Client connections accepted by PgBouncer. Set well above `processes × (maxConnections + readerMaxConnections)`, and raise the OS open-file limit (`ulimit -n` / `LimitNOFILE`) above `max_client_conn`.
- **Lock waits hold pool slots:** Transactions waiting on locks retain their PostgreSQL backend connection. If `cl_waiting` climbs while `sv_active` hits the cap, raise `default_pool_size` and `max_db_connections` within `max_connections`.

Behind PgBouncer, keep Atomic's `maxConnections` at its default of `8` or higher—PgBouncer queues client transactions for its server pool.

### Start PgBouncer

Start PgBouncer (`pgbouncer -d /etc/pgbouncer/pgbouncer.ini` or `systemctl restart pgbouncer`). After subsequent edits to `pgbouncer.ini`, run `RELOAD;` on PgBouncer's admin console.

<Warning>
**Ubuntu and Debian default `LimitNOFILE=1024`.** The distro unit starts PgBouncer with only 1,024 file descriptors—too low for `max_client_conn = 5000` (logged as `kernel file descriptor limit: 1024`). Raise the limit with a systemd drop-in, then run `systemctl daemon-reload && systemctl restart pgbouncer`:
</Warning>

```ini
# /etc/systemd/system/pgbouncer.service.d/limits.conf
[Service]
LimitNOFILE=16384
```

<Note>
If PgBouncer runs on the PostgreSQL host and connects via `127.0.0.1`, PostgreSQL's certificate typically does not include `127.0.0.1`. Use `server_tls_sslmode = verify-ca`, or connect via the hostname on the server certificate.
</Note>

## Configure Atomic

Point `url` at PgBouncer and `listenUrl` directly at PostgreSQL (both use `atomic_runtime` and the same password). On each agent machine:

<Steps>
  <Step title="Join the database through PgBouncer">
    ```bash
    (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
    atomic storage join 'postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic' --password-file ~/atomic-db-password
    rm ~/atomic-db-password  # atomic storage join keeps its own copy
    ```
  </Step>
  <Step title="Add listenUrl to ~/.atomic/agent/settings.json">
    `atomic storage join` does not set `listenUrl`, so add the direct PostgreSQL endpoint:

    ```bash
    jq '.storage.options.listenUrl = "postgresql://atomic_runtime@db.example.com:5432/atomic"' ~/.atomic/agent/settings.json > ~/.atomic/agent/settings.json.new \
      && mv ~/.atomic/agent/settings.json.new ~/.atomic/agent/settings.json
    ```
  </Step>
  <Step title="Restart Intercom and verify wake-ups">
    ```bash
    atomic intercom restart
    atomic storage status
    ```

    Confirm `atomic storage status` reports `wake-ups: LISTEN/NOTIFY`.
  </Step>
</Steps>

The resulting `~/.atomic/agent/settings.json` entry looks like this (keep the exact `storage-token.<id>` filename that `atomic storage join` created on your machine; `storage-token.example` is a placeholder):

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
      "listenUrl": "postgresql://atomic_runtime@db.example.com:5432/atomic",
      "maxConnections": 8
    },
    "secrets": { "password": { "file": "agent/storage-token.example" } }
  }
}
```

Atomic verifies the certificate and hostname of both PgBouncer and PostgreSQL; append `?sslrootcert=/path/to/root.crt` if signed by a private CA (see [TLS](/storage/postgres#tls)).

Equivalent SDK configuration:

```typescript
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
	listenUrl: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 8,
});
```

## Check that it works

**Atomic:** Run `atomic storage status` on an agent host and confirm `wake-ups: LISTEN/NOTIFY` (or `wake-ups: connecting` immediately after restart). If it shows `polling only, notifications do not pass the URL's transaction pooler`, check that `listenUrl` points directly to PostgreSQL.

**PgBouncer:** Inspect the `atomic` / `atomic_runtime` row via PgBouncer's console:

```bash
psql -h pgbouncer.example.com -p 6432 -U pgbouncer_auth pgbouncer -c 'SHOW POOLS'
```

| Column | Meaning | Healthy value |
| --- | --- | --- |
| `cl_active` | Client connections to PgBouncer | Roughly total Atomic client pool connections |
| `cl_waiting` | Clients waiting for a PostgreSQL backend | `0` most of the time; sustained `> 0` indicates pool saturation or slow queries |
| `sv_active` | Active PostgreSQL server connections | At most `default_pool_size + reserve_pool_size` |
| `sv_idle` | Ready PostgreSQL server connections | Some idle connections are normal |
| `maxwait` | Seconds the oldest waiting client has waited | `< 1` second |
| `pool_mode` | Active pooling mode | `transaction` |

Use `SHOW CLIENTS` and `SHOW STATS` for per-client details and query/wait totals.

**PostgreSQL:** Verify pooled (`atomic`) and direct wake-up (`atomic-listen`) counts on the database server:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

`atomic` connections should stay at or below PgBouncer's `max_db_connections`, with one `atomic-listen` connection per broker.

## Common errors

Atomic wraps these causes in `StorageUnavailableError` or `StorageTransientError`:

| Message | Cause | Fix |
| --- | --- | --- |
| `no more connections allowed (max_client_conn)` | Client connections exceeded `max_client_conn`. | Raise `max_client_conn` and `LimitNOFILE`. |
| `query_wait_timeout` | Client waited past `query_wait_timeout` for a server connection. | Check `cl_waiting` / `maxwait` in `SHOW POOLS`, raise `default_pool_size` if PostgreSQL has capacity, or check [active waits](/storage/postgres#check-the-effect). |
| `SSL required` | Connected without TLS (Atomic skips TLS for `localhost` by default). | Append `?sslmode=verify-full&sslrootcert=/path/to/root.crt` to `url`. |
| `SASL authentication failed` | Wrong password, unknown role, missing `[databases]` entry, or missing `pgbouncer.get_auth`. | Verify password, role allowlist, database entry, and lookup function. |
| `wake-ups: polling only, notifications do not pass the URL's transaction pooler` | `listenUrl` is unset or points at PgBouncer. | Point `listenUrl` directly at PostgreSQL. |
| `too many connections for role "atomic_runtime"` | Role `CONNECTION LIMIT` is below PgBouncer's pool plus broker wake-ups. | Raise `CONNECTION LIMIT` or lower `default_pool_size`. |
| `sorry, too many clients already` | PostgreSQL `max_connections` is too low for pool + wake-ups + other clients. | Raise `max_connections` or lower `default_pool_size` and `max_db_connections`. |
| `prepared statement "atomic_…" does not exist` | Prepared statements forced on behind a pooler that drops them, or `max_prepared_statements` was zeroed at runtime. | Set `max_prepared_statements > 0` in PgBouncer 1.21+, or set `maxPreparedStatements: 0` in Atomic. |
| `unsupported startup parameter: <name>` | Another client sent a startup parameter PgBouncer does not forward (Atomic sends only `application_name`). | Add that parameter to `ignore_startup_parameters` (never add `application_name`). |
| `bouncer config error` / `auth_query response contained null user name` | `pgbouncer.get_auth` returned a null row for an unknown role. | Declare with `RETURNS TABLE` as in [A role for password lookups](#a-role-for-password-lookups). |
| `kernel file descriptor limit: 1024` | Service `LimitNOFILE` is below `max_client_conn`. | Raise `LimitNOFILE` (see [Start PgBouncer](#start-pgbouncer)). |

## Managed services

| Provider | Pooled endpoint (`url`) | Direct endpoint (`listenUrl`) | Prepared statements |
| --- | --- | --- | --- |
| **Supabase** | Supavisor transaction mode on port `6543` | Direct host on port `5432` | Leave `maxPreparedStatements` unset (auto-disabled behind Supavisor) |
| **Neon** | `-pooler` host (PgBouncer transaction mode) | Same host without `-pooler` | Auto-detected |
| **Azure Flexible Server** | Built-in PgBouncer (`pgbouncer.enabled`) on port `6432` | Same host on port `5432` | Auto-detected |
| **Amazon RDS Proxy** | Proxy endpoint (port `5432`) | DB instance endpoint | Set `maxPreparedStatements: 0` explicitly (port `5432` does not auto-detect a pooler) |

## Related pages

- [Tuning for many concurrent agents](/storage/postgres#tuning-for-many-concurrent-agents): connection arithmetic and `maxConnections` sizing.
- [Tune PostgreSQL for many agents](/storage/postgres/tuning): server memory, `pg_stat_statements`, autovacuum, and `lz4` compression.
- [Connection poolers](/storage/postgres#connection-poolers) and [Wake-ups](/storage/postgres#wake-ups).
- [PgBouncer configuration reference](https://www.pgbouncer.org/config.html).
