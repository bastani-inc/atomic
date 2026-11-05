# Distributed fork chaos test (#4321)

Chaos test of run forking ("time travel": `forkRun`, `listForkPoints`, `forkDurableRun`) across Azure regions,
sharing one self-hosted libSQL `sqld` journal, with node-local SQLite where relevant. The #4331 distributed harness
has no fork suite yet, so these scripts provision their own private topology with `az`, under the same network
security rules, and delete it afterwards.

## Topology

| VM | Region (default) | Subnet | Role |
| --- | --- | --- | --- |
| `fc-<run>-sqld` | region 0 | `<prefix0>.1.0/24` | `sqld` on 127.0.0.1:8080 with JWT auth, nginx TLS on the private IP :8443, 8 GiB managed data disk at `/data` |
| `fc-<run>-a` | region 0 | `<prefix0>.2.0/24` | seeds the source runs, forks, runs the SIGSTOP claim holder and the checker |
| `fc-<run>-b`, `-c`, `-d` | per `WORKER_REGIONS` | `<prefixN>.2.0/24` | fork concurrently; `b` and `c` are clock-skewed +10 / -10 min in the fencing phase; node-local SQLite scenario on `b` |

`REGIONS` and `PREFIXES` choose the regions and their /16 address spaces (each must not overlap the control VNet or
anything already peered with it); `WORKER_REGIONS` places workers `a b c d` by region index (sqld is always in region
0); `VM_SIZES` lists the sizes tried in order when a region lacks capacity for one.

One resource group and one /16 VNet per region, globally peered with each other and with the control host's VNet
(both sides). No VM has a public IP. Subnet NSGs deny Internet inbound at priority 100, allow TCP 22 only from the
control host's prefix, allow TCP 8443 to the sqld subnet only from the run's test VNets, and deny `VirtualNetwork` and
`AzureLoadBalancer` inbound explicitly; Internet egress is denied once the installs are done. Everything is tagged
`atomic-distributed-test=feat-issue-4321-fork-and-time-travel`, `atomic-run=<run>` and `atomic-expires=<time>`.

## Requirements

