---
title: "Overview"
description: "Atomic documentation overview"
---

# Atomic documentation

Atomic is a terminal coding-agent runtime with built-in file, shell, search, codemode, subagent, MCP, web access, and Intercom tools. Extend it with TypeScript extensions, skills, prompt templates, themes, and Atomic packages.

## Quick start

Install with a package manager (requires Node.js 22.19+):

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

The archive installer verifies the GitHub Release checksum and installs into a versioned directory. See [Release archive](/getting-started/installation#release-archive) for `ATOMIC_VERSION`, `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, `GITHUB_TOKEN`/`GH_TOKEN`, default paths, and `PATH` setup.

Start Atomic in any project directory:

```bash
atomic
```

Authenticate with `/login` for a subscription provider, or export an API key such as `ANTHROPIC_API_KEY` before launching. See [Quickstart](/quickstart) for the full first-run walkthrough.

## Documentation paths

- **[Learn](/guides).** Install Atomic, complete your first session, and learn interactive commands, sessions, compaction, and providers.
- **[Build](/build).** Extend Atomic with prompt templates, skills, subagents, Intercom, codemode, extensions, and packages, or embed it through the [SDK, RPC, or JSON mode](/programmatic).
- **[Reference](/reference).** Look up CLI flags, settings, environment variables, keybindings, tools, storage, and API contracts.

### First successful session

1. [Install Atomic](/getting-started/installation).
2. [Authenticate a provider](/getting-started/authentication).
3. [Start your first session](/getting-started/first-session).
4. [Add project instructions](/getting-started/project-instructions).
5. [Learn interactive commands](/usage).
6. [Manage sessions](/sessions) and [compaction](/compaction).
