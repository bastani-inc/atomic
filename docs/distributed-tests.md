# Distributed chaos tests on Azure

`test/distributed/` brings up a private, multi-region Atomic environment on Azure for any git ref, runs scenario
suites while injecting faults, checks invariants, writes an evidence report, and deletes everything it created. It is
plain Node `.mjs` plus the `az` CLI; nothing in it ships in a published package.

```bash
node test/distributed/run.mjs --ref <sha|branch> --suite smoke
```

The full form is the one from #4331:

```bash
node test/distributed/run.mjs --ref <sha|branch> --suite <name|all> --nodes 3 --regions eastus2,westus3 --chaos <profile> [--keep]
```

## Prerequisites

Run it from a controller VM inside an Azure VNet of your own (the control VNet). The run's VNets are peered to it, and
only the controller's subnet may reach the run's VMs over SSH. Name that network in the environment:

```bash
export ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP=control-rg   # resource group of the control VNet
export ATOMIC_DISTRIBUTED_CONTROL_VNET=control-vnet           # name of the control VNet
export ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX=10.0.1.0/24      # CIDR of the controller's subnet
```

The harness reads the control VNet's address space from Azure and never allocates an overlapping prefix. It checks
everything below before it creates anything and lists every missing piece in one `DistributedPrerequisiteError`. Tools
are looked up on `PATH`; `az` is called only once it is found:

- the three variables above, and read access to the control VNet;
- `az` and `az login` with rights to create resource groups, VNets, NSGs, NICs, VMs and peerings, and to add and
  remove peerings on the control VNet;
- `ssh`, `scp` and `openssl` on every run;
- `ssh-keygen` and `curl` when the run brings up a new topology rather than reusing one;
- `docker` when the pinned `sqld` binary is not cached yet (it is extracted from its image once);
- `git` when `--ref` is not already a full commit SHA;
- `crabbox` when the ref has to be built. Pass `--artifact <file.tar.zst>` to deploy a tarball you already built, or
  `--builder <crabbox-id>` to build on a lease you already hold. A lease the harness warmed itself is stopped as soon
  as the build finishes or fails, and again by teardown if that stop failed.

## What one run does

1. Validates the flags and `test/distributed/topology.json`. An invalid value is a `DistributedConfigError` naming the
   flag or field, raised before any side effect.
