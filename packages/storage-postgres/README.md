# @bastani/atomic-storage-postgres

A [PostgreSQL](https://www.postgresql.org) storage adapter for [Atomic](https://github.com/bastani-inc/atomic). It stores sessions, workflow journals, and Intercom multi-node routing in one shared PostgreSQL database, so several machines can use the same state. It is a separate package: install it only where you want Postgres storage.

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

PostgreSQL 14 or newer is required. A URL that names no `sslmode` gets `sslmode=verify-full` when its host is not this machine, so the connection is encrypted and the server certificate is checked. Name a CA with `sslrootcert=/path/to/ca.pem` when the server's certificate is not signed by a CA Node trusts, or set `sslmode` yourself.

The adapter works through a transaction-mode connection pooler (PgBouncer, Supavisor, and the poolers of managed services): it sets nothing outside a transaction, takes no session locks, and uses no named prepared statements.

A failure that passes, such as a refused or lost connection, a lock conflict (SQLSTATE `40001`, `40P01`, `55P03`) or a cancelled statement (`57014`), is reported as `StorageTransientError`, and a call that wrote nothing runs again. Refused credentials (`28P01`), a missing database (`3D000`) and missing privileges (`42501`) fail at once. The password is redacted from error messages and diagnostics. Add a `prefix` to the `storage` block to keep projects or teams apart in one database. See [Storage](../coding-agent/docs/storage.md) for selection precedence and the other storage options.

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

For each new connection the adapter asks the platform for a short-lived token and sends it as the password. Tokens are kept in memory only, reused until 5 minutes before they expire, and never written to settings, logs or error messages. Each credential source has a time limit: 5 seconds for a metadata endpoint, 30 seconds for a CLI. When no source gives a token, opening fails with `StorageConfigError` reason `auth-unavailable`, and the message names each source tried and why it failed.

| `auth` | Where the token comes from, in order |
|---|---|
| `azure-entra` | AKS workload identity (`AZURE_FEDERATED_TOKEN_FILE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`); otherwise the App Service or Container Apps identity endpoint (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`) or the VM managed identity (IMDS); then `az account get-access-token --resource-type oss-rdbms` (a developer's `az login`). `AZURE_CLIENT_ID` selects a user-assigned identity. |
| `aws-iam` | `aws rds generate-db-auth-token` for the URL's host, port and user, with the AWS CLI v2's own credential chain (instance profile, IRSA, `AWS_*` variables, profiles). The region comes from an RDS host name, otherwise from the CLI's configuration. The host and user must not contain spaces, quotes or shell metacharacters (`invalid-auth-target`). |
| `gcp-iam` | The metadata server's token for the default service account (Compute Engine, GKE, Cloud Run); then `gcloud auth print-access-token` (a developer's `gcloud auth login`). |

Cloud tokens require TLS; keep `sslmode=verify-full` (the default for a remote host) or at least `require`.

### Least-privilege roles

Give the identity a database role with only what Atomic needs: `CONNECT` on the database, and `USAGE` on the schema (`USAGE, CREATE` for the first host that joins, which creates the tables). The cloud side needs no more than this:

**Azure Database for PostgreSQL (flexible server).** Enable Microsoft Entra authentication. As the Entra administrator, connected to the `postgres` database, create a role for the managed identity (named exactly as the identity) and grant it the database privileges:

```sql
SELECT * FROM pgaadauth_create_principal('atomic-hosts', false, false);
GRANT CONNECT ON DATABASE atomic TO "atomic-hosts";
```

The identity needs no Azure RBAC role; the URL's user is the role name.

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

`password` is a string or a function called for each new connection. The returned `SqliteDatabase` can be passed as SDK `sessionStore: { kind: "database", database }` or workflow `journal: { database }`.

The package ships plain ESM JavaScript with TypeScript declarations. This import works in supported Node versions without a TypeScript loader.

## License

MIT
