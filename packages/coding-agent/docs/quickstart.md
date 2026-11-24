---
title: "Quickstart"
sidebarTitle: "Quickstart"
description: "Install Atomic, authenticate a model provider, run your first session, and add project instructions."
---

**Outcome:** Atomic is installed, authenticated, and has completed a real task in your repository.

## Onboarding path

Follow these four pages in order for full setup instructions, or use the quick commands below:

1. **[Install Atomic](/getting-started/installation).** Choose a package manager or the self-contained release archive.
2. **[Authenticate a provider](/getting-started/authentication).** Sign in with a subscription (`/login`) or export an API key.
3. **[Run your first session](/getting-started/first-session).** Complete a task, inspect tool calls, and delegate work to subagents.
4. **[Add project instructions](/getting-started/project-instructions).** Define repository conventions in `AGENTS.md`.

## Prerequisites

- **Package install:** Node.js 22.19 or newer with npm or pnpm, or Bun 1.4.2+ for Bun installs.
- **Release archive install:** macOS and Linux need `tar` and either `curl` or `wget`; Windows uses built-in PowerShell commands. This path does not need Node.js or a package manager.
- **Model provider:** A supported subscription login (`/login`) or API key.

## Install

Install with npm, pnpm, or Bun:

```bash
npm install -g @bastani/atomic
# or: pnpm add -g @bastani/atomic
# or: bun add -g @bastani/atomic
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

See [Install Atomic](/getting-started/installation) for [package manager details](/getting-started/installation#package-managers), [release archive options](/getting-started/installation#release-archive), and [uninstalling](/getting-started/installation#uninstall).

## Authenticate

Sign in with a subscription inside Atomic or from your shell:

```bash
atomic
/login
```

```bash
# Or sign in directly from the shell
atomic auth login anthropic
```

Or export an API key before starting:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

See [Authenticate a provider](/getting-started/authentication) for all options and verification steps.

## First session

Start Atomic inside a repository and ask it to inspect the project:

```bash
cd /path/to/project
atomic
```

```text
List the top-level directories in this repository and say what each one holds.
```

- Use `/tasks` to inspect background subagents and shells.
- Use `/skill:<name>` to run a reusable skill directly. See [Top skills to invoke directly](/getting-started/first-session#top-skills-to-invoke-directly).
- Ask Atomic to split independent work across subagents. See [Delegate a larger task](/getting-started/first-session#delegate-a-larger-task).
- See [Run your first session](/getting-started/first-session) for the full walkthrough and [default tools](/getting-started/first-session#default-tools-and-prompts).

## Add project instructions

Add an `AGENTS.md` file at the root of your repository so Atomic follows your test commands and coding conventions automatically. Run `/reload` after editing it. See [Add project instructions](/getting-started/project-instructions).

## Try common workflows

### Reference files

Type `@` in the editor to fuzzy-search project files, or pass `@file` arguments on the CLI:

```bash
atomic @README.md "Summarize this"
atomic @src/app.ts @src/app.test.ts "Review these together"
```

`@file` paths expand `~`, resolve relative to the current directory, skip empty (0-byte) files, and exit `1` if a file is missing.

Paste images with `Cmd+V` on macOS, `Ctrl+V` on Linux or inside tmux on macOS, and `Alt+V` or `Ctrl+V` on Windows and WSL. You can also drag images into supported terminals. When the clipboard holds both text and an image, `Ctrl+V` prefers the image; `Cmd+V` depends on the terminal.

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
atomic --import <file>       # Import an exported JSONL session
```

`atomic --session` exits with code `75` if another live Atomic process holds that session open. Inside interactive mode, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone`.

### Non-interactive mode

Run one-shot prompts with `-p` (`--print`), or pipe input into `atomic` (non-TTY stdin or stdout enters print mode automatically):

```bash
atomic -p "Summarize this codebase"
cat README.md | atomic -p "Summarize this text"
atomic -p @screenshot.png "What's in this image?"
```

Piped stdin is separated from CLI prompt text by a newline. Use `--mode json` for a JSON event stream or `--mode rpc` for stdin/stdout process integration.

## Next steps

- **[Interactive mode](/usage).** Learn slash commands, shortcuts, and message queueing.
- **[Orchestration](/orchestration).** Combine codemode, subagents, and skills for multi-step work.
- **[Skills](/skills).** Run reusable procedures with `/skill:<name>`.
- **[Providers](/providers).** Configure provider logins, API keys, and cloud endpoints.
- **[Settings](/settings).** Configure global and project preferences.
- **[Keybindings](/keybindings).** Review default shortcuts and remap keys.
- **[Atomic packages](/packages).** Install shared extensions, skills, prompts, and themes.
- **[Security](/security).** Read project trust, tool permissions, and credential export rules before trusting a project or installing third-party packages.
- **[Containerization](/containerization).** Run Atomic inside a container or sandbox.

Platform guides: [Windows](/windows), [Termux](/termux), [tmux](/tmux), [Terminal setup](/terminal-setup), and [Shell aliases](/shell-aliases).
