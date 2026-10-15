# S2 implementation notes

## Goal and frozen acceptance matrix

Implement only the unwired `JournalDurableBackend`, persist before returning, rebuild its projection from journal events, verify it on Boat, and commit on `feat/workflow-journal-s2-journal-backend`.

The table records the unchanged acceptance clauses. The current five-entry, three-reviewer batch is review-round-latest.json:1155–1259 against designated S1 baseline `6c21d5927b0f1ee2b7e6613205870a9770dc043d`. `C` denotes current format/check gates, `F` focused tests and independent probes, `U` the standalone unit gate, and `D` baseline/artifact audits, recorded in the current repair section below. Earlier receipts are historical, not current-source validation. Their broad readiness and baseline-fidelity claims were incomplete: the newer baseline's empty-path fallback and exact unheld stale-error assertions had been dropped. No objective or contract amendment is introduced.

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
| Preserve transition boolean results and expected timestamp/status semantics | F: predicates rechecked after acquisition, sequence captured from acquired incarnation; shorter/equal/longer matching and mismatching status/timestamp schedules, missing replacement and held/stale fences |
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
| Catalog, hydration and accepted mutations reflect deletion/recreation | F: prior direct deletion/recreation cases retained; inactivity rechecked after acquisition, acquired sequence used for deletion CAS; deterministic and real Node/Bun child replacement schedules |
| Local-only `node:sqlite` storage | D: no shared-host store or new runtime selector |
| Default path remains `join(dirname(getAgentDir()), "workflows", "journal.sqlite")` | F: restored baseline expectation plus isolated default-constructor create/append/close/reopen and fresh Node/Bun process regressions for an empty override; D: explicit empty/unset fallback restored |
| `ATOMIC_WORKFLOW_JOURNAL_PATH` preserves every nonempty override verbatim | F: inherited relative/unusual path expectations; D: no trim, normalization, rejection or new validation; empty is treated as unset |
| WAL, FULL sync, busy timeout and foreign-key pragmas retained | F: inherited kernel/process tests; D: existing pragmas and counter adapters unchanged |
| Schema version 1, unknown version hard error, no migration | F: all 171 designated-baseline kernel cases; singleton safe integers, int64 extrema, text and real values report exact typed errors |
| Exported schema/table/column/event/encoding/lease constants and types retain identity | C, F and D: exact API probes; restored SqliteStoredValue and JournalSchemaVersionError found/constructor union; synchronous capability remains additive |
| Lease tombstone preserves monotonically increasing epoch after deletion | F: restored exact constructor/runId/heldEpoch/currentEpoch checks after release and deletion, inherited fencing and backend stale-deletion regressions; D: shared deletion retains tombstone |
| `seq` and `epoch` remain safe integers in `0..Number.MAX_SAFE_INTEGER` | F: inherited range matrix; expiry grant uses the same checked increment |
| Range errors retain exact class and fields | F: `JournalCounterRangeError { runId, field, value, reason }`; additive checkpoint path propagates it rather than hiding it |
| Identifier Unicode/NUL rules and NUL precedence remain unchanged | F: inherited kernel and Node/Bun process matrices; D: synchronous companions delegate shared validation bodies |
| Payload/header JSON preserves accepted values, NUL, lone surrogates and negative zero | F: exact retained S1 native JSON assertions plus backend native lexemes, caller serialization counts, frozen inputs/FWW, repeated status/prompt/message/summary snapshots, hydration/reopen/getters; no construction/fold stringify round trips |
| Surviving S1 tests, process fixture and notes remain intact relative to designated baseline | D: all 171 baseline kernel cases and exact assertions from `6c21d5927b0f1ee2b7e6613205870a9770dc043d` retained verbatim; only imports and two persistent default-path process cases added; adapter, contention file, journal-process.mjs and S1 notes byte-identical |
| Exactly one metadata row and typed corruption error | F: cardinality before any version decoding; nine multirow combinations include both int64 extrema and mixed types; exact JournalMetaCorruptError path/rowCount, no schema or row changes |
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
| No `any`, no `unknown` added outside SQLite boundary | C and D: restored getWide uses the existing typed node:sqlite boundary; other source/tests add neither |
| Named errors, fields and third-party storage causes retained | F: ownership and counter fields; inherited storage boundary tests; D: abort/closed/message-scope errors are named subclasses |
| Vitest and `node:assert/strict` | F and D: all new assertions use repository style |
| Runtime helpers and explicit Bun executable | F and D: new helper/fixture tests use `test/helpers/runtime.ts` |
| Each test owns a temporary database | D: shared cleanup constructor allocates per instance; intentional competing instances share only within one test |
| No authored skips or soft guards | F: all focused tests execute; D: no skip/guard additions |
| `npm run format` on touched files | C: clean formatter rerun; exact formatting changes applied locally through file edits |
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
- Direct deletion: decide durable existence from current journal headers, not the cached projection. Retained held leases still enter lease-checked SQL deletion even when cached state is empty; never discard stale authority by treating an empty projection as absence. An unowned absent run clears cached workflow/checkpoint/prompt state without acquiring a missing lease. No prior hydration is required. Successful current-owner deletion clears local ownership and retains the kernel tombstone for legal recreation.
- A pre-acquisition mismatch returns false without acquiring or writing. After acquiring, status claims recheck expected statuses and optional updatedAt against the acquired draft and capture that incarnation's sequence. Inactivity is likewise rechecked against acquired current state before deletion CAS. Matching replacements are allowed even when their journal length differs. A CAS loser adds no event and refreshes the winner. Missing-during-acquisition results preserve false/not_found, without clearing stale/lost execution fences.
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

