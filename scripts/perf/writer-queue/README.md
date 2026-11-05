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
| uncontended | baseline | 97.3% | 1913 | 1913 | 1.0 | 0.0 | 0.0 | 0.0 | 1 | 1913, 0.0/0.0 |
| uncontended | current@100 | 97.5% | 1916 | 1916 | 1.0 | 0.0 | 0.0 | 0.0 | 4 | 1916, 0.0/0.0 |
| serial-30 | baseline | 1.5% | 26 | 26 | 1.0 | 1139.3 | 1331.4 | 1368.8 | 1379 | 26, 1139.3/1331.4 |
| serial-30 | current@100 | 69.5% | 1242 | 1242 | 1.0 | 23.3 | 24.6 | 26.3 | 30 | 1242, 23.3/24.6 |
| bursty-8x16 | baseline | 20.4% | 25 | 398 | 16.0 | 310.0 | 418.6 | 458.6 | 476 | 398, 310.0/418.6 |
| bursty-8x16 | current@100 | 98.2% | 120 | 1926 | 16.0 | 62.1 | 65.7 | 66.3 | 74 | 1926, 62.1/65.7 |
| pool-like | baseline | 6.4% | 26 | 114 | 4.6 | 1110.2 | 1290.8 | 1360.0 | 1365 | 84, 1110.4/1295.3; 7, 1154.4/1221.6; 22, 1106.2/1258.0 |
| pool-like | current@100 | 95.3% | 225 | 1737 | 7.7 | 58.1 | 65.8 | 72.8 | 94 | 1452, 57.5/65.8; 121, 61.2/66.3; 164, 58.5/66.2 |
| heavy-batches | baseline | 31.8% | 21 | 168 | 8.1 | 1190.6 | 1310.1 | 1397.7 | 1424 | 152, 1205.0/1312.5; 16, 572.1/733.6 |
| heavy-batches | current@100 | 98.6% | 56 | 521 | 9.3 | 358.3 | 396.6 | 400.1 | 407 | 480, 363.7/396.9; 41, 196.0/302.2 |

No variant failed a transaction. In `serial-30` the lock changes hands about 1240 times a second; the remaining idle time, about 0.25 ms per turn, is the handoff itself: the notice reaching the next process, which wakes, checks the queue, and begins. The baseline's queued writers found the free lock by polling 50–100 ms apart.

### Group-commit budget

The budget only matters when one acquisition has more queued work than the budget allows. A sweep of 25, 50, 100, 200, and 400 ms over all five scenarios on an earlier runner of the same size (Azure D64ads_v6, AMD EPYC 9V74) measured all budgets alike in the first four, where no batch reached 25 ms. `heavy-batches` makes it bind. It was measured again on the runner above, where only a batch's first acquisition takes in the transactions queued behind it and the members a budget leaves over take the lock again on their own, both on the runner's disk and with every `fsync`/`fdatasync` delayed by 5 ms (an `LD_PRELOAD` shim, below) to stand in for slower storage:

| budget | disk: tx/s | disk: coordinators tx/s, wait p50/p95 ms | disk: workers tx/s, wait p50/p95 ms | 5 ms sync: tx/s | 5 ms sync: coordinators | 5 ms sync: workers |
|---:|---:|---|---|---:|---|---|
| 25 | 541 | 459, 402/416 | 82, 71/83 | 333 | 275, 680/698 | 57, 119/139 |
| 50 | 529 | 469, 386/406 | 59, 121/153 | 368 | 324, 564/590 | 45, 168/209 |
| 100 | 521 | 480, 364/397 | 41, 201/300 | 400 | 365, 480/515 | 34, 241/350 |
| 200 | 513 | 488, 330/387 | 25, 346/366 | 438 | 416, 390/448 | 22, 405/423 |
| 400 | 514 | 488, 330/387 | 26, 346/364 | | | |

