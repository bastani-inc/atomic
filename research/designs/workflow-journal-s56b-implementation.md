# Workflow journal s56b implementation

## Frozen goal

Wire the configured run journal into all workflow run entry points, remove the separate memory backend and remaining retired behavior, require boundary fingerprints, and update user guides and release notes. Part A's public journal contract and resolver remain the basis of this slice.

## Acceptance matrix

The table records initial implementation evidence and the amended review-repair evidence. Independent review found three defects, all repaired and covered by durable regressions. The final amended gates below pass.

| Clause | Evidence | Result |
| --- | --- | --- |
| Factory uses `RunOpts.journal: { path }`. | `workflow-journal-wiring.test.ts`, factory source, unit suite. | Pass |
| Factory uses a caller-owned `DatabaseSync`. | Wiring and `durable-journal-configuration.test.ts`, unit suite. | Pass |
| Explicit `{ memory: true }` selects a memory journal. | Wiring and resolver tests, unit suite. | Pass |
| A supplied `RunJournal` retains its identity. | Wiring test covers supplied journals, including a SQLite journal with its own `path` property. | Pass |
| Async-only custom journals need no synchronous methods. | Wiring, actual recovery and owned-deletion regressions use an adapter implementing exactly the amended async interface. | Focused pass |
| TUI/CLI extension runs use invocation settings. | Extension runtime wiring scenario, unit suite. | Pass |
| SDK runs use the selected journal. | Wiring and SDK initialization/replay tests, unit suite. | Pass |
| Background runs use the selected journal. | Detached-run wiring scenario, unit suite. | Pass |
| Child execution keeps the root backend. | Nested replay, cross-project replay and journal execution tests, unit/integration suites. | Pass |
| Distinct default contexts resolve their own settings/environment. | Default-selection regression, unit suite. | Pass |
| Explicit journal selection overrides environment/settings. | `durable-journal-resolution.test.ts`, unit suite. | Pass |
| A non-empty environment path overrides settings. | Resolver and context-selection tests, unit suite. | Pass |
| Empty environment values do not override settings. | Resolver tests, unit suite. | Pass |
| A non-empty settings path selects its file. | Resolver and extension settings tests, unit suite. | Pass |
| Relative settings paths resolve against the Atomic home directory. | Resolver assertion and settings/operations/API guides. | Pass |
| The default is `join(dirname(getAgentDir()), "workflows", "journal.sqlite")`. | Resolver default-path assertion, unit suite. | Pass |
| Memory is never a storage-failure fallback. | Factory and SDK negative initialization tests. | Pass |
| Unopenable configured storage raises a typed error. | Negative factory/SDK tests assert `StorageUnavailableError` and fields. | Pass |
| Custom storage failures are wrapped with their cause. | Custom open/catalog/close error scenarios in wiring tests. | Pass |
| Caller-owned connections remain open. | Configuration and wiring reset/close scenarios. | Pass |
| Delete `InMemoryDurableBackend`. | No remaining production definition or export; migrated tests use the shared journal helper. | Pass |
| Delete `createInMemoryTestBackend`. | No remaining production definition or export. | Pass |
| Delete SDK `durability`. | Authoring contract and SDK declaration inspection; typecheck. | Pass |
| Delete `WorkflowDurability` and its required-error class. | Authoring/SDK export and source inspection; typecheck. | Pass |
| SQLite and memory share `JournalDurableBackend`. | Same backend operations over both journals, conformance and replay suites. | Pass |
| The folded state is private and not exported as a backend. | Private projection class and backend member; public export inspection. | Pass |
| Tests use a shared memory-journal helper. | `test/helpers/workflow-journal.ts` and migrated imports. | Pass |
| Storage fixtures use per-test SQLite files, not SQLite `:memory:`. | Modified configuration/runtime fixtures and file-path inspection. | Pass |
| `DurableWorkflowBoundaryTopology.invocationFingerprint` is required. | Type declaration and typecheck. | Pass |
| Missing boundary fingerprints cause typed rejection. | Repair regressions assert unchanged event history and successful reopen for memory and file SQLite. | Pass, current unit suite |
| Remove the retired recovery module, argument and pending fields. | Workflow source inspection and typecheck. | Pass |
| Remove remaining old-reader, alias and compatibility paths. | Source sweep, current-contract tests, unit/integration suites. | Pass |
| Inventory `legacy|compat|deprecat|migrat|upgrade|fallback` hits. | Requested `git grep` inventory; every path/line is listed with its reason in the commit body. Expanded inventory matches the actual hit list exactly. | Pass |
| `packages/coding-agent/docs/settings.md`. | Documents journal settings, exclusivity, relative paths, precedence and explicit memory. | Pass |
| `packages/coding-agent/docs/workflows/operations.md`. | Documents local storage, recovery, selection and memory limitations. | Pass |
| `packages/coding-agent/docs/workflows/api-reference.md`. | Documents exact `RunOpts.journal` choices and ownership. | Pass |
| `packages/coding-agent/docs/sdk.md`. | Documents local journal configuration and memory selection. | Pass |
| `packages/coding-agent/docs/sdk/web-server.md`. | Uses `journal: { memory: true }` and explains persistent selection. | Pass |
| `packages/coding-agent/docs/getting-started/installation.md`. | Describes the local journal without separate server setup. | Pass |
| `packages/coding-agent/docs/environment-variables.md`. | Documents `ATOMIC_WORKFLOW_JOURNAL_PATH`. | Pass |
| Remove all DBOS/Postgres mentions from user docs. | Case-insensitive full user-doc search returns no matches, including the docs changelog page. | Pass |
| User guides contain actionable guidance, not implementation or verification history. | Seven-guide review and docs check. | Pass |
| Coding-agent changelog records removed option/type/backend/aliases. | Existing Unreleased Breaking Changes subsection. | Pass |
| Workflows changelog records removed option/type/backend/aliases. | Existing Unreleased Breaking Changes subsection. | Pass |
| The removed `@bastani/workflows` alias names `@bastani/atomic/workflows` as its replacement. | Both Unreleased changelog sections. | Pass |
| No duplicate changelog headings or released-section changes. | Changelog diff inspection and unit tests. | Pass |
| Changelogs describe shipped behavior only. | Entry review; temporary implementation failures are recorded below instead. | Pass |
| Journal schema v1 names, event tags, encoding and lease constants remain unchanged. | The authorized amendment adds required `deleteOwnedRun(lease)` and a shared closed-error cause, without changing schema names or values. | Pass |
| Dense ordered sequence numbers. | Shared conformance and SQLite contention suites. | Pass |
| Keyed first-writer-wins returns the first entry without a second write. | Shared journal conformance, unit suite. | Pass |
| CAS mismatch writes nothing. | Conformance and backend acquisition tests. | Pass |
| Lease epochs fence stale writers and stale deletion. | Shared owned-deletion conformance and backend takeover interleaving preserve successor records and events. | Focused pass |
| Deletion retains epoch tombstones. | Shared journal conformance. | Pass |
| Counter violations retain their typed errors. | Kernel/conformance tests; unchanged contract types. | Pass |
| Text validation rejects NUL before malformed Unicode. | Kernel/conformance text tests. | Pass |
| JSON payload NULs and lone surrogates round-trip unchanged. | Kernel/conformance and process fixtures. | Pass |
| The meta table has exactly one schema row. | SQLite and caller-owned configuration tests. | Pass |
| Unknown schema versions are errors, not migrations. | Kernel/configuration version-error tests. | Pass |
| WAL, FULL synchronization, busy timeout and foreign keys remain configured. | SQLite configuration tests and unchanged kernel. | Pass |
| Writes are visible on fresh connections; interrupted transactions are atomic. | Kernel and contention integration suites. | Pass |
| Bun can open, append and read the journal. | Public SDK/kernel child fixtures. | Pass |
| Pause, quit, answer, resume, status, catalog, heartbeat and delivery still work. | Review regressions exercise actual async-only resume and completed tool replay; complete amended unit and integration suites pass. | Pass |
| Public SDK types compile using ES2022 default libraries. | Strict standalone consumer check and the extended repository runtime-surface consumer fixture. | Pass |
| Importing the public SDK does not load `node:sqlite`. | Built SDK import guard. | Pass |
| Coding-agent source keeps relative self-imports and established extensions. | Source diff and import-consistency unit tests. | Pass |
| Tests remain in the root test tree; Vitest includes do not widen. | Test/configuration diff inspection. | Pass |
| No dependencies or raw-TypeScript packaging rules change. | Manifest/lockfile/configuration diff inspection and full build. | Pass |
| No newly skipped tests, softened assertions or new imprecise production errors. | Added-lines audit and full test results. Existing skips remain unchanged. | Pass |
| Touched code is formatted. | Remote Biome runs, formatting replay and `git diff --check`. | Pass |
| Commit uses the feature branch, conventional breaking subject and required trailers. | Final Git commit/history inspection. | Commit deliverable |
| No push, PR, main edit, extra worktree or machine-specific committed data. | Git state and added-content audit. | Pass |