### Prior recreation-repair gates (not latest-batch completion evidence)

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

Both historical gate runs returned `ATOMIC_JOURNAL_GATE_EXIT=0`. They proved the delivered ordinary JSON and recreation scenarios, not complete current-baseline losslessness or direct deletion from stale caches. The later six-finding review correctly contradicted those broader claims. No runtime/UI scenario applies to this unwired non-UI backend.

The correctness tradeoff is a full replay on unowned refresh and new acquisition; held writes remain incremental. No production-load benchmark was performed. The prior five-commit timing sample (only one measured duration) is anecdotal, not an estimate or replacement for current gate results.

## Historical six-finding repair, superseded by the eight-finding batch

The then-current six-finding batch was not a scope addition or contract amendment. All three reviewers reported the same JSON binding root and the same direct-deletion root. Prior passing reduced-suite gates did not prove the advanced baseline's accepted native rawJSON behavior; prior deleted-only coverage refreshed through another mutation before deletion and did not prove direct-first deletion. That repair remains retained, but its broad completion claims are superseded by the current eight-finding batch.

| Finding | Root and applied repair | Persistent prevention |
| --- | --- | --- |
| 1 completion P1, 3 evidence P1, 5 risk P1 | Designated S1 baseline advanced to `babfae6a0`, while S2 retained direct JSON.stringify SQLite bindings. Native JSON.rawJSON can emit literal lone surrogates, replaced by U+FFFD during UTF-8 TEXT binding. Restore the exact private serializeJson implementation in both shared synchronous write bodies, plus all baseline tests/fixture/notes. | All ten baseline unit cases and repeated alternating Node/Bun process case are byte-identical to the current baseline; no assertions removed or modified. Stringify once, escape only literal lone surrogate units; preserve number/string lexemes, negative zero, astral pairs, toJSON count, immutability and keyed duplicate no-serialization. |
| 2 completion P2, 4 evidence P2, 6 risk P2 | deleteOwned decided SQL deletion using cached projection existence. An empty observer silently retained late registrations; cached external deletion attempted to acquire a missing run. Replace that predicate with authoritative journal header existence OR a retained held lease; retain existing ownership acquisition, atomic lease/CAS deletion and typed error mapping. | Direct-first late-registration and external-deletion tests compare observer/fresh state, empty catalog, raw zero run/event rows and null tombstone holder, then recreate and compare checkpoints. Additional direct recreation/current-owner, foreign-holder and empty-projection stale-holder tests retain fencing. |

The existing no-hydration shorter/equal/longer recreation repair is unchanged. No schema, encoding, exported constant/type, Promise/AsyncIterable identity, synchronous companion, dependency, configuration or runtime wiring change is made. The deletion query uses the existing synchronous journal header API, not undocumented caller hydration or a new production test seam. It scans current headers only for unowned deletion; held deletion retains its existing lease check. No new validation, restriction, error class or message-text control flow is added.

Authoring gate: direct-first deletion protects the permanent-removal/no-op contract when cache and storage diverge; the earlier mutation-then-delete case cannot catch it. Fresh/stale lease boundaries protect against silently skipping authority checks when projection state is empty. Existing public backend/journal methods drive each scenario; raw rows add storage-boundary confirmation. Baseline coverage is restored verbatim, not reauthored.

### Historical six-finding RED/GREEN and independent probes

- `run_78a839d7b8d2f212c5c4791f800c8d46`, `/tmp/s2-batch-json-red.log` and Boat `.crabbox/s2-batch-json-red.log`: exact persisted baseline unit/process tests against unfixed current source: **8 failed, 158 passed of 166**, no skips. Independent Node/Bun each failed native rawJSON header/event and both direct deletion probes; each passed durability/duplicate/CAS/omission and the old no-hydration recreation probe. Separate Boat logs are `.crabbox/s2-batch-node-red.log` and `s2-batch-bun-red.log`.
- `run_a6b70c18b54e8816aa9f7a01d8a72172`, `/tmp/s2-batch-json-green.log`: exact serializer repair passed all **166** restored cases (161 unit/five process), including SIGKILL/integrity, 400 child appends and alternating native JSON children.
- `run_a1eaed61319dc009075ab3b22f43fbed`, `/tmp/s2-batch-delete-red.log`: persistent direct-first tests reproduced **2 failed, 24 passed**: retained late-registration run and RunNotFoundError after external deletion. No prior hydration or mutation masked either transition.
- The first post-fix attempt `run_96e1363e173f04eb1d95b6e550364cd6` reached a mistaken new-test catalog expectation: the real empty catalog also includes `inspectableIds: []`. After reading the public catalog implementation, the assertion was corrected to check the complete three-field empty shape, not removed or weakened. This was a test-authoring mistake, not an additional product fix.
- `run_9d838d5ce143bc0712e41adde20bf58a`, `/tmp/s2-batch-delete-green-2.log`: **26/26** backend tests passed. Exact independent source `/tmp/s2-completion-turn2-probes.mjs` was created inline on Boat; Node22.19.0 and Bun1.4.2 each passed all six groups, including native rawJSON headers/events, both direct deletions and the previous recreation mutation. Runtime logs are `.crabbox/s2-batch-node-green.log` and `s2-batch-bun-green.log`.

