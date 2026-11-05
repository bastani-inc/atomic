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

A crabbox runner (Azure D64ads_v7: AMD EPYC 9V45, 64 vCPU), Linux 7.0, Node v24.22.0 writers, Bun 1.4.4 orchestrator, database in a temporary directory on the runner's OS disk (an uncontended commit, sync included, takes about 0.5 ms), 3 repeats, 2026-11-05.

| scenario | variant | lock utilization | commits/s | transactions/s | transactions/commit | wait p50 ms | wait p95 ms | wait p99 ms | wait max ms | per group: tx/s, wait p50/p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| uncontended | baseline | 97.1% | 1905 | 1905 | 1.0 | 0.0 | 0.0 | 0.0 | 0 | 1905, 0.0/0.0 |
| uncontended | current@100 | 97.4% | 1908 | 1908 | 1.0 | 0.0 | 0.0 | 0.0 | 5 | 1908, 0.0/0.0 |
| serial-30 | baseline | 1.6% | 24 | 24 | 1.0 | 1213.6 | 1397.8 | 1457.1 | 1490 | 24, 1213.6/1397.8 |
| serial-30 | current@100 | 67.6% | 1177 | 1177 | 1.0 | 24.6 | 26.3 | 29.0 | 41 | 1177, 24.6/26.3 |
| bursty-8x16 | baseline | 20.8% | 26 | 408 | 16.0 | 320.4 | 409.7 | 441.2 | 454 | 408, 320.4/409.7 |
| bursty-8x16 | current@100 | 97.8% | 119 | 1910 | 16.0 | 62.6 | 66.2 | 66.8 | 72 | 1910, 62.6/66.2 |
| pool-like | baseline | 6.5% | 26 | 114 | 4.3 | 1063.6 | 1326.4 | 1335.4 | 1356 | 84, 1063.4/1326.4; 7, 1093.2/1354.2; 22, 1053.8/1284.9 |
| pool-like | current@100 | 94.5% | 222 | 1710 | 7.7 | 59.1 | 67.3 | 74.7 | 94 | 1428, 58.6/67.1; 119, 62.3/68.1; 162, 59.6/67.8 |
| heavy-batches | baseline | 32.0% | 21 | 168 | 8.1 | 1193.8 | 1392.5 | 1420.6 | 1440 | 152, 1203.2/1395.8; 16, 588.2/743.3 |
| heavy-batches | current@100 | 98.9% | 42 | 513 | 12.4 | 284.8 | 544.0 | 548.5 | 552 | 481, 287.9/544.2; 32, 261.2/283.0 |

No variant failed a transaction. In `serial-30` the lock changes hands about 1200 times a second; the remaining idle time, about 0.3 ms per turn, is the handoff itself: the notice reaching the next process, which wakes, checks the queue, and begins. The baseline's queued writers found the free lock by polling 50–100 ms apart.

### Group-commit budget

The budget only matters when one acquisition has more queued work than the budget allows. A sweep of 25, 50, 100, 200, and 400 ms over all five scenarios, run with this change on an earlier runner of the same size (Azure D64ads_v6, AMD EPYC 9V74), measured all budgets alike in the first four, where no batch reached 25 ms. `heavy-batches` makes it bind, measured on the runner's disk and again with every `fsync`/`fdatasync` delayed by 5 ms (an `LD_PRELOAD` shim, below) to stand in for slower storage:

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

## Dead-head probe

`dead-head.ts` checks that the queue recovers from a writer that dies while it waits. A holder keeps the write lock, waiter A queues behind it and waiter B behind A; A is killed, and the holder commits `--gaps` ms later. A's ticket stays live until 2 s after A last refreshed it, and only its owner refreshes it, so B should hold the lock about `2000 - gap` ms after the commit (less however long before its death A last refreshed), plus up to one 250 ms recheck.

```sh
bun run scripts/perf/writer-queue/dead-head.ts --gaps 100,1000,1500 --repeats 5
```

On the runner above, 5 samples per gap, baseline and this change interleaved (time from the holder's commit to the writer behind the dead one holding the lock):

| killed before the commit | expected | baseline (median, range) | this change (median, range) |
|---:|---:|---:|---:|
| 100 ms | about 1900 ms | 1926 ms (1895-1963) | 1902 ms (1886-1903) |
| 1000 ms | about 1000 ms | 1035 ms (1006-1055) | 1001 ms (996-1001) |
| 1500 ms | about 500 ms | 522 ms (511-569) | 498 ms (488-502) |
