# S5a implementation and consolidated repair

Goal: remove every storage-independent compatibility path under amended S5a while retaining current workflow behavior.

## Contract amendments received

User directive: "remove anything that is legacy".

S5a removes EVERY storage-independent legacy, back-compat, deprecated, migration, upgrade or fallback-reader path anywhere in packages/workflows/src, including UI/TUI, config loading, schema introspection, discovery/module loading, legacy frontier, deprecated aliases, old input/key shapes. Delete tests solely for removed paths. Retain only storage-coupled paths or words not denoting compatibility; EACH retained hit/reason goes directly in commit body. Explicit storage/recovery/journal exclusions remain.

Correction: the original named-target-only deferrals and no-amendment statement are superseded. The fingerprint type conflict is unresolved, not an approved exception.

## Acceptance matrix

| Requirement | Implementation and current oracle |
| --- | --- |
| Current child replay keys only | Removed ordinal legacy key counters, probes and mixed-key selection. `durable-current-replay.test.ts` and repeated-child replay cover current identity. |
| Current child result parser only | Removed `parseLegacyWorkflowChildResult` and all callers. Current parser and topology tests retain exact values and identity. |
| Explicit prompt occurrence identity only | Removed missing-occurrence coalescing and old topology validation. Current occurrence tests remain. |
| Strict active and completed reconstruction | Removed `LEGACY_ACTIVE_RECONSTRUCTION`, synthetic nested graphs, boundary lifecycle/fingerprint acceptance and stage topology upgrades. |
| Persisted delivery admission order | Removed `legacyPosition`; `admissionOrder` is required. Delivery ordering, raw message preservation and duplicates remain covered. |
| Current tool replay only | Missing tool topology raises `DurableToolTopologyError` with workflowId/argsHash. Removed topologyless graph reconstruction and sequence-derived tool order. Current interrupted root replay skips the completed callback; rejection tests verify no added record or callback. |
| Explicit failed tool frontier | Removed abort-message matching and old frontier checkpoint inference. Current frontier test requires `failedToolNodeId`. |
| Current configuration and discovery | Default roots use only `.atomic`, honoring explicit current agent-directory overrides. Removed old workflow and TypeBox virtual aliases and obsolete builtin scan roots. Current config/discovery/module tests exercise files rather than source shape. |
| Current API and reasoning options | Removed `runWorkflow` migration stub/declaration, `assertWorkflowCreatedStage`, separate authored `thinkingLevel`/`fallbackThinkingLevels` and scoped-model reasoning fields, old target parser/hints, and ignored `statusRuns.all`. Suffix-based current model failover remains. |
| Current UI/input behavior | Removed X10 mouse parsing, graph run-level prompt fallback and its obsolete adapter/tests, old quit timestamp inference, old empty reload formatting and zero-argument pause-release adaptation. Current stage-local UI and SGR input remain covered. |
| Required current DTO fields | Runtime and authoring RunResult.toolNodes and RunDetail.tools are required; tool summary runId is required. Custom UI adapters implement every method. Structural and standalone typing fixtures updated. |
| Required boundary invocation fingerprint | UNRESOLVED. Current writer supplies it and runtime requires exact equality, but the prohibited decoder constructs it conditionally. See exact compiler evidence below. |
| Format-version conditional deletion | Retained because excluded current record writers use it; it is not solely an old-format gate. |
| Typed changed failures | `DurableNestedTopologyError.reason`, `DurableToolTopologyError.workflowId/argsHash` and `WorkflowUIAdapterError.method` use named classes and typed fields. New tests branch on classes/fields. |
| Obsolete tests removed; current coverage retained | Removed only migration/old-alias/topologyless/graph-prompt tests. Preserved current nested/root/continuation replay, model failover, stage UI, ordering and backend-failure coverage. No new skips. |
| Complete residual classification | Inventory below covers every `legacy|compat|deprecat|migrat|upgrade|back-?compat|fallback` hit, grouped by file with every line named. The same inventory is included directly in the repair commit body. |
| Boat checks and full unit gate | Passed current source: npm run check, 929 unit files/10,314 assertions and 54 focused integration assertions. Formatting and current terminal scenario also pass. No project execution on the Mac. |
| Scope, branch and commit | Only S5a on `feat/workflow-journal-s5a-legacy-replay`. Explicit storage/recovery/journal exclusions are unchanged. No dependency changes, push, PR or lease lifecycle operations. |

