# Finished task retention benchmark (#4385)

Counts the task records one owner of the native task supervisor keeps while its tasks finish. Each task is an agent task admitted, claimed, settled and reaped through the raw `@bastani/atomic-natives` binding, so the counts do not depend on timing.

```sh
bun run scripts/perf/task-retention/benchmark.ts --binding base=<base .node> --binding current=packages/natives/native/index.js --tasks 5000 --checkpoints 5
```

Options: `--binding label=path` (repeatable; a `.node` file or the package loader, default the checkout's `packages/natives/native/index.js`), `--tasks` (default 5000), `--checkpoints` (default 5). Each binding runs in its own process.

## What it measures

At each checkpoint the script opens a watcher, takes its snapshot (the list `/tasks` renders) and disposes it. `records kept` is the snapshot's task count; `snapshot bytes` is the size of that snapshot as JSON, a proxy for what each watcher copies on a reset.

## Results

Linux x86-64, release builds of the native module, Bun 1.4.4, 2026-11-05. `base` is the module built from `origin/main` before this change, `current` the one with the retention bound.

| binding | finished tasks | records kept | snapshot bytes |
|---|---:|---:|---:|
| base | 1000 | 1000 | 537520 |
| base | 2000 | 2000 | 1081521 |
| base | 3000 | 3000 | 1625521 |
| base | 4000 | 4000 | 2169521 |
| base | 5000 | 5000 | 2713521 |
| current | 1000 | 256 | 137906 |
| current | 2000 | 256 | 139442 |
| current | 3000 | 256 | 139442 |
| current | 4000 | 256 | 139442 |
| current | 5000 | 256 | 139442 |

Before, the owner kept one record per finished task, and its snapshot grew by about 544 bytes per task. With the bound it keeps the 256 most recently finished, and the snapshot stops growing once the task ids reach their final width: at 5,000 finished tasks it holds 19.5 times fewer records and is 19.5 times smaller.
