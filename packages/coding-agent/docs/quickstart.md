# Quickstart

This page gets you from install to a useful first Atomic session.

## Prerequisites

- **Node.js 24 LTS or newer** — Atomic requires the latest Node LTS runtime. Check with `node --version`.
- **A package manager** — use npm (included with Node), pnpm, Yarn, or Bun. Use Bun 1.3.14+ for Bun installs or workflow-authoring examples.
- **Model-provider access** — Use `/login` after startup. Supports provider subscriptions and APIs.

## Install

Atomic is distributed through npm-compatible package managers. Choose one:

```bash
# npm
npm install -g @bastani/atomic

# Bun
bun install -g @bastani/atomic

# pnpm
pnpm add -g @bastani/atomic
```

Atomic does not require package install scripts. If you want to disable dependency lifecycle scripts during the Atomic install, you can add `--ignore-scripts` to the install command.

Then start Atomic in the project directory you want it to work on:

```bash
cd /path/to/project
atomic
```

## Authenticate

Atomic can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start Atomic and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching Atomic:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

You can also run `/login` and select an API-key provider to store the key in `~/.atomic/agent/auth.json`.

See [Providers](/providers) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once Atomic starts, the fastest way to get value is to kick off a built-in workflow or invoke a skill — Atomic plans and executes multi-stage work for you.

For an interactive tour any time, run `/atomic` inside the TUI; `/atomic overview`, `/atomic workflows`, and `/atomic example` walk through the same flow in more depth.

### Try the built-in workflows

Atomic ships with four workflows you can run immediately. Use `/workflow list` to see them and `/workflow inputs <name>` to inspect their inputs in your environment.

| Workflow | When to use | Example |
|---|---|---|
| `deep-research-codebase` | Broad, cross-cutting research before you decide what to change. Scout → research-history → parallel specialist waves → aggregator. | `/workflow deep-research-codebase prompt="How do payment retries work end to end?"` |
| `goal` | Small-to-medium scope changes when you can identify the work surface, state the exact outcome, and name the validation that proves it is done — for example tests, lint/typecheck, docs builds, or observable behavior. Keeps the run bounded with a goal ledger, reviewer gates, and final status `complete`, `blocked`, or `needs_human`. | `/workflow goal objective="Implement specs/2026-03-rate-limit.md, run the focused tests, and finish when burst traffic returns 429"` |
| `ralph` | Larger migrations, broad refactors, multi-package changes, and spec-to-PR work where you want Atomic to plan the approach, delegate implementation through sub-agents, simplify, review, iterate, and prepare a pull-request report. | `/workflow ralph prompt="Plan the database migration, implement it, review it, and prepare a PR"` |
| `open-claude-design` | UI and design-system work with generation, critique, and refinement loops; renders a live `preview.html` you can iterate against. | `/workflow open-claude-design prompt="Refresh the settings page hierarchy" output_type=page` |

<p align="center"><img src="images/workflow-list.png" alt="Workflow List" width="600" /></p>

