# S7.7 implementation notes

Goal: add only the async SessionStore contract, MemorySessionStore and runner-independent session conformance suite.

## Contract amendments received

Authoritative supervisor file-ownership amendment:

> Supervisor file-ownership rule for S7.7 (parallel S7.1 owns shared foundation):
> 1. Do NOT create/edit packages/coding-agent/src/core/storage/index.ts, storage/errors.ts, @bastani/atomic/storage entry in package.json, user docs or CHANGELOG.md. Remove those changes.
> 2. Put everything under packages/coding-agent/src/core/storage/session/: contract types.ts, memory-session-store.ts, conformance.ts, session-specific errors.ts. Session errors extend plain Error subclasses there; later slice rebases onto S7.1 StorageError.
> 3. Tests import directly from these files. Public exports, docs/changelog wired later after S7.1 merges.

The accompanying direction removes root src/index.ts session exports and both package export entries, including testing. All those earlier edits were removed. The Node scenario imports compiled session modules directly.

> final/last commit MUST contain BOTH literal trailer lines: `Assistant-workflow: journal-slice` (this run) and `Assistant-workflow: dbos-journal-slices` (migration family).

> The unit gate is EXACTLY: npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts (the box script applies the excludes). Do NOT diagnose them.

Final binding text clarification supersedes the earlier broader text-validation direction:

> SessionInvalidTextError applies ONLY structural identifiers: `sessionId` every method argument, `header.id`, `header.cwd`, `header.parentSessionId`, `entry.id`, `entry.parentId`, `session_summary.summarizedThroughId`. Exact field union: "sessionId" | "header.id" | "header.cwd" | "header.parentSessionId" | "entry.id" | "entry.parentId" | "summarizedThroughId". Reject NUL/ill-formed before write, memory and all future stores.
> Everything else user text MUST round-trip NUL/lone surrogates losslessly in reads, including session_info.name, session_summary.summary, firstMessage, createdAt, returned listing title/summary. Later SQL stores keep returned user text in JSON; private search/index columns may normalize but memory needs no normalization.

Latest timestamp-policy amendment (supersedes the earlier raw-timestamp allowance and the initial permissive repair direction):

> Do NOT accept and then skip unrepresentable timestamps. Validate every timestamp a caller supplies (header and entry timestamps, and any time used for activity or ordering) at the write boundary, before any write, in every store including memory. Valid means it is accepted by the store's representation AND new Date(value) is a valid date (|ms| <= 8.64e15; for strings, a parseable ISO-8601 instant). Otherwise throw SessionInvalidTimestampError (storage/session/errors.ts) with readonly field (for example 'header.timestamp' or 'entry.timestamp'), value: string | number and reason: 'out-of-range' | 'unparseable'. Listing and findMostRecent can then always format timestamps. Add normal and reopen boundary regressions: values exactly at ±8.64e15 are accepted, ±8640000000000001 is rejected with that class and fields, nothing is written, and listing still works.

The exact timestamp field union is `header.createdAt`, `entry.timestamp`, `entry.message.timestamp` (every message role, not only activity roles) and `entry.systemMessage.timestamp` (the optional typed compaction system message, confirmed by supervisor). Arbitrary custom details/data/workflow JSON payloads are not timestamp schemas and remain lossless. Optional system messages remain optional.

Binding supervisor grammar clarification: use exactly `^(\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$` plus finite `Date.parse`. Do not add separate calendar or year checks. Seconds are optional; fractions of 1–9 digits require seconds; timezone is mandatory. Preserve accepted strings verbatim. Grammar mismatch (including date-only, local time and RFC prose) is `unparseable`. Numeric nonfinite or outside inclusive ±8.64e15 (including NaN and ±Infinity) is `out-of-range`. The earlier sentence claiming all grammar-valid strings not representable by Date are `out-of-range` was incorrect, not an authoritative amendment; the exact classification amendment below supersedes it.

### Authoritative timestamp-reason amendment (latest repair)

For a string matching the mandated regex where the original `Date.parse` returns NaN: (1) year token `-000000` means `unparseable`; (2) otherwise replace ONLY the year token with `2000`, preserving every other component and offset byte-for-byte, and parse again; (3) finite means `out-of-range`, NaN means `unparseable`. Grammar mismatches remain `unparseable`. Numbers are unchanged. This is classification-only: no additional calendar/year validation, input acceptance, normalization or timestamp-schema changes.