On the control host: `az` logged in, `jq`, `openssl` ≥ 3.4 (for `-not_before`), Python 3 with `cryptography`, Bun 1.4.4
on `PATH` (copied to the VMs), Node ≥ 22, and a checkout where `npm run build` has produced `packages/ai/dist`,
`packages/ai/src/providers/data` and the native module (they are copied to the VMs). The control host's network comes
from the environment; the scripts stop with an error naming any variable that is not set:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP` | provision, teardown, report | resource group of the control host's VNet |
| `ATOMIC_DISTRIBUTED_CONTROL_VNET` | provision, teardown, report | the control host's VNet, peered with every run VNet |
| `ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX` | provision, report | the only CIDR allowed to SSH to the VMs |
| `SUBSCRIPTION` (optional) | provision, teardown | subscription to use; default: the current `az` account |

## Run

```sh
export RUN_ID=fc$(date -u +%m%d)$(openssl rand -hex 2)
export ARTIFACT_DIR=<where results go>
test/distributed/fork-chaos/provision.sh        # network, peerings, VMs (no public IPs)
test/distributed/fork-chaos/setup-nodes.sh      # per-run CA/JWT, sqld + nginx, Node/Bun/worktree on workers
test/distributed/fork-chaos/verify-security.sh  # mandatory; tear down instead of testing if it fails
node test/distributed/fork-chaos/controller.mjs # one round: scenario, faults, convergence, checker -> $ARTIFACT_DIR
node test/distributed/fork-chaos/report.mjs     # $ARTIFACT_DIR/results.json and summary.md
test/distributed/fork-chaos/teardown.sh         # always; writes teardown-proof.json
```

For another round against the current worktree, run `ROUND=<n> test/distributed/fork-chaos/sync-worktree.sh` and the
controller again with a new `ARTIFACT_DIR`; the controller resets the journal and the workers before it seeds.

Secrets (SSH key, CA key, JWT key and token) live in `~/.fork-chaos/$RUN_ID` (mode 700, files 600). The token reaches
the workers by `scp` from its file, sits in `/opt/fork-chaos/secrets/sqld.token` (mode 600) and is read only through
Atomic's storage secrets resolution (`secrets: { authToken: { file } }`). It never appears on a command line, in a log
or in the results. The report replaces the control host's network values with placeholders.

## Scenario

`workload.ts` (Bun, from the repository root) runs on every worker:

- `seed N` runs N source runs of a deterministic workflow (six `ctx.tool` steps, seven stages, three of them in a
  nested `ctx.workflow` child, so `child.c2` is a fork point). Every tool callback inserts one row into
  `chaos_ledger` in the same sqld database, keyed by a per-execution id.
- `forker` loops fork attempts: `listForkPoints`, then `forkRun` from a random point (sometimes the whole run, new
  inputs, `carryMessages: "all"`, another `cwd`, a fork of a fork, an abort signal, or a probe expected to fail with a
  given code), then waits for the fork's execution. Retryable `ForkError`s are retried with backoff. Every step is
  appended and fsynced to `/opt/fork-chaos/state/*.jsonl`. Hooks around the journal can SIGKILL the process after a
  claim, inside the copy transaction before commit, right after the commit or inside a tool, and SIGSTOP it after a
  claim. A restarted forker re-drives what the killed one left: a fork whose copy committed is adopted and resumed,
  never forked twice; so is a fork a typed error reports as written (`journal-unavailable` in phase `hydrate`).
- `resume [--global]` re-drives this node's unfinished attempts; `--global` also resumes every fork run in the
  journal that has not completed.
- `local <shared run id> <mount>` forks within a node-local SQLite journal, asks it for a run that exists only in
  the shared journal, and forks with the local disk full.
- `tlscheck` proves through the Atomic client stack that sqld needs the token and TLS with the run CA.

`controller.mjs` drives the phases: baseline; network (tc netem 100-500 ms, 5-30 % loss both ways, iptables partitions
of 15-60 s per node); kills (self-kill hooks plus external SIGKILLs); fencing with clock skew (one process SIGSTOPped
for 150 s holding a fresh source claim while the others, two of them ±10 min skewed, hammer that source); storage
(cgroup v2 `io.max` throttling of sqld's data disk, then the disk filled with `fallocate`); a mixed phase; then it
heals everything, drains, resumes and records the time to converge. `check.ts` reads the journal with plain SQL and
checks the invariants: untouched sources (hash of every event and the run row), no corruption (`PRAGMA
integrity_check`, contiguous sequences, no events without a run), atomic fork runs (complete seed, exact copied
prefix), no lost or duplicated work (ledger vs. checkpoints, one fork per attempt, no orphan fork), no wrong-tree
replay, fencing (no takeover of a fresh claim inside 120 s on the journal's clock), typed errors (every fork-path
failure is a `ForkError` with the documented `retryable` flag, or the caller's abort reason), recovery, and complete
worker logs (every worker the manifest lists, which the controller records as `expectedWorkers` in the timeline,
contributed readable logs with at least one record; only a log's final line may be torn by a killed process).

The round fails unless every one of those invariants passed. The controller collects each worker's logs onto node a
before the checker runs, and the round fails with `logs-not-collected` when archiving a worker's state or extracting
it exits nonzero or is ended by a signal; the checker then does not run. `check.ts` writes `check.json` and then exits 1 if any
invariant failed. The controller copies the report and exits 1 if the report is missing or unreadable, lacks an
invariant, holds a failed one, or the checker exited nonzero. The shared checker does not cover the node-local
SQLite scenario, so it has its own expectations. `workload.ts local` exits 1, and the round fails with
`local-sqlite-failed`, when the workload exits nonzero, prints no report, or its report misses one: the local fork
completes from `child.c2` replaying the tools before it; a shared-only run is `source-not-found` on local-only storage
with the join hint; the fork on a full disk fails with a typed error and writes no run; the fork after freeing the
disk completes; and no partial run is left. The `controller-error` timeline event carries the code (`report-missing`,
`report-invalid`, `checker-failed`, `invariants-failed`, `local-sqlite-failed` or `logs-not-collected`) and what
missed. To re-check a stored round, run `node test/distributed/fork-chaos/verdict.mjs <check.json>` or
`node test/distributed/fork-chaos/verdict.mjs --local <node-local-sqlite.json>`.

`verify-security.sh` fails when any `az` query fails, and when the VMs or NICs it finds do not match the manifest.
So a query that returns nothing cannot pass the security gate.

## Source snapshot coordination

Forks use the source's journal lease, renewing it every 30 seconds against the journal clock and epoch. The
takeover window is 120 seconds. A lease already owned by the backend is renewed but left to its existing holder
when the fork finishes; a temporary fork lease is released after renewal work has stopped and drained.

Journal events and all source session entries are materialized before the destination is committed. Ownership
checks surround the session reads and run again immediately before the atomic seed write. A successful renewal
checks the original holder and epoch, proving no takeover occurred while that snapshot was read. The caller's
abort signal is checked after the final asynchronous renewal, before the write starts. Known lease loss stops
source reads and destination creates early and reports `source-busy` with reason `lease-lost` and its cause.

No source data is read after the snapshot is sealed. A takeover after that point cannot change the in-memory
payload; an in-flight write's confirmed or uncertain outcome remains authoritative and its session copies are
never deleted merely because ownership changed later. This guarantee assumes workflow writers follow the
journal lease protocol. A stale writer's journal mutations are fenced, but arbitrary direct writes to a session
store are outside that protocol.

## Teardown

`teardown.sh` deletes only what `provision.sh` created for the run. It never deletes a resource just because the name
contains the run id:

- control VNet peerings named exactly `atomic-dt-<run>-<region>` that point at the run's VNet in that region;
- resource groups tagged `atomic-run=<run>` and `atomic-distributed-test=<branch tag>`, which contain the VMs,
  disks, NICs, NSGs, VNets and their peerings;
- VNet flow logs whose target is one of the run's VNets.

Azure region names contain no hyphens. So a name like `atomic-dt-demo-production-westus3` belongs to run
`demo-production`, not `demo`, and teardown leaves it alone. Teardown then records the `az` queries, with the same
selectors, that prove nothing of the run remains. It exits 1 when that proof is not clean: something of the run is
left, or a query failed. Run it again until it exits 0. Run it even after a failed bring-up.