- `run_6ddf9f0c085cdea90d38feeab8ee8640`, `/tmp/s2-batch-expanded-format.log`: temporarily restored the exact pre-repair backend blob `e829b7380102f5498cb9e8cea32ede87eb743a38` with an EXIT restoration trap and ran all expanded assertions: **4 failed, 25 passed of 29**. Both direct-first cases, fresh-foreign rejection and empty-projection stale-held rejection failed for the expected reasons. Restoring the fixed backend passed **29/29**. Boat logs are `.crabbox/s2-batch-delete-expanded-{red,green}.log`. No assertion was lost or modified between these runs. `npm run format` fixed only two formatting spans in the touched backend test; those exact edits were applied locally.
- `run_f308436c325caffcc46de5773da18c91`, `/tmp/s2-batch-final-check.log`: no-fix formatting passed; check caught unsorted newly added test imports before typechecking or subsequent gates. Only that import ordering was corrected; no product/assertion changes. The passing rerun below supersedes this failed attempt without hiding it.

### Historical six-finding final-source gates

All executable work below ran sequentially through the supplied wrapper on the assigned implementer Boat. Mac work was reads, file edits and git only. No production/test changes followed the no-fix format/check run; subsequent edits only record evidence in this note.

| Gate | Final-source result |
| --- | --- |
| C: `npm run format`; `git diff --exit-code`; `npm run check` | `run_cb1e94696805be1a9b22a30970f36110`, `/tmp/s2-batch-final-check-2.log`: 3431 files formatted, no fixes/no diff; Biome, root/workspace typechecks and published shrinkwrap passed. Six informational diagnostics, no warnings/errors. |
| F: exact selected durable command plus process integration | Same run: 19 selected unit files plus integration, **20 files / 321 tests passed**, none skipped. Includes all 29 backend tests, 161 baseline kernel tests and five process tests. |
| Literal `npx vitest --run test/unit/durable-sqlite-run-journal.test.ts` | Same run: **161/161** passed, none skipped. |
| Independent Node/Bun probes | Same run: Node22.19.0 and Bun1.4.2 each passed all six exact retained groups, including native rawJSON headers/events, both direct-first deletions and old recreation. Both reported `failures: []`. |
| U: exact established two-exclusion unit command, ALONE | `run_1bb0b2037a78a32ffc5809832274b467`, `/tmp/s2-batch-final-unit.log`: **930 files / 10,564 tests passed**, 26 pre-existing skips, duration115.97s. Wrapper applied exactly two authorized exclusions. No extra exclusions or skipped/soft-guarded regressions. |
| Supplemental cached qlty | `run_cb1e94696805be1a9b22a30970f36110`: qlty0.654.0 `metrics --functions` analyzed both changed production files successfully using existing configuration. No plugins/configuration changes or claim of a separate security audit. |
| D: whitespace and source fidelity | `run_cb1e94696805be1a9b22a30970f36110`: Boat `git diff --check` passed; final production/test hashes match local files. Final note-inclusive formatting/hash and baseline audit accompanies the signed commit receipt. |

Historical production hashes were backend `ead0169473ab3bae5782c18a3a9292de4522269d`, SQLite journal `24c9acbdfafa8b681cef0bcd47b26b503559eaa0`, backend tests `42703e171b7fea57da339b3ba2fd2ac299e7c357`. The baseline unit/process/fixture/notes hashes were respectively `72570e99e3a4e8da73838a74b981284316f3608e`, `6ef88bd8ef616cd7f317e13ea2144113e3e18b69`, `d746e587870b5c4a6d5c3a85c566ef0af8e06c9d`, `64866b03976829c1c508ecb5a408c05cc1fa02fa`. They matched the older `babfae6a0` baseline, not the designated `4631156a7` metadata baseline; they cannot establish current S1 coverage fidelity.

All required executable gates passed with `ATOMIC_JOURNAL_GATE_EXIT=0`. The remaining performance tradeoff is the existing full replay for unowned mutations plus a current-header scan for unowned direct deletion; no production-scale benchmark was run. The backend remains unwired, so no browser/video or wired-runtime end-to-end claim is made. The resolved issues.md is removed. Final note-inclusive no-fix formatting, all 27 S2/baseline-restoration content hashes, independent probe-source fidelity, whitespace, signature and clean-tree evidence accompany the commit receipt. No further product/test edits are made after the passed gates.

## Historical eight-finding repair: authoritative acquisition and JSON preservation

That batch was review-round-latest.json:1512–1675 at the time. It contained five P1 entries for guarded acquisition and three P2 entries for lossy JSON conversion. Those repairs remain retained. Its overall completion claim is superseded by the current metadata repair: ordinary CAS and recreation coverage did not establish fidelity to the advanced S1 metadata baseline.

| Finding | Reviewer and defect | Repair and durable proof |
| --- | --- | --- |
| 1, title at 1515 | Completion: expected status checked before acquisition | Recheck acquired draft status/timestamp, then capture its sequence; exact equal-sequence refusal and expanded predicate matrix |
| 2, title at 1535 | Completion: inactive deletion checked before acquisition | Recheck acquired current state before deletion CAS; exact running replacement refusal and sequence matrix |
| 3, title at 1555 | Completion: native negative zero lost | Typed event payload construction/fold without JSON normalization; single-boundary negative-zero preservation and repeated snapshot regression |
| 4, title at 1575 | Evidence: real-process claim race | Same authoritative claim repair; eight persisted Node/Bun child cases cover both actions and same/longer sequence controls |
| 5, title at 1595 | Evidence: real-process inactive deletion race | Same acquired inactivity repair; child deletes/registers/closes through public backend operations |
| 6, title at 1615 | Evidence: native JSON changes between header and projection | Header/event/immediate/reopened inputs and outputs agree; native raw lexemes and caller boundaries checked directly |
| 7, title at 1635 | Risk: both predicates and sequence bound to old incarnation | Shorter/equal/longer replacement matrix, matching/nonmatching predicates, absent acquisition, fresh competitor and retained stale execution fences |
| 8, title at 1655 | Risk: construction and fold normalize native JSON | No stringify on fold; status/prompt/message/summary snapshots retain decoded -0 through hydration, getters and reopening |

