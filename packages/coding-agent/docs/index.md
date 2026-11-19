---
title: "Overview"
description: "Atomic documentation overview"
---

# Atomic Documentation

Atomic is a terminal coding-agent runtime for repeatable, inspectable engineering work. Extend its small core with TypeScript extensions, skills, prompt templates, themes, codemode, subagents, MCP, web access, and Atomic packages.

## Quick start

Install the published package globally with npm:

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

Package installation requires Node.js. Atomic does not require package install scripts; add `--ignore-scripts` if you want to disable dependency lifecycle scripts during a package install.

Alternatively, install the self-contained release archive, which needs no Node.js or package manager.

On macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

The archive installer verifies the GitHub Release checksum and installs the full payload under a versioned root. See the [Quickstart](/getting-started/installation#release-archive) for its parameters (`ATOMIC_VERSION`, `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, `GITHUB_TOKEN`/`GH_TOKEN`), default paths, and PATH guidance.

Then run it in a project directory:

```bash
atomic
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Atomic.

For the full first-run flow, see [Quickstart](/quickstart).

## Documentation paths

Choose a documentation path based on what you want to do.

- **[Learn](/guides)** — install Atomic, run a first session, and get good at everyday use. Start with the [Quickstart](/quickstart) if you have never run Atomic, then read the [Guides](/guides).
- **[Build](/build)** — extend Atomic with prompt templates, skills, subagents, Intercom, codemode, extensions, and packages, or embed it with [programmatic use](/programmatic).
- **[Reference](/reference)** — look up an exact command, flag, setting, event, method, type, or tool contract.

### First successful session

1. [Install Atomic](/getting-started/installation).
2. [Authenticate a provider](/getting-started/authentication).
3. [Start your first session](/getting-started/first-session).
4. [Add project instructions](/getting-started/project-instructions).
5. [Learn the interactive commands](/usage).
6. [Learn sessions](/sessions) and [context management](/compaction).
