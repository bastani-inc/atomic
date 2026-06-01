---
date: 2026-03-28 19:23:24 UTC
researcher: Claude Opus 4.6
git_commit: b0ac459f0ba55f4971e03fcefc7cfe322f67e316
branch: main
repository: atomic
topic: "Reusable GHCR.io devcontainer features for copilot, opencode, and claude variants of Atomic"
tags:
    [
        research,
        codebase,
        devcontainer-features,
        ghcr,
        ci-cd,
        multi-variant,
        github-actions,
        oci,
    ]
status: complete
last_updated: 2026-03-28
last_updated_by: Claude Opus 4.6
last_updated_note: "Simplified: use stock install.sh for all features instead of per-agent config scripts"
---

# Research: Reusable GHCR.io Devcontainer Features for Multi-Variant Atomic

## Research Question

How to create reusable devcontainer features published to ghcr.io so users can plug Atomic (with their choice of copilot, opencode, or claude agent) into any existing devcontainer setup, along with a CI step for automated publishing.

## Summary

The goal is **not** standalone Docker images, but **devcontainer features** — reusable, composable OCI artifacts that users add to their existing devcontainers. A user with a Rust devcontainer should be able to add one line to get Atomic with their preferred agent:

```jsonc
// In any existing devcontainer.json
{
    "features": {
        "ghcr.io/bastani/atomic/claude:1": {},
    },
}
```

This research documents everything needed to create a **devcontainer feature collection** published to `ghcr.io/bastani/atomic/<feature-id>`, with three agent-specific features (`claude`, `opencode`, `copilot`). Each feature runs the stock `install.sh` to install the Atomic CLI and all shared dependencies/configs, then installs only its specific agent CLI. Features are published as OCI artifacts via `devcontainers/action@v1` in a GitHub Actions workflow.

### How Devcontainer Features Work

Devcontainer features are self-contained install scripts (`install.sh`) packaged as OCI artifacts. They run as root during `docker build` and can install tools, copy configs, and set environment variables. Users reference them by their GHCR OCI address in `devcontainer.json`. The devcontainer CLI resolves, downloads, and layers them on top of any base image.

Key properties:

- They work with **any** base image (Ubuntu, Debian, Alpine, language-specific images)
- They compose — users add multiple features to one devcontainer
- They are versioned with semver and published to GHCR as OCI artifacts
- Options are defined in `devcontainer-feature.json` and passed to `install.sh` as uppercase env vars

## Detailed Findings

### 1. Current State

The project has **no devcontainer features** and **no GHCR publishing pipeline**. The existing `.devcontainer/Dockerfile` is a monolithic development image that installs all three agents together. The six existing CI workflows contain no Docker or OCI publishing steps.

Current distribution channels:

- **Standalone binaries** via GitHub Releases (5 platform targets)
- **npm** package `@bastani/atomic-workflows`
- **Install scripts** (`install.sh` / `install.ps1`) that download binary + config archive

The `install.sh` script's [`sync_global_agent_configs()`](https://github.com/bastani/atomic/blob/b0ac459f0ba55f4971e03fcefc7cfe322f67e316/install.sh#L249) function (lines 249-327) is the closest prior art — it already handles per-agent config syncing and shared tool installation.

### 2. How the Three Agent Variants Differ

