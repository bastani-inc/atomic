---
title: "Running workers on many machines"
description: "Turn any Linux or macOS machine into a worker host for shared workflow runs with one command, and run it as a systemd service, from cloud-init, or in a container."
---

# Running workers on many machines

A workflow root with shared placement keeps its work queue in a shared libSQL or Turso database. Any machine that has Atomic installed can run that root's pooled children: install Atomic, then run one command that names the database. The machines coordinate only through the database. There is no other service to run.

## Join a machine

```bash
# once per machine
npm install -g @bastani/atomic
atomic install npm:@bastani/atomic-storage-libsql
# join and serve; Ctrl+C or SIGTERM drains
atomic worker start --db libsql://pool.example.turso.io --token-file /etc/atomic/token
```

The command prints `ready host=… slots=… journal=…` and then one line per event, such as `claimed child=…` when it takes a child and `released child=…` when the child finished. It serves every running root on that database that uses shared placement, and keeps serving roots that start later or resume on another machine.

- `--db` and `--token-file` apply to this process only and write nothing to settings. On a machine joined with `atomic team join`, `atomic worker start` with no options uses the team database.
- `--slots <n>` is the most children the machine runs at once. The default is half its CPUs, from 1 to 16, which leaves room for the tools the children run.
- `--label zone=east` adds a label that `atomic worker status` shows. Repeat it for more labels.
- `--prefix <prefix>` selects the tables of one team when several share a database.
- `--idle-exit <ms>` drains and exits once no child has run for that long. Use it for machines that should shut down when the queue is empty.
- `--json` prints the events as one JSON object per line, for log shippers.

