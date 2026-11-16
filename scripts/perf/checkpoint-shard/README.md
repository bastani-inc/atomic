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

Before is `main` at d0aadb5577, measured twice on the same VM, once before and once after this change, with the same benchmark file. The longest block is the worst over 5 rounds. Elapsed p50 is the median, with the two before runs averaged. Node 22.23.5 and Bun 1.4.4, 2026-11-16.

Windows, Azure Standard_D16ads_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 30.1 | 2.3 | 36.27 | 91.17 |
| hold (first claim) | 3.9 | 0.1 | 2.21 | 1.99 |
| accept, one 4 KiB | 10.2 | 0.6 | 1.92 | 1.96 |
| accept, one 64 KiB | 17.1 | 0.6 | 2.53 | 2.64 |
| accept x50 in sequence, 16 KiB | 183.0 | 0.4 | 102.34 | 101.02 |
| accept x16 at once, 16 KiB | 7.6 | 1.2 | 4.74 | 5.95 |
| seal 64 | 46.5 | 0.6 | 19.70 | 21.14 |
| shipped 64 | 6.1 | 0.2 | 3.57 | 3.81 |
| discard | 3.9 | 0.1 | 1.66 | 1.72 |
| fence | 4.6 | 0.1 | 3.77 | 3.73 |
| close (retire) | 19.6 | 0.8 | 18.65 | 48.12 |

Windows, Azure Standard_D16ads_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 31.6 | 2.8 | 42.39 | 66.27 |
| hold (first claim) | 7.4 | 0.1 | 2.69 | 2.45 |
| accept, one 4 KiB | 18.7 | 4.7 | 1.98 | 2.14 |
| accept, one 64 KiB | 16.4 | 3.0 | 2.47 | 2.66 |
| accept x50 in sequence, 16 KiB | 212.0 | 2.8 | 111.19 | 112.74 |
| accept x16 at once, 16 KiB | 7.6 | 0.6 | 4.99 | 4.88 |
| seal 64 | 29.1 | 1.6 | 21.25 | 22.44 |
| shipped 64 | 23.9 | 0.5 | 5.21 | 4.21 |
| discard | 8.7 | 0.1 | 1.91 | 2.44 |
| fence | 13.2 | 0.1 | 4.29 | 3.97 |
| close (retire) | 24.1 | 1.8 | 32.53 | 38.93 |

Linux, Azure Standard_D16alds_v6, Node:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 10.3 | 3.2 | 2.74 | 52.76 |
| hold (first claim) | 0.4 | 0.1 | 0.14 | 0.32 |
| accept, one 4 KiB | 0.6 | 0.9 | 0.15 | 0.18 |
| accept, one 64 KiB | 2.7 | 1.0 | 0.42 | 0.48 |
| accept x50 in sequence, 16 KiB | 12.1 | 0.6 | 9.14 | 11.86 |
| accept x16 at once, 16 KiB | 2.6 | 1.0 | 2.00 | 2.86 |
| seal 64 | 8.4 | 0.7 | 5.03 | 6.98 |
| shipped 64 | 0.5 | 0.1 | 0.23 | 0.28 |
| discard | 0.1 | 0.0 | 0.05 | 0.09 |
| fence | 1.1 | 0.1 | 0.92 | 1.03 |
| close (retire) | 1.0 | 0.8 | 3.01 | 31.05 |

Linux, Azure Standard_D16alds_v6, Bun:

| case | longest block before (ms) | longest block after (ms) | elapsed p50 before (ms) | elapsed p50 after (ms) |
|---|---:|---:|---:|---:|
| open | 13.6 | 2.5 | 5.83 | 25.24 |
| hold (first claim) | 0.5 | 0.1 | 0.21 | 0.28 |
| accept, one 4 KiB | 0.5 | 0.2 | 0.11 | 0.16 |
| accept, one 64 KiB | 2.4 | 3.1 | 0.38 | 0.37 |
| accept x50 in sequence, 16 KiB | 10.1 | 1.5 | 7.74 | 10.87 |
| accept x16 at once, 16 KiB | 3.1 | 0.8 | 1.88 | 2.16 |
| seal 64 | 8.7 | 1.5 | 7.73 | 9.12 |
| shipped 64 | 0.4 | 0.1 | 0.23 | 0.32 |
| discard | 0.1 | 0.1 | 0.10 | 0.09 |
| fence | 1.4 | 0.1 | 1.17 | 1.33 |
| close (retire) | 8.4 | 0.5 | 14.82 | 22.15 |

Every SQLite statement of a shard now runs on a thread of its own, and so does the journal directory's lock while a shard opens or retires. The event loop only sends each statement and receives its result. What remains of the longest block after the change is work on the event loop itself, such as receiving results and garbage collection; no SQLite statement runs there.

Costs of the change:

- Each statement crosses to the thread and back. On Linux, where a synced commit takes well under a millisecond, single operations take up to 0.2 ms longer, 16 concurrent checkpoints 15 to 45% longer, and sealing 64 checkpoints of 16 KiB, whose rows cross back to the event loop, 20 to 40% longer. On Windows, where syncing to disk dominates, operations take about as long as before; 16 concurrent checkpoints under Node take 25% longer.
- Opening a shard starts two threads, the lock's and the shard's, and retiring one starts the lock's: about 25 ms each under Node and 5 to 12 ms under Bun.
- A shard's thread uses about 11 MiB of memory under Node and 3.5 MiB under Bun while the shard is open.
