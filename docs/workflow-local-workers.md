# Local workflow workers

Issue #3869 enables an explicit public opt-in to local workers through SDK options and workflow settings. Without `localWorkers`, ordinary runs create no pool tables, worker processes, or polling loops. The public usage boundary is documented in the [workflow operations guide](../packages/coding-agent/docs/workflows/operations.md#local-workflow-workers).

Placement is limited to local Linux and macOS processes with native process identity and boot identity. Windows and hosts without those identities refuse activation, even when no process admission limit is configured. This prevents treating an expired lease as proof that an old process tree stopped. Remote workers are not supported.

## Execution and persistence

`workers/local-pool.ts` binds a supervisor to one physical `JournalDurableBackend`. The root keeps its existing execution lease. The existing durable child wrapper validates the boundary identity; `engine/primitives/workflow.ts` dispatches first-level children through the supervisor. Nested children execute on that same worker through the ordinary engine and scoped backend.

A headless Node process loads `workers/local-worker-entry.mjs`, then calls the existing `engine/run.ts`. It uses the normal Atomic agent-session adapter. It receives the original child run ID, parent boundary, root ID, depth, cwd and checkpoint scope. Its journal view refuses root registration, lease acquisition and direct journal writes.

Workers poll the supervisor over IPC. The supervisor claims work and applies checkpoint/session operations through the fenced SQL queue. IPC is transport, not completion evidence. The root reads completed results from the SQL result record. Session creation, append and replacement write a stage checkpoint and transcript in the same fenced transaction; no worker transcript is recovered from a JSONL path.

Checkpoint completion timestamps come from the worker's JavaScript clock. The coordinator allows them to be up to one second ahead of its JavaScript or SQLite clock. This covers Windows timer-tick differences between processes and SQLite's coarser clock without accepting clearly future timestamps. Lease fencing, event timestamps and commit receipts still use SQLite time only; the stored checkpoint timestamp remains unchanged for replay.

The pool gives the coordinator lease three root-heartbeat intervals, leaving room for delayed renewal. After a worker exits, the coordinator drains its received IPC operations and checks durable completion before applying the retry limit. A completion already in flight can still succeed on the final attempt.

Worker exit triggers a bounded replacement. Expired work becomes claimable only after the local worker has exited. Each child has a three-attempt limit; successful recovery of one child does not exhaust retries for later children. Replacement workers replay the child from acknowledged checkpoints, including completed stages and nested children. An unfinished agent stage resumes its SQL session. External effects that precede a checkpoint can still repeat.

## Compatibility boundary

The internal inventory accepts definitions loaded through the shared workflow-module loader, with an absolute module path, export name and SHA-256 content digest. Unregistered closures, changed entry modules and process-bound run adapter overrides fail before a worker starts. Child invocation budget overrides are also rejected before enqueueing; they are not silently dropped. The entry-module digest is not a deployment system or a transitive dependency snapshot. All workers still use the coordinator's local installation and filesystem.

This path accepts the default-prefix local SQL journal only. Admission and budget accounting are shared with the root. The root persists effective worker and admission settings and refuses changed settings or entry-module digests during resume. The digest covers only the worker entry file, not imported dependencies.

## Control and routing

Root control is registered before asynchronous pool preparation. Pause, resume and quit intent has a durable revision. Claims and resource grants check that intent; workers acknowledge revisions after applying the existing scheduler and stage controls. Pause waits for worker acknowledgements before publishing the root as paused. Quit gives workers a bounded chance to suspend and dispose their sessions, then confirms local process cleanup or reports unresolved cleanup. Explicit resume reopens admission without changing queued work identities or completed child results.

Resume checks for a newer pause after durable persistence, before reopening pool admission. Pool shutdown releases Intercom routes even when worker or session cleanup fails, while still reporting the cleanup error.

Worker activity updates the existing root store, including nested parent edges and worker lease diagnostics on stages. Workers do not register additional durable roots. The root's Intercom route owner announces worker stages and supplies their current route capabilities. Replacement rotates those capabilities. Pending direct messages, sticky broadcasts and delivery receipts use the existing root-owned durable queue. A worker never writes the root message ledger directly.

