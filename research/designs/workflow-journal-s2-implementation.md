# S2 implementation notes

## Goal and frozen acceptance matrix

Implement only the unwired `JournalDurableBackend`, persist before returning, rebuild its projection from journal events, verify it on Boat, and commit on `feat/workflow-journal-s2-journal-backend`.

The table refines the original pre-edit matrix into individual clauses without adding scope. `C` denotes the final check/format run, `F` the final focused run, `U` the established unit gate, and `D` the final diff/commit audit. Their results are recorded below.

| Contract clause | Verification |
| --- | --- |
| S2 only, one combined change, unwired | D: factory, runtime call sites, package manifests and settings unchanged |
| New `packages/workflows/src/durable/journal/journal-backend.ts` | D and C: file implements `DurableWorkflowBackend` |
| Backend operates directly on `RunJournal` | C and D: constructor accepts `RunJournal & SynchronousRunJournal` |
| Typed event appends | F: checkpoint, status, prompt, message and summary scenarios; D: exported event constants used |
| Fold into existing in-memory projection | F: runtime suites and persisted replay; D: `applyWorkflowSnapshot` replaces snapshots exactly |
| Open rebuilds from `read()` | F: fresh-process fixture; D: asynchronous open iterates `journal.read()` |
| Writes resolve only when durable | F: synchronous checkpoint visible to fresh connection before any flush; async checkpoint idempotency |
| No flush queue | D: synchronous append followed by fold; required `flush()` is a no-op readiness boundary |
| Status claims use `expectSeq` | F: injected competing append wins, losing claim returns false and adds no second status row |
| Preserve transition boolean results and expected timestamp/status semantics | F: success, status mismatch, stale timestamp and CAS conflict |
| Per-process holder identity | D: process UUID namespace and backend-instance UUID prevent separate backend instances sharing ownership accidentally |
| Lease renewal uses existing cadence | F: fake-clock renewal at `STAGE_SESSION_HEARTBEAT_INTERVAL_MS`, 30,000 ms |
| Stale-holder takeover | F: expiry after `FOREIGN_LIVE_WORKFLOW_WINDOW_MS`, 120,000 ms; transaction checks current renewal time |
| Stale appends rejected | F: takeover advances epoch and old writer contributes no event |
| Map stale lease into existing ownership handling | F: `JournalOwnershipError` retains `StaleLeaseError` cause and its fields; `classifyControlError` returns `owned_elsewhere` |
| Omit storage-specific optional members | D: no admission settlement/reconciliation, cancellation/probes, enrollment, execution view, or inspection-cost hydration variant |
| Simplest correct required members remain | F: runtime suites use immediate persistence, required hydration and no-op flush |
| Backend-agnostic durable suites use temp journal databases | F: 15 backend-consuming suites import the shared temporary-backend constructor; assertion bodies unchanged |
| Enumerate all selected durable suites in commit | D: exact list below and commit body |
| Fresh process writes, closes and reopens identical catalog/checkpoints | F: two `bunExecutable()` children run `test/fixtures/journal-backend-child.ts`, compare complete JSON snapshots |
| First-writer-wins checkpoint identity | F: changed duplicate `(kind, checkpointId)` returns original output and leaves journal entries unchanged |
| Two backends on one file, second cannot append to held run | F: default holders differ; typed rejection, unchanged journal and projection checkpoints |
| Expiry takeover rejects first holder | F: exact old/new epoch and typed cause fields |
| Lease handoff must not overwrite a newer projection | F: already-open receiver retains checkpoints, summary and prompt tokens before its status write |
| Prompt state survives status changes and reopen | F: unchanged-count status snapshot retains active token identity; release settles count; old generation cannot release newer reservation |
| Catalog and required hydration reflect deletion/recreation | F: deleted catalog entries disappear; reused run id rebuilds only its new checkpoints |
| Local-only `node:sqlite` storage | D: no shared-host store or new runtime selector |
| Default path remains `join(dirname(getAgentDir()), "workflows", "journal.sqlite")` | F: inherited kernel path tests; D: path function unchanged |
| `ATOMIC_WORKFLOW_JOURNAL_PATH` override remains unchanged | F: inherited kernel path tests; D: no path normalization added |
| WAL, FULL sync, busy timeout and foreign-key pragmas retained | F: inherited kernel/process tests; D: SQLite boundary unchanged |
| Schema version 1, unknown version hard error, no migration | F: inherited kernel schema tests; D: schema initialization unchanged |
| Exported schema/table/column/event/encoding/lease constants and types retain identity | C and D: no constant or existing type changes; synchronous capability is additive |
| Lease tombstone preserves monotonically increasing epoch after deletion | F: inherited kernel fencing tests and backend stale-deletion regression; D: shared deletion body retains tombstone |
| `seq` and `epoch` remain safe integers in `0..Number.MAX_SAFE_INTEGER` | F: inherited range matrix; expiry grant uses the same checked increment |
| Range errors retain exact class and fields | F: `JournalCounterRangeError { runId, field, value, reason }`; additive checkpoint path propagates it rather than hiding it |
| Identifier Unicode/NUL rules and NUL precedence remain unchanged | F: inherited kernel and Node/Bun process matrices; D: synchronous companions delegate shared validation bodies |
| Payload/header JSON retains NUL and lone surrogates | F: fresh-process fixture and raw checkpoint/message round trips |
| Exactly one metadata row and typed corruption error | F: inherited kernel `JournalMetaCorruptError { path, rowCount }` tests |
| `StatusChanged` is a full snapshot, latest sequence wins | F: direct metadata payload, conflicting claim and reopened handle checks |
| Optional absent fields omitted from JSON | F: raw status payload lacks owner, release, failure, session and resumability fields when absent |
| No invented null or `"undefined"` optional metadata values | F: raw payload key checks; D: normal JSON omission, no sentinel substitution |
| Omitted owner means no owner | F: status claim omits owner and reopened projection has no owner |
| Keep named return shapes | C and F: existing `RunJournal` Promise methods and AsyncIterable read retained; lease outcomes retain exact fields |
| Preserve raw text, array order and duplicates | F: NUL/surrogate strings, `[2, 1, 2]`, duplicate pending messages and verbatim timestamp strings |
| Preserve existing projection checkpoint ordering | F: reverse completion timestamps reopen in the same completion order; journal fold remains sequence ordered |
| No new replay semantics, child journals or session JSONL changes | D: no authoring, session persistence or engine edits |
| No dependencies or competing lockfiles | D: manifests and lockfiles unchanged; wrapper uses `npm ci --ignore-scripts` when setup is needed |
| Raw TypeScript, `.js` imports, no build step added | C and D: no generated outputs or build configuration changes |
| No `any`, no `unknown` added outside SQLite boundary | C and D: authored source/test inspection; adapter unchanged |
| Named errors, fields and third-party storage causes retained | F: ownership and counter fields; inherited storage boundary tests; D: abort/closed/message-scope errors are named subclasses |
| Vitest and `node:assert/strict` | F and D: all new assertions use repository style |
| Runtime helpers and explicit Bun executable | F and D: new helper/fixture tests use `test/helpers/runtime.ts` |
| Each test owns a temporary database | D: shared cleanup constructor allocates per instance; intentional competing instances share only within one test |
| No authored skips or soft guards | F: all focused tests execute; D: no skip/guard additions |
| `npm run format` on touched files | C: clean formatter rerun; formatting patch applied locally using git |
| No unnecessary explanatory source comments | D: no new source comments |
| `npm run check` | C: Biome, workspace/root typechecks and shrinkwrap check |
| Unit gate | U: exact command below, only the two established exclusions |
| Slice-specific tests | F: selected durable suites plus kernel process integration |
| `git diff --check` | D and C: whitespace audit |
| Correct slice branch and conventional breaking subject | D: signed commit inspection on `feat/workflow-journal-s2-journal-backend` |
| `Assistant-model` reflects actual model | D: `GPT-6.1 Sol (ultrafast)` |
| Explicit workflow trailer override | D: `Assistant-workflow: dbos-journal-stack` |
| Verification trailers describe checks actually run | D: passing gates and reproduced RED scenarios identified separately |
| Required preference and co-author trailers | D: exact three `User-preference` lines and `Co-authored-by: Norin Lavaee <nlavaee@umich.edu>` |
| All work committed, clean tree | D: final workflow receipt carries commit id and `git status --porcelain` result |
| No push, PR, main changes or additional worktree | D: only designated branch and checkout used |
| Heavy commands only on assigned Boat lease, from worktree root | C, F, U: supplied implementer wrapper; no local npm/compiler/formatter/tests |
| No lease creation, stopping, deletion or handoff | D: only `crabbox run --keep` on the assigned static lease |
| Ignored scratch setup occurs inline on Boat | D: optional qlty executable downloaded into remote `.crabbox/`; no repository config changes |
| User guides/changelog remain scoped | D: unwired S2 adds no actionable user guidance; S6 documentation remains untouched |