## Implementation decisions

The public `RunJournal` contract is asynchronous. Backend operations accept immediate or Promise results, while runtime callers await persistence. Internal synchronous capabilities preserve built-in acquisition and cached reads. Ownership queries for async-only journals probe actual acquisition availability under a temporary holder and release it before returning available; recovery, adoption and inspection await the query. A held foreign lease remains foreign. The user-authorized required `deleteOwnedRun(lease)` now performs atomic lease-fenced deletion in both journals. Backend owned deletion calls only that method. Unconditional deletion remains for administrative reset and kernel administrative tests.

The approved process-owner cache keys explicit files by resolved identity and caller-owned databases, supplied journals, and memory-option objects by object identity. Distinct memory-option objects remain isolated. Defaults resolve the current context before selecting a cached journal. Caller-owned journals are not closed by backend cleanup; owned journals are closed, and caller-owned database connections retain their existing non-closing rule.

## Initial implementation verification

All executable checks ran remotely. No local package installation, build, test, compiler or formatter was used.

| Command/check | Final result |
| --- | --- |
| `npm run check`, with coding-agent `dist` moved aside and restored | Pass |
| `npm run build` | Pass |
| `npm run test:unit` with default and JSON reporters | 883 files, 10,080 tests passed; 25 existing skips |
| `npm run test:integration` | 99 files, 1,198 tests passed; 2 files/12 tests already skipped |
| `npm run test --workspace=@bastani/atomic` | 704 files, 6,190 tests passed; 5 files/52 tests already skipped |
| `npm --prefix packages/coding-agent run docs:check` | 94 pages passed |
| `npm run test:scripts` | 15 tests passed |
| Strict ES2022 standalone consumer with TypeScript 7 `--ignoreConfig` | Pass |
| Extended `workflow-package-runtime-surface-typing.test.ts` consumer fixture | Pass |
| Built SDK import-time SQLite-load guard | Pass |
| Remote Biome plus `git diff --check` | Pass |