The three latest P2 findings share this classification defect in the common write validator. The preceding timestamp repair fixed acceptance and atomic validation but did not correctly distinguish regex-matching invalid components from range overflow. Its historical passing gates below did not cover that distinction and are not current-tree proof.

## Acceptance matrix

All conformance cases run normally and with close/reopen boundaries. The current gate results are recorded below.

| Requirement | Check |
| --- | --- |
| Session format constant is 4; header has id, version, createdAt, cwd and optional parentSessionId, internal: true, workflow | types.ts; header replacement/round-trip conformance; typecheck |
| Snapshot is { header, entries, lastSeq }; append order defines reopened leaf | Append-order/shared-entry-ID case |
| Summary has required id, cwd, internal, hasName, createdAt, modifiedAt, messageCount, firstMessage, searchText; optional parentSessionId, workflow, name, summary, summarizedThroughId, location | Summary, empty/optional-field and raw user-text cases; typecheck |
| SessionListQuery optional cwd/includeInternal/signal; SessionWriteOptions mandatory expectSeq | types.ts; filter, abort and CAS cases |
| Independent readonly descriptor adapter/location | Descriptor mutation test; no facade dependency |
| Async atomic create with {lastSeq}; SessionExistsError.sessionId on duplicate | Create/duplicate conformance |
| Async atomic append with order and {lastSeq}; missing ID typed; stale sequence typed with expected/actual fields and no writes | Append-order, stale-write, missing-ID and racing-writers cases |
| Async atomic replace with header/entries and {lastSeq} | Replacement, stale-write and invalid-text cases |
| Async load or SessionNotFoundError; async readHeader or undefined | Missing/delete/header cases |
| Async delete and recreate | Delete/recreate case; missing delete remains a no-op |
| Async iterable list; unspecified order; exact cwd filter; internal hidden by default | Filtering case |
| Abort raises AbortError before or between yields, with no later output | Abort case with default and custom abort reasons |
| Async findMostRecent uses user/assistant modified time, creation fallback and internal filter | Filtering, summary activity and empty-session cases |
| Every operation after close, including repeated close, rejects StoreClosedError.adapter/location | Closed-operation case, including active iterator |
| Copy on write/read, no caller aliases; process-local memory lifetime | Detached header/entry/summary cases and memory-handle test |
| Reopen variant without claiming disk/process durability | Fresh handles share only private in-process JSON records |
| Runner-independent registerSessionStoreConformance({describe,it},name,withSubject), node:assert/strict, fresh subject per case | Vitest registration and built-module Node test runner scenario |
| Session errors directly extend Error; typed fields; no any/unknown or untyped errors introduced | errors.ts; assertions on classes/fields; npm check |
| Structural field union exactly sessionId/header.id/header.cwd/header.parentSessionId/entry.id/entry.parentId/summarizedThroughId | Invalid-text conformance covering every field and method argument |
| NUL takes precedence over ill-formed Unicode; invalid writes leave no partial data | Invalid-text case with NUL-only, lone-surrogate-only and combined strings |
| Non-time user text including names, summaries, workflow metadata and nested payloads remains raw and lossless | User-text, JSON-body and message-summary cases; timestamp strings instead obey the latest amendment |
| Stored entry bodies use JSON text escaping; detached reads parse JSON | Memory records are JSON strings; nested NUL/lone-surrogate round-trip |
| Every schema timestamp is validated before create/append/replace mutates storage; SessionInvalidTimestampError carries exact field/value/reason | Boundary/ISO-string/nonfinite/compaction conformance cases; expanded invalid-component/range matrix checks typed error, no partial writes or sequence changes, usable list/findMostRecent |
| Inclusive numeric Date bounds and valid ISO instants round-trip verbatim; list/findMostRecent preserve ordering, count, firstMessage and creation fallback | Boundary ordering and ISO-form conformance cases, normally and after reopen; acceptance predicate unchanged by the reason-only repair |
| Code only under storage/session; no shared storage index/errors, public package exports, guide/changelog edits | Final diff inspection |
| Portable runtime modules have no node imports; .js relative runtime imports; exact existing entry types | Runtime-boundary test; type-only package self-reference; clean build |
| No SessionManager/caller, facade, dependency, version, generated schema or other-slice changes | Final diff inspection |
| npm run check; exact amended unit gate; focused tests; git diff --check, all heavy commands on assigned Boat | Gate commands/results below |
| Required branch, conventional commit, both workflow lines, model/verification/preference/coauthor trailers, clean worktree; no push/PR | Final Git inspection |

