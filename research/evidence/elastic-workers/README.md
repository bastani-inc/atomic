# Elastic multi-host workflows: evidence (#4768)

Measurements behind [`specs/2026-11-14-elastic-multi-host-workflows.md`](../../../specs/2026-11-14-elastic-multi-host-workflows.md).

**Where the numbers come from.** Every multi-node number here comes from **local multi-process runs on one 80-core
Azure VM**: each worker host is a separate Node process with its own `HOME` and agent directory, against a real
`sqld` v0.24.33 (the binary the distributed harness pins, cached at
`~/.cache/atomic-distributed-test/sqld/v0.24.33/sqld`). The controller VM was shared with other agent sessions
(one-minute load average 30–58, and 170–210 during the latency sweep), so absolute numbers are noisy. Ratios held
across repeated runs.

**Azure runs are still pending.** Write access to the test subscription expired while
`atomic-elastic-exp-20261114` was being provisioned. That resource group holds only a VNet and an NSG: no VM, NIC,
disk or public IP was created. Before that, eastus refused D-series v5/v6 and F-series v2 sizes with
`SkuNotAvailable`; v7 sizes are offered in eastus2. Spec §13.4 lists the runs still to do. `azure/` holds the
provisioning script and the cloud-init they will use.

## Scripts

| Script | What it measures |
| --- | --- |
| `bench-child.mjs` | A pooled child that commits `steps` checkpoints (no-op `ctx.tool`) and times each one. An optional stub-model stage, or a real model stage (`model: "provider/id"`), runs halfway |
| `bench-root.mjs` | A root that fans out `ELASTIC_CHILDREN` children with `workers: { placement: "shared" }` (or `ELASTIC_LOCAL=1`: this machine's own journal store) |
| `bench-host.mjs` | A worker host: what `atomic worker start --db <url> --token-file <f>` will run. SIGTERM drains |
| `run-shipping.mjs` | Checkpoint shipping against sync commits on Docker sqld or PostgreSQL 16, with an optional host SIGKILL (#4768); `--idle-probe N` adds an idle phase and a claim-latency probe (#5230) |
| `txn-overhead.mjs` | Store CPU of the per-transaction checks, each on its own: PostgreSQL's `SET LOCAL` and schema-version read, sqld's stream probe (#5230) |
| `run-local.mjs` | One sqld and N host processes. Options: `--hosts 1,2,4,8 --slots 4 --children 64 --steps 20 [--latency-ms <one-way>] [--trace 1] [--kill-after-ms <ms>] [--sqld-args "…"] [--run-timeout-ms]`. Prints progress every 10 s and records a stall with a write probe and sqld's slowest queries instead of hanging |
| `run-local-journal.mjs` | The same fan-out on the local journal store with W local workers: the per-host ceiling |
| `trace-proxy.mjs` | HTTP proxy that rebuilds write transactions from Hrana batons: requests per transaction, lock hold, `BEGIN IMMEDIATE` wait |
| `sqld-contention-repro.mjs`, `sqld-contention-multiprocess.sh` | Atomic-free load: interactive multi-request write transactions against one-request write batches |
| `stats.mjs` | Percentiles and throughput |
| `azure/provision.sh`, `azure/cloud-init.yaml` | Azure topology for §13.4 (not yet run) |

Run from the repository root after `npm ci --ignore-scripts && npm run build`.

## Results

| File | Finding |
| --- | --- |
| `results/local-sqld-sweep-default.json` | 1/2/4/8 hosts × 4 slots: 24.1 / 35.5 / 38.9 / 31.6 checkpoints/s; p50 191 / 219 / 342 / 750 ms |
| `results/local-sqld-rtt0-run1.jsonl` | First sweep: the 8 × 4 case **wedged** (25 min with no commit) |
| `results/wedge-8hosts-run1/` | sqld stats from the wedge (`BEGIN IMMEDIATE`/`COMMIT` at 5/10/15/20 s), and a worker that died with `UND_ERR_HEADERS_TIMEOUT` (paths redacted) |
| `results/local-sqld-8hosts-run2.json` | 8 × 4 again: progress then **stall** at 37 of 64 children; a fresh write probe times out |
| `results/local-sqld-8x4-1024conn.json` | sqld limits 128 → 1024: completes, but p99 11.6 s |
| `results/local-sqld-4x8.json`, `results/local-sqld-Nx1.json` | Slots versus hosts: throughput is set by total writers, not by hosts |
| `results/local-journal.json` | Local journal, 4/8/16 workers: 27.1 / 51.8 / 97.9 checkpoints/s at a flat ~150 ms p50 |
| `results/local-sqld-traced.json` | 6–17 HTTP requests per write transaction while holding the lock. At 4 and 8 hosts behind the trace hop: stall, with the lock held for up to 10 s |
| `results/sqld-contention-repro.json` | In-process clients, up to 128: no wedge. Batches outrun interactive transactions 2–3× |
| `results/sqld-contention-multiprocess-local.jsonl` | 40 processes: interactive 35.9 commits/s against batch 223.9 (6.2×) |
| `results/sqld-limiter-inversion.json` | sqld `--max-concurrent-requests 16`: excess requests get `SERVER_ERROR` rather than queueing; no wedge without Atomic's retry pattern |
| `results/nodes-rtt2ms-loaded-host.json` | **Loaded host (load average 170–245).** 3 hosts × 2 slots at about 2 ms RTT: no wedge (the write probe succeeded), 103 of 120 children done in 240 s. The sweep stopped here |

## Checkpoint shipping (#4768, S2–S4)

`run-shipping.mjs` runs each case twice on the same Docker store (`libsql-server:v0.24.33` or `postgres:16`): once with `checkpointShipping: "sync"` and once with shipping. The 16- and 32-host cases run across farm VMs: one VM holds the store, the root and 4 hosts, and the others run 4 hosts each (`--listen` / `--join`).

Earlier runs, before batching (`results/shipping-farm-*.jsonl`, `results/shipping-devbox-*.json`), sent every shipped event as its own fenced insert, with its own read of the root's checkpoints. Those runs showed no store saving. What follows is after the fix.

### Store CPU

Each batch is now one request: its fences are checked once, its events go in with one multi-row insert, it reads the root's checkpoints once, and its first plan needs no read at all.

**Marginal cost per checkpoint** (8 hosts × 4, 64 children; 20 against 60 steps, so per-child costs cancel):

| Store | Sync, ms CPU per checkpoint | Ship, ms CPU per checkpoint | Requests per checkpoint, sync → ship |
| --- | --- | --- | --- |
| PG16 | 4.07 | 0.77 (5.3×) | 5.1 → 0.63 |
| sqld | 12.3 | 2.35 (5.2×) | 5.0 → 0.51 |

**Total store CPU per checkpoint**, which includes every fixed cost. These runs used 256 children × 20 steps, the default `{ intervalMs: 2000, maxBatch: 64, maxLagMs: 30000 }`, and `--profile 1`:

| Store × hosts | Total CPU s, sync → ship | Per checkpoint ms | Checkpoints/s | Step p50 ms | Lag p99 ms (maxLagMs 30 000) |
| --- | --- | --- | --- | --- | --- |
| PG16 × 16 | 74.2 → 55.6 | 14.5 → 10.9 | 31.1 → 39.1 | 39 → 1.3 | 3 043 |
| sqld × 16 | 110 → 46 | 21.6 → 9.1 | 44.2 → 95.5 | 454 → 5.3 | 2 745 |
| sqld × 32 | 123 → 41 | 24.0 → 8.0 | 10.4 → 99.9 | 175 → 7.9 | 1 335 |

The sqld × 32 runs set `--sqld-max-concurrent-requests 1024`. At sqld's default of 128, both modes failed children with 429 and storage-unavailable errors. A few children also failed in the profiled sqld × 32 runs; the unprofiled ones (`results/shipping-v2-multi3-sqld-32-main.jsonl`) had none, so the single trace proxy is the likely cause.

**Where the store's work goes.** These are PG16 × 16 statements per acknowledged checkpoint, sync → ship.

The checkpoint path fell sharply:
- fence checks 9.82 → 2.85 (what remains is mostly claim, complete and renew fences);
- event inserts 1.10 → 0.15;
- checkpoint view reads 1.08 → 0.03;
- operation receipts 1.65 → 0.75;
- usage 2.24 → 0.98;
- the batch ledger adds 0.35.

On sqld, requests per checkpoint fell 14.2 → 8.6.

What remains is fixed overhead that grows with idle workers and time:
- **The idle worker loop.** Each pass reads the control state, catches up on the root's journal and claims, then sleeps 25–50 ms. In the PG ship run that was 12.5k control reads, 12.2k lease reads, 11.1k ready-work scans and 13.5k catch-up reads.
- **Version checks.** Each transaction checks the schema version; per checkpoint, that rose from 9.6 to 12.6.
- **sqld stream probes.** libSQL probes each stream before reusing it (`SELECT 1 FROM sqlite_schema`): 5–10 per checkpoint, the largest single class of requests.

Shipping finishes children sooner, so its workers spend more of the run idle and polling. The PG store burned about 0.4 core in both modes.

**Batches fill completely.** These children finish inside one shipping interval, so each child shipped exactly one batch: 20 events, or 60 at 60 steps.

### Shipping lag and backpressure

- **Backpressure.** Once an attempt's oldest unshipped checkpoint has waited half of `maxLagMs`, its next step waits until everything it holds is shipped, and its host claims nothing new. Hosts ship at least every quarter of `maxLagMs`.
- **The bound at p99.** Under 16- and 32-host load with `maxLagMs` 30 000, lag p99 was 1.3–3.0 s. In the kill runs, with `maxLagMs` 10 000, it was 5.4 s on PG16 and 2.1 s on sqld.
- **The bound at the maximum.** The PG16 kill run's single worst checkpoint waited 11.4 s. Backpressure stops new steps; it cannot make a delivery to a slow store finish sooner.

### Replay after a host dies

These runs had 8 hosts × 4 slots and 128 children × 40 steps, with 250 ms of work per step. The busiest host's whole process tree was SIGKILLed once a quarter of the steps had run. Shipping used `{ intervalMs: 2000, maxBatch: 64, maxLagMs: 10000 }` with an 8 s lease.

| Store | Mode | Children replayed | Steps run again per child | Unshipped on the host at the kill, per attempt |
| --- | --- | --- | --- | --- |
| PG16 | sync | 4 | 1 | — |
| PG16 | ship | 4 | 4 | 4 |
| sqld | sync | 0 | 0 | — |
| sqld | ship | 4 | 8 | 8 |

A replayed child ran again exactly the steps its host held unshipped, never all 40.

### Why the first runs showed 82 s against 2 356 s

- **That pair was a sync collapse.** The early local sqld × 8 pair ran on the 80-core dev box at load average 30. Sync stretched over 220 s instead of about 27 s, with the store contending for its write lock throughout. A rerun shows the native sqld binary and its Docker image cost the same per checkpoint: 22.6 against 20.4 ms in sync.
- **The farm runs had nothing to save yet.** They predate batching, so every shipped event still cost a fenced write and a view read.

## Idle workers wait for wake-ups (#5230)

Before #5230, an idle pooled worker looped on: read pool control, catch up on the root's journal, ask to claim, sleep 25–50 ms (a shared pool's coordinator also paused an empty claim 500 ms). Now an idle worker only asks to claim. Its coordinator registers the claim for wake-ups before it checks the store, and answers an empty claim after a pause that grows from 25–50 ms to 2 s. A `pool_ready` notification, the host's own enqueue or release, an opening gate, or new control ends the pause. A host whose store sends no wake-ups (sqld, SQLite, PostgreSQL through a pooler or while its listener reconnects) reads one ready mark every 250 ms while a worker idles.

### Runs

`run-shipping.mjs --profile 1 --idle-probe 40 --idle-settle-ms 15000`, 256 children × 20 steps, 4 slots per host, across farm VMs (one VM holds the store, the root and 4 hosts; every other VM runs 4 hosts). "before" is `feat/checkpoint-shipping-s4` at `d78fdd7d26` with only these scripts added (`bench/pool-idle-wake-before`, `fda0d9054f`); "after" is `perf/pool-idle-wake` at `14ece7a709`. Later commits change only paused workers and tests. At 16 hosts each pair ran twice, before and after swapped between two VM groups (r2, r3); at 32 hosts once each (r4, r5). Raw results are in `results/idle-wake/`.

- **Fan-out**: the 256 children, as before. CPU per checkpoint and per second stop where the idle phase begins.
- **Idle**: once every child finished, every worker idles for 15 s. Store CPU, requests (sqld trace) and version checks per second are of that window alone.
- **Claim latency**: then the root runs 40 one-step children one at a time, each after a random 0.3–1 s gap, and records how long after its enqueue each started on a worker: claim latency plus the worker's start of the child, by the clocks of the root and the worker's VM.

Discarded: a second 32-host pair (r6, r7). Both builds' runs failed children there on worker startup timeouts and lost sqld connections on the store VM. The PG16 × 32 sync "before" run in the table also failed 141 children on the root's worker startup timeouts, so its figures are not comparable.

| Store × hosts | Mode | Build (run) | Children done | Fan-out CPU ms / checkpoint | Fan-out CPU ms / s | Checkpoints / s | Idle CPU ms / s | Idle requests / s | Idle version checks / s | Claim latency p50 / p99 ms | Version checks / checkpoint | Txn control / checkpoint | Requests / checkpoint | Stream probes / checkpoint |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| PG16 × 16 | ship | before (r2) | 256/256 | 7.69 | 297 | 41.7 | 210 | — | 298 | 93 / 1123 | 8.24 | 39.6 | — | — |
| PG16 × 16 | ship | before (r3) | 256/256 | 11.94 | 396 | 36 | 292 | — | 446 | 93 / 1155 | 13.69 | 74.0 | — | — |
| PG16 × 16 | ship | after (r2) | 256/256 | 9.86 | 293 | 31.6 | 135 | — | 99 | 102 / 284 | 6.91 | 31.1 | — | — |
| PG16 × 16 | ship | after (r3) | 256/256 | 8.06 | 260 | 34.8 | 99 | — | 85 | 79 / 250 | 7.04 | 35.2 | — | — |
| PG16 × 16 | sync | before (r2) | 256/256 | 12.01 | 341 | 30.5 | 243 | — | 350 | 95 / 1113 | 10.23 | 49.6 | — | — |
| PG16 × 16 | sync | before (r3) | 256/256 | 13.38 | 422 | 33.9 | 377 | — | 464 | 119 / 1293 | 9.71 | 45.3 | — | — |
| PG16 × 16 | sync | after (r2) | 256/256 | 11.37 | 365 | 34.5 | 139 | — | 113 | 74 / 235 | 9.03 | 41.9 | — | — |
| PG16 × 16 | sync | after (r3) | 256/256 | 12.7 | 306 | 25.2 | 101 | — | 83 | 80 / 243 | 9.77 | 46.8 | — | — |
| PG16 × 32 | ship | before (r4) | 256/256 | 12.79 | 492 | 40.7 | 435 | — | 632 | 101 / 1183 | 12.09 | 58.7 | — | — |
| PG16 × 32 | ship | after (r5) | 256/256 | 14.35 | 518 | 38.1 | 211 | — | 187 | 102 / 318 | 11.14 | 60.0 | — | — |
| PG16 × 32 | sync | before (r4) | 115/256 | 8.02 | 413 | 26.5 | 835 | — | 899 | — / — | 14.7 | 69.8 | — | — |
| PG16 × 32 | sync | after (r5) | 256/256 | 15.6 | 441 | 29.6 | 288 | — | 269 | 224 / 431 | 13.12 | 59.1 | — | — |
| sqld × 16 | ship | before (r2) | 256/256 | 8.8 | 657 | 101.8 | 392 | 478 | 223 | 317 / 664 | 4.44 | — | 8.6 | 5.17 |
| sqld × 16 | ship | before (r3) | 256/256 | 14.15 | 878 | 72.4 | 610 | 869 | 411 | 280 / 884 | 6.14 | — | 12.3 | 8.0 |
| sqld × 16 | ship | after (r2) | 256/256 | 8.36 | 634 | 92.3 | 183 | 184 | 62 | 232 / 489 | 4.02 | — | 8.04 | 4.53 |
| sqld × 16 | ship | after (r3) | 256/256 | 8.77 | 689 | 104.1 | 197 | 190 | 64 | 216 / 598 | 3.99 | — | 7.98 | 4.47 |
| sqld × 16 | sync | before (r2) | 256/256 | 18.18 | 790 | 48.4 | 374 | 471 | 221 | 263 / 791 | 6.85 | — | 13.78 | 9.0 |
| sqld × 16 | sync | before (r3) | 256/256 | 25.97 | 308 | 12.2 | 630 | 866 | 412 | 283 / 7340 | 9.27 | — | 19.19 | 12.01 |
| sqld × 16 | sync | after (r2) | 256/256 | 19.1 | 576 | 33.3 | 197 | 185 | 62 | 224 / 802 | 6.83 | — | 14.14 | 9.13 |
| sqld × 16 | sync | after (r3) | 256/256 | 20.61 | 850 | 47.5 | 213 | 185 | 63 | 244 / 339 | 6.55 | — | 13.42 | 8.63 |
| sqld × 32 | ship | before (r5) | 256/256 | 9.77 | 762 | 105.5 | 416 | 534 | 244 | 370 / 860 | 4.67 | — | 9.28 | 5.66 |
| sqld × 32 | ship | after (r4) | 256/256 | 12.11 | 733 | 71.1 | 289 | 238 | 81 | 334 / 488 | 4.44 | — | 9.2 | 5.37 |
| sqld × 32 | sync | before (r5) | 256/256 | 22.92 | 861 | 43.2 | 415 | 530 | 243 | 261 / 845 | 7.5 | — | 15.65 | 10.38 |
| sqld × 32 | sync | after (r4) | 256/256 | 19.9 | 870 | 49.1 | 278 | 241 | 83 | 293 / 475 | 6.99 | — | 14.62 | 9.47 |


### What changed

- **Idle store load fell 2–4×.** PG16: 210–377 → 99–139 ms CPU per second at 16 hosts, 435 → 211 at 32. sqld: 374–630 → 183–213 at 16 hosts, 415–416 → 278–289 at 32; requests 471–869 → 184–190 per second at 16 hosts, 530–534 → 238–241 at 32. The `pool_control` reads (about 60–90 per second) and the catch-up reads are gone. Version checks while idle fell 3–4× (PG16 × 32: 632 → 187 per second).
- **Claim latency p99 fell; p50 held.** PG16: p99 1.1–1.3 s → 235–431 ms, p50 74–119 → 74–224 ms (the 224 ms is PG16 × 32 sync, whose "before" run has no probe figures). sqld: p99 664–884 ms (one 7.3 s) → 339–802 ms, p50 261–370 → 216–334 ms. Without notifications, sqld's latency is bounded by the 250 ms ready probe rather than a 500 ms pause.
- **Fan-out costs are within run-to-run noise.** The two 16-host "before" runs of each case differ by up to 50% in CPU per checkpoint; the "after" runs fall inside or below that range, except sqld × 32 ship (single runs: 9.77 → 12.11 ms, 105 → 71 checkpoints per second), which the discarded rerun could not confirm or refute.

### What remains while idle

Idle workers no longer read anything. What the store still serves while every worker idles:
- each idle worker's claim every 2 s, a write whose version fence stays;
- each coordinator's recovery pass every 500 ms (`inspect` of the root's work rows and the admission reconcile), whose reads check the version;
- on sqld, each host's ready mark every 250 ms, which skips the version check: a stale mark can only wake a worker, whose claim checks it.

At sqld × 16, that is about 65 work-row reads, 62 version checks and 16 lease reads per second. Skipping the recovery pass on a satellite whose workers hold nothing would remove most of the rest; that is left for a follow-up.

### Pause, stop and drain

- An idle worker takes no new child once a pause or stop commits: the claim is fenced on pool control in the store.
- On the root's host, control is still pushed to every ready worker, which acknowledges it at once (the integration test bounds the acknowledgement at 500 ms while the worker's claim waits in its coordinator). A worker becoming ready is pushed the committed control.
- A paused worker reads control again and asks for work once per 2 s, so a missed resume push and retirement still reach it.
- A satellite's running attempt hears of a pause from its next heartbeat, as before; a resume notifies `pool_ready` on PostgreSQL.
- A drain answers every waiting claim at once.

### Per-transaction checks

`txn-overhead.mjs --n 20000 --clients 8 --rounds 3` on the dev box (load 20–40), store CPU per one-row read:

| Store | Variant | µs CPU per operation | Added |
| --- | --- | --- | --- |
| PG16 | read in a transaction | 62.5 | — |
| PG16 | + `SET LOCAL` lock and statement timeouts | 65.7 | +3.2 |
| PG16 | + schema-version read | 84.3 | +21.8 |
| PG16 | + both (what a pool transaction sends) | 88.1 | +25.6 |
| sqld | read on a kept stream | 169.6 | — |
| sqld | + `SELECT 1 FROM sqlite_schema LIMIT 0` first, in the same request | 261.2 | +91.6 |

Neither check is cached. The schema-version read is what refuses a journal a later build upgraded, before a pool transaction reads it (#5029, #5219); a per-connection cache would read an upgraded journal with the old schema for as long as the connection lives. The sqld stream probe makes a kept connection reread a schema changed elsewhere (#5151, #5181), and costs no round trip. #5230 instead removes the idle transactions that carried them, and the ready mark skips the version read.

## Still to do

These runs are pending, below load 60 on this VM or on Azure (spec §13.4):

- the latency sweep at 10 and 20 hosts, about 2 and 30 ms RTT:
  `run-local.mjs --hosts 3,10,20 --slots 2 --children 120 --steps 10 --latency-ms 1|15`;
- the kill -9 run: `run-local.mjs --hosts 4 --slots 2 --children 48 --steps 20 --latency-ms 1 --kill-after-ms 15000`;
- 16 hosts × 4 slots;
- cross-host Intercom at scale.

Today's dead-host takeover and cross-host Intercom are covered functionally by
`test/integration/workflow-shared-pool-hosts.test.ts`.
