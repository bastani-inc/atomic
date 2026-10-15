# S5a implementation notes

Goal: remove only storage-independent legacy replay and topology handling, retaining current workflow replay behavior.

## Frozen acceptance matrix

| Requirement | Current-checkout evidence | Status |
| --- | --- | --- |
| Always use current child replay key; delete old counter/probe/conflict path and obsolete tests | durable-current-replay test plus current-key seeded boundary validation | Passed focused tests |
| Delete parseLegacyWorkflowChildResult and every caller | Removed definition/imports/calls; current-result projection regression and strict parser tests | Passed focused tests |
| Delete old prompt occurrence matching and validation | Explicit occurrence grouping regression; removed downgrade/upgrade test, retained current identity rejection test | Passed focused tests |
| Delete LEGACY_ACTIVE_RECONSTRUCTION | Strict active inspection policy and removed permissive branches/synthetic graph fallback; nested/repeated replay tests | Passed focused tests |
| Delete boundary topology fallbacks | Missing lifecycle regression, exact fingerprint validation, no source-identity relaxation | Passed focused tests |
| Delete stage topology upgrade behavior | Removed replay-only metadata hash marker; idempotent original metadata test | Passed focused tests |
| Delete legacyPosition | Persisted admissionOrder only; ordering, duplicate identity, and raw-message scenario | Passed focused tests |
| Delete format-version only if exclusively old-format gating | Current excluded writers depend on it; retained with caller evidence below | Satisfied conditional |
| Require fields runtime always writes; preserve legitimately optional fields | Required toolNodes/admissionOrder; explicit snapshot arrays and fixture orders | Constrained fingerprint exception below |
| Inventory every remaining legacy/compat/upgrade source hit with reason | Source search and full file/line inventory below | Inspected |
| Breaking change, no fallback/importer/data assumptions; no new replay semantics | Four baseline failures, five current regression passes; old child migration tests removed; current partial replay retains start record | Passed focused tests |
| Typed errors for controlled failures changed here; no message branching | DurableNestedTopologyError.reason asserted by class/field | Passed focused tests |
| Raw TypeScript, .js imports, no new dependencies/any/unknown | Scoped source diff; no manifests/build configuration changed | Inspected |
| Vitest/assert tests; no skips/soft guards; retain surviving coverage | Focused runs 15 files/86 tests and 4 files/13 tests; retained root replay/backend failure tests from removed migration suites | Passed focused tests |
| Format touched files on Boat; no unnecessary comments | npm run format with VCS changed-file filter; formatter diffs reapplied locally | Passed |
| npm run check ON BOAT | run_6c9d1c58d0171f878de6b6e242032a2e; Biome, both typecheck passes/type tests, shrinkwrap | Passed |
| Full prescribed unit gate ON BOAT | Same run, both prescribed excludes; 929 files, 10370 tests passed, 26 existing skips | Passed |
| Slice executable tests ON BOAT and git diff --check | 19 focused files/99 tests passed; local git whitespace check passed | Passed |
| No excluded recovery/storage/backend/factory/journal edits, no main/push/PR | Explicit excluded-path diff empty; required branch unchanged; no external actions | Inspected |
| Required branch, conventional breaking commit, all specified trailers | Signed commit carrying these notes on feat/workflow-journal-s5a-legacy-replay; final receipt records its identifier and clean status | Git verification in receipt |

## Interface choices and invariants

- Current child-result parser preserves accepted object identity, output values, ordering, duplicates, and text verbatim. No normalization or invented validation.
- Child replay keys come directly from the existing fingerprint-based generator.
- Prompt occurrence grouping uses only explicitly persisted occurrence identity; ordinary stage grouping remains by replay key.
- Boundary lifecycle remains new -> started/running -> failed/retry or completed/skipped terminal. Replay must preserve child identity, parent edges, source order, and exact invocation fingerprint. Illegal lifecycle and ownership inputs use the existing named topology error.
- Delivery admission ordering uses persisted admissionOrder, not collection position.
- Fields are made required only after checking actual writers. Truly optional caller attribution and non-graph checkpoints remain optional.
- Storage/model decisions outside S5a are not implemented here. Format-version callers and metadata fields in excluded files must be inspected before changing shared requirements.

### Exclusion-constrained field

