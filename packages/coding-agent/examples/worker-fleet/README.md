# Worker fleet recipes

Starting points for running Atomic worker hosts on any platform, and scaling them. Every host is the same portable
process, `atomic worker start`: it drains on SIGTERM and can exit on its own once idle (`--idle-exit`), so spot and
preemptible machines are safe. See [Scale the fleet automatically](../../docs/guides/worker-hosts.md#scale-the-fleet-automatically).

| Path | What it is |
| --- | --- |
| `Dockerfile` | The worker image; `atomic worker start` runs as PID 1 so SIGTERM drains it |
| `helm/atomic-worker` | A Helm chart sketch: the worker Deployment, `atomic worker metrics` with its Service, a KEDA `ScaledObject` that scales the workers from zero on `desiredHosts`, their ServiceAccount (annotate it for workload identity), and optional controller RBAC. The database URL comes from `database` or from a Secret named by `databaseSecret` |
| `terraform/azure-vmss` | An Azure Spot scale set at capacity 0 whose managed identity reads the token from Key Vault, and the controller's managed identity with a custom role limited to the scale set. `postgres.tf` adds an Azure Database for PostgreSQL flexible server on a private subnet, with its password in Key Vault |
| `terraform/aws-asg` | An AWS Spot Auto Scaling group at desired capacity 0 whose instance profile reads the token from Secrets Manager, and the controller's IAM role (instance profile or EKS Pod Identity) limited to the group. `postgres.tf` adds an Amazon RDS for PostgreSQL instance in the group's VPC, with its password in Secrets Manager |
| `terraform/gcp-mig` | A Google Cloud Spot managed instance group at size 0 whose service account reads the token from Secret Manager, and the controller's service account with a custom role conditioned on the group. `postgres.tf` adds a Cloud SQL for PostgreSQL instance on a private IP, with its password in Secret Manager |
| `terraform/cloud-init.yaml.tftpl` | The user data the three groups boot with: Atomic and the storage adapter for the database URL, its provider id from the metadata service, the password or token from your secret store, and the database's CA bundle when it needs one |
| `github-actions/atomic-workers.yml` | A workflow whose `workers` input fans out that many jobs running `atomic worker start --idle-exit`, each reading the token through GitHub OIDC |
| `presets/*.json` | Command provisioner presets for `atomic worker controller --provisioner`: `az`, `aws`, `gcloud`, `kubectl` and `gh` (with GitHub App auth) |

The Terraform modules create a managed PostgreSQL database beside the workers and point them at it. Set
`postgres = false` to use a libSQL / Turso database from `database` instead. See
[Worker fleets on managed PostgreSQL](../../docs/guides/worker-fleets-postgres.md) for connections, poolers and cloud
identities. Terraform keeps the generated PostgreSQL password in its state, so keep the state in a private backend.

Replace the example names (resource group, group, zone, namespace, repository, database URL) with yours. None of
these files holds a credential, and none needs a long-lived cloud key: the VMs, pods and jobs use their platform's
identity (a managed identity, an IAM role, a service account, a Kubernetes ServiceAccount, GitHub's OIDC token), each
host reads the database password or token from your secret manager, and the `gh` preset mints GitHub App tokens for an hour at a
time. See [Credentials for each platform](../../docs/guides/worker-hosts.md#credentials-for-each-platform).
