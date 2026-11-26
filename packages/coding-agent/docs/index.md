---
title: "Atomic documentation"
sidebarTitle: "Overview"
description: "Install Atomic, connect a model provider, and explore guides, customization APIs, and CLI references."
---

Atomic is a terminal coding agent with built-in file, shell, search, codemode, subagent, MCP, web access, and Intercom tools. Extend it with TypeScript extensions, skills, prompt templates, themes, and Atomic packages.

## Quick start

Install with a package manager (requires [Node.js 24.20.0 or newer](/getting-started/installation#nodejs-version), or Bun 1.4.5+ for Bun installs):

```bash
npm install -g @bastani/atomic
# or: pnpm add -g @bastani/atomic
# or: bun add -g @bastani/atomic
```

Atomic does not require package install scripts; pass `--ignore-scripts` if you disable lifecycle scripts during install.

Or install the self-contained release archive, which needs no Node.js or package manager:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

The archive installer verifies the GitHub Release checksum and installs into a versioned directory. See [Release archive](/getting-started/installation#release-archive) for version pinning, custom install paths, and `PATH` setup.

Start Atomic in any project directory:

```bash
atomic
```

Authenticate with `/login`, run `atomic auth login <provider>` in your shell, or export an API key such as `ANTHROPIC_API_KEY` before launching. See [Quickstart](/quickstart) for the full first-run walkthrough.

## First successful session

1. [Install Atomic](/getting-started/installation).
2. [Authenticate a provider](/getting-started/authentication).
3. [Run your first session](/getting-started/first-session).
4. [Add project instructions](/getting-started/project-instructions).
5. [Use interactive mode](/usage).
6. [Manage sessions](/sessions) and [compaction](/compaction).

## Explore by capability

- **Sessions, snapshots, and resume:** Save and branch in [Sessions](/sessions), capture repository state with [Worktree snapshots](/worktree-snapshots), resume across machines with [Environment blueprints](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint), and share state over PostgreSQL or Turso/libSQL in [Storage backends](/storage).
- **Multi-agent work:** Delegate focused tasks with [Subagents](/subagents), coordinate live sessions with [Intercom](/intercom), and script multi-step checks with [Orchestration](/orchestration).
- **Tools and context:** Connect external tools through [MCP servers](/mcp-servers), keep long runs within budget with [Compaction and custom compactors](/compaction#customize-morph-or-add-a-remote-compactor), and inspect terminal integrations like [Herdr](/herdr).
- **Embed and extend:** Drive Atomic from Node.js with the [TypeScript SDK](/sdk), [SDK storage backends](/sdk/storage), [Structured decisions (`decide()`)](/sdk/structured-decisions), [RPC mode](/rpc), and [Standalone libraries](/libraries).
- **Troubleshoot:** Capture logs, stalls, and snapshots with [Diagnostics and debugging](/development).

## Documentation paths

- **[Learn](/guides).** Install Atomic, run interactive and non-interactive sessions, manage context and [worktree snapshots](/worktree-snapshots), delegate work with [subagents](/subagents) and [Intercom](/intercom), connect providers, and review security and containerization.
- **[Build](/build).** Customize Atomic with skills, prompt templates, themes, extensions, [MCP servers](/mcp-servers), and packages, orchestrate agents, define custom providers and compactors, or embed Atomic through the [SDK, RPC, or JSON mode](/programmatic).
- **[Reference](/reference).** Look up CLI commands and flags, settings, environment variables, keybindings, tools, [storage](/storage), customization schemas, API protocols, [platform setup](/herdr), and [diagnostics](/development).
