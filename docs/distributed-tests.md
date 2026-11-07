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

The SSH prefix must be a private range inside `10.0.0.0/8`, `172.16.0.0/12` or `192.168.0.0/16`; anything else,
including `0.0.0.0/0`, is rejected before any side effect.

The harness reads the control VNet's address space from Azure and never allocates an overlapping prefix. It checks
everything below before it creates anything and lists every missing piece in one `DistributedPrerequisiteError`. Tools
are looked up on `PATH`; `az` is called only once it is found:

- the three variables above, and read access to the control VNet;
- `az` and an `az login` session. The account also needs rights to create resource groups, VNets, NSGs, NICs, VMs
  and peerings, and to add and remove peerings on the control VNet; those rights are not checked up front;
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
   and between the run's VNets, private NICs and VMs. It claims address space through the control-side peering before
   creating any subnet, checks for overlaps, and reallocates up to five times if another run won the same ranges.
   Every taggable resource carries
   `atomic-distributed-test=<run-id>` and `atomic-distributed-test-expiry=<ISO time>`. Each resource is written to
   `manifest.json` before the command that creates it.
3. Resolves `--ref` to a SHA through its exact name only: a full refname (`refs/...`) as given, otherwise
   `refs/tags/<ref>` (an annotated tag resolves to its commit) or `refs/heads/<ref>`, never a longer ref that merely
   ends in it, such as `refs/heads/release/<ref>`. A name that is a tag and a branch at different commits is rejected as
   ambiguous; pass the full refname instead. The report records the refname used. The harness builds the ref once on
   Crabbox (`npm ci --ignore-scripts` and `npm run build`), caches the tarball by SHA under
   `$XDG_CACHE_HOME/atomic-distributed-test/artifacts/`, and copies identical bytes to every node, checking the
   SHA-256 on each. Concurrent cache writers use separate staging files and atomically publish one complete entry
   without overwriting an entry another run is using.
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

`--nodes` accepts 1 to 80. With one or two nodes, the last node also takes the VM-level faults and a second NIC.
Nodes take the topology's templates in order and are spread over `--regions` round-robin; nodes beyond the templates
use `extraNode`. `--db-region` moves the replica (the second database tier) to another
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

- `az vm list-ip-addresses` shows no public IP on any VM, and lists every planned VM (a missing one fails the check),
  and the group has no public IP or load balancer resources.
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
| `multi-node-resume` | #4329 | skips: no `ResumeError` export |
| `cross-host-pools` | #4310 | skips: no `WorkerPlacementError` export |
| `shard-contention` | #4325 | skips: no `JournalShardUnavailableError` export |
| `idle-density` | #4309/#4326, #4394 | skips: no `AgentSessionRuntime.rehydrate` |
| `subscription-flood` | #4311 | skips: no `SubscriptionError` export |
| `fork-under-load` | #4321 | skips: no `forkRun` export |
| `restore-cold` | #4245 | skips: no `GitProvisionError` export |
| `team-ci` | #4320 | skips: no `TeamProfileError` export |
| `pool-scale` | #4312 | skips as pending |
| `compaction` | #4330 | skips: no `AgentSession.awaitBackgroundCompaction` |

A skip is a result with `status: "skipped"` and a typed reason: `feature-unavailable` when the deployed ref does not
export the interface, `scenario-pending` when it does but the suite's scenarios have not been written yet. A failed
import, a broken deployment or a failing call into an available feature is a failure, never a skip. The PR that adds a
feature adds its scenarios under `test/distributed/harness/` and sets `implemented: true` on its probe in
`suites.mjs`. `smoke`, `idle-density` and `multi-node-resume` have scenarios; the others skip as `scenario-pending` on a ref that has their
interface.

### The smoke suite

A chain of writers holds the lease on one run in the shared journal (the `smoke` namespace on sqld, opened through
`@bastani/atomic-storage-libsql` from the deployed ref) and appends keyed checkpoints, recording every acknowledged
append. Each chaos profile is applied to the writer's node or VM and its effect is observed. Whenever the fault was
applied it is reverted, even when observing it failed. Revert and cleanup commands use a separate signal with a
90-minute budget that covers sequential VM recovery commands, so cancelling a run does not prevent them from starting.
Undo failures are retained alongside the original error. The writers recover by taking an expired lease over at the
next epoch where a writer died. The disk profiles use local SQLite journals on device-mapper volumes on one node.
At the end the suite checks:

