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
7. [Extensions](/extensions). Write TypeScript that adds tools, commands, events, and custom UI when nothing lighter fits.
8. [Atomic packages](/packages). Bundle and distribute your extensions, skills, prompt templates, themes, subagents, MCP servers, or storage adapters.

## Change the model layer

- [Custom models](/models). Add model entries for a supported provider API.
- [Custom providers](/custom-provider). Implement a provider API or OAuth flow that Atomic does not ship.

## Customize appearance and controls

- [Themes](/themes). Restyle the terminal with a built-in or custom JSON theme.
- [Keybindings](/keybindings). Rebind interactive shortcuts and navigation keys.

## Embed Atomic in your own software

[Programmatic use](/programmatic) compares JSON mode, RPC, and the SDK, and links each one to its protocol or API reference.

- [SDK](/sdk). Embed Atomic in Node.js applications.
- [RPC mode](/rpc). Integrate over stdin and stdout JSONL.
- [JSON event stream mode](/json). Run print mode with structured events.
- [TUI components](/tui). Build custom terminal UI for extensions.
- [Libraries](/libraries). Use Atomic's AI, TUI, agent core, codemode, schema, and telemetry packages directly.
