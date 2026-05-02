# Developer Setup

## Prerequisites

- [Bun](https://bun.sh/) (latest)
- [Docker](https://docs.docker.com/get-docker/) (Docker Desktop or Docker Engine)
- [Dev Container CLI](https://github.com/devcontainers/cli) — install via Bun:
  ```bash
  bun install -g @devcontainers/cli
  ```
- Git

## Environment Variables

The devcontainer forwards the following environment variables from your host. Set them before building:

| Variable            | Purpose                   |
| ------------------- | ------------------------- |
| `GH_TOKEN`          | GitHub CLI authentication |
| `ANTHROPIC_API_KEY` | Claude agent SDK access   |

Add them to your shell profile (e.g. `~/.zshrc`, `~/.bashrc`) or export them in the current session:

**macOS / Linux:**

```bash
export GH_TOKEN="ghp_..."
export ANTHROPIC_API_KEY="sk-ant-..."
```

**Windows (PowerShell):**

```powershell
$env:GH_TOKEN = "ghp_..."
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

Alternatively, you can skip setting keys and log in interactively inside the container using each tool's `/login` command in the respective coding agent CLI.

## Getting Started

### 1. Build and start the container

```bash
devcontainer up --workspace-folder .
```

This builds the image defined in `.devcontainer/Dockerfile` (Ubuntu 24.04 base) and installs:

- **Bun** — JS/TS runtime
- **OpenCode CLI** — OpenCode agent
- **Claude CLI** — Claude agent
- **Copilot CLI** — GitHub Copilot agent
- **GitHub CLI** — via devcontainer feature
- **Playwright CLI** — browser automation

After the container starts, `bun install` runs automatically via `postCreateCommand`.

### 2. Open a shell inside the container

```bash
devcontainer exec --workspace-folder . bash
```

You are now inside the container as the `vscode` user with all tools on `$PATH`.

### 3. Verify the setup

```bash
bun test
```

## Development Commands

Run these inside the container:

| Command             | Description                             |
| ------------------- | --------------------------------------- |
| `bun test`          | Run all tests with coverage             |
| `bun test --bail`   | Stop on first failure                   |
| `bun run typecheck` | TypeScript type checking                |
| `bun run lint`      | Run oxlint + sub-module boundary checks |
| `bun run lint:fix`  | Auto-fix linting issues                 |
| `bun run dev`       | Run CLI in development mode             |

## Workflow UI Diagnostics

Set `ATOMIC_TUI_DIAGNOSTICS=1` when reproducing workflow graph rendering
issues. The orchestrator writes JSON frame-buffer snapshots that include
terminal capabilities, workflow state, and background-color counts.

```bash
ATOMIC_TUI_DIAGNOSTICS=1 \
ATOMIC_TUI_DIAGNOSTICS_DIR=/tmp/atomic-tui-diagnostics \
bun run examples/hello-world/claude-worker.ts --greeting="Hello" --style=casual
```

Optional tuning:

| Variable | Purpose |
| --- | --- |
| `ATOMIC_TUI_DIAGNOSTICS_DIR` | Output directory; defaults to a temp directory |
| `ATOMIC_TUI_DIAGNOSTICS_INTERVAL_MS` | Snapshot interval in milliseconds |
| `ATOMIC_TUI_DIAGNOSTICS_MAX` | Maximum number of snapshots |
| `ATOMIC_TUI_DIAGNOSTICS_OPENTUI_DUMP=1` | Also call OpenTUI's native buffer/stdout dump hooks |

## Quick Reference

```bash
# Full lifecycle
devcontainer up --workspace-folder .          # build & start
devcontainer exec --workspace-folder . bash   # open shell
bun test                                      # verify
bun run dev                                   # develop

# Rebuild after Dockerfile changes
devcontainer up --workspace-folder . --rebuild
```