- every writer's acknowledgement file is readable; a missing file fails the evidence check rather than reducing the history;
- every acknowledged checkpoint is in the journal with the same sequence, epoch and payload digest;
- no key is stored twice, and checkpoint indexes have no gaps;
- sequence numbers increase and lease epochs never go back (fencing);
- every stale writer is refused with `StaleLeaseError`;
- `PRAGMA integrity_check` is `ok` for the shared and local journals;
- every recorded failure has a typed name;
- a writer completed after the last fault, without intervention;
- the replica caught up with the primary;
- a node with a skewed clock never took over a live lease.

### The multi-node-resume suite

The suite needs at least three nodes, including the git-less node, and covers all seven acceptance scenarios of #4329.
It runs the same session, workflow, released-session and pooled-child fixtures as the reduced multi-process acceptance
tests, with each node's own Atomic home and one shared, authenticated sqld namespace. A pinned Bun 1.4.4 binary is
copied over the private control path and checked on each node. A run's synthetic Git remotes are copied to the same
path on each node; the nodes and database never need a public endpoint. Below, n1 is the first node, n2 the second and
n3 the git-less node.

1. **Session.** n1 records a session with uncommitted and untracked files plus an unpushed commit, then is SIGKILLed.
   n2 observes a typed timeout during a database partition, is SIGKILLed during restore, then resumes the session; the
   suite checks the tree, HEAD, conversation, mapped path, setup count and absence of partial worktrees.
2. **Two repositories.** n1 runs children bound to two repositories, with completed `ctx.tool` effects, and is
   SIGKILLed mid-step. n2 waits for the real owner lease to expire, checks that a database partition gives a typed run
   lookup timeout, then resumes both children and checks their trees and that each effect ran once.
3. **Pooled campaign.** A root on n1 runs with `workers: { placement: "shared" }` on the sqld journal, through
   `@bastani/atomic-storage-libsql`, with a table prefix of its own. Worker hosts (`startWorkflowWorkerHost`) serve on
   n2 and n3 first, and each host's own agent directory sets `resume.setupCommand` to a command that records the
   worktree it sets up. The root's tree has a lockfile, so a host that restores it runs the hook. Once n2's host holds
   the child in a worktree it restored, a capable host joins on n1 and n2's host is SIGKILLed with its workers. The
   suite checks that the child was claimed again and finished on n1's host, in a worktree restored with the recorded
   tree and commit (manifest equality), replaying its completed first step instead of running it again; that each host
   that restored the child ran the hook exactly once, in that worktree, before the child ran; and that n3's host, which
   has no Git and no restore port, never claimed the child, including while the reclaimed one waited: the journal
   records exactly two claims, n2's host's and n1's host's.
4. **Fork on a third node.** n1 runs a two-stage workflow. After scenario 6 provisioned Git on n3, a fork from the
   second stage runs on n3, is SIGKILLed right after `git worktree add`, and is retried; the retried fork's stage must
   see the state the first stage left, in a restored worktree, with no partial worktree left.
5. **Released session.** n1 records and releases two sessions, then is SIGKILLed. n2 wakes the first with
   `AgentSessionRuntime.rehydrate` while it is cut off from the database: the wake must fail with a retryable
   `ResumeCatalogTimeoutError` or `ResumeCatalogUnavailableError` and restore nothing. After the partition heals, the
   retry must restore the recorded tree (manifest equality) and commit, and n1's absolute path must resolve in it. For
   the second session, n2 first holds a different checkout of the same repository at exactly the recorded path: the
   woken session must continue in a restored worktree with the recorded tree, and leave that checkout as it was.
   Last, n1 launches a real background subagent (forked, so its session is in the shared database) in a third
   checkout: it writes a file there and waits on a call, so it is released, and n1 is SIGKILLed. n2 wakes it with
   the result it waited for. The subagent must be restored, not reported unrestorable, and continue in a worktree n2
   restored from its own snapshot with the recorded tree and commit, with n1's path mapped into it, and read n1's
   file through that path.
6. **Git-less node.** On n3 an unsuccessful provision must fail typed before restoration, and a lookup during a
   database partition must fail typed before anything is provisioned or restored. The suite then provisions Git from a
   synthetic archive of n1's Git and restores the session. The provision uses the same CI driver's fetch override, not
   Internet egress from the private node.
7. **Chaos during each.** Every scenario above is hit by at least one fault, as the table below shows.