The consumer fixture was extended after the complete integration run and passed separately; no production source changed after the complete suite snapshot.

## Earlier failed attempts

- The missing-fingerprint regression failed before the fold validation with `AssertionError: Missing expected rejection.` It passed after implementation.
- Early fixture migration exposed lease/timer assumptions, eager test imports, startup ordering, and fault-injection seams. These were repaired without dropping preserved assertions.
- Running all three complete suites concurrently produced one integration child timeout and two coding-agent timeouts. Individually run final suites passed without budget changes.
- One final unit attempt reported an unexpected worker exit, with `subagents-foreground-intercom-detach.test.ts` absent from its completed-file list. Its cause was not established. A subsequent full unit run passed all 883 files, including all 16 tests in that file, with no unhandled errors.
- The first standalone consumer invocation was rejected by TypeScript 7 with TS5112 because files were passed alongside a repository config. Adding `--ignoreConfig` corrected the invocation; the strict ES2022 check passed.

## Consolidated review repair

The seven consolidated findings share three causes. The following rows supersede initial implementation pass claims where indicated.

| Cause | Regression or exact check | Current result |
| --- | --- | --- |
| Missing fingerprint was rejected after persistence. | `workflow-journal-review-regressions.test.ts` asserts a typed error, unchanged journal entries and successful reopen for memory and file SQLite. | Failed on baseline; passes after repair. |
| Reopened async-only journals treated unheld runs as foreign. | Same file tests foreign-owner refusal, release, available ownership, targeted discovery, actual resume and completed-tool replay. | Failed on baseline; passes after repair. |
| Custom deletion could erase a successor after takeover. | `journal-custom-delete-race.ts`, exercised by the root regression suite, checks exact stale-error fields through the ownership wrapper and a surviving running record. | Failed before authorized API change; passes after implementation. |

