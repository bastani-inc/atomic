# Elastic Multi-Host Workflows — Technical Design Document / RFC

| Document Metadata      | Details |
| ---------------------- | ------- |
| Author(s)              | Alex Lavaee (with Atomic) |
| Status                 | Draft for review. Implementation targets the release after 0.9.87 |
| Issue                  | [#4768](https://github.com/bastani-inc/atomic/issues/4768) |
| Team / Owner           | `packages/workflows` (pool, worker host, autoscaler); `packages/coding-agent` (CLI, settings, docs); `packages/storage-libsql` (write path) |
| Created / Last Updated | 2026-11-14 |
| Builds on              | #3869 local workers, #4310 shared placement (`workers: { placement: "shared" }`, `startWorkflowWorkerHost`), #4416 restore backoff, #4329 resume on any machine |
| Evidence               | [`research/evidence/elastic-workers/`](../research/evidence/elastic-workers/README.md) |
| Compatibility posture  | Every slice is mergeable to `main` behind defaults that keep today's behavior: `checkpointShipping: "sync"`, no provisioner, no fleet rate limits. S0 changes only how existing writes reach the database, not what they write |

---

## 1. Problem

Shared placement already runs a root's pooled children on worker hosts on other machines. Every durable step a child
takes on any host commits through one remote writer, one interactive SQL transaction at a time. Users running
campaigns with hundreds to thousands of pooled children need dozens of hosts. Three gaps block that:

1. **The shared writer is the ceiling, and under load it wedges.** On this machine, today's shared placement tops out
   at 35–39 checkpoints per second whatever the host count, and its p50 checkpoint latency grows from 191 ms with one
   host to 750 ms with eight. At 8 hosts × 4 slots the shared store wedged in two of four runs: no write committed for
   25 minutes and every pooled child hung (§3).
2. **Adding capacity is a project.** Joining a machine means writing an SDK script around `startWorkflowWorkerHost`.
   Nothing grows or shrinks the set of hosts.
3. **Hosts do not cooperate on model quotas.** A 429 on one host is shared only with the workers of that host's
   coordinator (`workers/rate-limit-sharing.ts`), so a fleet retries in a stampede.

The issue lists five parts: local checkpoints with shared coordination, background checkpoint shipping, a host
provisioner, fleet-wide rate limits, and fleet status. The user added three requirements:

- **Ease of use first.** Install Atomic on a node, run one command that names the shared database, and the node is a
  worker host. Nodes coordinate only through that database. SIGTERM drains.
- **Copy proven patterns** from popular schedulers (§4).
- **Degrade, never block.** Every failure degrades and never blocks a run or a resume unless it is truly fatal. This
  rule applies to shipping lag, a dead host, provisioner errors and a token-bucket store outage (§10).

## 2. Goals and non-goals

Goals:

- G1. Shared placement completes at 8 and 16 hosts × 4 slots with no wedge, and degrades by slowing down, not
  stopping (S0).
- G2. `atomic worker start` turns a machine with Atomic installed into a worker host in one command (S1).
- G3. With `checkpointShipping` enabled, a host's checkpoint rate depends on its local disk, not on the shared writer.
  The shared store sees one write per batch per child (S2–S4).
- G4. A pluggable provisioner keeps the fleet between `minHosts` and `maxHosts` from queue depth, admission and
  budget, with Azure VM Scale Set, Kubernetes and command adapters, all validated by one conformance suite (S5–S6).
- G5. Fleet-wide token buckets per provider and model, plus fleet-wide 429 cooldowns (S7).
- G6. `/workflow status` and `host.stats()` show hosts, workers, queue depth, shipping lag and scale events (S8).

Non-goals:

- Changing the root's own (non-pooled) checkpoint path, or the default local journal store.
- Exactly-once external effects. The model stays at-least-once with a bounded replay window.
- A hosted control plane. The shared database is the only rendezvous point.
- Windows worker hosts, which still lack process containment (unchanged from #4310).

## 3. Measurements (before design)

All scripts and raw results are under `research/evidence/elastic-workers/`, and its `README.md` has the commands.
Every multi-node number in this document comes from **local multi-process runs on one 80-core VM**. Each worker host
is a separate Node process with its own `HOME` and agent directory, against a real `sqld` v0.24.33 (the version the
distributed harness pins). An optional TCP proxy adds WAN latency. **Azure validation is pending**: write access to
the test subscription expired mid-provisioning. §13.4 lists the runs still to do. The controller VM was shared with
other agent sessions, at a one-minute load average of 30–58, so absolute numbers are noisy. The ratios below held
across repeated runs.

### 3.1 Today's shared placement, 64 children × 20 checkpoints, 4 slots per host, sqld on loopback

| Hosts × slots | Writers | Checkpoints/s | p50 ms | p90 ms | p99 ms | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 1 × 4 | 5 | 24.1 | 191 | 212 | 239 | completed |
| 2 × 4 | 9 | 35.5 | 219 | 272 | 320 | completed |
| 4 × 4 | 17 | 38.9 | 342 | 474 | 572 | completed |
| 4 × 8 | 33 | 34.6 | 644 | 857 | 1014 | completed |
| 6 × 1 | 7 | 27.1 | 208 | 267 | 330 | completed |
| 8 × 1 | 9 | 29.5 | 239 | 295 | 379 | completed |
| 8 × 4 | 33 | 31.6 | 750 | 1017 | 1217 | completed in 2 of 4 runs; **wedged** in 2 |
| 8 × 4, sqld `--max-concurrent-requests 1024` | 33 | 23.3 | 813 | 1142 | **11 556** | completed, 10 s stalls |

(`results/local-sqld-sweep-default.json`, `local-sqld-4x8.json`, `local-sqld-Nx1.json`, `local-sqld-8x4-1024conn.json`,
`local-sqld-rtt0-run1.jsonl`, `local-sqld-8hosts-run2.json`.) "Writers" counts the root's own worker too.

Throughput stops growing at about 9 writers. Every extra host only adds latency: the queue for the single write lock
gets longer.

### 3.2 The per-host ceiling without a shared writer

The same fan-out on one machine's own default journal store, with `localWorkers` only (`results/local-journal.json`):

| Local workers | Checkpoints/s | p50 ms | p99 ms |
| --- | --- | --- | --- |
| 4 | 27.1 | 146 | 165 |
| 8 | 51.8 | 151 | 194 |
| 16 | 97.9 | 159 | 239 |

Local checkpointing scales linearly with workers, at a flat ~150 ms per step. That ~150 ms is IPC to the
coordinator plus the worker's catch-up fold, not storage. One 16-worker host already writes 2.5× what the whole shared
fleet manages. That gap is what parts 1 and 2 of the issue buy.

### 3.3 Why the shared writer saturates: transactions hold the lock across round trips

A tracing proxy (`trace-proxy.mjs`) between the hosts and sqld reconstructs each write transaction from Hrana batons
(`results/local-sqld-traced.json`):

| Hosts × 4 | Write transactions | HTTP requests per transaction (p50 / p99 / max) | Lock hold p50 / p99 / max ms | `BEGIN IMMEDIATE` wait p50 / p99 / max ms |
| --- | --- | --- | --- | --- |
| 2 | 3 337 | 8 / 11 / 17 | 9 / 25 / 50 | 9 / 50 / 95 |
| 4 (proxy hop) | 823 | 8 / 11 / 17 | 37 / 294 / 10 046 | 233 / 455 / 10 026 |
| 8 (proxy hop) | 1 359 | 6 / 11 / 17 | 16 / 174 / 10 023 | 107 / 5 027 / 19 971 |

Every pooled write (`SqlPoolQueue.commit`, `heartbeat`, `claim`, the shared-pool stage input calls) is an interactive
`BEGIN IMMEDIATE … COMMIT` made of 6–17 HTTP requests, and the write lock is held for all of them. The lock is
therefore held for at least the request count times the round trip time, and the whole fleet serializes on it.
An Atomic-free reproduction (`sqld-contention-repro.mjs`, `sqld-contention-multiprocess.sh`) shows the same shape:

| Load (12 statements, one process per client) | Commits/s | Worst client's p99 latency ms |
| --- | --- | --- |
| 40 processes, interactive transaction | 35.9 | 2 033 |
| 40 processes, one `batch(..., "write")` request | 223.9 | 432 |
| 100 processes, interactive | 30.0 | 4 754 |

Sending the same statements as one write batch, one request with no client round trip inside the lock, gives
**6.2× the commit rate** and a lower tail. This is the lever S0 pulls.

### 3.4 The wedge (finding for S0)

At 8 × 4 (and once at 4 × 4 behind the trace proxy), the store stops committing anything. The evidence is in
`results/wedge-8hosts-run1/` and `results/local-sqld-8hosts-run2.json`:

- 113 journal events in the first 14 s, then none for 25 minutes. Work rows stay `leased` with expiries 1 400 s in
  the past, and no host's heartbeat lands.
- A fresh client's `CREATE TABLE`/`INSERT` probe times out (15 s; it was still waiting after 5 minutes). Reads still
  answer.
- sqld burns 6.8 cores with 229 threads. Its slowest-query table holds only `BEGIN IMMEDIATE` and `COMMIT`, at
  durations quantized to 5 008, 10 002, 15 009 and 20 0xx ms, which are multiples of sqld's 5 s lock wait.
- Workers die with `StorageUnavailableError` caused by undici `UND_ERR_HEADERS_TIMEOUT`: a request waited longer than
  undici's 300 s header timeout.
- Raising sqld's request and connection limits from 128 to 1024 turns the wedge into 10 s stalls (p99 11.6 s). The
  run completes, so the stall is a queueing interaction and not data corruption.
- The Atomic-free load does not wedge, at 128 in-process clients or 100 processes. So the trigger is specific to
  Atomic's write pattern: multi-request transactions, plus clients that retry `BEGIN IMMEDIATE` for up to
  `JOURNAL_TRANSACTION.lockWaitMs` (10 minutes) through the facade's retry, from many connections per host
  (coordinator queue, shared pool, admission, sessions).

**Root cause.** The established part is that Atomic holds sqld's single write lock across 6–17 client round trips per
transaction (§3.3). Every pooled write in the fleet serializes on that, and that alone explains the 35–39/s ceiling.
The wedge is the same pattern at saturation. The holder's next request, usually its `COMMIT`, waits behind
`BEGIN IMMEDIATE` waiters. Each waiter sits out sqld's 5 s lock wait, and the client retries it at once (for up to
10 minutes), so the holder keeps losing its turn and commits collapse to zero. The evidence for that is the `COMMIT`
durations quantized at 5 s, the full stop of writes while sqld spins, and the stalls a higher request limit turned
into. What is not pinned down is the exact queue inside sqld where the holder waits. A reduced Atomic-free run with
sqld's request limit at 16 got `SERVER_ERROR` refusals rather than a wedge (`results/sqld-limiter-inversion.json`),
so the request limiter alone does not reproduce it. S0's first task pins it with the committed trace proxy, extended
to map requests to client connections. The fix removes the inversion from both sides and does not depend on that
detail:

- with no round trips inside the lock, no holder ever waits for a turn;
- with bounded, jittered client retries and a per-process write cap, waiters never saturate sqld.

### 3.5 Latency sweep (local multi-process nodes)

The harness supports a latency hop (`--latency-ms`) and SIGKILL of one host's process group (`--kill-after-ms`). The
sweep (3, 10 and 20 hosts × 2 slots, 120 children × 10 checkpoints, about 2 ms and about 30 ms RTT, then a kill -9)
was **stopped after its first trial**, because the shared controller VM reached a load average of 170–245 on 80
cores. The one recorded trial (`results/nodes-rtt2ms-loaded-host.json`, 3 hosts at about 2 ms RTT) is labeled
loaded-host. It did not wedge (its write probe succeeded), and it had completed 103 of 120 children when its 240 s
budget ran out. The rest of the sweep is pending, to run below load 60 or on Azure (§13.4). Today's dead-host
takeover and cross-host Intercom are already covered by `test/integration/workflow-shared-pool-hosts.test.ts`
(#4310, #4391). S4 adds the shipping-mode version. **The shipping defaults below are derived from §3.1–3.3, not from
the latency sweep**: §3.3 already isolates the cost per request, and RTT only scales it.

### 3.6 What the numbers set

| Default | Value | Derived from |
| --- | --- | --- |
| `checkpointShipping` | `"sync"` | Issue: today's behavior until shipping is proven on real VMs |
| `checkpointShipping.intervalMs` | `2000` | One flush per child every 2 s. With a batch costing one request, about 10 ms of lock time (§3.3), 64 children flushing every 2 s use about 32% of the lock at 2 ms RTT. Shorter intervals trade replay window for lock time linearly |
| `checkpointShipping.maxBatch` | `64` | At the measured per-host rate of ~6 checkpoints/s per worker (§3.2), a 2 s interval collects ~12 per child. 64 bounds the replay window by count, and keeps a batch under 1 MiB at the default checkpoint payload cap |
| `checkpointShipping.maxLagMs` | `30000` | Past this lag a host's status turns `lagging`, and it ships before it claims new work (§7.4). Matches the default work lease |
| Worker slots per host (`atomic worker start --slots`) | CPU count ÷ 2, at most 16 | §3.2: per-host throughput scales linearly to 16 workers on local storage. Pooled children also run CPU-heavy tools, so half the cores are left for them |
| Shared-store client write concurrency | 4 in-flight write requests per process | §3.3: the store saturates at about 9 concurrent writers. A per-process cap keeps the lock queue bounded as hosts grow |
| Write retry | 20 ms base, ×2, full jitter, capped at 1 s, total budget = the caller's `lockWaitMs` | Replaces immediate retries of 5 s waits (§3.4) |

## 4. Prior art, and what we copy

| System | Pattern | Taken for Atomic |
| --- | --- | --- |
| Temporal ([task queues and sticky execution](https://docs.temporal.io/sticky-execution), [history shards](https://docs.temporal.io/temporal-service/temporal-server)) | Workers long-poll task queues. History persistence is sharded, and transfer tasks use an outbox written in the same transaction as workflow state. Sticky queues route a workflow's next task to the worker that holds its cache | Workers keep polling the shared queue (unchanged). Each host's local shard plus outbox mirrors Temporal's history-shard transfer queue. A child stays on its host while it runs, like sticky execution, and falls back to any host on lease expiry |
| Ray autoscaler ([configuration](https://docs.ray.io/en/latest/cluster/vms/user-guides/configuring-autoscaling.html), [`ICloudInstanceProvider`](https://github.com/ray-project/ray/blob/master/python/ray/autoscaler/v2/instance_manager/node_provider.py)) | `min_workers`/`max_workers`/`idle_timeout`. Scales on queued resource demand, not utilization. A minimal provider interface launches, terminates and lists instances, and polls errors | `minHosts`/`maxHosts`/`idleDrainMs`. Target computed from queue depth and admission. The provider interface is `scaleTo`/`drain`/`list` plus errors as data |
| Celery ([`acks_late`, visibility timeout, prefetch](https://docs.celeryq.dev/en/latest/userguide/configuration.html), [optimizing](https://docs.celeryq.dev/en/latest/userguide/optimizing.html)) | At-least-once by acknowledging after execution, with redelivery after a visibility timeout. Bounded prefetch keeps workers from hoarding | The work lease is the visibility timeout. A child is "acked" only when its result is committed. A host claims at most its free slots (prefetch 1), and the autoscaler counts only ready work |
| Dramatiq / Dask distributed | Heartbeats plus worker removal on missed heartbeats. Retirement moves work off a worker before it stops | Host registry heartbeat (exists). `drain` is graceful retirement: no new claims, flush shipping, then exit |
| Kubernetes Jobs / StatefulSets, Nomad | Desired replica count reconciled by a controller. A pod deletion cost and preStop hooks drain before kill | The Kubernetes adapter scales a StatefulSet's replicas and drains a named pod (annotation, then delete). The container's SIGTERM drains through the preStop budget |
| Buildkite Elastic CI Stack ([scaling](https://buildkite.com/docs/agent/self-hosted/aws/elastic-ci-stack/ec2-linux-and-windows/managing-elastic-ci-stack)), GitHub Actions ARC | Agents register with a token and poll. The scaler polls queue depth (about every 10 s), never scales in a busy agent, and agents exit after an idle period | One-command join with a token file. A 10 s autoscaler tick. Scale-in only drains idle hosts. Hosts can also exit by themselves after `idleExitMs` (for scale-to-zero groups that have no controller) |
| Prefect work pools / Dagster run queues ([workers](https://www.prefect.io/docs/v3/concepts/workers)) | Lightweight workers poll a named pool. Infrastructure config lives on the pool, not the worker | The worker host serves every shared root on its journal. Its labels, not the root, describe the infrastructure |
| Global rate limiting (Envoy/Redis GCRA) | One atomic compare-and-set per acquire on a theoretical arrival time | Token bucket as GCRA in one `UPDATE … RETURNING` statement, with local prefetch of tokens (§8) |

The simplest model that fits: **the database is the broker, hosts are pull-based agents, and the autoscaler is a
reconciler over a three-method provider.** No new service runs anywhere.

## 5. Design overview

```
            ┌───────────────────────────── shared database (libSQL/Turso/sqld) ─────────────────────────────┐
            │ coordination: work queue, leases, admission, stage inputs, Intercom routes, status index,     │
            │ results, fleet tables (hosts, controller lease, scale events, rate buckets),                  │
            │ shipped checkpoints (journal events), ship watermarks and batch ledger                        │
            └───────────▲───────────────────────────▲───────────────────────────────▲───────────────────────┘
                one-request write batches        batches, every 2 s/64          autoscaler tick (10 s)
                        │                           │                               │
 root host ─────────────┘     worker host A ────────┘   worker host B …     controller (root, or `atomic worker controller`)
 (run graph, control,         local shard + outbox                           → provisioner.scaleTo / drain / list
  budget)                     coordinator, workers
```

- **Sync mode (default, today):** every checkpoint commits to the shared store. S0 makes each commit one request.
- **Shipping mode:** a checkpoint commits to the host's local shard (fenced against the host's cached lease) and
  acknowledges the worker at once. A shipper delivers batches to the shared store under a server-side fence, in one
  request each.

## 6. User experience (S1)

### 6.1 Join a node

```sh
# once per machine
npm install -g @bastani/atomic && atomic install npm:@bastani/atomic-storage-libsql
# join and serve; SIGTERM drains
atomic worker start --db libsql://pool.example.turso.io --token-file /etc/atomic/token [--slots 8] [--label zone=east]
```

- `--db` and `--token-file` select the journal for this process only and write nothing to settings, the
  `ATOMIC_WORKFLOWS_JOURNAL` equivalent. Without them, `atomic worker start` uses the journal the machine already
  selects, for example after `atomic team join <url> --token-file <f>`, so on a joined machine the command is just
  `atomic worker start`.
- `--slots` defaults to `max(1, min(16, floor(cpus / 2)))` (§3.6). `--prefix`, `--host-id`, `--label k=v`
  (repeatable), `--no-restore` and `--idle-exit <ms>` map to the existing `WorkflowWorkerHostOptions`, plus
  `idleExitMs`.
- Output is one line per event (`ready host=… slots=… journal=libsql://…`, `claimed child=…`, `drained`). `--json`
  prints NDJSON for log shippers.
- Signals: SIGTERM and SIGINT call `host.drain()`: no new claims, running children finish, the shipping outbox
  flushes, then exit 0. A second SIGINT calls `host.stop()`. Exit code 0 means drained, 1 a setup error
  (`SharedPoolSetupError` lists every problem), 2 a stop forced while draining.
- `atomic worker status [--json]` prints `host.stats()` from the journal for every host. It reuses the reader in S8.

A settings block lets `/workflow run` use shared placement without the SDK (also S1):

```json
{ "workflows": { "localWorkers": { "count": 2, "definitions": [] }, "workers": { "placement": "shared" } } }
```

### 6.2 systemd unit (one line of cloud-init writes it)

```ini
[Unit]
Description=Atomic worker host
After=network-online.target
[Service]
ExecStart=/usr/bin/env atomic worker start --db ${ATOMIC_DB} --token-file /etc/atomic/token
EnvironmentFile=/etc/atomic/worker.env
KillSignal=SIGTERM
TimeoutStopSec=900
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

The cloud-init form is `runcmd: [systemctl enable --now atomic-worker]` after `write_files` writes the unit, the env
file and the token at mode 600. `research/evidence/elastic-workers/azure/cloud-init.yaml` is the one the experiment
uses.

### 6.3 Container image

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install -g @bastani/atomic@${ATOMIC_VERSION} && atomic install npm:@bastani/atomic-storage-libsql
USER node
STOPSIGNAL SIGTERM
ENTRYPOINT ["atomic", "worker", "start"]
CMD ["--token-file", "/run/secrets/atomic-db-token"]
```

The token is mounted as a secret, and `ATOMIC_DB` is passed as `--db`. The Kubernetes adapter (§9.3) expects a
StatefulSet of this image with `terminationGracePeriodSeconds` ≥ the longest child step.

## 7. Local checkpoints and background shipping (S2–S4)

### 7.1 Configuration

```ts
workers: {
  placement: "shared",
  checkpointShipping?: "sync" | { intervalMs?: number; maxBatch?: number; maxLagMs?: number }, // default "sync"
}
```

`intervalMs` is an integer from 100 to 60 000 (default 2 000). `maxBatch` is from 1 to 1 000 (default 64).
`maxLagMs` is from 1 000 to 600 000 (default 30 000). The root records the setting with its resources. It is
operational, like `startupTimeoutMs`: a resume may change it, and it is not part of the identity comparison. Worker
hosts read it from the root's published `SharedPoolConfig`, so hosts need no settings of their own.

### 7.2 Data model

Local, per host and per root, in `<agent dir parent>/workflows/pool/ship/<hash of journal selection>/<root>.sqlite`.
That is one SQLite shard per root, created through the existing journal-store shard opener
(`ShardedRunJournal.openShard`), so a host serving many roots never contends on one file:

| Table | Columns | Key | Purpose |
| --- | --- | --- | --- |
| `ship_events` | `local_seq INTEGER`, `work TEXT`, `generation INTEGER`, `epoch INTEGER`, `event_key TEXT`, `type TEXT`, `payload TEXT`, `digest TEXT` (sha256 of payload), `at INTEGER`, `batch TEXT NULL` | PK `local_seq` (autoincrement); UNIQUE `(work, event_key)` | Checkpoints the host accepted and has not yet seen shipped. `batch` is set when a batch is sealed |
| `ship_sessions` | `local_seq INTEGER`, `work TEXT`, `generation INTEGER`, `session TEXT`, `op TEXT` (`create`/`append`/`replace`), `entries TEXT`, `expect_seq INTEGER`, `batch TEXT NULL` | PK `local_seq` | Pooled-stage session mutations, shipped in the same batch as the checkpoint that binds them |
| `ship_cursor` | `work TEXT`, `generation INTEGER`, `shipped_local_seq INTEGER`, `shipped_at INTEGER`, `fenced INTEGER` | PK `(work, generation)` | The local high-water mark the shared store acknowledged |
| `ship_lease` | `work TEXT`, `generation INTEGER`, `worker TEXT`, `epoch INTEGER`, `root_epoch INTEGER`, `expires_at INTEGER` | PK `work` | The attempt's lease as last renewed. Local commits check it |

Shared, new tables beside the existing `<runs>_pool_*` tables (all keyed under the journal prefix, created only when a
root uses shipping):

| Table | Columns | Key | Purpose |
| --- | --- | --- | --- |
| `<runs>_ship_batches` | `batch TEXT`, `work TEXT`, `generation INTEGER`, `worker TEXT`, `epoch INTEGER`, `host TEXT`, `first_local_seq INTEGER`, `last_local_seq INTEGER`, `events INTEGER`, `shipped_at INTEGER` | PK `batch`; INDEX `(work, generation)` | Ledger of delivered batches. `batch` = sha256 over `(root, work, generation, [event_key, digest]…, [session op digests]…)`, which is content-addressed: a retried batch has the same id |
| `<runs>_ship_watermarks` | `work TEXT`, `generation INTEGER`, `host TEXT`, `last_local_seq INTEGER`, `last_event_key TEXT`, `shipped_at INTEGER`, `lag_ms INTEGER` | PK `work` | Highest shipped point per child: what a replacement replays to, and what status shows |
| `<runs>_pool_status` | `work TEXT`, `root TEXT`, `child_run TEXT`, `state TEXT`, `host TEXT`, `generation INTEGER`, `progress_at INTEGER`, `checkpoints INTEGER`, `summary TEXT NULL` (≤ 1 KiB) | PK `work`; INDEX `(root, state)` | The issue's status index: one row per child, written in the shipping batch and by claim/complete |
| `<runs>_pool_hosts` (extended) | adds `ship_pending INTEGER DEFAULT 0`, `ship_lag_ms INTEGER DEFAULT 0`, `ship_error TEXT NULL`, `slots_busy INTEGER DEFAULT 0`, `draining INTEGER DEFAULT 0`, `provider_id TEXT NULL` | — | Columns added with `ALTER TABLE … ADD COLUMN` guarded by `pragma_table_info`. Older hosts ignore them |

Shipped checkpoints land in the root's existing `<prefix>events` table under their existing event keys
(`["checkpoint-recorded", kind, checkpointId]`), so the root, `/workflow status`, resume and fork read them exactly
as today. Shipped sessions land in the existing `<runs>_pool_session_*` tables.

### 7.3 Protocols

**Local commit (worker → host coordinator).** It runs `validatePoolMutation` against the local shard plus the
checkpoints pulled at claim (§7.5), then checks `ship_lease` (generation, worker, epoch, not expired by the local
clock), inserts into `ship_events`/`ship_sessions`, and returns `{ localSeq }` as the receipt. Usage billing stays a
shared write through the existing heartbeat, which already carries cumulative usage, so budgets still see it within
one `heartbeatMs`.

**Ship (host shipper, per child).** It triggers on `intervalMs`, `maxBatch` unshipped events, child completion,
pause, drain, or a claim attempt while lag exceeds `maxLagMs`:

1. Seal: take up to `maxBatch` unshipped rows in `local_seq` order, compute `batch`, and set `batch` on them in one
   local transaction.
2. Deliver one `batch(…, "write")` request to the shared store. Its statements are, in order:
   1. `INSERT INTO <runs>_ship_batches … SELECT … WHERE EXISTS (SELECT 1 FROM <runs>_work WHERE id = ? AND generation = ?
      AND worker = ? AND epoch = ? AND state = 'leased') AND EXISTS (root lease row with holder epoch = ?) ON CONFLICT(batch)
      DO NOTHING`
   2. for each event: `INSERT INTO <prefix>events(run_id, seq, epoch, key, type, payload, at) SELECT ?, (SELECT
      COALESCE(MAX(seq), 0) + 1 FROM <prefix>events WHERE run_id = ?), ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM
      <runs>_ship_batches WHERE batch = ? AND work = ? AND generation = ?) ON CONFLICT(run_id, key) DO NOTHING`
   3. the session statements, under the same `EXISTS` guard;
   4. upsert into `<runs>_ship_watermarks` and `<runs>_pool_status`, under the same guard;
   5. `SELECT generation, worker, epoch FROM <runs>_work WHERE id = ?` plus `SELECT batch FROM <runs>_ship_batches
      WHERE batch = ?` as the reply.
3. Interpret the reply: a ledger row means delivered, whether new or a retry of a batch already delivered. Advance
   `ship_cursor` and delete the shipped local rows. No ledger row and a different generation, worker or epoch means
   **fenced**: mark `ship_cursor.fenced`, drop the attempt's unshipped rows, and fence the local attempt (it gets
   `StaleWorkLeaseError` on its next commit, as today).

A checkpoint key that already exists with a different payload is the existing "Pool checkpoint identity conflict".
The batch's final statement selects any such key, so the conflict surfaces in the reply rather than as a silent
`DO NOTHING`.

**Completion.** `complete` ships every unshipped row first, then writes the result in its own one-request batch
(guarded the same way). A child's result is never visible before its checkpoints, which preserves today's rule that
a child cannot complete while outbox rows exist.

### 7.4 Failure and replay semantics

| Event | What happens | Replay window |
| --- | --- | --- |
| Shipper delivery fails (network, `SQLITE_BUSY`, 5xx) | Retry the same sealed batch, with jittered backoff capped at `intervalMs`. Local commits continue | No change. Lag grows and shows in status |
| Lag exceeds `maxLagMs` | Host status `lagging`. The host claims no new children until lag < `maxLagMs`. Running children continue | Bounded by `maxLagMs` |
| Shared store unreachable for longer than the work lease | Leases expire. Another host may claim the child; this host's late batch is fenced and dropped | Since the last shipped batch |
| Host dies (SIGKILL, VM loss) | Its leases expire after `leaseMs`. Another host claims, pulls shipped checkpoints, and replays from the last shipped one. The dead host's tool processes follow today's confirm-gone rule (#4310) | ≤ `min(intervalMs, maxBatch events)` under healthy shipping, plus the lease |
| Displaced host comes back | Its batch fails the guard: fenced, dropped. Its local shard rows for that generation are deleted on the next start | — |
| Local disk full, or local shard corrupt | The local commit fails. The host falls back to sync mode for that child (direct shared commit, S0 path) and reports `ship_error` | Unchanged (sync) |
| Pause / quit | Ship before acknowledging the control revision | 0 |
| Root resume | Unchanged: work rows of previous incarnations are released. Their late batches are fenced by the root-epoch guard | Since last shipped |

Replay is at least once with the same guarantee as today: a completed step whose checkpoint was shipped is never
re-run, and one that was not shipped re-runs on the replacement. External effects in the window can repeat, as they
can after a crash today.

### 7.5 Claim on a shipping root

A claim returns as today. Before starting the child, the host also pulls the child's shipped checkpoints and its
boundary start into the local shard, reading the shared journal from the watermark with
`journalKeyRangeRead`-style paging. The bound worktree restores from snapshots exactly as today. Workers keep calling
`catchUpWorkflow`, against the local shard, which then holds only that child's scope. That removes today's per-claim
fold of every sibling's events.

## 8. Fleet-wide rate limits (S7)

Configuration (root, recorded, operational):

```ts
workers: { rateLimits?: { [providerOrModel: string]: { requestsPerMinute: number; burst?: number; prefetch?: number } } }
```

When `rateLimits` is unset, nothing changes except the default-off flag `shareCooldowns` (S7 adds it). With
`shareCooldowns: true`, 429 cooldown observations (`ProviderRateLimitObservation`) also go to the shared table, so
every host backs off.

Shared table `<runs>_rate_buckets(scope TEXT PRIMARY KEY, tat INTEGER NOT NULL, interval_ms REAL NOT NULL, burst INTEGER
NOT NULL, cooldown_until INTEGER NOT NULL DEFAULT 0, kind TEXT, updated_at INTEGER)`. `scope` is `provider` or
`provider/model`. GCRA acquire of `n` tokens is one statement:

```sql
UPDATE <runs>_rate_buckets
   SET tat = MAX(tat, :now) + :n * interval_ms, updated_at = :now
 WHERE scope = :scope AND MAX(tat, :now) + :n * interval_ms - :now <= burst * interval_ms AND cooldown_until <= :now
RETURNING tat, cooldown_until;
```

No row returned means "wait": a follow-up read (in the same batch) returns `tat` and `cooldown_until` so the caller
can compute the delay. A 429 sets `cooldown_until = MAX(cooldown_until, :until)` in one statement. Each host
coordinator prefetches `prefetch` tokens (default `ceil(slots / 2)`) and hands them to workers over the existing IPC,
so the shared store sees about one acquire per prefetch.

**Degrade rule:** if the store is unreachable or slow (an acquire not answered within 1 s), the host switches to a
local bucket at `requestsPerMinute / max(1, liveHosts)` and keeps today's local cooldown sharing. It reports
`rateLimit: "local-fallback"` in stats and reconciles when the store answers. A model call never waits on the
rate-limit store beyond that 1 s.

## 9. Host provisioning and autoscaling (S5–S6)

### 9.1 Interface

```ts
export interface WorkerHostProvisioner {
  readonly kind: string; // "azure-vmss" | "kubernetes" | "command" | custom
  /** Hosts this provider manages, in any state. Must not throw for "none". */
  list(signal: AbortSignal): Promise<readonly ProvisionedHost[]>;
  /** Make the provider's desired count `target`. Idempotent; may return before hosts boot. */
  scaleTo(target: number, signal: AbortSignal): Promise<void>;
  /** Remove one host after it drained. Idempotent for an unknown or already-gone id. */
  drain(id: string, signal: AbortSignal): Promise<void>;
}
export interface ProvisionedHost {
  readonly id: string;          // provider's id (VM instance id, pod name, command-defined)
  readonly hostId?: string;     // Atomic worker host id once it registered (via ATOMIC_WORKER_PROVIDER_ID)
  readonly state: "pending" | "running" | "draining" | "stopped" | "failed";
  readonly since: number;
}
```

A provisioned host learns its provider id from `ATOMIC_WORKER_PROVIDER_ID` or from the cloud metadata of the adapter.
It writes the id to `<runs>_pool_hosts.provider_id`, which lets the controller match provider hosts to registered
hosts.

### 9.2 Policy and controller

```ts
workers: { provisioner?: { kind: "azure-vmss" | "kubernetes" | "command" | WorkerHostProvisioner, options?: object,
  minHosts?: number /*0*/, maxHosts?: number /*10*/, workersPerHost?: number /*matches --slots*/,
  scaleUpQueueDepth?: number /*= workersPerHost*/, scaleUpDelayMs?: number /*20000*/, idleDrainMs?: number /*300000*/,
  bootTimeoutMs?: number /*600000*/ } }
```

The controller holds the lease row `<runs>_fleet_controller(id INTEGER PRIMARY KEY CHECK(id = 1), holder TEXT, epoch
INTEGER, renewed_at INTEGER)`. It is the root's process by default, or `atomic worker controller --db … --token-file …`
for fleets serving many roots. Every `tickMs` (10 000) it computes:

```
demand      = Σ over shared roots (ready + leased) work
quotaCap    = admission.limits.session ? ceil(admission.limits.session / workersPerHost) : ∞
budgetCap   = any root budget-blocked ? (hosts with leases) : ∞
rateCap     = rateLimits set ? ceil(Σ requestsPerMinute / (perWorkerRpmEstimate × workersPerHost)) : ∞  (estimate from the last 10 min of acquires)
target      = clamp(minHosts, maxHosts, min(ceil(demand / workersPerHost), quotaCap, budgetCap, rateCap))
```

- **Scale up** when `ready > scaleUpQueueDepth` for `scaleUpDelayMs` and `target > live + pending`. It calls
  `scaleTo(target)`.
- **Scale in** only hosts with zero leases for `idleDrainMs`. It marks the host `draining` (the host stops claiming),
  waits for its shipping to flush, then calls `drain(id)` and `scaleTo(target)`. Busy hosts are never removed
  (Buildkite's lesson).
- A pending host that does not register within `bootTimeoutMs` is recorded as failed and replaced once. Repeated
  failures back off exponentially, capped at 10 minutes.
- Every decision and every provider error is a row in `<runs>_fleet_events(seq INTEGER PRIMARY KEY, at INTEGER, kind
  TEXT, target INTEGER, live INTEGER, reason TEXT, error TEXT NULL)`, keeping the last 1 000 rows.

### 9.3 Adapters (S6)

All adapters shell out to a CLI the operator already has, through `execFile` with argument arrays (never a shell
string), so they add no runtime dependency and their credentials stay in the provider's own chain:

- **`azure-vmss`**: `az vmss scale --new-capacity`, `az vmss list-instances`, and `az vmss delete-instances
  --instance-ids` after drain. Options: `resourceGroup`, `name`, `subscription?`. Credentials come from `az login`,
  managed identity or `AZURE_*` variables, and the least role is a custom role with
  `Microsoft.Compute/virtualMachineScaleSets/{read,write,delete/action}` and `…/virtualMachines/{read,delete}` on that
  one scale set. A VMSS instance boots the image or the custom data from §6.2.
- **`kubernetes`**: `kubectl scale statefulset/<name> --replicas`, `kubectl get pods -l <selector> -o json`, and for drain,
  `kubectl annotate pod controller.kubernetes.io/pod-deletion-cost=-1000` then scale down by one. Options: `namespace`,
  `statefulSet`, `selector`, `context?`. Least privilege: a Role with `get/list` on pods and `get/patch` on
  `statefulsets/scale` in one namespace.
- **`command`**: `up: string[]` (receives `ATOMIC_TARGET`), `down: string[]` (receives `ATOMIC_PROVIDER_ID`) and
  `list: string[]` (prints a JSON `ProvisionedHost[]`), each with a timeout (default 120 s). This covers anything else.

### 9.4 Conformance suite

`test/helpers/provisioner-conformance.ts` exports `runProvisionerConformance(name, makeProvider, fakeCloud)`. That is
the storage-adapter pattern (`packages/workflows/src/durable/journal/conformance.ts`). It checks that:

- `scaleTo` is idempotent, monotonic toward its target, and survives a target changed mid-call;
- `list` reflects `scaleTo` eventually and reports `pending` before `running`;
- `drain` of an unknown id is a no-op;
- provider errors reject with an `Error` whose cause chain carries the CLI's exit code but **no argument or environment
  value matching a secret pattern**;
- an aborted signal stops the CLI.

Each adapter runs it against a fake CLI on `PATH` (a Node script that keeps a JSON state file). CI makes no cloud
call.

## 10. The resume rule applied

| Failure | Behavior | Never |
| --- | --- | --- |
| Shipping lag | Status `lagging`. Claims pause on that host, children keep running, shipping retries | Fail a child, block a resume, or block the root's control |
| Dead host | Lease expiry, then replay elsewhere (today), from the last shipped checkpoint | Fail the run. Only the per-child three-attempt limit (today) can fail a single child |
| Provisioner error (CLI missing, auth, quota, timeout) | Recorded in `fleet_events`, shown in status, retried with backoff. The fleet keeps its current hosts | Fail or pause a run, or block a resume (resume does not need the provisioner) |
| Controller dies | Lease expires, and the next root process or controller takes over | Leave the fleet at a target forever. Hosts with `idleExitMs` also exit by themselves |
| Token-bucket store outage | Local-fallback bucket (§8) | Hold a model call longer than 1 s waiting for the store |
| Shared store write contention | S0: bounded, jittered retries and a per-process write cap. Calls slow down | Wedge (G1) |
| Local shard failure on a host | That child falls back to sync commits | Fail the child |
| Truly fatal (refused credentials at setup, schema version mismatch, process containment unavailable) | Typed setup error before anything starts (today's `SharedPoolSetupError`) | — |

## 11. Security

- **Cloud credentials never enter the journal.** The root records only `provisioner.kind` and non-secret options
  (resource names). Adapters resolve credentials through the provider's own chain (`az`, `kubectl`, or the command's
  environment) in the controller process. `secrets` values in adapter options must be environment or file references,
  as journal secrets already are, and are refused if passed inline.
- Least-privilege roles per adapter (§9.3). The docs ship the exact role definitions.
- The database token: `atomic worker start --token-file` reads a mode-600 file and never logs, prints or puts it in argv
  of child processes. Worker processes get the journal selection through `ATOMIC_POOL_DURABLE_JOURNAL` (today), which
  carries references, not values.
- Command-adapter commands are argument arrays from settings that only the machine owner writes. They are never
  derived from journal content: a root on a shared database cannot make another machine's controller run a command.
  The controller uses its own local settings and only reads targets from the store.
- Shipped batches are fenced by lease and epoch. A stale or malicious host holding a valid token can still write any
  table (as today), so the token is the trust boundary, and the docs say so.
- Status summaries are capped at 1 KiB and come from the child's declared outputs, never from raw transcripts.

## 12. Slice plan

Each slice is about 100–500 changed lines, mergeable on its own, with default behavior unchanged. **S0 and S1 come
first.** S0 fixes a defect that blocks everything else. S1 gives every later slice a one-command way to stand up
nodes on real VMs.

| ID | Title | Depends on | Parallel group | Objective | Files | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| S0 | Shared-store writes as one-request batches; no wedge | — | A | Confirm the §3.4 inversion with the trace proxy, then: run shared-pool write paths (`commit`, `heartbeat`, `claim`, `complete`, stage inputs, host reports) as single `batch(…, "write")` requests with the decisions moved into SQL guards (or read outside, then a guarded write), with no client round trip inside a lock. Bounded, full-jitter retry on `SQLITE_BUSY`/`TRANSACTION_TIMEOUT` within `lockWaitMs`, a per-process cap of 4 in-flight write requests, and heartbeats on a lane writes cannot starve | `packages/storage-libsql/libsql.js`, `packages/coding-agent/src/core/storage/sqlite-facade.ts`, `packages/workflows/src/durable/journal/sql-pool-queue.ts`, `sql-shared-pool.ts`, `pool-stage-usage.ts` | Red first: `test/integration/workflow-shared-pool-scale.test.ts` runs 8 and 16 hosts × 4 slots against sqld (skipped without `ATOMIC_TEST_LIBSQL_URL`, like `workflow-local-pool-sqld.test.ts`) and must complete with no 15 s write-probe timeout; a unit test with a fake driver asserts each pool write is one request; `research/evidence/elastic-workers/run-local.mjs` before/after commits/s recorded in the PR |
| S1 | `atomic worker start` / `status` and `workflows.workers` settings | — | A | One-command join (§6): CLI over `startWorkflowWorkerHost` with `--db/--token-file/--slots/--label/--prefix/--no-restore/--idle-exit/--json`, SIGTERM drain, exit codes, `idleExitMs` host option, and settings for shared placement in `/workflow run`. Docs: operations guide plus a systemd and container recipe | `packages/coding-agent/src/cli/worker-command.ts` (new), `src/main.ts`, `src/core/settings-schema.ts`, `packages/workflows/src/workers/worker-host.ts`, `worker-host-types.ts`, `packages/coding-agent/docs/workflows/operations.md`, `docs/settings.md` | Unit: argument parsing, slot default, token never in output. Integration: `atomic worker start` against a libSQL `file:` journal serves a shared root; SIGTERM drains a running child to completion (exit 0) |
| S2 | Local ship shard and fenced local commit | S0 | B | Per-root local shard tables (§7.2), lease cache, local commit path behind `checkpointShipping !== "sync"` (validation against local shard), sync fallback on local failure. No shipper yet: in this slice a test-only flag ships synchronously after each local commit, which keeps semantics identical | `packages/workflows/src/workers/ship-shard.ts` (new), `pool-coordinator.ts`, `durable/journal/pool-mutations.ts`, `workers/public-options.ts` | Unit: local commit refuses an expired or stale cached lease; identity conflict; fallback on disk-full fake. Integration: existing `workflow-shared-pool-hosts.test.ts` passes with shipping enabled in synchronous-test mode |
| S3 | Background shipper with content-addressed, fenced batches | S2 | B | Shipper (§7.3): sealing, one-request guarded delivery, `ship_batches`/`ship_watermarks`/`pool_status` tables, retries, fencing of late batches, flush on complete/pause/drain, `maxLagMs` claim gate | `packages/workflows/src/workers/checkpoint-shipper.ts` (new), `durable/journal/sql-shared-pool.ts`, `sql-pool-queue.ts` | Unit: retry of a sealed batch is idempotent (same id, no duplicate events); a batch from a displaced generation is fenced; completion waits for flush; property test over random crash points (seal, deliver, cursor) gives no lost acknowledged-and-shipped event and no duplicate key |
| S4 | Replay from shipped checkpoints, plus the multi-host simulation | S3 | B | Claim-time pull of the child's shipped checkpoints into the local shard; worker catch-up against the local shard; a multi-process scenario with hosts as processes with their own `HOME`, a latency proxy, and SIGKILL of a host mid-batch | `packages/workflows/src/workers/worker-host.ts`, `local-worker.ts`, `test/helpers/pooled-remote-root.ts`, `test/fixtures/shared-pool-*.mjs` | Integration: `workflow-shared-pool-shipping.test.ts`: 4 hosts, kill -9 one, every child completes; replayed steps ≤ `maxBatch` per killed child; no key recorded twice; `PRAGMA integrity_check`. Bench: shipping vs sync at 8/16 hosts in the evidence README |
| S5 | Provisioner interface, policy and controller lease | S1 | C | `WorkerHostProvisioner`, policy computation (§9.2) as a pure function, controller lease and `fleet_events`, wiring in the root (opt-in), `atomic worker controller` | `packages/workflows/src/workers/autoscaler.ts` (new), `fleet-controller.ts` (new), `public-options.ts`, `packages/coding-agent/src/cli/worker-command.ts` | Unit: policy table tests (queue, admission cap, budget block, idle drain never removes a busy host, boot timeout backoff). Integration: a fake in-memory provisioner launching `bench-host`-style processes scales 0 → N → 0 on a fan-out |
| S6 | Adapters: command, Azure VMSS, Kubernetes, with the conformance suite | S5 | C | Three adapters over `execFile`, plus `runProvisionerConformance`, fake CLIs and docs with least-privilege roles | `packages/workflows/src/workers/provisioners/{command,azure-vmss,kubernetes}.ts` (new), `test/helpers/provisioner-conformance.ts`, `test/fixtures/fake-az.mjs`, `fake-kubectl.mjs` | Conformance suite against each adapter with a fake CLI; secret redaction in errors; abort handling. No cloud calls in CI |
| S7 | Fleet token buckets and shared cooldowns | S0 | D | `<runs>_rate_buckets` with GCRA acquire, coordinator prefetch over IPC, 429 cooldown sharing across hosts (`shareCooldowns`), local fallback on store outage | `packages/workflows/src/workers/fleet-rate-limits.ts` (new), `rate-limit-sharing.ts`, `pool-coordinator.ts`, `public-options.ts` | Unit: GCRA math (burst, steady rate, cooldown), fallback after a 1 s timeout. Integration: two hosts with a fake provider that 429s once; both back off until `cooldown_until`; store killed mid-run → local fallback, no call blocked > 1 s |
| S8 | Fleet status in `/workflow status` and `host.stats()` | S1 (S3, S5, S7 fill fields as they land) | D | Extend `SharedPoolStats` with `fleet`: per-host slots, busy, draining, shipping lag and pending, scale events, controller, rate-limit state; status lines; `atomic worker status` | `durable/journal/shared-pool-types.ts`, `sql-shared-pool.ts` (`readSharedPoolStats`), `workers/shared-pool-status-lines.ts`, `worker-host-types.ts`, `packages/coding-agent/docs/workflows/operations.md` | Unit: status lines snapshot for each field present or absent (older hosts); reader tolerates missing columns. Integration: stats of a 2-host shipping pool show lag that drops to 0 after flush |

Parallel groups: **A** (S0, S1) start together. **B** (S2 → S3 → S4) must stack and starts after S0. **C**
(S5 → S6) stacks and starts after S1. **D** (S7, S8) can run in parallel with B and C once their dependencies merge.
With four implementers, A, then B, C and D in parallel, fits about a day of parallel work.

## 13. Test strategy

### 13.1 Unit

Pure policy (autoscaler, GCRA), batch identity, guard SQL against an in-memory SQLite, ship-shard fencing, status
lines, CLI parsing. Everything runs under the `unit` project.

### 13.2 Integration (local multi-process, real libSQL)

Hosts are separate processes with their own `HOME` and agent directory, sharing a libSQL `file:` database (the
existing `workflow-shared-pool-hosts.test.ts` pattern) or, when `ATOMIC_TEST_LIBSQL_URL` names one, a real sqld,
optionally behind `test/helpers/latency-proxy.ts`. Each scenario asserts the distributed-harness invariants:

- no key recorded twice;
- sequences increase and epochs never go back;
- every stale writer gets a typed refusal;
- `integrity_check` is `ok`;
- every child completes after a SIGKILL.

### 13.3 Benchmarks (evidence, not CI)

`research/evidence/elastic-workers/run-local.mjs` and `run-local-journal.mjs` take `--trace` and `--kill-after-ms`.
They are the before/after record for S0, S3 and S4, and for the 8 and 16 host regression case. S0's PR must show
the 8 × 4 and 16 × 4 cases completing with no stall, and the commits/s before and after.

### 13.4 Azure validation (pending re-elevation)

When subscription write access returns (resource group `atomic-elastic-exp-<date>`, tagged `purpose=atomic-4768`,
deleted afterwards), run `research/evidence/elastic-workers/azure/provision.sh` (sqld VM, root VM, N worker VMs from
the §6.2 cloud-init) and:

1. 3 → 10 → 20 hosts × `--slots` default, 500 pooled children with stub stages: checkpoint throughput and latency,
   and queue drain time, sync versus shipping.
2. 8 and 16 hosts × 4 slots, sync, before and after S0 (the wedge regression).
3. `az vm deallocate` of a host mid-run: lease takeover time and replayed steps.
4. Intercom between stages on different hosts, as in the `remote` scenario of `test/fixtures/shared-pool-root.mjs`.
5. A real-model smoke test of a handful of stages with the `github-copilot` credentials. `auth.json` is copied at mode
   600 and removed afterwards.

eastus returned `SkuNotAvailable` for D-series v5/v6 and F-series v2 sizes. v7 sizes (`Standard_D4s_v7`) are
available in eastus2. The test/distributed suite `pool-scale` (#4312) is where these become a standing scenario.

## 14. Open questions

1. Should `checkpointShipping` default to shipping once S4 has been validated on Azure? (This spec keeps `"sync"`.)
2. Should usage billing move into shipping batches to save one write per heartbeat? Today's budget latency then
   becomes `intervalMs` rather than `heartbeatMs`. Not proposed here.
3. The stage-message receipt limit in `docs/workflow-local-workers.md` ("Known limit") is unchanged by shipping. S0's
   one-request guarded writes make it closable with an `EXISTS` guard on the work row in the receipt's own batch, and
   that is a candidate follow-up.
