# S1 implementation and acceptance record

Goal: implement only the unwired journal kernel specified in workflow-journal-spec.md S1, validate on the supplied Boat lease, and commit on feat/workflow-journal-s1-kernel.

## Acceptance matrix

| Contract clause | Current-checkout evidence/check | Result |
| --- | --- | --- |
| Only S1, no S2-S6, compatibility, legacy, shared-host, replay changes, or runtime wiring | Branch delta remains three journal sources, two tests, one child fixture and this note; consolidated repair touches only the three sources, unit test and note | Pass |
| Three named source files and two named tests | packages/workflows/src/durable/journal/{types,node-sqlite,sqlite-run-journal}.ts; test/unit/durable-sqlite-run-journal.test.ts; test/integration/durable-sqlite-run-journal-contention.test.ts | Present |
| createRun returns created/exists; listRuns optional exact cwd filter | Unit creation/list/delete test checks duplicate header preservation and exact raw/empty cwd | Pass, focused run below |
| acquire, takeover, renew, release | Unit lease transition test covers initial/same-holder acquisition, held result, matching/mismatched takeover, renewal, release/reacquire; deletion test checks missing-run errors | Pass |
| append optional key and expectSeq; typed AppendOutcome | Unit durability/replay/CAS tests and both TypeScript passes | Pass |
| read AsyncIterable with inclusive fromSeq; readKey optional entry | Unit sequence/replay test covers omitted cursor, inclusive cursor, empty/missing keys | Pass |
| deleteRun and close | Unit deletion and idempotent close/storage error tests | Pass |
| Typed union includes started/finished, status, tool/ui/stage/task/boundary checkpoints, prompt asked/released, control, queued/delivered/settled messages, timer, summary | Unit event round-trip test enumerates every event type and checkpoint kind; check typechecks | Pass |
| WorkflowSerializableValue payloads, no any, unknown only SQLite boundary | types.ts payload definitions; source search finds unknown only in node-sqlite.ts row adapters and no any | Pass |
| Per-user node:sqlite path join(dirname(getAgentDir()), workflows, journal.sqlite), exact ATOMIC_WORKFLOW_JOURNAL_PATH override only | Unit path test checks PI-only is ignored and ATOMIC precedence, including empty/raw/relative overrides verbatim | Pass, repair validation below |
| Schema v1 named tables/columns/PKs/unique key | Unit exact schema/export test, replay and dense ordering tests, process contention test | Pass |
| WAL, FULL, busy_timeout 5000, foreign_keys ON; BEGIN IMMEDIATE lease/CAS | Adapter sets pragmas on every connection and transaction method begins IMMEDIATE; unit pragma checks and contention/CAS tests | Pass |
| Unknown schema version hard typed error; never migration | Unit versions 0/2/999 rejected with JournalSchemaVersionError fields and unchanged stored version | Pass |
| Dense per-run sequence, unique optional keys, first writer wins | Unit replay checks empty key, duplicate no extra row, two unkeyed rows, second run starts at 1; process test checks all 400 entries/keys | Pass |
| Append durable on resolve, fresh connection | Unit append durability test opens a separate connection while writer remains open | Pass |
| Stale takeover epoch throws StaleLeaseError fields | Unit lease transitions assert class/runId/heldEpoch/currentEpoch and no events | Pass |
| Stale expectSeq typed CAS error, no write | Unit CAS test checks new and duplicate keys, unchanged status/event count, then successful expected-tail append | Pass |
| deleteRun/listRuns(cwd); run-ID reuse remains legal and old leases stay fenced | Unit deletion clears header/events/key/holder while retaining the epoch; three delete/recreate cycles through fresh connections reject every old append/renew/release, permit new handles and preserve another run | Pass, repair validation below |
| SIGKILL child mid-transaction, no partial write, integrity_check ok | Integration child signals after two uncommitted writes, parent SIGKILLs it, reopens, verifies original event/status and integrity_check = ok | Pass |
| Two children, each 200 keyed events, one lease, dense all rows, no surfaced SQLITE_BUSY | Integration starts two Node children, releases both readiness barriers, checks exits/stdout/stderr, 400 dense seqs, unique keys and each persisted payload | Pass |
| bunExecutable child opens/appends/reads | Integration child uses bunExecutable(), writes/reads an empty-key event and parent checks persisted result | Pass |
| Typed journal errors and wrapped third-party causes; tests check class/fields | Unit missing-run/closed/storage/schema/CAS/lease assertions; storageBoundary preserves JournalError and wraps other errors with path/cause | Pass |
| Raw TypeScript, .js imports, no dependencies/build step | Staged-file list has no manifests/config/build changes; sources use .js imports and node:sqlite only | Pass |
| vitest + assert/strict; runtime helpers, unique temp DBs, no skips/soft guards | All original nine unit tests and three process tests retained; focused suite now 27/27, with 15 added unit cases and no new skips or soft guards | Pass |
| npm run format touched files, no unnecessary comments | Boat formatter fixed touched TypeScript only; touched-file diff passed git apply --check and was applied locally before final checks; no comments added | Pass |
| npm run check; amended full-unit command; slice tests; literal unit example; git diff --check | Required current-checkout commands and counts recorded below; all executable gates passed on Boat | Pass |
| Mac file work/git only; exact Boat wrapper; no local executable validation or sandbox lifecycle actions | Transcript shows all build/install/check/test/format work on Boat; targeted queued-command cancellation described below | Pass with cancellation exception recorded |
| Commit on slice branch with conventional breaking subject, model/workflow/verification/preferences/coauthor trailers; no main/push/PR | Signed slice commit contains required trailers; final receipt records SHA and clean tree | Final git inspection accompanies receipt |
| Export schema v1 table/column/event names, JSON-text encoding, version and lease semantics as constants/types, no ad-hoc literals | types.ts exported constants/types; SQL interpolates names; exact export strings asserted against schema | Pass |
| Never commit untracked root progress.md | Explicit staged-file list excludes it; progress is maintained outside checkout | Pass |
| Sole JournalCounterRangeError extends JournalError; readonly runId, field: seq/epoch, value: number, reason: overflow/negative/unsafe-integer | Exact export and adapted retained API compile, absence of obsolete class and every-field runtime assertions | Pass |
| Database seq/epoch domain 0..MAX_SAFE_INTEGER, including reads; successors checked transactionally before writes | SQLite counter adapters read integers as bigint before safe conversion, reject negative/fractional/above-MAX values with exact reasons; append/takeover/reacquire validate successor inside BEGIN IMMEDIATE before writes | Pass |
| Both counters seeded at MAX, -1, fractional and 2^53+2; exact error fields and unchanged rows | Seq append, epoch takeover/reacquisition and out-of-range access tests snapshot every table; read/readKey/replay, held/mismatched acquire/takeover, append/renew/release/delete; valid zero and MAX boundaries remain usable | Pass |