## State and interface decisions

- No SessionStore method signatures were changed. SessionEntry and SessionWorkflowMetadata retain the existing exported types through type-only `@bastani/atomic` imports. Runtime imports remain local .js paths. Clean compilation with dist removed passed, proving no dependency on pre-existing build output.
- Structural text checks apply only to the exact amended field union. Empty strings and well-formed unusual Unicode remain accepted in structural fields. Queries have no new cwd restrictions. Non-time user text is preserved, including whitespace, NUL and lone surrogates; schema timestamps obey the separate latest amendment above.
- Optional fields remain omitted when absent. JSON-compatible values are serialized on writes and parsed on reads. Duplicate entry IDs are retained, including within one session; only duplicate session creation is rejected.
- Sequence equals entry count. Empty create/replace yields 0; append advances by batch length. Empty writes retain sequence. CAS precedes mutation. Header identity is stored verbatim under the supplied replacement key; no additional mismatch rule is invented.
- States are absent -> created -> appended/replaced -> deleted -> recreated. Missing reads/writes and conflicting writes reject without mutation. Close makes the handle closed; all later SessionStore operations reject. Descriptor access and concrete reopen are outside that operation set.
- Concrete MemorySessionStore.reopen() returns a new open handle sharing private in-process records. The suite closes the old handle first. Reopen does not require that old handle to be closed and does not persist across process exit.
- hasName records presence of session_info, including empty names. First-message/search-text extraction includes user/assistant text only; absent first user text is '(no messages)'. modifiedAt uses the latest validated user/assistant time, or the verbatim validated createdAt with no such messages. Latest session_summary wins. No timestamp is rewritten or skipped; invalid timestamps reject the whole write before mutation.
- Listing order and equal-time tie order remain unspecified. cwd comparison is exact.

## Validation status

All heavy commands use the exact implementer Boat wrapper from the goal ledger, lease aj-7bbc9714715b. Mac operations are inspection, editing and Git only.

The initial implementation gates below are historical; latest timestamp-repair evidence is recorded separately after this table. They are not a substitute for current-tree validation.

| Command, run on the assigned Boat unless noted | Result | Evidence |
| --- | --- | --- |
| `npm --workspace=@bastani/atomic run clean && npm --workspace=@bastani/atomic run build` | Passed with dist absent before compilation | /tmp/s7-7-final.log |
| `npx vitest --run --project unit test/unit/memory-session-store.test.ts test/unit/session-store-runtime-boundary.test.ts test/unit/module-import-specifier-consistency.test.ts` | 3 files, 38 tests passed | /tmp/s7-7-final.log |
| `node --test test/fixtures/session-store-conformance.mjs` | 34 tests passed, no skipped tests | /tmp/s7-7-final.log |
| `npm run check` | Passed Biome, both typecheck passes/type tests and shrinkwrap check | /tmp/s7-7-final.log |
| `npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts` | 930 files passed; 10413 tests passed, 26 existing tests skipped; exit 0 | /tmp/s7-7-unit-final.log |
| Disable the two checks in validateSessionText, run the memory test, restore the file and rerun focused tests | 4 failures and 32 passes without checks; all 38 focused tests passed after restoration | /tmp/s7-7-final.log |
| `qlty metrics --functions packages/coding-agent/src/core/storage/session packages/coding-agent/src/core/auth-storage-backends.ts` and `qlty smells` on the three runtime implementation files | Qlty 0.654.0 ran; one informational cognitive-complexity finding, summarizeSession = 29 | /tmp/s7-7-final.log |
| `git diff --check` and `git diff --cached --check` locally | Passed | Final Git inspection |
| `npm run format && git diff --exit-code && git diff --check` | Formatted 3438 files; no fixes applied; exit 0 | /tmp/s7-7-format.log |

The first amended unit invocation ran concurrently with check's AI build and hit eight credential-store import failures. The exact same unit gate passed standalone with no production changes. Build/check and unit execution should not overlap their generated outputs. This is not an additional exclusion.

Historical evidence, not a substitute for the amended-tree gate:

