# Distributed chaos tests on Azure

The harness in [`test/distributed/`](../test/distributed/) deploys one Git ref to a private Azure environment.
It injects faults such as network partitions and process crashes, checks recovery, and writes a report.
Run it when a change affects cross-node session recovery, Intercom delivery, or the legacy workflow journal.
For changes to the harness itself, start with the [local unit tests](#unit-tests).

## Prerequisites

Use a Linux controller VM inside your Azure control VNet. Install Node.js and the Azure CLI, then run `az login`.
Use a subscription where you can create resource groups, VNets, NSGs, NICs, and VMs.
You also need permission to read the control VNet and manage its peerings. Set these variables to match your network:

```bash
export ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP=control-rg
export ATOMIC_DISTRIBUTED_CONTROL_VNET=control-vnet
export ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX=10.0.1.0/24
```

The SSH prefix must be the controller's subnet, within `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16`.
Put `ssh`, `scp`, and `openssl` on `PATH`. For a new topology, also install `ssh-keygen` and `curl`.
You need `git` to resolve a branch or tag and `docker` if the `sqld` binary is not cached.
Install `crabbox` to build the ref, or pass `--artifact <file.tar.zst>` to deploy an existing build.
The security gate checks private networking and database access before any suite runs.

## Suites

- `multi-node-resume` checks session recovery, released subagent wake, and Git provisioning across at least three nodes.
  It needs both `partition` and `sigkill` to pass. Workflow scenarios only run on refs with the legacy runtime.
- `idle-density` checks that Intercom wakes released subagents across nodes and delivers messages once and in order.
  It needs at least two nodes.
- `smoke` checks that the legacy workflow journal preserves acknowledged writes and fences stale writers after faults.
  It skips on refs without that journal.

## Run a suite

From the repository root, replace `main` with the branch, tag, or full commit SHA you want to test:

```bash
node test/distributed/run.mjs --ref main --suite multi-node-resume --chaos partition,sigkill
```

Use `--plan-only` to print the plan without contacting Azure. See [`topology.json`](../test/distributed/topology.json)
for the defaults and `node test/distributed/run.mjs --help` for all options, including `--suite all`.
The default `--chaos smoke` runs every profile the selected suite supports. To narrow a run, give a comma-separated
list from [`config.mjs`](../test/distributed/harness/config.mjs) or use `--chaos none` to disable the optional profiles.

## Read failures

Open `report.md` in `$XDG_STATE_HOME/atomic-distributed-test/runs/<run-id>/`, or in the directory you passed to `--out`.
If `XDG_STATE_HOME` is unset, the base is `~/.local/state`. Use `report.json` for error codes, hints, and causes.

- **Setup:** If there is no report, start with the terminal error. For provisioning failures, check Azure permissions,
  quota, and region capacity. If the security gate fails, fix the reported network or database setting.
- **Suites:** `feature-unavailable` means the ref lacks the required interface. `scenario-pending` means the suite
  has no scenarios yet. Check each suite's status, even if the run says `passed`. A broken deployment is not a skip.
- **Chaos coverage:** Check whether the fault took effect and the target recovered. For `fault-failed`, check the
  stage and target in `report.json`, then look up the command in `commands.log` or `commands-reuse-*.log`.
- **Invariants:** Compare the expected and actual values to see what the check found.

Check `cleanupCause` in `report.json` if cleanup also failed. The reports and command logs are redacted.
Do not share the run's `secrets/` or `ssh/` directories.

## Replay

Run `node test/distributed/run.mjs --replay path/to/report.json` to repeat the recorded test options and seed.
The seed repeats the harness's choices, not Azure scheduling or packet timing.
Use `--keep` to save the topology for another attempt. A failed security gate always triggers teardown.
Set `RUN_ID` to the run ID from the report. Run `node test/distributed/run.mjs --reuse "$RUN_ID"` with the same
subscription and control VNet. Pass the same `--out` directory if you set one. Add `--keep` again to reuse it later.

## Teardown and the sweeper

The harness normally deletes the run's resource group and peerings, then checks that nothing remains.
Schedule the sweeper with the same Azure subscription and control VNet settings in case the controller dies.
The default expiry is six hours. Use `--ttl-hours` to change it. The harness does not cap spending.

```bash
node test/distributed/sweep.mjs --dry-run
node test/distributed/sweep.mjs
node test/distributed/sweep.mjs --run-id "$RUN_ID" --force
```

The first command previews cleanup. The second deletes expired runs. If teardown fails, fix the reported error,
set `RUN_ID` from the report, and use the third command to clean up without waiting for expiry.
If `report.json` shows that stopping a Crabbox lease failed, stop that lease separately. The sweeper only cleans up Azure.

## Unit tests

Run `npm run test:unit -- test/unit/distributed-` to check the harness without Azure.
