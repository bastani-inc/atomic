---
title: "Worker fleets on managed PostgreSQL"
sidebarTitle: "Fleets on PostgreSQL"
description: "Run worker hosts and the fleet controller on Amazon RDS or Aurora, Google Cloud SQL, Azure Database for PostgreSQL, Neon or Supabase, with passwords or cloud identities and connection poolers."
---

# Worker fleets on managed PostgreSQL

A [worker fleet](/guides/worker-hosts) keeps its work queue, leases, admission and fleet controller in one shared database. This guide puts that database on a managed PostgreSQL service and connects every machine to it: the machines that start roots, the worker hosts, and the fleet controller. For the database options themselves, see [PostgreSQL](/storage#postgresql).

In this release a fleet's pool writes on PostgreSQL take turns, one at a time across every machine that shares the database, whatever its prefix, as they do on libSQL. Hosts that wait for work poll the database.

## What you need

- **Atomic 0.9.88 or later on every machine** that opens the database. Upgrading an existing fleet? Read [Upgrade a fleet](/guides/worker-hosts#upgrade-a-fleet) first.
- **PostgreSQL 16 or later.**
- **The adapter on every machine**, installed as the user that runs Atomic: `atomic install npm:@bastani/atomic-storage-postgres`. It is published on npm from Atomic 0.9.88. Container images and cloud-init install it in the same way.
- **A role and a database it owns.** Atomic creates its tables the first time it uses the database. The role needs `CONNECT` on the database and `USAGE, CREATE` on the schema; owning the database gives it both.
- **One credential per machine:** a password file, a token file that another process keeps fresh, or the machine's cloud identity. See [Choose a credential](#choose-a-credential).

## Connect every machine

Each kind of machine connects in its own way. All of them name the same URL and, if you use one, the same `--prefix`:

```bash
# Machines that start roots: select the database for sessions, workflow runs and Intercom
atomic install npm:@bastani/atomic-storage-postgres
atomic storage join 'postgresql://atomic@db.example.com:5432/atomic' --password-file ~/atomic-db-password
atomic intercom restart

# Worker hosts: serve the pool, for this process only
atomic worker start --db 'postgresql://atomic@db.example.com:5432/atomic' --password-file /etc/atomic/db-password

# The fleet controller, and the scaling signal for KEDA or Prometheus
atomic worker controller --provisioner ./fleet.json --db 'postgresql://atomic@db.example.com:5432/atomic' \
  --password-file /etc/atomic/db-password --max-hosts 20 --workers-per-host 4
atomic worker metrics --listen 0.0.0.0:9464 --db 'postgresql://atomic@db.example.com:5432/atomic' \
  --password-file /etc/atomic/db-password --max-hosts 20 --workers-per-host 4
```

Roots also need `"workflows": { "workers": { "placement": "shared" } }` in their settings, as [Start roots with shared placement](/guides/worker-hosts#start-roots-with-shared-placement) explains. `atomic team join` takes libSQL URLs only; use `atomic storage join` for PostgreSQL.

Put the user name in the URL and never the password: a URL with a password, or with a `password=` parameter, is refused. Quote the URL in a shell, because a query string such as `?sslmode=verify-ca&sslrootcert=…` holds a `&`.

## Choose a credential

`atomic storage join` and every `atomic worker` command take exactly one of these with a PostgreSQL URL:

| Flag | What it does | Use it for |
| --- | --- | --- |
| `--password-file <path>` | `storage join` copies the password into a private file (mode 600) in the agent directory. `atomic worker` reads the file where it is | A fixed password, such as one Terraform generated into a secret manager |
| `--token-file <path>` | Reads the file where it is for every new connection, so a password that another process rotates takes effect without joining again | A password that a Vault agent, a secrets sidecar or a Kubernetes Secret volume keeps fresh |
| `--auth aws`, `--auth gcp`, `--auth azure` | Signs in with the machine's cloud identity: a short-lived token for each new connection, kept in memory only | Amazon RDS and Aurora, Cloud SQL and AlloyDB, Azure Database for PostgreSQL |

A cloud identity needs its cloud's SDK beside the adapter, installed as the same user:

| `--auth` | Install |
| --- | --- |
| `aws` | `atomic install npm:@aws-sdk/rds-signer` |
| `gcp` | `atomic install npm:google-auth-library` |
| `azure` | `atomic install npm:@azure/identity` |

Neon and Supabase take a password. Keep password and token files at mode 600; `atomic worker start` warns when other users can read them. See [Cloud identities](/storage#cloud-identities) for where each SDK finds the identity.

## Plan connections

Each Atomic process opens connections as it needs them, up to 8 (`maxConnections`), and closes those idle for 10 seconds. A worker host runs a process for itself, one that coordinates its workers, and one for each slot, so it can open up to 8 × (slots + 2) connections. A controller, a metrics server and each Atomic session on a root machine can open up to 8 each:

| Fleet | Most connections it can open |
| --- | --- |
| 1 host, `--slots 4` | 8 × 6 = 48 |
| 10 hosts, `--slots 4` | 10 × 48 = 480 |
| 20 hosts, `--slots 8`, a controller and a metrics server | 20 × 80 + 2 × 8 = 1616 |

A fleet usually holds far fewer, because a process opens connections only for the statements it runs at once. When this ceiling exceeds the server's `max_connections`, watch the server's connection count as the fleet grows, and connect through a [connection pooler](#connection-poolers) before it runs out. Machines whose `storage` setting you write by hand can lower `maxConnections` instead.

## Connection poolers

A pooler lets many machines share a few server connections. Atomic works through poolers in **transaction mode**, the default for most managed poolers: it keeps no settings, locks or prepared statements on a connection between transactions. Point the URL at the pooler instead of the server:

| Service | Pooler URL |
| --- | --- |
| PgBouncer you run | Its host and port, usually 6432 |
| Azure Database for PostgreSQL | The server's host name, port 6432, once the built-in PgBouncer is enabled |
| Neon | The pooled host name, with `-pooler` after the endpoint id |
| Supabase | The transaction pooler, port 6543 |

What to check:

- **Pool mode.** Use `transaction` or `session`. `statement` mode is not supported, because Atomic runs transactions of several statements.
- **Pool size.** The pooler's server-side pool (PgBouncer's `default_pool_size`) bounds how many transactions run at once. Its client limit (PgBouncer's `max_client_conn`) must cover the connections from [Plan connections](#plan-connections).
- **Cloud identities.** The pooler must accept the cloud token and pass it to the server, as Azure's built-in PgBouncer does for Microsoft Entra ID. A PgBouncer you run checks passwords against its own user list, so use `--password-file` through it.
- **TLS.** The pooler's certificate is the one Atomic checks. An address that is not in that certificate, such as a private IP address, needs `sslmode=verify-ca` with `sslrootcert`.
- **A pooler restart** drops connections. Atomic reports it as a lost connection, and a write that wrote nothing runs again.

## Prefixes

A `prefix` keeps several teams or projects apart in one database: pass the same `--prefix` to `atomic storage join` and every `atomic worker` command. On PostgreSQL a prefix can be at most 24 characters, because PostgreSQL shortens table and index names longer than 63 bytes. A longer prefix is refused with `StoragePrefixError` reason `"too-long"` before Atomic creates anything. A prefix holds ASCII letters, digits and underscores and starts with a letter or underscore.

Hosts serve only the roots of their own prefix, and each prefix has its own fleet: its own controller, metrics and hosts. Pool writes take turns across every prefix in the database, so give a large fleet its own database rather than a prefix.

## Amazon RDS and Aurora PostgreSQL

1. Create an RDS for PostgreSQL instance or an Aurora PostgreSQL cluster, version 16 or later, in the hosts' VPC. Allow port 5432 from the hosts' security group.
2. Create the database and a role, connected as the master user:

   ```sql
   CREATE ROLE atomic LOGIN PASSWORD '<password>';
   CREATE DATABASE atomic OWNER atomic;
   ```

   On PostgreSQL 15 and later, a role that does not own the database also needs `GRANT CREATE ON SCHEMA public TO atomic`.
3. Download your region's certificate bundle to every machine, for example to `/etc/atomic/rds-ca.pem`:

   ```bash
   curl -fsSL -o /etc/atomic/rds-ca.pem https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem
   ```

4. Connect with the endpoint, an Aurora cluster's writer endpoint, or an RDS Proxy endpoint:

   ```bash
   atomic worker start \
     --db 'postgresql://atomic@atomic.abc123.us-east-1.rds.amazonaws.com:5432/atomic?sslrootcert=/etc/atomic/rds-ca.pem' \
     --password-file /etc/atomic/db-password
   ```

Read the password from Secrets Manager at boot with the instance profile, as the [Terraform recipe](#recipes-in-the-package) does: `aws secretsmanager get-secret-value --secret-id <arn> --query SecretString --output text`.

**IAM authentication instead of a password.** Enable IAM database authentication on the instance or cluster, then:

```sql
CREATE USER atomic_hosts;
GRANT rds_iam TO atomic_hosts;
GRANT CONNECT ON DATABASE atomic TO atomic_hosts;
GRANT USAGE, CREATE ON SCHEMA public TO atomic_hosts;
```

Allow the hosts' role, and the controller's, only `rds-db:connect` on `arn:aws:rds-db:<region>:<account-id>:dbuser:<DbiResourceId or cluster resource id>/atomic_hosts`, install the SDK, and connect with `--auth aws`:

```bash
atomic install npm:@aws-sdk/rds-signer
atomic worker start --db 'postgresql://atomic_hosts@atomic.abc123.us-east-1.rds.amazonaws.com:5432/atomic?sslrootcert=/etc/atomic/rds-ca.pem' --auth aws
```

The token is signed for the URL's host and port, so name the endpoint you connect to. The region comes from an RDS host name, or otherwise from `AWS_REGION` or the AWS profile. Once the first machine has created the tables, `CREATE` on the schema is no longer needed.

## Google Cloud SQL for PostgreSQL

1. Create a Cloud SQL for PostgreSQL 16 instance with a private IP in the hosts' network, and require TLS (`ENCRYPTED_ONLY`).
2. Create the user and database:

   ```bash
   gcloud sql users create atomic --instance=atomic-pool --password='<password>'
   gcloud sql databases create atomic --instance=atomic-pool
   ```

   A user created this way belongs to `cloudsqlsuperuser`, which owns the databases `gcloud` creates, so it can create Atomic's tables.
3. Save the instance's server CA certificate on every machine:

   ```bash
   gcloud sql instances describe atomic-pool --format='value(serverCaCert.cert)' > /etc/atomic/cloudsql-ca.pem
   ```

4. Connect by private IP address. That address is not among the certificate's names, so check the CA only (`verify-ca`):

   ```bash
   atomic worker start \
     --db 'postgresql://atomic@10.20.0.3:5432/atomic?sslmode=verify-ca&sslrootcert=/etc/atomic/cloudsql-ca.pem' \
     --password-file /etc/atomic/db-password
   ```

**IAM authentication instead of a password.** Set the instance flag `cloudsql.iam_authentication=on`, add the hosts' service account as an IAM database user, and grant it `roles/cloudsql.instanceUser`:

```bash
gcloud sql users create atomic-workers@my-project.iam --instance=atomic-pool --type=cloud_iam_service_account
gcloud projects add-iam-policy-binding my-project \
  --member=serviceAccount:atomic-workers@my-project.iam.gserviceaccount.com --role=roles/cloudsql.instanceUser
```

As the `atomic` user, grant the IAM user `CONNECT` on the database and, connected to `atomic`, `USAGE, CREATE` on the `public` schema. Its name is the service account's email without `.gserviceaccount.com`; in the URL, write its `@` as `%40`:

```bash
atomic install npm:google-auth-library
atomic worker start \
  --db 'postgresql://atomic-workers%40my-project.iam@10.20.0.3:5432/atomic?sslmode=verify-ca&sslrootcert=/etc/atomic/cloudsql-ca.pem' \
  --auth gcp
```

A Compute Engine VM needs the `cloud-platform` access scope; GKE pods use Workload Identity Federation. AlloyDB for PostgreSQL works the same way, with `roles/alloydb.databaseUser` and `roles/serviceusage.serviceUsageConsumer` and the cluster's CA.

## Azure Database for PostgreSQL

1. Create a flexible server, PostgreSQL 16 or later, with private access in the hosts' virtual network, or public access limited to their addresses.
2. Create the database and a role as the administrator:

   ```sql
   CREATE ROLE atomic LOGIN PASSWORD '<password>';
   CREATE DATABASE atomic OWNER atomic;
   ```

3. Connect. Azure's certificates chain to roots that Node.js trusts, so no CA file is needed:

   ```bash
   atomic worker start --db 'postgresql://atomic@atomic-pool.postgres.database.azure.com:5432/atomic' \
     --password-file /etc/atomic/db-password
   ```

Read the password from Key Vault at boot with the VM's managed identity: `az login --identity --allow-no-subscriptions && az keyvault secret show --vault-name <vault> --name atomic-postgres-password --query value --output tsv`.

**Microsoft Entra ID instead of a password.** Enable Microsoft Entra authentication on the server. As the Entra administrator, connected to the `postgres` database, create a role named exactly as the hosts' managed identity, then grant it the database:

```sql
SELECT * FROM pgaadauth_create_principal('atomic-workers', false, false);
GRANT CONNECT ON DATABASE atomic TO "atomic-workers";
```

Connected to `atomic`, run `GRANT USAGE, CREATE ON SCHEMA public TO "atomic-workers"`. The identity needs no Azure RBAC role for the database. Then:

```bash
atomic install npm:@azure/identity
atomic worker start --db 'postgresql://atomic-workers@atomic-pool.postgres.database.azure.com:5432/atomic' --auth azure
```

`AZURE_CLIENT_ID` selects a user-assigned identity on a VM; AKS pods use workload identity. To pool, enable the server's built-in PgBouncer and connect to port 6432.

## Neon

1. Create a project and a database, then a role in the console or with `CREATE ROLE`.
2. Copy the connection string, take the password out of it, and save the password to a file:

   ```bash
   atomic worker start --db 'postgresql://atomic@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/atomic' \
     --password-file /etc/atomic/db-password
   ```

The `-pooler` host name is Neon's PgBouncer in transaction mode; leave `-pooler` out for a direct connection. Neon's certificates chain to roots that Node.js trusts. Worker hosts poll the database while they run, so a Neon compute that scales to zero stays awake for as long as any host, controller or metrics server runs.

## Supabase

1. Create a project. Its `postgres` role owns the `postgres` database, or create a role and a database of your own.
2. Download the project's CA certificate (**Project Settings → Database → SSL Configuration**) to every machine. Supabase's certificates chain to its own CA, which Node.js does not trust.
3. Connect through the transaction pooler (port 6543), whose user name ends with the project reference:

   ```bash
   atomic worker start \
     --db 'postgresql://postgres.abcdefghijklmnop@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslrootcert=/etc/atomic/supabase-ca.pem' \
     --password-file /etc/atomic/db-password
   ```

The session pooler (port 5432 on the same host) and the direct connection (`db.<project-ref>.supabase.co`, IPv6 unless you add IPv4) work too, with the same CA.

## Run the fleet controller

The controller drives your platform through a [preset](/guides/worker-hosts#command-provisioners-and-presets) and opens the database like any host. Run it on a machine or pod with two identities: one that the preset's CLI uses, and one for the database. Each cloud's identity can be both, when the database uses that cloud's IAM authentication:

| Preset | Platform credential | Database credential with the same identity |
| --- | --- | --- |
| `aws-asg.json` | An IAM role: an instance profile, EKS Pod Identity or IRSA | `--auth aws`, with `rds-db:connect` added to the controller's role |
| `gcp-mig.json` | A service account attached to the VM, or Workload Identity Federation for GKE | `--auth gcp`, with the service account added as an IAM database user |
| `azure-vmss.json` | A user-assigned managed identity: `az login --identity --client-id <id>`, or AKS workload identity | `--auth azure`, with a role created for the identity |
| `kubernetes.json` | The pod's ServiceAccount | `--token-file` from a mounted Secret, or the cloud's `--auth` through the pod's workload identity |
| `github-actions.json` | A GitHub App's installation tokens | `--password-file` or `--token-file` |

For example, a controller for an AWS Auto Scaling group whose role reaches both the group and the database:

```bash
atomic install npm:@aws-sdk/rds-signer
atomic worker controller --provisioner ./aws-asg.json \
  --db 'postgresql://atomic_hosts@atomic.abc123.us-east-1.rds.amazonaws.com:5432/atomic?sslrootcert=/etc/atomic/rds-ca.pem' \
  --auth aws --max-hosts 20 --workers-per-host 4
```

`--workers-per-host` must match the `--slots` the hosts start with. Run more than one controller for failover; one is active at a time through a lease in the database. The hosts the preset starts must connect to the same database and prefix, and each must report its provider id, as the recipes below do.

## Recipes in the package

The package's `examples/worker-fleet` directory has the files the [worker hosts guide](/guides/worker-hosts#recipes) describes. For PostgreSQL:

- `terraform/aws-asg`, `terraform/gcp-mig`, `terraform/azure-vmss`: each module's `postgres.tf` creates an Amazon RDS instance, a Cloud SQL instance or an Azure Database for PostgreSQL flexible server beside the scaling group, keeps its password in the cloud's secret manager, and points the hosts at it. Set `postgres = false` to use a libSQL or Turso database from `database` instead. Terraform keeps the generated password in its state, so keep the state in a private backend.
- `terraform/cloud-init.yaml.tftpl`: installs the adapter that matches the URL, and writes the database's CA bundle when it needs one.
- `Dockerfile`: `--build-arg STORAGE_ADAPTER=atomic-storage-postgres` installs the PostgreSQL adapter, which is the default.
- `helm/atomic-worker`: `databaseSecret` names a Secret whose `url` key holds the database URL, and `tokenSecret` the Secret whose `token` key holds the password.
- `github-actions/atomic-workers.yml`: installs the adapter that matches `ATOMIC_DB`, and reads the password like a libSQL token.

## Troubleshooting

- **`self-signed certificate in certificate chain` or `unable to get local issuer certificate`**: the server's CA is not one Node.js trusts. Add `sslrootcert` with the provider's CA, as in the recipes above.
- **`Hostname/IP does not match certificate's altnames`**: you connect by an address that is not in the server's certificate, such as Cloud SQL's private IP. Use `sslmode=verify-ca` with `sslrootcert`, which checks the CA but not the host name.
- **`too many connections`** (`53300`), or `remaining connection slots are reserved`: the fleet has outgrown `max_connections`. Use a [pooler](#connection-poolers), raise `max_connections` (on managed services, a larger instance), or run fewer slots per host.
- **`password authentication failed`** (`28P01`) with `--auth`: the token was refused. Check that the role exists with the identity's exact name, that RDS has `rds_iam` granted and IAM authentication enabled, or that Cloud SQL's `cloudsql.iam_authentication` flag is on. An RDS token is signed for one host and port, so connect to the host it names.
- **`auth-unavailable`**: the cloud's SDK is not installed for the user that runs Atomic, or the machine has no identity. Install the package the message names.
- **`permission denied for schema public`** (`42501`) on the first start: the role cannot create tables. Grant `USAGE, CREATE ON SCHEMA public`, or make the role the database's owner.
- **`StoragePrefixError` reason `"too-long"`**: shorten the prefix to 24 characters or fewer.
- **`StorageSchemaVersionError`** on an older machine: a machine of this release has upgraded the database. Upgrade that machine to 0.9.88 or later; see [Upgrade a fleet](/guides/worker-hosts#upgrade-a-fleet).
- **Hosts register but never claim**: they serve another prefix or database than the roots, or lack the roots' worker definitions. Compare `atomic worker status` with the roots' `atomic storage status`.

See [Troubleshooting PostgreSQL](/storage#troubleshooting-postgresql) for the other errors.
