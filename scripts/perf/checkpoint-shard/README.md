# Checkpoint shard benchmark (#5321)

Measures how long a pool coordinator's event loop stops while its local checkpoint journal (`ShipShard`) works, and how long each operation takes.

```sh
node --import jiti/register scripts/perf/checkpoint-shard/benchmark.ts --rounds 5
bun run scripts/perf/checkpoint-shard/benchmark.ts --rounds 5
```

Options: `--rounds N` (default 5), `--out <file>` (the table as Markdown).

## What it measures

Each round opens a new file-backed shard and runs every case once, in order: open, the first `hold` of a lease, 50 single `accept`s of 4 KiB and 50 of 64 KiB (each its own sample), 50 `accept`s of 16 KiB one after another, 16 `accept`s of 16 KiB at once, `seal` of 64 checkpoints, `shipped` for them, `discard`, `fence`, and `close({ retire: true })`.

A `setImmediate` chain runs for the whole benchmark and records each turn of the event loop.

- **Longest block**: the longest gap between two turns while the case ran, the longest time nothing else on the event loop could run.
- **Elapsed**: the case's own wall time, from the call until its promise settles.
- **Turns**: how many turns the event loop took during the case. 1 means the case held the loop from start to end.

## Results

Before is `main` at d0aadb5577, measured twice on the same VM, once before and once after this change, with the same benchmark file. The longest block is the worst over 5 rounds. Elapsed p50 is the median, with the two before runs averaged. Node 22.23.5 and Bun 1.4.4, 2026-11-17.

Windows, Azure Standard_D16ads_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 43.0 | 15.0 | 40.34 | 68.84 |
| hold (first claim) | 5.1 | 0.2 | 2.43 | 2.14 |
| accept, one 4 KiB | 30.1 | 0.9 | 2.23 | 2.15 |
| accept, one 64 KiB | 40.3 | 0.6 | 2.88 | 2.75 |
| accept x50 in sequence, 16 KiB | 227.9 | 0.5 | 121.96 | 117.80 |
| accept x16 at once, 16 KiB | 11.2 | 0.8 | 5.23 | 5.77 |
| seal 64 | 30.9 | 0.7 | 24.44 | 25.30 |
| shipped 64 | 7.5 | 0.2 | 4.45 | 4.80 |
| discard | 6.0 | 0.1 | 2.28 | 2.09 |
| fence | 6.9 | 0.7 | 4.98 | 3.93 |
| close (retire) | 39.7 | 1.6 | 20.69 | 23.63 |

Windows, Azure Standard_D16ads_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 28.9 | 22.7 | 47.20 | 64.16 |
| hold (first claim) | 4.8 | 0.3 | 2.71 | 2.34 |
| accept, one 4 KiB | 14.8 | 7.7 | 2.21 | 2.20 |
| accept, one 64 KiB | 41.5 | 1.8 | 2.73 | 2.86 |
| accept x50 in sequence, 16 KiB | 135.8 | 2.2 | 119.42 | 124.42 |
| accept x16 at once, 16 KiB | 9.0 | 0.6 | 5.85 | 5.33 |
| seal 64 | 26.4 | 0.7 | 21.32 | 22.91 |
| shipped 64 | 28.9 | 0.7 | 5.26 | 5.10 |
| discard | 6.1 | 0.1 | 2.09 | 2.06 |
| fence | 10.1 | 0.1 | 4.30 | 3.94 |
| close (retire) | 31.3 | 12.4 | 32.52 | 33.47 |

Linux, Azure Standard_D16alds_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 10.5 | 3.3 | 2.30 | 27.55 |
| hold (first claim) | 0.4 | 0.2 | 0.15 | 0.32 |
| accept, one 4 KiB | 0.6 | 1.4 | 0.15 | 0.19 |
| accept, one 64 KiB | 3.3 | 1.6 | 0.42 | 0.50 |
| accept x50 in sequence, 16 KiB | 13.0 | 0.9 | 9.48 | 11.90 |
| accept x16 at once, 16 KiB | 2.6 | 2.9 | 2.10 | 3.35 |
| seal 64 | 8.1 | 0.7 | 5.59 | 7.10 |
| shipped 64 | 0.5 | 0.1 | 0.26 | 0.30 |
| discard | 0.1 | 0.1 | 0.07 | 0.09 |
| fence | 1.2 | 0.1 | 1.01 | 1.08 |
| close (retire) | 1.1 | 1.2 | 3.34 | 5.15 |

Linux, Azure Standard_D16alds_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 16.8 | 16.0 | 7.25 | 20.04 |
| hold (first claim) | 0.6 | 0.3 | 0.26 | 0.44 |
| accept, one 4 KiB | 0.6 | 0.2 | 0.12 | 0.18 |
| accept, one 64 KiB | 2.5 | 0.3 | 0.39 | 0.47 |
| accept x50 in sequence, 16 KiB | 10.4 | 0.2 | 8.05 | 11.94 |
| accept x16 at once, 16 KiB | 3.1 | 1.6 | 1.96 | 2.39 |
| seal 64 | 9.1 | 2.0 | 8.45 | 11.17 |
| shipped 64 | 1.7 | 0.2 | 0.30 | 0.36 |
| discard | 0.1 | 0.1 | 0.09 | 0.10 |
| fence | 1.4 | 0.1 | 1.27 | 1.34 |
| close (retire) | 9.4 | 24.5 | 16.81 | 19.94 |

Every SQLite statement of a shard now runs on a thread of its own: the event loop only sends each statement and receives its result. What remains of a write's longest block is work on the event loop itself, such as receiving results and garbage collection.

The journal directory's lock, taken while a shard opens or retires, stays on the event loop, in the in-process adapter: it waits for the lock without blocking the loop, keeps the writers' first-come order across processes, and names the holder when it gives up. Its transaction writes nothing, so it blocks the loop for about a millisecond, except in two cases these tables show:

- The first open in a journal directory creates the lock file and switches it to write-ahead logging: 12 to 23 ms on Windows. Every round here opens a new journal directory, so every round pays it. A coordinator pays it once per journal.
- Under Bun, closing the lock runs a full garbage collection so Windows lets go of the file: 10 to 25 ms in this process.

Costs of the change:

- Each statement crosses to the thread and back. On Linux, where a synced commit takes well under a millisecond, single operations take up to 0.2 ms longer, 16 concurrent checkpoints 20 to 60% longer, and 50 checkpoints in a row or sealing 64 of 16 KiB, whose rows cross back to the event loop, 25 to 50% longer. On Windows, where syncing to disk dominates, operations take about as long as before.
- Opening a shard starts its thread: 25 to 30 ms more under Node and 13 to 17 ms more under Bun.
- A shard's thread uses about 11 MiB of memory under Node and 3.5 MiB under Bun while the shard is open.