Boat typecheck run `run_6aa29d92fbdfbb47cd8ccf08d4e794d5` reproduced TS2322 in excluded `durable/dbos-envelope.ts:440-441` when invocationFingerprint became required. The decoder constructs an optional field. Supervisor directed that no excluded file be touched, and that shared storage-boundary optionality remain while permitted runtime validation removes old acceptance paths. This field is therefore not strengthened in the shared storage type. Current boundary writers provide it and replay validation requires an exact match. `format-version.ts` remains because excluded envelope, metadata, prompt-reservation and tombstone writers use it for current records, not solely old-format gating.

RunSnapshot.toolNodes and PendingStageMessage.admissionOrder are required. Snapshot writers and structural fixtures receive explicit arrays/orders. Session-entry payload shapes remain unchanged; restore output gets an empty tool array where no tool exists. Origin remains optional because launchers can be unattributable. Tool outcomeKind remains optional because default successful tools do not write a return-mode tag. Pending stage metadata remains optional because excluded storage writers omit it when empty.

## Setup and conventions

Read the full approved spec, goal ledger, root manifest, DEV_SETUP.md, and Boat setup script. Root uses npm workspaces, TypeScript, Vitest and Biome; workflows ship raw TypeScript. The provided script provisions pinned toolchains, dependencies and build on Boat. No commands that execute code or checks run on the Mac. Initial branch and tree were verified clean. Recent commits use descriptive subjects and Assistant/User-preference trailers, with Boat validation.

## Validation

All commands that execute project code ran on the assigned implementer Boat through the exact wrapper supplied in the ledger, from this checkout root. Local commands were file edits/inspection and Git only.

- Setup succeeded on Boat: script installed pinned toolchains, `npm ci --ignore-scripts --no-audit --no-fund`, and `npm run build` on first use. No manifest/lock changes.
- `npm run format -- --vcs-enabled=true --vcs-client-kind=git --changed --since=HEAD^` scopes the root formatter's `.` argument to changed files. Formatter output patches were recovered from the wrapper stdout and applied locally before subsequent gates.
- Baseline regression run `run_4f5ab0b3ddabd5b6ecc3218928e86176`: restoring baseline child/stage/boundary/parser/occurrence source caused four of five regression tests to fail for removed behavior. Restoring current source produced five passes. Durable test file is `test/unit/durable-current-replay.test.ts`.
- Focused run `run_a652ecd09950eac58397663b4a5019b2`: `npx vitest --run --project unit test/unit/durable-{current-replay,repeated-child-replay,cached-child-reconcile-guards,completed-catalog-review,nested-completed-chat,nested-resume-hydration,replay-selector,resume-hydration-continuation,root-child-fixes,round1-boundary-validation,round1-completed-validation,round2-scoped-identity,round3-active-topology,stage-primitive,occurrence-identity}.test.ts` passed 15 files and 86 tests in 4.41 seconds.
- Follow-up focused run `run_be75060c17f867479183c49793f3797f`: `npx vitest --run --project unit test/unit/pi-0.83.0-dbos-replay-probe.test.ts test/unit/workflow-tool-{graph-replay,root-replay,checkpoint-failures}.test.ts` passed four files and 13 tests in 3.45 seconds.
- Executable scenarios exercise actual workflow execution, retained child/tool work, fresh backend hydration, partial child replay with its original start record, completed graph reconstruction, nested ownership validation, and raw prompt/delivery values. This is non-UI work; no browser or terminal UI scenario was manufactured.
- First full unit run failed 15 tests due obsolete keys/discriminators/lifecycle fixtures. Those fixtures now use current shapes. A later run exposed the removed current-identity validator argument in two call sites and child migration tests requiring an absent start record. Updated the argument call sites, removed only obsolete migration tests, retained surviving root/backend failure coverage, and restored the required start record in the valid partial replay fixture.
- Supplemental qlty was initially missing. Inspected the upstream installer, made one bounded Boat-only install to `/tmp/s5a-qlty-bin`, with `QLTY_NO_MODIFY_PATH=1`. Existing `.qlty/qlty.toml` was preserved. `qlty 0.654.0` metrics on current child code and baseline source succeeded: main function cyclomatic complexity 12 -> 7, cognitive complexity 12 -> 5; old counter/probe helpers removed. No qlty plugin lint/security run is claimed; authoritative Biome is part of npm run check.
- The gh-commit skill was not installed in the available bundled or user skill paths. Followed the spec's exact commit rules and inspected recent Git conventions and configured SSH signing instead.

