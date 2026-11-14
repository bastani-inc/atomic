---
title: "Running workers on many machines"
description: "Turn any Linux or macOS machine into a worker host for shared workflow runs with one command, and run it as a systemd service, from cloud-init, or in a container."
---

# Running workers on many machines

A workflow root with shared placement keeps its work queue in a shared libSQL or Turso database. Any machine that has Atomic installed can run that root's pooled children: install Atomic, then run one command that names the database. The machines coordinate only through the database. There is no other service to run.

If you host the database yourself with sqld rather than Turso, start sqld with `--checkpoint-interval-s 60` (or `SQLD_CHECKPOINT_INTERVAL_S=60`): sqld 0.24.33 can otherwise stop taking writes when many hosts write at once. See [Turso and libSQL](/storage#turso-and-libsql).

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

`atomic worker status` lists the hosts registered in the database, their workers and labels, and when each last reported, and the queue of each running root. `--json` prints the same as JSON.

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
- **A host never claims anything.** It runs a root's children only if it has the root's worker definitions at the same paths with the same entry module, and the root uses shared placement. Check `atomic worker status`, and `/workflow status <run>` on the root's machine.