### Minimal design decisions

- Keep the existing preflight mismatch results. After acquisition, independently validate the authoritative predicate; capture expectSeq only after acquisition/rebuild. Keep journal CAS and epoch checks unchanged. Do not reject a replacement merely because its sequence or incarnation differs if its acquired state satisfies the actual predicate.
- If deletion wins while an unowned current-state lookup acquires, catch only typed RunNotFoundError, discard the obsolete projection and return absence. No lost execution is silently reacquired; retained stale leases still fail with JournalOwnershipError and exact StaleLeaseError fields, including on repeated attempts after hydration.
- A private discriminated BackendEvent union describes actual backend payloads. A type-only JSON payload mapping retains already-serializable values and gives domain interfaces structural payload types. Construction is direct; fold reads the already-decoded typed payload. No runtime conversion or caller mutation/freezing is added. Kernel event constants, exported API shapes, schema and encoding are unchanged.
- The journal still stringifies once per write and escapes only literal lone surrogates afterward. Its replacer emits native JSON.rawJSON("-0") only for a decoded negative-zero number; this is necessary because subsequent full snapshots would otherwise stringify it as positive zero. It does not parse/reserialize native raw fragments, so original accepted number/string lexemes, astral pairs and surrogates remain intact. Existing S1 tests/fixture/notes remain byte-identical; the serializer receives only this focused preservation extension.
- Backend registration performs two distinct durable writes (header and start event), each invoking caller toJSON once. A checkpoint invokes it once; an existing keyed checkpoint invokes it zero times. Later snapshots use decoded data and do not reinvoke the original caller. Frozen objects retain identity/content.

Authoring gate: each new test protects a required guarded transition or accepted-value round trip missing from prior coverage. Acquisition is injected through the existing journal capability, not a production-only test seam. Real children independently delete/register/close while the observer is paused at acquisition. Matching replacement cases prevent invented incarnation/sequence restrictions; fresh/stale cases retain authority fences. The prior 29 backend cases and every surviving S1 assertion remain intact.

### Historical eight-finding RED/GREEN evidence

All commands ran sequentially on the assigned implementer Boat through the exact supplied wrapper; Mac activity remained read/edit/git only.

| Behavior | RED | GREEN |
| --- | --- | --- |
| Equal-sequence status predicate | run_fe83b307fbfe69cef2aee431b0cb319e, /tmp/s2-turn4-status-red.log: true instead of false; focused selection ran one regression (29 other tests unselected) | run_e64d90bdb19b49b70c2ebf37579243f2, /tmp/s2-turn4-status-green.log: 30/30 |
| Equal-sequence inactive deletion | run_1589425d2e38b91d00b95bc178e0c00d, /tmp/s2-turn4-delete-red.log: 1 failed/30 passed, ok:true instead of running refusal | run_0348dc8ef7449bc5916b36bc2de60380, /tmp/s2-turn4-delete-green.log: 31/31 |
| Backend native negative zero | run_c94d920161cc775580edf200051c0619, /tmp/s2-turn4-zero-red.log: 1 failed/31 passed; exact independent Node/Bun each saw only header preserve -0 | run_c56be883be88ac2e26d5e8262206ccf2, /tmp/s2-turn4-zero-green.log: 198/198 across backend/kernel/process; exact Node/Bun numeric observations all true; both exact acquisition probes pass |
| Missing run during acquisition | run_fd45ff53ab63925397f26f49b44cc919, /tmp/s2-turn4-absent-red.log: 2 failed/32 passed with typed RunNotFoundError from acquire | run_fd63388ee3f174385ca7c6656ea02425, /tmp/s2-turn4-absent-green.log: 34/34 |

Expanded runtime coverage first passed 62/62 in run_65716a1d148869ec9887e22f99c830ea (/tmp/s2-turn4-expanded-check.log). Its check correctly rejected insufficient type overlap in the first private event boundary and one unnarrowed new-test checkpoint access. The first type-only mapping then exceeded recursive instantiation in run_1bb6d31700f9dca8d9e4614454695b46 (/tmp/s2-turn4-type-format.log). Stopping the mapping at already-serializable values resolved that type error without changing runtime data. A kind-discriminant assertion narrows the test checkpoint. Formatter output was applied locally via file edits. run_eb5ac1dd88cd22b13faa4d9154661ec7 (/tmp/s2-turn4-type-green.log) passed no-fix formatting, no diff and the complete repository check. These intermediate passes do not replace the final-source gates recorded next.

Expanded preimage proof: run_0f8a682ce8f0d37ebe7f1478f6b27436, /tmp/s2-turn4-expanded-red-green-2.log, temporarily loaded the exact f20045927 backend blob ead0169473ab3bae5782c18a3a9292de4522269d with an EXIT restoration trap. All 62 persisted assertions ran: RED **15 failed / 47 passed**, then restored-source GREEN **62/62**, no skips. The failures include both equal-sequence guards, absent acquisition, timestamp mismatch, valid shorter/longer matching claims, all four same-sequence real-child cases, negative-zero fold and unnecessary caller serialization on a duplicate checkpoint. The independent reviewer child schedule separately failed its four same-sequence Node/Bun cases while passing all four longer-sequence controls; after restoration all eight passed with failures: []. Complete repository check also passed with direct typed event construction. Remote logs: .crabbox/turn4-{expanded,children}-{red,green}.log. The earlier attempt run_8b17620f2506c02834fffc0ad4464492 stopped before executing any tests because scratch heredoc construction added a newline to the preimage and the byte-hash assertion rejected it; the EXIT trap restored source, and the corrected run verified exact bytes before executing. No test assertion was weakened or removed.

