# Writers'-queue benchmark (#4316)

Measures how busy a SQLite database's write lock stays when writers in several processes share it, and how long their transactions wait for it. It compares the node-sqlite adapter before #4316 (`baseline`, revision 77746f5, copied out of git) with this checkout's adapter at several `groupCommitHoldMs` budgets (`current@<ms>`).

```sh
bun run scripts/perf/writer-queue/benchmark.ts --repeats 3 --out /tmp/writer-queue.json
```

Options: `--scenarios` (comma-separated, default all), `--holds 25,50,100,200,400`, `--warmup 1000`, `--measure 8000` (ms), `--baseline <revision>`, `--runtime node|bun` (the writers' runtime; the default is Node, which npm installs run), `--out <file>` (all samples as JSON).

## What it measures

Each run starts the writer processes on a fresh database (WAL, `synchronous=FULL`, as the adapter opens it), waits until all are ready, then starts them at one wall-clock instant. Each writer runs `lanes` concurrent transaction loops; a transaction inserts one row and keeps the lock for `busyMs` of CPU work; a lane then thinks for about `thinkMs`. The first second is warm-up; the next 8 seconds are measured.

- **Lock utilization**: the sum over writers of the time each held the lock, from its successful `BEGIN IMMEDIATE` to its COMMIT or ROLLBACK, clipped to the measured window, divided by the window. It is measured inside each writer on its own connection, the same way for both adapters. Failed `BEGIN` attempts never count.
- **Wait**: from a transaction's `transaction()` call to its callback starting. With one transaction in flight per process (`serial-30`) this is the wait of each ticket in the writers' queue; with several in flight it includes waiting behind the same process's earlier batch.
- **Transactions/commit**: how many transactions each commit carried (group commit).
- **Per group**: transactions/s and wait p50/p95 for each kind of writer in the scenario, in the order the scenario lists them.

Every run checks that the table holds exactly the transactions the writers reported and that `PRAGMA integrity_check` passes. Variants run interleaved, rotating which goes first, and the tables report the median of the repeats.

Scenarios:

| Scenario | Writers |
|---|---|
| `uncontended` | 1 process, 1 transaction at a time (control) |
| `serial-30` | 30 processes, 1 transaction at a time each |
| `bursty-8x16` | 8 processes, 16 transactions in flight each |
| `pool-like` | 3 coordinators × 32 in flight, a parent × 8, 26 workers writing every ~100 ms: the shape of #4312's host A |
| `heavy-batches` | 3 coordinators × 64 in flight at 2 ms of work each (128 ms per full batch, so the hold budget splits it), 10 workers writing every ~50 ms |

## Results

A crabbox runner (Azure D64ads_v6: AMD EPYC 9V74, 64 vCPU), Linux 7.0, Node v24.22.0 writers, Bun 1.4.4 orchestrator, database in a temporary directory on the runner's OS disk (an uncontended commit, sync included, takes about 0.55 ms), 3 repeats, 2026-11-05.

| scenario | variant | lock utilization | commits/s | transactions/s | transactions/commit | wait p50 ms | wait p95 ms | wait p99 ms | wait max ms | per group: tx/s, wait p50/p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| uncontended | baseline | 94.6% | 1818 | 1818 | 1.0 | 0.0 | 0.0 | 0.1 | 0 | 1818, 0.0/0.0 |
| uncontended | current@100 | 96.3% | 1857 | 1857 | 1.0 | 0.0 | 0.0 | 0.0 | 0 | 1857, 0.0/0.0 |
| serial-30 | baseline | 1.8% | 26 | 26 | 1.0 | 1142.9 | 1319.4 | 1336.2 | 1353 | 26, 1142.9/1319.4 |
| serial-30 | current@100 | 61.7% | 1025 | 1025 | 1.0 | 28.3 | 29.9 | 33.6 | 78 | 1025, 28.3/29.9 |
| bursty-8x16 | baseline | 20.9% | 25 | 402 | 16.0 | 316.6 | 444.6 | 474.6 | 494 | 402, 316.6/444.6 |
| bursty-8x16 | current@100 | 96.2% | 116 | 1854 | 16.0 | 64.6 | 68.2 | 68.6 | 74 | 1854, 64.6/68.2 |
| pool-like | baseline | 6.2% | 24 | 107 | 4.4 | 1167.2 | 1281.2 | 1288.0 | 1328 | 80, 1168.7/1280.9; 6, 1176.5/1284.3; 21, 1141.6/1277.1 |
| pool-like | current@100 | 91.9% | 216 | 1637 | 7.6 | 62.3 | 70.7 | 74.9 | 92 | 1364, 61.8/70.5; 113, 65.6/71.2; 159, 63.1/71.2 |
| heavy-batches | baseline | 33.2% | 20 | 172 | 8.4 | 1220.7 | 1387.2 | 1414.5 | 1428 | 157, 1231.3/1391.2; 16, 570.6/785.8 |
| heavy-batches | current@100 | 98.5% | 41 | 506 | 12.4 | 286.8 | 548.5 | 552.8 | 556 | 475, 290.2/548.7; 31, 263.8/283.8 |

No variant failed a transaction. In `serial-30` the lock changes hands about 1000 times a second; the remaining idle time, about 0.4 ms per turn, is the handoff itself: the notice reaching the next process, which wakes, checks the queue, and begins. The baseline's queued writers found the free lock by polling 50–100 ms apart.

### Group-commit budget

The budget only matters when one acquisition has more queued work than the budget allows. A sweep of 25, 50, 100, 200, and 400 ms over all five scenarios, run with this change on the same runner, measured all budgets alike in the first four, where no batch reached 25 ms. `heavy-batches` makes it bind, measured on the runner's disk and again with every `fsync`/`fdatasync` delayed by 5 ms (an `LD_PRELOAD` shim, below) to stand in for slower storage:

| budget | disk: tx/s | disk: coordinators tx/s, wait p50/p95 ms | disk: workers tx/s, wait p50/p95 ms | 5 ms sync: tx/s | 5 ms sync: coordinators | 5 ms sync: workers |
|---:|---:|---|---|---:|---|---|
| 25 | 531 | 450, 417/429 | 81, 75/86 | 327 | 271, 699/718 | 56, 123/143 |
| 50 | 519 | 466, 435/458 | 54, 132/159 | 373 | 331, 618/649 | 42, 181/219 |
| 100 | 507 | 475, 290/548 | 31, 264/285 | 420 | 393, 352/677 | 26, 325/340 |
| 200 | 505 | 480, 333/391 | 25, 349/368 | 430 | 408, 395/453 | 22, 410/427 |
| 400 | 505 | 480, 333/391 | 25, 347/367 | | | |

A smaller budget lets the light writers in sooner (worker p50 75 ms at 25 vs 264 ms at 100 on the runner's disk) but commits more often, which costs the heavy writers throughput as syncs get slower: with 5 ms syncs a 25 ms budget loses 24% of total throughput against 200 ms, a 50 ms budget 13%, and 100 ms 2%. The `pool-like` scenario, the shape of the reported workload, is insensitive to the budget at both sync speeds (92% and 94% lock utilization). The default therefore stays at 100 ms: within 3% of the best throughput with slow syncs and within 5% with fast ones, while bounding how long a light writer waits behind a heavy one. Hosts that care more about small writers' latency on fast storage can lower it with `openNodeSqliteDatabase(path, { groupCommitHoldMs })`.

The slow-sync shim, compiled with `gcc -shared -fPIC -O2 -o slow-fsync.so slow-fsync.c -ldl` and run as `SLOW_FSYNC_US=5000 LD_PRELOAD=$PWD/slow-fsync.so bun run scripts/perf/writer-queue/benchmark.ts --scenarios uncontended,pool-like,heavy-batches --holds 25,50,100,200 --repeats 3` (uncontended drops to 177 commits/s, confirming the delay applies):

```c
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdlib.h>
#include <time.h>

static void slow(void) {
	const char *value = getenv("SLOW_FSYNC_US");
	long microseconds = value ? atol(value) : 5000;
	struct timespec pause = { microseconds / 1000000, (microseconds % 1000000) * 1000 };
	nanosleep(&pause, 0);
}

int fsync(int fd) {
	static int (*real)(int);
	if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fsync");
	slow();
	return real(fd);
}

int fdatasync(int fd) {
	static int (*real)(int);
	if (!real) real = (int (*)(int))dlsym(RTLD_NEXT, "fdatasync");
	slow();
	return real(fd);
}
```
