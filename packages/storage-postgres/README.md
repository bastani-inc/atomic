# @bastani/atomic-storage-postgres

A [PostgreSQL](https://www.postgresql.org) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions and Intercom multi-node routing in one shared PostgreSQL database, so several machines can use the same state. It is a separate package: install it only where you want Postgres storage.

## Install

```bash
atomic install npm:@bastani/atomic-storage-postgres
```

Install in user scope (without `-l`); Atomic only searches user-scope packages for storage adapters.

## Configure

Select the adapter in `~/.atomic/agent/settings.json`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic@db.example.com:5432/atomic" },
    "secrets": { "password": { "file": "postgres-password" } }
  }
}
```

```bash
printf '%s' "$PASSWORD" > ~/.atomic/postgres-password
chmod 600 ~/.atomic/postgres-password
```

| Option | Required | Description |
|---|---|---|
| `url` | yes | A `postgres://` or `postgresql://` URL with the user name but no password. A URL with a password, or with a `password=` parameter, is refused (`credential-in-url`). |
| `password` | when the server asks for one | Pass it through `secrets` (`{ "file": ... }` or `{ "env": ... }`). The reference is read again for every new connection, so a password file another process rotates in place is picked up by the next connection. |
| `auth` | no | `"password"` (default), or `"azure-entra"`, `"aws-iam"` or `"gcp-iam"` to sign in with a cloud identity instead of a password; see [Cloud IAM authentication](#cloud-iam-authentication). A cloud `auth` with a `password` is refused (`conflicting-token`). |
| `maxConnections` | no | Connections each process keeps open at most. Default 8. |
| `statementTimeoutMs` | no | How long one statement may run before the server cancels it. Default 30000. |
| `listenUrl` | no | A direct (session) endpoint for the connection that listens for wake-ups, when `url` goes through a transaction pooler. Default `url`. |
| `schema` | no | The schema Atomic's tables live in, a lowercase name. Default `atomic`, which the first store that sets up its tables creates when the role may. A database whose `public` schema holds an earlier release's tables, and has no `atomic` schema, keeps using `public` until `atomic storage migrate` moves them. Every transaction sets it with `SET LOCAL search_path`. |
| `proxy` | no | An `http://` or `https://` proxy every connection tunnels through with `CONNECT`, or `"none"` to connect directly. Default: the environment's, as below. |

Where the only way out is an HTTP proxy, such as a sandbox's, every connection (the pool's, the one that listens for wake-ups, cancel requests, and their reconnects) tunnels through the proxy `HTTPS_PROXY` (or `https_proxy`) names, then `ALL_PROXY` when it names an HTTP proxy, then `HTTP_PROXY`, unless `NO_PROXY` exempts the database host. `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are read as Atomic's other HTTPS clients read them; those clients do not read `ALL_PROXY`. A database on this machine (a loopback host or a socket directory) is reached directly whatever the environment says; the `proxy` option overrides all of this, except that a socket directory is always reached directly. Credentials in the proxy URL are sent as `Proxy-Authorization` and never appear in messages. TLS still runs end to end with the server through the tunnel. With the default `verify-full` (or `require` without `sslrootcert`), the certificate must name the database host, so the proxy sees only encrypted traffic. `verify-ca` (and `require` with `sslrootcert`) accepts any certificate the CA signed, whatever host it names: it keeps the proxy out only when `sslrootcert` names a CA that signs your database servers alone, and with the CAs Node trusts, a proxy holding any certificate they issued could read and change the traffic. `prefer` and `allow` do not check the certificate, so a proxy could read and change the traffic, and `disable` does not encrypt it. A proxy that refuses the tunnel fails the open with `StorageUnavailableError`, whose message names the proxy and the refused `host:port`; while an open retries a proxy that cannot be reached, its warning names the proxy too.

PostgreSQL 14 or newer is required. A URL that names no `sslmode` gets `sslmode=verify-full` when its host (for a URL that names no host, `PGHOST`) is not this machine, so the connection is encrypted and the server certificate is checked. Name a CA with `sslrootcert=/path/to/ca.pem` when the server's certificate is not signed by a CA Node trusts, or set `sslmode` yourself. `sslmode` follows libpq: `verify-ca` checks the certificate's CA (`sslrootcert`, or else the CAs Node trusts) but not its host name, for a server reached by an address its certificate does not name; `prefer` and `allow` encrypt without checking the certificate; `disable` turns TLS off. `require` with `sslrootcert` acts as `verify-ca`; without it, `require` checks the certificate and its host name, as `verify-full` does, which is stricter than libpq. Parameter names are case-sensitive, as in libpq: a TLS parameter that is not lowercase, or an unknown `sslmode`, is refused.

The adapter works through a transaction-mode connection pooler (PgBouncer, Supavisor, and the poolers of managed services): it sets nothing outside a transaction, takes no session locks, and uses no named prepared statements.

Each process also keeps one connection outside the pool that `LISTEN`s for wake-ups (`notifications` on the opened database), so Intercom brokers find new messages at once. A transaction-mode pooler does not deliver notifications to it: the adapter detects that with a probe and falls back to polling alone, unless `listenUrl` names the server's direct endpoint. Nothing is lost without wake-ups; work is found at the next poll. `atomic storage status` says which applies.

A failure that passes, such as a refused or lost connection, a lock conflict (SQLSTATE `40001`, `40P01`, `55P03`) or a cancelled statement (`57014`), is reported as `StorageTransientError`, and a call that wrote nothing runs again. Refused credentials (`28P01`), a missing database (`3D000`) and a refused server certificate fail at once. A missing privilege (`42501`) fails at once with `StorageConfigError` reason `missing-privilege`, which names the privilege and the grant or `atomic storage migrate` that fixes it. The password is redacted from error messages and diagnostics. Add a `prefix` to the `storage` block to keep projects or teams apart in one database. See [Storage](https://docs.bastani.ai/storage) for selection precedence and the other storage options.

## Azure

**Azure Database for PostgreSQL (flexible server)**, PostgreSQL 16 or newer:

- Use `<server>.postgres.database.azure.com`: port 5432 reaches the server directly. Port 6432 is the built-in PgBouncer, which General Purpose and Memory Optimized servers offer once the server parameter `pgbouncer.enabled` is on; Burstable servers have none. Through 6432, set `listenUrl` to the same URL on port 5432 so wake-ups still arrive.
- Azure's certificates chain to CAs Node trusts, so the URL needs no TLS parameter.
- The administrator is a member of `azure_pg_admin`, not a superuser; the owner and runtime role setup in [Storage](https://docs.bastani.ai/storage#set-up-the-database) works as written.
- Add `PG_TRGM` to the server parameter `azure.extensions` before `atomic storage migrate`. Without it, searches of session history read each session a page at a time, and `atomic storage migrate` says so.
- Mind the server's connection limit. A Burstable B1ms server allows 50 connections, 15 of them reserved for administrators, and each Atomic process opens up to `maxConnections` (8) plus one for wake-ups: lower `maxConnections`, connect through PgBouncer, or pick a larger server for more than a few processes.

**Azure HorizonDB** (preview), PostgreSQL 17:

- Use the cluster's read/write endpoint, `<cluster>.rw.<id>.<region>.horizondb.azure.com`, port 5432. The pool's read-only endpoint is for reads only, and Atomic writes on every connection. Wake-ups arrive on the read/write endpoint.
- TLS is required, and its certificates chain to CAs Node trusts: the URL needs no TLS parameter.
- The administrator is a member of `azure_pg_admin`, as on a flexible server, and the same role setup applies.
- Add `pg_trgm` to `azure.extensions` in the parameter group assigned to the compute pool.
- Allow each machine's address in the pool's firewall rules, or connect through a private endpoint.

Both services take Microsoft Entra sign-in with `auth: "azure-entra"`; see below.

## Cloud IAM authentication

On Azure, AWS and Google Cloud the adapter can sign in with the machine's cloud identity instead of a stored password. Set `auth` and leave out `secrets.password`:

```json
{
  "storage": {
    "adapter": "@bastani/atomic-storage-postgres",
    "options": { "url": "postgresql://atomic-hosts@atomic.postgres.database.azure.com/atomic?sslmode=verify-full", "auth": "azure-entra" }
  }
}
```

Each cloud signs in through its own SDK, which the adapter does not bundle. Install the one your `auth` needs among the user packages (these are the versions the adapter is tested with). The adapter finds it beside itself, or in `~/.atomic/agent/npm`, where `atomic install npm:<package>` puts it, so an adapter installed from a local path finds it too:

| `auth` | SDK | Install | Where the token comes from |
|---|---|---|---|
| `azure-entra` | `@azure/identity` | `atomic install npm:@azure/identity@4.14.1` | `DefaultAzureCredential` with the scope `https://ossrdbms-aad.database.windows.net/.default`: `AZURE_*` variables, AKS workload identity, managed identity (VM, App Service, Container Apps; `AZURE_CLIENT_ID` selects a user-assigned one), then a developer's `az login`. |
| `aws-iam` | `@aws-sdk/rds-signer` | `atomic install npm:@aws-sdk/rds-signer@3.1169.0` | The RDS `Signer` for the URL's host, port and user, with the AWS SDK's default credential chain (`AWS_*` variables, profiles, IRSA, instance profile). The region comes from an RDS host name, otherwise from the SDK's configuration (`AWS_REGION` or the profile). |
| `gcp-iam` | `google-auth-library` | `atomic install npm:google-auth-library@11.3.4` | `GoogleAuth` with the scope `https://www.googleapis.com/auth/sqlservice.login`: Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, the metadata server on Compute Engine, GKE and Cloud Run, or a developer's `gcloud auth application-default login`). |

