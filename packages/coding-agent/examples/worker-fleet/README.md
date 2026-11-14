# Worker fleet recipes

Starting points for running Atomic worker hosts on any platform, and scaling them. Every host is the same portable
process, `atomic worker start`: it drains on SIGTERM and can exit on its own once idle (`--idle-exit`), so spot and
preemptible machines are safe. See [Scale the fleet automatically](../../docs/guides/worker-hosts.md#scale-the-fleet-automatically).

| Path | What it is |
| --- | --- |
| `Dockerfile` | The worker image; `atomic worker start` runs as PID 1 so SIGTERM drains it |
| `helm/atomic-worker` | A Helm chart sketch: the worker Deployment, `atomic worker metrics` with its Service, and a KEDA `ScaledObject` that scales the workers from zero on `desiredHosts`. The database URL comes from `database` or from a Secret named by `databaseSecret` |
| `terraform/azure-vmss` | An Azure Spot scale set at capacity 0, and a custom role limited to it. `postgres.tf` adds an Azure Database for PostgreSQL Flexible Server on a private subnet, with its password in Key Vault |
| `terraform/aws-asg` | An AWS Spot Auto Scaling group at desired capacity 0, and an IAM policy limited to it. `postgres.tf` adds an Amazon RDS for PostgreSQL instance in the group's VPC, with its password in Secrets Manager |
| `terraform/gcp-mig` | A Google Cloud Spot managed instance group at size 0, and a custom role conditioned on it. `postgres.tf` adds a Cloud SQL for PostgreSQL instance on a private IP, with its password in Secret Manager |
| `terraform/cloud-init.yaml.tftpl` | The user data the three groups boot with: Atomic and the storage adapter for the database URL, its provider id from the metadata service, the token from your secret store, and the database's CA bundle when it needs one |
| `github-actions/atomic-workers.yml` | A workflow whose `workers` input fans out that many jobs running `atomic worker start --idle-exit` |
| `presets/*.json` | Command provisioner presets for `atomic worker controller --provisioner`: `az`, `aws`, `gcloud`, `kubectl` and `gh` |

The Terraform modules create a managed PostgreSQL database beside the workers and point them at it. Set
`postgres = false` to use a libSQL / Turso database from `database` instead. The PostgreSQL recipes need the
`@bastani/atomic-storage-postgres` adapter and an Atomic release whose `atomic worker start` accepts `postgres://` URLs.
See [PostgreSQL](../../docs/storage.md#postgresql) for sizing, roles and connection poolers.

Replace the example names (resource group, group, zone, namespace, repository, database URL) with yours. None of
these files holds a credential: each CLI uses its own login, and each host reads the database token or password from a secret. Terraform keeps the generated PostgreSQL password in
its state, so keep the state in a private backend.
