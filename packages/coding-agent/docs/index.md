---
title: "Overview"
description: "Atomic documentation overview"
---

# Atomic Documentation

Atomic is the loop engine for all engineering work: a terminal coding-agent runtime for reliable, inspectable engineering loops. It stays small at the core while being extended through TypeScript extensions, skills, prompt templates, themes, workflows, subagents, MCP, web access, and Atomic packages.

## Quick start

Install the self-contained release archive on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

Archive installation does not require Node.js or a package manager. It verifies the GitHub Release checksum and installs the full payload under a versioned root. See the [Quickstart](/quickstart#release-archive) for exact-version flags, default paths, `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, `ATOMIC_VERSION`, optional `GITHUB_TOKEN`/`GH_TOKEN`, and PATH guidance.

Package installation still requires Node.js. With npm, pnpm, or Bun:

```bash
npm install -g @bastani/atomic
pnpm add -g @bastani/atomic
bun add -g @bastani/atomic
```

Atomic does not require package install scripts. Add `--ignore-scripts` if you want to disable dependency lifecycle scripts during a package install.

### Alpine and musl Linux archives

The shell installer detects Alpine and selects `atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`. Each archive includes its matching native search and PTY bindings plus payload-local `libgcc` and `libstdc++` runtimes. It runs on stock Alpine without installing runtime packages.

The musl archives deliberately omit a clipboard native binding because `@mariozechner/clipboard` 0.3.9 publishes metadata-only musl stubs without a `.node` payload; Atomic uses Linux clipboard commands and OSC52 fallback instead. They also omit `@embedded-postgres/*` binary packages because those packages are glibc-linked. Durable workflows on Alpine therefore require external Postgres via `DBOS_SYSTEM_DATABASE_URL` or Docker; without a durable backend, Atomic uses a loud non-durable in-memory fallback.

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
- [Environment variables](/environment-variables) - Atomic/Pi aliases, provider credentials, and bash session metadata.
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
- [Desktop host](/desktop) - experimental optional Tauri host on RPC.
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
