# node-sqlite connection threads benchmark (#5376)

Measures how long the event loop is blocked while a connection from `openNodeSqliteDatabase` works, and the
elapsed time of each case: open, appends of 1 KiB and 64 KiB rows in their own transactions one after another, 64
appends at once (one group commit), 1,000 point reads one after another (the cost of a statement's trip to its
connection's thread), reading every row, and close.

```sh
node --import jiti/register scripts/perf/node-sqlite-threads/benchmark.ts --rounds 5
bun run scripts/perf/node-sqlite-threads/benchmark.ts --rounds 5
```

Options: `--rounds N` (default 5), `--load N` (start N processes that keep a CPU busy for the whole run, as a
loaded machine; default 0), `--out <file>` (the table as Markdown).

- **Longest block** is the worst lateness of a 1 ms timer while the case ran, across rounds. The event loop sleeps
  between turns, as the interactive host's does, so a reply from a connection's thread has to wake it. It includes
  garbage collection and scheduling delays, not only SQLite time: under `--load` it mostly shows the operating
  system leaving the process waiting for a CPU.
- **Elapsed p50** is the case's median wall time; **per operation** divides it by the case's operations.

To measure the driver before #5376, copy this script into a checkout of the base commit and run it there.