## Interface and state decisions

The supervisor approved `SynchronousRunJournal` companion operations because the runtime backend requires synchronous registration, status, checkpoint and prompt operations. Existing Promise-returning `RunJournal` methods and AsyncIterable `read()` remain unchanged and share operation bodies with the companions. Asynchronous open rebuilds through `read()`; synchronous writes and incremental refresh use `readEntries()`. No schema, event, encoding or lease constant changed.

Required/optional workflow fields keep their existing types. Status events contain direct full metadata snapshots. Owner omission clears ownership metadata on fold. No identifiers, caller paths or payload text are normalized. Checkpoint identity remains `(kind, checkpointId)` within one run. Duplicate checkpoint writes preserve the first payload; other lists retain their order and duplicate values. Completion-order getters retain their current behavior, while journal replay uses sequence order.

Legal ownership states and transitions:

- Absent run: register header, acquire ownership, append start snapshot.
- Unheld run: acquire next epoch. Passive reads do not acquire.
- Held/fresh: only its holder/epoch can append, renew or delete. A competitor writes nothing and receives a typed ownership error.
- Held/expired: atomic expiry-checked takeover grants a higher epoch. Renewal and takeover contend in a transaction.
- Lost: retain the stale lease and typed error; never silently reacquire that execution's authority.
- Released/closed: stop renewal, release owned leases, close the connection. Reopen folds persisted events.
- Deleted/recreated: keep the kernel epoch tombstone; required hydration discards the removed projection and rebuilds the new identity's events.
- Status mismatch returns false without a new event. A CAS loser adds no event and refreshes the winner. A successful claim writes a full snapshot with sequence CAS.
- Prompt generations survive unrelated status snapshots. A changed authoritative pending count resets the reservation projection; unchanged counts retain identities.