## Required boundary type conflict

The excluded `durable/dbos-envelope.ts` function `boundaryTopology` is explicitly annotated to return `DurableWorkflowBoundaryTopology | undefined`. It accepts missing invocationFingerprint and builds identity with a conditional spread. Requiring the public field therefore makes that concrete return value unassignable. Making a union accept that object would still accept omission; a cast would be unsound; a replacement storage type would require editing the excluded decoder. No in-scope exact solution was found.

Current source-only Boat probe in `/tmp/s5a-repair-gates5-run.log` changed only `readonly invocationFingerprint?: string` to required, then compiled a temporary tsconfig extending the repository config with `include: ["packages/workflows/src/**/*.ts"]`. `FINGERPRINT_SOURCE_EXIT=1`, with exactly TS2322 at `durable/dbos-envelope.ts:440:25` and `:441:2`. Both report `string | undefined` not assignable to `string`. The probe restored the current source and removed its temporary config before normal checks. No prohibited source was modified in this checkout. This finding needs a real contract resolution; passing gates with the optional field does not close it.

## Current behavior and retained distinctions

Current failed-model retry/failover, schema-to-input-form projection, compact graph display, error rendering, terminal key collision detection, third-party error classification and genuine optional capabilities are not old-record readers. Word matches alone do not justify deleting them. Current tool continuation reattributes already-present topology to a fresh run without fabricating absent topology. Current queue entries can precede stage materialization, so destination identity and receipt/session metadata can legitimately be absent. Origin attribution remains optional for unattributable launchers. Default successful tools do not write a return-mode tag. Non-graph internal checkpoints are not execution nodes.

## Validation record

All executable commands ran from this checkout through the assigned implementer Boat wrapper. The Mac only inspected/edited files and ran Git. Existing Boat setup had pinned toolchains, npm ci --ignore-scripts and a successful build.

The first repair unit gate exposed obsolete aliases, fixtures and old-path tests. These were repaired or deleted according to the amended contract, not skipped. A later full gate ran 10,314 assertions successfully but failed an empty obsolete describe block; that block was removed. Standalone package fixture imports stay on the actual raw package they symlink, rather than depending on the removed virtual loader alias. User-facing guides and unreleased breaking-change notes describe the removed options and current imports.

- Required current-source gates in `run_84885d515a3ed8735e6e1c02090dff56`, `/tmp/s5a-repair-final-gates-run.log`: `npm run check` exit 0, exact prescribed unit command exit 0, 929 files/10,314 passed assertions/26 pre-existing skips, 114.91 seconds. No new skipped test was introduced. `git diff --check` exit 0. The command's overall exit 1 was solely an empty staged-file formatter selection; explicit existing-file formatting succeeded. A subsequent ordinary `npm run format` succeeded with no edits.
- Focused integration command: `npx vitest --run --project integration test/integration/workflow-package-typing.test.ts test/integration/workflow-package-output-typing.test.ts test/integration/workflow-package-input-typing.test.ts test/integration/workflow-pending-stage-delivery.test.ts`. Passed 4 files/54 assertions in 10.78 seconds in that same gate run.
- Current docs and replay regression command: `npx vitest --run --project unit test/unit/docs-information-architecture.test.ts test/unit/changelog.test.ts test/unit/workflow-current-config.test.ts test/unit/workflow-current-contract.test.ts test/unit/workflow-current-types.test.ts test/unit/workflow-tool-root-replay.test.ts`. Passed 6 files/52 assertions after the final guide edit in `run_015340bd0b76f38a517a919709db23d8`, `/tmp/s5a-repair-tui-docs-final-run.log`.
- Regression red/green in `run_d75538fbc07274142ab1a2adb228a497`, `/tmp/s5a-repair-inventory-gates7-run.log`: restoring baseline source for configuration, discovery, module loading, API stubs, model reasoning, target/mouse parsing, frontier and tool replay causes 8 of 9 focused cases to fail for the removed behavior; the current interrupted replay case already passes. Restoring current source passes all 11 assertions across the 4 current-contract files. An earlier attempted comparison used the wrapper's synthetic HEAD and therefore did not restore baseline; it is not regression evidence.
- `npm run format` passed without changes in `run_015340bd0b76f38a517a919709db23d8`. Earlier changed-file selections accidentally included deleted paths; the final ordinary formatter processed 3,423 files and made no edits, so no unrelated formatting entered the diff.
- Real terminal scenario on Boat: confirmed `/usr/bin/tmux`, launched `bun test/fixtures/workflow-fallback-terminal.ts` in a dedicated 100x36 terminal, observed `model-a · high` and sibling `unchanged · low`, sent `f`, observed `model-b-fast · medium` while the sibling remained unchanged, sent `q`, and observed process exit 0. Both captures and exact commands are in `/tmp/s5a-repair-tui-docs-final-run.log`. This exercises real rendering and SDK selection/events with controlled transport; no live provider or browser claim is made.
- Qlty existing configuration was preserved. Cached `/tmp/s5a-qlty-bin/qlty metrics --functions` and `qlty smells` ran on tool-primitive, config-loader and model-fallback-candidates, both exit 0. Smells reported current large-function/complexity findings; no clean-smell or plugin security coverage is claimed. These are diagnostic scope-external refactor suggestions, not grounds to widen S5a.
- Every remaining hit is inventoried below: 442 matching lines in 121 files. The explicit excluded-source diff is empty. Source inventory generation and temporary fixture scripts ran only on Boat and were removed; none is shipped.

