# Checkpoint shard benchmark (#5321)

Measures the gaps between turns of a pool coordinator's event loop while its file-backed local checkpoint journal (`ShipShard`) works, and the elapsed time of each operation.

```sh
node --import jiti/register scripts/perf/checkpoint-shard/benchmark.ts --rounds 5
bun run scripts/perf/checkpoint-shard/benchmark.ts --rounds 5
```

Options: `--rounds N` (default 5), `--out <file>` (the table as Markdown).

## What it measures

Each round opens a new file-backed shard and runs these cases in order: open, the first `hold` of a lease, 50 single `accept`s of 4 KiB and 50 of 64 KiB (each its own sample), 50 `accept`s of 16 KiB one after another, 16 `accept`s of 16 KiB at once, `seal` of 64 checkpoints, `shipped` for them, `discard`, `fence`, and `close({ retire: true })`.

A `setImmediate` chain records each turn of the event loop.

- **Longest block** is the longest gap between two turns while the case ran. It includes garbage collection and OS scheduling delays, not only SQLite time.
- **Elapsed** is the case's wall time, from the call until its promise settles.
- **Turns** counts the event-loop turns during the case. A value of 1 means the case ran without yielding to another turn.

## Results

Measured on 2026-11-17 with Node 22.23.5 and Bun 1.4.4. Before uses the unchanged `ShipShard` module from `main` at `2670c2abb1`; after is the integrated threaded and rollback-safe implementation at `714c383767`. Both use the same dependencies and benchmark. Each VM ran before, after, then before again, with 5 rounds per run and runtime. The before column is the worst block across both baseline runs; its elapsed p50 is the arithmetic mean of their medians. After uses its single 5-round run.

Windows, Azure Standard_D16ads_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 51.07 | 16.46 | 46.16 | 85.20 |
| hold (first claim) | 12.92 | 0.36 | 2.59 | 2.81 |
| accept, one 4 KiB | 6.63 | 0.68 | 2.61 | 3.37 |
| accept, one 64 KiB | 45.12 | 0.68 | 3.08 | 3.72 |
| accept x50 in sequence, 16 KiB | 197.03 | 0.57 | 139.42 | 179.91 |
| accept x16 at once, 16 KiB | 7.56 | 1.18 | 5.23 | 7.37 |
| seal 64 | 25.94 | 0.62 | 22.52 | 24.38 |
| shipped 64 | 7.50 | 0.12 | 4.52 | 5.11 |
| discard | 4.47 | 0.06 | 2.71 | 2.94 |
| fence | 6.25 | 0.09 | 4.12 | 5.38 |
| close (retire) | 22.54 | 2.09 | 22.09 | 30.95 |

Windows, Azure Standard_D16ads_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 45.82 | 14.65 | 57.52 | 70.67 |
| hold (first claim) | 6.89 | 0.17 | 2.96 | 2.46 |
| accept, one 4 KiB | 21.87 | 5.08 | 2.62 | 1.80 |
| accept, one 64 KiB | 37.47 | 1.44 | 3.04 | 2.28 |
| accept x50 in sequence, 16 KiB | 195.81 | 2.41 | 146.31 | 100.40 |
| accept x16 at once, 16 KiB | 6.42 | 1.65 | 5.11 | 5.43 |
| seal 64 | 27.68 | 0.80 | 21.16 | 24.49 |
| shipped 64 | 7.12 | 1.57 | 4.54 | 4.75 |
| discard | 3.50 | 0.08 | 2.18 | 1.87 |
| fence | 7.45 | 0.68 | 4.59 | 3.89 |
| close (retire) | 21.60 | 13.57 | 31.88 | 34.97 |

