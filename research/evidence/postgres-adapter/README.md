# PostgreSQL storage adapter: evidence (#4793)

Measurements behind [`specs/2026-11-14-postgres-storage-adapter.md`](../../../specs/2026-11-14-postgres-storage-adapter.md).
Everything here is a throwaway prototype: nothing in `packages/` changed.

**Where the numbers come from.** One 80-core Azure VM shared with other agent sessions (one-minute load average
21–41 while the hot-path runs ran; every run started below 40). Each worker host is a separate Node process.
sqld is v0.24.33 (the binary the distributed harness pins) with `--checkpoint-interval-s 60`, the libsql#2286
workaround. Postgres is 16.16 in Docker (`postgres:16-alpine`, `max_connections=400`, `shared_buffers=1GB`, fsync
and synchronous commit on). Absolute numbers are noisy; the ratios are the finding.

## Scripts

| Script | What it does |
| --- | --- |
| `inventory.mjs` | Counts SQLite-specific constructs per store and file in shipped source, with the Postgres equivalent of each. `--json <file>` writes the raw counts |
| `hotpath.mjs` | The shared pool's hot path (claim, heartbeat, commit, complete, host reports, root lease renewal) as `SqlPoolQueue` runs it, on three backends: `sqlite` (Atomic's libSQL adapter against sqld, interactive transactions as on `main`), `pg-serial` (the same statements rewritten for Postgres, `BEGIN IMMEDIATE` kept as a database-wide `pg_advisory_xact_lock`), and `pg` (the designed port: root lease `FOR SHARE`, work row `FOR UPDATE`, `FOR UPDATE SKIP LOCKED` claim, late `UPDATE … RETURNING` sequence) |
| `hotpath-host.mjs` | One worker host process: `HP_SLOTS` workers claim, commit `HP_STEPS` checkpoints with a 7.5 s heartbeat, and complete |
| `run-hotpath.mjs` | The #4768 harness shape for the hot path: one root (this process), N host processes, `--latency-ms` TCP hop, stall detection with a write probe |

## Commands

```sh
npm ci --ignore-scripts && npm run build          # the libSQL adapter imports the built @bastani/atomic
mkdir -p /fast/tmp/pg-proto && (cd /fast/tmp/pg-proto && npm init -y && npm install --ignore-scripts pg@8)
docker run -d --name pg4793-bench -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench \
  -p 127.0.0.1:55432:5432 --shm-size=1g postgres:16-alpine -c max_connections=400 -c shared_buffers=1GB

node research/evidence/postgres-adapter/inventory.mjs --json research/evidence/postgres-adapter/results/inventory.json
for b in pg pg-serial sqlite; do
  node research/evidence/postgres-adapter/run-hotpath.mjs --backend $b --hosts 8,16,32 --slots 4 --steps 20 \
    --out research/evidence/postgres-adapter/results/hotpath-$b.json
  node research/evidence/postgres-adapter/run-hotpath.mjs --backend $b --hosts 8,16,32 --slots 4 --steps 20 --latency-ms 1 \
    --out research/evidence/postgres-adapter/results/hotpath-$b-rtt2ms.json
done
# The full Atomic path on sqld, same children counts (2 per slot):
ELASTIC_SESSIONS=256 node research/evidence/elastic-workers/run-local.mjs --hosts 8 --slots 4 --children 64 --steps 20 \
  --sqld-args "--checkpoint-interval-s 60" --out research/evidence/postgres-adapter/results/atomic-sqld-8x4.json
docker rm -f pg4793-bench && rm -rf /fast/tmp/pg-proto
```

## Results

| File | Finding |
| --- | --- |
| `results/inventory.json` | Per-file construct counts behind spec §3.1 |
| `results/hotpath-{pg,pg-serial,sqlite}.json` | Loopback, 8/16/32 hosts × 4: `pg` 1 513 / 1 442 / 1 365 cps; `pg-serial` 435 / 388 / 287; sqld 87 / 87 / 73 |
| `results/hotpath-*-rtt2ms.json` | 2 ms RTT: `pg` 331 / 314 / 293 cps; `pg-serial` 42 / 37 / 29; sqld 31 / 30 / 24, with requests failing and attempts fenced at 16 and 32 hosts |
| `results/atomic-sqld-{8,16}x4.json`, `atomic-sqld-32x4-run{1,2}.json` | The full Atomic path on sqld (`main`, S0 not merged): 25.7 / 20.4 / 12.2 cps, p99 1.4 / 3.4 / 8.1 s; 2 children failed at 16 and at 32 hosts with `StorageUnavailableError`, and the first 32-host run's root died with `SQLITE_BUSY`. The 32-host runs push the load to 70–78 themselves |

No run stalled (no fleet-wide gap of 5 s between commits). Every hot-path run kept one event per checkpoint key and a
dense sequence.
