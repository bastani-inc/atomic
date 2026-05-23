# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Prevented `deep-research-codebase` aggregation from inlining large specialist transcripts by handing intermediate research to downstream stages as file-only artifacts ([#1016](https://github.com/flora131/atomic/issues/1016)).
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