Initially, the exact `RunJournal` interface offered only unconditional deletion, so caller-side checks could not close the takeover race. The user then authorized required atomic `deleteOwnedRun(lease)`, superseding that blocker. Both journals check holder and epoch and delete atomically while retaining the fencing tombstone. SQLite uses a single immediate transaction. Backend deletion retains its existing `JournalOwnershipError` mapping with exact `StaleLeaseError` cause. No optional-method compatibility path is added.

### Repair validation

- Controlled reversal of the backend changes made all three new regression cases fail for the reviewed causes. Restoring the changes passed them. Focused backend/wiring/regression coverage passed 83 tests; root TypeScript check passed.
- The first complete repair unit run exposed discarded Promise authorization callbacks: 12 failed tests and 30 unhandled rejections. All control helper callers now await authorization. The following complete unit run passed 884 files and 10,083 tests, with the same 25 existing skips.
- Before the additional user amendments, full check/build, unit 884 files and 10,083 tests, integration 99 files and 1,198 tests, coding-agent 704 files and 6,190 tests, docs 94 pages, the ES2022 consumer fixture, scripts 15 tests and SDK lazy-import guard passed. These are historical results, not final amended gate claims.
- New conformance first reproduced missing `deleteOwnedRun` and started iterators silently continuing after close. Logical wrapper guards now reject even when a caller-owned SQLite connection remains open. Closed errors use `StorageUnavailableError` with the shared `JournalClosedError` cause; repeated close remains idempotent.
- After the async deletion change, 19 acquisition-interleaving tests exposed fixtures that discarded deletion promises before recreating records. Administrative fixture seeding now uses direct journal administrative deletion; all original guards/assertions remain. The amended focused suite passed 126 tests in four files; root typecheck and formatting passed. Final amended broad gates subsequently passed as listed below.
- The closed-state amendment is interpreted to take precedence over malformed input after close. The added invalid-input closed cases failed in all three storage modes before logical guards were moved ahead of validation. Open-journal NUL/Unicode precedence, typed validation fields, no-SQL checks and no-mutation assertions remain. Existing kernel closed-state expectations were updated to the newly required exact storage error and closed cause.
- One unchanged interactive-engine isolation heartbeat test exceeded its existing 100 ms assertion during a failed full attempt. The following complete unit suite passed without changing that test or its budget. Its transient cause was not established.
- Final amended unit verification passes 885 files and 10,117 tests, with the same 25 existing skips. Final integration passes 99 files and 1,198 tests, with 2 files and 12 tests already skipped. Final coding-agent verification passes 704 files and 6,190 tests, with 5 files and 52 tests already skipped. No new skips, weakened assertions, or timeout changes were introduced.
- Optional quality CLI installation was attempted once with a bounded setup timeout and did not complete; no quality CLI analysis is claimed. Repository Biome/typecheck remains authoritative. One failure-capture download encountered the local disk reserve; command stdout and retained remote logs remain evidence, and no user data was removed.

