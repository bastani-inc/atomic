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

`run-shipping.mjs` runs each case twice on the same Docker store (`libsql-server:v0.24.33` or `postgres:16`): once with `checkpointShipping: "sync"`, and once with shipping on. The 16- and 32-host cases run across farm VMs. One VM holds the store, the root and 4 hosts; each other VM runs 4 hosts (`--listen` / `--join`). Unless noted, the settings are 256 children × 20 no-op steps with `{ intervalMs: 2000, maxBatch: 64, maxLagMs: 30000 }`.

Earlier runs, before batching, are kept as history: `results/shipping-farm-*.jsonl` and `results/shipping-devbox-*.json`. In those, each shipped event was its own fenced insert with its own read of the root's checkpoints, and the store saved nothing.

### Store CPU

Each batch is now one request:
- its fences are checked once;
- its events go in with one multi-row insert;
- it reads the root's checkpoints once, and its first plan reads nothing.

**The checkpoint path costs about 5× less.** This is the marginal cost per checkpoint at 8 hosts × 4 slots, comparing 20 with 60 steps per child (`results/shipping-v2-marginal-*`):

| Store | Sync, ms CPU per checkpoint | Ship, ms CPU per checkpoint | Requests per checkpoint |
| --- | --- | --- | --- |
| PG16 | 4.07 | 0.77 (5.3× less) | 5.1 → 0.63 |
| sqld | 12.3 | 2.35 (5.2× less) | 5.0 → 0.51 |

**Total store CPU falls less.** Per checkpoint it is 1.3× lower on PG16 × 16, 2.4× on sqld × 16 and 3.0× on sqld × 32. This counts all of the store's CPU, fixed costs included, from the profiled runs in `results/shipping-v2-multi4-*`:

| Store × hosts | Total CPU s | ms per checkpoint | Checkpoints/s | Step p50 ms |
| --- | --- | --- | --- | --- |
| PG16 × 16 | 74.2 → 55.6 | 14.5 → 10.9 (1.3×) | 31.1 → 39.1 | 39 → 1.3 |
| sqld × 16 | 110 → 46 | 21.6 → 9.1 (2.4×) | 44.2 → 95.5 | 454 → 5.3 |
| sqld × 32 | 123 → 41 | 24.0 → 8.0 (3.0×) | 10.4 → 99.9 | 175 → 7.9 |

Unprofiled reruns at 16 hosts on the final code (`results/shipping-v3-*-main.jsonl`) agree. PG16: 12.6 → 8.2 ms per checkpoint, 27 → 40 checkpoints/s. sqld: 14.4 → 6.7 ms, 61 → 123 checkpoints/s.

The 32-host sqld runs set `--sqld-max-concurrent-requests 1024`. At sqld's default of 128 concurrent requests, both modes failed children with 429 and storage-unavailable errors.

**Why the total falls less than the checkpoint path.** On PG16 × 16, these are statements per acknowledged checkpoint, sync → ship:

- **The checkpoint path:**
  - fence checks 9.8 → 2.9 (what remains is mostly claim, complete and renew fences);
  - event inserts 1.1 → 0.15;
  - checkpoint view reads 1.1 → 0.03;
  - operation receipts 1.7 → 0.75;
  - usage 2.2 → 1.0.
- **Fixed costs that shipping does not touch.** They grow with idle workers and with time:
  - **The idle worker loop:** each pass reads the control state, catches up with the root's journal and claims, then sleeps 25–50 ms. In the PG ship run that was 12.5k control reads, 12.2k lease reads, 11.1k ready-work scans and 13.5k catch-up reads.
  - **Per-transaction version checks:** 9.6 → 12.6 per checkpoint.
  - **libSQL stream probes** (`SELECT 1 FROM sqlite_schema`) on sqld: 5–10 per checkpoint, the largest class of requests.

Shipping finishes children sooner, so its workers spend more of the run idle. The PG store burned about 0.4 core in both modes. #5230 tracks cutting those fixed costs.

**Batches fill completely.** These children finish within one interval, so each child shipped exactly one batch of 20 events.

### Shipping lag

**How shipping is held to `maxLagMs`:**
- Once an attempt's oldest unshipped checkpoint has waited half of `maxLagMs`, its next step waits until everything it holds is shipped, and its host claims nothing new.
- Hosts ship at least every quarter of `maxLagMs`.
- Deliveries go oldest checkpoint first, at most 2 at a time.

**Under 16-host load** (`maxLagMs` 30 000), lag never reached `maxLagMs`:

| Store | Lag p99 | Lag maximum |
| --- | --- | --- |
| PG16 | 3.0–7.7 s | 11.3 s |
| sqld | 1.4–2.7 s | 4.2 s |

**In the kill runs** (`maxLagMs` 10 000, final code, `results/shipping-v4-kill-pg-*`), PG16 lag p99 was 3.9–5.0 s and the maximum was 6.2–9.1 s across 4 runs. On sqld (`results/shipping-v3-kill-sqld-*`), p99 was 2.2 s and the maximum 4.4–5.5 s.

**How the maximum was found over the bound.** An earlier PG kill run recorded a maximum of 11.4 s, then 10.9 s. These were live hosts' checkpoints, never the killed host's. A killed host's unshipped checkpoints are never recorded: their steps run again elsewhere with new completion times, so the lag metric has nothing of theirs to exclude. Two causes, both fixed:
- **A tracking bug.** A flush that read the local journal's count while a commit accepted a checkpoint cleared the attempt's in-memory list. That attempt then went unshipped, and was not held back, until its child ended.
- **Delivery order.** On a busy store, a host's deliveries are slower than its interval, and they went out in the order the host took its attempts up.

The bound still depends on the store answering a delivery within the remaining half of the window. A store that stalls longer can hold a checkpoint past `maxLagMs`, though no new step is acknowledged meanwhile.

### Replay after a host dies

The kill runs used 8 hosts × 4 slots, 128 children × 40 steps of 250 ms, and an 8 s lease. The busiest host's whole process tree was SIGKILLed once a quarter of the steps had run.

| Store | Mode | Steps run again per replayed child | Unshipped on the host at the kill |
| --- | --- | --- | --- |
| PG16 (6 runs) | ship | 2–16 | the same count, run by run |
| sqld (4 runs) | ship | 4–8 | the same count, run by run |
| both | sync | 0–1 | — |

In every run, a replayed child ran exactly the steps its host held unshipped, never all 40.

### Why the first runs showed 82 s against 2 356 s

The early local sqld × 8 pair ran on the 80-core dev box at load average 30. The sync run collapsed under write-lock contention: it took 220 s instead of about 27 s. A rerun shows the native sqld binary and its Docker image cost the same per checkpoint (22.6 against 20.4 ms in sync). The farm runs after it predate batching.

## Still to do

These runs are pending, below load 60 on this VM or on Azure (spec §13.4):

- the latency sweep at 10 and 20 hosts, about 2 and 30 ms RTT:
  `run-local.mjs --hosts 3,10,20 --slots 2 --children 120 --steps 10 --latency-ms 1|15`;
- the kill -9 run: `run-local.mjs --hosts 4 --slots 2 --children 48 --steps 20 --latency-ms 1 --kill-after-ms 15000`;
- 16 hosts × 4 slots;
- cross-host Intercom at scale.

Today's dead-host takeover and cross-host Intercom are covered functionally by
`test/integration/workflow-shared-pool-hosts.test.ts`.