### Historical eight-finding final-source acceptance evidence

| Gate | Current-source evidence |
| --- | --- |
| C: npm run format, no diff, npm run check | run_ff8cd2c328f39830d3e354a6cfd1f28d, /tmp/s2-turn4-final-gates.log: 3431 files formatted with no fixes; git diff --exit-code passed; Biome, root/workspace typechecks and published shrinkwrap passed with six informational diagnostics and no warnings/errors |
| F: exact 19-suite selection plus process integration | Same run: **20 files / 354 tests passed**, no skips, including all 62 backend tests, 161 kernel tests and five process scenarios |
| Literal npx vitest --run test/unit/durable-sqlite-run-journal.test.ts | Same run: **161/161 passed**, no skips |
| Exact independent turn3 probes on Node22.19.0 and Bun1.4.2 | Same run: each runtime passed both original acquisition actions, all seven negative-zero observations, and all ten ordinary groups; public-backend variant of the acquisition probe also passed on each runtime |
| Independent real children and retained prior probes | Same run: all eight Node/Bun reviewer child schedules passed, including same-sequence and longer-sequence controls; both runtimes passed all six turn2 groups; prior standalone recreation executable passed |
| Supplemental cached qlty metrics | Same run: qlty0.654.0 metrics --functions analyzed both production files using existing configuration. Current cognitive complexity is 11 for status claims and 14 for guarded deletion; explicit post-acquisition validation adds branches. No broad refactor, configuration/plugin churn or separate security-audit claim |
| U: exact npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts, ALONE | run_bbb9084508459badbd0a9048ffed64af, /tmp/s2-turn4-final-unit-2.log: **930 files / 10,597 passed**, 26 pre-existing skips, 145.07s. Wrapper applied exactly two authorized exclusions; no other exclusions, concurrency adjustments, guards or retries inside tests |

The exact final commands and raw probe output are retained in /tmp/s2-turn4-final-gates.log and Boat .crabbox/turn4-final-*.log. All gates in that run returned ATOMIC_JOURNAL_GATE_EXIT=0. No product/test/fixture edits followed it. Current code hashes match local: backend 45ce10974f2a1fc2c3256648c2c812ebf8118dc6; SQLite journal cc265c9ba8685650bda18a9b0ea577e4b6c8e9b3; focused tests 9ca92a9b3f5a08853ac3ec21c389b259b43b3f17; new child fixture 5e2a6fa231c92bb6660d8e27e76c012810cd72a9. Final note-inclusive artifact and established unit evidence follow separately.

The first exact established unit attempt, run_c8baf119ba640b2d2c06b2159bd4f4cd (/tmp/s2-turn4-final-unit.log), passed 929 files / 10,596 tests but failed one untouched workflow-stage-bundled-resources assertion at line367: taskResponse was undefined; 26 pre-existing skips remained. All 62 backend tests passed under that same full-suite load. The untouched file's complete ten-test standalone run passed in run_3566ab0b630854dbf732d29b54aada58 (/tmp/s2-turn4-unit-investigation.log). Its source/history were inspected; no assertion, product code, test concurrency, gate exclusions or environment policy was changed. The lower-level cause of that isolated failure is unproven; it is not presented as a repaired S2 defect. The exact unchanged unit gate is rerun alone, with its actual outcome recorded below.

The unchanged full-unit rerun passed, including the earlier failing stage case and all 62 backend cases under ordinary full-suite load. This establishes the required current-source unit gate, not a diagnosis of the earlier unrelated transient. Both outcomes remain in the evidence and commit trailers.

Historical baseline audit: the S1 unit suite, contention suite, journal-process.mjs fixture and research/notes/workflow-journal-s1.md matched only the older `babfae6a0c4f149ecb3bc531aa3f290890732733`, not designated baseline `4631156a7a96f8386bb78ee4d200ada81a2add83`. The earlier assertion of current-baseline fidelity was therefore incorrect. The focused backend suite added 376 lines and removed zero relative to f20045927, retaining its prior 29 cases. The current repair restores all ten missing metadata cases and the corresponding adapter/error behavior while preserving that entire backend suite and its acquisition fixture.

The eight earlier defects have retained regressions, but their green receipts did not close the newly identified metadata gap. Remaining historical caveats include the unproven single untouched-test transient above, six informational diagnostics, 26 existing unit skips and unbenchmarked full replay/current-header scan costs. The backend remains unwired; no UI/video or wired-runtime E2E result is claimed.

## Historical metadata repair: six findings, one initialization root

The then-latest consolidated findings at review-round-latest.json:1298–1418 were required by the unchanged objective, not a user amendment. The initializer decoded every schema_version through a number-valued query before counting rows, and the exported schema error had lost its full stored-value type. Decoding could fail before cardinality validation or round a singleton value. A reduced 161-case suite hid this loss of baseline behavior. The following evidence is pinned to the older `4631156a7` reference, not the current designated baseline.

| Finding | Reviewer and facet | Applied repair and proof |
| --- | --- | --- |
| 1, title at 1301 | Completion: cardinality after decoding | Count rows first; all multirow inputs throw exact JournalMetaCorruptError path/rowCount |
| 2, title at 1321 | Completion: lossy singleton and narrowed error | Read singleton with BigInt enabled; retain exact stored value and full found/constructor union |
| 3, title at 1341 | Evidence: wide multirow storage errors | Same cardinality repair; all three restored wide-multirow baseline cases |
| 4, title at 1361 | Evidence: exported schema error regression | Exact independent field/constructor compilation and restored singleton assertions |
| 5, title at 1381 | Risk: version conversion precedes count | Independent Node/Bun probes and unchanged-row/schema snapshots |
| 6, title at 1401 | Risk: int64 rounding and type narrowing | Both int64 extrema preserved losslessly; exported SqliteStoredValue restored |

