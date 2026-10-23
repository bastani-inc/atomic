# Internal local workflow workers

Issue #3869 is being implemented in six slices. This document describes the internal execution path added in slice 3. There is no CLI, settings or public SDK option to enable it. Normal workflow execution does not create a pool or start polling workers.

## Execution and persistence

`workers/local-pool.ts` binds a supervisor to one physical `JournalDurableBackend`. The root keeps its existing execution lease. The existing durable child wrapper validates the boundary identity; `engine/primitives/workflow.ts` dispatches first-level children through the supervisor. Nested children execute on that same worker through the ordinary engine and scoped backend.

A headless Node process loads `workers/local-worker-entry.mjs`, then calls the existing `engine/run.ts`. It uses the normal Atomic agent-session adapter. It receives the original child run ID, parent boundary, root ID, depth, cwd and checkpoint scope. Its journal view refuses root registration, lease acquisition and direct journal writes.

Workers poll the supervisor over IPC. The supervisor claims work and applies checkpoint/session operations through the fenced SQL queue. IPC is transport, not completion evidence. The root reads completed results from the SQL result record. Session creation, append and replacement write a stage checkpoint and transcript in the same fenced transaction; no worker transcript is recovered from a JSONL path.

Checkpoint completion timestamps come from the worker's JavaScript clock. The coordinator allows them to be up to one second ahead of its JavaScript or SQLite clock. This covers Windows timer-tick differences between processes and SQLite's coarser clock without accepting clearly future timestamps. Lease fencing, event timestamps and commit receipts still use SQLite time only; the stored checkpoint timestamp remains unchanged for replay.

The pool gives the coordinator lease three root-heartbeat intervals, leaving room for delayed renewal. After a worker exits, the coordinator drains its received IPC operations and checks durable completion before applying the retry limit. A completion already in flight can still succeed on the final attempt.

Worker exit triggers a bounded replacement. Expired work becomes claimable only after the local worker has exited. Each child has a three-attempt limit; successful recovery of one child does not exhaust retries for later children. Replacement workers replay the child from acknowledged checkpoints, including completed stages and nested children. An unfinished agent stage resumes its SQL session. External effects that precede a checkpoint can still repeat.

## Compatibility boundary

The internal inventory accepts definitions loaded through the shared workflow-module loader, with an absolute module path, export name and SHA-256 content digest. Unregistered closures, changed entry modules and process-bound run adapter overrides fail before a worker starts. Child invocation budget overrides are also rejected before enqueueing; they are not silently dropped. The entry-module digest is not a deployment system or a transitive dependency snapshot. All workers still use the coordinator's local installation and filesystem.

This slice accepts the default-prefix local SQL journal only. It does not expose admission limits, shared budgets, root control propagation, Intercom handoff, remote workers or process-tree containment. Those remain later slices and are why production activation stays closed. Callers of the internal supervisor must close it after the root settles.

## Verification

- `test/integration/workflow-local-pool.test.ts` runs a root and two real workers, uses a SQL checkpoint barrier to prove fan-out, executes normal Atomic stages with an offline fixture provider, and checks scoped topology. Crash cases prove completed tool/stage/nested outputs are replayed, unfinished stages resume the same SQL session, and four successive child recoveries do not exhaust a pool-wide counter.
- `test/integration/workflow-local-pool-lifecycle.test.ts` checks delayed root-heartbeat headroom and a final-attempt worker exit while its durable completion is pending.
- `test/unit/workflow-local-pool-compatibility.test.ts` checks entry-module changes and process-bound run overrides before launch.
- `test/unit/workflow-pool-commits.test.ts` checks durable child completion receipts, including a lost acknowledgement and rejected late writes.

User guides and the package changelog are unchanged because this internal path is not available to users yet.
