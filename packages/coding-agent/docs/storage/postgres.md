---
title: "PostgreSQL setup"
sidebarTitle: "Setup"
description: "Share Atomic's sessions and Intercom across machines, a team, or CI with one PostgreSQL database: set up roles, join machines, connect through TLS, proxies, and poolers, size connections, and fix common errors."
---

Use PostgreSQL when more than one machine should see the same sessions and Intercom messages: a team, a CI fleet, or one person on several computers. Every machine that joins the database sees the same sessions, and its agents can message agents on the other machines. For one person on one machine, the default [local SQLite](/storage/sqlite) store needs no setup and is the better choice.

This page is for the person who sets up the database and the people who connect their machines to it. It covers:

- creating the database and its roles;
- joining a machine;
- TLS, HTTP proxies, poolers, and cloud identities;
- how many connections Atomic opens, and how to size them for many agents;
- fixes for common errors.

Requirements:

- **PostgreSQL 16 or newer.** Atomic keeps sessions only on PostgreSQL 16 or newer.
- **The PostgreSQL adapter, `@bastani/atomic-storage-postgres`,** installed on every machine that connects. [Join a machine](#join-a-machine) shows how.

Self-hosted PostgreSQL works, and so do managed services: Azure Database for PostgreSQL Flexible Server, Azure HorizonDB, Amazon RDS and Aurora PostgreSQL, Google Cloud SQL, AlloyDB, Neon, and Supabase.

A new PostgreSQL server allows 100 connections, and each Atomic process can open up to 10, or 11 for an Intercom broker. If you will run more than a few Atomic processes, read [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) before you start. When your agents need more connections than the server allows, put [PgBouncer](/storage/postgres/pgbouncer) in front of it. To tune the server itself, see [Server tuning](/storage/postgres/tuning).

## Set up the database

Atomic keeps its tables in their own schema, `atomic`, rather than `public`. A shared deployment uses two roles:

- **The owner role** owns the database and the `atomic` schema. It creates and upgrades Atomic's tables with `atomic storage migrate`.
- **The runtime role** is the role every machine connects as. It reads and writes rows, and cannot change the schema.

With two roles, a machine that connects as the runtime role can never change or drop Atomic's tables. Every machine can use the same runtime role, or you can create one login role per person with the same grants as `atomic_runtime`. For one person testing on one machine, a single role that owns the database is enough. Atomic then creates its tables the first time it opens the database.

1. **Create the roles and the database.** Connect as the server's administrator, a superuser or the managed service's administrator role, and run:

   ```sql
   CREATE ROLE atomic_owner LOGIN PASSWORD '<owner password>';
   CREATE ROLE atomic_runtime LOGIN PASSWORD '<runtime password>';
   -- On a managed service whose administrator is not a superuser, such as Azure, RDS, or Cloud SQL:
   -- GRANT atomic_owner TO <administrator>;
   CREATE DATABASE atomic OWNER atomic_owner;
   REVOKE ALL ON DATABASE atomic FROM PUBLIC;
   GRANT CONNECT ON DATABASE atomic TO atomic_owner, atomic_runtime;
   ```

   Owning the database lets `atomic_owner` create the `atomic` schema. On a managed service whose administrator is not a superuser, remove the `--` before the `GRANT` line, so the administrator may create a database owned by `atomic_owner`.

2. **Allow the machines to connect, over TLS.** On a self-hosted server, turn TLS on first, as [TLS](#tls) explains, because Atomic checks the server's certificate by default. Then `pg_hba.conf` decides who may log in. Allow the agent machines as the runtime role, and the machine you run `atomic storage migrate` on as the owner role. Then reload the server, for example with `SELECT pg_reload_conf();`:

   ```text
   # TYPE   DATABASE  USER            ADDRESS          METHOD
   hostssl  atomic    atomic_runtime  10.0.2.0/24      scram-sha-256
   hostssl  atomic    atomic_owner    10.0.3.10/32     scram-sha-256
   ```

   Managed services use firewall rules instead, and have TLS on already.

3. **Create Atomic's tables.** On a machine with Atomic installed, install the PostgreSQL adapter, save the owner's password in a file that only you can read, and run `atomic storage migrate` as the owner role. Connect to PostgreSQL directly, not through a pooler:

   ```bash
   atomic install npm:@bastani/atomic-storage-postgres
   (umask 077; printf 'Owner password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-owner-password)
   atomic storage migrate --db 'postgresql://atomic_owner@db.example.com:5432/atomic' --password-file ~/atomic-owner-password
   ```

   It prints what it set up:

   ```text
   Atomic's tables in PostgreSQL postgresql://db.example.com:5432/atomic via @bastani/atomic-storage-postgres are set up for this version: sessions and Intercom.
   ```

   `--password-file`, `--token-file`, `--auth`, and `--prefix` only work together with `--db`. Without `--db`, `atomic storage migrate` upgrades the database this machine's `storage` setting names.

4. **Give the runtime role its privileges.** Connect to the `atomic` database as `atomic_owner` and run:

   ```sql
   GRANT USAGE ON SCHEMA atomic TO atomic_runtime;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO atomic_runtime;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atomic TO atomic_runtime;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA atomic TO atomic_runtime;
   ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atomic_runtime;
   ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO atomic_runtime;
   ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO atomic_runtime;
   ```

   These are all the privileges the runtime role needs. The `ALTER DEFAULT PRIVILEGES` statements cover tables that later Atomic upgrades add, so you run them once. Intercom's notifications and locks need no extra grants.

5. **Join each machine as the runtime role.** See [Join a machine](#join-a-machine). If you will put PgBouncer in front of the server, set it up first and join with its address, as [Configure Atomic](/storage/postgres/pgbouncer#configure-atomic) shows.

Notes for managed services:

- **Azure Database for PostgreSQL Flexible Server.** Run the statements as the server administrator, a member of `azure_pg_admin`. If you set the `schema` option to `public`, also run `GRANT CREATE ON SCHEMA public TO atomic_owner;`.
- **Google Cloud SQL.** Run the statements as `postgres` or another member of `cloudsqlsuperuser`.

If the runtime role lacks a privilege, or the tables are older than the Atomic release that opens them, opening the database fails with `StorageConfigError` and reason `missing-privilege`. The error names the `GRANT` statement or the `atomic storage migrate` command to run.

### After each Atomic upgrade

Run `atomic storage migrate` as the owner role once after you upgrade Atomic, before you start many agents. The runtime role cannot change the schema. If an upgrade needs new tables, machines that connect as the runtime role fail with `missing-privilege` until you run it. Otherwise they keep working, but without the improvements only the owner can apply:

- Saving new entries to a session waits for the server once instead of twice, so saves are faster.
- The busy sessions and Intercom tables leave room on each page for updates, which keeps them faster to update and smaller. See [Server tuning](/storage/postgres/tuning#updates-that-stay-on-their-page).
- Autovacuum cleans the busy tables sooner, and large values use the faster `lz4` compression where the server supports it. See [Server tuning](/storage/postgres/tuning).
- On Azure, session history search gets its index once the `pg_trgm` extension is allowed. See [Azure](#azure).

Running it on a database that is already current changes nothing.

### Share one database between teams

Give each team or project its own database, or its own `prefix`. A prefix starts the name of every table Atomic creates, so several groups can use one database without seeing each other's sessions. There is no prefix by default. Pass the same `--prefix` to `atomic storage migrate` and to every `atomic storage join` of that group. A machine with another prefix sees none of the group's sessions.

On PostgreSQL, a prefix is at most 24 lowercase ASCII characters. A longer prefix fails with `StoragePrefixError` and reason `too-long`. Uppercase letters fail with reason `uppercase`.

### Upgrading from tables in `public`

Older releases created Atomic's tables in the `public` schema. Atomic keeps using those tables until you move them:

1. Upgrade Atomic on every machine.
2. Run `atomic storage migrate` once, as the role that owns the tables in `public`. It moves every Atomic table to the `atomic` schema in one transaction.
3. Give the runtime role its privileges on `atomic`, as in step 4 of [Set up the database](#set-up-the-database).
4. Restart every Atomic process that opened the database before the move.

A process that still writes to `public` after the move is refused, so no data lands in the wrong schema. If an older process created a table in `public` after the move anyway, the next `atomic storage migrate` names it and fails rather than lose it.

## Join a machine

Joining points a machine's Atomic at the shared database. Run these steps on every machine, as the user who runs Atomic:

1. **Install the PostgreSQL adapter.** It is a separate package, so you install it once per machine.

   ```bash
   atomic install npm:@bastani/atomic-storage-postgres
   ```

2. **Save the runtime role's password in a file** that only you can read. This command asks for the password, so it stays out of your shell history:

   ```bash
   (umask 077; printf 'Runtime password: '; read -rs password; printf '\n'; printf '%s' "$password" > ~/atomic-db-password)
   ```

3. **Join the database.**

   ```bash
   atomic storage join 'postgresql://atomic_runtime@db.example.com:5432/atomic' --password-file ~/atomic-db-password
   ```

   It prints what it did:

   ```text
   Connected to postgresql://atomic_runtime@db.example.com:5432/atomic.
   Stored the password in /home/me/.atomic/agent/storage-token.28ab7041-05e2-4ad5-80af-854329035d8c (mode 600).
   Set `storage` in /home/me/.atomic/agent/settings.json; other settings are unchanged.
   Run `atomic storage status` to check each domain.
   ```

4. **Restart Intercom and check the result.** The Intercom broker is the background process on each machine that passes messages between agents. Restart it so it uses the shared database. The command is safe when no broker is running. Sessions that are already open keep their old store until you restart them.

   ```bash
   atomic intercom restart
   atomic storage status
   ```

   `atomic storage status` exits with code `0` when everything answered, and prints something like this:

   ```text
   Sessions: PostgreSQL postgresql://db.example.com:5432/atomic via @bastani/atomic-storage-postgres
     source:      global settings: storage
     adapter:     loaded (from /home/me/.atomic/agent/npm/node_modules/@bastani/atomic-storage-postgres/postgres.js)
     connection:  ok (postgres postgresql://db.example.com:5432/atomic answered in 20 ms, PostgreSQL 17.12; wake-ups: LISTEN/NOTIFY)

   Intercom: PostgreSQL postgresql://db.example.com:5432/atomic via @bastani/atomic-storage-postgres
     source:      global settings: storage
     adapter:     loaded (from /home/me/.atomic/agent/npm/node_modules/@bastani/atomic-storage-postgres/postgres.js)
     connection:  ok (postgres postgresql://db.example.com:5432/atomic answered in 11 ms, PostgreSQL 17.12; wake-ups: LISTEN/NOTIFY)
     multi-node:  on
     brokers:     0 live in the database

   Intercom broker: not running (the next session that uses Intercom starts one with the selection above)
   ```

   `multi-node: on` means agents on this machine can message agents on the other machines that joined. A broker starts with the first session that uses Intercom, so right after a restart `brokers` can show `0` and the broker `not running`. Once sessions run on the joined machines, `brokers` counts their brokers.

5. **Delete your password file**, `~/atomic-db-password`. `atomic storage join` keeps its own copy.

`atomic storage join` takes a `postgres://` or `postgresql://` URL that names the user and never the password. Pass exactly one way to log in:

| Option | What Atomic does |
| --- | --- |
| `--password-file <path>` | Copies the password into a private file in the agent directory, `~/.atomic/agent/storage-token.<id>`, readable only by you. You can delete your own file afterwards. |
| `--token-file <path>` | Remembers the path and reads the file again for every new connection. Use it when another program, such as a Vault agent, keeps a short-lived password in that file. Atomic removes one trailing line break, so write no other trailing spaces or blank lines. |
| `--auth azure`, `--auth aws`, or `--auth gcp` | Logs in with the machine's cloud identity. See [Cloud identities](#cloud-identities). |

`atomic storage join` checks the URL, the adapter, and the password, and runs `SELECT 1` on the database, within 15 seconds. If any check fails, it changes nothing. Then it writes only the `storage` setting in `~/.atomic/agent/settings.json`, and replaces any `storage` value that was there. Save the old value first if you still need it. The setting looks like this:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic_runtime@db.example.com:5432/atomic" },
    "secrets": { "password": { "file": "agent/storage-token.28ab7041-05e2-4ad5-80af-854329035d8c" } }
  }
}
```

`atomic storage join` created the password file and chose its name. `storage-token.28ab7041-05e2-4ad5-80af-854329035d8c` stands for that name here and in the examples below, so keep the name your machine has. The path is relative to the [storage home](/storage#storage-home), `~/.atomic`.

You can write this setting yourself instead, or pass the same object in `ATOMIC_STORAGE` or `--storage`. Give the password in `secrets.password`, as `{ "file": "<path>" }` or `{ "env": "<variable>" }`. Atomic reads it again for every new connection, so a rotated password takes effect without a restart. A password in `options` is ignored, and a missing `secrets.password` fails with `StorageConfigError` and reason `secret-missing`.

### Connection options

Put these in `options`. The defaults suit a few machines. [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents) explains when to change them.

| Option | Default | What it does |
| --- | --- | --- |
| `url` | Required | The `postgres://` or `postgresql://` URL, with the user name and no password. |
| `auth` | `"password"` | `"azure-entra"`, `"aws-iam"`, or `"gcp-iam"` to log in with a [cloud identity](#cloud-identities). |
| `maxConnections` | `8` | The most connections one Atomic process opens to this database for its work. A positive whole number. |
| `readerMaxConnections` | `2` | The most extra connections one process opens only for reads, so reads never wait behind writes. At most `maxConnections`. `0` turns the extra connections off. |
| `statementTimeoutMs` | `30000` | How long one statement may run before the server cancels it, in milliseconds. If the server stops answering, Atomic drops the connection 5 seconds later. |
| `connectTimeoutMs` | `10000` | How long opening a connection, or waiting for a free one, may take, in milliseconds. |
| `idleTimeoutMs` | `300000` | How long a process keeps its last idle connection open, in milliseconds. Extra connections opened for a burst close after 10 seconds idle. |
| `keepAliveIdleMs` | `60000` | How long a connection sits unused before Atomic sends TCP keepalive probes on it, in milliseconds. |
| `maxPreparedStatements` | `256`, or `0` behind a pooler | How many queries each connection keeps prepared, so the server plans each one once. `0` turns this off. Atomic turns it off by itself behind a pooler, unless it finds a PgBouncer that supports it. See [Prepared statements](/storage/postgres/pgbouncer#how-atomic-works-with-pgbouncer). |
| `listenUrl` | Same as `url` | The server's own address, for [wake-ups](#wake-ups): the instant notice of new Intercom messages. Set it when `url` points at a pooler, which cannot pass wake-ups. Follows the same rules as `url`. |
| `schema` | `"atomic"` | The schema Atomic's tables live in. Lowercase letters, digits, and `_`, starting with a letter or `_`, at most 63 characters. To migrate a custom schema, put it in the `storage` setting and run `atomic storage migrate` without `--db`. |
| `proxy` | From the environment | An `http://` or `https://` proxy for every connection, or `"none"` to ignore proxy variables. See [Through an HTTP proxy](#through-an-http-proxy). |

For a Node.js or TypeScript app built on the SDK, install `@bastani/atomic-storage-postgres` with `npm install` and call `openPostgresDatabase` with the same options. See [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) and [SDK session storage](/sdk/storage).

## TLS

Atomic encrypts every connection to a remote server and checks both the server's certificate and its host name, as `sslmode=verify-full` does. Connections to `localhost`, a loopback address, or a Unix socket use no TLS unless the URL sets `sslmode`. If the URL names no host, Atomic uses `PGHOST`.

To change this, add `sslmode` to the URL, in lowercase:

| `sslmode` | Encrypts | Checks the certificate | Checks the host name |
| --- | --- | --- | --- |
| `verify-full`, the default | Yes | Yes | Yes |
| `verify-ca` | Yes | Yes | No |
| `require` with `sslrootcert` | Yes | Yes | No |
| `require` without `sslrootcert` | Yes | Yes | Yes |
| `prefer` or `allow` | Yes | No | No |
| `disable` | No | No | No |

`require` without `sslrootcert` checks more than the PostgreSQL command-line tools do. An unknown `sslmode`, or a TLS parameter written in uppercase, fails with `StorageConfigError`.

Where to find the certificate authority, the certificate that signed the server's certificate:

- **Self-hosted PostgreSQL.** Turn TLS on in `postgresql.conf` with `ssl = on`, `ssl_cert_file`, and `ssl_key_file`, using a certificate whose name matches the host in `url`. If your own certificate authority signed it, add `?sslrootcert=/path/to/root.crt` to the URL. The self-signed certificate that some Linux packages install, such as Debian's `snakeoil` certificate, does not pass the default check.
- **Azure Database for PostgreSQL, Azure HorizonDB, and Neon.** Their certificates are trusted by Node.js already. Add nothing.
- **Supabase.** Download the project's CA certificate from Project Settings > Database > SSL Configuration, and add `?sslrootcert=/path/to/supabase-ca.pem` to the URL.
- **Amazon RDS and Aurora.** Download your region's bundle from `https://truststore.pki.rds.amazonaws.com/<region>/<region>-bundle.pem`, and add `?sslrootcert=/path/to/bundle.pem`.
- **Google Cloud SQL.** Save the server's CA with `gcloud sql instances describe <instance> --format='value(serverCaCert.cert)'`. Over a private IP address, add `?sslmode=verify-ca&sslrootcert=/path/to/server-ca.pem`, because the certificate does not list private addresses.

## Through an HTTP proxy

Where outbound traffic must go through an HTTP proxy, Atomic tunnels every database connection through it with HTTP `CONNECT`. Allow `<database host>:5432`, or your server's port, on the proxy.

- **Which proxy.** Atomic reads `HTTPS_PROXY` or `https_proxy` first, then `ALL_PROXY` when it names an `http://` or `https://` proxy, then `HTTP_PROXY`. A user name and password in the proxy URL are sent to the proxy and hidden from logs and errors.
- **Hosts that skip the proxy.** `NO_PROXY` or `no_proxy` lists hosts to reach directly, such as `db.example.com`, `.example.com`, `*.example.com`, `host:port`, or `*`. `localhost`, loopback addresses, and Unix sockets never use the proxy.
- **One store only.** Set the `proxy` option to a proxy URL to use it for this database, or to `"none"` to ignore the proxy variables.
- **TLS stays end to end.** Atomic's TLS session runs inside the tunnel, so the proxy sees only encrypted traffic. With `verify-full`, the default, the certificate must match the database's host name. `verify-ca` protects against a proxy that intercepts traffic only when `sslrootcert` names a certificate authority used for nothing but your database servers.

If the proxy refuses the tunnel with `403` or `407`, opening fails at once with `StorageUnavailableError`. A refused or dropped connection, or a `502` or `503` answer, is retried like an unreachable server, with a warning that names the proxy and the reason.

## Connection budget

Connections are counted per process. What counts as one Atomic process:

- each `atomic` you start, interactive or with `-p`;
- each `atomic --mode rpc` child that a program starts;
- the Intercom broker: Atomic runs one Intercom broker per agent directory, usually one per machine or container.

Subagents run inside the process that launched them and share its connections, so they add none.

Each Atomic process shares one set of connections per database between everything it opens there: its sessions, its subagents' sessions, search, and Intercom. The set holds:

| Connections | How many | `application_name` in `pg_stat_activity` |
| --- | --- | --- |
| Main pool | Up to `maxConnections`, 8 by default | `atomic` |
| Read pool | Up to `readerMaxConnections`, 2 by default. Only reads use it | `atomic-reader` |
| Wake-up connection | 1, only in a process that listens for [wake-ups](#wake-ups), such as an Intercom broker | `atomic-listen` |

So a process opens at most `maxConnections` + `readerMaxConnections` connections, 10 with the defaults, and a process that listens, such as an Intercom broker, 1 more: 11.

Atomic opens connections only when it needs them, and closes them again. An extra connection opened for a burst closes after 10 seconds unused. The last connection of each pool stays open for `idleTimeoutMs`, 5 minutes by default, so the next call after a pause does not wait for a new connection. So between bursts, a process holds 1 main connection, 1 read connection if it read recently, and its wake-up connection if it listens. Open connections never keep a process from exiting.

Size the settings by how many processes you run:

- **A few long-lived processes**, such as one interactive session per machine. Keep the defaults.
- **Many processes, such as a swarm of agent runners.** Work out `maxConnections` with [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents). If the processes often sit idle, set `idleTimeoutMs` between `10000` and `30000`, so idle processes give their connections back sooner.
- **More processes than the server can take.** Connect through [PgBouncer](/storage/postgres/pgbouncer) in transaction mode, and set `listenUrl` to the server's own address. Then only the wake-up connections go to the server directly.

## Connection poolers

A pooler lets many clients share a few server connections. Atomic works with poolers in transaction mode or session mode, never statement mode. That includes PgBouncer, Azure's built-in PgBouncer on port 6432, Supabase's Supavisor on port 6543, and Neon's `-pooler` host.

A pooler in transaction mode cannot pass notifications, so set `listenUrl` to the server's own address, such as port 5432 on Azure or Neon's host without `-pooler`. Without it, Intercom still works, by checking for new messages every half second. See [Wake-ups](#wake-ups).

To run your own PgBouncer, follow the [PgBouncer guide](/storage/postgres/pgbouncer). It has a complete configuration with TLS and SCRAM, how to size the pools, and how to check that it works.

## Wake-ups

When one machine sends an Intercom message, the receiving machine's broker learns about it at once through PostgreSQL's `LISTEN` and `NOTIFY` commands. Each process that listens, such as an Intercom broker, holds one wake-up connection per database.

While wake-ups work, each broker also checks for missed messages every 5 seconds. If the wake-up connection drops, or `url` points at a transaction pooler and `listenUrl` is not set, brokers check every half second instead, so no message is lost. Atomic checks the wake-up connection every 30 seconds and reconnects it. Behind a transaction pooler, it stops trying until the process restarts.

`atomic storage status` shows the state:

| Status line | Meaning |
| --- | --- |
| `wake-ups: LISTEN/NOTIFY` | Wake-ups work. |
| `wake-ups: connecting` | The wake-up connection is opening. |
| `wake-ups: polling only, notifications do not pass the URL's transaction pooler (set listenUrl to a direct endpoint)` | `url` points at a pooler. Set `listenUrl` to the server's own address. |
| `wake-ups: polling only, the listen connection failed` | The wake-up connection could not connect or log in. Check `listenUrl` and the server's connection limit. |

## Azure

**Azure Database for PostgreSQL Flexible Server:**

- Connect to `<server>.postgres.database.azure.com` on port 5432.
- On General Purpose and Memory Optimized tiers, you can turn on the built-in PgBouncer with the `pgbouncer.enabled` server parameter. It listens on port 6432. Point `url` at port 6432 and `listenUrl` at port 5432.
- Add `PG_TRGM` to the `azure.extensions` server parameter, then run `atomic storage migrate`, so Atomic can index session history search. Without it, search still works but reads sessions one page at a time, and `atomic storage migrate` tells you to run it again once the extension is allowed.
- Watch the connection limit. A Burstable B1ms server allows 50 connections and keeps 15 of them for administrators. With the defaults, one Atomic process can open 10, and an Intercom broker 11. Lower `maxConnections`, use PgBouncer, or pick a larger server. See [Connection budget](#connection-budget).
- Allow your machines' addresses in the firewall rules, or use private access.

**Azure HorizonDB (preview, PostgreSQL 17):**

- Connect to the cluster's read/write endpoint, `<cluster>.rw.<id>.<region>.horizondb.azure.com`, on port 5432. A read-only endpoint does not work, because Atomic writes on every connection. Wake-ups work on the read/write endpoint.
- Add `pg_trgm` to `azure.extensions` in the compute pool's parameter group, then run `atomic storage migrate`.
- Allow your machines' addresses in the firewall rules, or connect over a private endpoint.

Both services use certificates Node.js trusts, work with the roles from [Set up the database](#set-up-the-database), and support Microsoft Entra ID with `--auth azure`.

## Cloud identities

A machine on Azure, AWS, or Google Cloud can log in with its cloud identity instead of a password. Atomic asks the cloud for a short-lived token for each new connection and keeps it only in memory. Install the cloud provider's library first:

| `--auth` | `options.auth` | Install | Where the identity comes from |
| --- | --- | --- | --- |
| `azure` or `azure-entra` | `"azure-entra"` | `atomic install npm:@azure/identity` | `AZURE_*` variables, AKS workload identity, the managed identity of a VM, App Service, or Container App (`AZURE_CLIENT_ID` picks a user-assigned one), or `az login` |
| `aws` or `aws-iam` | `"aws-iam"` | `atomic install npm:@aws-sdk/rds-signer` | The default AWS credentials: `AWS_*` variables, profiles, IRSA, or the instance profile |
| `gcp` or `gcp-iam` | `"gcp-iam"` | `atomic install npm:google-auth-library` | Application Default Credentials: `GOOGLE_APPLICATION_CREDENTIALS`, the Compute Engine, GKE, or Cloud Run metadata server, or `gcloud auth application-default login` |

If the library is missing or cannot get a token, opening fails with `StorageConfigError` and reason `auth-unavailable`. Cloud tokens need TLS, so keep the default `sslmode`.

Then map the identity to a PostgreSQL role:

- **Azure, Flexible Server or HorizonDB.** Turn on Microsoft Entra authentication and add an Entra administrator. Connected to the `postgres` database as that administrator, run `SELECT * FROM pgaadauth_create_principal('<identity name>', false, false);` and grant the new role `CONNECT` on the Atomic database. Use the identity name as the user in the URL.
- **AWS.** Turn on IAM database authentication. Run `CREATE USER atomic; GRANT rds_iam TO atomic;`, and allow the IAM identity `rds-db:connect` on `arn:aws:rds-db:<region>:<account>:dbuser:<DbiResourceId>/atomic`.
- **Google Cloud.** Set `cloudsql.iam_authentication=on`, add the service account as an IAM database user, and grant it `roles/cloudsql.instanceUser`. Use the service account's email without `.gserviceaccount.com` as the user in the URL. Compute Engine VMs need the `cloud-platform` scope.

Give the mapped role the runtime privileges from [Set up the database](#set-up-the-database), and run `atomic storage migrate` as the owner role. For more detail per service, see [`@bastani/atomic-storage-postgres`](/libraries/storage-postgres).

`atomic install` puts these libraries in `~/.atomic/agent/npm`, where the PostgreSQL adapter looks for them.

## Tuning for many concurrent agents

How many agents can write at once depends on how many connections each process may open. Writes to different sessions run side by side, each on its own connection. Writes to the same session wait for each other.

This section covers Atomic's settings. For the server side, such as memory, monitoring, and the busiest tables, see [Server tuning](/storage/postgres/tuning).

Every Atomic process on every machine shares the server's `max_connections`. Give each process as many connections as the server can spare, and no more. The steps below work out that number.

### Count the connections Atomic needs

Each Atomic process, as [Connection budget](#connection-budget) defines it, opens up to this many connections:

- **An agent process**, including each `atomic --mode rpc` child: `maxConnections` plus `readerMaxConnections`.
- **An Intercom broker**: `maxConnections` plus `readerMaxConnections`, plus 1 for [wake-ups](#wake-ups).

A quiet process holds fewer. Plan for the maximum anyway, because busy processes reach it.

Find what the server has to share. Run these as an administrator:

```sql
SHOW max_connections;
SHOW superuser_reserved_connections;
SHOW reserved_connections; -- PostgreSQL 16 and later
SELECT count(*) FROM pg_stat_activity
WHERE backend_type = 'client backend' AND application_name NOT LIKE 'atomic%';
```

Then work out `maxConnections`:

1. Take `max_connections`. Subtract both reserved counts and the connections other clients use. Call the result *available*.
2. Count *P*, the number of Atomic processes on all machines, and *B*, the number of those that are Intercom brokers. Atomic runs one Intercom broker per agent directory, usually one per machine or container.
3. Each process may use (*available* − *B*) / *P* connections, rounded down.
4. Set `maxConnections` to that number minus `readerMaxConnections`.

If step 4 gives `maxConnections` below 2, the server cannot give each process enough connections. Use a pooler, as in the second example below.

A new PostgreSQL server has `max_connections = 100` with 3 slots reserved for superusers. With Atomic's defaults, each process may need 10 connections and each broker 11, so such a server holds about 8 processes. For example, 20 agent processes on 4 machines, with one broker each, can open up to 20 × 10 + 4 × 11 = 244 connections. Raise `max_connections`, lower `maxConnections`, or use PgBouncer.

### Example: 24 processes on a large server

Four machines each run five agent processes and one Intercom broker, so *P* is 24 and *B* is 4. The server has `max_connections = 500`, 3 superuser slots, no other reserved slots, and 20 connections used by other clients.

- *available* is 500 − 3 − 0 − 20 = 477.
- Each process may use (477 − 4) / 24 = 19.7, rounded down to 19.
- With the default `readerMaxConnections` of 2, set `maxConnections` to 19 − 2 = 17.

In `~/.atomic/agent/settings.json` on each machine:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@db.example.com:5432/atomic",
      "maxConnections": 17,
      "readerMaxConnections": 2
    },
    "secrets": { "password": { "file": "agent/storage-token.28ab7041-05e2-4ad5-80af-854329035d8c" } }
  }
}
```

The same options in an SDK app:

```typescript
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 17,
	readerMaxConnections: 2,
});
```

### Example: 150 machines on a smaller server

Here, 150 CI runners each run one agent process and one Intercom broker, so *P* is 300 and *B* is 150. The server has `max_connections = 300`, 3 superuser slots, and 10 connections used by other clients, so *available* is 287.

Even at the smallest settings, `maxConnections: 1` and `readerMaxConnections: 0`, the processes need 300 × 1 + 150 = 450 connections. That is more than 287, so connect through a pooler such as PgBouncer in transaction mode, on port 6432:

- **Point `url` at PgBouncer.** Connections to PgBouncer do not count against the server, so keep `maxConnections` at its default of 8. Set PgBouncer's `max_client_conn` to at least *P* × (`maxConnections` + `readerMaxConnections`), here 300 × 10 = 3000.
- **Point `listenUrl` at the server**, or leave it out. PgBouncer cannot pass wake-ups. With `listenUrl`, each broker holds one direct connection, learns of new messages at once, and checks for missed ones every 5 seconds. Without it, brokers check the database every half second, 10 times as often.
- **Size PgBouncer's pool** to fit in what is left. With `listenUrl`, PgBouncer's pool and its reserve together may use at most 287 − 150 = 137 connections. Without `listenUrl`, up to 287. A smaller pool is often faster. The [PgBouncer guide](/storage/postgres/pgbouncer#choose-the-pool-sizes) starts at 80 plus 5 in reserve.

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": {
      "url": "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
      "listenUrl": "postgresql://atomic_runtime@db.example.com:5432/atomic",
      "maxConnections": 8
    },
    "secrets": { "password": { "file": "agent/storage-token.28ab7041-05e2-4ad5-80af-854329035d8c" } }
  }
}
```

The same options in an SDK app:

```typescript
const database = await openPostgresDatabase({
	url: "postgresql://atomic_runtime@pgbouncer.example.com:6432/atomic",
	listenUrl: "postgresql://atomic_runtime@db.example.com:5432/atomic",
	password: process.env.ATOMIC_DB_PASSWORD,
	maxConnections: 8,
});
```

The [PgBouncer guide](/storage/postgres/pgbouncer) has a complete PgBouncer configuration, the PostgreSQL and Atomic settings that go with it, and how to check that it works.

### Other settings

Set these in the same `options` object, or pass them to `openPostgresDatabase`. Each takes a whole number of milliseconds, except `maxPreparedStatements`.

- **Distance comes first.** Each save waits for at least one round trip to the server, so a machine 80 ms away spends at least 80 ms on each save. Put the database in the same region as the agents. Saves are slower until the owner has run `atomic storage migrate` after an upgrade.
- **`idleTimeoutMs`** (default `300000`, 5 minutes). Lower it, for example to `30000`, when long-running processes sit idle and the server is near its connection limit.
- **`statementTimeoutMs`** (default `30000`). Raise it only if statements fail with `StorageTransientError` code `transaction-timeout` on a slow server. A lower value does not make anything faster.
- **`connectTimeoutMs`** (default `10000`). Raise it for a distant server or one that is slow to accept connections.
- **`keepAliveIdleMs`** (default `60000`). Lower it if calls fail with `StorageTransientError` code `connection-lost` after a pause. That error after a pause usually means a firewall, NAT, or load balancer dropped the idle connection.
- **`maxPreparedStatements`** (default `256`, or `0` behind a pooler). Lower it if the server is short of memory per connection. Atomic expects a pooler on ports 6432 and 6543. Behind a pooler on any other port, set `listenUrl` or `maxPreparedStatements: 0`. See [Prepared statements](/storage/postgres/pgbouncer#how-atomic-works-with-pgbouncer).

### Check the effect

Run these as an administrator. Replace `atomic` with your database name. Atomic's connections report the application name `atomic`, `atomic-reader`, or `atomic-listen`.

How many connections Atomic holds, and what they are doing:

```sql
SELECT application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

What busy connections are waiting for:

```sql
SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = 'atomic' AND state <> 'idle'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

How close the server is to its limit:

```sql
SELECT count(*) AS used, current_setting('max_connections')::int AS max
FROM pg_stat_activity
WHERE backend_type = 'client backend';
```

What to change:

| You see | It means | Change |
| --- | --- | --- |
| `sorry, too many clients already`, `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `too many connections for role "<role>"` | The processes asked for more connections than the server or the role allows. | Lower `maxConnections` or `readerMaxConnections`, raise `max_connections` or the role's `CONNECTION LIMIT`, or [put PgBouncer in front](/storage/postgres/pgbouncer). |
| `timeout exceeded when trying to connect` | Every connection in a process's pool stayed busy for `connectTimeoutMs`. | Raise `maxConnections` if the server has connections to spare. Otherwise raise `connectTimeoutMs`. |
| `the call was queued behind an earlier call that ran 60 seconds without settling, and did not run; nothing was written, retry it` | An earlier call ran for a minute, usually because it waited on a lock or on an overloaded server, and this call waited behind it. | Check what busy connections wait for. More connections do not help. |
| Many connections with `wait_event_type` `Lock` | Agents write to the same sessions at once and wait for each other. | More connections do not help. Spread agents over more sessions. |
| Most `atomic` connections are `idle` and the server is near its limit | Idle processes keep connections open. | Lower `idleTimeoutMs`. |
| `wake-ups: polling only, the listen connection failed` in `atomic storage status` | A broker could not open its wake-up connection, often because the server has none left. | Count the connections again with the steps above. |

Atomic reports the first two rows as `StorageTransientError` with code `connection-refused`, and the quoted text is the error's cause. The third row is a `StorageUnavailableError` whose message ends with the quoted text.

## Troubleshooting

Errors from `atomic storage join`, `atomic storage migrate`, and opening the database, with what to do:

| Error | Fix |
| --- | --- |
| `credential-in-url` | Remove the password from the URL. Pass `--password-file` or `--token-file` instead. |
| `libsql-removed` | The URL is a libSQL one, such as `libsql://`, `https://`, `wss://`, or `file:`, or the command is `atomic team join`. Use a `postgres://` URL with `atomic storage join`. To move existing sessions, see [Moving off libSQL](/storage#moving-off-libsql). |
| `unsupported-auth` | `--auth` accepts `azure`, `aws`, or `gcp`, or the long forms `azure-entra`, `aws-iam`, and `gcp-iam`. |
| `adapter-not-installed` | Run `atomic install npm:@bastani/atomic-storage-postgres` as the user who runs Atomic. |
| `auth-unavailable` | Install the cloud library the error names, and check that the machine has a cloud identity. Atomic does not retry this error. |
| `missing-privilege`, with PostgreSQL code `42501` or `3F000` | Run the `GRANT` the error names, as in [Set up the database](#set-up-the-database). If the error mentions ownership or `CREATE`, run `atomic storage migrate` as the owner role. |
| `This database was upgraded since this process started` | `atomic storage migrate` moved the tables from `public` to `atomic` while this process ran. Restart the process. |
| A refused password or token, with PostgreSQL code `28P01`, or `28000` on Azure | The token expired, names the wrong user, or has the wrong format. On Azure, use `--auth azure`, or get a token for `https://ossrdbms-aad.database.windows.net` with `az account get-access-token --resource-type oss-rdbms`. |
| `StorageUnavailableError` on open | The server refused the login (`28P01` or `28000`), the database does not exist (`3D000`), or the server is too old. Use PostgreSQL 16 or newer. |
| `self-signed certificate in certificate chain` or `unable to get local issuer certificate` | Set `sslrootcert` to your server's certificate authority. See [TLS](#tls). |
| `INVALID_PURPOSE` | The certificate in `sslrootcert` is not a certificate authority (`basicConstraints=CA:TRUE`), or may only be used for clients. Point `sslrootcert` at the authority that signed the server's certificate. |
| `PATH_LENGTH_EXCEEDED` | The certificate chain is longer than the root certificate allows. Reissue the root without that limit, or sign the server certificate with the root directly. |
| `UNSPECIFIED` with a reason, such as `key usage does not include certificate signing` | Node.js reports some certificate problems this way. Follow the reason, for example reissue the certificate authority with `keyCertSign`. |
| The proxy's own certificate is refused | An `https://` proxy's certificate is checked against Node.js's certificate authorities, never `sslrootcert`. Add your proxy's authority to [`NODE_EXTRA_CA_CERTS`](/environment-variables#tls-certificates). |
| The proxy refused the tunnel, or cannot be reached | Allow the database's `host:port` on the proxy, give proxy credentials for a `407`, check `HTTPS_PROXY`, or skip the proxy with `NO_PROXY` or `proxy: "none"`. See [Through an HTTP proxy](#through-an-http-proxy). |
| `unsupported-proxy` | Use an `http://` or `https://` proxy. Atomic does not support `socks5://`. |
| `StorageTransientError` with code `read-only-server`, PostgreSQL code `25006` | `url` points at a read-only replica, or the server is failing over or out of disk. Point `url` at the read/write endpoint, or retry once the server recovers. |
| `sorry, too many clients already`, `remaining connection slots are reserved for roles with the SUPERUSER attribute`, or `too many connections for role "<role>"`, PostgreSQL code `53300` | The server, or the role's `CONNECTION LIMIT`, has no connection left. Atomic reports `StorageTransientError` with code `connection-refused`. Lower `maxConnections` or `readerMaxConnections`, raise `max_connections`, or put [PgBouncer](/storage/postgres/pgbouncer) in front. See [Tuning for many concurrent agents](#tuning-for-many-concurrent-agents). |
| `timeout exceeded when trying to connect` | Every connection in the process's pool stayed busy, or a new connection took longer than `connectTimeoutMs`. Atomic reports `StorageTransientError` with code `connection-refused`. Raise `maxConnections` if the server has connections to spare, or raise `connectTimeoutMs` for a distant or slow server. |
| `prepared statement "atomic_…" does not exist` or `already exists`, behind a pooler | The pooler does not keep prepared statements. Atomic stops preparing statements for the rest of the process and retries, so you usually see only a one-time warning. Set `maxPreparedStatements` to `0`, or on PgBouncer 1.21 or later set `max_prepared_statements` above `0`. |
| `StorageTransientError` with code `lock-conflict` or `transaction-timeout` | The server cancelled a statement that waited too long or ran past `statementTimeoutMs`. Nothing was written. If it keeps happening, the server is overloaded. |
| `wake-ups: polling only` in `atomic storage status` | Messages still arrive, by polling. See [Wake-ups](#wake-ups). |
| `StorageTransientError` with code `connection-lost` after a failover or pooler restart | The server or pooler closed the connection. Retry. |
