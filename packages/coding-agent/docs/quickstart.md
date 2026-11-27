---
title: "Quickstart"
sidebarTitle: "Quickstart"
description: "Install Atomic, authenticate a model provider, run your first session, and add project instructions."
---

**Outcome:** Atomic is installed, connected to a model provider, and has completed a real task in your repository.

## Prerequisites

- **Package-manager install:** [Node.js 24 LTS, version 24.20.0 or newer](/getting-started/installation#nodejs-version). Package-manager installs—including `bun add -g`—run on Node.js by default unless you explicitly invoke Atomic with Bun (`bun --bun`, requiring Bun 1.4.5+).
- **Release archive install:** macOS and Linux need `tar` and either `curl` or `wget`; Windows uses built-in PowerShell. No Node.js or package manager is required.
- **Model provider:** A supported subscription or account login (`/login`), an API key, or a local `llama.cpp` server.

## Get up and running

<Steps>
  <Step title="Install Atomic">
    Choose a package manager or the self-contained release archive:

    <Tabs>
      <Tab title="Package manager">
        ```bash
        npm install -g @bastani/atomic
        # or: pnpm add -g @bastani/atomic
        # or: bun add -g @bastani/atomic
        ```
      </Tab>
      <Tab title="macOS / Linux archive">
        ```bash
        curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh
        ```
      </Tab>
      <Tab title="Windows PowerShell archive">
        ```powershell
        irm https://raw.githubusercontent.com/bastani-inc/atomic/main/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    Verify the install:

    ```bash
    atomic --version
    ```

    See [Install Atomic](/getting-started/installation) for [package manager details](/getting-started/installation#package-managers), [release archive options](/getting-started/installation#release-archive), Git setup, and [uninstalling](/getting-started/installation#uninstall).
  </Step>

  <Step title="Authenticate a provider">
    Connect a subscription, sign in from your shell, or export an API key:

    <Tabs>
      <Tab title="Interactive /login">
        Start Atomic and run `/login`, then pick a subscription, account, or API key provider:

        ```bash
        atomic
        ```

        ```text
        /login
        ```
      </Tab>
      <Tab title="Shell login">
        Sign in without opening an interactive session (pass `--no-browser` over SSH):

        ```bash
        atomic auth login anthropic
        ```
      </Tab>
      <Tab title="API key">
        Export an API key before launching Atomic:

        ```bash
        export ANTHROPIC_API_KEY=sk-ant-...
        atomic
        ```
      </Tab>
    </Tabs>

    See [Authenticate a provider](/getting-started/authentication) for all login flows and verification steps.
  </Step>

  <Step title="Run your first session">
    Start Atomic inside a repository. On a fresh install, Atomic opens a brief two-step **First-Time Setup** screen (theme and analytics preference) before showing the prompt.

    ```bash
    cd /path/to/project
    atomic
    ```

    Ask Atomic to inspect the repository:

    ```text
    List the top-level directories in this repository and say what each one holds.
    ```

    - Run `/tasks` to inspect background subagents and shells.
    - Run `/skill:<name>` to invoke a reusable skill directly (see [Top skills to invoke directly](/getting-started/first-session#top-skills-to-invoke-directly)).
    - Ask Atomic to split independent work across subagents (see [Delegate a larger task](/getting-started/first-session#delegate-a-larger-task)).

    See [Run your first session](/getting-started/first-session) for the full walkthrough and [built-in tools](/getting-started/first-session#built-in-tools).
  </Step>

  <Step title="Add project instructions">
    Create an `AGENTS.md` file in your repository root with your build commands, test commands, and coding conventions, then run `/reload` so Atomic picks it up immediately.

    See [Add project instructions](/getting-started/project-instructions) for precedence rules and system prompt files.
  </Step>
</Steps>

## Try common workflows

### Reference files and images

Type `@` in the editor to fuzzy-search project files, or pass `@file` arguments from the shell:

```bash
atomic @README.md "Summarize this"
atomic @src/app.ts @src/app.test.ts "Review these together"
```

Paste images into the editor with `Cmd+V` on macOS, `Ctrl+V` on Linux (or inside tmux on macOS), and `Alt+V` or `Ctrl+V` on Windows and WSL, or drag images directly into supported terminals.

### Run shell commands

Prefix a command in the editor with `!` to run it and include its output in the model context, or `!!` to run it locally without sending output to the model:

```text
!npm test
```

### Switch models and thinking levels

- `/model` or `Ctrl+L`: open the model selector (`←`/`→` adjusts thinking effort on reasoning models).
- `Shift+Tab`: cycle the thinking level.
- `Ctrl+P` / `Shift+Ctrl+P` (`Alt+P` on Windows and WSL): cycle forward or backward through scoped models.

### Continue or branch a session

Sessions auto-save per working directory:

```bash
atomic -c                    # Continue the most recent session
atomic -r                    # Pick from saved sessions
atomic --name "my task"      # Set a display name at startup
atomic --session <id|prefix> # Open by exact ID or unique 8-hex prefix
atomic --import <file.jsonl> # Import an exported JSONL session
```

Inside interactive mode, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone`. See [Manage sessions](/sessions).

### Run non-interactively

Use `-p` (`--print`) for one-shot prompts, or pipe input into `atomic` (non-TTY stdin or stdout enters print mode automatically):

```bash
atomic -p "Summarize this codebase"
cat README.md | atomic -p "Summarize this text"
atomic -p @screenshot.png "What's in this image?"
```

Use `--mode json` for a JSON event stream or `--mode rpc` for stdin/stdout process integration. See [Non-interactive mode](/guides/non-interactive).

## Next steps

<Columns cols={2}>
  <Card title="How Atomic works" href="/how-atomic-works">
    Understand the agent loop, two-process terminal UI, context assembly, and trust model.
  </Card>
  <Card title="Use interactive mode" href="/usage">
    Learn editor shortcuts, message queueing, startup typing, and prompt history search.
  </Card>
  <Card title="Choose a model" href="/models/choose-a-model">
    Compare subscriptions, API keys, local llama.cpp models, and scoped model cycling.
  </Card>
  <Card title="Context and compaction" href="/compaction">
    Keep long sessions within budget with memory compaction or custom remote compactors.
  </Card>
  <Card title="Subagents and orchestration" href="/subagents">
    Delegate independent work to background subagents, coordinate via Intercom, and verify results.
  </Card>
  <Card title="Security and isolation" href="/security">
    Review project trust, OS tool permissions, and container isolation before running untrusted code.
  </Card>
</Columns>

Also explore [Slash commands](/slash-commands), [Custom compaction models](/compaction/custom-compactors), [Worktree snapshots](/worktree-snapshots), [Resume on any machine](/guides/resume-on-any-machine), [Storage](/storage), [MCP servers](/mcp-servers), [CLI reference](/reference/cli), and [Platform setup](/reference#platform-setup) ([Windows](/windows), [Terminal setup](/terminal-setup), [tmux](/tmux), [Herdr](/herdr), [Shell aliases](/shell-aliases)).