## Interface decisions and state invariants

The interface method names follow S1. RunHeader requires runId/name/cwd/createdAt/status, with optional serializable inputs. RunSummary is a RunHeader alias. LeaseOutcome is an acquired/held discriminated result; AppendOutcome returns status and the persisted JournalEntry. Returned collections are arrays; read is an AsyncIterable. Events preserve payload strings and array order without normalization. Status strings remain permissive. Optional keys distinguish absence from the empty string; empty keys participate in uniqueness. Key scope is per run. Duplicate createRun preserves the original header, and duplicate keyed append returns the first persisted entry. Sequence starts at 1; empty-tail CAS uses 0; reads are inclusive and ordered by sequence, never wall-clock time. Lists return arrays ordered by run_id. No cwd normalization or added format restrictions.

Lease states are missing run, unheld run, and held run. Missing-run acquisition/takeover raises RunNotFoundError. Initial acquisition starts epoch 1. Same-holder acquisition retains epoch; another holder receives a held outcome. Takeover requires an exact expected holder and advances epoch. Mismatched takeover returns held, with null holder when unheld. Renew validates holder/epoch without changing epoch. Release validates holder/epoch and retains the row with null holder; reacquisition increments epoch. Append/renew/release reject stale holder or epoch before writes. Lease validation precedes CAS; CAS precedes keyed replay so stale expectations always fail. Missing reads/deletions remain permissive. Deletion removes header/events transactionally and clears the lease holder while retaining the epoch as a durable fencing tombstone. Recreating a run ID is legal and its next acquisition increments the retained epoch, even for the same holder; unrelated runs are unaffected. Close is idempotent; further access raises StorageUnavailableError.

