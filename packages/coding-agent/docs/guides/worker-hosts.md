---
title: "Running workers on many machines"
description: "Turn any Linux or macOS machine into a worker host for shared workflow runs with one command, and run it as a systemd service, from cloud-init, or in a container."
---

# Running workers on many machines

A workflow root with shared placement keeps its work queue in a shared database. Any machine that has Atomic installed can run that root's pooled children: install Atomic, then run one command that names the database. The machines coordinate only through the database. There is no other service to run.

Choose the database:

- **[PostgreSQL](/storage#postgresql)** for fleets in the cloud, or when you already run managed PostgreSQL: Amazon RDS or Aurora, Google Cloud SQL, Azure Database for PostgreSQL, Neon or Supabase. Hosts sign in with a password file or the cloud's own identity. [Worker fleets on managed PostgreSQL](/guides/worker-fleets-postgres) has a recipe for each service.
- **[libSQL or Turso](/storage#turso-and-libsql)** as the lightweight option: one URL and a token. If you host it yourself with sqld, start sqld with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`): sqld 0.24.33 can otherwise stop taking writes when many hosts write at once.

On libSQL the pool's writes take turns, one at a time across the database, and idle hosts poll it. On PostgreSQL hosts claim children, send heartbeats, record checkpoints and complete children in parallel, each write locking only its own rows, and idle hosts are woken through `LISTEN`/`NOTIFY` as soon as work is queued. See [Which store to choose](/storage#which-store-to-choose) and [What works on PostgreSQL](/storage#what-works-on-postgresql). On PostgreSQL, hosts can connect with a runtime role that only reads and writes rows, once the owner role has run `atomic storage migrate`: see [Set up the database](/storage#set-up-the-database). On PostgreSQL, size the server's `max_connections` for every host and its slots, or put a pooler in front: see [Plan connections](/guides/worker-fleets-postgres#plan-connections).

## Join a machine

```bash
# once per machine
npm install -g @bastani/atomic
atomic install npm:@bastani/atomic-storage-postgres
# join and serve; Ctrl+C or SIGTERM drains
atomic worker start --db 'postgresql://atomic@db.example.com:5432/atomic' --password-file /etc/atomic/db-password
```

On libSQL or Turso, install `@bastani/atomic-storage-libsql` instead and pass the token:

```bash
atomic install npm:@bastani/atomic-storage-libsql
atomic worker start --db libsql://pool.example.turso.io --token-file /etc/atomic/token
```

The command prints `ready host=… slots=… journal=…` and then one line per event, such as `claimed child=…` when it takes a child and `released child=…` when the child finished. It serves every running root on that database that uses shared placement, and keeps serving roots that start later or resume on another machine.

- `--db` and its credential apply to this process only and write nothing to settings. On a machine joined with `atomic storage join` or `atomic team join`, `atomic worker start` with no options uses that database.
- A PostgreSQL URL takes exactly one credential: `--password-file`, `--token-file` for a password another process keeps fresh, or `--auth aws|gcp|azure` for the machine's cloud identity. See [Choose a credential](/guides/worker-fleets-postgres#choose-a-credential). A libSQL URL takes `--token-file`.
- `--slots <n>` is the most children the machine runs at once. The default is half its CPUs, from 1 to 16, which leaves room for the tools the children run.
- `--label zone=east` adds a label that `atomic worker status` shows. Repeat it for more labels.
- `--prefix <prefix>` selects the tables of one team when several share a database. On PostgreSQL it can be at most 24 characters, in lowercase.
- `--idle-exit <ms>` drains and exits once no child has run for that long. Use it for machines that should shut down when the queue is empty.
- `--provider-id <id>` names the VM instance, pod or CI job the host runs on, for a [fleet controller](#scale-the-fleet-automatically). It defaults to the `ATOMIC_PROVIDER_ID` environment variable, or on Kubernetes to the pod name.
- `--json` prints the events as one JSON object per line, for log shippers.

See the [CLI reference](/reference/cli#worker-commands) for every option and exit code.

A worker host runs on Linux or macOS. It needs the root's worker definitions at the same absolute module paths, and the root's working directory, unless the root binds its children to a workspace, which the host then restores.

## Start roots with shared placement

On the machine that starts the runs, select the shared database for workflow runs (with `atomic storage join`, or `atomic team join` for libSQL), and set `workflows.workers` beside `workflows.localWorkers` in settings:

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

Roots that the `workflow` tool starts then run their pooled children on this machine's own workers and on every worker host. SDK runs pass `workers: { placement: "shared" }` instead. See [Workflow settings](/settings#local-worker-pools).

## Stop, drain and status

SIGTERM or SIGINT drains a host: it takes no more children, lets the ones it runs finish, leaves the database's host list, and exits `0`. A second signal stops it at once: the children it held go back to the queue, other hosts replay them from their last checkpoints, and it exits `2`. Give a drain as long as the longest child step takes, for example with `TimeoutStopSec` in systemd or `terminationGracePeriodSeconds` in Kubernetes.

A machine that dies, or is killed with SIGKILL, loses nothing that was committed: once its children's leases expire, other hosts take them over from their last checkpoints.

`atomic worker status` prints the fleet: how many running or paused roots use the database and how many of their children are ready and running, then each registered host and each root's queue. `--json` prints the same as JSON, in the shape of `host.stats()`. Each host line starts with the host's state:

- `busy` or `idle`: whether any of its workers runs a child. The line also shows the instance it runs on when it has a provider id, its workers out of its slots, how many are busy, its labels, and when it last reported. Busy counts are as of the host's last report, at most 5 seconds old.
- `draining`: it takes no more children and stops once its running ones finish.
- `degraded`: its polls of the database fail; the line shows how many in a row and the last error.
- `stale`: it has not reported for 15 seconds. It may have died, or lost the database. Its children go to other hosts once their leases expire.
- `live`: a host of an older Atomic version, which does not report whether it is busy.

The command never waits on a database that stops answering: after 5 seconds it prints `shared store degraded`, why, and a hint, and exits `1`. A database it cannot reach at all prints `shared store unknown` the same way. The command also tries one write that changes nothing, and prints `shared store degraded` with the hint when the database answers reads but does not commit that write within 2 seconds.

## Upgrade a fleet

Atomic 0.9.88 upgrades a shared database's session schema the first time it opens it, and older Atomic versions then refuse that database with `StorageSchemaVersionError`. Upgrade every machine that shares the database together, in this order:

1. Stop the fleet controllers and `atomic worker metrics`, so nothing adds hosts.
2. Let running roots finish, or stop them and continue them after the upgrade from `/resume`.
3. Drain the worker hosts with SIGTERM, and stop the Atomic sessions on the machines that start roots.
4. Install 0.9.88 or later on every machine, including container images and the user data of scaling groups (`atomic update`, or `npm install -g @bastani/atomic`), and update the storage adapter with `atomic update --extensions`.
5. Start the roots' machines, then the hosts, then the controllers.

A machine you missed fails to open the database once a newer one has; upgrade it and start it again. Before the first 0.9.88 run, back up the database, for example with your service's snapshots or `pg_dump`.

## Scale the fleet automatically

Every worker host is the same portable process, `atomic worker start`, wherever it runs: a VM, a container, a pod or a CI job. It drains on SIGTERM and can exit on its own once idle (`--idle-exit`), so any platform's own scaling can add and remove hosts safely. Atomic gives that scaling two things:

- **A scaling signal.** `atomic worker metrics` serves how many hosts the fleet wants, with the queue and slots behind it, for KEDA, Prometheus or any autoscaler to act on. Nothing of Atomic runs in your scaling group.
- **A fleet controller.** `atomic worker controller` decides when to add and remove hosts itself, and drives your platform through a provisioner: a [command provisioner](#command-provisioners-and-presets) configured for your platform's CLI (presets for Azure, AWS, Google Cloud, Kubernetes and GitHub Actions come with Atomic), or a JavaScript module of your own.

Both use the same policy and the same defaults, so they want the same number of hosts. Ready-made [recipes](#recipes) cover a container image, a Helm chart with KEDA, Terraform for each cloud's scaling group, and a GitHub Actions workflow.

Before you let the fleet grow, size the database for it: on PostgreSQL, plan its connections or put a pooler in front, as [Plan connections](/guides/worker-fleets-postgres#plan-connections) explains. If you host a libSQL database yourself with sqld, start sqld with `--checkpoint-interval-s 60`, as [Turso and libSQL](/storage#turso-and-libsql) explains: many hosts writing at once can otherwise stop sqld taking writes.

### The scaling signal

The policy wants `max(minHosts, min(maxHosts, ceil(demand / workersPerHost), rateCapHosts))` hosts. Without a rate cap, omit `rateCapHosts` from the minimum. Demand is the ready and running children of every running root, each root capped by its `admission.limits.session`. A root whose budget is spent, or that is paused, counts only its running children.

When roots set fleet-wide model rate limits, the controller and metrics server estimate how many workers those limits can feed. For each limited provider or model, they keep up to 10 minutes of granted calls, started-child counts and time workers spent waiting for tokens. Claims still in placement or workspace restore do not count as started children. They subtract token-waiting time before estimating capacity. A limit that granted a quarter of its rate to 8 nonwaiting workers feeds about 32. A saturated limit, at 95% or more of its rate, with 32 busy workers and the equivalent of 22 workers waiting feeds 10, or 3 hosts of 4 slots. Each limit caps only the roots using its scope. Roots using several scopes satisfy each limit, while work under disjoint scopes and unlimited roots keeps its own capacity. Their combined capacity sets `rateCapHosts`, with at least one host available to make progress; the policy still respects `minHosts` and `maxHosts` and can scale an empty queue to zero.

Each limited scope needs a minute of recent observations. Until then, capacity for work under warming scopes stays at the current serving and booting host count, or one bootstrap host when none exists. Unrelated work can still grow. If a scope has no draws during a minute of observation while its roots run children, its hold ends because there is no evidence that this scope limits the work. The no-draw minute starts over when the scope's roots stop running children. Time booting a host or restoring a claimed child's workspace does not count toward that minute. This applies to unused scopes, tool-only work and unchanged counters left by earlier runs. A scope starts warming again when it begins drawing after being idle. Standby controllers collect observations too. A gap longer than 30 seconds, or three controller ticks when that is longer, starts the observation window over. Scrape `atomic worker metrics` at least once every 30 seconds to build its history. Only readers that keep history apply this cap: a [fleet controller](#the-fleet-controller), `atomic worker metrics`, or SDK reads with `rateHistory: true`; `atomic worker status` does not. Hosts of 0.9.88 do not report these counters. When a bucket's schedule advances without enough counted draws to explain it, that scope supplies no cap for the observation window. A mixed-version fleet can therefore scale more permissively. Upgrade every host for the full cap.

`atomic worker status --json` prints it as `scaling`, and `atomic worker metrics` serves it over HTTP:

```bash
atomic worker metrics --listen 0.0.0.0:9464 --db 'postgresql://atomic@db.example.com:5432/atomic' \
  --password-file /etc/atomic/db-password --workers-per-host 8 --max-hosts 20
```

`atomic worker metrics` only reads a database whose schema is current, so on PostgreSQL a monitoring role with `USAGE` on the `atomic` schema and `SELECT` on its tables can serve it.

- `GET /scaling` returns the signal as JSON, the shape a KEDA [`metrics-api`](https://keda.sh/docs/latest/scalers/metrics-api/) trigger reads. It answers `503` while the database cannot be read.
- `GET /metrics` returns the same counts in Prometheus text: `atomic_fleet_desired_hosts`, `atomic_fleet_desired_workers`, `atomic_fleet_demand`, `atomic_fleet_queue_depth`, `atomic_fleet_running`, `atomic_fleet_hosts`, `atomic_fleet_slots{state="busy"|"idle"}`, the policy's `atomic_fleet_min_hosts`, `atomic_fleet_max_hosts` and `atomic_fleet_workers_per_host`, `atomic_fleet_rate_cap_hosts` whenever a running root sets `rateLimits` and the reader keeps history, even if the limits do not reduce the target, and `atomic_fleet_store_up`.

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
| `rateCapHosts` | Hosts the fleet can keep busy under its rate limits across every root, including unlimited and disjoint-scope work. While history warms, limited work stays at the current host count. Present whenever a running root sets `rateLimits` and the reader keeps history, whether or not it reduces the target. An unused scope or one with uncounted draws leaves its roots' full demand available. |

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
atomic worker controller --provisioner ./fleet.json --db 'postgresql://atomic@db.example.com:5432/atomic' \
  --password-file /etc/atomic/db-password --max-hosts 20 --workers-per-host 8
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

Start each host it creates with `atomic worker start --provider-id <id>`, or the environment variable `ATOMIC_PROVIDER_ID`, set to the id `list` reports for it, so the controller can match the two. On Kubernetes a host uses its pod name by default.

A drain applies to the instance, not only to the worker on it. If a drained host's worker restarts, for example when a pod's container restarts, it registers under a new host id but with the same provider id, so it drains again at once and takes no children until the provider has removed the instance, including while a deletion is still in progress. A host started without a provider id is matched by its host id only. Such a host keeps its id in its agent directory, so if that directory does not survive a restart, set `ATOMIC_PROVIDER_ID` (or `--provider-id`) for its drain to survive the restart. Without one, a restarted host is drained only if `list` reports its new host id for the instance, and the controller keeps a drained instance whose host is gone while a host it cannot match holds a child. When several listings in a row no longer include an instance, the controller forgets its drain, so a new instance that reuses the id serves normally. One listing that briefly misses an instance does not clear its drain.

SDK roots can run it themselves while they run: pass `workers: { placement: "shared", provisioner: { provisioner, maxHosts: 20, workersPerHost: 8 } }`, where `provisioner` is a module's provisioner or `createWorkerHostProvisioner(config)`, or call `startWorkflowFleetController({ provisioner, … })`. When such a root ends, its controller asks the idle hosts above the target to drain at once, but nothing removes them from your provider afterwards unless another controller runs. Have your provisioner reap hosts that exited, or run `atomic worker controller` for a fleet that serves many roots.

Every 10 seconds the controller:

- computes the [scaling signal's](#the-scaling-signal) target, capped by what the rate limits keep busy. When that cap holds the fleet below what its queue wants, it records a `rate-cap` fleet event naming the limit, its rate, what it granted and to how many workers, and another once the cap no longer holds the fleet back.
- adds hosts with `scaleTo` when more than `scaleUpQueueDepth` children have been waiting for `scaleUpDelayMs`, or when children wait and no host runs at all. Hosts below `minHosts` are added at once.
- asks a host to drain once it has held no child for `idleDrainMs` and the fleet is above its target. The host takes no more children, from the moment the drain is asked even before the host has read it, and exits as on SIGTERM; the controller calls `drain` once the host has left the registry. A host that stopped reporting without leaving is removed only 5 minutes after its drain was asked, and only if it holds no child. A host that holds a child is never drained or removed, whether or not it still reports. A child whose root died and whose own lease expired no longer counts, so it does not keep an idle host or the fleet's target up.
- removes a host that has not registered `bootTimeoutMs` after it started, or that the provider reports failed, and replaces it once. A host that registers just as its boot timeout is reached is kept, but a host that registered and then stopped reporting is not. The instance is drained before it is removed, so a host that registers on it during the removal takes no child. Further failures in a row wait 30 seconds, then twice as long each time, up to 10 minutes.
- makes no provider call once its lease may have lapsed, including after its process was paused or blocked: it checks the lease's age right before each call, by the longer of the monotonic and wall clocks, so a machine that slept past its lease does too.

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

`up` and `down` may each be several commands run in order, as `[["first", "…"], ["second", "…"]]`. So may `list`: its commands report their hosts together, and a host two of them report counts once. Changes run one at a time. `timeoutMs` (default 120000) bounds each command; a command still running then, or when the controller gives up on the call, is stopped together with every process it started.

Credentials come from each tool's own login or environment, or, for `gh`, from short-lived tokens Atomic mints from a GitHub App ([GitHub App auth](#github-app-auth)). Nothing in the configuration is a credential, and none of it is written to the database. A command that fails reports its exit code and its error output, with tokens, passwords and the values of secret-named environment variables replaced by `[redacted]`; its arguments are never reported. The error's `code` says what went wrong: `missing-cli` (not installed or not on `PATH`), `auth` (credentials refused), `exit`, `timeout`, `malformed` (output the list format does not match) or `unavailable` (GitHub could not be reached when minting a token, or answered with a server error or a rate limit).

Atomic ships presets in its package's `examples/worker-fleet/presets` directory. Copy one, replace the names in it (resource group, scale set, group, zone, namespace, repository) with yours, and pass it to `--provisioner`. The controller also needs a credential for the database; [Run the fleet controller](/guides/worker-fleets-postgres#run-the-fleet-controller) pairs each preset with one for PostgreSQL:

| Preset | Drives | Host id | Least privilege for the controller | Controller credential |
| --- | --- | --- | --- | --- |
| `azure-vmss.json` | `az vmss scale`, `list-instances`, `delete-instances` | Instance id | A custom role on that one scale set: `Microsoft.Compute/virtualMachineScaleSets/{read,write,delete/action}` and `…/virtualMachines/{read,delete}` | A managed identity: `az login --identity --client-id <id>` on an Azure VM, or Workload Identity in AKS. No service principal secret |
| `aws-asg.json` | `aws autoscaling set-desired-capacity`, `describe-auto-scaling-groups`, `terminate-instance-in-auto-scaling-group` | Instance id | `autoscaling:SetDesiredCapacity` and `autoscaling:TerminateInstanceInAutoScalingGroup` on that group's ARN, and `autoscaling:DescribeAutoScalingGroups`, which AWS does not scope to a resource | A role through the default credential chain: an instance profile, EKS Pod Identity or IRSA. No access keys |
| `gcp-mig.json` | `gcloud compute instance-groups managed resize`, `list-instances`, `delete-instances` | Instance name | A custom role with `compute.instanceGroupManagers.get`, `compute.instanceGroupManagers.update` and `compute.instances.delete` | A service account attached to the VM, or Workload Identity Federation for GKE. No JSON keys |
| `kubernetes.json` | `kubectl scale` on a Deployment, `get pods`, and for removal `delete pod` then a scale-down by one | Pod name | A Role in the namespace with `get`, `list` and `delete` on `pods`, and `get` on `deployments` and `get`, `patch` and `update` on `deployments/scale`, both limited to that Deployment by `resourceNames` | The pod's in-cluster ServiceAccount, which `kubectl` uses on its own. The Helm chart creates it with `controllerRbac: true` |
| `github-actions.json` | `gh workflow run` once per host, `gh run list` for queued, running and waiting runs, `gh run cancel` | Run id | **Actions: read and write** on that one repository | A GitHub App's installation tokens, minted for each hour ([GitHub App auth](#github-app-auth)). Inside Actions, the workflow's own `GITHUB_TOKEN`. Fallback: a fine-grained token |

How each preset removes a host:

- The Azure, AWS and Google Cloud presets delete the named instance and lower the group's size in one call, so the platform never picks a victim.
- The Kubernetes preset deletes the drained pod, then scales the Deployment down by one, so the ReplicaSet does not replace it. If the ReplicaSet already started a replacement, the scale-down removes it, because a ReplicaSet removes pods that are not ready, or have been ready for the shortest time, first. For scaling to zero on Kubernetes, prefer KEDA on [the scaling signal](#the-scaling-signal).
- The GitHub Actions preset starts one workflow run per host, each running `atomic worker start --idle-exit`, and cancels a run only if it never registered. A drained host's run ends by itself.

Give each host its provider id: the instance id from the cloud's metadata service, the pod name from the downward API, or `${{ github.run_id }}` in Actions. The recipes below do this.

### GitHub App auth

The `github-actions.json` preset authenticates `gh` as a GitHub App, as actions-runner-controller and `actions/create-github-app-token` do. The controller signs a JWT with the app's private key, exchanges it for an installation token limited to **Actions: write** on the one repository, and passes the token to each `gh` command in that command's environment only. Each token lasts an hour; the controller mints a new one 5 minutes before it expires, so no long-lived token exists anywhere.

1. Create a GitHub App in your organization with the repository permission **Actions: Read and write** and nothing else, and install it on the repository that holds `atomic-workers.yml`.
2. Generate a private key for the app, and store it on the controller's machine in a file only the controller's user can read: `chmod 600 app.pem`. In Kubernetes, mount it from a Secret, the Secrets Store CSI driver or the External Secrets Operator, and copy it into memory at mode 600 as the Helm chart does for the database token.
3. Give the controller the app's settings, in the preset or in environment variables:

```json
"auth": {
  "githubApp": {
    "appId": "Iv23liExample",
    "installationId": 12345678,
    "privateKeyFile": "/run/secrets/github-app.pem",
    "repository": "acme/flows"
  }
}
```

| Setting | Environment variable | Meaning |
| --- | --- | --- |
| `appId` | `ATOMIC_GITHUB_APP_ID` | The app's client ID or app ID |
| `installationId` | `ATOMIC_GITHUB_APP_INSTALLATION_ID` | The installation's id, from the URL of its settings page |
| `privateKeyFile` | `ATOMIC_GITHUB_APP_PRIVATE_KEY_FILE` | The private key file. The controller refuses a key that other users can read |
| `repository` | `ATOMIC_GITHUB_APP_REPOSITORY` | `owner/name`: the only repository the tokens can act on |
| `host` | `ATOMIC_GITHUB_HOST` | Default `github.com`. For GitHub Enterprise Server, its host name |
| `apiUrl` | `ATOMIC_GITHUB_API_URL` | Default `https://api.github.com`, `https://api.<host>` for GHE.com, or `https://<host>/api/v3` for GitHub Enterprise Server. It must use HTTPS; plain HTTP is accepted only for `localhost` |

A setting in the file takes precedence over its variable. The shipped preset sets only `repository`, so the rest can come from the environment. For GitHub Enterprise Server, the controller passes the token as `GH_ENTERPRISE_TOKEN` with `GH_HOST`, as `gh` expects.

The private key and the tokens are never printed, logged or written to the database. If GitHub refuses the app (`auth`), or cannot be reached or answers with an error (`unavailable`), or the request runs past `timeoutMs` (`timeout`), the controller reports `degraded`, keeps its hosts, and tries again with its usual backoff. Runs are never affected.

To use a fine-grained personal access token instead, remove `auth` from the preset and give the controller the token as `GH_TOKEN`, or sign in once with `gh auth login`. Give the token access to that one repository with **Actions: Read and write**, and an expiry.

A controller that runs inside GitHub Actions needs neither: remove `auth`, and pass the workflow's own token. `workflow_dispatch` events made with `GITHUB_TOKEN` do start workflow runs.

```yaml
permissions:
  actions: write
steps:
  - run: atomic worker controller --provisioner github-actions.json --db "$ATOMIC_DB" --token-file "$RUNNER_TEMP/atomic-db-token"
    env:
      GH_TOKEN: ${{ github.token }}
```

### Credentials for each platform

Every recipe uses the platform's own short-lived identity, and no recipe stores a cloud key:

| Credential | How the recipes get it | Pattern it follows |
| --- | --- | --- |
| `gh` for the GitHub Actions preset | GitHub App installation tokens, minted for each hour and narrowed to **Actions: write** on one repository | actions-runner-controller, philips-labs/terraform-aws-github-runner, `actions/create-github-app-token` |
| `az` for the Azure preset, and the VMs' database token | Managed identities: the VMs' system-assigned identity reads the token from Key Vault, and the controller runs as a user-assigned identity, attached to its VM or federated with a workload | Azure managed identities and workload identity federation |
| `aws` for the AWS preset, and the instances' database token | IAM roles through the default credential chain: an instance profile reads the token from Secrets Manager, and the controller's role suits an instance profile, EKS Pod Identity or IRSA | AWS IAM roles for EC2, EKS Pod Identity |
| `gcloud` for the Google Cloud preset, and the VMs' database token | Service accounts: one attached to the VMs reads the token from Secret Manager, and the controller's runs on its VM or through Workload Identity Federation for GKE | Google Cloud attached service accounts, Workload Identity Federation |
| `kubectl` for the Kubernetes preset | The controller pod's ServiceAccount, with a Role limited to the worker Deployment | Kubernetes in-cluster config and RBAC |
| KEDA reading the scaling signal | Nothing: the metrics Service is in-cluster and serves counts only. Limit who reaches it with a NetworkPolicy. Scalers that read a cloud service take a `TriggerAuthentication` with `podIdentity` | KEDA authentication providers |
| Cloud access from GitHub Actions | GitHub's OIDC token (`id-token: write`) with `azure/login`, `aws-actions/configure-aws-credentials` or `google-github-actions/auth` | GitHub Actions OpenID Connect |
| The shared database's password or token (`--password-file`, `--token-file`), or no stored credential with `--auth aws\|gcp\|azure` on PostgreSQL | Read from a secret manager at boot (Key Vault, Secrets Manager, Secret Manager), or mounted in Kubernetes from a Secret synced by the External Secrets Operator or the Secrets Store CSI driver, and copied to a mode 600 file. Never baked into an image | Secrets Store CSI driver, External Secrets Operator |

A database password or token is long-lived. On PostgreSQL, `--auth` replaces it with a short-lived token from the machine's cloud identity: see [Worker fleets on managed PostgreSQL](/guides/worker-fleets-postgres).

### Recipes

The package's `examples/worker-fleet` directory has a starting point for each platform:

- `Dockerfile`: the worker image. It runs `atomic worker start` as PID 1 so SIGTERM drains it. `STORAGE_ADAPTER` selects the adapter it installs: `atomic-storage-postgres` (the default) or `atomic-storage-libsql`.
- `helm/atomic-worker`: a Helm chart sketch with the worker Deployment, an `atomic worker metrics` Deployment and Service, and a KEDA `ScaledObject` that scales the workers from zero. The pods run as their own ServiceAccount, which you can annotate for workload identity (`serviceAccount.annotations`, `podLabels`). The database URL comes from `database`, or from the `url` key of the Secret that `databaseSecret` names. An init container copies the password or token from its Secret, or from your secret manager through the Secrets Store CSI driver (`tokenSecretProviderClass`), into memory, readable only by the container's user. `controllerRbac: true` replaces KEDA with a ServiceAccount and Role for a controller that uses the `kubernetes.json` preset. Install the release in its own namespace, because a Role cannot limit `patch` on pods to one Deployment's pods.
- `terraform/azure-vmss`, `terraform/aws-asg`, `terraform/gcp-mig`: a scaling group of spot or preemptible VMs that boot into `atomic worker start` with their provider id, at size 0. Each module's `postgres.tf` creates a managed PostgreSQL database beside the group (Azure Database for PostgreSQL, Amazon RDS, Cloud SQL) and keeps its password in the cloud's secret manager; set `postgres = false` to use a libSQL or Turso database from `database` instead. The VMs read the password or token from the secret manager with their own identity. Each module also creates the controller's identity (a managed identity, an IAM role, a service account) with the least-privilege role for its preset.
- `github-actions/atomic-workers.yml`: a workflow whose `workflow_dispatch` input `workers` fans out that many jobs, each running `atomic worker start --idle-exit`. Each job installs the adapter that matches `ATOMIC_DB`, signs in to your cloud with GitHub's OIDC token, and reads the database password or token from its secret manager. Run it by hand for a burst, or let the `github-actions.json` preset dispatch it.
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

`/etc/atomic/worker.env` holds the URL, such as `ATOMIC_DB=postgresql://atomic@db.example.com:5432/atomic`. `/etc/atomic/token` holds the PostgreSQL password, or the libSQL token, owned by the `atomic` user with mode 600. `--token-file` reads it again for every new connection, so a rotated password takes effect without a restart. With a cloud identity, replace `--token-file /etc/atomic/token` with `--auth aws`, `--auth gcp` or `--auth azure`. Run `atomic install npm:@bastani/atomic-storage-postgres` (or `@bastani/atomic-storage-libsql`) as the `atomic` user, because each user has their own agent directory. Exit code `1` is a setup error, which `Restart=on-failure` retries; read it with `journalctl -u atomic-worker`.

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
      ATOMIC_DB=postgresql://atomic@db.example.com:5432/atomic
  - path: /etc/atomic/token
    permissions: "0600"
    content: |
      <database password>
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
  - [sh, -c, "npm install -g @bastani/atomic && sudo -iu atomic atomic install npm:@bastani/atomic-storage-postgres"]
  - [systemctl, enable, --now, atomic-worker]
```

Put the password in the user data only when the user data itself is private to the VM. Otherwise fetch it from your secret store in `runcmd` before the last line, as the package's Terraform recipes do. For libSQL, set a `libsql://` URL, put the token in `/etc/atomic/token`, and install `@bastani/atomic-storage-libsql`.

## Run it in a container

```dockerfile
FROM node:22-bookworm-slim
ARG ATOMIC_VERSION=latest
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @bastani/atomic@${ATOMIC_VERSION}
ARG STORAGE_ADAPTER=atomic-storage-postgres
USER node
RUN atomic install npm:@bastani/${STORAGE_ADAPTER}
STOPSIGNAL SIGTERM
ENTRYPOINT ["sh", "-c", "exec atomic worker start --db \"$ATOMIC_DB\" --token-file /run/secrets/atomic-db-token \"$@\"", "--"]
```

```bash
docker run -d --name atomic-worker -e ATOMIC_DB=postgresql://atomic@db.example.com:5432/atomic \
  -v "$PWD/db-password:/run/secrets/atomic-db-token:ro" --stop-timeout 900 atomic-worker --slots 4
```

`exec` makes `atomic` the process that receives the container's SIGTERM, so stopping the container drains it. Mount the password or token as a secret file, never as an environment variable or build argument. For libSQL, build with `--build-arg STORAGE_ADAPTER=atomic-storage-libsql` and pass a `libsql://` URL. Options after the image name, such as `--slots 4`, are passed to `atomic worker start`. Process containment needs Linux, so run the container on a Linux host.

## Security

- The token is the trust boundary. Anyone with a token for the database can read and write every table in it, including the work queue. Give a token only to machines you trust to run your workflows.
- `atomic worker start` reads the token from a file only when it opens the database. It never prints or logs the token, and never puts it on a child process's command line. The workers it starts receive a reference to the token file, not the token.
- Keep the token file at mode 600. The command warns when other users can read it.
- Keep a GitHub App private key at mode 600 too. The controller refuses one that other users can read, and never prints it, the tokens it mints, or their JWT.

## Troubleshooting

- **`Worker host setup is incomplete`** lists every missing piece at once, with a fix for each: the adapter not installed (`atomic install npm:@bastani/atomic-storage-postgres` for a PostgreSQL URL, `atomic install npm:@bastani/atomic-storage-libsql` for libSQL), a token file that cannot be read, a journal that other machines cannot open (pass `--db`), or a machine where Atomic cannot contain its workers' processes (Windows, or no native process identity). The command exits `1`.
- **`degraded failures=… retry_in_ms=…`** means the host could not reach the database. It keeps running its children and tries again after 1 second, then twice as long after each further failure, up to 30 seconds, and prints `recovered` once it gets through. Its workers keep their children while each child's lease (`localWorkers.leaseMs`, 30 seconds by default) lasts. A child whose lease expires during a longer outage, or that writes a checkpoint while the database is unreachable, is replayed by another host from its last checkpoint.
- **`shared store unknown` or `shared store degraded`**, or hosts that all turn `stale` at once, mean the database stopped answering or stopped committing writes. sqld 0.24.33 and earlier can stop taking writes from every client until it restarts ([tursodatabase/libsql#2286](https://github.com/tursodatabase/libsql/issues/2286)): start sqld with `--checkpoint-interval-s 60` (`SQLD_CHECKPOINT_INTERVAL_S=60`) to avoid it, and restart it if writes stay stuck. Hosts keep their running children meanwhile.
- **PostgreSQL connection, TLS, pooler and cloud identity errors**: see [Troubleshooting](/guides/worker-fleets-postgres#troubleshooting) in the PostgreSQL fleet guide.
- **A host never claims anything.** It runs a root's children only if it has the root's worker definitions at the same paths with the same entry module, and the root uses shared placement. Check `atomic worker status`, and the run in `/workflows` on the root's machine.
