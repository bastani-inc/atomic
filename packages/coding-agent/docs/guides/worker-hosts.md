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

A fleet controller adds worker hosts when the queues of the database's shared roots grow, and drains and removes hosts that sat idle. It drives a provisioner that starts and removes machines in your cloud or cluster: one of the [built-in provisioners](#built-in-provisioners) for Azure scale sets, Kubernetes and your own scripts, or a JavaScript module of your own. A module's provisioner has three methods:

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

Start each host it creates with `atomic worker start` and the environment variable `ATOMIC_WORKER_PROVIDER_ID` set to the host's provider id, so the controller can match the two. Then run the controller on any machine that opens the database:

```bash
atomic worker controller --provisioner ./provisioner.mjs --db libsql://pool.example.turso.io \
  --token-file /etc/atomic/token --max-hosts 20 --workers-per-host 8
```

SDK roots can run it themselves while they run: pass `workers: { placement: "shared", provisioner: { provisioner, maxHosts: 20, workersPerHost: 8 } }`, or call `startWorkflowFleetController({ provisioner, … })`. When such a root ends, its controller asks the idle hosts above the target to drain at once, but nothing removes them from your provider afterwards unless another controller runs. Have your provisioner reap hosts that exited, or run `atomic worker controller` for a fleet that serves many roots.

Every 10 seconds the controller:

- computes a target of `ceil(demand / workersPerHost)` hosts, kept between `minHosts` and `maxHosts`. Demand is the ready and running children of every running root, each root capped by its `admission.limits.session`. A root whose budget is spent, or that is paused, counts only its running children.
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

The provisioner runs in the controller's process with that machine's credentials. Nothing it is given or returns goes to the database except host ids, states and error messages, so keep secrets out of its error messages.

### Built-in provisioners

Three provisioners come with Atomic. Each runs a command-line tool you already use: `az`, `kubectl`, or commands of your own. It passes arguments directly, never through a shell, and stops a call that takes longer than its `timeoutMs` (or that the controller gives up on) together with every process the call started. Give `atomic worker controller` a JSON file with the provisioner's `kind` and options:

```bash
atomic worker controller --provisioner ./fleet.json --db libsql://pool.example.turso.io \
  --token-file /etc/atomic/token --max-hosts 20 --workers-per-host 8
```

SDK roots pass `workers: { placement: "shared", provisioner: { provisioner: createWorkerHostProvisioner({ kind: "kubernetes", … }), maxHosts: 20 } }`. `createWorkerHostProvisioner` checks the options and throws a `TypeError` that names the option at fault.

Credentials come only from the tool's own login or environment: `az login`, a managed identity or the `AZURE_*` variables; kubectl's kubeconfig or the controller pod's service account; whatever your commands read. Nothing in the JSON file or the SDK options is a credential, and none of it is written to the database. When a call fails, the controller prints `degraded` with the tool's exit code and its error output, with tokens, passwords and the values of secret-named environment variables replaced by `[redacted]`. It keeps the hosts the fleet has and tries again later; a run never waits on it. The error's `code` says what went wrong: `missing-cli` (the tool is not installed or not on `PATH`), `auth` (its credentials were refused), `exit`, `timeout` or `malformed` (output it could not read).

