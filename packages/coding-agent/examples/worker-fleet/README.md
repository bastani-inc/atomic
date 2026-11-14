# Worker fleet recipes

Starting points for running Atomic worker hosts on any platform, and scaling them. Every host is the same portable
process, `atomic worker start`: it drains on SIGTERM and can exit on its own once idle (`--idle-exit`), so spot and
preemptible machines are safe. See [Scale the fleet automatically](../../docs/guides/worker-hosts.md#scale-the-fleet-automatically).

| Path | What it is |
| --- | --- |
| `Dockerfile` | The worker image; `atomic worker start` runs as PID 1 so SIGTERM drains it |
| `helm/atomic-worker` | A Helm chart sketch: the worker Deployment, `atomic worker metrics` with its Service, and a KEDA `ScaledObject` that scales the workers from zero on `desiredHosts` |
| `terraform/azure-vmss` | An Azure Spot scale set at capacity 0, and a custom role limited to it |
| `terraform/aws-asg` | An AWS Spot Auto Scaling group at desired capacity 0, and an IAM policy limited to it |
| `terraform/gcp-mig` | A Google Cloud Spot managed instance group at size 0, and a custom role conditioned on it |
| `terraform/cloud-init.yaml.tftpl` | The user data the three groups boot with: Atomic, its provider id from the metadata service, and the token from your secret store |
| `github-actions/atomic-workers.yml` | A workflow whose `workers` input fans out that many jobs running `atomic worker start --idle-exit` |
| `presets/*.json` | Command provisioner presets for `atomic worker controller --provisioner`: `az`, `aws`, `gcloud`, `kubectl` and `gh` |

Replace the example names (resource group, group, zone, namespace, repository, database URL) with yours. None of
these files holds a credential: each CLI uses its own login, and each host reads the database token from a secret.
