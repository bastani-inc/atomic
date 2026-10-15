# S2 implementation notes

## Goal and frozen acceptance matrix

Implement only the unwired `JournalDurableBackend`, persist before returning, rebuild its projection from journal events, verify it on Boat, and commit on `feat/workflow-journal-s2-journal-backend`.

The table refines the original pre-edit matrix into individual clauses without adding scope. `C` denotes the current repair check/format run, `F` its focused run, `U` its established unit gate, and `D` its final diff/commit audit. Historical implementation receipts are explicitly separated below; current results are in the review-repair section.

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
| Lease handoff must not overwrite a newer projection | F: ordinary handoff plus no-hydration deleted/recreated shorter, equal and longer journals; observer/fresh handles, checkpoints and raw status agree |
| Prompt state survives status changes and reopen | F: unchanged-count status snapshot retains active token identity; release settles count; old generation cannot release newer reservation; replacement tokens survive while deleted tokens disappear |
| Catalog, hydration and accepted mutations reflect deletion/recreation | F: deleted catalog entries disappear; recreated mutations rebuild all state without caller hydration; stale held leases remain fenced |
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
- Unheld run: rebuild the complete current journal before evaluating cached state, acquire next epoch, and rebuild again under the new lease before caching ownership. Passive reads do not acquire.
- Held/fresh: only its holder/epoch can append, renew or delete. A competitor writes nothing and receives a typed ownership error.
- Held/expired: atomic expiry-checked takeover grants a higher epoch. Renewal and takeover contend in a transaction.
- Lost: retain the stale lease and typed error; never silently reacquire that execution's authority.
- Released/closed: stop renewal, release owned leases, close the connection. Reopen folds persisted events.
- Deleted/recreated: keep the kernel epoch tombstone. Unowned refresh and each new acquisition discard the removed projection, sequence, prompt reservations and message accounting before replaying the replacement. Do not infer incarnation from journal length; equal and longer replacements also need clean replay. Retained stale leases are never cleared or reacquired by this refresh.
- Status mismatch returns false without a new event. A CAS loser adds no event and refreshes the winner. A successful claim writes a full snapshot with sequence CAS.
- Prompt generations survive unrelated status snapshots. A changed authoritative pending count resets the reservation projection; unchanged counts retain identities.

## Commands and evidence

The original implementation gates below are historical evidence for `e1a64e868a488a68870c2077a87ce67b15d464b4`, not validation of the review repair. They passed but did not prove recreation-safe accepted mutations. The earlier recreation test explicitly hydrated first; the ordinary handoff test did not delete/recreate the id. Neither justified the previous broad recreation claim. Current repair evidence is recorded separately below.

Original source check/format and focused evidence is `run_6cdc9eb220e1acbe89573f59a9bbf814`: formatting reported no fixes, `npm run check` passed, and 20 focused files passed all 298 tests with no skips. That includes 17 backend tests, 118 existing runtime assertions using temporary journal backends, 151 kernel tests, eight pure helper tests and four process-integration tests. The original unit gate passed in `run_60ac3775f2250f771efdb0a829c4423e`.

The original backend, SQLite journal and focused-suite git blob hashes were respectively `1292cc4b54f25e9a9726f3d5bbca2feb4820bda6`, `d2f54bf234344647028be4772bc64019d12a5763`, `eb1ca7312b1a10280d7ab7a13f0efccdfc211243`. Current repaired artifact hashes are recorded with the repair audit.

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

Qlty 0.654.0 originally ran built-in function metrics on Boat using the existing `.qlty/qlty.toml` in `run_6cdc9eb220e1acbe89573f59a9bbf814`. Its executable/archive were installed only in remote ignored scratch storage. No plugin rollout or repository configuration change was made. Metrics supplement, not replace, `npm run check`; the current repair metrics are below.

The local commit skips only the `format` and `check` hooks with documented `PREK_SKIP=format,check`, because those commands must run on Boat. Their full equivalents passed there. Lightweight built-in git checks remain enabled. The completion receipt records the signed commit and clean worktree audit.

## Review repair: all three consolidated P1 findings

The completion, evidence and risk findings at review lines 1134–1193 share one root: an unowned observer used the deleted incarnation's sequence as the replacement's replay cursor. After acquiring the replacement lease, a status mutation copied the deleted handle into a durable full snapshot. Lease epoch fencing worked; cache incarnation isolation did not.

The repair extracts the existing complete hydration replay into a synchronous internal `rebuild`. Unowned refresh rebuilds instead of trusting its old cursor. A newly acquired lease rebuilds again before being cached, so mutations that append directly also start with the current projection. Held leases retain incremental refresh and existing stale-epoch rejection; no schema, constants, Promise/AsyncIterable identity, public interface, dependencies or runtime wiring changed.

Authoring gate: the exact shorter-journal test protects accepted mutations without undocumented hydration; equal/longer variants protect against sequence-length heuristics and leaked checkpoint/prompt/message maps; stale-lease and deleted-only cases protect the ownership/no-op boundaries. Existing hydration-only and ordinary handoff cases do not cover these transitions. All exercise existing public backend/journal methods without adding a production test seam.

| Finding / invariant | Durable regression and evidence |
| --- | --- |
| Completion P1: reset cached incarnation before acquisition | Exact cached seq4 → replacement seq2 → direct `setWorkflowStatus` test; independent reviewer executable rerun |
| Evidence P1: no deleted projection after recreated lease | Observer and fresh reader agree on new inputs, name, creation time, checkpoints/count and summary; raw final status equals the current full snapshot |
| Risk P1: detect replacement independently of sequence length | Equal seq8 and longer seq9 replacement variants clear old checkpoints, prompt identities, settled messages, receipts and delivery counts; new prompt token still releases |