## Residual source-hit inventory

Inventory command: `git grep -nEi 'legacy|compat|deprecat|migrat|upgrade|back-?compat|fallback' -- packages/workflows/src`. Each listed line is a retained hit; its row's reason applies to every listed line.

| Source file | Every matching line | Retention reason |
| --- | --- | --- |
| authoring.ts | 78 | Current model-failover type export, not an old API alias. |
| durable/backend.ts | 82, 87, 287, 366, 760 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/completed-catalog.ts | 333, 388, 478, 479, 482, 483 | Current missing timing/empty non-graph state projection; tool identity and order require persisted topology, not checkpoint position. |
| durable/dbos-admission-config.ts | 12 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-backend.ts | 70, 305, 309, 315, 893, 934 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-embedded-postgres-root.ts | 235, 305, 349, 475, 947, 952, 953 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-embedded-postgres.ts | 306, 435, 613, 1112, 1213, 1214, 1216, 1241, 1262, 1309, 1312, 1315, 1642, 1652 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-envelope.ts | 80, 194, 203, 496, 499, 500, 501, 502, 505, 507 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-launch-lock.ts | 5 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-lifecycle.ts | 50 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-local-postgres.ts | 136, 137, 274, 283 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-metadata.ts | 69, 179 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-process-owner.ts | 19 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-registration-diagnostics.ts | 92 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-row-guard.ts | 56 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-sdk-handle.ts | 409, 417, 428, 503, 505 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/dbos-tombstone.ts | 7, 20 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/factory.ts | 1, 99, 147 | Explicit storage/backend/factory source exclusion; removed in the storage-coupled slice. |
| durable/local-command.ts | 50, 64, 95 | Live process exit/close event scheduling, not record compatibility. |
| durable/stage-primitive.ts | 360, 363 | Current task result text projection from structured/current stage checkpoints, not an old result discriminator. |
| durable/types.ts | 88, 278, 308 | Explicitly excluded recovery fields and current stage model-failover metadata. |
| engine/primitives/parallel.ts | 5, 39, 78, 79 | Current authored parallel prompt defaults when a step has no task, not an old input format. |
| engine/primitives/task.ts | 92 | Current model-attempt metadata collection. |
| engine/run-tool-node-lifecycle.ts | 76, 139 | Current replay parent-set consistency check against tracked graph ancestry, not acceptance of absent topology. |
| extension/companions.ts | 23, 25 | Live companion capability detection by registered commands/tools, not old persisted records. |
| extension/dispatcher.ts | 95 | Current optional model catalog for execution failover. |
| extension/extension-factory.ts | 61, 62 | Current graph selection when no run is active. |
| extension/extension-runtime-state.ts | 284, 354, 359, 365 | Current surface precedence plus storage-coupled Docker diagnostics; old resource-loader method was removed. |
| extension/hil-answer-notifications.ts | 354 | Printable notification text for a narrow terminal, not a previous record reader. |
| extension/lifecycle-notifications.ts | 702, 712, 743 | Printable notification text for a narrow terminal; old single-warning reader removed. |
| extension/public-types.ts | 10, 262 | Current AI package import path and explicitly excluded recovery argument. |
| extension/render-result.ts | 139, 153, 280, 333, 578, 579 | Current transcript preview, unknown-action rendering and TypeScript exhaustiveness, not an old result shape. |
| extension/runtime.ts | 80 | Current optional model catalog for execution failover. |
| extension/ui-surface.ts | 81, 87, 132, 151 | Current host UI option/capability documentation; optional viewport controls do not parse old input or stored shapes. |
| extension/wiring.ts | 210, 289, 291, 563, 584, 586, 589 | Current SDK model failover contract, inherited model policy and model-attempt metadata. |
| extension/workflow-command-surfaces.ts | 14, 48 | Current run-result display when graph inspection is unavailable; not an old result reader. |
| extension/workflow-durable-resume-command.ts | 31, 64, 66, 77, 187 | Storage-coupled completed catalog hydration/direct backend access when no shared view exists; current session-picker capability fails closed. |
| extension/workflow-heartbeat-notice.ts | 77, 87, 101 | Printable heartbeat text for a narrow terminal. |
| extension/workflow-legacy-recovery.ts | 10, 23, 30, 35, 43, 52, 55, 60, 63 | Explicitly excluded recovery module. |
| extension/workflow-prompts.ts | 26, 46, 52, 55, 61 | General task migration vocabulary, current verification/tool-unavailability guidance and current model failover authoring instructions; no old workflow reader. |
| extension/workflow-run-control-command.ts | 267 | Comment documents rejection when the current session-picker capability is absent. |
| extension/workflow-session-run-control.ts | 270 | Explicitly excluded recovery argument forwarding. |
| extension/workflow-stage-results.ts | 112, 157, 163 | Current bounded inline transcript preview when no transcript path exists. |
| extension/workflow-tool-content.ts | 167 | Current transcript preview diagnostic rendering. |
| extension/workflow-tool-control.ts | 670 | Storage-coupled best-effort durable preparation before authoritative run control. |
| extension/workflow-tool.ts | 1, 20, 299, 300 | Current AI package import path and explicitly excluded recovery flow. |
| intercom/result-intercom.ts | 83, 84 | Current caller-supplied unknown-event rendering hook, not an old event parser. |
| runs/background/startup-admission.ts | 61, 71 | Current admission diagnostic default text. |
| runs/foreground/executor-abort.ts | 108 | Diagnostic display for a live abort error. |
| runs/foreground/executor-exit-manager.ts | 27, 59, 63 | Current stage-exit reason default during live cancellation. |
| runs/foreground/executor-hil.ts | 37 | Current default response on prompt cancellation, not an old adapter reader. |
| runs/foreground/executor-lifecycle.ts | 72, 83, 147, 150, 153, 154, 155, 156, 157, 158, 161, 166, 168, 256, 263, 272 | Current failure classification/default result composition from live stage data. |
| runs/foreground/executor-prompt-nodes.ts | 17, 63, 75, 325, 336 | Current prompt cancellation/default values and stage-exit reason handling. |
| runs/foreground/executor-stage-call.ts | 135, 188, 202, 212, 325 | Current model-attempt accounting and explicit chain selection. |
| runs/foreground/executor-stage-context.ts | 56, 151 | Current model-attempt metadata forwarding. |
| runs/foreground/executor-stage-factory.ts | 174, 226, 227, 382, 467 | Current model-attempt metadata projection. |
| runs/foreground/executor-stage-replay.ts | 147 | Current replayed model-attempt metadata projection. |
| runs/foreground/executor-stage-types.ts | 65, 75 | Current model-attempt metadata interface. |
| runs/foreground/executor-task-prompts.ts | 139 | Current task text defaults for parallel steps. |
| runs/foreground/executor-types.ts | 110, 163 | Current execution model catalog and session-event interface. |
| runs/foreground/pending-stage-delivery.ts | 33, 62, 64 | Current model failover eligibility for delivery errors, not old delivery records. |
| runs/foreground/stage-runner-candidate.ts | 2 | Current resolved model-candidate type import. |
| runs/foreground/stage-runner-context.ts | 154, 187, 206, 250, 256, 395, 396 | Current model failover execution and last assistant text selection. |
| runs/foreground/stage-runner-controller.ts | 33, 70, 82, 265, 277, 315, 316, 387, 392, 393, 394, 397, 398, 402, 404, 405, 407, 415, 416, 473, 484, 639, 655, 750, 779, 1137, 1138, 1139, 1225, 1226, 1227, 1267, 1313, 1315, 1334, 1577, 1583, 1605, 1688, 1698, 1699, 1700, 1702, 1703, 1705, 1707, 1746, 1822, 1835, 1838, 1851, 1854, 1867, 1868, 1869, 1872, 1878, 1879, 1880, 1883, 1885, 1886, 1904, 1926, 1927, 1928, 1932, 1933, 1958, 1960, 1968, 1971, 1972, 1984, 1986 | Current retry, candidate failover, session replacement and attempt accounting; deprecated authored reasoning fields removed. |
| runs/foreground/stage-runner-messages.ts | 2, 61, 80, 81, 180, 226, 229, 234 | Current assistant/error text extraction across model failover and session replacement. |
| runs/foreground/stage-runner-options.ts | 51, 88 | Current explicit model failover list forwarded to SDK. |
| runs/foreground/stage-runner-output.ts | 102, 117 | Current transcript rendering when no assistant transcript text exists. |
| runs/foreground/stage-runner-replacement.ts | 5 | Current session ownership during model replacement. |
| runs/foreground/stage-runner-session-options.ts | 3, 8, 39, 40 | Current candidate/session option construction. |
| runs/foreground/stage-runner-session.ts | 19 | Current session ownership during model replacement. |
| runs/foreground/stage-runner-structured-output.ts | 30, 93, 126 | Current schema inference and retry/failover contract. |
| runs/foreground/stage-runner-types.ts | 100, 114, 149, 156, 157, 160, 213, 214 | Current model failover/session event metadata types. |
| runs/foreground/stage-runner-unresolved-overflow.ts | 24 | Current exhausted candidate handling after resumed context overflow. |
| runs/foreground/stage-runner.ts | 17 | Current model-attempt metadata type export. |
| runs/shared/model-fallback-candidates.ts | 137, 138, 181, 188, 215, 220, 224, 230, 238, 248, 262, 267, 293 | Current explicit model candidate chain and catalog availability handling. |
| runs/shared/model-fallback-failures.ts | 2, 5, 9, 10, 11 | Current re-export of the shared classifier used by workflows; no deprecated function aliases or old error-shape readers here. |
| runs/shared/model-fallback.ts | 1, 2 | Current public module grouping candidate resolution and shared classifier exports. |
| runs/shared/retry.ts | 2 | Current shared retry policy exports and workflow sleep cancellation, not a removed API alias. |
| runs/shared/validate-inputs.ts | 17 | Historical comment describes a removed descriptor; current validation only accepts schema inputs. |
| shared/authoring-contract-stage.ts | 68, 70, 170, 174, 202 | Current model failover authoring interface. |
| shared/authoring-contract-ui.ts | 344, 404 | Current model-attempt metadata and session replacement event contract. |
| shared/expanded-workflow-graph.ts | 30 | Stage-compatible means render projection type, not old-record acceptance. |
| shared/graph-store-snapshot.ts | 67 | Bounded current display field projection when serialized exited outputs exceed the size bound; original run outputs remain exact. |
| shared/possible-stages.ts | 1056, 1081, 1086, 1088, 1362 | Current static name inference for builtin exports and source-analysis vocabulary; obsolete module roots removed. |
| shared/schema-introspection.ts | 3, 28, 49, 85, 92 | Current schema-to-form field-kind/requiredness projection consumed by input UI; no old descriptor input is accepted. |
| shared/serializable.ts | 55 | Current schema error-path display notation, not parsing an old value shape. |
| shared/sticky-stage-delivery-status.ts | 95 | Storage-coupled receipt admission provenance; current live transport receipts are intentionally not context-admission proof. |
| shared/store-run-methods.ts | 65 | Current active-run selection when a child is the only live run. |
| shared/store-types.ts | 354, 425, 438, 440, 447 | Current render projections and model-attempt metadata. |
| shared/timing.ts | 10 | Comment documents that old timing gaps are not filled. |
| shared/types.ts | 38, 48, 188, 242, 248, 249, 252, 436 | Current model failover types/default task prompts; omitted SDK reasoning keys prevent exposing removed authored options. |
| shared/workflow-activity.ts | 56 | Current ancestry resolution for live/folded child ownership, not old record migration. |
| shared/workflow-failures-classifier.ts | 16, 19, 78, 80, 81, 100, 205, 289, 290, 291 | Current third-party failure classification, including text-only errors providers still raise. |
| shared/workflow-failures-decisions.ts | 99, 428, 432, 437, 467, 473 | Current third-party provider error classification, not old workflow errors. |
| shared/workflow-run-ownership.ts | 16 | Current optional root identity for roots/unattributed snapshots and consistency validation, not an old-format reader. |
| tui/chat-surface-message.ts | 51, 154 | Current plain notification text rendering and historical layout commentary. |
| tui/chat-surface.ts | 50 | Current viewport measurement default. |
| tui/dispatch-confirm.ts | 10, 17, 194, 214, 217, 258, 259 | Current bounded input-value rendering and historical layout commentary; no old UI input is read. |
| tui/graph-theme.ts | 9 | Current light/no-color palette selection. |
| tui/graph-view-input.ts | 109, 143 | Current keybindings precedence and current j/k navigation, not old input grammar. |
| tui/inline-form-editor-text.ts | 99, 107 | Current terminal bracketed-paste capability and live typing burst handling. |
| tui/inline-form-overlay.ts | 143 | Current capability detection reports unsupported, not an old host adapter. |
| tui/keybindings-adapter.ts | 5, 70 | Current injected key manager and explicit no parallel raw-byte default contract. |
| tui/node-card.ts | 163 | Current compact/full child-output display projection; both are produced by current writers. |
| tui/overlay-adapter.ts | 334 | Current overlay local focus state when host inline dialog state is absent. |
| tui/pending-input-affordance.ts | 277, 279, 295 | Current same-question descriptor equivalence and uniqueness validation. |
| tui/prompt-card-text.ts | 71, 73 | Current editor key defaults for standalone prompt cards and injected key manager matching, not an old record reader. |
| tui/session-picker.ts | 102 | Current broader status listing terminology, not a retained old listing algorithm. |
| tui/stage-chat-layout.ts | 31, 33, 75 | Current viewport defaults and small-terminal layout. |
| tui/stage-chat-view-delivery-activity.ts | 12 | Current model replacement/compaction delivery ownership. |
| tui/stage-chat-view-transcript.ts | 18 | Current plain notification transcript text. |
| tui/stage-chat-view-types.ts | 16 | Current unhosted viewport size default. |
| tui/stage-chat-view.ts | 4 | Current re-export facade after file decomposition; no deprecated names or old path decoding. |
| tui/text-helpers.ts | 37 | Current workflow width/truncation helper delegates to host library, not a deprecated API alias. |
| tui/tool-detail.ts | 20 | Current collapsed host message preview sizing. |
| tui/widget-scroll-hint.ts | 4, 7, 20 | Current control-key collision detection: distinct configured keys can share terminal bytes; it is not an old configuration reader. |
| tui/widget.ts | 339, 340 | Current badge color default. |
| tui/workflow-attach-pane-types.ts | 25 | Current read-only completed inspection when no live executor exists. |
| tui/workflow-attach-pane.ts | 346 | Current transcript behavior when no attachable child stage exists. |
| tui/workflow-notice-card.ts | 22, 32 | Current narrow-terminal plain notification text. |
| tui/workflow-resume-selector.ts | 21, 152, 225 | Current resume capability rejection and current running-row selection, not an old picker reader. |