Every database-read seq/epoch must be an integer in 0..Number.MAX_SAFE_INTEGER. Counter queries use node:sqlite bigint reads through typed adapters so out-of-range SQLite integers become JournalCounterRangeError, not a conversion exception wrapped as storage failure. Negative counters use reason negative; non-safe integers (fractions or above-MAX values) use unsafe-integer. The sole counter error carries readonly runId, field (seq or epoch), numeric value, and reason; for a valid current counter whose successor overflows, value is the rejected successor and reason is overflow. Counter and successor checks occur inside the mutation transaction before writes. Zero and safe MAX counters may be read/replayed or renewed/released when no increment is needed; a new seq or epoch above MAX is rejected. No unrelated input normalization or validation is added.

Journal contract change: schema v1 leases.run_id no longer has a cascading foreign key to runs.run_id. Lease rows survive run deletion with null holder_id and their last epoch. This is the smallest durable fencing repair using the specified tables and columns, with no additional counter table, run-ID reuse restriction, migration or legacy path. All exported table, column, event, encoding and version names remain unchanged. The retained tombstones consume one small row per ever-leased run; deleting them would violate fencing.

## Original implementation validation history (before consolidated repairs)

Every executable validation command used this exact wrapper from the worktree root, replacing the final quoted command:

```sh
CRABBOX_SSH_KEY=/Users/tonystark/.ssh/ascii_box_ed25519 CRABBOX_STATIC_ID=aj-386ff92db84c crabbox run --provider ssh --target linux --static-host 46.105.118.142 --static-port 19037 --static-user user --static-work-root /home/user/crabbox --keep --script /Users/tonystark/.atomic/agent/workflows/dbos-journal-slices/in-box.sh -- origin/main '<command>'
```

| Command | Current evidence |
| --- | --- |
| npm run format | run_e5985444fa549c1bd31566cac3a8dc7e, exit 0, five added files formatted; patch replayed into local checkout. Final run_fd77bd24dbb85031e63da8e01d3abdbe reported no fixes. |
| npm run check && npx vitest --run test/unit/durable-sqlite-run-journal.test.ts test/integration/durable-sqlite-run-journal-contention.test.ts | run_6c6a8546eec8bd51e9258089413045c2, ATOMIC_JOURNAL_GATE_EXIT=0; Biome, both typechecks and shrinkwrap passed; 2 files/12 tests passed; process tests passed with rollback/integrity, 400 concurrent entries and Bun child checks. |
| npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts | run_307d9c3e137a666a05c313f830438cda, ATOMIC_JOURNAL_GATE_EXIT=0; 929 files passed, 10383 tests passed, 26 pre-existing skipped. New journal tests: 9 passed, none skipped. |
| git diff --check and git diff --cached --check | Local git whitespace gates passed before commit. |

Raw command transcripts remain in ignored .crabbox/s1-format.log, s1-final-check-focused.log and s1-amended-unit.log for this checkout. The supplied in-box script automatically installed dependencies with npm ci --ignore-scripts and built the workspace on the lease. No local npm/Bun/test/lint/typecheck command ran.

The tracer first failed because the journal module did not exist, then exposed an INSERT with eight placeholders for seven event columns. Correcting the placeholders made the fresh-connection test pass. Additional validation caught a test's PRAGMA busy_timeout result-column assumption, import ordering, and nullable computed-key narrowing; all were corrected and the final tests/check pass. These failures are retained in the ignored Boat transcripts, not hidden as successful runs.

The initial unexcluded unit gate ran 931 files: 929 passed, two pre-existing embedded-Postgres files failed with eight environment-related errors. The user replaced that gate and ordered investigation stopped. A queued diagnostic command was canceled during sync before launch with a targeted SIGTERM to its local crabbox process. The workspace owner released and --keep retained the lease. No baseline execution claim is made. The first two-exclude invocation still collected both files because Vitest projects ignore the CLI exclusions. The supervisor updated the external in-box script to expand the full selected unit file list minus those exact two files. The successful exact-command rerun logged `in-box: unit excludes applied (2 files excluded; Vitest projects ignore CLI --exclude)`. Neither excluded file nor repository test configuration changed.

