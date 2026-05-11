# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-11

### Added

- `pi-workflows` package: multi-stage workflow authoring and execution as a pi extension.
- Authoring API: `defineWorkflow` fluent builder, `createRegistry` (immutable chainable), `normalizeWorkflowName`.
- DAG executor (`src/runs/sync/executor.ts`) with `GraphFrontierTracker` topology inference — sequential, parallel (`Promise.all`), and fan-in stage topologies.
- Extension entry point registering the `workflow` tool, `/workflow` slash command surface, `/workflows-doctor`, message renderers, and lifecycle hooks against the pi extension API.
- Above-editor progress widget via `pi.setWidget` with live stage status and tool-execution event subscriptions.
- On-demand DAG overlay (`ctx.ui.custom({overlay: true})`) with keyboard navigation and status filter modes.
- Session-entry persistence via `pi.appendEntry` for run/stage lifecycle events; restore on `session_start`; compaction policy hook.
- `/workflow status`, `/workflow stop`, `/workflow resume` slash commands for run lifecycle management.
- Per-event inline rendering in the chat scroll: run banner, stage chips, stage progress, stage results, run summary.
- Optional integrations: `pi-subagents` (sub-agent dispatch from stages), `pi-mcp-adapter` (per-stage MCP server gating), `pi-intercom` (detached-run HIL via `contact_supervisor`).
- Builtin workflows: `deep-research-codebase` (scout → parallel specialists → aggregator), `ralph` (plan → orchestrate → review loop with HIL), `open-claude-design` (design generation pipeline).
- Runnable examples in `packages/pi-workflows/examples/`.
- Published to npm as `pi-workflows@0.1.0` (unscoped, MIT, `keywords: ["pi-package"]`, `pi` manifest in package.json).

## [0.7.0] — 2026-05-04

### Breaking Changes
- **SDK rename: `@bastani/atomic` → `@bastani/atomic-sdk`.** Library consumers of
  `defineWorkflow`, `createRegistry`, `WorkflowPicker`, etc. must migrate package
  name. No backwards-compat shim is published. See README "Migration from 0.6.x".
- **Wrapper carries no runtime dependencies.** `@bastani/atomic` is now a
  zero-dep wrapper that resolves a per-platform binary via `optionalDependencies`.

### Added
- Per-platform binary distribution: `@bastani/atomic-{linux,darwin,windows}-{x64,arm64}`.
- Bun workspace at repo root; CLI under `packages/atomic/`, SDK under `packages/atomic-sdk/`.
- `Bun.embeddedFiles`-backed config bundling — `.claude/`, `.opencode/`, `.github/`,
  `.agents/skills/` are inlined into the compiled binary and extracted to a
  platform cache on first run.

### Fixed
- Windows MAX_PATH (260-char) silent file-extraction truncation that produced
  `z.toJSONSchema is not a function` at runtime. Wrapper has no nested
  `node_modules` by construction.
