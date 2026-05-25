# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added workflow tool stage introspection and control actions (`stages`, `stage`, `transcript`, `send`, `pause`, and `reload`) for inspecting stage state, reading transcripts, answering prompts, controlling live stages, pausing runs, and reloading workflow resources ([#1023](https://github.com/flora131/atomic/issues/1023)).

### Changed

- Updated Ralph's orchestrator prompt to discover project initialization needs from repository evidence before implementation work proceeds ([#1048](https://github.com/flora131/atomic/issues/1048)).
- Added a final Ralph PR-preparation phase that reviews changes against the configured base branch, tries available GitHub credentials using local git identity as a hint, posts implementation notes as a PR comment, and creates a pull request when possible.
- Updated Ralph to persist planner RFCs under `specs/`, keep OS-temp implementation notes during orchestration, and pass file paths rather than the full plan text to later stages ([#1037](https://github.com/flora131/atomic/issues/1037)).
- Updated `deep-research-codebase` output layout to write public reports under `research/` and hidden per-run handoff artifacts under `research/.deep-research-<run-id>/`.

### Fixed

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