The qlty skill was read; existing supplemental configuration was preserved. A remote read-only capability/installer-source probe timed out after 4m9s waiting for the workspace owner, before execution. No qlty installation, config change, metrics or smells run is claimed. Authoritative repository gates passed; optional expansion was stopped as directed.

The local pre-commit hook invokes Biome/npm checks. The signed commit uses a per-command core.hooksPath=/dev/null override to avoid prohibited local execution; it does not change repository hook configuration. Equivalent required checks ran on Boat.

## Contract amendments received

Define journal.sqlite schema v1 names, including tables, columns, event type strings, payload encoding, and schema version, as exported constants and types instead of ad-hoc literals. Do not rename them in later slices. A later slice that must change them states it on a "Journal contract change:" line in its commit body. Never commit the untracked progress.md in the main checkout root.

"stop investigating the embedded-Postgres failures. test/unit/durable-embedded-postgres-root.test.ts and test/unit/durable-embedded-postgres.test.ts fail on Boat at origin/main because they depend on the environment, and a later slice deletes them. The S1 gate deliberately runs: npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts. Use exactly that for your full-unit evidence on the lease, record it as such in the notes and commit trailers, and do not edit those two files."

The second amendment supersedes the initial unexcluded full-unit requirement for S1. The external wrapper adjustment implements its intended selection without repository changes.

The inherited counter amendment was missing from the prior implementation and acceptance record. During repair, an authoritative replacement amendment explicitly superseded its OverflowError API: export EXACTLY ONE JournalCounterRangeError extends JournalError with readonly runId: string, field: 'seq' | 'epoch', value: number, reason: 'overflow' | 'negative' | 'unsafe-integer'. Valid database counters are integers 0..Number.MAX_SAFE_INTEGER. Reject negative database values with negative and non-safe integers with unsafe-integer. Reject overflowing successors with overflow inside the SAME transaction before ANY write. Seed each field at MAX, -1 and 2^53+2 or a fraction via direct SQL; assert the exact class and every field, and unchanged rows for rejected mutations. No obsolete counter-error class remains. The repair implements the replacement amendment without changing public method signatures or adding unrelated input rules.

## Consolidated review repair record

The nine findings at review-round-latest.json:1424-1605 are exactly three repeated roots; all are addressed together in this repair.

| Root / consolidated finding ordinals | Diagnosis and repair | Durable prevention |
| --- | --- | --- |
| Fencing: 1, 5, 8 | Cascading lease deletion reset epoch to 1, reviving old authority. Retain unheld durable epoch tombstones; see Journal contract change above. | Three same-ID/same-holder delete/recreate cycles, fresh connections, exact stale append/renew/release errors, working new handle and unrelated run. |
| Path selector: 2, 4, 7 | Shared environment helper accepted PI_WORKFLOW_JOURNAL_PATH. Read process.env.ATOMIC_WORKFLOW_JOURNAL_PATH directly. | PI-only defaults correctly; exact ATOMIC precedence and empty/raw/relative values. |
| Counter amendment: 3, 6, 9 | Missing export/checks and node:sqlite integer conversion produced unsafe writes or wrong errors. Implement the replacement sole JournalCounterRangeError, bigint-aware typed adapters, range-checked reads and pre-write successor checks. | Both MAX fields, negative/fractional/already-above-MAX values; exact class/every field and full row snapshots; zero and safe MAX remain valid; retained 15 scenarios adapted to the replacement API/reasons, plus six negative scenarios. |

### Current repair validation

All repair commands use the exact wrapper above, serially, on the existing lease. Local work is file reads/edits/git only; no local runtime, formatter, tests, hooks, dependencies, new checkout, sandbox lifecycle action or optional qlty expansion. Raw logs are retained under ignored .crabbox/repair-*.log.

The durable regression sequence first reproduced fencing reset (1 !== 2, repair-root1-red-2.log), then PI-only selection (repair-root2-red-root1-green.log), absent counter export (repair-counter-red-root2-green.log), two MAX epoch missing rejections (repair-epoch-red.log), and six unsafe-access failures (repair-unsafe-red.log). Each was repaired and rerun successfully before proceeding. The first fencing test had a missing brace, caught by the remote transform in repair-root1-red.log; it was corrected before the behavioral RED run. The replacement range amendment then produced 12 failures, including negative counters accepted and the absent replacement class (run_3ce1434cad226f15ce50e1b214c0ce45, repair-range-amendment-red.log); the amended implementation passed all 24 unit tests (run_24364f768e6c9a1abc95a74bc9704b2d, repair-range-amendment-green.log). No failing test was suppressed.