### Final amended gates

All executable validation ran remotely. Formatting patches were replayed into the feature checkout. Only implementation notes changed after the final executable snapshot.

| Command or check | Result |
| --- | --- |
| `npm run check`, coding-agent `dist` moved aside and restored | Pass |
| `npm run build` on the final production source | Pass |
| `npm run test:unit` | 885 files, 10,117 tests passed; 25 existing skips |
| `npm run test:integration` | 99 files, 1,198 tests passed; 2 files/12 existing skips |
| `npm run test --workspace=@bastani/atomic` | 704 files, 6,190 tests passed; 5 files/52 existing skips |
| `npm --prefix packages/coding-agent run docs:check` | 94 pages passed |
| `npm run test:scripts` | 15 tests passed |
| Focused amended journal/public SDK/entrypoint suite | 65 tests passed; Node and Bun public conformance included |
| Node resolver hook rejecting `node:sqlite` during built public SDK import | Pass |
| Consumer ES2022 fixture | Passed in the complete integration suite |
| Scoped Biome, including fixture stdin formatter comparison | Pass |
| Source keyword inventory versus prior exact hit list | Identical; full inventory retained in follow-up commit body |

The retired recovery code, docs, changelog, schema and import constraints remain covered by the complete gates and prior source inspections. The only public journal contract change is the explicitly authorized deletion method and shared typed closed cause. Close stays idempotent; closed-state errors precede invalid arguments, while open-journal validation behavior is preserved.

## Async journal review repair

The next consolidated review confirmed the preceding repairs and identified two Promise-result defects. These rows and the final checks below supersede the prior readiness evidence for the changed paths.

| Required behavior | Durable regression | Current result |
| --- | --- | --- |
| Delayed cached-stage prompt and complete observe metadata rejection immediately without losing the original typed failure. | `workflow-journal-async-results.test.ts` runs strict Node children through the built public SDK. | Four baseline children terminated with the original storage error; all four cases pass after containment and in final validation. |
| An unused cached-stage handle and explicit exit cannot discard its already-started metadata write failure. | The same fixture checks workflow failure, one metadata write and no unhandled rejection for unused and exit branches. | Pass, including the complete unit gate. |
| Valid cross-realm Promise results persist registration before reporting success and retain replay. | `workflow-journal-cross-realm.test.ts` runs shared conformance and backend execution against actual promises from `node:vm`. | Baseline conformance passed 15 cases, but backend registration failed with zero events and an unhandled lease error. All 16 cases pass after repair and in the complete unit gate. |

The test authoring gate protects observable workflow completion and host survival, not internal method calls. Existing tests awaited cached-stage use immediately and used same-realm promises, so neither regression was covered. No production-only test seam or journal restriction is added.

Cached handles immediately observe their one persistence result while preserving it for prompt and complete. The engine tracks those already-started writes in its existing completion and exit lifecycle; it does not defer writes or expose a new queue or flush API. Supervisor guidance on this containment pattern is implementation guidance, not a user amendment.

The two new suites pass 20 tests together, and root TypeScript checking passes. The strict child cases assert zero unhandled rejections, the same typed error in prompt/complete, the original workflow error for all branches, one metadata write and one live callback across execution/replay. All three same-realm Promise checks in the backend were audited and replaced with callable-then detection; yielded results are normalized with `Promise.resolve` before execution continues. No public API or journal schema changes are made by this repair.

| State or transition | Invariant and evidence |
| --- | --- |
| Cached handle created; metadata write pending | The write starts once and has an immediate rejection observer. Strict child checks one metadata append. |
| Pending write rejects before handle use | Delayed prompt and complete rethrow the same stored typed error; the host emits no unhandled rejection. |
| Rejected write; handle unused or workflow exits | Existing completion/exit finalization produces the storage failure, never successful completion. |
| Cross-realm promise pending to fulfilled | Backend continuation waits for the fulfilled lease/write value; registration has a persisted RunStarted event and readable projection before success. |
| Completed custom-journal execution to replay | Tool and stage callbacks each execute once across both runs. |

