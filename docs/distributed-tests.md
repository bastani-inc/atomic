# Distributed tests on PostgreSQL

The harness in [`test/distributed/`](../test/distributed/) runs several Atomic nodes against one shared PostgreSQL
database and checks that they work together: Intercom messages between nodes, sessions that move to another node,
broker failures, wake-ups, forks, and faults in the database itself. It writes a report of what passed and what failed.

Run it when a change affects how nodes share sessions or Intercom through the database. It is not part of `npm test`
or CI. For changes to the harness itself, start with its [unit tests](#unit-tests).

## What it starts

Docker Compose ([`compose.yaml`](../test/distributed/compose.yaml)) starts the database side:

- **PostgreSQL 16 primary.** Its data lives on a disk image of its own, so the disk faults can slow it or fill it.
- **PgBouncer** in transaction mode, set up as the [PgBouncer guide](../packages/coding-agent/docs/storage/postgres/pgbouncer.md)
  says, with prepared statements kept.
- **A streaming replica** of the primary, unless you pass `--no-replica`.

Every server uses TLS with a certificate the run makes for itself, and SCRAM passwords the run generates. Atomic's
runtime role has no right to change the schema; the owner role runs `atomic storage migrate`. Only PostgreSQL and
PgBouncer are reachable from the host, on `127.0.0.1`, and the superuser cannot log in over the network.

The Atomic nodes run as separate processes on the host, from this checkout. Each node has its own home directory,
agent directory, and Intercom broker. Its queries go through PgBouncer, and its wake-up connection (`listenUrl`) goes
straight to the primary. Each node reaches the database through a small proxy of its own, which the harness can cut
or slow to simulate a network fault.

```text
node a ─┐                        ┌─> PgBouncer :6432 ──> primary :5432 ──> replica
node b ─┼─ per-node proxy ───────┤
node c ─┘                        └─> primary :5432 (wake-ups)
```

## Prerequisites

- Linux or macOS with Docker and Docker Compose v2. The PostgreSQL containers run privileged: each one
  loop-mounts its data disk and limits its own disk speed.
- Node.js, Bun, `git`, and `openssl` on `PATH`.
- A built checkout: run `npm ci` and `npm run build` first.

The first run builds a small PostgreSQL image (PostgreSQL 16 plus `mkfs.ext4`) and pulls PgBouncer, so it needs
network access.

## Run it

From the repository root:

```bash
node test/distributed/run.mjs
```

This starts the database, runs the security check, runs every suite, writes the report, and removes everything it
started. A full run takes about 15 to 30 minutes. To run some suites only:

```bash
node test/distributed/run.mjs --suite intercom-routing,resume
node test/distributed/run.mjs --suite database-faults --faults primary-restart,disk-full
```

Use `--plan-only` to see what a run would do without starting anything, and `--help` for every option.

The security suite always runs first. If it fails, no other suite runs and the database is removed, even with `--keep`.

## Suites

| Suite | What it checks |
| --- | --- |
| `security` | TLS and SCRAM on every server; no plain connections, wrong CA, wrong password, or superuser over the network; the runtime role cannot change the schema; PgBouncer is in transaction mode |
| `intercom-routing` | Messages between brokers on different nodes arrive once and in order. Wake-ups come by `LISTEN`/`NOTIFY` on the primary, not through PgBouncer. A node whose wake-up connection is cut still gets its messages, and listens again once it heals |
| `broker-failover` | A killed broker's messages are queued and arrive after it restarts. A frozen broker does not stop the other nodes. A node cut off from the database catches up after the partition heals |
| `session-handoff` | An Intercom session that moves to another node keeps its id. One whose node stops answering gets a new id first, then its own id back once the old node's hold lapses. Messages arrive once throughout |
| `resume` | A session killed on node A resumes on node B in a byte-identical tree, also after node B is killed in the middle of the restore. A cut-off node fails with a typed, retryable error. A node without Git opens the session without its checkout, or downloads Git and restores it |
| `fork` | A session recorded on node A is forked and continued on node B, while node C continues the original. Each keeps only its own continuation |
| `wake-ups` | A released session and a released subagent wake on another node in their restored checkouts. Intercom wakes released subagents for messages from other nodes and delivers each message once, in order |
| `replica` | The replica streams over TLS. A node reading from the replica sees every entry the other nodes wrote, and cannot write there |
| `database-faults` | The faults below, one at a time, while every node sends messages and node A writes a session. See [Faults](#faults) |

## Faults

`database-faults` injects each fault for about 12 seconds while the nodes keep working, undoes it, and waits for
the database and the brokers to recover. Then it checks that every message a broker accepted arrived exactly once and
in order, that no refused message arrived, that no message arrived twice, and that the session writer is making
progress again. A send whose outcome stays uncertain, because the recipient did not confirm it in time or the
connection was lost, may arrive or not, but never twice. Each send is retried with the same message id, as a session
does. At the end it reads
the session from another node and checks that every entry the store confirmed is there, in order.

| Fault | What happens |
| --- | --- |
| `pgbouncer-restart` | PgBouncer is killed and started again, which drops every client and pooled connection |
| `primary-restart` | The primary restarts, which drops every connection, including the wake-up connections |
| `primary-pause` | The primary freezes: connections stay open but nothing answers |
| `node-partition` | Node B is cut off from PgBouncer and the primary |
| `link-latency` | Node B's links to the database add 250 ms each way |
| `broker-sigkill` | Node C's broker is killed, then started again |
| `broker-sigstop` | Node A's broker is frozen with `SIGSTOP`, then resumed |
| `clock-skew` | Node B's broker restarts with its clock 45 seconds fast |
| `disk-throttle` | The primary's data disk slows to 256 KB/s |
| `disk-full` | The primary's data disk fills up, then the space is freed |

The run's seed sets the order of the faults. Pass `--faults none` to skip this suite, or a comma-separated list to
choose faults.

## Read the report

Each run has a directory under `$XDG_STATE_HOME/atomic-distributed-test/runs/<run-id>/`, or under the directory you
pass to `--out`. If `XDG_STATE_HOME` is unset, the base is `~/.local/state`. It holds:

- `report.md`: whether the run passed, each suite's result, each failed test with its message, and the faults with
  their times.
- `report.json`: the same, plus the options and seed, for `--replay`.
- `events.jsonl`: everything the scenarios recorded, such as when each fault started and ended, and delivery times.
- `nodes/<suite>/<node>/`: each node's broker log and the error output of each node process.
- `vitest-*.json`: the test runner's own results.

If there is no report, start with the terminal output. A suite that shows `not-run` did not start because something
before it stopped the run. Check the `error` field in `report.json`.

Passwords and keys stay in the run's `secrets/` and `tls/` directories. The reports redact the passwords. Do not share
those two directories.

## Keep, reuse, and replay

- `--keep` leaves the database running after the run. The report says how to reuse it.
- `--reuse <run-id>` runs suites against a database a `--keep` run left. Pass the same `--out` if you set one.
- `--replay <path/to/report.json>` repeats the suites, faults, node count, and seed of an earlier run. The seed
  repeats the harness's choices, such as the fault order. It does not repeat the timing of the processes.

## Run on a cloud VM

The harness needs nothing beyond the prerequisites above, so it runs the same way on any Linux VM with Docker. Clone
the repository, build it, and run the same commands. Everything it starts listens on `127.0.0.1` only, so the VM does
not need any inbound port open. Use a VM with at least 4 CPUs and 8 GB of memory for the default three nodes.

## Clean up

A run removes what it started, then checks that no container, volume, or network is left. If it could not, or if a
run was killed, use the sweeper:

```bash
node test/distributed/sweep.mjs --dry-run
node test/distributed/sweep.mjs
node test/distributed/sweep.mjs --run-id "$RUN_ID" --force
```

The first command shows what it would remove. The second removes runs older than six hours, and runs that have only
volumes or networks left. Use `--ttl-hours` to change the limit. The third removes one run now, whatever its age. The
sweeper only touches Compose projects whose name starts with `adt-`.

## Unit tests

The harness's own logic has unit tests that need no Docker:

```bash
npm run test:unit -- test/unit/distributed-
```

## Where things are

- [`run.mjs`](../test/distributed/run.mjs) and [`sweep.mjs`](../test/distributed/sweep.mjs): the commands.
- [`harness/`](../test/distributed/harness/): options and plan, the Compose stack, the report, the per-node proxy, and
  the cluster helper the scenarios use to start nodes and brokers.
- [`scenarios/`](../test/distributed/scenarios/): one file per suite, run with
  [`vitest.config.ts`](../test/distributed/vitest.config.ts), one file at a time.
- [`postgres/`](../test/distributed/postgres/) and [`pgbouncer/`](../test/distributed/pgbouncer/): server setup,
  `pg_hba.conf`, and the disk fault script.
- [`node/`](../test/distributed/node/): node processes that the scenarios run with Bun. The scenarios also use
  [`test/fixtures/multinode-resume-node.ts`](../test/fixtures/multinode-resume-node.ts) and the released-session
  fixtures next to it.