The repair applies the necessary `babfae6a0..4631156a7` changes in this checkout. The adapter is byte-identical to the designated baseline; only its typed boundary gains getWide. The initializer counts without decoding versions, rejects cardinality greater than one, then reads a singleton losslessly. Safe integer versions remain numbers in the error; wide integers remain bigint; text, real, blob and null stay their stored types. The exact exported SqliteStoredValue union is `string | number | bigint | Uint8Array | null`; JournalSchemaVersionError.found and its required constructor argument are `number | bigint | string | Uint8Array | null`. A current singleton version is accepted and an empty/missing table initializes normally. Unsupported versions are hard errors without migration. No schema, contract, counter API, identifier validation, collection identity or runtime wiring change is introduced. S2 synchronous companions, native JSON handling and acquired-state guards remain unchanged.

TDD authoring gate: the ten restored baseline cases protect existing cardinality and exact singleton-value behavior absent from the 161-case suite. All use the public journal constructor and inspect typed errors and unchanged storage. The entire baseline test file was restored byte-for-byte for RED; required formatting subsequently wrapped one multirow test call and added its trailing comma. No assertion is removed or weakened. Fixtures and S1 notes already match the designated baseline and require no edits.

### Historical RED evidence

Assigned-Boat run `run_6eb50bba30aefa96b0d2985016c954d1`, `/tmp/s2-meta-red.log`, restored all 171 cases before production edits: **166 passed, five failed**, no skips. Three wide-multirow cases raised StorageUnavailableError instead of JournalMetaCorruptError. Singleton INT64_MAX raised StorageUnavailableError; Node rounded INT64_MIN to -9223372036854776000. Exact retained `.crabbox/completion-turn4-meta.mjs` failed **4/8** on each of Node and Bun; Bun raised StorageUnavailableError for both singleton extrema. The exact `.crabbox/completion-turn4-meta-tsconfig.json` probe failed TS2344 and TS2345. Raw remote logs are `.crabbox/s2-meta-{red,node-red,bun-red,type-red}.log`. The evidence-collection wrapper returned zero deliberately after recording failing subprocess exits; it is not a green test gate.

### Historical metadata validation

Initial GREEN `run_a6abdb590dc6278a3c75339b8df4a907`, `/tmp/s2-meta-green.log`: all **171/171** kernel cases passed, Node/Bun each passed **8/8** exact metadata probes, and the exact metadata typecheck passed. The subsequent formatter changed only the restored metadata helper/initializer layout and one baseline multirow test call (wrapping and trailing comma). Those exact formatting changes were applied locally; assertion bodies are unchanged. Final gates follow.

| Gate | Current-source evidence |
| --- | --- |
| C: npm run format, no diff, npm run check | `run_f41457964947ccbbb62c06b8bb89e349`, `/tmp/s2-meta-final-gates.log`: 3431 files formatted, no fixes; no diff; Biome, root/workspace typechecks and shrinkwrap passed, six existing informational diagnostics |
| F: exact 19-suite selection plus process integration | Same run: **20 files / 364 tests passed**, no skips; includes 171 kernel cases, 62 retained backend cases and five process cases |
| Literal npx vitest --run test/unit/durable-sqlite-run-journal.test.ts | Same run: **171/171 passed**, no skips |
| Exact metadata and general API compilation | Same run: both retained configs passed; supplemental compile proves exact SqliteStoredValue and constructor-parameter unions |
| Independent runtime probes | Same run: Node22.19.0/Bun1.4.2 each passed all eight metadata cases, both acquisition guards, all seven negative-zero observations, ten ordinary groups and six earlier groups; public-backend guards also passed |
| Independent process/race probes | Same run: all eight real-child acquisition schedules passed; fresh Node/Bun process rebuild preserved catalog, checkpoint ordering, prompt state and exact text; previous recreation probe passed |
| Supplemental qlty | Same run: cached qlty0.654.0 analyzed three production files with existing configuration; getWide cognitive complexity0, storedVersion2; no plugins/config changes |

All gates in that run returned `ATOMIC_JOURNAL_GATE_EXIT=0`. Product/test hashes matched the local checkout: adapter `dcea59bbe8101c0f2f655d4c66bc7105551c7de5`, journal `700938349337ce5919e5c4950033ab02f41e669d`, types `bc95fa340f8d118da1c89027d184b05fdedca154`, kernel tests `79a12a51c5f3d3e01d182542b072b5ef628ae4e8`. The backend, its 62 tests and acquisition fixture remained exactly the cb0750286 versions. Only evidence notes changed after these gates. Final standalone unit and note-inclusive artifact receipts follow.

The first current standalone full-unit attempt, `run_c20c7a72abee7a1e5f49948fde4c8be9` (`/tmp/s2-meta-final-unit.log`), ran the exact two-exclusion command alone and returned gate1: **929 files / 10,606 tests passed, one failed, 26 pre-existing skips**, 133.14s. The failure repeated the previously recorded untouched workflow-stage-bundled-resources.test.ts:367 case: taskResponse was undefined. The entire file is unchanged from the designated baseline; its history and stage-session setup were inspected. Its unchanged standalone run, `run_820c734af822feb7677e84177b2cb1b4` (`/tmp/s2-meta-unit-investigation.log`), passed **10/10**, including delegation, gate0. No test assertions, production code, concurrency settings, environment policy or exclusions were changed. This is not a diagnosed or repaired metadata defect; the lower-level cause remains unproven. Both outcomes are retained, and the exact full gate is rerun unchanged.

