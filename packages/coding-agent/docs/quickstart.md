---
title: "Quickstart"
description: "Install Atomic, authenticate a provider, run your first session, and add project instructions."
---

# Quickstart

**Outcome:** Atomic is installed, authenticated, and has completed a real task in your repository.

## Onboarding path

Follow these four pages in order for full setup instructions, or use the quick commands below:

1. **[Install Atomic](/getting-started/installation).** Choose a package manager or the self-contained release archive.
2. **[Authenticate](/getting-started/authentication).** Sign in with a subscription (`/login`) or export an API key.
3. **[Run your first session](/getting-started/first-session).** Complete a task, inspect tool calls, and delegate work to subagents.
4. **[Add project instructions](/getting-started/project-instructions).** Define repository conventions in `AGENTS.md`.

## Prerequisites

- **Package install:** Node.js 22.19 or newer plus npm, pnpm, Yarn, or Bun (1.4.2+ for Bun installs).
- **Release archive install:** macOS and Linux need `tar` and either `curl` or `wget`; Windows uses built-in PowerShell commands. This path does not need Node.js or a package manager.
- **Model provider:** a supported subscription login (`/login`) or API key.

## Install

<a id="package-managers" />
<a id="release-archive" />
<a id="atomic_version" />
<a id="atomic_install_dir" />
<a id="atomic_bin_dir" />
<a id="github_token-/-gh_token" />
<a id="which-runtime-runs-your-workflows" />
<a id="which-runtime-runs-atomic" />
<a id="alpine-and-musl-linux-archives" />
<a id="uninstall" />

Install with npm (or pnpm / Bun):

```bash
npm install -g @bastani/atomic
```

Or install the self-contained release archive (no Node.js required):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
```

Verify the install:

```bash
atomic --version
```

See [Installation](/getting-started/installation#install) for [package managers](/getting-started/installation#package-managers), [release archive options](/getting-started/installation#release-archive) (`ATOMIC_VERSION`, `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, `GITHUB_TOKEN`/`GH_TOKEN`, `--force`/`-Force`/`ATOMIC_FORCE_INSTALL=1`, Alpine/musl archives, portable Git), and [uninstalling](/getting-started/installation#uninstall).

## Authenticate

<a id="option-1-subscription-login" />
<a id="option-2-api-key" />

Either log in with a subscription inside Atomic:

```bash
atomic
/login
```

Or export an API key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

See [Authentication](/getting-started/authentication#authenticate) for all options and verification steps.

## First session

<a id="try-the-built-in-workflows" />
<a id="use-an-earlier-workflow" />
<a id="monitor-and-steer-a-run" />
<a id="top-skills-to-invoke-directly" />
<a id="create-your-own-workflow-in-natural-language" />
<a id="describe-a-reusable-procedure" />
<a id="default-tools-and-prompts" />

Start Atomic inside a repository and ask it to inspect the project:

```bash
cd /path/to/project
atomic
```

```text
List the top-level directories in this repository and say what each one holds.
```

- Use `/tasks` to inspect background subagents and shells.
- Use `/skill:<name>` to invoke a reusable skill directly. See [Top skills](/getting-started/first-session#top-skills-to-invoke-directly).
- Workflows are now skills. Give Atomic an older workflow file to convert it into a skill, or see [Migrating workflows](/orchestration/migrating-workflows) and [Delegate a larger task](/getting-started/first-session#delegate-a-larger-task).
- See [First session](/getting-started/first-session#first-session-2) for the full walkthrough and [default tools](/getting-started/first-session#default-tools-and-prompts).

## Give Atomic project instructions

Add an `AGENTS.md` file at the root of your repository so Atomic follows your test commands and coding conventions automatically. Run `/reload` after editing it. See [Project instructions](/getting-started/project-instructions#give-atomic-project-instructions).

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search project files, or pass `@file` arguments on the CLI:

```bash
atomic @README.md "Summarize this"
atomic @src/app.ts @src/app.test.ts "Review these together"
```

Paste images with `Cmd+V` on macOS, `Ctrl+V` on Linux or inside tmux on macOS, and `Alt+V` or `Ctrl+V` on Windows. You can also drag images into supported terminals. When the clipboard holds both text and an image, `Ctrl+V` prefers the image; `Cmd+V` depends on the terminal.

### Run shell commands

Prefix a command in the editor with `!` to run it and attach its output to the model context, or `!!` to run it without sending output to the model:

```text
!bun run lint
```

### Switch models

- `/model` or `Ctrl+L`: pick a model.
- `Shift+Tab`: cycle the thinking level.
- `Ctrl+P`: cycle forward through scoped models.
- `Shift+Ctrl+P` (`Alt+P` on Windows and WSL): cycle backward through scoped models.

### Continue later

Sessions auto-save per working directory:

```bash
atomic -c                    # Continue the most recent session
atomic -r                    # Pick a previous session
atomic --name "my task"      # Set a display name at startup
atomic --session <id|prefix> # Open by exact ID or unique 8-hex UUID prefix
atomic --import <file>       # Import a format-4 JSONL export
```

Inside interactive mode, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone`.

### Non-interactive mode

Run one-shot prompts with `-p` (`--print`):

```bash
atomic -p "Summarize this codebase"
cat README.md | atomic -p "Summarize this text"
atomic -p @screenshot.png "What's in this image?"
```

Use `--mode json` for a JSON event stream or `--mode rpc` for stdin/stdout process integration.

## Next steps

- **[Interactive use](/usage).** Learn slash commands, shortcuts, and message queueing.
- **[Orchestration](/orchestration).** Combine codemode, subagents, and skills for multi-step work.
- **[Skills](/skills).** Run reusable procedures with `/skill:<name>`.
- **[Providers](/providers).** Configure provider logins, API keys, and cloud endpoints.
- **[Settings](/settings).** Configure global and project preferences.
- **[Keybindings](/keybindings).** Review default shortcuts and remap keys.
- **[Atomic packages](/packages).** Install shared extensions, skills, prompts, and themes.
- **[Security](/security).** Read project trust, tool permissions, and vulnerability reporting rules before trusting a project or installing third-party packages.
- **[Containerization](/containerization).** Run Atomic in an isolated environment.

Platform guides: [Windows](/windows), [Termux](/termux), [tmux](/tmux), [Terminal setup](/terminal-setup), and [Shell aliases](/shell-aliases).