| Scenario | `partition` | `sigkill` |
| --- | --- | --- |
| 1 | session lookup on n2 | session restore on n2 |
| 2 | run lookup on n2 | workflow owner mid-step on n1 |
| 3 | | n2's worker host while it holds a bound child |
| 4 | | fork restore on n3 |
| 5 | wake on n2 | |
| 6 | session lookup on n3 | |

Each fault record names its scenario, the report's chaos coverage lists every record, and the suite's metrics include
`chaosByScenario`, the profiles that hit each scenario, with scenario 7 as their union. The invariant
`chaos-hit-every-scenario` fails unless every fault in the table was applied, observed and recovered from. The lost
owner of scenario 2 and the lost worker host of scenario 3 are part of their scenarios, so they are killed whichever
profiles are selected; they are recorded as faults only when `sigkill` is. A scenario that fails is recorded with its
error, and the scenarios that do not depend on it still run. The suite also checks the shared database's integrity.
Its `partition` and `sigkill` profiles are required for full acceptance.

### The idle-density suite

Background subagents released on one node are woken by Intercom sends that arrive through brokers on other nodes. It
needs at least two nodes (`--nodes 1` is rejected before any side effect): the first node runs the owner and every other
node runs one sender. All of them run `test/distributed/node/released.mjs` against the deployed ref in run-owned
systemd units.

- **Owner.** A session with the built-in Intercom and subagents extensions and a scripted model launches 20 background
  subagents. Each starts a long shell task in the background and waits on it, so it is released. The owner's sessions
  stay in a SQLite file on its own node. Its unit restarts on failure, and a restarted owner reopens the same session
  and runs its recovery (`startPendingRecovery("resume")`), as an interactive session does, which restores the
  children the killed process left running.
- **Senders.** Each sender connects through its own node's broker, in the project group the Intercom extension joins
  when routing is multi-node, and sends numbered messages (`ADT <sender> <child> <k>`) to every child, one message per
  child at a time, so each sender's order to a child is defined. A send that loses its broker connection is retried with the same message id after Intercom's reconnect
  delays. Every outcome is logged: `delivered`, `queued`, `reason` and `reasonCode`, or the thrown error's name and code.
- **Shared store.** Every node's agent directory selects the run's first namespace on sqld through
  `@bastani/atomic-storage-libsql`, with a table prefix of its own per attempt, so the brokers route across nodes
  through it.

Each fault starts only after the senders logged new outcomes, and is reverted before the next one. They run in the
order below; the two SIGKILLs come last, so every other fault runs against an owner that was never restarted:

| Profile | Target | Mechanism | Counts as exercised when |
| --- | --- | --- | --- |
| `latency`, `loss` | owner node | netem towards the gateway for 30 s | netem passed packets; for `loss`, dropped some |
| `partition` | first sender's node | iptables DROP to the gateway for 30 s | drops counted, rules gone afterwards |
| `sigstop` | last sender's broker | SIGSTOP for 30 s, then SIGCONT | process state `T`, then running again and the sender progressing |
| `clock-skew` | first sender's node | chrony stopped, clock stepped +300 s for at least 30 s | offset observed while sends continue; restored within 5 s |
| `slow-disk` | sqld primary | cgroup write limit on `adt-sqld` (20 IOPS, 1 MB/s) | a synchronous 4 MiB write in sqld's cgroup slows by at least 200 ms, then speeds up again |
| `disk-full` | sqld primary | the data volume filled with a filler file | a write fails with `No space left on device`; afterwards sqld is active and writes succeed |
| `sigkill` | the owner node's broker, then the owner unit | `kill -KILL` of the broker; `systemctl kill --signal=SIGKILL` | a new broker took over; the unit restarted and rebound its children; deliveries resumed |

Then the senders stop and the children get at least two minutes, and at most five, to settle: long enough for each of
multi-node Intercom's 30-second recovery windows (a stale outbox claim, a stale broker lease, the outbox backup poll).
The owner is stopped, and every child's transcript is read back from its session. The suite checks:

- every sender and owner log is complete, and every child the owner launched was read back;
- every send that returned `delivered` reached its child exactly once;
- each sender's messages reached each child in the order they were sent;
- no message id reached a child twice, whatever its send returned;
- every send accepted as `queued` reached its child exactly once by the end;
- no refused send arrived;
- every non-delivery has a `reasonCode` or a typed error name;
- no wake was lost: every accepted send arrived, and no child recorded a wake failure;
- every child was released again before the owner stopped;
- `PRAGMA integrity_check` is `ok` for the shared database and the owner's store, and every child's session reads back;
- after each SIGKILL the owner restarted by itself, reopened its session with every child, ran its recovery, and
  deliveries resumed, with no other crash.

