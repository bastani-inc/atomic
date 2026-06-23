# Quickstart

This page gets you from install to a useful first Atomic session. Atomic is the loop engine for all engineering work: it runs reliable coding-agent loops with stages, tools, artifacts, verification, subagents, review gates, checkpoints, and human approvals.

## Prerequisites

- **Node.js 24 LTS or newer** — Atomic requires the latest Node LTS runtime. Check with `node --version`.
- **A package manager** — use npm (included with Node), pnpm, Yarn, or Bun. Use Bun 1.3.14+ for Bun installs or workflow-authoring examples.
- **Model-provider access** — Use `/login` after startup. Supports provider subscriptions and APIs.

## Install

Install the published package globally with npm, pnpm, or Bun:

With npm:

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

Atomic does not require package install scripts. If you want to disable dependency lifecycle scripts during the Atomic install, you can add `--ignore-scripts` to the install command.

Then start Atomic in the project directory you want it to work on:

```bash
cd /path/to/project
atomic
```

## Uninstall

Remove the global package with the same package manager you used to install it:

```bash
npm uninstall -g @bastani/atomic
pnpm remove -g @bastani/atomic
bun remove -g @bastani/atomic
```

This removes the CLI package only. User configuration, auth, sessions, and packages remain under `~/.atomic/agent/` unless you delete that directory yourself.

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

Once Atomic starts, the fastest way to get value is to kick off a built-in workflow or invoke a skill. Atomic turns repeatable engineering loops into executable stages with inspectable evidence instead of relying on a markdown checklist the model may or may not follow.

For an interactive tour any time, run `/atomic` inside the TUI; `/atomic overview`, `/atomic workflows`, and `/atomic example` walk through the same flow in more depth.

### Try the built-in workflows

Atomic ships with four workflows you can run immediately. Use `/workflow list` to see them and `/workflow inputs <name>` to inspect their inputs in your environment.

| Workflow | When to use | Example |
|---|---|---|
| `deep-research-codebase` | Broad, cross-cutting research before you decide what to change. Scout → research-history → parallel specialist waves → aggregator. | `/workflow deep-research-codebase prompt="How do payment retries work end to end?"` |
| `goal` | Bounded one-off changes when you already know the work surface, exact outcome, and validation — for example tests, lint/typecheck, docs builds, or observable behavior. Keeps the run focused with a goal ledger, reviewer gates, final status `complete`, `blocked`, or `needs_human`, and optional final-stage PR creation with `create_pr=true` after approval. | `/workflow goal objective="Update the CLI docs for --json, include one example, run the docs build, and finish when the build passes"` |
| `ralph` | Planned or broad implementation work from a spec file, GitHub issue, or crisp ticket description. Ralph refines the prompt, researches as needed, delegates implementation through sub-agents, reviews, records a QA proof video for UI/full-stack changes when practical, iterates, and optionally lets only the final stage attempt PR creation with `create_pr=true`. | `/workflow ralph prompt="Implement specs/2026-03-rate-limit.md and validate burst traffic returns 429"` |
| `open-claude-design` | UI and design-system work with separate forked generate and feedback chains; renders a live `preview.html` you can iterate against. | `/workflow open-claude-design prompt="Refresh the settings page hierarchy as a page"` |

<p align="center"><img src="images/workflow-list.png" alt="Workflow List" width="600" /></p>

Inputs are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=5`, `flag=true`, and `objective="multi word value"` preserve useful types. Some workflows expose reusable worktree inputs; for example, add `git_worktree_dir=../atomic-ralph-wt` to `ralph` to run its stages in a created/reused Git worktree while preserving your current repo-relative cwd. Goal and Ralph skip PR creation by default; prompt text alone does not opt in. Add `create_pr=true` only when you want the final `pull-request` stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation after the workflow's review gate approves, such as GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling; the PR-creation instructions live in that final stage. If you call `/workflow <name>` without required inputs, the TUI opens an inline picker; pass `--no-picker` to skip it.

You can also launch workflows with **natural language** — just describe the task in chat and ask Atomic to run the matching workflow:

```text
Run a deep codebase research workflow on how the rate limiter behaves under burst traffic.
```

```text
Use the goal workflow to update the CLI docs for --json, include one example, run the docs build, and finish when the build passes.
```

Atomic picks the workflow, fills in inputs from the request, and confirms before launch.

For planned work, make `ralph` the default implementation loop after research or spec creation. Give it a spec file, GitHub issue, or crisp ticket description; it refines the prompt, researches as needed, delegates implementation, reviews, records a QA proof video for UI/full-stack changes when practical, and iterates. Add `create_pr=true` only when you want the final PR handoff after the review gate approves.

For smaller one-off tasks, use `goal` with a concrete task description that names the work surface, desired outcome, and validation. It keeps the run bounded, captures receipts in a goal ledger, gates completion through reviewers, stops as `complete`, `blocked`, or `needs_human`, and can optionally run only the final PR handoff with `create_pr=true` after approval.

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
| `playwright-cli` | Drive a real browser for end-to-end UI checks, screenshots, and reviewable proof videos. | `/skill:playwright-cli` |
| `effective-liteparse` | Pull text, tables, or values out of PDF, DOCX, PPTX, XLSX, and image files locally. | `/skill:effective-liteparse` |

Use `/skill:research-codebase` for a focused area and `/workflow deep-research-codebase` when the answer spans the whole repo. A typical planned flow is `/skill:research-codebase` → `/skill:create-spec` → `/workflow ralph` with the spec path, a GitHub issue, or a crisp ticket description. For smaller one-off tasks, use `/workflow goal` with a concrete objective that identifies the work surface, states the exact outcome, and names the validation that proves it is done; add `create_pr=true` only when you want Goal's final `pull-request` stage after approval.

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
- write a `.atomic/workflows/<name>.ts` definition that uses `workflow({ ... })` and imports `Type` from `typebox`,
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
- `find` - discover files by glob pattern
- `search` - search file contents
- `ask_user_question` - ask structured questions in the TUI
- `todo` - manage file-based todos

Normal coding sessions include file discovery and content search through `find` and `search` in addition to `read`, `bash`, `edit`, and `write`. Additional read-only built-ins (`grep`, `ls`) remain available through tool options. Atomic runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give Atomic project instructions

Atomic loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `bun run typecheck` after code changes.
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

Platform notes: [Windows](/windows), [Termux](/termux), [tmux](/tmux), [Terminal setup](/terminal-setup), [Shell aliases](/shell-aliases).