- Initial new-module RED and first green: /tmp/s7-7-red.log and /tmp/s7-7-green.log; 26 focused tests passed after adding memory.
- Pre-amendment expanded tests: /tmp/s7-7-gates.log; 29 focused and 26 compiled Node cases passed. The unexcluded unit gate failed in the two later-excluded files and the then-new mixed-extension import. Formatting/export ordering and imports were corrected or removed.
- Repeated-close mutation check: /tmp/s7-7-prevalidation.log; two cases failed with 'Missing expected rejection', then passed with strict close restored. Clean build passed. The already-admitted command completed its old baseline steps before the no-diagnosis amendment; no further Postgres diagnosis was run. Qlty 0.654.0 installed on Boat only.

## Earlier review repair: timestamp validation

The completion, evidence and risk reviewers' three blocking findings are the same root cause: `Number.isFinite` in `summarizeSession` admitted numeric activity beyond Date's representable range, and `toISOString()` then threw an untyped RangeError during both listing and recent selection. The latest contract amendment resolves all three together at the write boundary, not by skipping activity or rewriting records. Existing create/append/replace validation now checks every declared timestamp before mutation and throws `SessionInvalidTimestampError` with readonly field/value/reason. The summary algorithm and manager/callers are unchanged.

The focused conformance suite now has 26 cases, each run normally and across close/reopen (52 total). New cases cover both rejected numeric signs, typed errors and atomicity for all writes, string grammar/range rejection, nonfinite numbers even in non-activity messages, optional compaction system timestamps, accepted inclusive Date bounds, raw timestamp preservation, chronological ordering rather than append/creation ordering, firstMessage/count/searchText, and creation fallback. Non-time NUL/lone-surrogate text and arbitrary custom JSON remain lossless. Invalid raw timestamp fixtures were replaced only because the binding amendment changed their validity.

| Earlier repair command/scenario (assigned Boat) | Observed result | Evidence |
| --- | --- | --- |
| `npx vitest --run --project unit test/unit/memory-session-store.test.ts -t "rejects out-of-range message timestamp"` before numeric validation | RED: 4 failures, `Missing expected rejection`; the name filter deselected 36 other tests | /tmp/s7-7-timestamp-red.log |
| `npx vitest --run --project unit test/unit/memory-session-store.test.ts` after numeric validation | GREEN: 40 passed | /tmp/s7-7-timestamp-green-numeric.log |
| Same memory command, new header/entry ISO-string rejection cases before string validation | RED: 4 failed, 40 passed; missing expected rejection | /tmp/s7-7-timestamp-red-strings.log |
| Same memory command after exact ISO grammar/Date.parse validation | GREEN: 44 passed | /tmp/s7-7-timestamp-green-strings.log |
| Same memory command, new optional system-message rejection cases before validation | RED: 2 failed, 46 passed; missing expected rejection | /tmp/s7-7-timestamp-red-system.log |
| Same memory command after optional system-message validation | GREEN: 48 passed | /tmp/s7-7-timestamp-green-system.log |
| `npm --workspace=@bastani/atomic run clean && npm --workspace=@bastani/atomic run build` | Passed with dist removed | /tmp/s7-7-timestamp-final-gates.log |
| `npm run check` | Passed Biome, both typecheck passes/type tests and shrinkwrap; 5 unrelated informational Biome diagnostics | /tmp/s7-7-timestamp-final-gates.log |
| `npx vitest --run --project unit test/unit/memory-session-store.test.ts test/unit/session-store-runtime-boundary.test.ts test/unit/module-import-specifier-consistency.test.ts` | 3 files, 56 tests passed, no skipped tests | /tmp/s7-7-timestamp-final-gates.log |
| `node --test test/fixtures/session-store-conformance.mjs` | 52 passed, no failures or skipped tests | /tmp/s7-7-timestamp-final-gates.log |
| `npm run format && git diff --exit-code && git diff --check` | 3438 files, no fixes or diff; exit 0 | /tmp/s7-7-timestamp-final-gates.log |
| `npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts` | 930 files passed; 10431 tests passed, 26 existing skipped; exit 0. Ran after build/check settled, with exactly the two authorized exclusions | /tmp/s7-7-timestamp-unit-final.log |

The format preview changed two test files on Boat; those exact formatting changes were mirrored locally before the final gate. `issues.md` tracked each RED and was removed when focused/compiled validation passed. Goal 7dcdcc78 remains active; final completion belongs to the reviewers/reducer.

## Current review repair: timestamp reason classification