In an SDK project, `npm install` the same package next to `@bastani/atomic-storage-postgres`; each is an optional peer dependency. Only the configured cloud's SDK is loaded, when the store opens its first connection.

For each new connection the adapter asks the SDK for a short-lived token and sends it as the password. Tokens are kept in memory only and never written to settings, logs or error messages; Azure tokens are reused until 5 minutes before they expire, and the AWS and Google SDKs cache their own credentials. A token the server refuses (`28P01`, or Azure's `28000` for a malformed one) is dropped, and the connection tried once more with a fresh one. One token request may take up to 8 seconds. When the SDK is missing or gives no token, opening fails with `StorageConfigError` reason `auth-unavailable`; the message names the package to install, or the SDK's own reason with anything shaped like a credential removed.

Cloud tokens require TLS; keep `sslmode=verify-full` (the default for a remote host) or at least `require`.

### Least-privilege roles

Atomic uses two roles: an owner role that owns the database and the `atomic` schema and runs `atomic storage migrate`, and a runtime role for hosts, roots, sessions and brokers, which runs no DDL. Give a cloud identity the runtime role's privileges, as [Set up the database](https://docs.bastani.ai/storage#set-up-the-database) lists them; after `atomic storage migrate`, as the owner role:

```sql
GRANT CONNECT ON DATABASE atomic TO "<identity>";
GRANT USAGE ON SCHEMA atomic TO "<identity>";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA atomic TO "<identity>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA atomic TO "<identity>";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA atomic TO "<identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT USAGE, SELECT ON SEQUENCES TO "<identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE atomic_owner IN SCHEMA atomic GRANT EXECUTE ON FUNCTIONS TO "<identity>";
```

The cloud side needs no more than this:

**Azure Database for PostgreSQL (flexible server).** Enable Microsoft Entra authentication. As the Entra administrator, connected to the `postgres` database, create a role for the managed identity (named exactly as the identity) and grant it the database privileges:

```sql
SELECT * FROM pgaadauth_create_principal('atomic-hosts', false, false);
GRANT CONNECT ON DATABASE atomic TO "atomic-hosts";
```

The identity needs no Azure RBAC role; the URL's user is the role name.

**Azure HorizonDB.** Enable Microsoft Entra authentication on the cluster and add a Microsoft Entra administrator. Then create the identity's role and grant it the database privileges exactly as on a flexible server, as that administrator. Tokens use the same scope.

**Amazon RDS and Aurora PostgreSQL.** Enable IAM database authentication on the instance or cluster, create the user, and allow only `rds-db:connect` for that user:

```sql
CREATE USER atomic;
GRANT rds_iam TO atomic;
GRANT CONNECT ON DATABASE atomic TO atomic;
```

```json
{
  "Effect": "Allow",
  "Action": "rds-db:connect",
  "Resource": "arn:aws:rds-db:<region>:<account-id>:dbuser:<DbiResourceId or cluster resource id>/atomic"
}
```

**Google Cloud SQL for PostgreSQL.** Set the instance flag `cloudsql.iam_authentication=on`, add the service account as an IAM database user, and grant it `roles/cloudsql.instanceUser` (add `roles/cloudsql.client` only when connecting through the Cloud SQL Auth Proxy or a connector). The database user name is the service account's email without `.gserviceaccount.com`:

```bash
gcloud sql users create atomic-hosts@my-project.iam --instance=atomic --type=cloud_iam_service_account
gcloud projects add-iam-policy-binding my-project \
  --member=serviceAccount:atomic-hosts@my-project.iam.gserviceaccount.com --role=roles/cloudsql.instanceUser
```

```sql
GRANT CONNECT ON DATABASE atomic TO "atomic-hosts@my-project.iam";
```

A Compute Engine VM must have the `cloud-platform` access scope for its metadata token to sign in. AlloyDB works the same way with `roles/alloydb.databaseUser` and `roles/serviceusage.serviceUsageConsumer`.

## Use from the SDK

```ts
import { openPostgresDatabase } from "@bastani/atomic-storage-postgres";

const database = await openPostgresDatabase({
	url: "postgresql://atomic@db.example.com/atomic",
	password: async () => readFile("/run/secrets/postgres-password", "utf8"),
});
```

`password` is a string or a function called for each new connection. The returned `SqliteDatabase` can be passed as SDK `sessionStore: { kind: "database", database }`.

For a custom transport, pass `socket`, a function that opens a connection to `{ host, port }` and returns a stream (or a promise of one) that carries the PostgreSQL protocol there; the adapter negotiates TLS over it as over a socket. It is used instead of a proxy from the environment; passing it with `proxy` is refused with `StorageConfigError` reason `conflicting-transport`, and a socket directory is still reached directly. `{ host, port }` is the endpoint pg connects to: the URL's, else `PGHOST` and `PGPORT`.

The package ships plain ESM JavaScript with TypeScript declarations. This import works in supported Node versions without a TypeScript loader.

## License

MIT