Each variant is defined centrally in [`src/services/config/definitions.ts:29`](https://github.com/bastani/atomic/blob/b0ac459f0ba55f4971e03fcefc7cfe322f67e316/src/services/config/definitions.ts#L29).

#### Per-Agent Install & Config Summary

|                       | Claude                                            | OpenCode                                         | Copilot                                                      |
| --------------------- | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| **CLI install**       | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://opencode.ai/install \| bash` | `curl -fsSL https://gh.io/copilot-install \| bash`           |
| **Source config dir** | `.claude/`                                        | `.opencode/`                                     | `.github/`                                                   |
| **Global config dir** | `~/.claude/`                                      | `~/.opencode/`                                   | `~/.copilot/`                                                |
| **Agents**            | `.claude/agents/*.md` (10 files)                  | `.opencode/agents/*.md` (10 files)               | `.github/agents/*.md` → `~/.copilot/agents/` (10 files)      |
| **Skills**            | `.claude/skills/*/SKILL.md` (15 dirs)             | `.opencode/skills/*/SKILL.md` (15 dirs)          | `.github/skills/*/SKILL.md` → `~/.copilot/skills/` (15 dirs) |
| **Settings file**     | `.claude/settings.json`                           | `.opencode/opencode.json`                        | N/A                                                          |
| **MCP config**        | `.mcp.json`                                       | Inline in `opencode.json`                        | `.vscode/mcp.json`                                           |
| **LSP config**        | In `settings.json`                                | N/A                                              | `.github/lsp.json` → `~/.copilot/lsp-config.json`            |
| **Auth env var**      | `ANTHROPIC_API_KEY`                               | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`           | `GH_TOKEN` / `COPILOT_GITHUB_TOKEN`                          |

Note: Copilot has an **asymmetric mapping** — source files live under `.github/` but are installed to `~/.copilot/` globally.

All three share the same 10 agent definitions and 15 skill definitions (identical markdown content, different directory locations). After global install, 4 SCM-scoped skills (`gh-commit`, `gh-create-pr`, `sl-commit`, `sl-submit-diff`) are removed from global dirs.

#### Shared Dependencies (All Agents)

From the existing [`.devcontainer/Dockerfile`](https://github.com/bastani/atomic/blob/b0ac459f0ba55f4971e03fcefc7cfe322f67e316/.devcontainer/Dockerfile) and [`install.sh`](https://github.com/bastani/atomic/blob/b0ac459f0ba55f4971e03fcefc7cfe322f67e316/install.sh):

| Tool                 | Source             | Purpose                                     |
| -------------------- | ------------------ | ------------------------------------------- |
| Node.js + npm        | `Dockerfile:4`     | Runtime for agent CLIs                      |
| Bun                  | `Dockerfile:8-9`   | Primary JS runtime for Atomic               |
| uv                   | `Dockerfile:11`    | Python package installer for cocoindex-code |
| cocoindex-code       | `Dockerfile:25-29` | Semantic code search (`ccc search`)         |
| Embedding model      | `Dockerfile:31-32` | Pre-baked ~200MB model for cocoindex-code   |
| @playwright/cli      | `Dockerfile:35`    | Browser automation for agents               |
| tmux                 | `Dockerfile:4`     | Terminal multiplexer for debugging          |
| SSH agent forwarding | `Dockerfile:15-21` | Persistent SSH agent across tmux sessions   |

### 3. Devcontainer Features Specification

**References**: [Feature spec](https://containers.dev/implementors/features/), [Distribution spec](https://containers.dev/implementors/features-distribution/), [devcontainers/feature-starter](https://github.com/devcontainers/feature-starter)

#### Key Concepts

- Each feature is a directory containing `devcontainer-feature.json` + `install.sh`
- Options defined in `devcontainer-feature.json` become **uppercase env vars** in `install.sh` (e.g., option `version` → `$VERSION`)
- Built-in env vars: `$_REMOTE_USER`, `$_REMOTE_USER_HOME`, `$_CONTAINER_USER`, `$_CONTAINER_USER_HOME`
- `installsAfter` controls ordering (not hard dependencies)
- Publishing via `devcontainers/action@v1` → pushes OCI artifacts to `ghcr.io/<owner>/<repo>/<feature-id>` with semver tags (`:1`, `:1.0`, `:1.0.0`)
- Features are **private by default** on GHCR — must manually set to public after first publish

### 4. Proposed Feature Design

#### Simplified approach: Stock `install.sh` + agent CLI

Each agent feature does two things:

1. Runs the **stock Atomic `install.sh`** — installs the Atomic CLI binary, all shared dependencies (bun, uv, cocoindex-code, playwright-cli), and all three agent configs globally. Extra configs from other agents are harmless.
2. Installs the **specific agent CLI** (claude, opencode, or copilot).

This eliminates the need for a separate `atomic-base` feature, per-agent `configs/` directories, and config syncing scripts. The stock `install.sh` already handles everything.

#### Repository Structure

Features live inside the existing repo under `src/devcontainer/`:

```
src/devcontainer/
├── claude/
│   ├── devcontainer-feature.json
│   └── install.sh
├── opencode/
│   ├── devcontainer-feature.json
│   └── install.sh
└── copilot/
    ├── devcontainer-feature.json
    └── install.sh
```

Each feature becomes a separate OCI package:

- `ghcr.io/bastani/atomic/claude:1`
- `ghcr.io/bastani/atomic/opencode:1`
- `ghcr.io/bastani/atomic/copilot:1`

#### Feature 1: `claude` (Claude Code agent)

**`src/claude/devcontainer-feature.json`**:

```json
{
    "id": "claude",
    "version": "0.4.44",
    "name": "Atomic + Claude Code",
    "description": "Installs Atomic CLI with Claude Code agent, skills, and shared tooling (bun, cocoindex-code, playwright)",
    "documentationURL": "https://github.com/bastani/atomic",
    "containerEnv": {
        "COCOINDEX_CODE_DB_PATH_MAPPING": "/workspaces=/tmp/cocoindex-db"
    },
    "installsAfter": ["ghcr.io/devcontainers/features/common-utils"]
}
```

**Version**: The `version` field in each `devcontainer-feature.json` must match the main `package.json` version (currently `0.4.44`). The publish workflow reads the version from `package.json` and writes it into each feature's JSON before publishing.

**`src/claude/install.sh`**:

```bash
#!/usr/bin/env bash
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo 'Script must be run as root.' >&2
    exit 1
fi

# ─── Install Atomic CLI + all shared deps/configs via stock installer ────────
curl -fsSL https://raw.githubusercontent.com/bastani/atomic/main/install.sh | bash

# ─── Install Claude Code CLI ────────────────────────────────────────────────
curl -fsSL https://claude.ai/install.sh | bash

echo "Atomic + Claude Code installed successfully."
```

#### Feature 2: `opencode` (OpenCode agent)

**`src/opencode/devcontainer-feature.json`**:

```json
{
    "id": "opencode",
    "version": "0.4.44",
    "name": "Atomic + OpenCode",
    "description": "Installs Atomic CLI with OpenCode agent, skills, and shared tooling (bun, cocoindex-code, playwright)",
    "documentationURL": "https://github.com/bastani/atomic",
    "containerEnv": {
        "COCOINDEX_CODE_DB_PATH_MAPPING": "/workspaces=/tmp/cocoindex-db"
    },
    "installsAfter": ["ghcr.io/devcontainers/features/common-utils"]
}
```

**`src/opencode/install.sh`**:

```bash
#!/usr/bin/env bash
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo 'Script must be run as root.' >&2
    exit 1
fi

# ─── Install Atomic CLI + all shared deps/configs via stock installer ────────
curl -fsSL https://raw.githubusercontent.com/bastani/atomic/main/install.sh | bash

# ─── Install OpenCode CLI ───────────────────────────────────────────────────
curl -fsSL https://opencode.ai/install | bash

echo "Atomic + OpenCode installed successfully."
```

#### Feature 3: `copilot` (Copilot CLI agent)

**`src/copilot/devcontainer-feature.json`**:

```json
{
    "id": "copilot",
    "version": "0.4.44",
    "name": "Atomic + Copilot CLI",
    "description": "Installs Atomic CLI with GitHub Copilot agent, skills, and shared tooling (bun, cocoindex-code, playwright)",
    "documentationURL": "https://github.com/bastani/atomic",
    "containerEnv": {
        "COCOINDEX_CODE_DB_PATH_MAPPING": "/workspaces=/tmp/cocoindex-db"
    },
    "installsAfter": [
        "ghcr.io/devcontainers/features/common-utils",
        "ghcr.io/devcontainers/features/github-cli"
    ]
}
```

**`src/copilot/install.sh`**:

```bash
#!/usr/bin/env bash
set -e

if [ "$(id -u)" -ne 0 ]; then
    echo 'Script must be run as root.' >&2
    exit 1
fi

# ─── Install Atomic CLI + all shared deps/configs via stock installer ────────
curl -fsSL https://raw.githubusercontent.com/bastani/atomic/main/install.sh | bash

# ─── Install Copilot CLI ────────────────────────────────────────────────────
curl -fsSL https://gh.io/copilot-install | bash

echo "Atomic + Copilot CLI installed successfully."
```

### 5. User Experience

Users add a **single feature** to get Atomic + their chosen agent. No `atomic-base` needed — the stock `install.sh` handles all shared deps.

#### Example: Adding Atomic + Claude to a Rust devcontainer

```jsonc
// .devcontainer/devcontainer.json (user's Rust project)
{
    "image": "mcr.microsoft.com/devcontainers/rust:latest",
    "features": {
        "ghcr.io/bastani/atomic/claude:1": {},
    },
    "remoteEnv": {
        "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}",
    },
}
```

#### Example: Adding Atomic + Copilot to a Python devcontainer

```jsonc
{
    "image": "mcr.microsoft.com/devcontainers/python:3.12",
    "features": {
        "ghcr.io/devcontainers/features/github-cli:1": {},
        "ghcr.io/bastani/atomic/copilot:1": {},
    },
    "remoteEnv": {
        "GH_TOKEN": "${localEnv:GH_TOKEN}",
    },
}
```

#### Example: Adding Atomic + OpenCode to a Go devcontainer

```jsonc
{
    "image": "mcr.microsoft.com/devcontainers/go:1.22",
    "features": {
        "ghcr.io/bastani/atomic/opencode:1": {},
    },
}
```

### 6. CI Workflow

#### Publish Workflow: `.github/workflows/publish-features.yml`

```yaml
name: Publish Devcontainer Features

on:
    workflow_dispatch:
    push:
        branches: [main]
        paths:
            - "src/devcontainer/**"

jobs:
    publish:
        if: github.ref == 'refs/heads/main'
        runs-on: ubuntu-latest
        permissions:
            contents: write
            packages: write
        steps:
            - uses: actions/checkout@v6

            - name: Sync feature versions from package.json
              run: |
                  VERSION=$(jq -r .version package.json)
                  for feature in src/devcontainer/*/devcontainer-feature.json; do
                    jq --arg v "$VERSION" '.version = $v' "$feature" > tmp.json && mv tmp.json "$feature"
                  done

            - name: Publish Features
              uses: devcontainers/action@v1
              with:
                  publish-features: "true"
                  base-path-to-features: "./src/devcontainer"
              env:
                  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### Authentication

Uses `GITHUB_TOKEN` (auto-provisioned). Required permissions:

- `packages: write` — push OCI artifacts to GHCR
- `contents: write` — create tags
- `pull-requests: write` — create docs PRs (optional)

**Post-publish**: Features are **private by default** on GHCR. After first publish, go to `https://github.com/users/flora131/packages/container/atomic%2F<feature-id>/settings` and set visibility to **public** for each feature.

### 8. Mono-Repo vs Separate Repo

**Option A: Features in the Atomic repo (mono-repo)** — Feature source lives under `src/` in the existing `bastani/atomic` repo. Config files are already here. Simpler to keep configs in sync.

**Option B: Separate features repo** — A new `bastani/atomic-devcontainer-features` repo. Cleaner separation of concerns. Standard pattern used by `devcontainers/features` and community repos.

**Recommendation**: Option A (mono-repo) is simpler to start. The publish workflow can target a subdirectory. If the feature source grows large, extract to a separate repo later.

However, note that `devcontainers/action@v1` publishes features to `ghcr.io/<owner>/<repo>/<feature-id>`. If features live in the `atomic` repo, references would be `ghcr.io/bastani/atomic/claude:1`. If in a separate repo `atomic-features`, they'd be `ghcr.io/bastani/atomic-features/claude:1`.

## Code References

- `.devcontainer/Dockerfile` — Existing monolithic devcontainer (all agents)
- `.devcontainer/devcontainer.json:7` — Already uses `ghcr.io/devcontainers/features/github-cli:1`
- `install.sh:249-327` — `sync_global_agent_configs()` — per-agent config sync logic to extract
- `install.sh:253-262` — Per-agent directory creation and copy commands
- `install.sh:265-267` — SCM-scoped skill removal (`gh-*`, `sl-*`)
- `install.sh:274-289` — cocoindex-code installation
- `install.sh:319-326` — @playwright/cli installation
- `src/services/config/definitions.ts:29` — `AGENT_CONFIG` central registry
- `src/services/config/definitions.ts:37-87` — Per-agent config exclusions and onboarding files
- `src/services/config/atomic-global-config.ts:34-42` — `GLOBAL_SYNC_FILES` (lsp.json → lsp-config.json for Copilot)
- `.claude/agents/` — 10 agent definitions
- `.claude/skills/` — 15 skill directories (13 global + 4 SCM-scoped)
- `.opencode/agents/` — 10 agent definitions
- `.opencode/skills/` — 15 skill directories
- `.github/agents/` — 10 agent definitions (Copilot source)
- `.github/skills/` — 15 skill directories (Copilot source)
- `.github/lsp.json` — 11 LSP server configs for Copilot

## Architecture Documentation

### Current Distribution Architecture

```
                    ┌─────────────────┐
                    │  GitHub Release  │
                    │   (publish.yml)  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───────┐  ┌──▼──────────┐  ┌▼───────────────┐
     │  Binary Assets  │  │ Config Tars │  │  npm Package   │
     │  (5 platforms)  │  │ .tar.gz/.zip│  │  @bastani/     │
     └────────┬───────┘  └──┬──────────┘  │  atomic-       │
              │              │              │  workflows     │
              └──────┬───────┘              └───────────────┘
                     │
          ┌──────────▼──────────┐
          │    install.sh /     │
          │    install.ps1      │
          │  installs ALL 3     │
          │  agent configs      │
          └─────────────────────┘
```

### Proposed Architecture (with Devcontainer Features)

```
  ┌─────────────────┐       ┌───────────────────────────────────────┐
  │  GitHub Release  │       │  GHCR.io (OCI Artifacts)              │
  │   (publish.yml)  │       │  (publish-features.yml)               │
  └────────┬────────┘       └───────────────────┬───────────────────┘
           │                                    │
  ┌────────┼──────────┐             ┌───────────┼───────────┐
  │        │          │             │           │           │
  ▼        ▼          ▼             ▼           ▼           ▼
Binaries  Configs    npm         claude      opencode    copilot
(5 plat)  .tar.gz    pkg       (install.sh  (install.sh (install.sh
                                + claude     + opencode  + copilot
                                  CLI)         CLI)        CLI)

  Each feature runs stock install.sh → installs Atomic + all deps/configs
  Then installs only its specific agent CLI

  User's devcontainer.json:
  ┌──────────────────────────────────────────────────────┐
  │ {                                                     │
  │   "image": "mcr.microsoft.com/devcontainers/rust",   │
  │   "features": {                                       │
  │     "ghcr.io/bastani/atomic/claude:1": {}            │
  │   }                                                   │
  │ }                                                     │
  └──────────────────────────────────────────────────────┘
```

## Historical Context (from research/)

- `research/docs/2026-01-21-binary-distribution-installers.md` — Original binary distribution research. Docker-based distribution was **rejected** at the time (`specs/2026-01-21-binary-distribution-installers.md:380`), but devcontainer features are a different mechanism — they augment existing containers rather than replacing them.
- `research/docs/2026-02-25-install-postinstall-analysis.md` — Installation infrastructure analysis. The `sync_global_agent_configs()` function is the direct basis for the feature install scripts.
- `research/docs/2026-02-25-global-config-sync-mechanism.md` — Global config sync documentation. Directly informs how agent configs should be deployed in features.
- `research/docs/2026-03-04-claude-sdk-discovery-and-atomic-config-sync.md` — Three-tier discovery hierarchy. Features install to the "userGlobal" tier (`~/.claude/`, `~/.opencode/`, `~/.copilot/`).

## Related Research

- `research/docs/2026-03-28-devcontainer-features-publishing-research.md` — Companion document with deep dive on devcontainer feature spec, testing, and publishing patterns
- `research/docs/2026-01-21-binary-distribution-installers.md` — Prior art (binary distribution channel)
- `research/docs/2026-01-20-cross-platform-support.md` — Cross-platform analysis

## Open Questions

1. **Mono-repo vs separate repo**: Should features live in `bastani/atomic` (refs become `ghcr.io/bastani/atomic/claude:1`) or a separate `bastani/atomic-features` repo (`ghcr.io/bastani/atomic-features/claude:1`)?

2. **Existing devcontainer**: Should `.devcontainer/Dockerfile` be refactored to consume these features instead of inline installs? This would dogfood the features in Atomic's own development.

3. **Alpine/RHEL support**: The stock `install.sh` targets Debian/Ubuntu. Should features include OS detection for Alpine (`apk`) and RHEL (`dnf`) base images, or is Debian/Ubuntu sufficient for the devcontainer use case?

4. **GHCR visibility**: After first publish, each feature package must be manually set to public. Should the publish workflow include a `gh api` call to automate this?

5. **Duplicate installs**: If a user adds both `claude:1` and `copilot:1` features, the stock `install.sh` runs twice. The installer's idempotent checks (`install_bun_if_missing`, etc.) mitigate this, but it's wasted build time. Acceptable for now given the simplicity benefit.