## Commands and evidence

All executable checks ran on Boat using the supplied implementer wrapper. The Mac performed file reads/edits and git operations only. Final source check/format and focused evidence is `run_6cdc9eb220e1acbe89573f59a9bbf814`: formatting reported no fixes, `npm run check` passed, and 20 focused files passed all 298 tests with no skips. That includes 17 new backend tests, 118 existing runtime assertions using temporary journal backends, 151 kernel tests, eight pure helper tests and four process-integration tests. The final unit gate also passed on this source in `run_60ac3775f2250f771efdb0a829c4423e`.

The checked backend, SQLite journal and focused-suite git blob hashes respectively match the local checkout: `1292cc4b54f25e9a9726f3d5bbca2feb4820bda6`, `d2f54bf234344647028be4772bc64019d12a5763`, `eb1ca7312b1a10280d7ab7a13f0efccdfc211243`.

Focused command:

```sh
files=$(git ls-files 'test/unit/durable-*.test.ts' | xargs grep -LiE 'dbos|postgres')
npx vitest --run $files test/integration/durable-sqlite-run-journal-contention.test.ts
```

Established unit gate:

```sh
npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts
```

The wrapper applies these two established environment-specific exclusions before invoking the unit project. No repository test configuration was changed. Final-source unit run `run_60ac3775f2250f771efdb0a829c4423e` passed 930 files and 10,542 tests, with 26 pre-existing skips. No new test was skipped or guarded. The earlier run `run_7029bddc4e809130c744a36718a02037` passed 10,539 tests before the last three state-transition regressions were added; final evidence supersedes it.