If you host the shared database yourself with sqld, start sqld with `--checkpoint-interval-s 60` before you let the fleet grow, as [Turso and libSQL](/storage#turso-and-libsql) explains: many hosts writing at once can otherwise stop sqld taking writes.

#### Azure Virtual Machine Scale Sets

```json
{ "kind": "azure-vmss", "resourceGroup": "atomic-rg", "name": "atomic-workers", "subscription": "<subscription id>" }
```

The provisioner runs `az vmss scale --new-capacity <n> --no-wait` to add instances, `az vmss list-instances` to list them, and `az vmss delete-instances --instance-ids <id> --no-wait` to remove one that drained. A host's provider id is its instance id. `subscription` is optional and defaults to the one `az` selects; `timeoutMs` defaults to 60000. The controller must run on Linux or macOS, where `az` is an executable rather than a Windows batch file.

Each instance boots from the scale set's image or custom data, which should install Atomic and start `atomic worker start` as in [Provision with cloud-init](#provision-with-cloud-init). In a scale set with Uniform orchestration, the instance's id is the end of its VM name, so add this to `runcmd` before the service starts:

```yaml
  - [sh, -c, 'name=$(curl -s -H Metadata:true "http://169.254.169.254/metadata/instance/compute/name?api-version=2021-02-01&format=text"); echo "ATOMIC_WORKER_PROVIDER_ID=${name##*_}" >> /etc/atomic/worker.env']
```

The service's `EnvironmentFile` line passes it on to `atomic worker start`.

Give the controller's identity a custom role limited to that one scale set, which lets it scale, read and delete instances and nothing else:

```json
{
  "Name": "Atomic worker fleet",
  "IsCustom": true,
  "Description": "Scale, read and delete the instances of one scale set.",
  "Actions": [
    "Microsoft.Compute/virtualMachineScaleSets/read",
    "Microsoft.Compute/virtualMachineScaleSets/write",
    "Microsoft.Compute/virtualMachineScaleSets/delete/action",
    "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/read",
    "Microsoft.Compute/virtualMachineScaleSets/virtualMachines/delete"
  ],
  "AssignableScopes": [
    "/subscriptions/<subscription id>/resourceGroups/atomic-rg/providers/Microsoft.Compute/virtualMachineScaleSets/atomic-workers"
  ]
}
```

```bash
az role definition create --role-definition role.json
az role assignment create --assignee <controller principal id> --role "Atomic worker fleet" \
  --scope /subscriptions/<subscription id>/resourceGroups/atomic-rg/providers/Microsoft.Compute/virtualMachineScaleSets/atomic-workers
```

If the scale set's instances join a subnet or use a user-assigned identity that the role does not already cover, scaling out also needs `Microsoft.Network/virtualNetworks/subnets/join/action` on that subnet or `Microsoft.ManagedIdentity/userAssignedIdentities/assign/action` on that identity; `az` names the missing action when it refuses.

#### Kubernetes

```json
{ "kind": "kubernetes", "namespace": "atomic", "deployment": "atomic-worker", "selector": "app=atomic-worker" }
```

The provisioner runs `kubectl scale deployment/<name> --replicas=<n>` to add pods and `kubectl get pods --selector <selector>` to list them. To remove a pod that drained, it deletes that pod and then scales the Deployment down by one, on the condition that the count is still the one it read: the Deployment replaces the deleted pod with a new, pending one, and a scale-down removes pending pods first, so a busy pod is never chosen. A host's provider id is its pod name. Give `statefulSet` instead of `deployment` for a StatefulSet. A StatefulSet can only remove its highest-numbered pod, so the provisioner removes a drained pod only when it is that one; prefer a Deployment. `context` selects a kubeconfig context; `timeoutMs` defaults to 30000.

Start each pod with its name as its provider id, and give it as long to drain as its longest child step takes:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: atomic-worker, namespace: atomic }
spec:
  replicas: 0
  selector: { matchLabels: { app: atomic-worker } }
  template:
    metadata: { labels: { app: atomic-worker } }
    spec:
      terminationGracePeriodSeconds: 900
      containers:
        - name: worker
          image: <your atomic-worker image>
          args: ["--slots", "8"]
          env:
            - { name: ATOMIC_DB, value: "libsql://pool.example.turso.io" }
            - name: ATOMIC_WORKER_PROVIDER_ID
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
          volumeMounts: [{ name: token, mountPath: /run/secrets/atomic-db-token, subPath: token, readOnly: true }]
      volumes: [{ name: token, secret: { secretName: atomic-db-token } }]
```

The image is the one from [Run it in a container](#run-it-in-a-container). Give the controller's service account a Role in that namespace that reads the pods, deletes them, and reads and scales only that Deployment:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: atomic-fleet, namespace: atomic }
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    resourceNames: ["atomic-worker"]
    verbs: ["get"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    resourceNames: ["atomic-worker"]
    verbs: ["get", "patch", "update"]
```

Bind it with a RoleBinding to the account the controller runs as. Kubernetes cannot limit pod deletion to one Deployment's pods, so run the workers in a namespace of their own. For a StatefulSet, use `statefulsets` and `statefulsets/scale` instead, and drop `delete` on pods.

#### Your own commands

```json
{
  "kind": "command",
  "up": ["/opt/fleet/scale-to"],
  "down": ["/opt/fleet/remove"],
  "list": ["/opt/fleet/list", "--json"]
}
```

Each command is an executable and its arguments, run without a shell, with the controller's environment:

- `up` makes the number of hosts the value of `ATOMIC_TARGET`. It may return before they boot, and is only ever asked to add hosts.
- `down` removes the host whose id is `ATOMIC_PROVIDER_ID`, which drained already or never started, and lowers the count by one. It must succeed for an id that is already gone.
- `list` prints a JSON array of the hosts, for example `[{"id": "vm-3", "state": "running", "since": "2026-11-14T09:30:00Z"}]`. `state` is `pending`, `running`, `draining`, `stopped` or `failed`. `since`, a time in milliseconds or ISO 8601, and `hostId`, the Atomic host id when you know it, are optional. Leave out hosts you already removed.

A command that exits non-zero fails the call. Its error output is reported, redacted as above, but its arguments never are. `timeoutMs` defaults to 120000.

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