Worker activity publication keeps one request in flight and coalesces later invalidations into the latest snapshot. Lease renewal and control polling do not wait for activity acknowledgements. Pending-message transitions apply persisted messages to the current run snapshot, including when worker publication replaces it during persistence.

The root records a receipt only after transport acknowledgement or confirmed context admission. Each receipt append validates the work lease in the same SQL transaction as the write and checks the published session before the transaction returns. A concurrent replacement either precedes that validation and rejects the receipt, or follows the receipt's transaction ordering. Successor delivery waits for the old drain to release its message claim. Session replacement rejects old readiness requests and discards the failed delivery object. A temporary coordinator heartbeat lag refuses receipt commits without retiring the root's journal backend.

The root reconstructs committed child checkpoints and pending messages from the journal. Uncheckpointed worker activity is observational and may disappear on recovery. Recovery still provides at-least-once execution, not exactly-once external effects.

## Verification

- `test/integration/workflow-local-pool.test.ts` runs a root and two real workers, uses a SQL checkpoint barrier to prove fan-out, executes normal Atomic stages with an offline fixture provider, and checks scoped topology. Crash cases prove completed tool/stage/nested outputs are replayed, unfinished stages resume the same SQL session, and four successive child recoveries do not exhaust a pool-wide counter.
- `test/integration/workflow-local-pool-lifecycle.test.ts` checks delayed root-heartbeat headroom, pause/resume/quit, recovery, and a final-attempt worker exit while its durable completion is pending.
- `test/unit/workflow-local-pool-compatibility.test.ts` checks entry-module changes and process-bound run overrides before launch.
- `test/unit/workflow-pool-commits.test.ts` checks durable child completion receipts, including a lost acknowledgement and rejected late writes.
- `test/integration/workflow-pool-intercom.test.ts` sends direct and sticky messages through a real local broker to two workers, replaces one worker before delivery, and verifies both messages enter the intended stage context.
- `test/unit/workflow-pool-stage-handoff.test.ts` checks scoped publication, capability rotation, stale-session acknowledgement rejection and reuse of durable pending messages. Deterministic barriers replace workers or sessions after transport validation but before receipt persistence, and fence an attempt after its receipt insert to verify transaction rollback. Direct and sticky delivery both cover receipts for messages already admitted to context.
- `test/integration/workflow-local-worker-heartbeat.test.ts` holds activity acknowledgements while a real worker produces tool updates, checks continued renewals and control polling, and verifies coalesced publication retains the final state.
- `test/unit/workflow-pool-dispose-routes.test.ts` verifies failed session cleanup still releases root routes and reports the cleanup error.

## Public placement and admission

The public SDK accepts `RunOpts.localWorkers: { count, definitions: [{ path, exportName }] }` and optional `RunOpts.admission`. The SDK helper `loadWorkerWorkflow(absolutePath, exportName = "default")` loads an importable child definition for `ctx.workflow(child)`. A root can remain an inline closure, but each eligible child definition needs an importable path and export inventory. Only the complete first-level child subtree runs on a worker; nested children remain there. Missing or incompatible definitions fail instead of falling back to local execution. Independent stage placement is not supported.

The CLI reads the same keys from `workflows` settings. Settings and entry-module digests are retained with the root. Settings paths resolve against the invocation working directory; SDK paths resolve against `cwd`. Arbitrary SDK process-bound adapters, UI, persistence, and related runtime overrides are rejected before worker launch. CLI host bindings stay in the root process; worker stages create their own sessions.

Resource limits count agent sessions from creation through disposal, including fallback and delegated sessions, and Atomic-managed tool processes until cleanup is confirmed. Yielding an observation does not free a process permit. Arbitrary subprocesses outside managed Atomic APIs are not counted. Host load and free-memory thresholds are launch gates, not hard OS limits. Optional user-wide limits require all participating roots to use the same canonical local SQLite path. This is local-user coordination, not multi-tenant isolation.

Recovery is at least once: committed checkpoints prevent repetition of completed work, but external effects performed before a checkpoint may run again. Use stable logical idempotency keys where duplicate effects matter. Root status, stages, steering, pause, quit, and resume still operate on one root identity.

The worker entrypoint ships in installed workflow bundles. The standalone launcher handles its internal worker mode before loading the normal CLI, supplies the same host modules as the app bundle, and refuses startup without an IPC channel.