Durable regression evidence:

| Reproduction | RED evidence | Persisted check |
| --- | --- | --- |
| Initial missing backend | `run_e7ffdefbb59b57c1fb4f9b4b8b040d68` | Durable fresh-reader tracer |
| Stale-holder deletion | `run_e1a35075100a78976190c9f7103a236d` | Atomic lease-checked deletion test |
| Direct full status metadata | `run_59ee031d10f6ec7eef7af69a9b360eba` | Raw status snapshot fields and owner omission |
| Additive counter error suppression | `run_65b38a07cfc8ccfb6c1ffc5797735bc9` | Exact counter class/field propagation |
| Prompt token loss on status update | `run_844053a00f7b27e8deec4b7b812fed19` | Status/reopen/release transition |
| Stale metadata at lease handoff | `run_e370b14cc06bbfc7eeb9f4e105f20c98` | Released-holder transfer preserves checkpoint/summary/prompt state |
| Deleted catalog entry retained | `run_e4766557530eee5b60a4d33f43428ab0` | Catalog deletion and repeated run-id hydration |

The early typecheck caught four unsafe payload assertions in `run_35d8cb41925d7ac025a65e766f78f032`; subsequent check runs passed. Formatting consistency checks intentionally stopped when formatting patches were pending; those patches were applied before rerunning. Failures were not suppressed.

Qlty 0.654.0 ran built-in function metrics on Boat using the existing `.qlty/qlty.toml`, most recently in `run_6cdc9eb220e1acbe89573f59a9bbf814`. Its executable/archive were installed only in remote ignored scratch storage. No plugin rollout or repository configuration change was made. The new backend has no pre-change baseline; inherited journal method bodies retain their prior behavior. Metrics supplement, not replace, `npm run check`.

The local commit skips only the `format` and `check` hooks with documented `PREK_SKIP=format,check`, because those commands must run on Boat. Their full equivalents passed there. Lightweight built-in git checks remain enabled. The completion receipt records the signed commit and clean worktree audit.

## Selected durable suites

All 19 selected unit filenames are enumerated here and in the commit body. Fifteen existing suites use the shared temporary-backend constructor. The new focused suite allocates its own temporary databases. The kernel and two pure helper suites retain their own subjects.

- `test/unit/durable-cached-child-reconcile-guards.test.ts`
- `test/unit/durable-completed-catalog-topology.test.ts`
- `test/unit/durable-completed-catalog.test.ts`
- `test/unit/durable-journal-backend.test.ts`
- `test/unit/durable-legacy-root-reconcile.test.ts`
- `test/unit/durable-local-command.test.ts`
- `test/unit/durable-repeated-child-replay.test.ts`
- `test/unit/durable-replay-selector.test.ts`
- `test/unit/durable-resume-flush-retry.test.ts`
- `test/unit/durable-resume-hydration-continuation.test.ts`
- `test/unit/durable-resume-worktree.test.ts`
- `test/unit/durable-retention-policy.test.ts`
- `test/unit/durable-root-child-fixes.test.ts`
- `test/unit/durable-round1-completed-validation.test.ts`
- `test/unit/durable-sqlite-run-journal.test.ts`
- `test/unit/durable-stage-frontier-fixes.test.ts`
- `test/unit/durable-stage-primitive.test.ts`
- `test/unit/durable-stage-session-resume.test.ts`
- `test/unit/durable-ui-primitive.test.ts`

## Contract amendments received

None during implementation. The launch contract explicitly requires `Assistant-workflow: dbos-journal-stack`.

## Deferred observations

Existing unrelated Biome `useTemplate` informational diagnostics were left unchanged. No product additions or other slice work were added. User guides and release notes remain assigned to S6.
