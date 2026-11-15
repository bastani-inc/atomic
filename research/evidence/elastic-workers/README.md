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
| `run-shipping.mjs` | Checkpoint shipping against sync commits on Docker sqld or PostgreSQL 16, with an optional host SIGKILL (#4768) |
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

## Still to do

These runs are pending, below load 60 on this VM or on Azure (spec §13.4):

- the latency sweep at 10 and 20 hosts, about 2 and 30 ms RTT:
  `run-local.mjs --hosts 3,10,20 --slots 2 --children 120 --steps 10 --latency-ms 1|15`;
- the kill -9 run: `run-local.mjs --hosts 4 --slots 2 --children 48 --steps 20 --latency-ms 1 --kill-after-ms 15000`;
- 16 hosts × 4 slots;
- cross-host Intercom at scale.

Today's dead-host takeover and cross-host Intercom are covered functionally by
`test/integration/workflow-shared-pool-hosts.test.ts`.