Final gates ran on Boat in `run_6c9d1c58d0171f878de6b6e242032a2e`. `npm run check` exited 0. The exact prescribed unit command, `npm run test:unit -- --exclude test/unit/durable-embedded-postgres-root.test.ts --exclude test/unit/durable-embedded-postgres.test.ts`, exited 0: 929 files passed, 10370 tests passed, 26 pre-existing tests skipped, 115.43 seconds. No skipped test was introduced. The box script confirmed both exclusions applied. `git diff --check` passed on Boat and locally.

Local retained logs: `/tmp/s5a-verified-gates-run.log`, `/tmp/s5a-focused-run.log`, `/tmp/s5a-focused2-qlty-run.log`, and `/tmp/s5a-red-green2-run.log`. The focused tests and this committed note are the durable regression evidence; temporary logs are supplementary. All validation issues were resolved by in-scope fixture changes or the explicit storage-boundary exception, so the temporary issues.md was removed. No user guide or changelog edits were made because those are assigned to S6 and this slice adds no current-use configuration or troubleshooting steps.

Final source inspection found none of `legacyReplayCounts`, `nextLegacyReplayKey`, `hasLegacy`, `parseLegacyWorkflowChildResult`, `LEGACY_ACTIVE_RECONSTRUCTION`, or `legacyPosition`. The diff for excluded source paths was empty. The full file list is available from `git show --name-only` for the commit carrying this note.

## Remaining source hits

Inventory command: `git grep -nEi 'legacy|compat|upgrade' -- packages/workflows/src`. Paths below are relative to that source root. Each listed line is a retained hit; one reason applies to every line in its row.