Linux, Azure Standard_D16alds_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 4.88 | 3.26 | 2.83 | 28.48 |
| hold (first claim) | 0.38 | 0.33 | 0.17 | 0.40 |
| accept, one 4 KiB | 1.02 | 1.43 | 0.15 | 0.19 |
| accept, one 64 KiB | 2.61 | 1.48 | 0.41 | 0.48 |
| accept x50 in sequence, 16 KiB | 10.52 | 0.55 | 9.06 | 11.56 |
| accept x16 at once, 16 KiB | 2.55 | 0.98 | 1.97 | 3.38 |
| seal 64 | 5.95 | 0.92 | 5.38 | 6.60 |
| shipped 64 | 0.36 | 0.08 | 0.23 | 0.29 |
| discard | 0.12 | 0.05 | 0.07 | 0.08 |
| fence | 1.07 | 0.07 | 0.96 | 1.03 |
| close (retire) | 1.29 | 1.24 | 3.67 | 5.13 |

Linux, Azure Standard_D16alds_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 14.93 | 14.50 | 6.78 | 18.77 |
| hold (first claim) | 0.56 | 0.16 | 0.22 | 0.44 |
| accept, one 4 KiB | 0.56 | 0.22 | 0.12 | 0.18 |
| accept, one 64 KiB | 2.60 | 0.35 | 0.38 | 0.44 |
| accept x50 in sequence, 16 KiB | 9.16 | 0.29 | 7.72 | 10.84 |
| accept x16 at once, 16 KiB | 2.58 | 0.54 | 1.83 | 2.62 |
| seal 64 | 8.52 | 1.90 | 7.88 | 10.20 |
| shipped 64 | 0.39 | 0.10 | 0.23 | 0.29 |
| discard | 0.13 | 0.06 | 0.06 | 0.08 |
| fence | 1.32 | 0.10 | 1.15 | 1.31 |
| close (retire) | 9.24 | 9.78 | 15.21 | 16.61 |

Every SQLite statement on the shard's connection now runs on its worker thread. On Windows, the longest observed checkpoint-write gap fell from 197.03 ms to 1.18 ms under Node, and from 195.81 ms to 5.08 ms under Bun. The sequential 50-checkpoint case fell from 197.03 to 0.57 ms under Node and from 195.81 to 2.41 ms under Bun. A transaction still resolves only after its full-synchronization commit returns.

Opening and retiring a shard also use the journal directory's lock. That lock stays in the in-process adapter, which waits asynchronously, keeps the writers' first-come order across processes, and reports a typed timeout with holder diagnostics. These operations are not entirely off-thread:

- Open still creates directories, takes the root's native lock, and initializes the directory-lock database in process. Windows open had a 16.46 ms worst gap under Node and 14.65 ms under Bun in this run. An earlier threaded-only run observed a 93.37 ms open gap under Node, so these numbers are not latency bounds. Every round creates a new journal directory, so each pays initialization.
- Under Bun, closing the directory lock runs a full garbage collection to release its files. The retiring close had a 13.57 ms worst gap on Windows and 9.78 ms on Linux.

Costs of the change:

- Each statement crosses to the thread and back. On Linux, sequential writes took about 28% longer under Node and 40% longer under Bun; 16 concurrent writes took about 71% and 43% longer. Windows disk timings varied between runs; elapsed medians are shown rather than treating event-loop responsiveness as a throughput gain.
- Opening starts a worker thread. Its elapsed median increased by about 26 ms on Linux Node and 12 ms on Linux Bun. The shard keeps that thread until it closes.
- A previous isolated measurement put an open shard's thread at about 11 MiB of memory under Node and 3.5 MiB under Bun.

## Reproduce the baseline

Create a temporary copy of the baseline module alongside the current one so its relative imports resolve against the same dependencies. Run the same benchmark against that module, then remove the copies:

```sh
git show 2670c2abb1:packages/workflows/src/workers/ship-shard.ts > packages/workflows/src/workers/checkpoint-shard-before.ts
sed 's@workers/ship-shard.js@workers/checkpoint-shard-before.js@' scripts/perf/checkpoint-shard/benchmark.ts > scripts/perf/checkpoint-shard/before.ts
node --import jiti/register scripts/perf/checkpoint-shard/before.ts --rounds 5
bun run scripts/perf/checkpoint-shard/before.ts --rounds 5
rm packages/workflows/src/workers/checkpoint-shard-before.ts scripts/perf/checkpoint-shard/before.ts
```
