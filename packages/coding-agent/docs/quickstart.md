# Quickstart

**Outcome:** Atomic is installed, authenticated, and has completed one useful task in your repository.

Follow the steps below to install Atomic and complete your first useful session. Atomic runs coding-agent loops with stages, tools, artifacts, verification, subagents, review gates, checkpoints, and human approvals for engineering work.

Work through the steps in order. Each links to a focused page with full instructions.

## Onboarding path

1. **[Install Atomic](/getting-started/installation)** — package manager or self-contained release archive.
2. **[Authenticate](/getting-started/authentication)** — subscription login or API key.
3. **[Run your first session](/getting-started/first-session)** — start Atomic, run a task, invoke a built-in workflow, and steer the run.
4. **[Add project instructions](/getting-started/project-instructions)** — teach Atomic your repository's conventions with `AGENTS.md`.

Then come back here for [common things to try](#common-things-to-try) and [next steps](#next-steps).

## Prerequisites

- **Package install:** Node.js 22.19 or newer plus npm, pnpm, Yarn, or Bun. Use Bun 1.4.2+ for Bun installs or workflow-authoring examples.
- **Release archive install:** macOS and Linux need `tar` and either `curl` or `wget`; Windows uses built-in PowerShell commands. This path does not need Node.js or a package manager.
- **Model-provider access** — use a supported subscription login or API key. Run `/login` after startup.

## Install

The install commands and every installer knob, default path, and platform note now live on the installation page.

Moved to [Installation](/getting-started/installation#install).

### Package managers

Moved to [Installation](/getting-started/installation#package-managers).

Full detail: package manager commands and the `--ignore-scripts` note.

### Release archive

Moved to [Installation](/getting-started/installation#release-archive).

Full detail: version pinning, `ATOMIC_VERSION`, `ATOMIC_INSTALL_DIR`, `ATOMIC_BIN_DIR`, `GITHUB_TOKEN`/`GH_TOKEN`, default paths, and PATH guidance. It also describes what the installer prints: the release and platform, a live download progress bar, one-line phase confirmations, the Atomic logo, and a `To start:` block, or plain text when `NO_COLOR=1` is set, `CI` is set, or output is not a terminal.

#### ATOMIC_VERSION

Moved to [Installation](/getting-started/installation#atomic_version).

#### ATOMIC_INSTALL_DIR

Moved to [Installation](/getting-started/installation#atomic_install_dir).

#### ATOMIC_BIN_DIR

Moved to [Installation](/getting-started/installation#atomic_bin_dir).

#### GITHUB_TOKEN / GH_TOKEN

Moved to [Installation](/getting-started/installation#github_token-/-gh_token).

### Which runtime runs your workflows

Moved to [Installation](/getting-started/installation#which-runtime-runs-your-workflows).

### Alpine and musl Linux archives

Moved to [Installation](/getting-started/installation#alpine-and-musl-linux-archives).

## Uninstall

Moved to [Installation](/getting-started/installation#uninstall).

Full detail: removing the install root, the launcher, and the PATH entry on every platform.

## Authenticate

Moved to [Authentication](/getting-started/authentication#authenticate).

Full detail: `/login` subscription providers and API-key environment variables.

### Option 1: subscription login

Moved to [Authentication](/getting-started/authentication#option-1-subscription-login).

### Option 2: API key

Moved to [Authentication](/getting-started/authentication#option-2-api-key).

## First session

Moved to [First session](/getting-started/first-session#first-session-2).

Full detail: starting Atomic, the built-in workflows, monitoring and steering a run, top skills, creating a workflow in natural language, and the default tools and prompts.

### Try the built-in workflows

Moved to [First session](/getting-started/first-session#try-the-built-in-workflows).

### Monitor and steer a run

Moved to [First session](/getting-started/first-session#monitor-and-steer-a-run).

### Top skills to invoke directly

Moved to [First session](/getting-started/first-session#top-skills-to-invoke-directly).

### Create your own workflow in natural language

Moved to [First session](/getting-started/first-session#create-your-own-workflow-in-natural-language).

### Default tools and prompts

Moved to [First session](/getting-started/first-session#default-tools-and-prompts).

## Give Atomic project instructions

Moved to [Project instructions](/getting-started/project-instructions#give-atomic-project-instructions).

Full detail: `AGENTS.md` discovery, precedence, and what to put in it.

## Common things to try

### Reference files

Type `@` in any interactive editor to fuzzy-search files; or pass files on the command line:

```bash
atomic @README.md "Summarize this"
atomic @src/app.ts @src/app.test.ts "Review these together"
```

Paste images with native macOS Cmd+V or Ctrl+V. On Windows, use Alt+V instead of Ctrl+V. You can also drag images into supported terminals.

Inside tmux on macOS, use `Ctrl+V` for reliable image paste. Native `Cmd+V` depends on your terminal and may not work through tmux.

When the clipboard contains both text and an image, Ctrl+V prefers the image. Cmd+V may paste either, depending on how the terminal delivers the gesture.

### Run shell commands

In interactive mode:

```text
!bun run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or CTRL+L to choose a model. Use SHIFT+Tab to cycle thinking level. Use CTRL+P / SHIFT+CTRL+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
atomic -c                  # Continue most recent session
atomic -r                  # Browse previous sessions
atomic --name "my task"    # Set session display name at startup
atomic --session <path|id> # Open a specific session
```

Inside Atomic, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
atomic -p "Summarize this codebase"
cat README.md | atomic -p "Summarize this text"
atomic -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Atomic](/usage) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Workflows](/workflows) - run, inspect, and author multi-stage automation (including the built-in workflows).
- [Skills](/skills) - reusable expert instructions invoked with `/skill:<name>`.
- [Providers](/providers) - authentication and model setup.
- [Settings](/settings) - global and project configuration.
- [Keybindings](/keybindings) - shortcuts and customization.
- [Atomic Packages](/packages) - install shared extensions, skills, prompts, and themes.
- [Security](/security) - project trust, what Atomic is allowed to touch, and how to report a vulnerability. Read this before you trust a project or install someone else's skills, extensions, or packages.
- [Containerization](/containerization) - run Atomic or its tools inside an isolated environment.

Platform notes: [Windows](/windows), [Termux](/termux), [tmux](/tmux), [Terminal setup](/terminal-setup), [Shell aliases](/shell-aliases).
