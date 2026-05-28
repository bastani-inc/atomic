# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Warn before starting a new session when workflows are still running, allowing users to cancel before those runs are killed and current-session workflow history is cleared ([#1082](https://github.com/flora131/atomic/issues/1082)).

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

- Removed Ralph's configurable `review_quorum` and `blocker_threshold` inputs; `max_turns` remains configurable while reviewer quorum and blocker threshold use fixed controller defaults ([#1061](https://github.com/flora131/atomic/issues/1061)).

### Changed

- Aligned Ralph's goal-continuation prompt more closely with Codex `/goal` hidden continuation guidance, including current-state evidence, non-shrinking scope, fidelity, completion audit, and strict blocked audit language ([#1061](https://github.com/flora131/atomic/issues/1061)).
- Restored Ralph's stronger historical review gate prompt and `review_decision` schema with findings, oracle satisfaction, receipt assessment, verification remaining, and reviewer-error guard fields.

## [0.8.16] - 2026-05-26

### Changed

- Promoted the 0.8.16 prerelease changes to a stable release.

## [0.8.16-0] - 2026-05-26

### Breaking Changes

- Removed Ralph's `prompt` and `max_loops` compatibility inputs; use the canonical `objective` and `max_turns` inputs instead ([#1061](https://github.com/flora131/atomic/issues/1061)).

### Changed

- Reworked Ralph into a Goal Runner workflow with a persisted goal ledger, bounded worker turns, parallel structured reviewers, reviewer-quorum completion, repeated-blocker gating, and final status reporting while excluding token-budget behavior ([#1061](https://github.com/flora131/atomic/issues/1061)).

### Fixed

- Hardened Ralph's goal-runner edge cases around base-branch sanitization coverage, worker/reviewer failure handling, cross-turn review context, bounded blocker-threshold handling, and unused ledger state ([#1061](https://github.com/flora131/atomic/issues/1061)).

## [0.8.15] - 2026-05-26

### Breaking Changes

- Changed workflow human-in-the-loop prompts (`ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor`) to render as synthetic graph stages with `awaiting_input` status; consumers should handle the new `StageSnapshot.promptAnswerState` metadata and avoid caching `StageSnapshot.parentIds` references across store updates ([#1046](https://github.com/flora131/atomic/issues/1046)).
- Changed `ctx.ui.select(..., [])` to throw `pi-workflows: ctx.ui.select requires at least one option` before creating a prompt node instead of returning an empty string ([#1046](https://github.com/flora131/atomic/issues/1046)).

### Added

- Added workflow tool stage introspection and control actions (`stages`, `stage`, `transcript`, `send`, `pause`, and `reload`) for inspecting stage state, reading transcripts, answering prompts, controlling live stages, pausing runs, and reloading workflow resources ([#1023](https://github.com/flora131/atomic/issues/1023)).
- Added live-memory prompt answer replay for workflow continuations using snapshot-safe `promptAnswerState` markers and a private `PromptAnswerRecord` ledger that is excluded from snapshots and persistence ([#1046](https://github.com/flora131/atomic/issues/1046)).

### Changed

- Updated Ralph around an autonomous goal contract so planner, implementation, and reviewer/auditor stages infer verifiable criteria, require receipts, and judge completion against the verification oracle instead of document completeness alone ([#1053](https://github.com/flora131/atomic/issues/1053)).
- Updated Ralph's orchestrator prompt to discover project initialization needs from repository evidence before implementation work proceeds ([#1048](https://github.com/flora131/atomic/issues/1048)).
- Added a final Ralph PR-preparation phase that reviews changes against the configured base branch, tries available GitHub credentials using local git identity as a hint, posts implementation notes as a PR comment, and creates a pull request when possible.
- Updated Ralph to persist planner goal contracts and implementation notes as OS-temp workflow artifacts, and pass file paths rather than full plan text to later stages ([#1037](https://github.com/flora131/atomic/issues/1037)).
- Updated `deep-research-codebase` output layout to write public reports under `research/` and hidden per-run handoff artifacts under `research/.deep-research-<run-id>/`.

### Fixed

- Returned the workflow overlay to the graph orchestrator after answering or skipping a `ctx.ui` prompt node, and preserved the prompt's question footprint for read-only prompt-node views.
- Removed biasing stage-output and iteration-count context from Ralph reviewer prompts while making the comparison base branch explicit ([#1037](https://github.com/flora131/atomic/issues/1037)).
- Ordered snapshot transcript fallback entries chronologically before applying `tail`/`limit`, preserving terminal result/error entries after tools for missing or tied timestamps ([#1023](https://github.com/flora131/atomic/issues/1023)).
- Reloaded workflow resources directly for `workflow({ action: "reload" })` instead of queuing a literal `/workflow reload` follow-up ([#1023](https://github.com/flora131/atomic/issues/1023)).
- Kept pending prompts unresolved when `workflow({ action: "send" })` omits `text`, `response`, and `message`, while preserving explicit empty-string answers ([#1023](https://github.com/flora131/atomic/issues/1023)).
- Included `deep-research-codebase` discovery-stage handoff files in the persisted run manifest.
- Persisted `deep-research-codebase` final reports as dated Markdown research docs while retaining file-only handoffs for bounded aggregation.
- Prevented `deep-research-codebase` aggregation from inlining large specialist transcripts by using file-only handoff artifacts ([#1016](https://github.com/flora131/atomic/issues/1016)).
- Removed model metadata from workflow node cards while retaining fallback dependency metadata ([#1011](https://github.com/flora131/atomic/issues/1011)).
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