See the [CLI reference](/reference/cli#worker-commands) for every option and exit code.

A worker host runs on Linux or macOS. It needs the root's worker definitions at the same absolute module paths, and the root's working directory, unless the root binds its children to a workspace, which the host then restores. See [Workers on other hosts](/workflows/operations#workers-on-other-hosts).

## Start roots with shared placement

On the machine that starts the runs, select the shared database for workflow runs (for example with `atomic team join`), and set `workflows.workers` beside `workflows.localWorkers` in settings:

```json
{
  "workflows": {
    "localWorkers": {
      "count": 2,
      "definitions": [{ "path": "/srv/flows/workflows/research.ts", "exportName": "research" }]
    },
    "workers": { "placement": "shared" }
  }
}
```

Roots that `/workflow run` starts then run their pooled children on this machine's own workers and on every worker host. SDK runs pass `workers: { placement: "shared" }` instead. See [Workflow settings](/settings#local-worker-pools).

## Stop, drain and status

SIGTERM or SIGINT drains a host: it takes no more children, lets the ones it runs finish, leaves the database's host list, and exits `0`. A second signal stops it at once: the children it held go back to the queue, other hosts replay them from their last checkpoints, and it exits `2`. Give a drain as long as the longest child step takes, for example with `TimeoutStopSec` in systemd or `terminationGracePeriodSeconds` in Kubernetes.

A machine that dies, or is killed with SIGKILL, loses nothing that was committed: once its children's leases expire, other hosts take them over from their last checkpoints.

`atomic worker status` prints the fleet: how many running or paused roots use the database and how many of their children are ready and running, then each registered host and each root's queue. `--json` prints the same as JSON, in the shape of `host.stats()`. Each host line starts with the host's state:

- `busy` or `idle`: whether any of its workers runs a child. The line also shows its workers out of its slots, how many are busy, its labels, and when it last reported. Busy counts are as of the host's last report, at most 5 seconds old.
- `draining`: it takes no more children and stops once its running ones finish.
- `degraded`: its polls of the database fail; the line shows how many in a row and the last error.
- `stale`: it has not reported for 15 seconds. It may have died, or lost the database. Its children go to other hosts once their leases expire.
- `live`: a host of an older Atomic version, which does not report whether it is busy.

The command never waits on a database that stops answering: after 5 seconds it prints `shared store degraded`, why, and a hint, and exits `1`. A database it cannot reach at all prints `shared store unknown` the same way. The command also tries one write that changes nothing, and prints `shared store degraded` with the hint when the database answers reads but does not commit that write within 2 seconds.

## Scale the fleet automatically

Every worker host is the same portable process, `atomic worker start`, wherever it runs: a VM, a container, a pod or a CI job. It drains on SIGTERM and can exit on its own once idle (`--idle-exit`), so any platform's own scaling can add and remove hosts safely. Atomic gives that scaling two things:

- **A scaling signal.** `atomic worker metrics` serves how many hosts the fleet wants, with the queue and slots behind it, for KEDA, Prometheus or any autoscaler to act on. Nothing of Atomic runs in your scaling group.
- **A fleet controller.** `atomic worker controller` decides when to add and remove hosts itself, and drives your platform through a provisioner: a [command provisioner](#command-provisioners-and-presets) configured for your platform's CLI (presets for Azure, AWS, Google Cloud, Kubernetes and GitHub Actions come with Atomic), or a JavaScript module of your own.

Both use the same policy and the same defaults, so they want the same number of hosts. Ready-made [recipes](#recipes) cover a container image, a Helm chart with KEDA, Terraform for each cloud's scaling group, and a GitHub Actions workflow.

If you host the shared database yourself with sqld, start sqld with `--checkpoint-interval-s 60` before you let the fleet grow, as [Turso and libSQL](/storage#turso-and-libsql) explains: many hosts writing at once can otherwise stop sqld taking writes.

### The scaling signal

The policy wants `ceil(demand / workersPerHost)` hosts, kept between `minHosts` and `maxHosts`. Demand is the ready and running children of every running root, each root capped by its `admission.limits.session`. A root whose budget is spent, or that is paused, counts only its running children.

`atomic worker status --json` prints it as `scaling`, and `atomic worker metrics` serves it over HTTP:

```bash
atomic worker metrics --listen 0.0.0.0:9464 --db libsql://pool.example.turso.io \
  --token-file /etc/atomic/token --workers-per-host 8 --max-hosts 20
```

- `GET /scaling` returns the signal as JSON, the shape a KEDA [`metrics-api`](https://keda.sh/docs/latest/scalers/metrics-api/) trigger reads. It answers `503` while the database cannot be read.
- `GET /metrics` returns the same counts in Prometheus text: `atomic_fleet_desired_hosts`, `atomic_fleet_desired_workers`, `atomic_fleet_demand`, `atomic_fleet_queue_depth`, `atomic_fleet_running`, `atomic_fleet_hosts`, `atomic_fleet_slots{state="busy"|"idle"}`, the policy's `atomic_fleet_min_hosts`, `atomic_fleet_max_hosts` and `atomic_fleet_workers_per_host`, and `atomic_fleet_store_up`.

| Field | Meaning |
| --- | --- |
| `desiredHosts` | Hosts the policy wants |
| `desiredWorkers` | `desiredHosts × workersPerHost` |
| `demand` | Children the roots can run at once |
| `queueDepth` | Ready children of roots that can start them now |
| `running` | Children running on hosts |
| `hosts` | Hosts that reported within 15 seconds |
| `busySlots`, `idleSlots` | Their slots running a child, and free on hosts that are not draining |
| `minHosts`, `maxHosts`, `workersPerHost` | The policy it was computed with (`--min-hosts`, `--max-hosts`, `--workers-per-host`) |

The endpoints serve counts only: no host, root, URL or token. They read the database at most once every 5 seconds however often they are scraped, never write to it, and cut off a client that takes longer than 10 seconds. The default address is `127.0.0.1:9464`; listen on `0.0.0.0` only inside a container or a private network.

A KEDA `ScaledObject` that scales a Deployment of worker pods to `desiredHosts`, down to zero:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: atomic-worker, namespace: atomic }
spec:
  scaleTargetRef: { name: atomic-worker }
  minReplicaCount: 0
  maxReplicaCount: 20
  advanced:
    horizontalPodAutoscalerConfig:
      behavior: { scaleDown: { stabilizationWindowSeconds: 300 } }
  triggers:
    - type: metrics-api
      metadata:
        url: "http://atomic-worker-metrics.atomic.svc:9464/scaling"
        valueLocation: desiredHosts
        targetValue: "1"
        activationTargetValue: "0"
```

When KEDA scales in, Kubernetes sends SIGTERM to pods it picks, which may be busy: each drains and finishes its children within `terminationGracePeriodSeconds`, and a child still running after that is replayed on another host from its last checkpoint. Set the grace period to your longest child step.

### The fleet controller

A fleet controller adds worker hosts when the queues grow, and drains and removes only hosts that sat idle, so it never removes a busy host. Run it on any machine that opens the database:

```bash
atomic worker controller --provisioner ./fleet.json --db libsql://pool.example.turso.io \
  --token-file /etc/atomic/token --max-hosts 20 --workers-per-host 8
```

`--provisioner` takes the JSON configuration of a [command provisioner](#command-provisioners-and-presets), or a JavaScript module whose default export is a provisioner with three methods:

```js
// provisioner.mjs
export default {
  kind: "my-cloud",
  // Every host it manages: { id, state: "pending" | "running" | "draining" | "stopped" | "failed", since }.
  async list(signal) { /* … */ return []; },
  // Run `target` hosts, counting every host list() reports. Only ever called to add hosts.
  async scaleTo(target, signal) { /* … */ },
  // Remove one host, which drained already or never registered, and lower the count by one.
  async drain(id, signal) { /* … */ },
};
```

Start each host it creates with `atomic worker start` and the environment variable `ATOMIC_WORKER_PROVIDER_ID` set to the host's provider id, so the controller can match the two.

SDK roots can run it themselves while they run: pass `workers: { placement: "shared", provisioner: { provisioner, maxHosts: 20, workersPerHost: 8 } }`, where `provisioner` is a module's provisioner or `createWorkerHostProvisioner(config)`, or call `startWorkflowFleetController({ provisioner, … })`. When such a root ends, its controller asks the idle hosts above the target to drain at once, but nothing removes them from your provider afterwards unless another controller runs. Have your provisioner reap hosts that exited, or run `atomic worker controller` for a fleet that serves many roots.

Every 10 seconds the controller:

- computes the [scaling signal's](#the-scaling-signal) target.
- adds hosts with `scaleTo` when more than `scaleUpQueueDepth` children have been waiting for `scaleUpDelayMs`, or when children wait and no host runs at all. Hosts below `minHosts` are added at once.
- asks a host to drain once it has held no child for `idleDrainMs` and the fleet is above its target. The host takes no more children and exits as on SIGTERM; the controller then calls `drain`. A host that holds a child is never drained or removed.
- removes a host that has not registered `bootTimeoutMs` after it started, or that the provider reports failed, and replaces it once. Further failures in a row wait 30 seconds, then twice as long each time, up to 10 minutes.

| Option | Default | |
| --- | --- | --- |
| `minHosts` / `--min-hosts` | 0 | Hosts kept however idle |
| `maxHosts` / `--max-hosts` | 10 | Hosts never exceeded |
| `workersPerHost` / `--workers-per-host` | 4 | The `--slots` the hosts start with |
| `scaleUpQueueDepth` / `--scale-up-queue-depth` | `workersPerHost` | Children allowed to wait before hosts are added |
| `scaleUpDelayMs` / `--scale-up-delay` | 20000 | How long they wait first |
| `idleDrainMs` / `--idle-drain` | 300000 | Idle time before a host is drained |
| `bootTimeoutMs` / `--boot-timeout` | 600000 | Time a new host has to register |

You can run several controllers, such as one per root machine. One is active at a time through a lease in the database; another takes over within 30 seconds when it stops or dies. A provisioner that fails (a missing CLI, refused credentials, a quota) never fails, pauses or blocks a run: the controller prints `degraded`, keeps the hosts the fleet has, and tries again after 10 seconds, then twice as long after each further failure, up to 10 minutes. Every decision and failure is recorded in the database's last 1000 fleet events.

### Command provisioners and presets

A command provisioner runs three commands of yours, each an executable and its arguments, never through a shell, with the controller's environment:

```json
{
  "kind": "command",
  "up": ["/opt/fleet/scale-to", "--count", "{target}"],
  "down": ["/opt/fleet/remove", "{id}"],
  "list": ["/opt/fleet/list", "--json"]
}
```

- `up` adds hosts. `{target}` (also `ATOMIC_TARGET`) is the count to reach and `{add}` (`ATOMIC_ADD`) how many that adds. It runs only when `list` reports fewer than `target` hosts. With `"upEach": true` it runs once for each host to add, with `{add}` 1.
- `down` removes the host `{id}` (`ATOMIC_PROVIDER_ID`), which drained already or never started, and lowers the count by one. `{remaining}` (`ATOMIC_REMAINING`) is the count `list` reported, less one. It runs only for a host that `list` reports and that is not `draining` already, so removing a host twice, or one already gone, does nothing.
- `list` prints the hosts as JSON: by default an array of `{ "id": "vm-3", "state": "running", "since": "2026-11-14T09:30:00Z" }`, where `state` is `pending`, `running`, `draining`, `stopped` or `failed`, and `since` (milliseconds or ISO 8601) and `hostId` (the Atomic host id, when you know it) are optional. `listFormat` reads other JSON: `items` is the path to the array (such as `AutoScalingGroups.0.Instances`), `id`, `state`, `since` and `hostId` are paths in each item, and `states` maps your platform's states to host states. A state mapped to `null` leaves the host out, for hosts your platform no longer counts, such as one being deleted; `"*"` maps any state not listed.

`up` and `down` may each be several commands run in order, as `[["first", "…"], ["second", "…"]]`. Changes run one at a time. `timeoutMs` (default 120000) bounds each command; a command still running then, or when the controller gives up on the call, is stopped together with every process it started.

Credentials come only from each tool's own login or environment; nothing in the configuration is a credential, and none of it is written to the database. A command that fails reports its exit code and its error output, with tokens, passwords and the values of secret-named environment variables replaced by `[redacted]`; its arguments are never reported. The error's `code` says what went wrong: `missing-cli` (not installed or not on `PATH`), `auth` (credentials refused), `exit`, `timeout` or `malformed` (output the list format does not match).

Atomic ships presets in its package's `examples/worker-fleet/presets` directory. Copy one, replace the names in it (resource group, scale set, group, zone, namespace, repository) with yours, and pass it to `--provisioner`:

| Preset | Drives | Host id | Least privilege for the controller |
| --- | --- | --- | --- |
| `azure-vmss.json` | `az vmss scale`, `list-instances`, `delete-instances` | Instance id | A custom role on that one scale set: `Microsoft.Compute/virtualMachineScaleSets/{read,write,delete/action}` and `…/virtualMachines/{read,delete}` |
| `aws-asg.json` | `aws autoscaling set-desired-capacity`, `describe-auto-scaling-groups`, `terminate-instance-in-auto-scaling-group` | Instance id | `autoscaling:SetDesiredCapacity` and `autoscaling:TerminateInstanceInAutoScalingGroup` on that group's ARN, and `autoscaling:DescribeAutoScalingGroups`, which AWS does not scope to a resource |
| `gcp-mig.json` | `gcloud compute instance-groups managed resize`, `list-instances`, `delete-instances` | Instance name | A custom role with `compute.instanceGroupManagers.get`, `compute.instanceGroupManagers.update` and `compute.instances.delete` |
| `kubernetes.json` | `kubectl scale` on a Deployment, `get pods`, and for removal `annotate` with `controller.kubernetes.io/pod-deletion-cost` then a scale-down by one | Pod name | A Role in the namespace with `get`, `list` and `patch` on `pods`, and `get` on `deployments` and `get`, `patch` and `update` on `deployments/scale`, both limited to that Deployment by `resourceNames` |
| `github-actions.json` | `gh workflow run` once per host, `gh run list`, `gh run cancel` | Run id | A fine-grained token for that one repository with **Actions: read and write**, as `GH_TOKEN` |

How each preset removes a host:

- The Azure, AWS and Google Cloud presets delete the named instance and lower the group's size in one call, so the platform never picks a victim.
- The Kubernetes preset marks the drained pod with the lowest deletion cost, then scales the Deployment down by one. The ReplicaSet removes pending pods first, then the marked pod, never a busy one. If a pod was still pending, it goes instead, and the drained pod is drained again later. For scaling to zero on Kubernetes, prefer KEDA on [the scaling signal](#the-scaling-signal).
- The GitHub Actions preset starts one workflow run per host, each running `atomic worker start --idle-exit`, and cancels a run only if it never registered. A drained host's run ends by itself.

Give each host its provider id: the instance id from the cloud's metadata service, the pod name from the downward API, or `${{ github.run_id }}` in Actions. The recipes below do this.

### Recipes

The package's `examples/worker-fleet` directory has a starting point for each platform:

- `Dockerfile`: the worker image. It runs `atomic worker start` as PID 1 so SIGTERM drains it.
- `helm/atomic-worker`: a Helm chart sketch with the worker Deployment, an `atomic worker metrics` Deployment and Service, and a KEDA `ScaledObject` that scales the workers from zero.
- `terraform/azure-vmss`, `terraform/aws-asg`, `terraform/gcp-mig`: a scaling group of spot or preemptible VMs that boot into `atomic worker start` with their provider id, at size 0, and the least-privilege role for the controller's preset.
- `github-actions/atomic-workers.yml`: a workflow whose `workflow_dispatch` input `workers` fans out that many jobs, each running `atomic worker start --idle-exit`. Run it by hand for a burst, or let the `github-actions.json` preset dispatch it.
- `presets/`: the command provisioner presets above.

Spot and preemptible machines are safe: a host told to stop gets SIGTERM and drains, and a child cut off before it finishes is replayed on another host from its last checkpoint.

## Run it as a systemd service

`/etc/systemd/system/atomic-worker.service`:

```ini
[Unit]
Description=Atomic worker host
After=network-online.target
Wants=network-online.target

[Service]
User=atomic
EnvironmentFile=/etc/atomic/worker.env
ExecStart=/usr/bin/env atomic worker start --db ${ATOMIC_DB} --token-file /etc/atomic/token
KillSignal=SIGTERM
TimeoutStopSec=900
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`/etc/atomic/worker.env` holds `ATOMIC_DB=libsql://pool.example.turso.io`. `/etc/atomic/token` holds the database token, owned by the `atomic` user with mode 600. Run `atomic install npm:@bastani/atomic-storage-libsql` as the `atomic` user, because each user has their own agent directory. Exit code `1` is a setup error, which `Restart=on-failure` retries; read it with `journalctl -u atomic-worker`.

## Provision with cloud-init

This user data installs Atomic on a new VM and joins it:

```yaml
#cloud-config
users:
  - name: atomic
    shell: /bin/bash
write_files:
  - path: /etc/atomic/worker.env
    content: |
      ATOMIC_DB=libsql://pool.example.turso.io
  - path: /etc/atomic/token
    permissions: "0600"
    content: |
      <database token>
  - path: /etc/systemd/system/atomic-worker.service
    content: |
      [Unit]
      Description=Atomic worker host
      After=network-online.target
      Wants=network-online.target
      [Service]
      User=atomic
      EnvironmentFile=/etc/atomic/worker.env
      ExecStart=/usr/bin/env atomic worker start --db ${ATOMIC_DB} --token-file /etc/atomic/token
      KillSignal=SIGTERM
      TimeoutStopSec=900
      Restart=on-failure
      [Install]
      WantedBy=multi-user.target
runcmd:
  - [sh, -c, "chown atomic:atomic /etc/atomic/token"]
  - [sh, -c, "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs git"]
  - [sh, -c, "npm install -g @bastani/atomic && sudo -iu atomic atomic install npm:@bastani/atomic-storage-libsql"]
  - [systemctl, enable, --now, atomic-worker]
```

Put the token in the user data only when the user data itself is private to the VM. Otherwise fetch it from your secret store in `runcmd` before the last line.

## Run it in a container

```dockerfile
FROM node:22-bookworm-slim
ARG ATOMIC_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @bastani/atomic@${ATOMIC_VERSION}
USER node
RUN atomic install npm:@bastani/atomic-storage-libsql
STOPSIGNAL SIGTERM
ENTRYPOINT ["sh", "-c", "exec atomic worker start --db \"$ATOMIC_DB\" --token-file /run/secrets/atomic-db-token \"$@\"", "--"]
```

```bash
docker run -d --name atomic-worker -e ATOMIC_DB=libsql://pool.example.turso.io \
  -v "$PWD/token:/run/secrets/atomic-db-token:ro" --stop-timeout 900 atomic-worker --slots 4
```

`exec` makes `atomic` the process that receives the container's SIGTERM, so stopping the container drains it. Mount the token as a secret file, never as an environment variable or build argument. Options after the image name, such as `--slots 4`, are passed to `atomic worker start`. Process containment needs Linux, so run the container on a Linux host.

## Security

- The token is the trust boundary. Anyone with a token for the database can read and write every table in it, including the work queue. Give a token only to machines you trust to run your workflows.
- `atomic worker start` reads the token from a file only when it opens the database. It never prints or logs the token, and never puts it on a child process's command line. The workers it starts receive a reference to the token file, not the token.
- Keep the token file at mode 600. The command warns when other users can read it.

## Troubleshooting

- **`Worker host setup is incomplete`** lists every missing piece at once, with a fix for each: the adapter not installed (`atomic install npm:@bastani/atomic-storage-libsql`), a token file that cannot be read, a journal that other machines cannot open (pass `--db`), or a machine where Atomic cannot contain its workers' processes (Windows, or no native process identity). The command exits `1`.
- **`degraded failures=… retry_in_ms=…`** means the host could not reach the database. It keeps running its children and tries again after 1 second, then twice as long after each further failure, up to 30 seconds, and prints `recovered` once it gets through. Its workers keep their children while each child's lease (`localWorkers.leaseMs`, 30 seconds by default) lasts. A child whose lease expires during a longer outage, or that writes a checkpoint while the database is unreachable, is replayed by another host from its last checkpoint.
- **`shared store unknown` or `shared store degraded`**, or hosts that all turn `stale` at once, mean the database stopped answering or stopped committing writes. sqld 0.24.33 and earlier can stop taking writes from every client until it restarts ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)): start sqld with `--checkpoint-interval-s 60` (`SQLD_CHECKPOINT_INTERVAL_S=60`) to avoid it, and restart it if writes stay stuck. Hosts keep their running children meanwhile.
- **A host never claims anything.** It runs a root's children only if it has the root's worker definitions at the same paths with the same entry module, and the root uses shared placement. Check `atomic worker status`, and `/workflow status <run>` on the root's machine.
