# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Fixed schema-backed workflow stages to send up to three corrective follow-up prompts when a turn finishes without the required `structured_output` call or with an invalid `structured_output` call, echoing the concrete contract/validation error before failing the stage.
- Fixed failed workflow stages to retain and persist SDK `sessionId`/`sessionFile` metadata, so post-error transcript inspection and follow-up messaging resume from the failed conversation instead of silently creating a fresh empty session.
- Fixed schema-backed workflow stages with `noTools: "all"` to keep the restrictive allowlist while still exposing the required `structured_output` final-answer tool.

## [0.8.29] - 2026-06-15

### Added

- Added opt-in schema-backed workflow item results: `ctx.stage(..., { schema })`, `ctx.task(..., { schema })`, `ctx.chain` items, and `ctx.parallel` items now receive a schema-specific `structured_output` tool only for that item, return the captured value from `ctx.stage().prompt(...)`, and expose parsed task values as `result.structured` while preserving formatted JSON handoff text ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).

### Changed

- Changed the builtin `ralph` workflow to start each iteration with `/skill:prompt-engineer` prompt-engineering and `/skill:research-codebase` research instead of an RFC/planner stage, pass the resulting research artifact to the orchestrator as primary implementation context, fork follow-up research from prior research session data, and feed unresolved reviewer findings into subsequent research passes ([#1371](https://github.com/bastani-inc/atomic/issues/1371)).
- Changed builtin `goal`, `ralph`, and `open-claude-design` decision gates to use schema-backed workflow `structured_output` stages with TypeBox-native schema builders instead of registering bespoke terminating custom tools or wrapping plain JSON schemas with `Type.Unsafe`.
- Changed the builtin `ralph` prompt-engineering stage to disable all tools while relying on the `/skill:prompt-engineer` skill prompt, keeping that first-pass rewrite focused and tool-free.
- Changed builtin `goal` worker/reviewer prompts and `ralph` orchestrator/reviewer prompts to request end-to-end verification when practical, using browser-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios.
- Aligned the workflows extension with upstream pi TUI `^0.79.3` so workflow graph, custom UI, and prompt-broker integrations inherit the latest shared TUI compatibility fixes.
- Documented the opt-in `structured_output` workflow path and clarified that ordinary workflow stages do not receive `structured_output` from the default tool registry; schema-enabled items auto-add the runtime tool to explicit `tools` allowlists without adding extra workflow prompt text about the tool ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Removed top-level-object restrictions from workflow `structured_output` gate schemas; Atomic now passes any plain JSON Schema object directly to the tool and documents the one-`prompt()` limit for schema-backed `StageContext` result contracts ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).

### Fixed

- Fixed direct workflow tool validation so schema-enabled `task`, `tasks`, `chain`, and `parallel` items accept plain JSON Schema objects without additional object-root constraints ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed schema-backed workflow stages to fail with a clear stage-level error when `prompt()` is called more than once on the same `StageContext`, rather than surfacing the lower-level structured-output single-use guard ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed schema-backed workflow model fallback so an attempt that already captured a valid terminating `structured_output` result is treated as successful instead of retrying against fallback models and tripping the single-use result guard ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed the workflow graph overlay remaining interactive when the parent/main-chat agent opens `ask_user_question`: the graph keeps focus, the parent question stays pending behind it with a clear “Main chat needs input — exit graph to answer.” status hint, hiding/exiting the graph focuses the pending question, and host custom-UI state changes no longer hide, restore, remount, or repaint the overlay ([#1353](https://github.com/bastani-inc/atomic/issues/1353)).
- Fixed builtin `ralph` skill-prompt stages to invoke bundled skills through `/skill:<name>` expansion so prompt engineering and research stages receive the intended skill instructions.
- Fixed concurrent workflow stage resource reloads to serialize temporary subagent child environment isolation so parallel stage startup cannot leave parent process child flags accidentally cleared.
- Fixed workflow stage sessions to keep bundled workflow package skills (`create-spec`, `impeccable`, `prompt-engineer`, `research-codebase`, and `skill-creator`) available while still disabling only the recursive workflows extension inside child sessions.
- Fixed workflow stage resource discovery so bundled subagent definitions stay available, `subagent` is active by default with the same two-hop nesting budget as main chat, and explicitly allowlisted bundled extension tools such as `subagent`, `web_search`, `fetch_content`, and `intercom` remain visible even when a workflow is launched from a subagent child process.

## [0.8.28] - 2026-06-11

### Added

- Added workflow `ctx.ui.custom<T>(factory, options?)` for graph-visible custom TUI human-in-the-loop prompts. Custom prompts create `awaiting_input` prompt nodes, reuse the stage UI broker/attached stage chat component path, expose the same real TUI/theme/keybinding/component types as Atomic extension custom UI, participate in live-memory prompt replay through hashed custom identities, honor prompt/run abort signals, and reject clearly in headless/unavailable UI modes ([#1309](https://github.com/bastani-inc/atomic/issues/1309)).
- Added workflow authoring `ctx.exit(options?)` for intentional early terminal runs from any call depth, supporting `completed`, `skipped`, `cancelled`, and `blocked` terminal statuses, optional persisted/displayed reasons, and partial declared outputs with strict validation for provided output keys. Public run/detail/child status unions widen with `skipped`, `cancelled`, and `blocked`, and child workflow results are discriminated by `exited`.
- Added workflow stage/task `bashPolicy` wiring so individual workflow stages can constrain the built-in `bash` tool with command-level allow/deny rules, command-string glob matching, fail-closed invalid-policy validation, and default-allow no-rule compatibility.

### Changed

- Changed the builtin `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows to use `anthropic/claude-fable-5:xhigh` as the primary planner/reviewer/design model, demoting each previous primary to the head of the fallback chain ([#1345](https://github.com/bastani-inc/atomic/pull/1345)).
- Changed workflow transcript introspection to return `sessionFile`/`transcriptPath` metadata with a lazy-read prompt by default when a transcript path exists, keeping bounded inline previews behind explicit `tail`/`limit` requests ([#1314](https://github.com/bastani-inc/atomic/issues/1314)).

### Fixed

- Fixed a workflow kill/abort race that could crash the entire CLI with a process-level uncaught exception when a workflow was killed mid-prompt; `raceAbort` now always observes the in-flight promise in the already-aborted branch so a killed run can no longer orphan a rejecting prompt.
- Fixed `ctx.exit(...)` cleanup races across the executor: the selected exit is a level-triggered gate so delayed `ctx.stage`/`ctx.task`/`ctx.chain`/`ctx.parallel`/`ctx.workflow`/graph-backed `ctx.ui.*` calls and retained `StageContext` session-control methods no longer create artifacts after exit, queued `ctx.parallel` work stops after exit, parent exits cancel linked hidden child workflows with typed parent-exit abort reasons and exactly-once stage-end ordering, and prompt-node abort handling preserves `workflow-exit` skipped reasons.
- Fixed terminal run-end reconciliation after `ctx.exit(...)` so when an external kill or another terminal writer wins `Store.recordRunEnd(...)`, the returned `RunResult` and `onRunEnd` callback report the canonical store status and only the winning run-end write is persisted.
- Fixed workflow-boundary child-edge metadata cleanup for `ctx.exit(...)` and continuation replay: skipped/failed boundaries clear `workflowChild`/`workflowChildRun`, stage-end persistence only emits child replay metadata for completed boundary stages, and expanded graph views no longer flatten stale child stages.
- Fixed `ctx.exit({ outputs })` payload capture to snapshot outputs by value at the first selected exit call, and deep-froze the thrown exit signal so author code cannot rewrite the terminal status, reason, or outputs after the fact.
- Fixed continuation replay races where replayed stage `prompt`/`complete` or prompt-node finalizers could complete after a concurrent `ctx.exit(...)`; pending replay finalizers now re-check the exit gate so resumed runs skip those stages instead of writing misleading completed stage-end entries.
- Fixed control-signal probing for arbitrary workflow-thrown values and abort reasons to use non-throwing reads, so throwing or inaccessible author accessors no longer leak from the executor catch path.
- Fixed interactive `ctx.ui.*` handling so workflow runs degrade gracefully: every primitive is guarded against method-less UI adapters with a clear per-method error, and headless (non-interactive) runs without a UI adapter reject with an explicit actionable message ([#1339](https://github.com/bastani-inc/atomic/issues/1339)).
- Fixed the builtin `open-claude-design` workflow not installing the browser skill's `browse` CLI before it is needed: a deterministic best-effort setup step probes `PATH` and installs the CLI when missing, per-run bootstrap guidance is injected into every browser-using stage, the install outcome is exposed via a new `browse_cli_status` output, and read-only `read`/`grep`/`ls` tools are granted to the refinement and pre-export decision gates ([#1327](https://github.com/bastani-inc/atomic/issues/1327)).
- Fixed paused workflow runs being counted as running in `/workflow status` (now shown separately as `❚❚ paused`) and run detail cards to surface the natural `workflow resume` action hint ([#1283](https://github.com/bastani-inc/atomic/issues/1283)).

## [0.8.28-alpha.4] - 2026-06-11

### Changed

- Changed the builtin `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows to use `anthropic/claude-fable-5:xhigh` as the primary planner/reviewer/design model, demoting each previous primary (`openai-codex/gpt-5.5:xhigh` or `github-copilot/claude-opus-4.8:xhigh`) to the head of the fallback chain ([#1345](https://github.com/bastani-inc/atomic/pull/1345)).

## [0.8.28-alpha.3] - 2026-06-11

### Added

- Added workflow stage/task `bashPolicy` wiring so individual workflow stages can constrain the built-in `bash` tool with command-level allow/deny rules, command-string glob matching, escaped glob bracket-class literal preservation, reserved/compound-head rejection, leading-redirection and attached command-head redirection rejection, non-leading `>|` noclobber redirection handling, assignment-head rejection, invalid glob range handling through `invalid-policy`, unknown top-level policy key rejection, runtime invalid-policy validation, and default-allow no-rule compatibility.
- Added workflow authoring `ctx.exit(options?)` for intentional early terminal runs from any call depth. `ctx.exit` supports `completed`, `skipped`, `cancelled`, and `blocked` terminal statuses, optional persisted/displayed reasons (including in the default status list), and partial declared outputs while preserving strict validation for provided output keys. This widens public run/detail/child status unions with `skipped`, `cancelled`, and `blocked`; downstream exhaustive switches should add cases for those statuses, while `failed` remains for thrown errors and `killed` remains external run-control. Child workflow results are now discriminated by `exited`: `exited: false` has full declared outputs, while `exited: true` has partial outputs plus the child exit status/reason.

### Fixed

- Fixed `ctx.exit(...)` cleanup races so the selected exit is a level-triggered gate: delayed `ctx.stage`/`ctx.task`/`ctx.chain`/`ctx.parallel`/`ctx.workflow`/graph-backed `ctx.ui.*` calls and retained `StageContext` session-control methods no longer create graph, control, or `AgentSession` artifacts after exit; queued `ctx.parallel` work stops after exit even with `failFast: false`; parent exits cancel already-linked hidden child workflows with a typed parent-exit abort reason while the child executor owns skipped child stage/prompt cleanup, live handle/session disposal, and non-resumable `cancelled` child run finalization; parent finalization waits for that child cleanup so child `workflow.stage.end` entries are written exactly once before child and parent `workflow.run.end`; and prompt-node abort handling preserves `workflow-exit` skipped reasons instead of overwriting them with `run-aborted`.
- Fixed terminal run-end reconciliation after `ctx.exit(...)` cleanup races. If an external kill or another terminal writer wins `Store.recordRunEnd(...)` while exit cleanup or exit-output validation is pending, the returned `RunResult` and `onRunEnd` callback now report the canonical store status/result/error/reason (for example `killed`) and only the winning run-end write is persisted.
- Fixed workflow-boundary child-edge metadata cleanup for `ctx.exit(...)` and continuation replay. Boundaries that finalize as `skipped` or `failed` now clear `workflowChild`/`workflowChildRun`, stage-end persistence only emits child replay metadata for completed boundary stages, restore ignores stale child metadata on skipped/failed stage-end entries, and expanded graph views no longer flatten stale child stages from non-completed boundaries.
- Fixed `ctx.exit({ outputs })` payload capture to snapshot outputs by value at the first selected exit call. Later `finally` mutations can no longer remove undeclared keys or change valid/invalid values before post-cleanup validation, and option/output getter or enumeration failures now run workflow-exit cleanup before finalizing as non-resumable authoring failures when that terminal write wins.
- Fixed `ctx.exit(...)` exposing mutable finalization state to author code. The thrown exit signal and its captured output snapshot are now deep-frozen, so a workflow that catches the exit signal in a broad `try`/`catch` and mutates it before rethrowing can no longer rewrite the terminal status, reason, or outputs (finalization recovers the same frozen object via the run abort reason or the rethrow).
- Fixed continuation replay races where replayed stage `prompt`/`complete` or prompt-node finalizers could complete after a concurrent `ctx.exit(...)`. Pending replay finalizers now register with workflow-exit cleanup and re-check the exit gate after their replay microtask, so resumed runs skip/suppress those stages instead of writing misleading completed stage-end entries.
- Fixed control-signal probing for arbitrary workflow-thrown values and abort reasons. `ctx.exit(...)`/parent-exit detection now uses non-throwing reads for private markers, `scope`, aggregate `errors`, `cause`, and `reason`; throwing or inaccessible author accessors are ignored for that probe branch so runs finalize as ordinary failures or kills instead of leaking accessor errors from the executor catch path.
- Fixed interactive `ctx.ui.*` handling so workflow runs degrade gracefully instead of crashing or emitting a confusing error. Partial/method-less UI adapters could previously surface a raw `TypeError: <method> is not a function` for `input`/`confirm`/`select`/`editor` (only `custom` was already guarded); every primitive is now guarded and rejects with a clear, actionable per-method error. Separately, headless/background (non-interactive) runs without a UI adapter now reject with an explicit "interactive ctx.ui.<primitive> is unavailable in headless (non-interactive) mode…" error that points to running interactively or removing the prompt, replacing the generic "Atomic runtime did not provide a UI adapter" wording for that path. Earlier completed stages remain completed, and interactive background runs keep brokering `ctx.ui.custom` through awaiting-input prompt nodes ([#1339](https://github.com/bastani-inc/atomic/issues/1339)).

## [0.8.28-alpha.2] - 2026-06-10

### Fixed

- Fixed the builtin `open-claude-design` workflow not installing the browser skill's `browse` CLI before it is needed. The workflow now runs an initial deterministic, best-effort setup step that probes `PATH` (`which`/`where browse`) and installs the CLI with `npm install -g browse` when missing (skipped under automated tests); per-run bootstrap guidance is derived from the outcome and injected into every browser-using stage (assume-available when ensured, with concrete recovery steps surfaced when the install failed), the install outcome is exposed via a new `browse_cli_status` output, and the read-only `read`/`grep`/`ls` tools are granted to the refinement and pre-export decision gates so they can inspect `preview.html` without mutating it. The step never throws or blocks the run, so stages keep their graceful-degradation fallback ([#1327](https://github.com/bastani-inc/atomic/issues/1327)).
- Fixed paused workflow run detail cards to surface the natural `workflow resume` action hint while preserving the interrupt hint for non-paused active runs ([#1283](https://github.com/bastani-inc/atomic/issues/1283)).
- Fixed paused workflow runs being counted as running and displayed as pending/running in `/workflow status` and `/workflow status <id>`, with paused runs now shown separately as `❚❚ paused` ([#1283](https://github.com/bastani-inc/atomic/issues/1283)).

## [0.8.28-alpha.1] - 2026-06-09

### Added

- Added workflow `ctx.ui.custom<T>(factory, options?)` for graph-visible custom TUI human-in-the-loop prompts. Custom prompts create `awaiting_input` prompt nodes, reuse the stage UI broker/attached stage chat component path, expose the same real TUI/theme/keybinding/component types as Atomic extension custom UI, participate in live-memory prompt replay through hashed custom identities, keep labels display-only/outside replay identity, honor prompt/run abort signals, and reject clearly in headless/unavailable UI modes. Iteration 1 supports inline graph rendering; `overlay: true` and non-TUI `workflow send` answers for arbitrary custom widget results return clear unsupported errors rather than silently degrading ([#1309](https://github.com/bastani-inc/atomic/issues/1309)).

### Changed

- Changed workflow transcript introspection to return `sessionFile`/`transcriptPath` metadata with a lazy-read prompt by default when a transcript path exists, while keeping bounded inline previews behind explicit `tail`/`limit` requests and falling back to a small preview when no path is available ([#1314](https://github.com/bastani-inc/atomic/issues/1314)).

### Fixed

- Fixed a workflow kill/abort race that could crash the entire CLI with a process-level uncaught exception (for example `No API key found for ...`). When a workflow was killed mid-prompt, the executor's `raceAbort` left the already-in-flight stage prompt promise unobserved; its later rejection escaped every workflow error boundary and became an unhandled rejection. `raceAbort` now always observes the in-flight promise in the already-aborted branch so a killed run can no longer orphan a rejecting prompt.

## [0.8.27] - 2026-06-08

### Changed

- Promoted the 0.8.27 prerelease package version to a stable release.

## [0.8.26] - 2026-06-08

### Changed

- Updated workflow-stage chat so `/compact` is the no-argument compaction command and `/context-compact` is no longer handled locally.
- Refined bundled workflow prompts to keep natural instructions inside meaningful XML sections while removing redundant wrapper noise.
- Upgraded builtin workflow fallback model tiers so degraded runs land on stronger models across `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` ([#1259](https://github.com/bastani-inc/atomic/issues/1259)).
- Changed the builtin `ralph` workflow to include the workflow current working directory in every stage prompt and to skip pull-request creation by default unless `create_pr=true`, omitting `pr_report` when disabled while keeping provider-aware PR/MR/review creation instructions in the final stage ([#1255](https://github.com/bastani-inc/atomic/issues/1255)).
- Updated the `research-codebase` skill to capture and carry a `breaking_changes_allowed` compatibility posture through research fanout and downstream research documents ([#1225](https://github.com/bastani-inc/atomic/issues/1225)).

### Fixed

- Fixed workflow custom-message renderers for inline forms and workflow run banners so persisted workflow messages no longer crash the host TUI with `child.render is not a function` on `/resume` ([#1236](https://github.com/bastani-inc/atomic/issues/1236)).
- Fixed the workflow input form so transient `/workflow <name>` argument selectors do not leak into model context and rehydrated stale input-form cards render nothing after `/resume`.
- Made stage sessions emit `session_shutdown` before `dispose()`, giving bound extensions graceful shutdown and preventing leaked child MCP servers or stale-context MCP initialization noise.
- Fixed stage-local workflow HIL `input` and `editor` prompts losing draft text across Ctrl+D detach/reattach; drafts are kept live-only in memory and cleared when the prompt or run/stage exits ([#1179](https://github.com/bastani-inc/atomic/issues/1179)).
- Fixed workflow worktree Git commands to strip ambient repository-local Git environment variables before inspecting or creating targeted worktrees.
- Suppressed intermediate model fallback failure warnings from successful workflow stages while preserving final failures and raw per-attempt diagnostics ([#1226](https://github.com/bastani-inc/atomic/issues/1226)).
- Fixed the workflow global tool-event hook ignoring unscoped parent-session prompts instead of attributing them to running stages, preventing false `awaiting_input` / "needs attention" states from unrelated `ask_user_question` calls ([#1261](https://github.com/bastani-inc/atomic/issues/1261)).
- Fixed the builtin `goal` and `ralph` workflows to fork looped worker/orchestrator-stage sessions from their matching prior iteration, preserving accumulated context while keeping reviewer stages independent ([#1275](https://github.com/bastani-inc/atomic/issues/1275)).
- Fixed workflow completion gates to rely on structured decision fields instead of manual text/regex heuristics in `goal` and `open-claude-design`.

## [0.8.26-alpha.11] - 2026-06-08

### Changed

- Published a synchronized Atomic 0.8.26-alpha.11 prerelease alongside the subagent codebase-agent tool restriction changes; no functional changes were made in the workflows extension.

## [0.8.26-alpha.10] - 2026-06-08

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.10 prerelease.

## [0.8.26-alpha.9] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.9 prerelease.

## [0.8.26-alpha.8] - 2026-06-07

### Changed

- Updated workflow-stage chat so `/compact` is the no-argument compaction command and `/context-compact` is no longer handled locally.

## [0.8.26-alpha.7] - 2026-06-07

### Changed

- Refined bundled workflow prompts to keep natural instructions inside meaningful XML sections while removing redundant wrapper noise.

### Fixed

- Fixed the builtin `goal` and `ralph` workflows to fork looped worker/orchestrator-stage sessions from their matching prior iteration, preserving accumulated context while keeping reviewer stages independent ([#1275](https://github.com/bastani-inc/atomic/issues/1275)).
- Fixed workflow completion gates to rely on structured decision fields instead of manual text/regex heuristics in `goal` and `open-claude-design`.

## [0.8.26-alpha.6] - 2026-06-06

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.6 prerelease.

## [0.8.26-alpha.5] - 2026-06-06

### Fixed

- Fixed the workflow global tool-event hook ignoring unscoped parent-session prompts instead of attributing them to running stages, preventing false `awaiting_input` / "needs attention" states from unrelated `ask_user_question` calls ([#1261](https://github.com/bastani-inc/atomic/issues/1261)).

## [0.8.26-alpha.4] - 2026-06-05

### Changed

- Upgraded builtin workflow fallback model tiers so degraded runs land on stronger models: bumped `github-copilot/claude-opus-4.8` fallbacks from `:medium` to `:xhigh` in `deep-research-codebase` and `ralph`, replaced `claude-sonnet-4-8`/`4.8` fallbacks with `claude-opus-4-8`/`4.8` in the `goal` and `ralph` runner configs, and raised `claude-sonnet-4-6`/`4.6` fallbacks from `:medium` to `:high` in `open-claude-design` ([#1259](https://github.com/bastani-inc/atomic/issues/1259)).

## [0.8.26-alpha.3] - 2026-06-05

### Changed

- Changed the builtin `ralph` workflow to include the workflow current working directory in every stage prompt so planner, implementation, simplification, review, and PR handoff stages keep repository work anchored to the workflow checkout.
- Changed the builtin `ralph` workflow to skip pull-request creation by default unless `create_pr=true`, omit `pr_report` when disabled, and keep provider-aware PR/MR/review creation instructions in the final stage ([#1255](https://github.com/bastani-inc/atomic/issues/1255)).

## [0.8.26-alpha.2] - 2026-06-05

### Changed

- Updated the `research-codebase` skill to capture a `breaking_changes_allowed` compatibility posture before research fanout, carry it through sub-agent prompts, and record it in research documents so downstream specs and workflows do not preserve legacy APIs by default when breaking changes are allowed ([#1225](https://github.com/bastani-inc/atomic/issues/1225)).

### Fixed

- Fixed stage-local workflow HIL `input` and `editor` prompts losing draft text across Ctrl+D detach/reattach; drafts are kept live-only in memory and cleared when the prompt or run/stage exits ([#1179](https://github.com/bastani-inc/atomic/issues/1179)).
- Fixed workflow worktree Git commands to strip ambient repository-local Git environment variables before inspecting or creating targeted worktrees.
- Suppressed intermediate model fallback failure warnings from successful workflow stages while preserving final failures and raw per-attempt diagnostics ([#1226](https://github.com/bastani-inc/atomic/issues/1226)).

## [0.8.26-alpha.1] - 2026-06-05

### Fixed

- Fixed the inline-form "snapshot lost" renderer and the `workflow.run.start`/`workflow.run.end` banner renderers returning bare strings, which crashed the host TUI with `child.render is not a function` when resuming a session containing persisted workflow custom messages. These renderers now return proper render components ([#1236](https://github.com/bastani-inc/atomic/issues/1236)).
- Fixed the workflow input form (the `/workflow <name>` argument selector) leaking into model context: spawning the picker and exiting without running the workflow no longer sends the form to the LLM. The input-form card is now emitted with `excludeFromContext` since it is transient UI, not conversation.
- Fixed the workflow input widget re-rendering in chat after `/resume`. Inline-form state is now cleared on `session_start`, and a rehydrated `workflows:input-form` card whose backing state is gone now renders nothing (returns `null`) instead of a stale form or "snapshot lost" placeholder.
- Stage sessions now emit `session_shutdown` before `dispose()` (mirroring the host `AgentSessionRuntime` teardown) so bound extensions receive a graceful shutdown signal instead of being silently invalidated. This stops disposed stage sessions from leaking child MCP servers and from triggering spurious stale-context "MCP initialization failed" errors when an extension's deferred `session_start` work races with stage disposal.

## [0.8.25] - 2026-06-04

### Changed

- Promoted the 0.8.25 prerelease package version to a stable release.

## [0.8.25-alpha.1] - 2026-06-04

### Fixed

- Fixed the interactive workflow inputs selector so it hides the working loader while replacing the editor, keeping the picker pinned to the bottom like `ask_user_question` without wedged host chrome ([#1224](https://github.com/bastani-inc/atomic/issues/1224)).

## [0.8.24] - 2026-06-04

### Changed

- Promoted the 0.8.24 prerelease package version to a stable release.

## [0.8.24-alpha.4] - 2026-06-04

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.4 prerelease.

## [0.8.24-alpha.3] - 2026-06-03

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.3 prerelease.

## [0.8.24-alpha.2] - 2026-06-03

### Added

- The `@bastani/workflows` authoring SDK types are now externally resolvable in installed packages through `@bastani/atomic`'s new `./workflows` exports and ambient bridge, so workflow files type-check `import { defineWorkflow, Type } from "@bastani/workflows"` (and `@bastani/workflows/builtin/*`) under `tsc` (NodeNext) without a hand-authored `.d.ts`, `declare module` shim, or `paths` alias. Workflow packages declare `@bastani/atomic` and `typebox` as peer dependencies; the package continues to distribute raw TypeScript with no build step, and the runtime virtual-module loader is unchanged ([#1208](https://github.com/bastani-inc/atomic/issues/1208)).

### Fixed

- Fixed builtin (and any) workflows falling back to the user's currently selected model instead of the stage's defined model. A fully-qualified `provider/model` id that the live model catalog did not list was treated as a hard "not available" failure; because candidate validation throws on any failure and the catalog resolver catches that throw and collapses the whole ordered candidate list down to the user's `currentModel`, a single absent cross-provider fallback discarded the defined primary plus every fallback. Provider-qualified ids are now trusted (passed through with the reasoning suffix split off the last colon), mirroring the subagent resolver, so the defined primary is used and only genuinely failing candidates fall through at runtime. Regressed when bundled workflow model lists were refreshed onto newer multi-provider ids alongside suffix-first reasoning levels ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

## [0.8.24-alpha.1] - 2026-06-02

### Breaking Changes

- Removed the imperative `runWorkflow` object-form API from `@bastani/workflows`; workflow authors must export definitions produced by `defineWorkflow(...).compile()`, and forged `__piWorkflow: true` objects are rejected by discovery and composition.

### Added

- Added suffix-first workflow reasoning levels for `model` and `fallbackModels` entries such as `openai/gpt-5:high`, plus `WorkflowModelAttempt.reasoningLevel` metadata and optional `fallbackThinkingLevels` compatibility mapping ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

### Changed

- Changed bundled workflows to encode their existing reasoning levels directly on model and fallback model strings ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Documented the `model_name:thinking_effort` suffix syntax and `thinkingLevel` migration guidance in the workflows docs and package README ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Adopted the new `-alpha.N` prerelease version convention (revision starting at 1), replacing the legacy numeric `-N` prerelease suffix in the release tooling (bump script, CI publish validation, and changelog parsing).
- Dropped the leading `v` from release git tags and `release/`/`prerelease/` branch names; the Publish CI now triggers on and validates bare version tags such as `0.8.24` or `0.8.24-alpha.1`.

### Deprecated

- Deprecated workflow `thinkingLevel` stage options in favor of per-candidate `:off|minimal|low|medium|high|xhigh` model suffixes; removal is deferred ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

### Fixed

- Made workflow reasoning-suffix parsing lenient so it no longer rejects legitimate colon-tagged model ids (for example OpenRouter `:free`/`:exacto` variants and Ollama `llama3:latest`); only canonical `:off|minimal|low|medium|high|xhigh` suffixes are stripped as reasoning levels, and unknown ids still surface the generic catalog "not available" error ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

## [0.8.23] - 2026-06-02

### Changed

- Promoted the 0.8.23 prerelease package version to a stable release.

## [0.8.23-0] - 2026-06-02

### Added

- Added a workflow node chat Ctrl+D hint that shares the bottom footer line with model/cwd metadata and appears in the bottom-right corner of stage-local ctx.ui widgets.

### Changed

- Changed bundled Goal and Ralph workflows to save reviewer feedback as JSON artifacts and hand only latest review artifact paths to downstream agents instead of injecting full review histories or session tails.
- Removed Ralph's separate `infra-locate-*`, `infra-analyze-*`, and `infra-patterns-*` discovery stages; Ralph reviewers now inspect repository infrastructure directly as needed during review.
- Documented artifact-path handoffs, `outputMode: "file-only"`, `reads`, and explicit `Read the file at <path>...` downstream prompts as the preferred pattern for large workflow context.
- Updated the workflow tool description to tell agents to hand off large stage context through files/artifacts instead of injected previous text.

### Fixed

- Fixed paused workflow stage chats so Ctrl+D returns to the orchestrator graph instead of closing back to the main chat.

## [0.8.22] - 2026-06-01

### Breaking Changes

- Migrated workflow contracts to TypeBox schemas and fully explicit outputs, removing legacy descriptor schemas, `.import(...)`, string-alias child workflow calls, parent-side output remapping, implicit `result`/`rawOutput`, and declaration-time `.humanInTheLoop(...)` metadata.

### Added

- Added TypeBox re-exports, TypeScript module-style child workflow composition, schema-validated child outputs, reusable builtin workflow modules, and flattened nested child workflow stages.

### Changed

- Raised the bundled deep-research workflow's default parallelism, renamed workflow runtime errors to `atomic-workflows:`, rendered workflow notices as compact TUI cards, flattened imported workflow graph boundaries, and expanded registered workflow-tool metadata.

### Fixed

- Fixed defaulted input validation, slow workflow discovery through the jiti loader, headless workflow shutdown and print-mode automation, builtin workflow initialization cycles, package-manifest workflow reloads, nested workflow widgets/graph cards, portable deep-research line counting, Codex fast-mode workflow markers, human-in-the-loop focus/answer behavior, background widget rendering, and deterministic headless command output.

## [0.8.22-0] - 2026-06-01

### Breaking Changes

- Migrated workflow input/output declarations to a TypeBox-native schema system, replacing the legacy `{ type, required, default, choices }` descriptor. Authors now declare inputs/outputs with TypeBox schemas (`.input("prompt", Type.String({ description }))`, `.input("count", Type.Number({ default: 2 }))`, `.input("flavor", Type.Union([Type.Literal("a"), Type.Literal("b")]))`, `.output("packet", Type.Object({ topic: Type.String(), score: Type.Number() }))`). `ctx.inputs`, the `.run()` return, and `ctx.workflow(child).outputs` are precisely typed via `Static<>`, and the runtime validates inputs and outputs with TypeBox `Value`. `Type` is re-exported from `@bastani/workflows` (with types `Static` and `TSchema`) so workflow authors single-import. An optional field is declared with `Type.Optional(...)`; a `default` keeps the key required at the type level. This is a clean break with no legacy descriptor support.
- Removed the unshipped `.import(...)` workflow builder API and string-alias child workflow calls. Workflows now compose children by importing compiled workflow definitions with TypeScript imports and passing those definitions directly to `ctx.workflow(workflowDefinition, options)`.
- Removed parent-side child output selection/renaming from `ctx.workflow(...)`. Parent workflows now receive the child's declared `.output(...)` contract as `child.outputs`.
- Made workflow outputs fully explicit so a workflow's input/output contract is the stable, self-documenting surface other workflows compose against. A workflow now exposes exactly the outputs it declares with `.output(...)`, and a `.run()` return that contains a key the workflow did not declare fails the run with `atomic-workflows: ... returned undeclared output "<key>"`. The implicit string `result` output and the `child.rawOutput` escape hatch were removed: declare `.output("result", schema)` and return `{ result }` if you want a `result` output, and declare every other field a parent should read.
- Changed default transcript inspection from inlining about 50 recent entries to a reference-first 5-entry preview with `sessionFile`/`transcriptPath`; pass explicit `tail` or `limit` to override the preview size.
- Removed the obsolete `.humanInTheLoop(...)` workflow builder API and its declaration-time interaction metadata; workflows should use runtime `ctx.ui.*` calls directly when they need human input.

### Added

- Added TypeBox as the workflow schema engine and re-exported `Type` (plus the `Static` and `TSchema` types) from the `@bastani/workflows` public entry point so authors single-import the authoring surface.
- Added TypeScript module-style workflow composition: parent workflows can pass compiled child workflow definitions directly to `ctx.workflow(compiledWorkflow, options)`. The bundled `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows are reusable from `@bastani/workflows/builtin` or individual builtin module paths.
- Added first-class workflow composition: child workflows can declare `.output()` contracts, and `ctx.workflow()` runs compiled child workflow definitions as nested runs with input validation, schema-validated declared outputs, and the nested workflow's stages flattened inline into the parent graph ([#1071](https://github.com/bastani-inc/atomic/issues/1071)).

### Removed

- Removed the `zod` dependency from `@bastani/workflows`; JSON-serializable validation and input/output validation now run on TypeBox `Value`.

### Changed

- Raised the bundled `deep-research-codebase` default `max_concurrency` from 4 to 100 so partitioned research stages fan out in parallel by default; lower it via the `max_concurrency` input on rate-limited or cost-sensitive setups (with `max_partitions` up to 100 and one locator/pattern-finder/analyzer/online-researcher specialist per partition, a single run can otherwise spawn many concurrent stage sessions).
- Declared explicit output contracts for the bundled `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows so parent workflows receive schema-validated child outputs.
- Renamed workflow runtime error prefixes from `pi-workflows:` to `atomic-workflows:`.
- Render workflow stage notices, lifecycle notices, and HiL answer notices as compact emoji-free TUI cards instead of plain wrapped rows, matching the debugger warning card treatment.
- Flatten imported workflows in the expanded run graph so a `ctx.workflow()` import reads as a single flat layout: the child run's stages stand in for the import instead of rendering an extra boundary "information" node above them. The boundary's incoming dependencies become the child roots' dependencies and downstream stages rewire to the child's terminal stages, so a depth-1 composition of single-stage leaves now shows one node per import instead of two. A boundary whose child run produced no stages of its own is still kept as a single node so the import stays visible. Affects the graph overlay, session list, `status` stage counts/details, and attach resolution alike.
- Updated the registered `workflow` tool description so agent-facing metadata covers named and direct runs, discovery, inspection, prompt answering/steering, run control, and reload ([#1151](https://github.com/bastani-inc/atomic/issues/1151)).

### Fixed

- Fixed the programmatic named-workflow runner (`runWorkflow`) to resolve declared input defaults before validating, so an input declared with both `required: true` and a `default` is no longer rejected as missing when omitted, matching the resolve-then-validate order used by the other dispatch paths.
- Fixed slow workflow discovery outside the compiled binary by always resolving the `@bastani/workflows` SDK (and its builtin submodules) to in-memory virtual modules in the jiti loader instead of aliasing to the on-disk package. The alias path re-evaluated the entire SDK module graph once per workflow file (the loader keeps `moduleCache: false` so edits stay observable), so projects with many workflow files saw multi-second discovery and timing-sensitive workflow tests flaked at the default test timeout; workflow files are still evaluated fresh from disk, so `/workflow reload` keeps observing edits.
- Fixed headless workflow shutdown so completed stage chat handles are disposed on CLI quit, allowing successful non-interactive `/workflow` runs to return to the shell prompt ([#1167](https://github.com/bastani-inc/atomic/issues/1167)).
- Fixed bundled workflow modules so they import the leaf `defineWorkflow` authoring API instead of the public package entrypoint, avoiding an ESM initialization cycle during builtin workflow discovery.
- Fixed workflow HIL prompts so awaiting-input and answered-prompt notices no longer wake the main chat agent, answer notices stay out of LLM context and explicitly forbid auto-answering later HIL prompts, and stale Enter input from graph/connect focus transitions is quarantined when prompts appear after the attach pane is already open, covering input, confirm, select, and editor prompts ([#1163](https://github.com/bastani-inc/atomic/issues/1163)).
- Fixed workflow run widgets so store changes and elapsed-time ticks repaint through a long-lived reactive widget instead of waiting for unrelated chat input or remounting the widget ([#1150](https://github.com/bastani-inc/atomic/issues/1150)).
- Fixed `/workflow reload` and `workflow({ action: "reload" })` so newly added package-manifest workflow entries are rediscovered in-process without requiring top-level `/reload` or restart ([#1155](https://github.com/bastani-inc/atomic/issues/1155)).
- Fixed completed child workflow boundary stages rendering as empty graph nodes by showing the child workflow name, child run id prefix, and output count in the node card.
- Fixed the background workflow widget (`BACKGROUND` panel) listing nested `ctx.workflow()` child runs as separate top-level entries, so a two-level composition no longer shows the root, parent, and child runs as three separate items with an inflated `N runs` count. The widget now applies the same top-level visibility rule (`run.parentRunId === undefined`) already used by `statusRuns`, the `status` action, and the `/workflow connect` session picker. The "needs attention" (awaiting HiL input) badge still fires for a hidden nested descendant by attributing its awaiting state to the visible top-level ancestor via `rootRunId`, so a HiL prompt waiting inside an imported child workflow stays discoverable.
- Fixed the bundled deep-research workflow line-count heuristic hanging Windows CI by replacing its POSIX `wc` subprocess with portable in-process line counting.
- Kept workflow stage model metadata as the raw model id while surfacing Codex fast mode as a separate visible `fast` marker on workflow node cards, including stages that use the default Atomic SDK adapter settings manager.
- Show workflow Codex fast-mode metadata on running workflow nodes as soon as the stage session starts, including explicit-model stages, catalog-resolved bare model aliases, and custom resource-loader stages whose settings manager is created by the Atomic SDK.
- Kept workflow Codex fast-mode markers synchronized across fallback attempts: running nodes now update when fallback switches to a fast-eligible model, completed nodes clear stale `fast` markers when fallback finishes on a non-eligible model, and prompt-adapter stages no longer create SDK sessions only to compute fast metadata.
- Made successful headless `/workflow` informational commands emit displayable command output instead of dropping success messages through the no-op non-interactive UI reporter, made degraded terminal-detail fallback rendering avoid fabricating successful status for unknown run states, and preserved non-interactive execution policy when resuming failed workflow runs ([#1123](https://github.com/bastani-inc/atomic/issues/1123)).
- Suppressed workflow lifecycle steer notices while awaited non-interactive workflow dispatch is already waiting for terminal completion, and made workflow chat-surface custom-message content printable by default for headless list/status/detail/dispatch/killed output ([#1123](https://github.com/bastani-inc/atomic/issues/1123)).
- Re-enabled deterministic non-interactive workflow execution: headless sessions keep the `workflow` tool, `/workflow <name> key=value` skips interactive pickers, named workflow dispatch waits for the terminal run snapshot, declared human-in-the-loop workflows are rejected, top-level `ctx.ui.*` is unavailable, and non-interactive stage sessions exclude `ask_user_question` without binding broker-backed extension UI ([#1123](https://github.com/bastani-inc/atomic/issues/1123)).
- Added a concise display-only `User responded with: ...` workflow HiL answer notice so the main chat transcript records the answer for user-visible audit without triggering an autonomous model turn or adding the notice to LLM context ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Suppressed workflow HiL answer interrupt notices for prompts answered by the main-chat `workflow` tool, so tool-driven answers do not dismiss the current main-chat turn with workflow-chat wording ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Hardened workflow awaiting-input lifecycle notices and readiness-gate answers: awaiting-input lifecycle states now emit main-chat steer notices for dedupe-aware model visibility while preserving the existing `/workflow connect` and `workflow send` response hints, readiness gates use unique prompt ids per gate instance, and duplicate/raced `workflow send` answers for a just-resolved brokered input request now report the request as already answered instead of falling through to `No matching pending prompt` ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Prevented Enter used for `/workflow connect`, graph attach, direct stage attach, unrelated graph-node inspection, or transition key-repeat from immediately submitting workflow HIL prompts; prompt submission now requires the user to be past the attach transition and press Enter while the specific prompted node is attached, leaving sibling HIL prompts pending ([#1148](https://github.com/bastani-inc/atomic/issues/1148)).
- Fixed completed human-in-the-loop prompt archives so reattached read-only prompt nodes keep their prompt card scrollable with keyboard and mouse-wheel input ([#1140](https://github.com/bastani-inc/atomic/issues/1140)).
- Kept the workflow graph overlay navigable while a stage-local human-input prompt is awaiting a response: graph navigation, the stage switcher, Ctrl+D detach, and mouse-wheel scrolling now stay owned by graph mode until the user explicitly attaches to the prompted stage ([#1141](https://github.com/bastani-inc/atomic/issues/1141)).
- Preserved literal slash text entry in legacy run-level workflow prompt cards, so paths and URLs such as `/tmp/file` remain typable while the prompt owns input ([#1141](https://github.com/bastani-inc/atomic/issues/1141)).
- Cleared brokered stage HIL UI during terminal stage cleanup so a completed workflow does not leave an active `ask_user_question`/custom prompt card visible after detach ([#1141](https://github.com/bastani-inc/atomic/issues/1141)).
- Fixed workflow HIL select/editor prompts so navigation, scroll input, and ambiguous Escape-prefix input cannot advance prompts before an explicit configured confirm/Enter submit or Ctrl+C skip. Graph-mode prompt cards now honor custom select keybindings, and Enter submitted during connect/attach/detach transitions is time-boxed so key repeat cannot attach or answer the next prompt accidentally ([#1148](https://github.com/bastani-inc/atomic/issues/1148)).
- Preserved synthetic workflow HiL prompt nodes as `awaiting_input` when an unrelated main-chat `ask_user_question` result arrives, so choosing to leave a workflow prompt open no longer makes the orchestrator node look like it resumed while the prompt is still unanswered ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Fixed headless `/workflow <name>` print-mode automation so successful non-interactive runs wait for terminal snapshots and emit printable run-detail summaries, while terminal failures surface as command-visible errors instead of silent zero-output successes ([#1156](https://github.com/bastani-inc/atomic/issues/1156)).

## [0.8.21] - 2026-05-30

### Changed

- Promoted the 0.8.21 prerelease changes to a stable release.

## [0.8.21-0] - 2026-05-30

### Added

- Enabled the `/workflow send` action (with `delivery: "answer"`) to answer a stage's brokered structured prompts — an in-stage `ask_user_question` call or the deterministic readiness gate — without the interactive TUI/graph overlay. These prompts resolve through the `StageUiBroker` (`ctx.ui.custom`) rather than the simple `store.pendingPrompt` model, so `send` previously no-op'd ("No pending prompt to answer") and they could only be answered by attaching the graph viewer. The stage UI broker now carries an optional headless-answer adapter (`provideStagePrompt` / `peekStagePrompt` / `answerStagePrompt` / `clearStagePrompt`), keyed by `(runId, stageId)`, that maps a simple answer — a free-text reply, an option label, a 1-based option index, comma-separated labels for multi-select, or a pre-built `response` — into the `QuestionnaireResult` the tool expects. The executor's existing `ask_user_question` watcher captures the tool-call `args` to build the adapter, and the readiness gate registers one statically; both surface a serializable `inputRequest` descriptor on the stage snapshot (shown in `/workflow stage` / `stages` output) so an orchestrating agent can see the questions/options and answer them programmatically.
- Added a deterministic readiness gate after `ask_user_question` tool calls inside workflow stages. When a stage's model turn issues an `ask_user_question` call, the workflow re-uses the structured `ask_user_question` UI — rendered inline in the attached stage chat via the stage UI broker — to ask "Are you ready to move on to the next stage?" (Yes/No) before completing/advancing the stage. Answering **No** (or "Chat about this"/cancel) steers the stage with a continuation message so the conversation keeps going, then re-shows the gate after the next turn, repeating until **Yes**; **Yes** resumes normal sequential and dependent-parallel progression. Detection is independent of how the underlying UI is implemented, and the executor exposes a `confirmStageReadiness` seam so the gate is fully testable. `@bastani/atomic` now also exports `createAskUserQuestionToolDefinition` so first-party extensions can invoke the structured prompt deterministically ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).

### Fixed

- Fixed background workflow HIL prompt nodes becoming input-dead when they appeared while the orchestrator graph overlay was already open: the visible overlay now reclaims focus on awaiting-input store updates, and the graph auto-focuses newly awaiting prompt nodes so Enter attaches directly to the HIL response UI.
- Fixed the `/workflow status <id>` run-detail card still ticking (and flickering the whole screen) even after the chat-surface clock was frozen: a running stage's in-flight tool-activity label (e.g. `bash · 6s`) was computed inside `stageActivityString()` from a fresh `Date.now()`, bypassing the capture-once `now` that `renderRunDetail` threads everywhere else. While a background workflow ran, the below-editor companion widget drove a full re-render roughly once per second (and on every store mutation); each re-render advanced that label, and once the detail card had scrolled above the viewport fold pi-tui took the full-screen-clear path (CSI 2J + CSI H + CSI 3J), read as whole-page + chat-box flicker. `stageActivityString()` now uses the threaded `now`, so scrollback run-detail cards are byte-stable across re-renders (the companion widget still owns the live, ticking view).
- Fixed the `/workflow status` and `/workflow status <id>` chat-surface cards triggering a full-screen redraw (clear + scrollback wipe) every render tick once they scroll above the viewport fold. Their custom-message renderer's `render()` lambda re-runs on every TUI frame (pi-tui fans out to every child each `doRender`, and the live workflow/subagent widgets request a frame ~12×/sec while runs are active), and it called `renderStatusList` / `renderRunDetail` without a captured clock, so they fell through to `Date.now()` each frame and ticked the `elapsed` / `running` labels — and pi-tui full-clears the screen (CSI 2J + CSI H + CSI 3J) whenever a changed line sits above the fold, read as whole-screen flicker on terminals without synchronized output (e.g. mosh). The renderer now captures wall-clock once when the chat entry's component is created and threads it through to the status/detail renderers, so these point-in-time scrollback snapshots stay byte-stable across re-renders (the live widget still owns live state). Mirrors the earlier tool-result status-card fix.
- Fixed answering a stage's brokered structured prompt (an in-stage `ask_user_question` or the readiness gate) via `/workflow send` replying **"User declined to answer questions"** and leaving the stage stuck `running` with no pending input — even though a real answer was sent. A structured `response` was forwarded verbatim to the `ask_user_question` tool: a JSON-encoded string was captured as raw free text, and — most damagingly — any object with an `answers` array (e.g. the orchestrator-friendly `{ answers: [{ question, answer }] }`) was treated as a pre-built `QuestionnaireResult` despite lacking the numeric `questionIndex` the tool envelope requires, so it matched no question segment and declined. `coerceStageInputAnswer` now forwards `raw` ONLY for a fully-formed result (every answer carries a numeric `questionIndex`); every other shape — JSON strings, `answers[]`/`questions[]` entries, flat `{ answer | label | selected }`, string arrays — is normalized to a label/index/multi-select value that the stage prompt adapter resolves against the question's options (assigning the correct `questionIndex`). The readiness decision (`readinessResultMeansAdvance`) matches the advance option case/whitespace-insensitively and via `selected[]`. A new regression test drives the real `StageUiBroker` + `ask_user_question` tool resolution path (the seam the earlier unit tests missed) and reproduces the decline for the `answers[]`-without-`questionIndex` payload. The "keep exploring"/stay path is unchanged ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Hardened the `/workflow` tool-result renderer against missing or unshaped payloads. `renderResult` is passed `result.details`, which can be absent during streaming/partial renders or on error paths, and previously dereferenced a missing `action` and crashed the TUI render loop. It now degrades gracefully (renders nothing for partials, a generic notice otherwise) ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Made `terminate: true` tool results deterministic when deriving a stage/task's result text: when an agent turn ends on a terminating tool, the stage runner now returns that tool result's output instead of any prose the model emitted before the tool call. This fixes the `goal` and `ralph` review gates, whose terminating `review_decision` structured-output tool emits clean JSON — previously the preceding assistant narration was captured instead, so the strict `JSON.parse` failed and a valid verdict was misclassified as a reviewer failure ("returned invalid structured JSON"), blocking quorum and forcing extra turns ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Tightened terminating-tool result detection when deriving a stage/task's result text. The stage runner now treats a trailing tool result as the deterministic turn output ONLY when that tool call actually returned `terminate: true` — tracked at runtime from the session's `tool_execution_end` events, since the tool-result message itself does not carry the flag — instead of whenever the last conversational message merely happened to be a tool result. A turn that ends on a non-terminating tool result (e.g. aborted or interrupted right after a tool call) now correctly falls back to the last assistant message, and that fallback no longer surfaces non-terminating tool output. Verified end-to-end against real `terminate: true`, `terminate: false`, and no-tool stages ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Fixed a mid-turn `ask_user_question` (or readiness gate) rendering but being input-dead in the attached stage chat. After a readiness-gate "stay" returns to the composer and the user submits another message, the agent's next question mounts while host keyboard focus has drifted off the overlay; the focus re-assertion was suppressed during streaming (a blunt guard added to avoid a prior continuation stall), so arrows/Enter were ignored and nothing could be answered or sent to the model. The overlay's `requestFocus` is now idempotent — it grabs focus only when the overlay does not already own it (`isFocused()`), so the redundant `focus()` that stalled the stream never runs. The stage chat now requests focus whenever a custom UI is shown (including mid-turn) and the focus-hold timer keeps a mounted question focused, trusting `requestFocus` to no-op when unnecessary ([#1120](https://github.com/bastani-inc/atomic/issues/1120)).
- Detaching or closing the attached stage chat (Ctrl+D / Ctrl+C) while a stage has a pending human-input request — an agent `ask_user_question` call or the readiness gate — no longer cancels that request. Previously, tearing down the chat view (or its stage UI broker host) rejected the pending prompt, so the stage silently dropped out of `awaiting_input` and the question disappeared. Detaching, closing, and disposing now only stop *displaying* the request: it stays pending (the stage remains `awaiting_input`) and is re-displayed when a host re-attaches. A pending request is settled only by the user answering (broker resolve) or the run aborting via its `AbortSignal` — the single chokepoints for ending a human-input request ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).

## [0.8.20] - 2026-05-29

### Changed

- Promoted the 0.8.20 prerelease changes to a stable release.

## [0.8.20-0] - 2026-05-29

### Added

- Added main-chat lifecycle steer notices for workflow completion, failure, and awaiting-input pauses with global notification config controls ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).

### Fixed

- Fixed the background-workflow companion counter widget flickering every second while a run is active by updating a single long-lived above-editor widget in place instead of disposing and re-mounting a fresh widget factory on each elapsed-clock tick ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Fixed workflow lifecycle completion/failure/awaiting-input notices crashing the TUI on narrow or freshly-resized terminals: the notice component now wraps to the render width (hard-breaking long run ids) instead of emitting a single fixed line, which pi-tui rejects with a hard "Rendered line exceeds terminal width" throw ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Fixed the workflow companion counter widget triggering a full-screen redraw (clear + scrollback wipe) on every elapsed-clock tick after the terminal is resized while a run is active. The widget now mounts `belowEditor` instead of `aboveEditor`, keeping its live clock line within the bottom viewport; pi-tui full-clears the screen whenever a changed line sits above the viewport fold, and an above-editor widget was pushed above the fold once the editor/status region grew tall ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Disabled workflows in non-interactive (`-p` / `--print` / `--mode json`) sessions, which bind a no-op UI surface and cannot drive workflow prompts, pickers, or the graph overlay: the `workflow` tool is removed from the model's active tool set at session start, and the `/workflow` command (reachable via `atomic -p "/workflow …"`) is refused — preventing headless runs from stalling on work that can never complete ([#1096](https://github.com/bastani-inc/atomic/issues/1096)).
- Escaped workflow lifecycle notice text and structured response hints, isolated lifecycle send failures from store subscribers, and rejected empty lifecycle notification event lists ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).
- Fixed stage awaiting-input lifecycle notice dedupe so promptless pauses after resolved prompts are not suppressed by historical prompt metadata ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).
- Reset workflow lifecycle-notification dedupe state at chat session boundaries so reused workflow run IDs in later sessions still emit completion/failure/input notices ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).
- Warn before starting or resuming another session when workflows are still in flight, allowing users to cancel before those runs are killed and current-session workflow history is cleared ([#1082](https://github.com/bastani-inc/atomic/issues/1082)).
- Prevented workflow stage sessions from exposing or executing the `workflow` tool while preserving stage-level subagent delegation.
- Retained completed, failed, and killed workflow runs in user-facing status/connect surfaces and changed workflow kill controls to mark runs killed without removing them from live inspection history ([#1083](https://github.com/bastani-inc/atomic/issues/1083)).

## [0.8.18] - 2026-05-27

### Changed

- Promoted the 0.8.18 prerelease changes to a stable release.

## [0.8.18-0] - 2026-05-27

### Added

- Added Ralph `git_worktree_dir` support for running stages from an optional Git worktree, reusing/sharing existing worktrees from the invoking repository as-is and leaving worktrees in place for retries.

### Changed

- Replaced regex-based workflow discovery stage validation with runtime empty-graph validation based on actual stage creation while keeping discovery side-effect-free.
- Threaded named workflow invocation cwd into workflow run contexts so workflow-owned artifacts can use the explicit runner cwd.
- Split worker project-initialization preflight guidance from Goal receipt/reporting instructions.

### Fixed

- Defaulted workflow `ctx.cwd` to the reusable worktree cwd when `worktreeFromInputs` resolves a `gitWorktreeDir`, so workflow-owned artifacts such as Ralph specs are written inside the worktree unless explicitly overridden.
- Avoided blank deep-research display paths when a displayed artifact path equals the workflow invocation directory.
- Distinguished Ralph same-repository worktree classification and canonicalization failures from definitely non-Git existing `git_worktree_dir` paths.
- Updated Ralph to revise a stable original spec file across planner iterations and clarified `git_worktree_dir` null-byte diagnostics.

## [0.8.17] - 2026-05-26

### Changed

- Promoted the 0.8.17 prerelease changes to a stable release.

## [0.8.17-0] - 2026-05-26

### Breaking Changes

- Removed Ralph's configurable `review_quorum` and `blocker_threshold` inputs; `max_turns` remains configurable while reviewer quorum and blocker threshold use fixed controller defaults ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

### Changed

- Aligned Ralph's goal-continuation prompt more closely with Codex `/goal` hidden continuation guidance, including current-state evidence, non-shrinking scope, fidelity, completion audit, and strict blocked audit language ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).
- Restored Ralph's stronger historical review gate prompt and `review_decision` schema with findings, oracle satisfaction, receipt assessment, verification remaining, and reviewer-error guard fields.

## [0.8.16] - 2026-05-26

### Changed

- Promoted the 0.8.16 prerelease changes to a stable release.

## [0.8.16-0] - 2026-05-26

### Breaking Changes

- Removed Ralph's `prompt` and `max_loops` compatibility inputs; use the canonical `objective` and `max_turns` inputs instead ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

### Changed

- Reworked Ralph into a Goal Runner workflow with a persisted goal ledger, bounded worker turns, parallel structured reviewers, reviewer-quorum completion, repeated-blocker gating, and final status reporting while excluding token-budget behavior ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

### Fixed

- Hardened Ralph's goal-runner edge cases around base-branch sanitization coverage, worker/reviewer failure handling, cross-turn review context, bounded blocker-threshold handling, and unused ledger state ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

## [0.8.15] - 2026-05-26

### Breaking Changes

- Changed workflow human-in-the-loop prompts (`ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor`) to render as synthetic graph stages with `awaiting_input` status; consumers should handle the new `StageSnapshot.promptAnswerState` metadata and avoid caching `StageSnapshot.parentIds` references across store updates ([#1046](https://github.com/bastani-inc/atomic/issues/1046)).
- Changed `ctx.ui.select(..., [])` to throw `pi-workflows: ctx.ui.select requires at least one option` before creating a prompt node instead of returning an empty string ([#1046](https://github.com/bastani-inc/atomic/issues/1046)).

### Added

- Added workflow tool stage introspection and control actions (`stages`, `stage`, `transcript`, `send`, `pause`, and `reload`) for inspecting stage state, reading transcripts, answering prompts, controlling live stages, pausing runs, and reloading workflow resources ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Added live-memory prompt answer replay for workflow continuations using snapshot-safe `promptAnswerState` markers and a private `PromptAnswerRecord` ledger that is excluded from snapshots and persistence ([#1046](https://github.com/bastani-inc/atomic/issues/1046)).

### Changed

- Updated Ralph around an autonomous goal contract so planner, implementation, and reviewer/auditor stages infer verifiable criteria, require receipts, and judge completion against the verification oracle instead of document completeness alone ([#1053](https://github.com/bastani-inc/atomic/issues/1053)).
- Updated Ralph's orchestrator prompt to discover project initialization needs from repository evidence before implementation work proceeds ([#1048](https://github.com/bastani-inc/atomic/issues/1048)).
- Added a final Ralph PR-preparation phase that reviews changes against the configured base branch, tries available GitHub credentials using local git identity as a hint, posts implementation notes as a PR comment, and creates a pull request when possible.
- Updated Ralph to persist planner goal contracts and implementation notes as OS-temp workflow artifacts, and pass file paths rather than full plan text to later stages ([#1037](https://github.com/bastani-inc/atomic/issues/1037)).
- Updated `deep-research-codebase` output layout to write public reports under `research/` and hidden per-run handoff artifacts under `research/.deep-research-<run-id>/`.

### Fixed

- Returned the workflow overlay to the graph orchestrator after answering or skipping a `ctx.ui` prompt node, and preserved the prompt's question footprint for read-only prompt-node views.
- Removed biasing stage-output and iteration-count context from Ralph reviewer prompts while making the comparison base branch explicit ([#1037](https://github.com/bastani-inc/atomic/issues/1037)).
- Ordered snapshot transcript fallback entries chronologically before applying `tail`/`limit`, preserving terminal result/error entries after tools for missing or tied timestamps ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Reloaded workflow resources directly for `workflow({ action: "reload" })` instead of queuing a literal `/workflow reload` follow-up ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Kept pending prompts unresolved when `workflow({ action: "send" })` omits `text`, `response`, and `message`, while preserving explicit empty-string answers ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Included `deep-research-codebase` discovery-stage handoff files in the persisted run manifest.
- Persisted `deep-research-codebase` final reports as dated Markdown research docs while retaining file-only handoffs for bounded aggregation.
- Prevented `deep-research-codebase` aggregation from inlining large specialist transcripts by using file-only handoff artifacts ([#1016](https://github.com/bastani-inc/atomic/issues/1016)).
- Removed model metadata from workflow node cards while retaining fallback dependency metadata ([#1011](https://github.com/bastani-inc/atomic/issues/1011)).
- Preserve the selected workflow switcher row highlight through truncation ellipses on long stage names.

## [0.0.1] — 2026-05-15

### Added

- Initial release of `@bastani/workflows`, a raw TypeScript pi package for multi-stage workflow authoring and execution.
- pi extension entry point at `src/extension/index.ts` registered through the package `pi` manifest.
- Public authoring API with `defineWorkflow`, `createRegistry`, workflow identity helpers, and programmatic workflow runners.
- `workflow` LLM tool and `/workflow` slash command surface for listing, inspecting, running, interrupting, and resuming workflows.
- Background workflow execution with persisted run/stage state, status rendering, cancellation, pause/resume support, and HIL prompt routing.
- TUI surfaces for live workflow progress, graph overlays, run details, stage chat, input collection, and status widgets.
- Workflow discovery from bundled workflows, project-local `.atomic/workflows/`, user-global `~/.atomic/agent/workflows/`, and configured workflow directories.
- Built-in workflows: `deep-research-codebase`, `open-claude-design`, and `ralph`.
- Optional runtime integrations with companion pi packages including `pi-subagents`, `pi-mcp-adapter`, `pi-intercom`, and `pi-web-access`.
- Bundled skills, agents, themes, examples, and documentation for authoring and operating workflows.
