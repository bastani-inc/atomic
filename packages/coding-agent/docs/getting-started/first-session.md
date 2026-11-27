---
title: "Run your first session"
sidebarTitle: "Run your first session"
description: "Complete first-time setup, run your first task in a repository, inspect background work, and verify saved sessions."
---

**Outcome:** You complete first-time setup, finish one interactive task in a repository, and verify that the session was saved.

**Prerequisites:** [Authenticate a provider](/getting-started/authentication) is complete.

## Start Atomic and finish first-time setup

Start Atomic inside a repository directory:

```bash
cd /path/to/project
atomic
```

### First-Time Setup wizard

On a fresh install (when using the default `~/.atomic/agent/` directory before `settings.json` exists), interactive mode opens a two-step **First-Time Setup** screen before the prompt:

1. **Pick a theme:** Choose **Dark**, **Light**, or **System** (matching your terminal colors). Atomic pre-selects the option matching your detected terminal appearance and updates the theme live as you move through the list.
2. **Anonymous usage analytics:** Choose **Share anonymous usage data** or **Don't share**. Your choice and a local random tracking ID are written to `~/.atomic/agent/settings.json`. Atomic does not transmit analytics data in this release, and you can change this setting anytime in `/settings`.

Use `↑`/`↓` or `j`/`k` to move between choices, `Enter` to continue or finish, and `Esc` or `Ctrl+C` to skip setup without writing `settings.json`.

### Your first prompt

After setup finishes—on your first empty interactive session launched with no CLI prompt—Atomic displays a brief one-time welcome overview above the input box. Returning users skip both setup and the welcome overview automatically.

Type any request to start working, run `/login` to connect a provider, or run `/agents` to browse available subagents.

## Verify the session

<Steps>
  <Step title="Run a bounded repository task">
    Ask Atomic to inspect a repository you know:

    ```text
    List the top-level directories in this repository and say what each one holds.
    ```

    Atomic streams its response and calls tools such as `read`, `find`, or `bash` inline as it works, then summarizes the directories in your checkout. If it mentions nothing from your repository, exit, `cd` into the repository, and launch `atomic` again.
  </Step>
  <Step title="Confirm the session saved">
    Exit Atomic with `/exit`, then open the session picker:

    ```bash
    atomic -r
    ```

    Your completed session appears at the top of the list. Select it with `Enter`, or run `atomic -c` next time to continue the most recent session immediately.
  </Step>
</Steps>

## Explore built-in capabilities

Once your first session works, reach for these capabilities as your tasks grow.

### Delegate a larger task

Ask Atomic to split independent work across background [subagents](/subagents):

```text
Ask one subagent to trace the retry logic and another to find its tests. Compare their findings and show me any gaps.
```

- Run `/tasks` to inspect background subagents and shells, peek at their output, or send them follow-up instructions.
- Run `/resume` to return to any saved session.

### Top skills to invoke directly

Skills are reusable procedures invoked with `/skill:<name>`:

| Skill | When to use | Example |
| --- | --- | --- |
| `research-codebase` | Scoped research that writes a grounded summary for one subsystem or question. | `/skill:research-codebase how the rate limiter works in src/middleware/` |
| `create-spec` | Turn research into an implementation-ready plan. | `/skill:create-spec from research/docs/2026-03-rate-limit.md` |
| `prompt-engineer` | Write, evaluate, migrate, or troubleshoot GPT and Claude prompts with model-specific guides. | `/skill:prompt-engineer Draft a sharper repo-research prompt for payment retries end to end.` |
| `tdd` | Test-first feature or bug work. | `/skill:tdd` |
| `impeccable` | Critique or refine web and native frontend UI. | `/skill:impeccable` |
| `agent-browser` | Drive a real browser for end-to-end UI checks, screenshots, and proof videos. | `/skill:agent-browser` |
| `agent-desktop` | Drive a native desktop app through its accessibility tree: snapshot, act on a ref, wait for postcondition. | `/skill:agent-desktop` |
| `qlty` | Lint, auto-format, and measure complexity, duplication, and code smells across languages. | `/skill:qlty check this branch before I hand it off` |
| `liteparse` | Extract text, tables, or values from PDF, DOCX, PPTX, XLSX, and images locally. | `/skill:liteparse` |
| `show-me` | Explain topics visually with diagrams, code sketches, or focused HTML views. | `/skill:show-me` |

Atomic bundles these skills with every release, and you can add your own user or project skills. `agent-browser`, `agent-desktop`, `qlty`, and `liteparse` require their corresponding external CLI tools to be installed on your machine. See [Skills](/skills) for discovery and authoring details.

### Built-in tools

By default, Atomic gives the model these core coding tools (see [Built-in tools](/tools) for full inputs and options):

- **`read`:** Read files, directories, images, archives, URLs, and SQLite databases (using table/row selectors).
- **`bash`:** Run shell commands.
- **`kill`:** Stop background shell tasks by task ID.
- **`edit`:** Patch files with exact text replacement.
- **`write`:** Create or overwrite files.
- **`find`:** Find files by glob pattern.
- **`search`:** Search file contents with regular expressions.
- **`ask_user_question`:** Prompt you with structured choices or text questions in the terminal UI.
- **`todo`:** Track file-based todos for multi-step work.
- **`codemode`:** Compose permitted tool calls inside a sandboxed JavaScript runtime (see [Codemode](/codemode)).

On native Windows, `powershell` is also enabled when a PowerShell executable is available. Bundled integration tools—including `subagent`, `intercom`, `web_search`, and `fetch_content`—are enabled alongside the coding tools by default. Run `/tools` anytime to see every active tool.

<Note>
Atomic runs in your current working directory and can edit files or run shell commands with your OS permissions. Work inside a Git repository (or rely on [Worktree snapshots](/worktree-snapshots)) for easy rollback, and see [Security](/security) for trust boundaries.
</Note>

## Next step

Continue to [Add project instructions](/getting-started/project-instructions).