### Final async repair validation

All executable checks ran remotely. Production source remained unchanged after the complete suite snapshot. The fixture-only formatting replay was rechecked with its 20 focused cases and the complete check gate.

| Command or scenario | Final result |
| --- | --- |
| `npm run build` | Pass |
| `npm run check`, coding-agent `dist` moved aside and restored | Pass, including the post-format check |
| `npm run test:unit` | 887 files, 10,137 tests passed; 25 existing skips |
| `npm run test:integration` | 99 files, 1,198 tests passed; 2 files/12 existing skips; ES2022 consumer included |
| `npm run test --workspace=@bastani/atomic` | 704 files, 6,190 tests passed; 5 files/52 existing skips |
| `npm --prefix packages/coding-agent run docs:check` | 94 pages passed |
| `npm run test:scripts` | 15 tests passed |
| Focused async/default/review/conformance suites | 5 files, 77 tests passed |
| Final two new suites after formatting replay | 2 files, 20 tests passed |
| Adapted original reviewer stage scenario in strict Node | Zero unhandled rejections; failed workflow result; one callback across replay |
| Built public SDK import with a resolver hook refusing `node:sqlite` | Pass |
| Scoped Biome and fixture stdin-format comparison | Pass; replayed into the checkout |
| Requested source keyword inventory | Identical to the prior complete inventory; retained in commit body |

The first complete coding-agent attempt timed out in two unchanged SQLite-selector tests. Both files then passed 37 focused tests, and the complete suite passed without edits, exclusions, timeout changes or worker limits. The transient timeout cause was not established. An initial fixture-format comparison failed on whitespace; the formatter output was replayed and the final comparison passed. Existing informational Biome diagnostics remain unchanged; no warnings or errors block the check. No additional quality-CLI setup was attempted after the earlier bounded timeout.

## Contract amendments received

User amendment received during review repair:

> in-memory storage is supported but is NEVER the default. With no RunOpts.journal, no ATOMIC_WORKFLOW_JOURNAL_PATH and no workflows.journal setting, every run entry point (TUI/CLI, slash command, workflow tool, SDK run(), background and resume) must resolve the persistent SQLite journal at the default path. MemoryRunJournal is selected only by an explicit `{ memory: true }` / a passed MemoryRunJournal / `workflows.journal.memory: true`. No code path may fall back to memory when the file can't be opened (raise the typed error). Your current resolveRunJournal already matches this; keep it that way across all entry points, and add or keep a test proving that default resolution through each public entry point yields a SqliteRunJournal at the default path, never memory. Tests and helpers may choose memory explicitly. Docs must describe memory as an opt-in for tests or ephemeral runs, not the default.

