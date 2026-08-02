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

### Alpine and musl Linux archives

For Alpine Linux, use `atomic-linux-x64-musl.tar.gz` on x64 or `atomic-linux-arm64-musl.tar.gz` on arm64. These archives provide native search and PTY bindings. Install their runtime libraries with `apk add --no-cache libgcc libstdc++`, then see the [Alpine and musl Linux archive notes](/index#alpine-and-musl-linux-archives) for the clipboard fallback and external Postgres or Docker requirement for durable workflows.

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

On a fresh install with no prior Atomic startup state, Atomic shows a one-time first-run explanation after any What's New notes and directly above the input box describing Atomic as a verifiable coding agent runtime for building and running agent workflows you can feel confident in. Returning users with prior startup state are marked onboarded automatically and continue directly into the normal chat UI; stored credentials by themselves do not skip the first-run explanation. The composer is the normal Atomic input from the start: type a message, run `/login` first if no provider is connected, open `/atomic`, or launch a workflow command without a special onboarding transition.

Once Atomic starts, default to a workflow for non-trivial work and for requests with inherent structure plus a verifiable objective. Implementation, build, debugging, bug fixes, migrations, features, scoped multi-file edits, validation/review work, and loop-shaped requests are workflow candidates; reserve direct chat for tiny deterministic low-risk answers or edits where tracking clearly adds more overhead than value.

Workflow-first is not builtin-only or monolithic. Atomic can discover and run named builtin, project, user, and package workflows; author a rich custom TypeScript `workflow({...})` inline; and compositionally import reusable workflow definitions—including builtins from `@bastani/workflows/builtin`—into parent workflows with `ctx.workflow(...)`. Nested children can nest again within `maxDepth`, so custom graphs can combine proven research, implementation, design, verification, and approval workflows instead of copying them. They can also classify and branch, dynamically fan out and synthesize artifacts, run adversarial repair cycles, tournament-rank candidates, and loop until checks pass with explicit bounds.

Atomic turns repeatable engineering loops into executable stages with inspectable evidence instead of relying on a markdown checklist the model may or may not follow.

For an interactive tour any time, run `/atomic` inside the TUI; `/atomic overview`, `/atomic workflows`, and `/atomic example` walk through the same flow in more depth.

### Try the built-in workflows

Atomic ships with nine workflows you can run immediately. Use `/workflow list` to see them and `/workflow inputs <name>` to inspect their inputs in your environment.

| Workflow | When to use | Example |
|---|---|---|
| `classify-and-act` | Route requests through structured classification and low-confidence human fallback. | `/workflow classify-and-act prompt="Triage and handle this request"` |
| `fan-out-and-synthesize` | Partition independent slices, including repository-focused research, and synthesize their artifact evidence. | `/workflow fan-out-and-synthesize prompt="Map payment retries by subsystem and synthesize cited findings"` |
| `adversarial-verification` | Challenge a candidate with fresh verifiers and bounded repair. | `/workflow adversarial-verification task="Verify the migration patch"` |
| `generate-and-filter` | Generate, dedupe, filter, optionally judge, and shortlist candidates. | `/workflow generate-and-filter prompt="Propose names for the new command"` |
| `tournament` | Compare whole solutions through balanced pairwise judging. | `/workflow tournament prompt="Design the retry strategy"` |
| `loop-until-done` | Iterate with a durable ledger until completion or bound exhaustion. | `/workflow loop-until-done prompt="Repair failures until the test suite passes"` |
| `goal` | Autonomous work that needs a durable ledger, bounded sub-agent orchestration, receipts, and reviewer-gated completion. | `/workflow goal objective="Update the CLI docs, add one example, and validate the docs build"` |
| `ralph` | Research-first autonomous work with prompt refinement, delegated implementation, and iterative multi-model review. | `/workflow ralph prompt="Implement specs/rate-limit.md and validate burst traffic"` |
| `open-claude-design` | UI and design-system work with separate generate and feedback chains and a live `preview.html`. | `/workflow open-claude-design prompt="Refresh the settings page hierarchy as a page"` |

<p align="center"><img src="images/workflow-list.png" alt="Workflow List" width="600" /></p>

Inputs are bare `key=value` tokens. Values are JSON-parsed when possible, so `count=5`, `flag=true`, and `prompt="multi word value"` preserve useful types. If you call `/workflow <name>` without required inputs, the TUI opens an inline picker; pass `--no-picker` to skip it. Goal and Ralph support `git_worktree_dir` only when you explicitly want a reusable worktree, and skip PR creation unless you set `create_pr=true` for the post-approval final stage.

You can also launch workflows with **natural language** — describe the task in chat and ask Atomic to run a matching installed workflow or author a task-specific one:

```text
Fan out repository research by subsystem, save cited findings as artifacts, and synthesize the evidence.
```

```text
Create a worker → fresh verifier → reducer workflow that updates the CLI docs, runs the docs build, and repairs evidence-backed findings until it passes or reaches a bounded stop.
```

```text
Use goal to update the CLI docs, include one example, run the docs build, and finish only when reviewers approve the evidence.
```

```text
Use ralph to research and implement specs/rate-limit.md, then review and repair it within three loops.
```

Atomic chooses a complete execution shape, fills inputs from the request, and confirms before launch. Use Goal when a durable ledger and receipt-backed reviewer gate fit the task. Use Ralph when the job benefits from a research-first implementation/review loop. For exact domain contracts that either builtin does not cover, author a custom graph with deterministic checks and bounded repairs.

### Monitor and steer a run

Named workflow runs execute in the background. After launch you get the full run id; user-facing workflow surfaces show that complete UUID. You can still type the full id or a unique short prefix to inspect, connect, pause, quit, or resume a run. Ambiguous prefixes are reported rather than selecting a run arbitrarily.

```text
/workflow status <run-id>         # inspect one run's progress
/workflow status                  # list this session's active and terminal runs
/workflow connect <run-id>        # see agents working; chat with or steer each stage (F2 also opens latest)
/workflow attach <run-id> <stage> # chat with one stage
/workflow interrupt <run-id>      # pause resumably
/workflow resume <run-id> "go"    # send a steer message and resume
/workflow quit <run-id>           # pause gracefully and keep the run resumable
```

The below-editor `BACKGROUND` panel uses two lines per card at 80 columns and wider: the status glyph and full id are on the first line, and the workflow name plus mode/progress/elapsed metadata are on the second. Below 80 columns it collapses to a count-only line. In chat surfaces, a full id wraps onto continuation lines at narrow widths instead of being cut, and the surrounding border remains intact.

Human-in-the-loop prompts (`ctx.ui.input`, `confirm`, `select`, `editor`) surface in the graph viewer, not as chat modals — connect to the run to answer them.

Atomic also posts main-chat lifecycle notices when a run completes, fails, or awaits input. If you answer a workflow prompt in the graph or attached stage chat, the main chat receives a display-only answer summary for audit; it does not wake the model, enter LLM context, or answer later prompts. See [Workflows](/workflows) for the full reference and authoring guide.

### Top skills to invoke directly

Skills are reusable expert instructions. Trigger one with `/skill:<name>` followed by a request:

| Skill | When to use | Example |
|---|---|---|
| `research-codebase` | Scoped research that writes a grounded artifact for one subsystem or question. | `/skill:research-codebase how the rate limiter works in src/middleware/` |
| `create-spec` | Turn research into an implementation-ready plan. | `/skill:create-spec from research/docs/2026-03-rate-limit.md` |
| `prompt-engineer` | Create, optimize, evaluate, or troubleshoot prompts for GPT-5.6, Claude Opus 5, and Claude Fable 5. | `/skill:prompt-engineer Draft a sharper repo-research prompt for payment retries end to end.` |
| `tdd` | Test-first feature or bug work. | `/skill:tdd` |
| `impeccable` | Critique or refine web/native frontend and product UI; includes detector hooks. | `/skill:impeccable` |
| `playwright-cli` | Drive a real browser for end-to-end UI checks, screenshots, and reviewable proof videos. | `/skill:playwright-cli` |
| `liteparse` | Pull text, tables, or values out of PDF, DOCX, PPTX, XLSX, and image files locally. | `/skill:liteparse` |

Use `/skill:research-codebase` for a focused subsystem or question. For repository-wide research, use `fan-out-and-synthesize` with distinct repository partitions and an artifact synthesis barrier. Use Goal for ledger-backed bounded orchestration and Ralph for research-first delegated implementation with iterative review; task size alone does not select either workflow.

### Create your own workflow in natural language

Named workflows may be builtin, project, user, or package supplied. You do not have to hand-write TypeScript to add a new workflow. Describe what you want in plain chat and Atomic will design and write it for you using the [Workflows](/workflows) reference as the source of truth:

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
- run `/workflow reload` so the generated workflow is rediscovered and can be launched with `/workflow <name>`,
- then report the generated workflow folder so you can inspect the code it wrote, using `Custom workflow created. You can inspect its code at: <workflow-folder-path>` (for example, `.atomic/workflows/`); Atomic does this only for newly created custom workflows, never builtin or pre-existing workflows.

The same plain-chat approach works for editing or hardening an existing workflow. For the full authoring reference, see [Workflows](/workflows), including composition with user-defined workflows and all nine builtins from `@bastani/workflows/builtin`.

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

Normal coding sessions include file discovery and content search through `find` and `search` in addition to `read`, `bash`, `edit`, and `write`. Atomic runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

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

Type `@` in any interactive editor to fuzzy-search files; or pass files on the command line:

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
