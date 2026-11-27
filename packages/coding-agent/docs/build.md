---
title: "Build with Atomic"
sidebarTitle: "Build with Atomic"
description: "Choose how to customize an Atomic session, extend it with TypeScript or MCP, or embed it in your own software."
---

Customize how Atomic behaves in your repository, connect external tools, or embed the agent runtime in your own software.

New to Atomic? Start with the [Quickstart](/quickstart) or [How Atomic works](/how-atomic-works). Looking for an exact CLI flag, setting, or API contract? Use the [Reference index](/reference).

## Choose the lightest mechanism

Start at the top of this table and stop at the first mechanism that fits your task.

| What you want | Start with | Needs code? |
| --- | --- | --- |
| Expand a reusable Markdown prompt from a `/command` | [Create prompt templates](/prompt-templates) | No |
| Give the agent on-demand instructions and optional scripts | [Use skills](/skills) | Optional scripts |
| Connect external tools and data sources over MCP | [MCP servers](/mcp-servers) | No (config only) |
| Delegate a focused, bounded task to a child agent | [Subagents](/subagents) | No |
| Coordinate live sessions on one host or across machines | [Intercom](/intercom) | No |
| Run multi-step fan-out, checks, and recovery logic | [Orchestration](/orchestration) | JavaScript in codemode |
| Add custom tools, slash commands, lifecycle hooks, or custom UI | [Extensions](/extensions) | TypeScript |
| Bundle and version customizations to share across teams | [Atomic packages](/packages) | Package manifest |

<Note>
Need restored worktrees to rebuild dependencies and caches automatically across machines or CI runners? Define `.atomic/blueprint.yaml` as an [environment blueprint](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint).
</Note>

## Change the model layer

<Columns cols={2}>
  <Card title="Choose a model" href="/models/choose-a-model">
    Switch chat models, thinking levels, scoped models, and fallbacks day to day.
  </Card>
  <Card title="Custom models" href="/models">
    Add model entries, parameter overrides, or compatible endpoints in `models.json`.
  </Card>
  <Card title="Remote compaction models" href="/compaction/custom-compactors">
    Tune built-in Morph compaction parameters or connect your own remote compaction endpoint.
  </Card>
  <Card title="Custom providers" href="/custom-provider">
    Implement a provider API, classifier, remote compactor, or OAuth flow that Atomic does not ship.
  </Card>
</Columns>

## Customize appearance and controls

<Columns cols={2}>
  <Card title="Create themes" href="/themes">
    Switch built-in palettes, follow terminal light or dark mode, or author custom JSON themes with live hot reload.
  </Card>
  <Card title="Keybindings" href="/keybindings">
    Rebind interactive shortcuts and navigation keys in `keybindings.json`.
  </Card>
</Columns>

## Embed Atomic in your own software

Compare print mode, JSON streams, RPC, and the TypeScript SDK in [Programmatic modes](/programmatic), then jump to the integration that fits your stack.

<Columns cols={2}>
  <Card title="TypeScript SDK" href="/sdk">
    Embed Atomic directly in Node.js applications with full session and tool control.
  </Card>
  <Card title="SDK storage backends" href="/sdk/storage">
    Wire local SQLite, JSONL, in-memory, or PostgreSQL storage into `createAgentSession()`.
  </Card>
  <Card title="Structured decisions" href="/sdk/structured-decisions">
    Run typed classifier or chat decisions with `decide()` and `generateStructuredOutput()`.
  </Card>
  <Card title="Web server guide" href="/sdk/web-server">
    Stream agent runs from an HTTP server or Next.js App Router endpoint.
  </Card>
  <Card title="RPC mode" href="/rpc">
    Drive an Atomic session over stdin and stdout JSONL from any language.
  </Card>
  <Card title="JSON event stream mode" href="/json">
    Run non-interactive prompts that emit structured JSONL events.
  </Card>
  <Card title="TUI components" href="/tui">
    Build custom terminal UI components for extensions and embedded hosts.
  </Card>
  <Card title="Standalone libraries" href="/libraries">
    Use Atomic's six core packages (`ai`, `tui`, `agent-core`, `codemode`, `schema`, `telemetry`) and the optional PostgreSQL storage adapter (`@bastani/atomic-storage-postgres`) directly.
  </Card>
</Columns>