A smaller budget lets the light writers in sooner (worker p50 71 ms at 25 vs 201 ms at 100 on the runner's disk) but commits more often, which costs the heavy writers throughput as syncs get slower: with 5 ms syncs a 25 ms budget loses 24% of total throughput against 200 ms, a 50 ms budget 16%, and 100 ms 9%. The `pool-like` scenario, the shape of the reported workload, is insensitive to the budget at both sync speeds (95% and 97% lock utilization at every budget). The default therefore stays at 100 ms: within 9% of the best throughput with slow syncs and within 4% with fast ones, while light writers wait about 40% less than at 200 ms. Hosts that care more about small writers' latency on fast storage can lower it with `openNodeSqliteDatabase(path, { groupCommitHoldMs })`.

The slow-sync shim, compiled with `gcc -shared -fPIC -O2 -o slow-fsync.so slow-fsync.c -ldl` and run as `SLOW_FSYNC_US=5000 LD_PRELOAD=$PWD/slow-fsync.so bun run scripts/perf/writer-queue/benchmark.ts --scenarios uncontended,pool-like,heavy-batches --holds 25,50,100,200 --repeats 3` (uncontended drops to 179 commits/s, confirming the delay applies):

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

## Separate-notice recheck

After moving release notices into `<file>-wakes`, the same benchmark was rerun on a 64-vCPU crabbox runner with Node 22.23.4 writers and Bun 1.4.4. Three interleaved repeats used 500 ms warm-up, 2000 ms measurement, and the unchanged 100 ms hold budget, against the same `77746f5` baseline. Medians:

| Scenario | Baseline utilization | Separate notices | Baseline tx/s | Separate notices tx/s | Baseline wait p50 ms | Separate notices wait p50 ms |
|---|---:|---:|---:|---:|---:|---:|
| uncontended | 97.4% | 97.5% | 1910 | 1910 | 0.0 | 0.0 |
| serial-30 | 2.1% | 69.6% | 27 | 1198 | 1133.3 | 24.1 |
| bursty-8x16 | 20.6% | 98.0% | 408 | 1912 | 307.4 | 62.5 |
| pool-like | 6.6% | 94.8% | 122 | 1703 | 1125.8 | 59.3 |
| heavy-batches | 35.7% | 98.3% | 183 | 521 | 1098.2 | 361.1 |

No transaction failed, and every sample checked its row count and `integrity_check`. A one-sample-per-gap dead-head recheck measured 1902, 1000, and 497 ms after commit for the 100, 1000, and 1500 ms gaps. Only the owner now writes a ticket's heartbeat: a release cannot undo a refresh made after the queue scan, and cannot change its timestamp through a floating-point conversion.

## Failures

Both scripts check every flag before they create a directory or start a writer process, stop every writer they started and remove their scratch files when a run fails, and print one message (plus the stack only when `ATOMIC_PERF_DEBUG=1`) with exit code 1. A writer that exits, fails to start, or closes its output before the script reads what it waits for fails the run instead of leaving it waiting. Configuration and worker-protocol errors extend `WriterQueueBenchmarkError` (`retryable` is always `false`; `cleanupCause` holds a cleanup failure that followed the primary one) and have guards (`isWriterQueueBenchmarkError`, `isWriterQueueBenchmarkConfigError`, `isWriterQueueBenchmarkWorkerError`) in `errors.ts`.

| Class | Code | When | Fields | What to do |
|---|---|---|---|---|
| `WriterQueueBenchmarkConfigError` | `invalid-option` | A flag is unknown, repeated, valueless, out of range, or names a baseline or output path that cannot be used | `source` (`"cli"`), `field`, `reason`, `hint`; `cause` for `git-unavailable` | Fix the flag named in `field`; `reason` is one of `unexpected-argument`, `unknown-flag`, `repeated-flag`, `missing-value`, `out-of-range`, `unknown-scenario`, `unknown-runtime`, `unknown-revision`, `missing-storage-directory`, `not-a-file-path`, `git-unavailable` |
| `WriterQueueBenchmarkWorkerError` | `worker-exited` | A writer exited (any code or signal) before the line the script waited for, or with a failing status at the end | `worker`, `phase`, `exitCode`, `signal` | Read the writer's own error on stderr, fix it, rerun |
| `WriterQueueBenchmarkWorkerError` | `worker-error` | A writer process could not be started | `worker`, `phase`, `cause` | Check the runtime named by `--runtime` or `NODE` exists |
| `WriterQueueBenchmarkWorkerError` | `worker-protocol` | A writer sent a line the script cannot use, or closed its output while still running | `worker`, `phase`, `cause` | Read the writer's stderr; rerun |
