---
title: "Overview"
description: "Atomic documentation overview"
---

# Atomic Documentation

Atomic is the loop engine for all engineering work: a terminal coding-agent runtime for reliable, inspectable engineering loops. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, workflows, subagents, MCP, web access, and Atomic packages.

## Quick start

Install Atomic globally with npm, pnpm, or Bun:

With npm:

```bash
npm install -g @bastani/atomic
```

With pnpm:

```bash
pnpm add -g @bastani/atomic
```

With Bun:

```bash
bun add -g @bastani/atomic
```

Atomic does not require package install scripts. If you want to disable dependency lifecycle scripts during the Atomic install, you can add `--ignore-scripts` to the install command.

Or download an `atomic-*` archive from the Atomic GitHub Release for your platform.

Then run it in a project directory:

```bash
atomic
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Atomic.

For the full first-run flow, see [Quickstart](/quickstart).

## Start here

- [Quickstart](/quickstart) - install, authenticate, and run a first session.
- [Using Atomic](/usage) - interactive mode, slash commands, context files, and CLI reference.
- [Providers](/providers) - subscription and API-key setup for built-in providers.
- [Security](/security) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](/containerization) - sandbox Atomic with OpenShell, Gondolin, or Docker.
- [Settings](/settings) - global and project settings.
- [Keybindings](/keybindings) - default shortcuts and custom keybindings.
- [Sessions](/sessions) - session management, branching, and tree navigation.
- [Compaction](/compaction) - Verbatim Compaction, context management, and branch summarization.

## Customization

- [Extensions](/extensions) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](/skills) - Agent Skills for reusable on-demand capabilities.
- [Subagents](/subagents) - focused child agents for research, analysis, debugging, cleanup, and review compositions.
- [Workflows](/workflows) - executable engineering loops with tracked stages, artifacts, gates, and resumable runs.
- [Prompt templates](/prompt-templates) - reusable prompts that expand from slash commands.
- [Themes](/themes) - built-in and custom terminal themes.
- [Atomic packages](/packages) - bundle and share extensions, skills, prompts, and themes.
- [Custom models](/models) - add model entries for supported provider APIs.
- [Custom providers](/custom-provider) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](/sdk) - embed Atomic in Node.js applications.
- [RPC mode](/rpc) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](/json) - print mode with structured events.
- [TUI components](/tui) - build custom terminal UI for extensions.

## Reference

- [Session format](/session-format) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](/windows)
- [Termux on Android](/termux)
- [tmux](/tmux)
- [Terminal setup](/terminal-setup)
- [Shell aliases](/shell-aliases)

## Development

- [Development](/development) - local setup, project structure, and debugging.