Inputs are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=5`, `flag=true`, and `objective="multi word value"` preserve useful types. Some workflows expose reusable worktree inputs; for example, add `git_worktree_dir=../atomic-ralph-wt` to `ralph` to run its stages in a created/reused Git worktree while preserving your current repo-relative cwd. If you call `/workflow <name>` without required inputs, the TUI opens an inline picker; pass `--no-picker` to skip it.

You can also launch workflows with **natural language** — just describe the task in chat and ask Atomic to run the matching workflow:

```text
Run a deep codebase research workflow on how the rate limiter behaves under burst traffic.
```

```text
Use the goal workflow to update the CLI docs for --json, include one example, run the docs build, and finish when the build passes.
```

Atomic picks the workflow, fills in inputs from the request, and confirms before launch.

Use `goal` for small-to-medium scope changes when you can identify the work surface, state the exact outcome you want, and name the validation that proves it is done — for example specific tests, lint/typecheck commands, docs builds, or observable behavior. It keeps the run bounded, captures receipts in a goal ledger, gates completion through reviewers, and stops as `complete`, `blocked`, or `needs_human`.

Keep using `ralph` for larger migrations, broad refactors, multi-package changes, and spec-to-PR work where you want Atomic to plan the approach, delegate implementation through sub-agents, simplify, review, iterate, and prepare a pull-request report.

### Monitor and steer a run

Named workflow runs execute in the background. After launch you get a run id; use it to inspect, attach, pause, or resume:

```text
/workflow status                  # list this session's active and terminal runs
/workflow connect <run-id>        # open the graph viewer (F2 also opens the latest)
/workflow attach <run-id> <stage> # chat with one stage
/workflow interrupt <run-id>      # pause resumably
/workflow resume <run-id> "go"    # send a steer message and resume
/workflow kill <run-id>           # abort and retain for inspection
```

Human-in-the-loop prompts (`ctx.ui.input`, `confirm`, `select`, `editor`) surface in the graph viewer, not as chat modals — connect to the run to answer them.

Atomic also posts main-chat lifecycle notices when a run completes, fails, or awaits input. If you answer a workflow prompt in the graph or attached stage chat, the main chat receives a display-only answer summary for audit; it does not wake the model, enter LLM context, or answer later prompts. See [Workflows](/workflows) for the full reference and authoring guide.

### Top skills to invoke directly

Skills are reusable expert instructions. Trigger one with `/skill:<name>` followed by a request:

| Skill | When to use | Example |
|---|---|---|
| `research-codebase` | Scoped research that writes a grounded artifact for one subsystem or question. | `/skill:research-codebase how the rate limiter works in src/middleware/` |
| `create-spec` | Turn research into an implementation-ready plan. | `/skill:create-spec from research/docs/2026-03-rate-limit.md` |
| `prompt-engineer` | Tighten a vague prompt before a long run. | `/skill:prompt-engineer Draft a sharper repo-research prompt for payment retries end to end.` |
| `tdd` | Test-first feature or bug work. | `/skill:tdd` |
| `impeccable` | Critique or refine frontend and product UI. | `/skill:impeccable` |

Use `/skill:research-codebase` for a focused area and `/workflow deep-research-codebase` when the answer spans the whole repo. A typical focused flow is `/skill:research-codebase` → `/skill:create-spec` → `/workflow goal` with an objective that identifies the work surface, states the exact outcome, and names the validation that proves it is done. Keep using `/workflow ralph` for larger migrations, broad refactors, multi-package changes, and spec-to-PR work where you want Atomic to plan, delegate through sub-agents, simplify, review, iterate, and prepare a pull-request report.

### Create your own workflow in natural language

You do not have to write TypeScript to add a new workflow. Describe what you want in plain chat and Atomic will design and write it for you using the [Workflows](/workflows) reference as the source of truth:

```text
Create a reusable Atomic workflow called review-changes. It takes one
required text input `target` (a diff, PR, or review focus). Run two reviewers
in parallel with fresh context — one for correctness and missing tests, one
for edge cases and maintainability — then a synthesis stage that
consolidates findings into blockers vs. suggestions and returns
{ consolidated_review, decision }.
```

Atomic will:

- ask clarifying questions if stage purpose, inputs, models, or handoffs are ambiguous,
- write a `.atomic/workflows/<name>.ts` definition that uses `defineWorkflow(...).input(...).run(...).compile()`,
- and run `/workflow reload` so the generated workflow is rediscovered and can be launched with `/workflow <name>`.

The same plain-chat approach works for editing or hardening an existing workflow — ask Atomic to add a stage, switch a model, save artifacts, or wire in a human approval gate. For the full authoring reference, see [Workflows](/workflows). The authoring guide also covers [workflow composition](/workflows#workflow-composition), including calling user-defined workflows or builtin workflows such as `deep-research-codebase`, `goal`, and `ralph` from `@bastani/workflows/builtin`.

### Default tools and prompts

If you'd rather start with a plain prompt, just type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Atomic gives the model these tools:

- `read` - read files
- `bash` - run shell commands
- `edit` - patch files
- `write` - create or overwrite files
- `ask_user_question` - ask structured questions in the TUI
- `todo` - manage file-based todos

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Atomic runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give Atomic project instructions

Atomic loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Atomic loads:

- `~/.atomic/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

Restart Atomic, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
atomic @README.md "Summarize this"
atomic @src/app.ts @src/app.test.ts "Review these together"
```

Images can be pasted with CTRL+V (ALT+V on Windows) or dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or CTRL+L to choose a model. Use SHIFT+Tab to cycle thinking level. Use CTRL+P / SHIFT+CTRL+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
atomic -c                  # Continue most recent session
atomic -r                  # Browse previous sessions
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

Platform notes: [Windows](/windows), [Termux](/termux), [tmux](/tmux), [Terminal setup](/terminal-setup), [Shell aliases](/shell-aliases).
