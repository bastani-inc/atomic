---
title: "Build with Atomic"
sidebarTitle: "Overview"
description: "Choose how to customize an Atomic session, extend it with TypeScript or MCP, or embed it in your own software."
---

Customize an Atomic session or embed it in your own software. Choose a starting point below.

New to Atomic? Start with the [Quickstart](/quickstart). To look up an exact contract, use the [Reference index](/reference).

## Choose the lightest mechanism

Work down this list and stop at the first mechanism that solves your problem.

1. [Prompt templates](/prompt-templates). Expand reusable Markdown prompts from a slash command without writing code.
2. [Skills](/skills). Provide on-demand instructions and optional scripts that the agent loads when a task matches.
3. [MCP servers](/mcp-servers). Connect external tools and data sources over Model Context Protocol without writing an extension.
4. [Subagents](/subagents). Delegate a focused, bounded task to a child agent.
5. [Intercom](/intercom). Coordinate sessions on the same machine or across machines sharing a database.
6. [Orchestration](/orchestration). Use codemode to launch children, check results, and pick up after an interruption.
7. [Environment blueprints](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint). Define `.atomic/blueprint.yaml` so restored worktrees rebuild dependencies and caches automatically on any machine or CI runner.
8. [Extensions](/extensions). Write TypeScript that adds tools, commands, events, and custom UI when nothing lighter fits.
9. [Atomic packages](/packages). Bundle and distribute your extensions, skills, prompt templates, themes, subagents, MCP servers, or [storage adapters](/storage#adapters-from-atomic-packages).

## Change the model layer

- [Custom models](/models). Add model entries for a supported provider API.
- [Remote compaction models](/models#remote-compaction-models). Configure custom `type: "compactor"` endpoints or override `morph/morph-compactor` parameters (see [Compaction](/compaction#customize-morph-or-add-a-remote-compactor)).
- [Custom providers](/custom-provider). Implement a provider API, classifier, remote compactor, or OAuth flow that Atomic does not ship.

## Customize appearance and controls

- [Themes](/themes). Restyle the terminal with a built-in or custom JSON theme.
- [Keybindings](/keybindings). Rebind interactive shortcuts and navigation keys.

## Embed Atomic in your own software

[Programmatic modes](/programmatic) compares JSON mode, RPC, and the SDK, and links each one to its protocol or API reference.

- [TypeScript SDK](/sdk). Embed Atomic in Node.js applications.
- [SDK storage backends](/sdk/storage). Wire local SQLite, JSONL, in-memory, libSQL/Turso, or PostgreSQL into `createAgentSession()` and `createAgentSessionRuntime()`.
- [Structured decisions](/sdk/structured-decisions). Run typed classifier or chat decisions with `decide()` and `generateStructuredOutput()`.
- [Web server guide](/sdk/web-server). Stream agent runs from an HTTP server or Next.js App Router endpoint.
- [RPC mode](/rpc). Integrate over stdin and stdout JSONL.
- [JSON event stream mode](/json). Run print mode with structured events.
- [TUI components](/tui). Build custom terminal UI for extensions.
- [Standalone libraries](/libraries). Use Atomic's six core packages (`ai`, `tui`, `agent-core`, `codemode`, `schema`, `telemetry`) and optional storage adapters ([`@bastani/atomic-storage-postgres`](/libraries/storage-postgres) and [`@bastani/atomic-storage-libsql`](/libraries/storage-libsql)) directly.