RED `run_d56087e20655dba186c80ddf3791c712`: independent `bun .crabbox/completion-recreation.ts` and persisted focused regression both failed with identity old instead of new. Focused suite: 17 passed, 1 failed. Raw replacement events were seq1/epoch2 new inputs/createdAt5, seq2/epoch2 new checkpoint, then seq3/epoch3 old inputs/createdAt1/summary old. Observer retained checkpoint old; fresh fold contained checkpoint new. Logs: `.crabbox/s2-repair-scratch-red.log`, `.crabbox/s2-repair-red.log` on Boat.

Initial GREEN `run_7bf6f4531596544cc14c31f81d897973`: all 18 focused tests passed and the independent executable passed. Its raw seq3/epoch3 status retained new inputs/createdAt5 and no old summary; observer/fresh checkpoints were both new. Logs: `.crabbox/s2-repair-green.log`, `.crabbox/s2-repair-scratch-green.log`. Equal/longer variants then passed in `run_7ff9cb460eb57601e11ef5d7c7a8785a` (20 tests; `.crabbox/s2-repair-variants.log`). Final gates and artifact audit follow after all boundary cases.

Expanded baseline confirmation `run_e40f4f2ac1d8a6df4f58fae2cacdd095` temporarily restored the exact original backend blob `1292cc4b54f25e9a9726f3d5bbca2feb4820bda6` on Boat with a restoration trap. Six relevant cases failed as intended (18 passed): shorter/equal metadata corruption, longer stale checkpoints, deleted-only erroneous `RunNotFoundError`, stale status-claim preconditions and skipped delivery accounting. Restoring the repaired backend made all 24 tests pass, including the retained stale-lease case. Logs: `.crabbox/s2-repair-all-baseline-red.log`, `.crabbox/s2-repair-all-green.log`. No failing test was suppressed or weakened.

The stale-lease regression checks exact `JournalOwnershipError`/`StaleLeaseError` fields, unchanged journal, no silently reacquired holder, and the same lost error even after explicit hydration. The deleted-only case preserves absent-run no-op/false/not-found results and permits later registration. The first-mutation claim and receipt variants cover precondition checks and direct append paths independently of the status draft path.

Formatting run `run_ccc42e3ba5e49f45e07727c3921965af` formatted 3431 files and fixed only the touched focused test. Its formatting-only edits were applied locally; backend/test hashes are `e829b7380102f5498cb9e8cea32ede87eb743a38` and `7826bb63a9ea908f24f4324a5c761adac6ba493d`.

### Current repaired-source final gates

All heavy execution used only the supplied implementer Boat wrapper, sequentially, from this checkout. No local npm, compiler, formatter or test command ran. The complete current check/focused log is `/tmp/s2-repair-final-check.log`; the exact unit gate log is `/tmp/s2-repair-final-unit.log`.

| Gate | Current result |
| --- | --- |
| C: `npm run format` and no-diff rerun | `run_d7506593d97e647cae3a3dc3ce1f7fcc`: 3431 files, no fixes; `git diff --exit-code` passed |
| C: `npm run check` | Same run: Biome (five existing informational diagnostics), root/workspace typechecks and published shrinkwrap check passed |
| F: exact selected durable command above plus process integration | Same run: all 19 selected unit files and the integration file, 20 files / 305 tests passed, no skips; all 24 backend tests executed |
| Independent reviewer executable | Same run: `bun .crabbox/completion-recreation.ts` passed; observer/fresh inputs and checkpoints are new, raw final status is from the replacement |
| U: exact established unit command above, run separately alone | `run_edcc38795f1362c5b977310317de1ed7`: 930 files / 10,549 tests passed, 26 pre-existing skips; wrapper logged exactly two authorized exclusions; duration 122.65s |
| Supplemental qlty metrics | `run_d7506593d97e647cae3a3dc3ce1f7fcc`: cached qlty 0.654.0 built-in function analysis passed with existing config; rebuild cognitive complexity 1, refresh 2, maximum backend cognitive complexity 10 |
| D: artifact and whitespace audit | Same run: Boat backend/test hashes exactly match local `e829b7380102f5498cb9e8cea32ede87eb743a38` / `7826bb63a9ea908f24f4324a5c761adac6ba493d`; Boat and local `git diff --check` passed; final three-file note-inclusive hash/commit audit is recorded in the completion receipt |

Both final gate runs returned `ATOMIC_JOURNAL_GATE_EXIT=0`. Process evidence still covers fresh Bun rebuild, SIGKILL rollback/integrity, 400 keyed child appends, and Node/Bun identifier/JSON behavior. No runtime/UI scenario applies to this unwired non-UI backend. Required preferences, explicit workflow trailer override, actual model attribution, separate RED evidence and signed commit are retained. The resolved `issues.md` is removed before commit.

The correctness tradeoff is a full replay on unowned refresh and new acquisition; held writes remain incremental. No production-load benchmark was performed. The prior five-commit timing sample (only one measured duration) is anecdotal, not an estimate or replacement for current gate results.

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

Five existing unrelated Biome informational diagnostics and 26 established unit skips were left unchanged. No product additions or other slice work were added. User guides and release notes remain assigned to S6. No reproduced in-scope failure remains after the current repair gates.
