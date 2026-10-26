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

Resuming a root releases the work its previous incarnation leased, but a released child becomes claimable only when the resumed root enqueues it again; until then its row keeps the previous root epoch, and claims select only rows of the current epoch. The root accepts activity only for work it has enqueued, so an earlier claim would be rejected as a stale lease. A pool that has failed or quit stays bound to its root until its owner closes it: a child the root starts afterwards gets the pool's failure (or suspends after a quit) and never runs in the root process, whose session store cannot see pooled stage sessions.

## Compatibility boundary

The internal inventory accepts definitions loaded through the shared workflow-module loader, with an absolute module path, export name and SHA-256 content digest. Unregistered closures, changed entry modules and process-bound run adapter overrides fail before a worker starts. Child invocation budget overrides are also rejected before enqueueing; they are not silently dropped. The entry-module digest is not a deployment system or a transitive dependency snapshot. All workers still use the coordinator's local installation and filesystem.

This path accepts the default-prefix local SQL journal only. Admission and budget accounting are shared with the root. The root persists effective worker and admission settings and refuses changed settings or entry-module digests during resume. The digest covers only the worker entry file, not imported dependencies. `localWorkers.startupTimeoutMs` is operational rather than placement configuration: it is stripped before the effective resources are persisted and compared, so roots saved before the field existed resume unchanged and the timeout can be changed between resumes.

## Worker failure containment (#3887)

A worker can die while the coordinator still owes it IPC replies; workers keep renewal, control, usage and activity requests in flight. `ChildProcess.connected` stays true until the coordinator reads the IPC EOF, so a reply sent in that window fails synchronously with `EPIPE`. Without a send callback, Node reports that on the `ChildProcess` `'error'` event, and the second such error after the one-shot startup listener crashed the root. Every coordinator `send` now passes a callback, and the `'error'` listener is permanent. A failed reply or channel error kills the worker once, which routes it into the existing exit path: the attempt is fenced, process cleanup is confirmed, and the child is replayed on a replacement worker.

Worker standard error is piped to `worker-logs/<encoded root id>/<worker id>.log` beside the journal file, while an 8 KB tail stays in memory for error messages. Startup failures are reported on the child `'close'` event, after standard error is drained, so the message tail is complete. `Local worker exited before readiness`, `Local worker startup timed out after <n> ms` and `Local worker retry limit` name the log file. Logs of workers that exit on their own, time out or are killed by stalled-lease recovery are kept. On a successful pool close, logs of the workers that close stopped are deleted and the root's log directory is removed if empty; a coordinator crash leaves every log in place.

A worker opens its read-only journal backend without folding any run, reports ready, and only then folds the served root. Readiness therefore costs the same on an empty journal and on one with hundreds of unrelated runs. The root is folded before the first claim, so a large root history is read before the worker holds a work lease rather than inside the five-second lease window. `start()` resolves when any worker is ready (`Promise.any`) and fails with the first startup error only when every initial worker fails. Initial workers that fail later are dropped without failing the pool; a replacement that cannot start still fails it, as before. Pause, resume and quit wait only for acknowledgements from ready workers, because a still-starting worker observes the current control revision as its first request after readiness.

### Incremental root hydration

Workers used to call `hydrateWorkflow(root)`, which rebuilds the root from seq 1, after every commit and every claim. They now call `catchUpWorkflow(root)` at those points and before each claim request. It is the same prefix-checked fold used by the resume catalog: it reads from the last folded seq, folds the appended entries when that entry still has the folded `seq` and `at`, and otherwise rebuilds. This is equivalent to a rebuild because:

- a run's journal events are append-only with strictly increasing `seq`; `deleteRunData` is the only operation that removes events, and it removes the whole run;
- a deleted and recreated run is detected because its entry at the folded `seq` is missing or has a different store timestamp, which forces a rebuild;
- `fold` is deterministic and skips entries at or below the folded `seq`, so folding a suffix onto the cached prefix produces the state a full fold would;
- nothing else mutates the worker's projection: the worker backend proxy refuses every mutating method and its journal proxy is read-only, so the cached prefix can only come from earlier folds.

The coordinator still rebuilds the root through `hydrateWorkflow` before enqueueing a child and after reading its result.

### Admission defaults

A public pool without `admission` still passes `{}` to the coordinator and workers, so each opens `SqlResourceAdmission`. This is intentional. A limit-less admission writes no limit rows, but every managed tool process still takes a process permit bound to its Unix process group. When a worker exits, the coordinator's `releaseStoppedSessions(worker)` reconciles those groups and quarantines live ones instead of replaying the child while the old process tree may still run. Attempt fencing (`assertCurrentAttempt`) also refuses new sessions and processes from a stale attempt, and grants wait while the root is paused. Without the admission, a worker's permits would be no-ops without `bindProcess`, and a dead worker's orphaned tool processes could overlap with its replay.

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
- `test/integration/workflow-local-pool-worker-failure.test.ts` runs the coordinator in its own process. A worker sends three requests and dies while the coordinator's event loop is held, so every reply fails with `EPIPE`; the coordinator must exit cleanly with the child replayed on a replacement. A second case SIGKILLs one of two workers mid-child. In-process cases check that a worker exiting before readiness leaves a log named by the error, that `startupTimeoutMs` is honored, that one never-ready worker does not hold back the pool and that stopped workers' logs are removed, and that readiness survives a corrupt unrelated run, which the worker no longer reads.
- `test/unit/durable-journal-catch-up.test.ts` checks that a backend opened for no runs reads no events, that catch-up reads only from the last folded event and matches a fresh fold, and that a replaced history is rebuilt.
- `test/unit/workflow-public-pool.test.ts` checks that an invalid `startupTimeoutMs` is rejected before root admission and that changing it does not block resume.
- `test/unit/workflow-resource-admission.test.ts` checks that a limit-less admission still binds and quarantines a live worker process group until it stops.

## Public placement and admission

The public SDK accepts `RunOpts.localWorkers: { count, definitions: [{ path, exportName }], startupTimeoutMs? }` and optional `RunOpts.admission`. The SDK helper `loadWorkerWorkflow(absolutePath, exportName = "default")` loads an importable child definition for `ctx.workflow(child)`. A root can remain an inline closure, but each eligible child definition needs an importable path and export inventory. Only the complete first-level child subtree runs on a worker; nested children remain there. Missing or incompatible definitions fail instead of falling back to local execution. Independent stage placement is not supported.

The CLI reads the same keys from `workflows` settings. Settings and entry-module digests are retained with the root. Settings paths resolve against the invocation working directory; SDK paths resolve against `cwd`. Arbitrary SDK process-bound adapters, UI, persistence, and related runtime overrides are rejected before worker launch. CLI host bindings stay in the root process; worker stages create their own sessions.

Resource limits count agent sessions from creation through disposal, including fallback and delegated sessions, and Atomic-managed tool processes until cleanup is confirmed. Yielding an observation does not free a process permit. Arbitrary subprocesses outside managed Atomic APIs are not counted. Host load and free-memory thresholds are launch gates, not hard OS limits. Optional user-wide limits require all participating roots to use the same canonical local SQLite path. This is local-user coordination, not multi-tenant isolation.

Recovery is at least once: committed checkpoints prevent repetition of completed work, but external effects performed before a checkpoint may run again. Use stable logical idempotency keys where duplicate effects matter. Root status, stages, steering, pause, quit, and resume still operate on one root identity.

The worker entrypoint ships in installed workflow bundles. The standalone launcher handles its internal worker mode before loading the normal CLI, supplies the same host modules as the app bundle, and refuses startup without an IPC channel.
