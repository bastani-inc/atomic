# node-sqlite connection threads benchmark (#5376)

Measures the gaps between turns of the event loop while a connection from `openNodeSqliteDatabase` works, and the
elapsed time of each case: open, appends of 1 KiB and 64 KiB rows in their own transactions one after another, 64
appends at once (one group commit), 1,000 point reads one after another (the cost of a statement's trip to its
connection's thread), reading every row, and close.

```sh
node --import jiti/register scripts/perf/node-sqlite-threads/benchmark.ts --rounds 5
bun run scripts/perf/node-sqlite-threads/benchmark.ts --rounds 5
```

Options: `--rounds N` (default 5), `--out <file>` (the table as Markdown).

- **Longest block** is the worst gap between two event-loop turns while the case ran, across rounds. It includes
  garbage collection and scheduling delays, not only SQLite time.
- **Elapsed p50** is the case's median wall time; **per operation** divides it by the case's operations.

To measure the driver before #5376, copy this script into a checkout of the base commit and run it there.