The unchanged exact full-unit rerun passed in `run_4a3f5883e0c30fdcc73e3e942bd3bfa6` (`/tmp/s2-meta-final-unit-2.log`): **930 files / 10,607 passed**, 26 pre-existing skips, 122.46s, gate0. The previously failing delegation case and all 62 backend cases passed under full-suite load. Exactly the two authorized exclusions were applied, without retries inside tests or configuration changes. This establishes the required gate, not a diagnosis of the earlier admission failure.

Final baseline/probe audit `run_619e00aa90a09ca7f57bd1f8dbf77517` (`/tmp/s2-meta-final-artifact-3.log`) passed. Exact files exported from the designated local commit were compared on Boat: the adapter, process fixture, contention suite and S1 notes are byte-identical; types are identical after removing only the existing S2 synchronous interface; the entire kernel suite equals the designated baseline after the repository formatter, preserving all 171 assertions. All 29 audited file hashes (the complete S2 baseline delta plus unchanged adapter/fixtures/notes) matched local files. The final note-inclusive formatting/hash receipt is recorded with the commit.

The retained metadata and earlier six-group probe had one extra terminal LF in their first scratch copies; local-original-plus-one-LF hashes proved the difference. Removing only that LF and rerunning both exact sources on Node/Bun passed every case. Canonical metadata source hash is `120605b4a29531a6e5334fe28fdebcd14426557f`; exact field/constructor probe source hash is `39ddbd3bb9cb7287999144717017f14fc3ee07b3`. General API, metadata API and complete stored-value/constructor-union compilations also passed. Nine retained probe/source/config hashes match their local originals.

Two audit-tool attempts are retained rather than counted as successful gates: `run_55b8fac74846d2246475f2023ed526eb` could not read the local-only S1 revision from Boat Git; `run_fe05f28329506f4928ba07fc4c023b7e` discovered that the installed TypeScript package has no JavaScript parser API. Exporting the exact baseline files into ignored scratch storage and comparing the test through the existing repository formatter resolved those audit limitations. No project source, test, dependency or configuration was changed for either limitation.

All six metadata findings were closed by that repair's persisted coverage and independent runtime/type probes. Those changes remain retained. Its `4631156a7` audit did not establish fidelity to the now-designated `6c21d5927` baseline: empty-path and two exact stale-error assertion blocks were missing. The current repair below supersedes that broader readiness claim. The intermittent unit failures remain undiagnosed; the backend remains unwired.

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

Five unrelated Biome informational diagnostics, the exact-formula serializer style information and 26 established unit skips are not suppressed. No other slice work is added. User guides and release notes remain assigned to S6. Current completion requires the current-baseline path/assertion repair and fresh gates below, not historical reduced-suite or metadata-only receipts.

## Current repair: five findings, two baseline-preservation roots

The current designated S1 commit is `6c21d5927b0f1ee2b7e6613205870a9770dc043d`, inspected by full SHA and `git show`. It changes only `sqlite-run-journal.ts` and `durable-sqlite-run-journal.test.ts`: empty override fallback, two stronger stale-lease assertion blocks, and formatting of already-retained metadata code/tests. The objective is unchanged. This repair applies its required behavior in this checkout rather than replacing S2 or replaying unrelated slices.

| Consolidated finding | Reviewer | Root, fix and closure evidence |
| --- | --- | --- |
| 1, title at 1158, P1 | Completion | Empty override selected a private temporary SQLite database; restore the exact baseline fallback and persistent Node/Bun regression |
| 2, title at 1178, P2 | Completion | Release/deletion class-only checks omitted supported diagnostics; restore both verbatim constructor/runId/heldEpoch/currentEpoch blocks |
| 3, title at 1198, P1 | Evidence | Same empty-path root and persistent regression as finding 1 |
| 4, title at 1218, P2 | Evidence and risk | Same exact stale-field coverage restoration as finding 2; no production error behavior changed |
| 5, title at 1239, P1 | Risk | Same empty-path root; default constructor now survives close/reopen and a fresh process |

The only production change is `workflowJournalPath`: undefined and empty select `join(dirname(getAgentDir()), "workflows", "journal.sqlite")`; every nonempty value is returned verbatim, including whitespace and unusual relative paths. No trimming, rejection or validation is added. Both direct journal constructors and backend default/open callers use this function. S2 synchronous companions, private discriminated event union, native JSON/negative-zero preservation, metadata widths/errors, counters, ownership races and deletion semantics remain unchanged.

TDD authoring gate: the inherited path test checked a string, not successful persistence. Two additional public-interface cases create/append/close/reopen using the default constructor and compare a second fresh process on each of Node22.19.0 and Bun1.4.2. Every process receives an isolated temporary `ATOMIC_CODING_AGENT_DIR` and an empty override; no real user database is opened. They use the existing runtime helpers and `bunExecutable`, strict assertions, no skips, mocks or new production seams. The exact baseline test body otherwise remains intact; only helper imports and these cases are added.

### RED and initial GREEN

