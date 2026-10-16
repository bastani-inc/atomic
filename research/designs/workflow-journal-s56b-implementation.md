# Workflow journal s56b implementation

## Frozen goal

Wire the configured run journal into all workflow run entry points, remove the separate memory backend and remaining retired behavior, require boundary fingerprints, and update user guides and release notes. Part A's public journal contract and resolver remain the basis of this slice.

## Acceptance matrix

The commands in the verification table passed on the final executable changes. “Unit” and “integration” below refer to those complete suites, not selected subsets. Source and diff inspections were performed in the feature checkout.

| Clause | Evidence | Result |
| --- | --- | --- |
| Factory uses `RunOpts.journal: { path }`. | `workflow-journal-wiring.test.ts`, factory source, unit suite. | Pass |
| Factory uses a caller-owned `DatabaseSync`. | Wiring and `durable-journal-configuration.test.ts`, unit suite. | Pass |
| Explicit `{ memory: true }` selects a memory journal. | Wiring and resolver tests, unit suite. | Pass |
| A supplied `RunJournal` retains its identity. | Wiring test covers supplied journals, including a SQLite journal with its own `path` property. | Pass |
| Async-only custom journals need no synchronous methods. | Wiring test delays a custom journal append and checks that workflow completion waits. | Pass |
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
| Missing boundary fingerprints cause typed rejection. | `durable-journal-backend.test.ts` opening regression asserts `DurableNestedTopologyError` and reason. | Pass |
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
| No journal schema v1 names, event tags, encoding or lease constants change. | `durable/journal/types.ts` has no diff. | Pass |
| Dense ordered sequence numbers. | Shared conformance and SQLite contention suites. | Pass |
| Keyed first-writer-wins returns the first entry without a second write. | Shared journal conformance, unit suite. | Pass |
| CAS mismatch writes nothing. | Conformance and backend acquisition tests. | Pass |
| Lease epochs fence stale writers. | Conformance and execution-lease tests. | Pass |
| Deletion retains epoch tombstones. | Shared journal conformance. | Pass |
| Counter violations retain their typed errors. | Kernel/conformance tests; unchanged contract types. | Pass |
| Text validation rejects NUL before malformed Unicode. | Kernel/conformance text tests. | Pass |
| JSON payload NULs and lone surrogates round-trip unchanged. | Kernel/conformance and process fixtures. | Pass |
| The meta table has exactly one schema row. | SQLite and caller-owned configuration tests. | Pass |
| Unknown schema versions are errors, not migrations. | Kernel/configuration version-error tests. | Pass |
| WAL, FULL synchronization, busy timeout and foreign keys remain configured. | SQLite configuration tests and unchanged kernel. | Pass |
| Writes are visible on fresh connections; interrupted transactions are atomic. | Kernel and contention integration suites. | Pass |
| Bun can open, append and read the journal. | Public SDK/kernel child fixtures. | Pass |
| Pause, quit, answer, resume, status, catalog, heartbeat and delivery still work. | Complete unit/integration suites and execution-retirement regressions. | Pass |
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

The public `RunJournal` contract is asynchronous. Backend operations accept immediate or Promise results, while runtime callers await persistence. Internal synchronous capabilities preserve atomic expired-lease takeover and conditional deletion for the built-in journals. Async-only custom journals need no additional methods; their public contract has no expiry inspection or conditional-delete operation, so foreign ownership remains conservative rather than inventing automatic expired takeover.

The approved process-owner cache keys explicit files by resolved identity and caller-owned databases, supplied journals, and memory-option objects by object identity. Distinct memory-option objects remain isolated. Defaults resolve the current context before selecting a cached journal. Caller-owned journals are not closed by backend cleanup; owned journals are closed, and caller-owned database connections retain their existing non-closing rule.

## Final verification

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

## Contract amendments received

None. The implementation decisions above came from the supervisor and do not amend the user's frozen behavior contract.

## Deferred observations

Contributor setup prose differs from current repository instructions. It is outside this slice and remains unchanged.