The only implementation delta is a string-NaN classification branch. It never returns successfully: original grammar mismatches still reject before parsing, original finite parsed instants still pass, original NaN still rejects, and numbers use the unchanged finite/inclusive-range check. Thus the accepted/rejected input set is unchanged, including Date.parse normalization of `2026-02-30T00:00:00Z`. The exact regex and all four timestamp schema paths are unchanged.

The existing header/entry invalid-string conformance cases now include the following literal matrix. Each case runs normally and with close/reopen, asserts `SessionInvalidTimestampError` and exact `field`/`value`/`reason`, exercises create/replace and entry append, and checks unchanged snapshot/sequence, absent rejected session, usable list and findMostRecent after each rejection.

| String examples | Expected reason |
| --- | --- |
| `2026-13-01T00:00Z`, `2026-13-15T00:00Z`, `2026-13-15T00:00:00Z`, `2026-99-15T12:00Z` | `unparseable` |
| `2026-10-15T25:00Z`, `2026-10-15T25:00:00Z` | `unparseable` |
| `2026-10-15T00:00+24:00`, `2026-10-15T00:00+99:00` | `unparseable` |
| `-000000-01-01T00:00Z`, `-000000-10-15T00:00:00Z` | `unparseable` |
| `+275761-13-01T00:00Z`, `+275761-01-01T00:00+24:00` | `unparseable` (invalid suffix preserved despite overflowing year) |
| `+275761-01-01T00:00Z`, `-271822-01-01T00:00Z` | `out-of-range` |
| `+275760-09-13T00:00:00.001Z`, `-271821-04-19T23:59:59.999Z` | `out-of-range` |

Inclusive bounds remain accepted in the boundary case, including `+275760-09-13T00:00:00.000Z` and `-271821-04-20T00:00:00.000Z`, plus numeric ±8640000000000000. Numeric just-beyond and nonfinite cases are unchanged.

| Current repair command/scenario (assigned Boat) | Observed result | Evidence |
| --- | --- | --- |
| `npx vitest --run --project unit test/unit/memory-session-store.test.ts` before classifier repair | RED: 4 failed, 50 passed; actual `out-of-range` versus expected `unparseable`, stack at conformance.ts:365 | /tmp/s7-7-reason-red.log |
| Same memory command after classifier repair | GREEN: 54 passed, no skips; entire literal invalid-component/range matrix and prior acceptance cases pass | /tmp/s7-7-reason-green-format.log |
| `npm run format` preview after classifier repair | 3438 files, no fixes; no Boat formatting delta to mirror | /tmp/s7-7-reason-green-format.log |
| `npm --workspace=@bastani/atomic run clean && npm --workspace=@bastani/atomic run build` | Passed with dist removed | /tmp/s7-7-reason-final-gates.log |
| `npm run check` | Passed Biome, root/coding-agent typechecks, type tests and shrinkwrap; 5 unrelated informational diagnostics | /tmp/s7-7-reason-final-gates.log |
| `npx vitest --run --project unit test/unit/memory-session-store.test.ts test/unit/session-store-runtime-boundary.test.ts test/unit/module-import-specifier-consistency.test.ts` | 3 files, 56 tests passed, no skips | /tmp/s7-7-reason-final-gates.log |
| `node --test test/fixtures/session-store-conformance.mjs` | 52 normal/reopen cases passed, no skips | /tmp/s7-7-reason-final-gates.log |
| `npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts` | 930 files, 10431 passed, 26 existing skips; only the two authorized exclusions | /tmp/s7-7-reason-final-gates.log |
| `npm run format && git diff --exit-code && git diff --check` | 3438 files, no fixes, no diff; passed both before and after the sequential gates | /tmp/s7-7-reason-final-gates.log |

Boundary headers spell the same accepted ISO extrema literally instead of deriving them with `toISOString()`. All gates above ran sequentially, with build/check complete before unit execution. No formatting delta needed mirroring. `issues.md` recorded RED, repair and GREEN, and was removed after resolution. The final notes tree is rechecked with the same full sequential gate suite; its log is `/tmp/s7-7-reason-current-tree.log` and the external receipt `/tmp/s7-7-timestamp-reason-receipt.md` records the terminal outcome and commit. Goal 7dcdcc78 remains active pending reviewers/reducer.

## Deferred

Public exports, shared StorageError integration, guides and changelog wiring are deferred by the ownership amendment. No other scope added.

The qlty cognitive-complexity observation is non-blocking; no unrelated refactoring was added to change a metric.