- `run_7d7060f692b697614ec08eb24917b2ed`, `/tmp/s2-path-initial-red.log`: reran the exact retained `.crabbox/completion5-path.mjs` from the latest completion receipt, with isolated agent directories. Both Node and Bun printed `actual:""`, `reopenedRows:[]` and failed the expected-default assertion with exit1. The diagnostic wrapper returned zero only after recording individual exits; that is not a passing probe. In the same run the exact `.crabbox/completion5-runtime.mjs` passed all five groups on each runtime, including both exact stale-field checks. No artificial RED is claimed for already-correct error behavior.
- `run_3f2777180f1d63348055e565ce4fbac8`, `/tmp/s2-path-test-red.log`: all 173 persisted kernel cases ran against unfixed production. **170 passed, three failed**, no skips: the restored baseline path expectation and both new default-constructor persistence cases. The new cases reached successful writes, then received an empty reopened run list. Both exact restored stale-error tests passed.
- `run_4a3d85e92378f428ce28f0ca6ac2d25f`, `/tmp/s2-path-green-format.log`: after the one-function fix, **173/173** kernel cases passed, no skips. The exact reviewer path source passed on both runtimes with matching expected/actual persistent paths and one reopened run. Both exact reviewer runtime sources passed all five groups. `npm run format` processed 3431 files with no fixes or diff; no local formatter was run.

### Current final gates and fidelity

Historical unit failures remain observations, not reasons to add exclusions or reduce assertions. The latest reviewer unit run failed unchanged `interactive-engine-isolation.test.ts:104` (heartbeat 476.2ms against 100ms), while prior attempts failed the unchanged stage-resource test with undefined taskResponse and later passed. No lower-level cause has been established for either observation. The current gates and fidelity audit follow.

| Gate | Current-source evidence |
| --- | --- |
| C: format, no diff and check | `run_8ef938d3cff3f2243f0c000c95cc794a`, `/tmp/s2-path-final-gates.log`: `npm run format` processed 3431 files without fixes; `git diff --exit-code` passed; `npm run check` passed Biome, root/workspace typechecks and shrinkwrap with six existing informational diagnostics |
| F: exact selected durable suites plus process integration | Same run: exact 19-file selector and integration passed **20 files / 366 tests**, no skips; includes 62 backend, 173 kernel and five process cases |
| F: literal kernel command | Same run: `npx vitest --run test/unit/durable-sqlite-run-journal.test.ts` passed **173/173**, no skips |
| F: exact API/type compilation | Same run: completion5, prior general API, metadata API and full stored-value/constructor-union configurations passed unchanged |
| F: independent Node/Bun probes | Same run: exact reviewer path and five-group runtime probes passed; prior eight-case metadata, acquisition guards, seven negative-zero observations, ten ordinary groups and six earlier JSON/deletion groups passed; all eight real-child schedules and fresh-process rebuilds passed |
| Supplemental metrics | Same run: cached qlty0.654.0 `metrics --functions` passed on the changed journal file, using existing configuration; no config/plugin/dependency changes |

The main gate returned `ATOMIC_JOURNAL_GATE_EXIT=0`. Exact completion path/runtime probe hashes are `130ed9098969691cf4fa55168a8e426a80ddbaf1` and `517347d533602ba47fcccec2c67e2ad01d4cda34`; retained metadata source hash remains `120605b4a29531a6e5334fe28fdebcd14426557f`. Current journal and kernel-test hashes are `69263d8cb2c36c096ecb067aab5c949916837828` and `07fa1509d8e7fc4d1b0d462172c944ca3fdc2d9e`. Final note-inclusive hash comparison follows the unit gate.

U: `run_61eefd1e833ae0282f29a3ed6d573ded`, `/tmp/s2-path-final-unit.log`, ran the exact command `npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts` ALONE. It passed **930 files / 10,609 tests**, with only the 26 pre-existing skips, in 127.68s, `ATOMIC_JOURNAL_GATE_EXIT=0`. The wrapper applied exactly two exclusions. Both previously implicated unchanged files passed: interactive-engine-isolation 5/5 and workflow-stage-bundled-resources 10/10. No assertion, exclusion, skip, concurrency or timeout policy was changed to obtain this result. Their historical failures remain undiagnosed rather than reclassified as fixed S2 defects.

D: `run_26594dc395ca6165b99cfb132eb2881b`, `/tmp/s2-path-audit-2.log`, exported the actual designated baseline files into ignored Boat scratch storage and proved the complete 171-case kernel body byte-identical after removing only the added helper imports and two new cases. The path function is exact baseline text. Adapter, process fixture, contention suite and S1 notes remain byte-identical; existing types equal baseline plus the retained S2 synchronous interface. Local file-by-file inspection of the full baseline delta confirms the remaining 15 suite changes are import substitutions only, without changed assertions. All metadata formatting in the new baseline is already retained.

The same run replayed the exact evidence-reviewer source on Node/Bun: **15/15** groups each, with `EMPTY_REOPEN_RUNS 1`. The exact risk-reviewer default-backend source retained `persistent:true`, one event and the run before and after close/reopen on both runtimes. Canonical source hashes are `b352b632e9799007ed45e67c39b8d1cdeee586ae` and `64900ee5188099206ac2bb711ab7df5561848f35`. A preceding audit-only attempt, `run_6a0fdf105b579030303a19e4763d7d88` (`/tmp/s2-path-audit.log`), failed on an extra closing parenthesis in the scratch comparison script. Only that scratch syntax was fixed; no product code, tests or assertions changed. The successful rerun also formatted 3431 files without fixes or diff and passed whitespace validation.

All five findings are closed by the two focused repairs and current executable evidence. The resolved issues.md is removed. This batch changes only the path function, the kernel test file and these implementation notes; no API/type/schema changes, new dependencies, runtime wiring or other slices. The final note-inclusive local/Boat hash and whitespace audit is recorded in the signed commit receipt. The backend remains unwired: no UI, video or wired-runtime result is claimed. Remaining caveats are the historical unexplained unit failures, six informational diagnostics, 26 established skips and unbenchmarked full-replay/header-scan costs.