2. Creates a dedicated resource group `<run-id>-rg`, one VNet per region (`10.60.0.0/16` upward, skipping the control
   VNet's address space and prefixes already peered to it or owned by other runs), NSGs, peerings to the control VNet
   and between the run's VNets, private NICs and VMs. Every taggable resource carries
   `atomic-distributed-test=<run-id>` and `atomic-distributed-test-expiry=<ISO time>`. Each resource is written to
   `manifest.json` before the command that creates it.
3. Resolves `--ref` to a SHA, builds it once on Crabbox (`npm ci --ignore-scripts` and `npm run build`), caches the
   tarball by SHA under `$XDG_CACHE_HOME/atomic-distributed-test/artifacts/`, and copies identical bytes to every node,
   checking the SHA-256 on each.
4. Starts `sqld` (`v0.24.33`, digest-pinned) as a primary and a replica with namespaces, JWT authentication and
   replication over mutual TLS, behind a TLS gateway on each database VM's private address.
5. Runs the security gate. Any failure aborts the run before a scenario starts and tears everything down.
6. Runs the selected suites and chaos profiles, then checks the invariants.
7. Tears down in `finally` and proves absence with `az` queries. `--keep` skips teardown, except after a failed security
   gate, which always tears down; the TTL still applies.

## Default topology

| VM | Role | Region | Size |
| --- | --- | --- | --- |
| `n1` | large node, for density | `eastus2` | `Standard_E8s_v7` (64 GB) |
| `n2` | small-memory node | `westus3` | `Standard_D2ls_v7` (4 GB) |
| `n3` | git-less node with a second NIC, the target of VM-level faults | `eastus2` | `Standard_D2s_v7` |
| `db-primary` | sqld primary, Premium SSD data disk | `eastus2` | `Standard_D2s_v7` |
| `db-replica` | sqld replica in the second region | `westus3` | `Standard_D2s_v7` |

`--nodes` accepts 1 to 80. Nodes take the topology's templates in order and are spread over `--regions` round-robin;
nodes beyond the templates use `extraNode`. `--db-region` moves the replica (the second database tier) to another
region. `--db-storage local-nvme` puts both database VMs on the local NVMe temporary disk of `Standard_D2ds_v7` with
`--encryption-at-host true`; when the subscription has not registered `Microsoft.Compute/EncryptionAtHost`, the run
records the skip reason `encryption-at-host-unavailable` and uses Premium SSD instead. Local NVMe is ephemeral: a
deallocation erases it.

The git-less node has git removed after the artifact is unpacked, and the facts in the report show its absence.

## Private networking and the security gate

Nothing in a run has a public IP. VMs are created with `--public-ip-address ""` and NICs of their own, subnets have no
default outbound access, and every subnet's NSG has, in priority order:

| Priority | Rule |
| --- | --- |
| 100 | deny inbound from `Internet` |
| 200 | allow TCP 22 from the controller subnet (`ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX`) |
| 210 | allow TCP 8443 (sqld TLS gateway) from the run's VNets to the database VMs |
| 220 | allow TCP 5001 (replication) from the replica to the primary |
| 4000 | deny inbound from `VirtualNetwork`, overriding Azure's `AllowVnetInBound` |
| 4010 | deny inbound from `AzureLoadBalancer` |
| 100 (outbound) | deny outbound to `Internet` |

No VM needs the Internet: the Node runtime, the `sqld` binary, the harness scripts and the ref tarball are copied over
the private control path. `sqld` listens on `127.0.0.1` for HTTP and admin, and on the private address for replication;
the gateway serves TLS on the private address with a certificate from the run's own CA. Clients authenticate with an
EdDSA JWT scoped to the run's namespaces, kept in a mode-600 file and passed to Atomic through `secrets.file`.

Before any scenario, the gate checks and records:

- `az vm list-ip-addresses` shows no public IP on any VM, and the group has no public IP or load balancer resources.
- Effective NSG rules on every NIC have no inbound allow from `Internet`, `*` or a public range, every allow comes
  from the allowlist, and `AllowVnetInBound` and `AllowAzureLoadBalancerInBound` are overridden by higher-priority denies.
- `sqld` binds HTTP and admin to loopback and the gateway and replication listeners to the private address only.
- From a node in the other region: an authenticated HTTPS request succeeds; a request without a token, with a token
  signed by another key, verified against another CA, in plaintext to the gateway, or in plaintext to the backend port
  is rejected; and the token file is mode 600.
- With `--db-storage local-nvme`, the database VMs report `encryptionAtHost: true`.

## Suites

| Suite | Issue | On a ref without the feature |
| --- | --- | --- |
| `smoke` | #4331 | always runs |
| `multi-node-resume` | #4329 | skips: no `WorkspaceError` export |
| `cross-host-pools` | #4310 | skips: no `WorkerPlacementError` export |
| `shard-contention` | #4325 | skips: no `JournalShardUnavailableError` export |
| `idle-density` | #4309/#4326 | skips: no `AgentSessionRuntime.rehydrate` |
| `subscription-flood` | #4311 | skips: no `SubscriptionError` export |
| `fork-under-load` | #4321 | skips: no `forkRun` export |
| `restore-cold` | #4245 | skips: no `GitProvisionError` export |
| `team-ci` | #4320 | skips: no `TeamProfileError` export |
| `pool-scale` | #4312 | skips as pending |
| `compaction` | #4330 | skips: no `AgentSession.awaitBackgroundCompaction` |

A skip is a result with `status: "skipped"` and a typed reason: `feature-unavailable` when the deployed ref does not
export the interface, `scenario-pending` when it does but the suite's scenarios have not been written yet. A failed
import, a broken deployment or a failing call into an available feature is a failure, never a skip. The PR that adds a
feature adds its scenarios to `test/distributed/harness/suites.mjs` and sets `implemented: true` on its probe.

### The smoke suite

A chain of writers holds the lease on one run in the shared journal (the `smoke` namespace on sqld, opened through
`@bastani/atomic-storage-libsql` from the deployed ref) and appends keyed checkpoints, recording every acknowledged
append. Each chaos profile is applied to the writer's node or VM and its effect is observed. Whenever the fault was
applied it is reverted, even when observing it failed, so a failed profile never leaves a partition, qdisc, skewed
clock, cgroup or device-mapper target behind for the next one. The writers then recover on their own, taking an
expired lease over at the next epoch where a writer died. The disk profiles
use local SQLite journals on device-mapper volumes on one node. At the end the suite checks:

- every acknowledged checkpoint is in the journal with the same sequence, epoch and payload digest;
- no key is stored twice, and checkpoint indexes have no gaps;
- sequence numbers increase and lease epochs never go back (fencing);
- every stale writer is refused with `StaleLeaseError`;
- `PRAGMA integrity_check` is `ok` for the shared and local journals;
- every recorded failure has a typed name;
- a writer completed after the last fault, without intervention;
- the replica caught up with the primary;
- a node with a skewed clock never took over a live lease.

## Chaos profiles

`--chaos smoke` (the default) runs all of them; `--chaos none` runs none; a profile name or a comma-separated list
runs those.

| Profile | Mechanism | Counts as exercised when |
| --- | --- | --- |
| `partition` | iptables DROP both ways between a node and the gateway | drops counted and no acknowledgement during the window |
| `asymmetric-partition` | iptables DROP of gateway responses only | node drops responses while the gateway still receives requests |
| `reset` | iptables `REJECT --reject-with tcp-reset` | rejects counted |
| `latency` | `tc` prio + netem `delay 150ms`, filtered to the gateway flow | median append latency rises |
| `jitter` | netem `delay 100ms 80ms distribution normal` | latency spread widens |
| `loss` | netem `loss 20% seed <seeded>` | netem drop counter is non-zero |
| `bandwidth` | netem `rate 256kbit` | traffic passed through the limit |
| `sigkill` | `systemctl kill --signal=SIGKILL` of the writer unit | unit dead with result `signal`; replacement at the next epoch |
| `sigstop` | SIGSTOP, takeover elsewhere, SIGCONT | process state `T`; resumed writer fenced |
| `clock-skew` | chrony stopped, clock stepped +600 s | node clock offset observed; no takeover of a live lease |
| `disk-full` | loop-backed ext4 filled with a filler file | local appends fail, then resume after removal |
| `slow-disk` | `dm-delay` target swapped in under the journal | direct synchronous writes slow down |
| `io-error` | `dm-error` target swapped in under the journal | direct writes fail with EIO; checkpoints acknowledged before the fault survive |
| `oom` | writer in a cgroup v2 with `memory.max` and no swap | `memory.events` `oom_kill` ≥ 1 |
| `vm-restart` | `az vm restart` | boot id changes |
| `vm-deallocate` | `az vm deallocate`, then `az vm start` | power state `VM deallocated`, new boot id |
| `nic-detach` | deallocate, `az vm nic remove` of the second NIC, start, then re-add | the VM runs with one NIC fewer, then with it again |

Network faults touch only rules and qdiscs owned by the run; SSH is never affected. NIC detach is a VM-level fault:
Azure only removes a NIC from a deallocated VM with at least two NICs.

## Replay

`--seed` fixes every random choice (targets, the netem seed); the report records the seed, the PRNG
(`mulberry32/v1`), the resolved SHA, the artifact digest and the options. `--replay <report.json>` reruns with the
same values; explicit flags override them. A seed reproduces choices and their order, not Azure scheduling or packet
timing.

`--keep` leaves the topology up after the run, unless its security gate failed. `--reuse <run-id>` runs the security
gate and the suites again on a kept topology, which is the fast way to iterate on a scenario.

## Evidence

Each run writes to `$XDG_STATE_HOME/atomic-distributed-test/runs/<run-id>/` (or `--out`):

- `report.json` and `report.md`: replay values, topology, environment facts (Node, kernel, tools, sqld version and
  digest), security checks, suites with typed skip and failure reasons, invariants with expected and actual values,
  per-profile coverage with observations, metrics (append latency, writer errors by type, at-least-once replays), the
  fault timeline, phase durations, and the teardown's absence queries with their results;
- `commands.log`: every command the controller ran, redacted;
- `manifest.json`, `state.json`, `secrets/` and `ssh/`: the run's ownership record and private material, mode 600.

No token or key reaches the report or the log: tokens live in files, commands never carry them, and both outputs pass
through redaction. No database file or dump leaves the run's resource group.

## Teardown, the sweeper and cost controls

Teardown deletes the control VNet peerings named for the run, then the run's resource group, and passes only when all
of these succeed and return `[]`:

```bash
az resource list --tag atomic-distributed-test=<run-id> --query "[].id"
az group list --tag atomic-distributed-test=<run-id> --query "[].id"
az network vnet peering list --resource-group "$ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP" --vnet-name "$ATOMIC_DISTRIBUTED_CONTROL_VNET" --query "[?contains(name, '<run-id>')].name"
az network vnet list --query "[?contains(name, '<run-id>')].id"
az group list --query "[?name=='<run-id>-rg'].id"
```

A failed query is a failure, not absence. A teardown that cannot prove absence fails the run with
`DistributedTeardownError` and says how to retry.

A killed controller cannot run `finally`, so schedule the sweeper:

```bash
node test/distributed/sweep.mjs              # delete every run past its expiry
node test/distributed/sweep.mjs --dry-run    # show what it would delete
node test/distributed/sweep.mjs --run-id <run-id> --force   # delete one run now, ignoring its TTL
```

It re-reads each candidate's tags, never deletes a group with a missing or malformed expiry, removes
control VNet peerings whose run group is gone or expired, and runs the same absence queries.

Cost is bounded by the topology's size, `--ttl-hours` (default 6) and the sweeper; there is no spending limit. A
smoke run uses five VMs (14 vCPUs) for roughly an hour; `--chaos none` or a short profile list makes it cheaper, and
`--reuse` avoids paying for bring-up twice.

## Errors

Every harness failure is a `DistributedTestError` from `test/distributed/harness/errors.mjs` with a stable `code`, safe
`fields` and a `hint`; errors round-trip through JSON (`serializeDistributedError`, `rehydrateDistributedError`).

| Class | Code | When | What to do |
| --- | --- | --- | --- |
| `DistributedConfigError` | `invalid-config` | A flag, topology field or replay file is invalid; nothing was created | Fix the named `field` |
| `DistributedPrerequisiteError` | `missing-prerequisite` | A tool, login or the control VNet is missing | Run the fixes in `hint` |
| `DistributedCommandError` | `command-failed` | `az`, `ssh`, `scp` or `crabbox` exited unsuccessfully (SSH exit 255 is retryable) | Read `commands.log` |
| `DistributedTimeoutError` | `timeout` | A phase exceeded its budget | Check reachability of the target |
| `DistributedProvisionError` | `provision-failed` | A resource could not be created or verified | Check quota and SKU availability |
| `DistributedSecurityError` | `security-check-failed` | The security gate failed; no scenario ran | Fix the configuration named in `violations` |
| `DistributedFaultError` | `fault-failed` | A profile could not be applied, observed or recovered; failures of its revert or cleanup are attached as `cleanupCause` | Check the node's facts for tool support |
| `DistributedInvariantError` | `invariant-violated` | An invariant failed | A finding against the ref under test |
| `DistributedFeatureUnavailableError` | `feature-unavailable` | The ref lacks a suite's interface (skip) | Run against a ref with the feature |
| `DistributedScenarioPendingError` | `scenario-pending` | The ref has the interface but the suite is unwritten (skip) | Write the suite's scenarios |
| `DistributedTeardownError` | `teardown-incomplete` | Teardown could not prove absence | Rerun `sweep.mjs --run-id <run-id> --force` |

Cancellation (Ctrl-C) is reported as `cancelled`, not as a failure, and teardown still runs.

## Unit tests

`test/unit/distributed-*.test.ts` cover the harness's own logic (configuration, network rules and their effective
evaluation, ownership and TTL decisions, teardown, invariants, errors, fault sequencing, run credentials, the build
script, the report, the lifecycle and the sweeper) without Azure. They run in the normal unit project. The harness
itself needs a Linux controller; the tests that depend on POSIX file modes, shell scripts or process groups are
skipped on Windows.
