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

Measured on 2026-11-17 with Node 22.23.5 and Bun 1.4.4. Before uses the unchanged `ShipShard` module from `main` at `2670c2abb1`; after is `2e9d1fdc0c`. Both use the same dependencies and benchmark. Each VM ran before, after, then before again, with 5 rounds per run and runtime. The before column is the worst block across both baseline runs; its elapsed p50 is the arithmetic mean of their medians. After uses its single 5-round run.

Windows, Azure Standard_D16ads_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 28.11 | 93.37 | 57.33 | 93.26 |
| hold (first claim) | 4.91 | 0.21 | 3.36 | 3.60 |
| accept, one 4 KiB | 91.19 | 0.62 | 3.02 | 2.87 |
| accept, one 64 KiB | 24.80 | 0.69 | 3.52 | 3.38 |
| accept x50 in sequence, 16 KiB | 252.17 | 0.53 | 187.39 | 170.20 |
| accept x16 at once, 16 KiB | 9.89 | 0.96 | 6.75 | 7.70 |
| seal 64 | 56.80 | 0.73 | 27.95 | 26.94 |
| shipped 64 | 9.58 | 0.14 | 6.38 | 6.52 |
| discard | 7.38 | 0.07 | 2.75 | 2.69 |
| fence | 8.26 | 0.09 | 5.33 | 5.03 |
| close (retire) | 28.92 | 1.66 | 26.14 | 24.43 |

Windows, Azure Standard_D16ads_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 58.58 | 18.01 | 54.00 | 68.69 |
| hold (first claim) | 5.35 | 0.30 | 2.59 | 3.71 |
| accept, one 4 KiB | 31.29 | 5.20 | 2.17 | 2.70 |
| accept, one 64 KiB | 205.54 | 1.80 | 2.84 | 3.03 |
| accept x50 in sequence, 16 KiB | 227.04 | 3.21 | 117.75 | 139.40 |
| accept x16 at once, 16 KiB | 13.82 | 0.53 | 5.27 | 6.02 |
| seal 64 | 45.60 | 1.25 | 22.31 | 25.93 |
| shipped 64 | 8.23 | 0.20 | 4.58 | 5.25 |
| discard | 2.35 | 0.07 | 1.99 | 2.67 |
| fence | 6.17 | 0.11 | 4.30 | 4.91 |
| close (retire) | 22.03 | 11.28 | 32.05 | 35.51 |

Linux, Azure Standard_D16als_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 5.22 | 3.30 | 2.83 | 27.24 |
| hold (first claim) | 0.42 | 0.17 | 0.15 | 0.35 |
| accept, one 4 KiB | 0.53 | 1.27 | 0.15 | 0.19 |
| accept, one 64 KiB | 3.91 | 2.71 | 0.42 | 0.49 |
| accept x50 in sequence, 16 KiB | 12.84 | 0.59 | 9.25 | 11.49 |
| accept x16 at once, 16 KiB | 2.72 | 0.99 | 2.05 | 3.37 |
| seal 64 | 8.14 | 0.97 | 5.30 | 6.91 |
| shipped 64 | 0.46 | 0.09 | 0.24 | 0.35 |
| discard | 0.12 | 0.05 | 0.07 | 0.09 |
| fence | 1.23 | 0.07 | 1.02 | 1.06 |
| close (retire) | 0.97 | 1.22 | 3.52 | 5.23 |

Linux, Azure Standard_D16als_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 15.58 | 14.14 | 6.37 | 18.64 |
| hold (first claim) | 0.55 | 0.28 | 0.27 | 0.36 |
| accept, one 4 KiB | 0.62 | 0.23 | 0.12 | 0.17 |
| accept, one 64 KiB | 2.67 | 0.25 | 0.38 | 0.43 |
| accept x50 in sequence, 16 KiB | 9.57 | 0.18 | 7.82 | 11.38 |
| accept x16 at once, 16 KiB | 2.56 | 0.67 | 1.86 | 2.80 |
| seal 64 | 8.49 | 2.06 | 7.87 | 10.50 |
| shipped 64 | 0.45 | 0.11 | 0.26 | 0.33 |
| discard | 0.11 | 0.07 | 0.07 | 0.09 |
| fence | 1.49 | 0.08 | 1.19 | 1.29 |
| close (retire) | 8.97 | 9.69 | 15.80 | 17.38 |

Every SQLite statement on the shard's connection now runs on its worker thread. On Windows, the longest observed checkpoint-write gap fell from 252.17 ms to 0.96 ms under Node, and from 227.04 ms to 5.20 ms under Bun. The sequential 50-checkpoint case fell from 252.17 to 0.53 ms under Node and from 227.04 to 3.21 ms under Bun. A transaction still resolves only after its full-synchronization commit returns.

Opening and retiring a shard also use the journal directory's lock. That lock stays in the in-process adapter, which waits asynchronously, keeps the writers' first-come order across processes, and reports a typed timeout with holder diagnostics. These operations are not entirely off-thread:

- Open still creates directories, takes the root's native lock, and initializes the directory-lock database in process. Windows open had a 93.37 ms worst gap under Node and 18.01 ms under Bun. Every round creates a new journal directory, so each pays initialization.
- Under Bun, closing the directory lock runs a full garbage collection to release its files. The retiring close had an 11.28 ms worst gap on Windows and 9.69 ms on Linux.

Costs of the change:

- Each statement crosses to the thread and back. On Linux, sequential writes took about 24% longer under Node and 45% longer under Bun; 16 concurrent writes took about 64% and 51% longer. Windows disk timings varied between the two baseline runs; elapsed medians are shown rather than treating event-loop responsiveness as a throughput gain.
- Opening starts a worker thread. Its elapsed median increased by about 24 ms on Linux Node and 12 ms on Linux Bun. The shard keeps that thread until it closes.
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
