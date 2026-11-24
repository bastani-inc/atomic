---
title: "Run your first session"
sidebarTitle: "First session"
description: "Start Atomic in a repository, run your first task, inspect background work, and verify saved sessions."
---

**Outcome:** You complete one interactive task and verify its saved session.

**Prerequisites:** [Authenticate a provider](/getting-started/authentication) is complete.

## Start Atomic

Start Atomic in a repository directory:

```bash
cd /path/to/project
atomic
```

The first time you open an empty interactive session with no initial prompt on the command line, Atomic displays a one-time overview above the input box (after any What's New notes). Returning users skip it automatically; stored credentials alone do not skip it.

The prompt is ready immediately. Type a request, run `/login` to connect a provider, or run `/agents` to browse available subagents.

## Verify the session

Run a bounded task in a repository you know:

```text
List the top-level directories in this repository and say what each one holds.
```

Expected result: Atomic streams a response and calls `read`, `find`, or `bash` at least once, showing each tool call inline as it runs. It finishes with a summary naming directories that exist in your checkout. If it names nothing from your repository, quit, `cd` into the repository, and start Atomic again.

Exit Atomic (`/exit`) and verify the session was saved:

```bash
atomic -r
```

Expected result: the session picker lists the run you just finished. Run `atomic -c` to resume it.

## Explore built-in capabilities

Once your first session works, reach for these capabilities as needed.

### Delegate a larger task

Ask Atomic to split independent work across [subagents](/subagents):

```text
Ask one subagent to trace the retry logic and another to find its tests. Compare their findings and show me any gaps.
```

- Run `/tasks` to inspect background subagents and read their output.
- Run `/resume` to return to a saved session.

Converting an older Atomic workflow file? Give Atomic its path in a trusted project and ask it to convert the file into a skill. See [Migrating workflows](/orchestration/migrating-workflows).

### Top skills to invoke directly

Skills are reusable instructions invoked with `/skill:<name>`:

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
| `show-me` | Explain topics visually with diagrams, code sketches, or focused HTML views (HumanLayer, MIT). | `/skill:show-me` |

Atomic bundles these skills with every release, and you can also add your own project or user skills. Note that `agent-browser`, `agent-desktop`, `qlty`, and `liteparse` require their external CLI binaries to be installed on your machine. See [Skills](/skills) for skill discovery, requirements, and authoring details.

### Default tools and prompts

Type any plain request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Atomic gives the model these built-in coding tools:

- **`read`:** Read files, directories, images, archives, URLs, and SQLite selectors.
- **`bash`:** Run shell commands.
- **`kill`:** Cancel background shell tasks by task ID.
- **`edit`:** Patch files with exact text replacement.
- **`write`:** Create or overwrite files.
- **`find`:** Discover files by glob pattern.
- **`search`:** Search file contents with regular expressions.
- **`ask_user_question`:** Ask structured questions in the terminal UI.
- **`todo`:** Manage file-based todos.
- **`codemode`:** Compose permitted tool calls in a sandboxed script.

On native Windows, `powershell` is also enabled when a PowerShell executable is available. Bundled integration tools such as `subagent`, `intercom`, `web_search`, and `fetch_content` are enabled alongside the coding tools by default; run `/tools` to inspect every active tool.

Atomic runs in your current working directory and can modify files there, so use Git or another checkpointing workflow for easy rollback.

## Next step

Continue to [Add project instructions](/getting-started/project-instructions).