The report's metrics count outcomes by kind, non-deliveries by reason or error name, retried sends, broker
connections per sender, the latency of delivered sends, and how long the children took to settle.

## Chaos profiles

`--chaos smoke` (the default) runs every profile each selected suite supports: all of them in `smoke`, the eight listed
above in `idle-density`, `partition` and `sigkill` in `multi-node-resume`. `--chaos none` runs none; a profile name or a
comma-separated list runs those, and a profile that none of the selected suites runs is rejected before any side effect.
Coverage is reported per suite, with a row for each target a profile hit, and a profile a suite exercises more than once
(the two SIGKILLs of `idle-density`, the four partitions and four SIGKILLs of `multi-node-resume`) counts as exercised
only when every one was. The table below describes the profiles as `smoke` runs them.

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
| `vm-restart` | `az vm restart --no-wait`, then the guest's boot id is polled | boot id changes |
| `vm-deallocate` | `az vm deallocate`, then `az vm start` | power state `VM deallocated`, new boot id |
| `nic-detach` | deallocate, `az vm nic remove` of the second NIC, start, then re-add | the VM runs with one NIC fewer, then with it again |

Network faults touch only rules and qdiscs owned by the run; SSH is never affected. NIC detach is a VM-level fault:
Azure only removes a NIC from a deallocated VM with at least two NICs.

Restarts and starts are requested with `--no-wait`, and the harness waits for the guest instead: a new boot id, or SSH
answering again. Azure can report a VM as `Updating` for many minutes after the guest is back, for example when a
policy installs an extension such as Defender for Endpoint that needs Internet access the run's VMs do not have.

## Replay

`--seed` fixes every random choice (targets, the netem seed); the report records the seed, the PRNG
(`mulberry32/v1`), the resolved SHA, the artifact digest and the options. `--replay <report.json>` reruns with the
same values; explicit flags override them. A seed reproduces choices and their order, not Azure scheduling or packet
timing.

`--keep` leaves the topology up after the run, unless its security gate failed. `--reuse <run-id>` runs the security
gate and the suites again on a kept topology, which is the fast way to iterate on a scenario; it copies the current
node scripts to the nodes first. If the kept run used `--out <dir>`, pass the same directory with
`--reuse <run-id> --out <dir>`. The report includes that reuse command.
Before it changes or tears down anything, `--reuse` checks that the current `az` subscription and control VNet are the
ones the run was created with. On a mismatch it exits with code 2 and leaves the kept topology alone.

## Evidence

Each run writes to `$XDG_STATE_HOME/atomic-distributed-test/runs/<run-id>/` (or `--out`):

- `report.json` and `report.md`: replay values, topology, environment facts (Node, kernel, tools, sqld version and
  digest), security checks, suites with typed skip and failure reasons (a suite that fails or is cancelled midway
  keeps the fault records gathered so far), invariants with expected and actual values,
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
control VNet peerings whose run group is gone or expired, and runs the same absence queries. It deletes an expired
resource outside its run's group on its own, and tears that whole run down only when the group is already gone. If
one straggler deletion fails, it continues with the remaining deletions and expired runs, reports each failure, and
exits nonzero.

Cost is bounded by the topology's size, `--ttl-hours` (default 6) and the sweeper; there is no spending limit. A
smoke run uses five VMs (16 vCPUs) for roughly an hour; `--chaos none` or a short profile list makes it cheaper, and
`--reuse` avoids paying for bring-up twice.

## Errors

Every harness failure is a `DistributedTestError` from `test/distributed/harness/errors.mjs` with a stable `code`, safe
`fields` and a `hint`; errors round-trip through JSON (`serializeDistributedError`, `rehydrateDistributedError`).

| Class | Code | When | What to do |
| --- | --- | --- | --- |
| `DistributedConfigError` | `invalid-config` | A flag, topology field or replay file is invalid; nothing was created | Fix the named `field` |
| `DistributedPrerequisiteError` | `missing-prerequisite` | A tool, login or the control VNet is missing | Run the fixes in `hint` |
| `DistributedCommandError` | `command-failed` | `az`, `ssh`, `scp` or `crabbox` exited unsuccessfully (SSH exit 255 is retryable); when the node agent fails, its own error (name and code) is the `cause` | Read `commands.log` and the cause |
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