> add a REQUIRED `deleteOwnedRun(lease)` method to the public RunJournal interface. It deletes the run atomically ONLY if that lease (runId, holderId, epoch) still holds it; otherwise it throws the typed StaleLeaseError {runId, heldEpoch, currentEpoch} and deletes nothing. Implement it in SqliteRunJournal (one BEGIN IMMEDIATE transaction: check lease holder and epoch, then delete with the same tombstone semantics as today) and MemoryRunJournal (equivalent atomic check-and-delete), add it to the shared registerRunJournalConformance suite (cases: owner deletes; a stale lease after takeover throws StaleLeaseError with the successor's run and events intact; the tombstone still fences a recreated run), and make JournalDurableBackend use only deleteOwnedRun for owned deletion (no unconditional deleteRun on any ownership-sensitive path). Keep the existing unconditional deleteRun for administrative deletion only if something genuinely needs it; otherwise remove it, and say which in the commit body. RunJournal is unreleased, so there's no compatibility path. Update the custom-journal docs and the packages/workflows changelog Added entry for RunJournal to describe deleteOwnedRun as part of the interface (append to the existing Unreleased subsection). Add the reviewers' interleaving as a regression: renew succeeds, a successor takes over and appends, then the old owner's delete raises StaleLeaseError and the successor's data survives.

> draw on upstream pi-durable (@earendil-works/pi-durable, packages/durable) where relevant. Applied to this slice: since you're already extending registerRunJournalConformance for deleteOwnedRun, add the pi-durable storage-conformance cases our session-store suite already has but the run-journal suite lacks (packages/workflows/src/durable/journal/conformance.ts): (1) detachment: mutating an event payload or run header object after append/createRun, and mutating entries returned by read/readKey/listRuns, never changes stored data (re-read and compare); (2) after close(), every operation (including a second close, if the contract says close is idempotent then assert that instead) rejects with the journal's typed closed or storage error, never silently succeeding; (3) all-or-nothing: an append rejected by expectSeq CAS, a stale lease or a text-validation error leaves no partial row, seq gap or status change, and a failed deleteOwnedRun leaves the run and its events intact. Run them against both SqliteRunJournal and MemoryRunJournal. Use typed errors, and add a typed JournalClosedError only if none exists (reuse StorageUnavailableError semantics if that's what closed journals already raise, and keep it consistent across both journals). Don't copy pi-durable's single-process-owner model: Atomic needs leases and epochs because several processes share one journal file.

The latter two user amendments authorize a changed public journal contract and additional conformance cases. The earlier deletion blocker is superseded by this authorization. Code and user guides describe the behavior without comparative implementation discussion.

The latest reviewer artifacts also report a user-authored bounded-review amendment: blocking findings are limited to slice or binding-decision violations and reproduced correctness or data-loss defects in changed code, not hypothetical beyond-contract features or style. This is an inherited summary from reviewer traceability, not a verbatim quotation; exact source wording was unavailable in the current artifacts. Both Promise findings are reproduced correctness defects in changed code.

| Amended requirement | Evidence | Status |
| --- | --- | --- |
| Default SQLite selection through SDK, background, extension dispatch, TUI slash, CLI slash, workflow tool and resume. | `workflow-journal-default-entrypoints.test.ts` clears the injected backend, isolates Atomic home, omits journal/environment/settings selection, and asserts `SqliteRunJournal`, exact default path and persistent state. | 8 focused tests pass |
| Memory requires explicit selection. | Existing resolver/wiring tests cover memory options, a supplied memory journal and settings memory. | Pass |
| Opening failure never selects memory. | Default-path directory failure and existing configured-path failure tests assert typed storage rejection and no installed backend. | Focused pass |
| User guides describe memory only as opt-in. | Existing settings, API and operations guidance; SDK now explicitly identifies tests and ephemeral runs. | Inspected |
| Required atomic `deleteOwnedRun(lease)` in both journals. | Shared conformance checks owner deletion, stale takeover rejection with exact error fields, and recreation tombstones. | Focused pass |
| Owned backend deletion uses only the required journal method. | Adversarial renewal/takeover regression and source audit; administrative reset retains unconditional deletion. | Focused pass |
| Public custom-journal docs and existing Added entry describe the new method. | API reference, SDK guide and workflow changelog updated without released-section changes. | Inspected |
| Detached original and returned values. | Shared conformance mutates headers, payloads, append result, read, keyed read and list results, then rereads. | Pass for both journals and caller-owned connection |
| Closed journals reject every operation and started iterators, with idempotent close. | Shared conformance including a caller-owned SQLite wrapper; caller connection remains usable afterward. | Focused pass |
| Failed CAS, stale lease, invalid text and owned deletion leave state unchanged. | Shared conformance compares history, status, next sequence and successor data. | Focused pass |

## Deferred observations

Contributor setup prose differs from current repository instructions. It is outside this slice and remains unchanged.