| File | Lines | Reason retained |
| --- | --- | --- |
| durable/backend.ts | 87, 366, 760 | Explicit backend exclusion and recovery fields. |
| durable/dbos-backend.ts | 70, 305, 309, 315, 893, 934 | Explicit storage-file exclusion. |
| durable/dbos-embedded-postgres-root.ts | 235, 305, 349, 475, 947, 952, 953 | Explicit storage-file exclusion. |
| durable/dbos-embedded-postgres.ts | 306, 435, 613, 1112, 1213, 1214, 1216, 1262, 1309, 1312, 1315, 1642, 1652 | Explicit storage-file exclusion. |
| durable/dbos-envelope.ts | 80, 194, 203 | Explicit storage-file exclusion. |
| durable/dbos-metadata.ts | 69, 179 | Explicit storage-file exclusion and recovery fields. |
| durable/dbos-process-owner.ts | 19 | Explicit storage-file exclusion. |
| durable/dbos-row-guard.ts | 56 | Explicit storage-file exclusion. |
| durable/dbos-sdk-handle.ts | 409, 417, 428 | Explicit storage-file exclusion and recovery fields. |
| durable/dbos-tombstone.ts | 7, 20 | Explicit storage-file exclusion. |
| durable/tool-resume-frontier.ts | 80 | Tool abort/failure-frontier validation, not child replay or prompt topology handling named by S5a. |
| durable/types.ts | 88, 308 | Explicit recovery-field exclusion. |
| engine/run-tool-node-lifecycle.ts | 78, 141 | Current tool-parent graph consistency predicate, not an old-record fallback. |
| extension/atomic-stage-session.ts | 77, 78 | Agent configuration paths, outside replay/topology scope. |
| extension/background-ui-adapter.ts | 2, 22, 116 | Non-executor HIL adapter, not persisted topology. |
| extension/config-loader.ts | 119, 387, 392, 395, 408 | Configuration lookup precedence, outside S5a. |
| extension/discovery.ts | 131, 386 | Workflow discovery roots, outside S5a. |
| extension/public-types.ts | 10, 263 | AI package import path and explicitly excluded recovery argument. |
| extension/ui-surface.ts | 81, 87, 132 | Host UI capabilities, not durable replay. |
| extension/workflow-command-surfaces.ts | 76, 79 | Workflow reload-report rendering, not persisted topology. |
| extension/workflow-legacy-recovery.ts | 10, 23, 30, 35, 43, 52, 55, 60, 63 | Explicit whole-file exclusion. |
| extension/workflow-module-loader.ts | 28, 74, 97 | SDK module aliases, not persisted replay records. |
| extension/workflow-session-run-control.ts | 270 | Explicit recovery-argument exclusion. |
| extension/workflow-status-summary.ts | 85 | Public summary DTO attribution, not an old stored record. |
| extension/workflow-tool-control.ts | 670 | Best-effort control preparation is storage-coupled and outside S5a. |
| extension/workflow-tool.ts | 1, 20, 299, 300 | AI package import path and explicitly excluded recovery flow. |
| intercom/result-intercom.ts | 84 | Unknown control-message callback, unrelated to topology. |
| runs/background/run-inspect.ts | 61 | Public inspection DTO, not a stored run snapshot. |
| runs/background/status.ts | 98 | Public listing option, outside S5a. |
| runs/foreground/executor-types.ts | 185 | Public execution result DTO, not a stored snapshot. |
| runs/foreground/stage-runner-controller.ts | 1139 | Current model error classification, unrelated to old topology. |
| runs/foreground/stage-runner-pause.ts | 179 | Live pause adapter callback semantics, not persisted topology. |
| runs/shared/model-fallback-candidates.ts | 191, 196, 197, 198, 202, 206 | Model reasoning configuration, outside S5a. |
| runs/shared/model-fallback-failures.ts | 2 | Re-export of current model failure classifier. |
| runs/shared/retry.ts | 2 | Re-export of current retry policy. |
| runs/shared/validate-inputs.ts | 17 | Historical wording in authoring validation, not old record acceptance. |
| shared/authoring-contract-stage.ts | 71 | Model reasoning configuration, outside S5a. |
| shared/authoring-contract-ui.ts | 453 | Public UI observation DTO, not a stored snapshot. |
| shared/expanded-workflow-graph.ts | 30 | Current render projection terminology. |
| shared/graph-store-snapshot.ts | 67 | Bounded display result fields, not replay topology. |
| shared/schema-introspection.ts | 3, 28, 49, 85, 92 | Current authoring-schema to picker descriptor mapping. |
| shared/serializable.ts | 55 | Validation error path display format. |
| shared/sticky-stage-delivery-status.ts | 95 | Inspection distinguishes live transport receipts from context admission; storage receipt shapes are excluded. |
| shared/store-types.ts | 39, 59, 358 | Budget warning API, inspection marker for missing tool topology, and current tool-to-render projection. Runtime still has non-graph tool records, so topology absence is not solely old data. |
| shared/timing.ts | 10 | Preserve original optional execution timings; do not fabricate timings during hydration. |
| shared/types.ts | 163 | Live custom-widget adapter optionality, outside topology. |
| shared/workflow-run-ownership.ts | 16 | Current root-run IDs are legitimately omitted on roots; ownership validation is not old child-result parsing. |
| shared/workflow-stage-target.ts | 12, 35, 53, 55 | Rejection and actionable hint for unsupported external target syntax, not a replay fallback. |
| tui/chat-surface-message.ts | 51 | UI layout history. |
| tui/dispatch-confirm.ts | 10, 17, 194, 214, 259 | UI layout history and width behavior. |
| tui/graph-view-input.ts | 15, 32, 35, 333 | Host keybindings and live prompt UI. |
| tui/inline-form-editor-text.ts | 99 | Terminal paste markers. |
| tui/inline-form-overlay.ts | 143 | Host overlay capability detection. |
| tui/mouse-input.ts | 15 | Terminal mouse input protocol. |
| tui/node-card.ts | 167 | UI payload size accounting. |
| tui/pending-input-affordance.ts | 277, 279, 295 | Current prompt descriptor agreement predicate. |
| tui/prompt-card-render.ts | 26 | Optional UI run attribution. |
| tui/session-picker.ts | 102 | UI listing behavior. |
| tui/stage-chat-view.ts | 4 | Public UI module facade. |
| tui/text-helpers.ts | 37 | ANSI-aware text helper wrapper. |
| tui/widget-scroll-hint.ts | 4, 7, 20 | Raw terminal key sequences. |
| tui/widget.ts | 92 | Live/session snapshot quit-status display, outside child replay/topology. |

## Deferred

Supervisor confirmed the strict named-target scope after inspection of `durable/tool-primitive.ts:848-895`. Its standalone scoped/root tool reconstruction, the tool failure-frontier path, and optional public execution/inspection DTO fields remain outside S5a absent a direct dependency. The named boundary fallbacks are removed; current partial child replay retains the actual start record. No additional in-scope implementation is deferred. Shared storage-boundary fingerprint optionality remains the exclusion-constrained exception documented above.

## Contract amendments received

None.
