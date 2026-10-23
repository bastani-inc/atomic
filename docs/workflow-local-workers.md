# Internal local workflow workers

Issue #3869 is being implemented in six slices. This document describes the internal execution path through slice 5. There is no CLI, settings or public SDK option to enable it. Normal workflow execution does not create a pool or start polling workers.

## Execution and persistence

`workers/local-pool.ts` binds a supervisor to one physical `JournalDurableBackend`. The root keeps its existing execution lease. The existing durable child wrapper validates the boundary identity; `engine/primitives/workflow.ts` dispatches first-level children through the supervisor. Nested children execute on that same worker through the ordinary engine and scoped backend.

A headless Node process loads `workers/local-worker-entry.mjs`, then calls the existing `engine/run.ts`. It uses the normal Atomic agent-session adapter. It receives the original child run ID, parent boundary, root ID, depth, cwd and checkpoint scope. Its journal view refuses root registration, lease acquisition and direct journal writes.

Workers poll the supervisor over IPC. The supervisor claims work and applies checkpoint/session operations through the fenced SQL queue. IPC is transport, not completion evidence. The root reads completed results from the SQL result record. Session creation, append and replacement write a stage checkpoint and transcript in the same fenced transaction; no worker transcript is recovered from a JSONL path.

Checkpoint completion timestamps come from the worker's JavaScript clock. The coordinator allows them to be up to one second ahead of its JavaScript or SQLite clock. This covers Windows timer-tick differences between processes and SQLite's coarser clock without accepting clearly future timestamps. Lease fencing, event timestamps and commit receipts still use SQLite time only; the stored checkpoint timestamp remains unchanged for replay.

The pool gives the coordinator lease three root-heartbeat intervals, leaving room for delayed renewal. After a worker exits, the coordinator drains its received IPC operations and checks durable completion before applying the retry limit. A completion already in flight can still succeed on the final attempt.

Worker exit triggers a bounded replacement. Expired work becomes claimable only after the local worker has exited. Each child has a three-attempt limit; successful recovery of one child does not exhaust retries for later children. Replacement workers replay the child from acknowledged checkpoints, including completed stages and nested children. An unfinished agent stage resumes its SQL session. External effects that precede a checkpoint can still repeat.

## Compatibility boundary

The internal inventory accepts definitions loaded through the shared workflow-module loader, with an absolute module path, export name and SHA-256 content digest. Unregistered closures, changed entry modules and process-bound run adapter overrides fail before a worker starts. Child invocation budget overrides are also rejected before enqueueing; they are not silently dropped. The entry-module digest is not a deployment system or a transitive dependency snapshot. All workers still use the coordinator's local installation and filesystem.

This path accepts the default-prefix local SQL journal only. Admission and budget accounting are shared with the root. Remote workers and the public activation contract remain out of scope. Callers of the internal supervisor must close it after the root settles.

## Control and routing

Root control is registered before asynchronous pool preparation. Pause, resume and quit intent has a durable revision. Claims and resource grants check that intent; workers acknowledge revisions after applying the existing scheduler and stage controls. Pause waits for worker acknowledgements before publishing the root as paused. Quit gives workers a bounded chance to suspend and dispose their sessions, then confirms local process cleanup or reports unresolved cleanup. Explicit resume reopens admission without changing queued work identities or completed child results.

Worker activity updates the existing root store, including nested parent edges and worker lease diagnostics on stages. Workers do not register additional durable roots. The root's Intercom route owner announces worker stages and supplies their current route capabilities. Replacement rotates those capabilities. Pending direct messages, sticky broadcasts and delivery receipts use the existing root-owned durable queue. The root records a receipt only after transport acknowledgement and a current-attempt/session check. A worker never writes the root message ledger directly.

The root reconstructs committed child checkpoints and pending messages from the journal. Uncheckpointed worker activity is observational and may disappear on recovery. Recovery still provides at-least-once execution, not exactly-once external effects.

## Verification

- `test/integration/workflow-local-pool.test.ts` runs a root and two real workers, uses a SQL checkpoint barrier to prove fan-out, executes normal Atomic stages with an offline fixture provider, and checks scoped topology. Crash cases prove completed tool/stage/nested outputs are replayed, unfinished stages resume the same SQL session, and four successive child recoveries do not exhaust a pool-wide counter.
- `test/integration/workflow-local-pool-lifecycle.test.ts` checks delayed root-heartbeat headroom, pause/resume/quit, recovery, and a final-attempt worker exit while its durable completion is pending.
- `test/unit/workflow-local-pool-compatibility.test.ts` checks entry-module changes and process-bound run overrides before launch.
- `test/unit/workflow-pool-commits.test.ts` checks durable child completion receipts, including a lost acknowledgement and rejected late writes.
- `test/integration/workflow-pool-intercom.test.ts` sends direct and sticky messages through a real local broker to two workers, replaces one worker before delivery, and verifies both messages enter the intended stage context.
- `test/unit/workflow-pool-stage-handoff.test.ts` checks scoped publication, capability rotation, stale-session acknowledgement rejection and reuse of durable pending messages.

User guides and the package changelog are unchanged because this internal path is not available to users yet.