Before the replacement amendment, the old overflow API/15-scenario oracle and npm check passed (repair-overflow-oracle.log, repair-check.log). These are historical evidence only, not proof of the final amended API. The final range oracle adapts all 15 retained scenarios to the new class and every field/reason, uses 2^53+2 for oversized-integer seeds, and adds six negative-counter cases; it also proves the obsolete counter class is not exported.

| Final command / scenario | Result and raw log |
| --- | --- |
| npm run format | run_4e657ba4bdb4d00399b195cce7c27894; formatted 3428 files, fixed one touched test file; ATOMIC_JOURNAL_GATE_EXIT=0. repair-range-format.log. Earlier repair-format.log fixed three touched files before the replacement amendment. Both formatting diffs were brought back with git apply after git apply --check; no unrelated formatting churn. |
| npm run check | run_2de32b430c51ee5d43397801070c9c51; Biome, root/workspace typechecks and shrinkwrap passed; ATOMIC_JOURNAL_GATE_EXIT=0. repair-range-check.log. |
| npx vitest --run test/unit/durable-sqlite-run-journal.test.ts test/integration/durable-sqlite-run-journal-contention.test.ts | run_c89408df9faaab7216caa95ca7b0f6b4; 2 files, 27 tests passed (24 unit, 3 process); ATOMIC_JOURNAL_GATE_EXIT=0. SIGKILL rollback/integrity, 400 concurrent keyed appends and Bun open/append/read passed. repair-range-focused.log. |
| npx vitest --run test/unit/durable-sqlite-run-journal.test.ts | run_5d171d411bc77799ffb968304cbed14f; literal required example, 1 file, 24 tests passed; ATOMIC_JOURNAL_GATE_EXIT=0. repair-range-literal-unit.log. |
| npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts | Exact amended command ran ALONE: run_a80bd45458a4900b1aa18e4aea29ca5c; 929 files, 10398 tests passed, 26 pre-existing skipped; ATOMIC_JOURNAL_GATE_EXIT=0. Wrapper logged `in-box: unit excludes applied (2 files excluded; Vitest projects ignore CLI --exclude)`. No excluded-file or test-configuration edits. repair-range-full-unit.log. |
| npx tsc -p .crabbox/range-tsconfig.json and adapted retained runtime oracle (.crabbox/repair-range-oracle.sh) | run_db54d8775882eb645c94d1700806478e; RANGE_API_COMPILE_EXIT=0, RANGE_RUNTIME_EXIT=0, RANGE_PROBE_COUNT=21, RANGE_PROBE_PASSED=21, ATOMIC_JOURNAL_GATE_EXIT=0. Exact sole class, readonly fields/type reasons, actual error class/every field, and unchanged full before/after snapshots. repair-range-oracle.log. |
| npm run format followed by the retained path/fencing risk oracle | run_911be6c37450b4783e783215bd344261; final format reported no fixes across 3428 files, all 7 risk groups passed, and ABA_LEASES showed old epoch 1/new epoch 2; ATOMIC_JOURNAL_GATE_EXIT=0. Custom-agent-dir default, PI-only ignored, primary raw/empty/relative overrides, permissive values and stale lifecycle operations all passed. repair-range-final-format-risk.log. |

Final local git diff --check and git diff --cached --check guard the exact five-file repair. Only three journal sources, the journal unit test and this note are staged; the existing integration suite and fixture remain unchanged. There were no production or test edits after the final formatter patch. The signed repair uses the documented per-command hooksPath override; final SHA/signature/clean-status inspection accompanies the completion receipt. Active review issues were removed from the ignored issues.md after their passing validations.

## Deferred items

No additional product work identified. S2-S6 remain outside this slice. User-facing docs and changelogs are unchanged because the kernel is unwired. Optional qlty metrics were not run. The two user-excluded environment-sensitive test files remain unchanged, not fixed by S1.
