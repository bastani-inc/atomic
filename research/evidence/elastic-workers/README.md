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

`run-shipping.mjs` runs each case twice, once with `checkpointShipping: "sync"` and once with `{ intervalMs: 2000, maxBatch: 64, maxLagMs: 30000 }`. Both runs use the same Docker store (`libsql-server:v0.24.33` or `postgres:16`). A case is 256 children × 20 no-op `ctx.tool` steps on N hosts × 4 slots. The kill case is 128 children × 40 steps, with one host SIGKILLed 20 s in and an 8 s lease.

| Store | Hosts | Mode | Journal checkpoints/s | Step p50 / p99 ms | Store CPU s | Ship lag p50 / p99 / max ms |
| --- | --- | --- | --- | --- | --- | --- |
| sqld | 8 (farm) | sync | 60.4 | 359 / 948 | 91 | 160 / 679 / 1 986 |
| sqld | 8 (farm) | ship | 81.7 | 53 / 472 | 88 | 3 438 / 6 586 / 9 535 |
| sqld | 16 | sync | 88.4 | 418 / 1 030 | 148 | 195 / 841 / 1 953 |
| sqld | 16 | ship | 134.4 | 38 / 441 | 132 | 2 943 / 8 908 / 9 403 |
| sqld | 32 | sync | 86.0 | 484 / 1 436 | 154 | 203 / 1 051 / 2 686 |
| sqld | 32 | ship | 107.0 | 17 / 516 | 185 | 2 612 / 6 924 / 9 377 |
| PG16 | 8 (farm) | sync | 28.5 | 44 / 3 491 | 51 | 29 / 2 124 / 3 811 |
| PG16 | 8 (farm) | ship | 38.7 | 12 / 3 005 | 46 | 2 397 / 16 196 / 45 032 |
| PG16 | 16 | sync | 38.5 | 17 / 3 383 | 55 | 13 / 2 171 / 4 339 |
| PG16 | 16 | ship | 46.8 | 10 / 1 088 | 55 | 2 069 / 7 817 / 28 378 |
| PG16 | 32 | sync | 34.8 | 17 / 3 079 | 103 | 13 / 1 172 / 2 899 |
| PG16 | 32 | ship | 41.2 | 10 / 1 648 | 100 | 2 074 / 6 419 / 41 614 |

Kill case, steps run again after one host's death:

| Store | Mode | Steps run again | Children replayed | Per child |
| --- | --- | --- | --- | --- |
| sqld | sync | 0 | 0 | — |
| sqld | ship | 405 | 11 | 40 (all) |
| PG16 | sync | 0 | 0 | — |
| PG16 | ship | 280 | 7 | 40 (all) |

Where the runs happened:

- **Farm runs** are marked "farm": one Linux VM slot (D16) each.
- **16 and 32 hosts ran on the 80-core dev box**, at load average 15–40. A farm slot's memory cgroup OOM-kills that many host processes.
- **Raw data:** `results/shipping-farm-*.jsonl` and `results/shipping-devbox-*.json`.

What this shows:

- **Steps are acknowledged 4–28× faster at p50**, and the root's journal records 20–55% more checkpoints per second. Every child completed in every run.
- **The shared store's CPU barely changes.** Each shipped checkpoint is still its own event row under the commit's fences; only the round trips per step go away.
- **The ship lag can exceed `maxLagMs`** (28–45 s maximum on PostgreSQL). `maxLagMs` stops a lagging host from claiming and acknowledging more, but it does not bound how long a delivery takes when the store is slow.
- **Replay after a host's death is at-least-once for the unshipped window.** These children finish in about 2 s, faster than the ship lag, so a killed host's children ran every step again.
- **Claim-time pull (spec §7.5) would not change this.** The replay cost comes from checkpoints that never reached the shared journal, not from catch-up. Shipping pays off when steps are slow, such as model and tool calls, compared with `intervalMs`.

## Still to do

These runs are pending, below load 60 on this VM or on Azure (spec §13.4):

- the latency sweep at 10 and 20 hosts, about 2 and 30 ms RTT:
  `run-local.mjs --hosts 3,10,20 --slots 2 --children 120 --steps 10 --latency-ms 1|15`;
- the kill -9 run: `run-local.mjs --hosts 4 --slots 2 --children 48 --steps 20 --latency-ms 1 --kill-after-ms 15000`;
- 16 hosts × 4 slots;
- cross-host Intercom at scale.

Today's dead-host takeover and cross-host Intercom are covered functionally by
`test/integration/workflow-shared-pool-hosts.test.ts`.
