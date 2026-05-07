<p align="center">
  <img src="assets/atomic.png" alt="Atomic" width="800">
</p>

<h1 align="center">Atomic</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source CLI and TypeScript SDK for Claude Code, OpenCode, and GitHub Copilot CLI.
</p>

<p align="center">
  <a href="#quick-start"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#why-atomic">Why Atomic</a>
  &nbsp;·&nbsp;
  <a href="#example-use-cases">Use cases</a>
  &nbsp;·&nbsp;
  <a href="#workflow-sdk--build-reliable-engineering-workflows">SDK</a>
  &nbsp;·&nbsp;
  <a href="https://deepwiki.com/flora131/atomic">Docs</a>
</p>

<p align="center">
  <a href="https://deepwiki.com/flora131/atomic"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/Bun-Runtime-f9f1e1?logo=bun&logoColor=black" alt="Bun"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

## Install in 60 seconds

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash

# Windows (PowerShell 5.1+ or 7+)
irm https://raw.githubusercontent.com/flora131/atomic/main/install.ps1 | iex

# Already have Bun? Skip the bootstrap script entirely
bun install -g @bastani/atomic
```

Then kick off your first autonomous workflow:

```bash
atomic workflow -n ralph -a claude "Build a REST API for user management"
```

> Ralph plans, implements, reviews, and debugs the task on its own — up to 10 iterations, exiting after 2 consecutive clean reviews. Run it inside a [devcontainer](#alternative-devcontainer-recommended-for-autonomous-workflows) or [git worktree](https://git-scm.com/docs/git-worktree) — workflows execute with permission checks disabled.

Need a different install path? See [all installation options](#1-install) (npm, devcontainer, SDK-only) or jump to the full [Quick Start](#quick-start).

<details>
<summary><b>Upgrading from a previous version?</b></summary>

**From 0.6.x or earlier (SDK users):** the SDK moved from `@bastani/atomic` to `@bastani/atomic-sdk`.

```bash
bun remove @bastani/atomic
bun add    @bastani/atomic-sdk
```

Update imports: `from "@bastani/atomic/workflows"` → `from "@bastani/atomic-sdk/workflows"`. The CLI (`atomic` command) keeps the same package name — nothing changes for global-install users.

For SDK API changes (`createWorkflowCli` removal, `source: import.meta.path`, etc.), see the [full SDK migration guide](#migration-from-0x-directory-scanning-and-the-createworkflowcli-wrapper).

**From the old standalone binary:** see [the binary migration steps](#migrating-from-the-old-standalone-binary).

</details>

---

## Why Atomic

Coding agents are great inside a single session — they inspect code, use tools, make edits, and explain their work. The trouble starts when a task is ambiguous, tied to specific exit criteria, long-running, or anchored in a large codebase. You end up reminding the agent of the process, copying output between sessions, second-guessing whether it followed the right steps, and deciding when a human needs to review the work.

**Atomic turns that process into code.** A workflow can branch, retry, run stages in parallel, isolate sessions, pass only the right transcript forward, pause for human approval, and run inside a devcontainer so the agent is never loose on your host machine.

| | |
|---|---|
| **Start with your own process** | Automate the repetitive parts of research, debugging, review, migrations, or PR prep. One TypeScript file, versioned with the repo. |
| **Scale to your team** | Encode review gates, quality checks, and approvals so every teammate runs the same workflow instead of manually steering an agent. |
| **Keep the coding agent** | Atomic adds structure around Claude Code, OpenCode, and Copilot CLI without rebuilding file editing, tool use, MCP setup, hooks, or context handling. |
| **Start in natural language** | Ask the `workflow-creator` skill to turn a description into `defineWorkflow()` code — or let an agent invoke it when a complex task warrants a repeatable workflow. |
| **Own the outer loop** | Workflows, gates, handoffs, and the execution graph are TypeScript you can read, edit, and version — instead of a black-box harness improvising process. |

> Build the workflow once. Run it across agents, repos, and teams — with GitHub, Azure DevOps, or Sapling.

---

## Quick Start

Four steps, a few minutes:

1. **[Install](#1-install)** — one-line bootstrap, no Bun or Node required.
2. **[Generate context](#2-generate-context-files--cli)** — Atomic explores your codebase and writes `CLAUDE.md` / `AGENTS.md`.
3. **[Try Ralph](#3-try-ralph--cli-autonomous-coding)** — autonomous plan → implement → review → debug loop.
4. **[Build your own workflow](#4-build-your-own-workflow--sdk)** — encode your team's process in TypeScript.

Steps 1–3 are the **CLI** path (pre-built autonomous behavior). Step 4 is the **SDK** path (your own workflows). Skip straight to step 4 if you only want the library.

<details>
<summary><b>Prerequisites</b> — what Atomic needs on your machine</summary>

Atomic doesn't replace your coding agent or terminal — it gives them a workflow to follow. Three things have to exist on the host before a workflow can run:

- **A terminal multiplexer** — every stage runs inside a detachable session on a dedicated `atomic` socket (your personal tmux is untouched). That's how workflows survive terminal disconnects, how `-d/--detach` puts a run in the background, and how `atomic session connect` reattaches later from any shell.
  - **macOS / Linux:** [tmux](https://github.com/tmux/tmux) — auto-installed on first `atomic` run via `brew` (macOS) or `apt`/`dnf`/`yum`/`pacman`/`zypper`/`apk` (Linux) when one is on `PATH`
  - **Windows:** [psmux](https://github.com/psmux/psmux) — auto-installed on first `atomic` run via `winget` / `scoop` / `choco` / `cargo`; detected as `psmux` / `pmux` / `tmux` on `PATH`
- **At least one coding agent** installed and logged in — Atomic spawns the agent's own CLI at each stage and talks to it via its SDK, so the CLI has to be present and authenticated:
  - [Claude Code](https://code.claude.com/docs/en/quickstart) — run `claude` and authenticate
  - [OpenCode](https://opencode.ai) — run `opencode` and authenticate
  - [GitHub Copilot CLI](https://github.com/features/copilot/cli) — run `copilot` and authenticate

The bootstrap installer below ships a prebuilt binary — it does **not** require Bun, Node, or any other runtime on your machine. tmux/psmux are not bundled but are **auto-installed lazily on the first non-info `atomic` command** (e.g. `atomic workflow list`) via your platform's package manager. Coding agents are **not** auto-installed — install and authenticate those separately. Using a [devcontainer](#alternative-devcontainer-recommended-for-autonomous-workflows) short-circuits all of this: the atomic feature bundles tmux + the agent CLI into the container image.

</details>

### 1. Install

`@bastani/atomic` is the CLI; `@bastani/atomic-sdk` is the library. Pick the one(s) you need.

**CLI path** — bootstrap script downloads a verified prebuilt binary, installs it to `~/.local/bin` (or `%LOCALAPPDATA%\atomic\bin` on Windows), updates your PATH, and sets up shell completions. No Bun/Node prerequisite.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash

# Windows (PowerShell 5.1+ or 7+)
irm https://raw.githubusercontent.com/flora131/atomic/main/install.ps1 | iex

# Windows (cmd.exe — for environments without PowerShell)
curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.cmd -o install.cmd && install.cmd && del install.cmd
```

Pin a specific version by passing it as an argument: `bash install.sh 0.4.47`, `./install.ps1 0.4.47`, or `install.cmd 0.4.47`.

Upgrade later by re-running the same one-liner.

**SDK-only path** — if you only want to `defineWorkflow(...)` in your own TypeScript project and never need the `atomic` binary, skip the bootstrap and just add the library:

```bash
bun init -y                                      # new project
bun add @bastani/atomic-sdk                      # the SDK
bun add @anthropic-ai/claude-agent-sdk           # the provider SDK you target
```

Skip steps 2–3 below (those use the CLI) and jump straight to [step 4](#4-build-your-own-workflow--sdk). The SDK is fully standalone — it bundles its own orchestrator dispatcher and never reaches into a sibling `@bastani/atomic` package, so `@bastani/atomic-sdk` is the only atomic dependency you need. You'll still need tmux/psmux + an authenticated agent CLI at runtime — see [Prerequisites](#prerequisites). To route self-exec through a globally installed `atomic` binary instead of the bundled dispatcher, pass `pathToAtomicExecutable` to `runWorkflow` — see [Overriding the self-exec target](#overriding-the-self-exec-target).

<details>
<summary><b>Alternative: Already have Bun? Install the CLI directly from npm</b></summary>

```bash
bun install -g @bastani/atomic
```

This skips the Bun install step but doesn't set up shell completions — run `atomic completions <shell>` separately if you want them (see [Commands Reference](#atomic-completions--shell-completions)).
If your shell cannot find `atomic` after the install, add the directory from `bun pm bin -g` to your PATH or use the bootstrap installer above to do it automatically.

**Prerelease builds:** `bun install -g @bastani/atomic@next` (may contain breaking changes).

</details>

<details>
<summary><b>Authenticated downloads (CI / enterprise)</b></summary>

The bootstrap downloads from `github.com/flora131/atomic/releases` (no API calls), so no token is required for normal use. If your environment proxies or rate-limits unauthenticated `github.com` traffic, route the download through your proxy or use `bun install -g @bastani/atomic` instead.

</details>

<details>
<summary><b>Alternative: Devcontainer (recommended for autonomous workflows)</b></summary>

> Devcontainers isolate the agent from your host, limiting the blast radius of destructive actions. This is the safest way to run workflows.

Add one feature to `.devcontainer/devcontainer.json`:

| Feature                              | Agent                |
| ------------------------------------ | -------------------- |
| `ghcr.io/flora131/atomic/claude:1`   | Atomic + Claude Code |
| `ghcr.io/flora131/atomic/opencode:1` | Atomic + OpenCode    |
| `ghcr.io/flora131/atomic/copilot:1`  | Atomic + Copilot CLI |

Full `.devcontainer.json` templates per agent live in [`.devcontainer/`](./.devcontainer/). Each feature installs Atomic, bun, playwright-cli, agent configs, and the agent CLI itself. First run takes ~1 minute to warm up.

Minimal example (Claude + Rust):

```jsonc
{
  "image": "mcr.microsoft.com/devcontainers/rust:latest",
  "features": {
    "ghcr.io/devcontainers/features/common-utils": {},
    "ghcr.io/flora131/atomic/claude:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {}
  },
  "remoteEnv": {
    "GH_TOKEN": "${localEnv:GH_TOKEN}",
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
  }
}
```

Use the [Dev Containers VS Code extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) or the [Dev Container CLI](https://github.com/devcontainers/cli#dev-container-cli) to start the container.

</details>

<details>
<summary><b>Migrating from the old standalone binary?</b></summary>

Atomic used to ship as a standalone binary. It's now an npm package. One-time migration:

```bash
atomic uninstall
bun uninstall -g @bastani/atomic-workflows
rm -rf ~/.atomic ~/.copilot/skills ~/.opencode/skills
bun install -g @bastani/atomic
```

</details>

### 2. Generate context files — CLI

```bash
atomic chat -a <claude|opencode|copilot>
```

Then type `/init`. Atomic explores your codebase with sub-agents and writes `CLAUDE.md` / `AGENTS.md` so every future session starts with the right context.

### 3. Try Ralph — CLI (autonomous coding)

Ralph plans, implements, reviews, and debugs a task on its own — up to 10 iterations, exiting after 2 consecutive clean reviews.

```bash
atomic workflow -n ralph -a claude "Build a REST API for user management"
```

> ⚠️ Workflows run with agent permission checks **disabled** so pipelines don't block on prompts. Run them in a [devcontainer](#containerized-execution) or [git worktree](https://git-scm.com/docs/git-worktree), not on your host. See [Security](#security-workflow-permissions-model).

### 4. Build your own workflow — SDK

Every team has a process — code review, CI checks, PR creation, approval, merge. Encode it as TypeScript once; everyone runs the same pipeline.

```bash
bun init && bun add @bastani/atomic-sdk
```

Author the workflow in `src/workflows/review-to-merge/claude.ts`:

```ts
import { defineWorkflow } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "review-to-merge",
  description: "Review → CI → PR → Notify → Approve → Merge",
}).for("claude")
  .run(async (ctx) => {
    // 1. Review
    const review = await ctx.stage({ name: "review" }, {}, {}, async (s) => {
      await s.session.query("Review uncommitted changes for correctness, security, style.");
      s.save(s.sessionId);
    });

    // 2. Run security + CI in parallel
    await Promise.all([
      ctx.stage({ name: "security-scan" }, {}, {}, async (s) => {
        await s.session.query("Run `bun audit` and scan for leaked secrets.");
        s.save(s.sessionId);
      }),
      ctx.stage({ name: "ci-checks" }, {}, {}, async (s) => {
        await s.session.query("Run `bun lint` and `bun test`. Report failures.");
        s.save(s.sessionId);
      }),
    ]);

    // 3. Open PR, then notify Slack + wait for human approval
    await ctx.stage({ name: "notify-and-merge" }, {}, {}, async (s) => {
      const t = await s.transcript(review);
      await s.session.query(`Read ${t.path}. Open a PR summarizing the changes.`);

      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.SLACK_TOKEN}` },
        body: JSON.stringify({ channel: "#code-review", text: "PR ready — please approve." }),
      });

      // Human-in-the-loop: pauses until the user responds
      await s.session.query(
        "Ask the user to confirm approval, then merge with `gh pr merge --squash`.",
        { allowedTools: ["Bash", "Read", "AskUserQuestion"] },
      );
      s.save(s.sessionId);
    });
  })
  .compile();
```

Wire it to a CLI in `src/claude-worker.ts`. The SDK ships pure
primitives — no wrapper to opt into. Compose with your CLI library of
choice (Commander, citty, yargs, …) and call `runWorkflow`. Catch the
SDK's typed errors (`MissingDependencyError`, `SessionNotFoundError`,
…) for friendly CLI output:

```ts
import { Command } from "@commander-js/extra-typings";
import {
  getInputSchema,
  runWorkflow,
  MissingDependencyError,
} from "@bastani/atomic-sdk/workflows";
import workflow from "./workflows/review-to-merge/claude.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  try {
    await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
  } catch (err) {
    if (err instanceof MissingDependencyError) {
      console.error(`Missing dependency: ${err.dependency}. Install it and retry.`);
      process.exit(1);
    }
    throw err;
  }
});
await program.parseAsync();
```

Run it:

```bash
bun run src/claude-worker.ts --target_branch=main
```

That's the full shape — one workflow file, one composition root. The
SDK exposes primitives (`runWorkflow`, `getInputSchema`, `listWorkflows`,
`getName`, `getAgent`, `validateInputs`, `listSessions`, …) and the
developer composes them into whatever CLI shape they prefer. See
[Workflow SDK](#workflow-sdk--build-reliable-engineering-workflows) for
parallel stages, input schemas, headless stages, and the full API
reference.

### Managing sessions

Every chat and workflow runs inside an isolated [tmux](https://github.com/tmux/tmux) session on a dedicated socket (your personal tmux is untouched). If your terminal disconnects, your session keeps running — reconnect anytime.

```bash
atomic session list              # all sessions
atomic session connect           # interactive fuzzy picker
atomic session connect <name>    # by name
atomic session kill              # interactive multi-select
atomic session kill <name>       # kill one session by name
atomic session kill --all        # select all matching sessions, then confirm
atomic session kill --all --yes  # kill all matching sessions without prompts
```

Session names follow `atomic-chat-<id>` or `atomic-wf-<workflow>-<id>`. Scope with `atomic chat session …` or `atomic workflow session …`.

Need a workflow to run in the background while you do something else? Pass `-d` / `--detach`:

```bash
atomic workflow -n ralph -a claude -d "build the auth module"   # returns immediately
atomic workflow session connect atomic-wf-claude-ralph-<id>      # attach later
```

Detached mode is what you want for scripted / CI automation and long-running tasks — the workflow keeps running on the atomic tmux socket regardless of your terminal.

---

## Two surfaces: CLI and SDK

Atomic ships **two** things that share one workflow runtime. You can use either on its own or both together:

|                       | Atomic CLI                                                                                                                                                                                                                               | Atomic SDK                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What it is**        | Global `atomic` binary                                                                                                                                                                                                                   | `@bastani/atomic-sdk/workflows` TypeScript library                                                                                                                                                                                                                                                                                                                                    |
| **Install**           | `install.sh` / `install.ps1` / `install.cmd` (no runtime prereq) or `bun install -g @bastani/atomic`                                                                                                                                                                       | `bun add @bastani/atomic-sdk` inside your project                                                                                                                                                                                                                                                                                                                                     |
| **Entrypoint**        | `atomic <command>`                                                                                                                                                                                                                       | `bun run src/<agent>-worker.ts`                                                                                                                                                                                                                                                                                                                                                       |
| **Code required?**    | No — everything is pre-built. You can also ask the agent inside `atomic chat` to use the `workflow-creator` skill, decide when a complex task needs its own workflow, and build/run that workflow on the fly.                            | No to start — describe the workflow in natural language and use the `workflow-creator` skill to generate it. Then refine it in natural language or edit the TypeScript workflow and composition root directly, with full visibility into exactly what will run.                                                                                                                       |
| **What you get**      | `atomic chat` (agent REPL), three autonomous built-in workflows (`ralph`, `deep-research-codebase`, `open-claude-design`), session management, the live workflow panel, Atomic skills (`/init`, `/research-codebase`, `/create-spec`, …) | `defineWorkflow`, `createRegistry`, `runWorkflow`, metadata accessors (`getName`, `getInputSchema`, …), session primitives (`listSessions`, `getSessionStatus`, `attachSession` / `detachSession`, `nextWindow` / `previousWindow` / `gotoOrchestrator`), typed errors (`MissingDependencyError`, `SessionNotFoundError`, …), `ctx.stage`, `s.save` / `s.transcript`, headless stages |
| **When to reach for** | You want autonomous execution of a standard pattern out of the box, interactive chat with your agent's full toolset, or a CLI agent that can create a purpose-built workflow before doing complex work.                                  | You want to control the outer loop yourself — review flows, deployment gates, custom research pipelines — with full visibility into the TypeScript your team will run identically.                                                                                                                                                                                                    |
| **Read next**         | [Quick Start](#quick-start) (steps 1–3)                                                                                                                                                                                                  | [Quick Start step 4](#4-build-your-own-workflow--sdk) and [Building your own atomic-powered app](#building-your-own-atomic-powered-app)                                                                                                                                                                                                                                               |

Both surfaces call the same runtime underneath (tmux/psmux session graph, provider SDKs, detach/reattach) — they're two entry points, not two products. Neither depends on the other: you can `bun add @bastani/atomic-sdk` in a project without ever installing the global binary, and you can use `atomic chat` and the built-in workflows without writing any TypeScript.

## Example use cases

These are workflows you'd author with `defineWorkflow` and run from your own `src/<agent>-worker.ts` — see [step 4 of Quick Start](#4-build-your-own-workflow--sdk) for the three-line entrypoint. Atomic ships three built-in workflows (`ralph`, `deep-research-codebase`, `open-claude-design`); everything else is yours to define.

- **Review-to-merge pipeline.** Review code, run CI in parallel, open a PR, notify Slack, wait for approval, merge.
- **Support ticket to draft PR.** Reproduce the issue, find the root cause, try a fix in a sandbox, run tests, pause for review.
- **Production alert investigation.** Pull the failing trace, inspect recent commits, rank likely causes, then draft a fix or page the on-call with evidence.
- **Parallel UX testing.** Run many persona-specific agents against the same feature, aggregate structured feedback, and turn selected issues into tasks.
- **Large migration or refactor.** Research the codebase, split the work into safe batches, run implementation and review passes, and keep artifacts for later runs.

---

## Table of Contents

- [Install in 60 seconds](#install-in-60-seconds)
- [Why Atomic](#why-atomic)
- [Quick Start](#quick-start)
  - [1. Install](#1-install)
  - [2. Generate context files](#2-generate-context-files--cli)
  - [3. Try Ralph](#3-try-ralph--cli-autonomous-coding)
  - [4. Build your own workflow](#4-build-your-own-workflow--sdk)
  - [Managing sessions](#managing-sessions)
- [Two surfaces: CLI and SDK](#two-surfaces-cli-and-sdk)
- [Example use cases](#example-use-cases)
- [Security: Workflow Permissions Model](#security-workflow-permissions-model)
- [Core Features](#core-features)
  - [Multi-Agent Support](#multi-agent-support)
  - [Workflow SDK — Build Reliable Engineering Workflows](#workflow-sdk--build-reliable-engineering-workflows)
  - [Research Codebase](#research-codebase)
  - [Autonomous Execution (Ralph)](#autonomous-execution-ralph)
  - [Deep Research Codebase](#deep-research-codebase)
  - [Containerized Execution](#containerized-execution)
  - [Specialized Sub-Agents](#specialized-sub-agents)
  - [Built-in Skills](#built-in-skills)
  - [Workflow Panel](#workflow-panel)
- [Commands Reference](#commands-reference)
- [Building your own atomic-powered app](#building-your-own-atomic-powered-app)
- [Configuration](#configuration)
- [Updating & Uninstalling](#updating--uninstalling)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)
- [Credits](#credits)

---

## Security: Workflow Permissions Model

> [!CAUTION]
> **Atomic workflows run coding agents with all permission checks disabled.** The agent can read, write, and delete files, execute arbitrary shell commands, and make network requests without prompting. This is required for unattended pipelines. **Run workflows in a [devcontainer](#containerized-execution), not on your host machine.**

| Agent                  | How permissions are bypassed                                         | Key flags / settings                                                  |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Claude Code**        | CLI flag disables the interactive permission prompt entirely         | `--dangerously-skip-permissions`                                      |
| **GitHub Copilot CLI** | CLI flag enables auto-execution; SDK auto-approves all tool requests | `--yolo`, `COPILOT_ALLOW_ALL=true`, `onPermissionRequest: approveAll` |
| **OpenCode**           | Permissions handled programmatically through the event stream        | Permission requests auto-replied via SSE events                       |

Defaults live in `src/services/config/definitions.ts` and `src/sdk/runtime/executor.ts`. Override per-project via `ProviderOverrides` in `.atomic/settings.json` — `chatFlags` replaces defaults entirely; `envVars` are merged.

---

## Core Features

### Multi-Agent Support

Atomic works across **three production coding agents** — switch with a flag and your workflows, skills, and sub-agents carry over.

| Agent              | Command                   |
| ------------------ | ------------------------- |
| Claude Code        | `atomic chat -a claude`   |
| OpenCode           | `atomic chat -a opencode` |
| GitHub Copilot CLI | `atomic chat -a copilot`  |

Each agent gets its own configuration directory (`.claude/`, `.opencode/`, `.github/`), skills, and context files — all managed by Atomic.

### Workflow SDK — Build Reliable Engineering Workflows

The Workflow SDK (`@bastani/atomic-sdk/workflows`) lets you encode your team's process as TypeScript — spawn agent sessions dynamically with native control flow (`for`, `if`, `Promise.all()`), pass state explicitly, and watch each stage appear in a live graph as it runs.

Set up a workflow project (`bun init && bun add @bastani/atomic-sdk`), define your workflow with `defineWorkflow`, then call `runWorkflow({ workflow, inputs })` from inside whatever CLI library you prefer (Commander, citty, yargs, an OpenTUI app, …). The SDK ships pure primitives — no opinionated wrapper:

```bash
bun run src/claude-worker.ts --prompt="describe this project"
```

See [step 4 of Quick Start](#4-build-your-own-workflow--sdk) for a complete review-to-merge example. More examples and the full API reference below.

#### Runnable examples shipped with the repo

The [`examples/`](./examples) directory contains small, complete user apps you can run directly. Most subdirectories ship `claude/`, `copilot/`, and `opencode/` variants plus one agent-scoped worker file per agent — `claude-worker.ts`, `copilot-worker.ts`, `opencode-worker.ts` — each a small Commander entrypoint that calls `runWorkflow({ workflow, inputs })`. `multi-workflow/` and `commander-embed/` use a single `cli.ts` instead, to demonstrate multi-workflow dispatch and Commander embedding respectively.

**Design principle — when does `-a/--agent` belong on your CLI?** Each agent-scoped worker file imports a single workflow pinned to one agent (`import workflow from "./claude/index.ts"`), so there's nothing to disambiguate — no `-a` flag. Only reach for `-a/--agent` when one CLI dispatches across workflows that exist in multiple agent variants — e.g. a `cli.ts` that registers `hello` for claude *and* copilot. The atomic CLI itself uses `-a` for exactly that reason: its builtin registry has cross-agent variants of `ralph`, `deep-research-codebase`, and `open-claude-design`.

| Example                         | What it demonstrates                                                                                                                                                                                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello-world`                   | Minimal single-session workflow with structured inputs (greeting, style, optional notes)                                                                                                                                                                                                                               |
| `sequential-describe-summarize` | Two stages passing data via `s.save()` → `s.transcript(handle)` — the canonical handoff pattern                                                                                                                                                                                                                        |
| `parallel-hello-world`          | `Promise.all()` fan-out and transcript merge                                                                                                                                                                                                                                                                           |
| `headless-test`                 | Visible seed → 3 parallel headless stages → visible merge → headless verdict                                                                                                                                                                                                                                           |
| `hil-favorite-color`            | Human-in-the-loop prompt mid-workflow                                                                                                                                                                                                                                                                                  |
| `hil-favorite-color-headless`   | HIL pause inside a headless stage                                                                                                                                                                                                                                                                                      |
| `structured-output-demo`        | Per-SDK structured output (JSON-schema validation, Zod)                                                                                                                                                                                                                                                                |
| `reviewer-tool-test`            | Custom reviewer tool wiring (Copilot — copilot-worker.ts only)                                                                                                                                                                                                                                                         |
| `review-fix-loop`               | Draft → loop(review → fix) with bounded iterations and early exit on a `CLEAN` verdict — a reliable review gate showing how a stage's return value (`handle.result`) drives TypeScript control flow                                                                                                                    |
| `multi-workflow`                | Two Claude workflows under one `cli.ts` — uses `listWorkflows(registry)` to register one Commander subcommand per workflow with each workflow's declared inputs as `--<flag>` options.                                                                                                                                 |
| `commander-embed`               | Mount an atomic workflow under a parent Commander CLI by calling `runWorkflow({ workflow, inputs })` inside a Commander action, alongside a plain Commander sibling command. No re-entry boilerplate — the SDK ships its own orchestrator entry script.                                                                |
| `pane-navigation`               | Driver CLI for the SDK pane-navigation primitives (`nextWindow`, `previousWindow`, `gotoOrchestrator`, `attachSession`, `detachSession`). Spawns a 3-stage workflow detached and exposes `start / list / status / next / prev / home / attach / stop` subcommands. Catches `SessionNotFoundError` for friendly errors. |

Each example directory ships its own `package.json` and `README.md` with the run command, inputs, and a one-paragraph explanation — head to [`examples/`](./examples) and pick one. The general shape is:

- **Worker-style examples** — `bun install && bun run <agent>-worker.ts --<input>=<value>`. Agent is pinned by which worker file you run (no `-a` flag). Inputs map to `--<input>=<value>` flags; if the workflow declares no inputs, trailing positional tokens become the prompt.
- **CLI-style examples** (`multi-workflow`, `commander-embed`, `pane-navigation`) — `bun install && bun run cli.ts <subcommand>`. See each folder's README for subcommands.

Copy an example directory into your project as a starting point — swap the workflow import in each `<agent>-worker.ts` (or in `cli.ts` for the multi-workflow / commander-embed shapes) for your own definition and you're done.

<details>
<summary><b>Example: Sequential workflow (describe → summarize)</b></summary>

```ts
import { defineWorkflow } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "my-workflow",
  description: "Two-session pipeline: describe -> summarize",
  inputs: [{ name: "prompt", type: "text", required: true, description: "task prompt" }],
}).for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    const describe = await ctx.stage(
      { name: "describe", description: "Ask Claude to describe the project" },
      {}, {},
      async (s) => {
        await s.session.query(prompt);
        s.save(s.sessionId);
      },
    );

    await ctx.stage(
      { name: "summarize", description: "Summarize the previous session's output" },
      {}, {},
      async (s) => {
        const research = await s.transcript(describe);
        await s.session.query(`Read ${research.path} and summarize in 2-3 bullets.`);
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

</details>

<details>
<summary><b>Example: Parallel workflow (describe → [summarize-a, summarize-b] → merge)</b></summary>

```ts
import { defineWorkflow } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "parallel-demo",
  description: "describe -> [summarize-a, summarize-b] -> merge",
  inputs: [{ name: "prompt", type: "text", required: true, description: "task prompt" }],
}).for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    const describe = await ctx.stage({ name: "describe" }, {}, {}, async (s) => {
      await s.session.query(prompt);
      s.save(s.sessionId);
    });

    const [summarizeA, summarizeB] = await Promise.all([
      ctx.stage({ name: "summarize-a" }, {}, {}, async (s) => {
        const research = await s.transcript(describe);
        await s.session.query(`Read ${research.path} and summarize in 2-3 bullets.`);
        s.save(s.sessionId);
      }),
      ctx.stage({ name: "summarize-b" }, {}, {}, async (s) => {
        const research = await s.transcript(describe);
        await s.session.query(`Read ${research.path} and summarize in one sentence.`);
        s.save(s.sessionId);
      }),
    ]);

    await ctx.stage({ name: "merge" }, {}, {}, async (s) => {
      const bullets = await s.transcript(summarizeA);
      const oneliner = await s.transcript(summarizeB);
      await s.session.query(
        `Combine:\n\n## Bullets\n${bullets.content}\n\n## One-liner\n${oneliner.content}`,
      );
      s.save(s.sessionId);
    });
  })
  .compile();
```

</details>

<details>
<summary><b>Example: Structured-input workflow (declared schema + CLI flag validation)</b></summary>

Declare `inputs` on `defineWorkflow` and the CLI materialises one `--<field>=<value>` flag per entry. Required fields, enum membership, and unknown-flag rejection are validated before any tmux session spawns. The interactive picker renders the same schema as a form.

```ts
import { defineWorkflow } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "gen-spec",
  description: "Convert a research doc into an execution spec",
  inputs: [
    {
      name: "research_doc",
      type: "string",
      required: true,
      description: "path to the research doc",
      placeholder: "research/docs/2026-04-11-auth.md",
    },
    {
      name: "focus",
      type: "enum",
      required: true,
      description: "how aggressively to scope the spec",
      values: ["minimal", "standard", "exhaustive"],
      default: "standard",
    },
    {
      name: "notes",
      type: "text",
      description: "extra guidance for the spec writer (optional)",
    },
  ],
}).for("claude")
  .run(async (ctx) => {
    const { research_doc, focus } = ctx.inputs;
    const notes = ctx.inputs.notes ?? "";

    await ctx.stage({ name: "write-spec" }, {}, {}, async (s) => {
      await s.session.query(
        `Read ${research_doc} and produce a ${focus} spec.` +
          (notes ? `\n\nExtra guidance:\n${notes}` : ""),
      );
      s.save(s.sessionId);
    });
  })
  .compile();
```

Wire it into `src/claude-worker.ts` (three lines — see [step 4 of Quick Start](#4-build-your-own-workflow--sdk)) and run it:

```bash
# Scriptable; CI-friendly
bun run src/claude-worker.ts \
  --research_doc=research/docs/2026-04-11-auth.md \
  --focus=standard
```

</details>

<details>
<summary><b>Example: Headless (background) stages for parallel data gathering</b></summary>

Stages can run headlessly (`headless: true`) — they execute the provider SDK in-process instead of spawning a tmux window. Headless stages are invisible in the graph but tracked via a background counter in the statusline.

```ts
import { defineWorkflow, extractAssistantText } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "headless-demo",
  description: "seed -> [3 headless background] -> merge",
  inputs: [{ name: "prompt", type: "text", required: true, description: "task prompt" }],
}).for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    const seed = await ctx.stage(
      { name: "seed", description: "Generate overview" }, {}, {},
      async (s) => {
        const result = await s.session.query(prompt);
        s.save(s.sessionId);
        return extractAssistantText(result, 0);
      },
    );

    const [pros, cons, uses] = await Promise.all([
      ctx.stage({ name: "pros", headless: true }, {}, {}, async (s) => {
        const r = await s.session.query(`List 3 pros:\n\n${seed.result}`);
        s.save(s.sessionId);
        return extractAssistantText(r, 0);
      }),
      ctx.stage({ name: "cons", headless: true }, {}, {}, async (s) => {
        const r = await s.session.query(`List 3 cons:\n\n${seed.result}`);
        s.save(s.sessionId);
        return extractAssistantText(r, 0);
      }),
      ctx.stage({ name: "uses", headless: true }, {}, {}, async (s) => {
        const r = await s.session.query(`List 3 use cases:\n\n${seed.result}`);
        s.save(s.sessionId);
        return extractAssistantText(r, 0);
      }),
    ]);

    await ctx.stage(
      { name: "merge", description: "Combine results" }, {}, {},
      async (s) => {
        await s.session.query(
          `Combine:\n\n## Pros\n${pros.result}\n\n## Cons\n${cons.result}\n\n## Uses\n${uses.result}`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

The graph shows `seed → merge` — headless stages are transparent to the topology. The callback API (`s.client`, `s.session`, `s.save()`, `s.transcript()`, return values) is identical to interactive stages.

</details>

**Key capabilities:**

| Capability                         | Description                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Dynamic session spawning**       | `ctx.stage()` spawns sessions at runtime — each gets its own tmux window and graph node                                            |
| **Native TypeScript control flow** | Use `for`, `if/else`, `Promise.all()`, `try/catch` — no framework DSL                                                              |
| **Review gates and approvals**     | Pause for human input, run structured review stages, and decide whether the next stage should continue                             |
| **Session return values**          | Session callbacks can return data: `const h = await ctx.stage(...); h.result`                                                      |
| **Transcript passing**             | Access prior output via handle (`s.transcript(handle)`) or name (`s.transcript("name")`)                                           |
| **Declared input schemas**         | Add an `inputs: [...]` array and the CLI materialises `--<field>=<value>` flags with built-in validation                           |
| **Interactive picker**             | `atomic workflow -a <agent>` is the explicit no-`-n` discovery path; direct runs use `-n <name>`                                   |
| **Nested sub-sessions**            | `s.stage()` inside a callback spawns child sessions — visible as nested graph nodes                                                |
| **Auto-inferred graph**            | Topology derived from `await` / `Promise.all` patterns — no annotations                                                            |
| **Provider-agnostic**              | Write raw SDK code for Claude, Copilot, or OpenCode inside each callback                                                           |
| **Live graph visualization**       | Sessions appear in the TUI graph as they spawn — loops and conditionals visible in real time                                       |
| **Background (headless) stages**   | `headless: true` runs in-process without a tmux window — invisible in graph, tracked by statusline counter, identical callback API |
| **Token-aware handoffs**           | Save transcripts to disk and pass paths or distilled outputs forward instead of stuffing every stage with the full history         |

**Deterministic execution guarantees:**

Workflows are deterministic by design — the same definition produces the same execution order with the same data flow, anywhere.

- **Strict step ordering** — Step 2 never starts until Step 1 finishes. Parallel sessions complete (or fail fast) before the next step begins.
- **Frozen definitions** — `.compile()` freezes the workflow. Once compiled, step order, session names, and the execution graph are immutable.
- **Controlled transcript access** — Sessions only read transcripts from *completed* upstream sessions; parallel siblings can't read each other.
- **Isolated context windows** — Each session runs in its own tmux pane with a fresh context. Data flows only through explicit `ctx.transcript()` / `ctx.getMessages()` calls.
- **Persisted artifacts** — Every session writes messages, transcript, and metadata to disk — a complete, inspectable execution record.

Variance comes from the LLM's responses, not from a changing workflow.

> Ask Atomic to build workflows for you: `Use your workflow-creator skill to create a workflow that plans, implements, and reviews a feature.`

<details>
<summary><b>Full Workflow SDK Reference</b></summary>

#### Builder API

| Method                                  | Purpose                                                           |
| --------------------------------------- | ----------------------------------------------------------------- |
| `defineWorkflow({ name, description })` | Entry point — returns a `WorkflowBuilder`                         |
| `.run(async (ctx) => { ... })`          | Set the workflow's entry point — `ctx` is a `WorkflowContext`     |
| `.compile()`                            | **Required** — terminal method that seals the workflow definition |

#### WorkflowContext (`ctx`) — top-level workflow context

| Property                                       | Type                        | Description                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.inputs`                                   | `{ [K in N]?: string }`     | Typed inputs for this run — only declared field names are valid keys. Accessing an undeclared field is a compile-time error. Workflows that need a prompt must declare it in their `inputs` schema |
| `ctx.agent`                                    | `AgentType`                 | Which agent is running (`"claude"`, `"copilot"`, `"opencode"`)                                                                                                                                     |
| `ctx.stage(opts, clientOpts, sessionOpts, fn)` | `Promise<SessionHandle<T>>` | Spawn a session — returns handle with `name`, `id`, `result`                                                                                                                                       |
| `ctx.transcript(ref)`                          | `Promise<Transcript>`       | Get a completed session's transcript (`{ path, content }`)                                                                                                                                         |
| `ctx.getMessages(ref)`                         | `Promise<SavedMessage[]>`   | Get a completed session's raw native messages                                                                                                                                                      |

#### SessionContext (`s`) — inside each session callback

| Property                                     | Type                        | Description                                                                                                                     |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `s.client`                                   | `ProviderClient<A>`         | Pre-created SDK client (auto-managed by runtime)                                                                                |
| `s.session`                                  | `ProviderSession<A>`        | Pre-created provider session (auto-managed by runtime)                                                                          |
| `s.inputs`                                   | `{ [K in N]?: string }`     | Same typed inputs as `ctx.inputs`, forwarded into every stage so callbacks can read values without closing over the outer `ctx` |
| `s.agent`                                    | `AgentType`                 | Which agent is running                                                                                                          |
| `s.paneId`                                   | `string`                    | tmux pane ID for this session                                                                                                   |
| `s.sessionId`                                | `string`                    | Session UUID                                                                                                                    |
| `s.sessionDir`                               | `string`                    | Path to this session's storage directory on disk                                                                                |
| `s.save(messages)`                           | `SaveTranscript`            | Save this session's output for subsequent sessions                                                                              |
| `s.transcript(ref)`                          | `Promise<Transcript>`       | Get a completed session's transcript                                                                                            |
| `s.getMessages(ref)`                         | `Promise<SavedMessage[]>`   | Get a completed session's raw native messages                                                                                   |
| `s.stage(opts, clientOpts, sessionOpts, fn)` | `Promise<SessionHandle<T>>` | Spawn a nested sub-session (child in the graph)                                                                                 |

#### Session Options (`SessionRunOptions`)

| Property      | Type       | Description                                                                                           |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| `name`        | `string`   | Unique session name within the workflow run                                                           |
| `description` | `string?`  | Human-readable description shown in the graph                                                         |
| `headless`    | `boolean?` | When `true`, run in-process without a tmux window — invisible in graph, tracked by background counter |

The runtime auto-infers parent-child edges from execution order: sequential `await` creates a chain, `Promise.all` creates parallel fan-out/fan-in — no annotations needed.

#### Saving Transcripts

Each provider saves transcripts differently:

| Provider     | How to Save                                                       |
| ------------ | ----------------------------------------------------------------- |
| **Claude**   | `s.save(s.sessionId)` — auto-reads via `getSessionMessages()`     |
| **Copilot**  | `s.save(await session.getMessages())` — pass `SessionEvent[]`     |
| **OpenCode** | `s.save(result.data!)` — pass the full `{ info, parts }` response |

#### Per-Agent Session APIs

The runtime auto-creates `s.client` and `s.session` — use them directly inside the callback:

| Agent        | How to send a prompt                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **Claude**   | `await s.session.query(prompt)`                                                                       |
| **Copilot**  | `await s.session.send({ prompt })`                                                                    |
| **OpenCode** | `await s.client.session.prompt({ sessionID: s.session.id, parts: [{ type: "text", text: prompt }] })` |

#### Key Rules

1. Every workflow definition must call `.run()` and `.compile()` on the builder
2. Session names must be unique within a workflow run
3. `transcript()` / `getMessages()` only access completed sessions (callback returned + saves flushed)
4. Each session runs in its own tmux window with the chosen agent
5. Run a workflow by calling `runWorkflow({ workflow, inputs })` from inside any CLI library (Commander, citty, yargs, …). Use `listWorkflows(registry)` to iterate when registering multiple workflows.
6. Set up your workflow project with `bun init && bun add @bastani/atomic-sdk`
7. Background (headless) stages use the same callback API — `s.client`, `s.session`, `s.save()`, return values all work identically

For the authoring walkthrough ask Atomic to use the `workflow-creator` skill or read `.agents/skills/workflow-creator/`.

> [!TIP]
> When the Workflow SDK is updated, ask the `workflow-creator` skill to migrate your workflows to the latest patterns: _"Update this workflow to use the latest SDK patterns."_

</details>

### Research Codebase

The `/research-codebase` command dispatches **specialized sub-agents in parallel** to analyze your codebase — understand auth flows, trace root causes, query docs, and hit external sources via [DeepWiki MCP](https://deepwiki.com). Get up to speed on a new project in minutes instead of hours.

| Sub-Agent                    | Model  | Purpose                                                                               |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------- |
| `codebase-locator`           | Haiku  | Locate files, directories, and components relevant to the research topic              |
| `codebase-analyzer`          | Sonnet | Analyze implementation details, trace data flow, explain technical workings           |
| `codebase-pattern-finder`    | Haiku  | Find similar implementations, usage examples, and existing patterns to model after    |
| `codebase-online-researcher` | Sonnet | Fetch up-to-date information from the web and repository knowledge from DeepWiki      |
| `codebase-research-locator`  | Haiku  | Discover relevant documents in `research/` and `specs/` directories                   |
| `codebase-research-analyzer` | Sonnet | Extract high-value insights, decisions, and technical details from research documents |

**Run parallel research sessions** to compare approaches:

```bash
# Terminal 1: LangChain approach
atomic chat -a claude "/research-codebase Research GraphRAG using LangChain's graph retrieval."

# Terminal 2: Microsoft GraphRAG
atomic chat -a claude "/research-codebase Research GraphRAG using microsoft/graphrag."

# Terminal 3: LlamaIndex approach
atomic chat -a claude "/research-codebase Research GraphRAG using LlamaIndex's property graph."
```

Then run `/create-spec` on each output, spin up git worktrees, and run `atomic workflow -n ralph -a <agent>` in each — wake up to three complete implementations on separate branches. Research persists in `research/` and specs in `specs/`, so every investigation compounds into future context.

<details>
<summary><i>Why specialized research agents instead of one general-purpose agent?</i></summary>

A single agent asked to "research the auth system" tries to search, read, analyze, and summarize within one context window. As that window fills with file contents, search results, and intermediate reasoning, synthesis degrades — this is a fundamental constraint of transformer attention, not a prompt-engineering problem.

Atomic dispatches purpose-built sub-agents: a `codebase-locator` only finds relevant files, a `codebase-analyzer` only reads and analyzes implementations, a `codebase-online-researcher` only queries external docs. Each operates in its own context with only the tools it needs; the parent receives distilled findings. The result: faster research, higher-quality findings, less hallucination.

</details>

### Autonomous Execution (Ralph)

<p align="center">
  <img src="assets/ralph-wiggum.jpg" alt="Ralph Wiggum" width="600">
</p>

The [Ralph Method](https://ghuntley.com/ralph/) enables **multi-hour autonomous coding sessions**. Approve your spec, let Ralph work in the background, focus on other things.

**How Ralph works:**

1. **Task Decomposition** — A `planner` sub-agent breaks your spec into a task list with dependency tracking, stored in SQLite (WAL mode for parallel access).
2. **Execution** — An `orchestrator` retrieves the task list, validates the dependency graph, and dispatches `worker` sub-agents for ready tasks.
3. **Review & Debug** — A `reviewer` audits the implementation with structured JSON output; if P0–P2 findings exist, a `debugger` investigates root causes and feeds back to the planner on the next iteration.

**Loop config:** Up to **10 iterations**. Exits early after **2 consecutive clean reviews** (zero actionable findings). P3 (minor) findings are non-actionable.

```bash
# From a prompt
atomic workflow -n ralph -a <claude|opencode|copilot> "Build a REST API for user management"

# From a spec file
atomic workflow -n ralph -a claude "specs/YYYY-MM-DD-my-feature.md"
```

**Best practice:** run Ralph in a [git worktree](https://git-scm.com/docs/git-worktree) so autonomous changes stay isolated from your working tree:

```bash
git worktree add ../my-project-ralph feature-branch
cd ../my-project-ralph
atomic workflow -n ralph -a claude "Build the auth module"
```

### Deep Research Codebase

Atomic ships a `deep-research-codebase` workflow that performs **multi-agent parallel research** across your codebase — a full pipeline, not a single-shot command.

1. **Scout** — One agent scans the codebase structure and writes an architectural orientation.
2. **History** — A parallel agent surfaces prior research from `research/docs/`.
3. **Explorers** — Multiple parallel agents (count scaled by LOC) each investigate a partition.
4. **Aggregator** — A final agent synthesizes all explorer reports + history into a dated research doc at `research/docs/YYYY-MM-DD-<slug>.md`.

```bash
atomic workflow -n deep-research-codebase -a claude "How does the authentication system work?"
```

The output is a permanent research artifact that future runs, specs, and workflows can reference.

### Containerized Execution

Atomic ships as **devcontainer features** that bundle the CLI, agent, and all dependencies into isolated containers — the recommended way to run autonomous agents safely.

**Why containerize?**

- Agents run `rm`, `git reset --hard`, and arbitrary shell commands — containers limit blast radius
- Reproducible environments across team members and CI
- Pre-installed dependencies: bun, playwright-cli, agent CLI, GitHub CLI
- Features versioned in sync with Atomic releases

| Feature                              | Installs             |
| ------------------------------------ | -------------------- |
| `ghcr.io/flora131/atomic/claude:1`   | Atomic + Claude Code |
| `ghcr.io/flora131/atomic/opencode:1` | Atomic + OpenCode    |
| `ghcr.io/flora131/atomic/copilot:1`  | Atomic + Copilot CLI |

See [Quick Start → Devcontainer](#1-install) for a working `.devcontainer.json` and the [`.devcontainer/`](./.devcontainer/) directory for per-agent templates.

### Specialized Sub-Agents

Atomic dispatches **purpose-built sub-agents**, each with scoped context, tools, and termination conditions:

| Sub-Agent                    | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `planner`                    | Decompose specs into structured task lists with dependency tracking |
| `worker`                     | Implement single focused tasks (multiple workers run in parallel)   |
| `reviewer`                   | Audit implementations against specs and best practices              |
| `code-simplifier`            | Simplify and refine code for clarity, consistency, maintainability  |
| `orchestrator`               | Coordinate complex multi-step workflows                             |
| `codebase-analyzer`          | Analyze implementation details of specific components               |
| `codebase-locator`           | Locate files, directories, and components                           |
| `codebase-pattern-finder`    | Find similar implementations and usage examples                     |
| `codebase-online-researcher` | Research using web sources and DeepWiki                             |
| `codebase-research-analyzer` | Deep dive on research topics                                        |
| `codebase-research-locator`  | Find documents in `research/` directory                             |
| `debugger`                   | Debug errors, test failures, and unexpected behavior                |

<details>
<summary><i>Why specialize instead of using one general-purpose agent?</i></summary>

LLMs have an architectural limitation: the more context they hold, the harder it becomes to attend to the right information. A single agent juggling a spec, dozens of files, tool outputs, and its own reasoning will lose details, repeat work, or hallucinate connections. This isn't solvable via prompt engineering — it's how attention mechanisms work.

Specialized sub-agents turn the limitation into an advantage:

- **Context isolation** — Fresh, minimal context scoped to one job. A `codebase-locator` doesn't carry file contents; a `worker` doesn't carry the full spec.
- **Tool scoping** — Agents only see tools relevant to their role. A `reviewer` has read-only tools and can't edit files; a `worker` has edit tools but can't spawn other workers.
- **Parallel execution** — Independent sub-agents run concurrently. One worker writes the migration, another writes the handler, a third generates tests — all at once.
- **Composability** — Sub-agents combine into workflows or dispatch ad-hoc. The same `reviewer` used by Ralph is the one invoked when you ask for a code review in chat.

A specialized `codebase-analyzer` reading three files produces more accurate output than a generalist that has already consumed 50,000 tokens of search results and prior reasoning.

</details>

Use `/agents` in any chat session to see all available sub-agents.

### Built-in Skills

Skills are structured capability modules that give agents best practices and reusable workflows. Atomic ships **57 skills** across eight categories; each lives at `.agents/skills/<name>/SKILL.md` and is auto-invoked when the agent detects a relevant trigger.

<details>
<summary><b>Development workflows</b></summary>

| Skill               | Description                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `init`              | Generate `CLAUDE.md` and `AGENTS.md` by exploring the codebase              |
| `research-codebase` | Analyze codebase with parallel sub-agents and document findings             |
| `create-spec`       | Create detailed execution plans from research documents                     |
| `workflow-creator`  | Create multi-agent workflows using the session-based `defineWorkflow()` API |
| `explain-code`      | Explain code functionality in detail using DeepWiki                         |
| `find-skills`       | Discover and install agent skills from the community                        |
| `tdd`               | Write tests first; includes a testing anti-patterns guide                   |
| `prompt-engineer`   | Create, improve, and optimize prompts using best practices                  |

</details>

<details>
<summary><b>Context engineering</b> — working within (and around) LLM context limits</summary>

| Skill                  | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `context-fundamentals` | How context windows work; attention mechanics; progressive disclosure |
| `context-degradation`  | Diagnose lost-in-middle, poisoning, distraction failures in long runs |
| `context-compression`  | Summarize transcripts at session boundaries; preserve actionable info |
| `context-optimization` | KV-cache optimization, observation masking, context budgeting         |
| `filesystem-context`   | Offload context to files; file-based agent coordination               |
| `memory-systems`       | Cross-session knowledge retention; Mem0 / Zep / Letta comparisons     |
| `multi-agent-patterns` | Supervisor, swarm, handoff patterns for multi-agent systems           |
| `tool-design`          | Design clear tool contracts; reduce agent-tool friction               |
| `hosted-agents`        | Background agents in sandboxed VMs; warm pools; Modal sandboxes       |
| `project-development`  | Validate task-model fit before building; cost estimation              |
| `bdi-mental-states`    | Belief-desire-intention models for explainable agent reasoning        |

</details>

<details>
<summary><b>TypeScript & runtime</b></summary>

| Skill                       | Description                                                             |
| --------------------------- | ----------------------------------------------------------------------- |
| `typescript-expert`         | Type-level programming, perf optimization, migrations                   |
| `typescript-advanced-types` | Generics, conditional types, mapped types, template literals            |
| `typescript-react-reviewer` | Expert review for TypeScript + React 19 applications                    |
| `bun`                       | Build, test, deploy with Bun (runtime, package manager, bundler, tests) |
| `opentui`                   | Build terminal UIs with OpenTUI (core, React, Solid reconcilers)        |

</details>

<details>
<summary><b>Frontend design & UI polish</b> — used by `impeccable` and invoked individually for targeted refinement</summary>

| Skill                                          | Description                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `impeccable`                                   | Create distinctive, production-grade frontend interfaces                       |
| `polish`                                       | Final quality pass on alignment, spacing, consistency                          |
| `critique`                                     | UX evaluation with quantitative scoring and persona testing                    |
| `audit`                                        | Accessibility, performance, theming, responsive, anti-pattern audit            |
| `layout` / `typeset` / `colorize`              | Layout, typography, and color refinement                                       |
| `adapt`                                        | Responsive design: breakpoints, fluid layouts, touch targets                   |
| `animate` / `delight`                          | Add motion, micro-interactions, and personality                                |
| `clarify`                                      | Improve UX copy, error messages, microcopy, labels                             |
| `distill` / `quieter` / `bolder` / `overdrive` | Simplify, tone down, amplify, or push designs to their limit                   |
| `harden`                                       | Error handling, onboarding, empty states, i18n, overflow, edge-case resilience |
| `optimize`                                     | Diagnose and fix loading, rendering, animation, bundle-size issues             |

</details>

<details>
<summary><b>Evaluation, documents, git, meta</b></summary>

**Evaluation:**

| Skill                 | Description                                                         |
| --------------------- | ------------------------------------------------------------------- |
| `evaluation`          | Multi-dimensional evaluation, LLM-as-judge, quality gates           |
| `advanced-evaluation` | Pairwise comparison, position-bias mitigation, evaluation pipelines |

**Documents & parsing:**

| Skill       | Description                                                             |
| ----------- | ----------------------------------------------------------------------- |
| `pdf`       | Read, create, edit, split, merge, and OCR PDF files                     |
| `xlsx`      | Create, read, edit, and fix spreadsheet files (`.xlsx`, `.csv`, `.tsv`) |
| `docx`      | Create, read, edit, and manipulate Word (`.docx`) documents             |
| `pptx`      | Create, read, edit, and manipulate PowerPoint (`.pptx`) slide decks     |
| `liteparse` | Parse and convert unstructured files (PDF, DOCX, PPTX, images) locally  |

**Git / Azure DevOps / Sapling / automation:**

| Skill            | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `gh-commit`      | Conventional-commit Git commits                                             |
| `gh-create-pr`   | Commit unstaged changes, push, and submit a GitHub PR                       |
| `ado-commit`     | Conventional-commit Git commits for Azure DevOps (adds `AB#<id>` trailers)  |
| `ado-create-pr`  | Commit, push, and open an Azure DevOps PR via the `azure-devops` MCP server |
| `sl-commit`      | Conventional-commit Sapling commits                                         |
| `sl-submit-diff` | Submit Sapling commits as Phabricator diffs                                 |
| `playwright-cli` | Automate browser interactions, tests, screenshots                           |

> **Note on source control providers:** the GitHub and Azure DevOps MCP servers are **disabled by default** to avoid consuming tokens on projects that don't need them. Set `scm` in `.atomic/settings.json` (or run `atomic config set scm <provider>`) to `github`, `azure-devops`, or `sapling` — on every `atomic chat` / `atomic workflow` startup Atomic reconciles `.claude/settings.json` (`disabledMcpjsonServers`), `.opencode/opencode.json` (`mcp.<server>.enabled`), and appends `--disable-mcp-server <name>` to the Copilot CLI invocation (Copilot has no on-disk MCP toggle). `sapling` disables both servers everywhere.

**Meta:**

| Skill           | Description                                             |
| --------------- | ------------------------------------------------------- |
| `skill-creator` | Create, modify, evaluate, and benchmark your own skills |

</details>

Skills are auto-invoked when relevant. Run `ls .agents/skills/` for the complete, current list on disk.

### Workflow Panel

During `atomic workflow` execution, Atomic renders a live workflow panel built on [OpenTUI](https://github.com/anomalyco/opentui) over the workflow's tmux session graph. It shows:

- **Session graph** — Nodes per `.stage()` with status (pending / running / completed / failed) and edges for sequential / parallel dependencies
- **Task list tracking** — Ralph's decomposed task list with dependency arrows, updated in real time
- **Pane previews** — Thumbnail of each tmux pane so you can see every agent without context-switching
- **Transcript passing visibility** — Highlights `s.save()` / `s.transcript()` handoffs as they happen

During `atomic chat`, there is no Atomic-owned TUI — `atomic chat -a <agent>` spawns the native agent CLI inside a tmux session, so chat features (streaming, `@` mentions, `/slash-commands`, model selection, theme, keyboard shortcuts) come from the agent CLI itself. Atomic handles config sync, tmux session management, and argument passthrough.

| Context                                | UI provider                                                 |
| -------------------------------------- | ----------------------------------------------------------- |
| `atomic workflow -n <name> -a <agent>` | Atomic (workflow panel + tmux session graph)                |
| `atomic chat -a <agent>`               | The native agent CLI (Claude Code / OpenCode / Copilot CLI) |

---

## Commands Reference

### CLI Commands

| Command                         | Description                                                       |
| ------------------------------- | ----------------------------------------------------------------- |
| `atomic chat`                   | Spawn the native agent CLI inside a tmux session                  |
| `atomic workflow`               | Run a named multi-session workflow with the Atomic workflow panel |
| `atomic workflow list`          | List available workflows, grouped by source                       |
| `atomic session list`           | List all running sessions on the atomic tmux socket               |
| `atomic session connect [name]` | Attach to a session (interactive picker when no name given)       |
| `atomic session kill [name]`    | Kill one session, or pick sessions interactively when no name is given |
| `atomic completions <shell>`    | Output shell completion script (bash, zsh, fish, powershell)      |
| `atomic config set <k> <v>`     | Set configuration values (supports `telemetry` and `scm`)         |

#### Global Flags

| Flag            | Description                                |
| --------------- | ------------------------------------------ |
| `-y, --yes`     | Auto-confirm all prompts (non-interactive) |
| `--no-banner`   | Skip ASCII banner display                  |
| `-v, --version` | Show version number                        |

#### `atomic session` Subcommands

Available at three levels — scoped or global:

| Command                                  | Description                                             |
| ---------------------------------------- | ------------------------------------------------------- |
| `atomic session list`                    | List all running sessions                               |
| `atomic session connect [name]`          | Attach to a session (interactive picker when no name)   |
| `atomic session kill [name]`             | Kill one session, or interactively pick sessions        |
| `atomic chat session list`               | List running chat sessions only                         |
| `atomic chat session connect [name]`     | Attach to a chat session                                |
| `atomic chat session kill [name]`        | Kill one chat session, or interactively pick chat sessions |
| `atomic workflow session list`           | List running workflow sessions only                     |
| `atomic workflow session connect [name]` | Attach to a workflow session                            |
| `atomic workflow session kill [name]`    | Kill one workflow session, or interactively pick workflow sessions |

`list`, `connect`, and `kill` accept `-a <agent>` (repeatable) to filter by agent. `kill` confirms before terminating sessions unless `-y` / `--yes` is passed. When no session name is given, `kill` opens a checkbox picker with an "All matching sessions" option; use `--all` to skip the picker and preselect every matching session.

```bash
atomic session list                      # all sessions
atomic session list -a claude            # only Claude sessions
atomic session connect my-session        # attach by name
atomic session connect                   # interactive picker
atomic chat session list -a copilot      # chat sessions for Copilot only
atomic session kill my-session           # kill one session by name
atomic session kill                      # choose sessions with a multi-select picker
atomic session kill --all                # kill all sessions after confirmation
atomic session kill --all --yes          # kill all sessions without prompts
atomic workflow session kill -a claude   # choose Claude workflow sessions to kill
atomic workflow session kill -a claude --all --yes
```

#### `atomic chat` Flags

| Flag                 | Description                            |
| -------------------- | -------------------------------------- |
| `-a, --agent <name>` | Agent: `claude`, `opencode`, `copilot` |

All other arguments are forwarded directly to the native agent CLI:

```bash
atomic chat -a claude "fix the bug"          # initial prompt
atomic chat -a copilot --model gpt-5.4       # custom model
atomic chat -a claude --verbose              # forward --verbose to claude
```

#### `atomic workflow` Flags

| Flag                 | Description                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-n, --name <name>`  | Workflow name (required for direct runs; omit only for the interactive picker)                                                                    |
| `-a, --agent <name>` | Agent: `claude`, `opencode`, `copilot`                                                                                                            |
| `-d, --detach`       | Start the workflow in the background without attaching — ideal for scripted / CI runs; attach later with `atomic workflow session connect <name>` |
| `--<field>=<value>`  | Structured input for workflows that declare an `inputs` schema (also accepts `--<field> <value>`)                                                 |
| `[prompt...]`        | Positional prompt — requires the workflow to declare a `prompt` input                                                                             |

Five invocation shapes:

```bash
# 1. List every workflow available, grouped by source
atomic workflow list
atomic workflow list -a claude       # filter by agent

# 2. Launch the interactive picker (no -n) — fuzzy-search, fill the form, confirm with y/n
atomic workflow -a claude

# 3. Run with a positional prompt (workflow must declare a "prompt" input)
atomic workflow -n ralph -a claude "build a REST API for user management"

# 4. Run a structured-input workflow with one --<field> flag per declared input
atomic workflow -n open-claude-design -a claude \
  --prompt="a dashboard for monitoring API latency" \
  --output-type=prototype

# 5. Run detached — workflow runs in the background; prints the session name
#    and returns immediately. Attach any time with `atomic workflow session connect`.
atomic workflow -n ralph -a claude -d "build a REST API for user management"
```

Workflows that declare `inputs: WorkflowInput[]` get CLI flag validation for free. **Builtin workflows (e.g. `ralph`) are reserved** — a local/global workflow with the same name will not shadow a builtin.

#### `atomic completions` — Shell Completions

Atomic ships tab-completion for **bash**, **zsh**, **fish**, and **PowerShell**. Cache the script once so new shells don't re-spawn the atomic binary on startup.

<details>
<summary><b>Bash / Zsh / Fish / PowerShell setup</b></summary>

**Bash**

```bash
mkdir -p ~/.atomic/completions
atomic completions bash > ~/.atomic/completions/atomic.bash
echo '[ -f "$HOME/.atomic/completions/atomic.bash" ] && source "$HOME/.atomic/completions/atomic.bash"' >> ~/.bashrc
```

**Zsh**

```zsh
mkdir -p ~/.atomic/completions
atomic completions zsh > ~/.atomic/completions/atomic.zsh
echo '[ -f "$HOME/.atomic/completions/atomic.zsh" ] && source "$HOME/.atomic/completions/atomic.zsh"' >> ~/.zshrc
```

**Fish**

```fish
atomic completions fish > ~/.config/fish/completions/atomic.fish
```

**PowerShell**

```powershell
$cache = Join-Path $HOME '.atomic\completions\atomic.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path $cache) | Out-Null
atomic completions powershell | Out-File -FilePath $cache -Encoding utf8
Add-Content $PROFILE "`nif (Test-Path `"$cache`") { . `"$cache`" }"
```

</details>

> The bootstrap installer (`install.sh` / `install.ps1` / `install.cmd`) sets this up automatically and migrates older `eval "$(atomic completions …)"` snippets to the cached form.

### Atomic-Provided Skills (invokable from any agent chat)

Atomic ships skills — not slash commands. Skills are auto-discovered by Claude Code, OpenCode, and Copilot CLI, invoked by typing `/<skill-name>` (Claude Code) or by natural-language reference (OpenCode / Copilot CLI).

| Skill               | Typical invocation                | Purpose                                                                         |
| ------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| `init`              | `/init`                           | Generate `CLAUDE.md` and `AGENTS.md` by exploring the codebase                  |
| `research-codebase` | `/research-codebase "<question>"` | Dispatch parallel sub-agents to analyze the codebase and write a research doc   |
| `create-spec`       | `/create-spec "<research-path>"`  | Produce a technical spec grounded in a research document                        |
| `explain-code`      | `/explain-code "<path>"`          | Deep-dive explanation of specific code using DeepWiki                           |
| `gh-commit`         | `/gh-commit`                      | Create a conventional-commit Git commit                                         |
| `gh-create-pr`      | `/gh-create-pr`                   | Commit, push, and open a GitHub pull request                                    |
| `ado-commit`        | `/ado-commit`                     | Create a conventional-commit Git commit on an Azure DevOps-hosted repo          |
| `ado-create-pr`     | `/ado-create-pr`                  | Commit, push, and open an Azure DevOps PR through the `azure-devops` MCP server |
| `sl-commit`         | `/sl-commit`                      | Create a Sapling commit                                                         |
| `sl-submit-diff`    | `/sl-submit-diff`                 | Submit a Sapling commit as a Phabricator diff                                   |
| `workflow-creator`  | natural language                  | Generate a multi-agent workflow definition using `defineWorkflow` + registry    |

Native slash commands (`/help`, `/clear`, `/compact`, `/model`, `/theme`, `/agents`, `/mcp`, `/exit`) come from the underlying agent CLI, not Atomic.

---

## Building your own atomic-powered app

`@bastani/atomic-sdk/workflows` is a library, not just a CLI. Use it directly to build your own TypeScript app that runs your team's workflows.

> **SDK-only users:** you don't need the global `atomic` binary, but you still need the runtime prerequisites — **[Bun](https://bun.sh/) (the SDK does not run on Node.js)**, a terminal multiplexer (tmux on macOS/Linux, psmux on Windows), and at least one authenticated coding agent CLI (`claude`, `opencode`, or `copilot`). See [Prerequisites](#prerequisites) for the "why" and install commands. The SDK spawns the agent CLI at each stage and wraps it in a detachable multiplexer session.
>
> **Session management primitives.** The SDK exposes `listSessions`, `getSession`, `stopSession`, `attachSession`, `detachSession`, `getSessionStatus`, `getSessionTranscript`, plus pane-navigation verbs `nextWindow` / `previousWindow` / `gotoOrchestrator` — wire them into your CLI's `session list`, `status`, etc. subcommands as you see fit. Sessions live on the shared `atomic` tmux socket, so a worker CLI built on the primitives, the global `atomic` binary, and `bunx atomic` all see the same runtime state.
>
> **Typed errors.** Every error path the SDK throws — missing tmux/psmux/bun, unknown session id, missing `.compile()`, invalid workflow file, `minSDKVersion` mismatch — is a typed class (`MissingDependencyError`, `SessionNotFoundError`, `WorkflowNotCompiledError`, `InvalidWorkflowError`, `IncompatibleSDKError`). Catch them with `instanceof` to render friendly CLI output without parsing message text. See `examples/pane-navigation/cli.ts` for a worked example.

### Primitives, not a wrapper

The SDK ships pure functions you compose into whatever CLI shape you want:

| Primitive                                                                                                                | Purpose                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineWorkflow`                                                                                                         | Author a workflow with `.for(agent).run(...).compile()`. Pass `source: import.meta.path`.                                                                                                                           |
| `createRegistry`                                                                                                         | Build an immutable registry of workflows for iteration / lookup.                                                                                                                                                    |
| `listWorkflows(reg)`                                                                                                     | Snapshot every workflow in a registry.                                                                                                                                                                              |
| `getWorkflow(reg, …)`                                                                                                    | Resolve `(agent, name)` → workflow.                                                                                                                                                                                 |
| `getName / getAgent / getInputSchema / getDescription / getSource / getMinSDKVersion`                                    | Read workflow metadata.                                                                                                                                                                                             |
| `validateInputs(wf, raw)`                                                                                                | Run the same validation pipeline atomic uses (required, defaults, enum, integer).                                                                                                                                   |
| `runWorkflow({ workflow, inputs, detach?, pathToAtomicExecutable? })`                                                    | Spawn the orchestrator tmux session and (optionally) attach. Resolves with `{ id, tmuxSessionName }`. `pathToAtomicExecutable` overrides the self-exec target — see [Overriding the self-exec target](#overriding-the-self-exec-target). |
| `listSessions / getSession / stopSession / attachSession / detachSession`                                                | Manage running tmux sessions on the shared atomic socket.                                                                                                                                                           |
| `getSessionStatus / getSessionTranscript`                                                                                | Read the orchestrator-written status snapshot or per-session messages from disk.                                                                                                                                    |
| `nextWindow / previousWindow / gotoOrchestrator`                                                                         | **Pane navigation** — pure tmux verbs that update the session's current-window pointer. Never auto-attach; an attached client sees the change live, otherwise a subsequent `attachSession` lands on the new window. |
| `MissingDependencyError / SessionNotFoundError / WorkflowNotCompiledError / InvalidWorkflowError / IncompatibleSDKError` | **Typed errors** thrown by the primitives above. Catch with `instanceof` to render friendly CLI messages without parsing message text.                                                                              |

**Single workflow (most common):**

```ts
// src/claude-worker.ts
import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic-sdk/workflows";
import workflow from "./workflows/review-to-merge/claude.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  const inputs = rawOpts as Record<string, string>;
  await runWorkflow({ workflow, inputs });
});
await program.parseAsync();
```

Run it:

```bash
bun run src/claude-worker.ts --target_branch=release/v2
```

**Multiple workflows — iterate a registry:**

```ts
// src/cli.ts
import { Command } from "@commander-js/extra-typings";
import {
  createRegistry,
  getInputSchema,
  getName,
  listWorkflows,
  runWorkflow,
} from "@bastani/atomic-sdk/workflows";
import reviewToMerge from "./workflows/review-to-merge/claude.ts";
import genSpec from "./workflows/gen-spec/claude.ts";

const registry = createRegistry().register(reviewToMerge).register(genSpec);
const program = new Command("my-app");

for (const wf of listWorkflows(registry)) {
  const sub = program.command(getName(wf)).description(wf.description);
  for (const input of getInputSchema(wf)) {
    sub.option(`--${input.name} <value>`, input.description ?? "");
  }
  sub.action(async (rawOpts) => {
    await runWorkflow({ workflow: wf, inputs: rawOpts as Record<string, string> });
  });
}

await program.parseAsync();
```

See [`examples/multi-workflow/`](./examples/multi-workflow) for a complete runnable version — two Claude workflows (`hello`, `goodbye`) registered under one `cli.ts`.

### Programmatic invocation

`runWorkflow({ workflow, inputs })` is a plain async function — you don't need a CLI at all:

```ts
import { runWorkflow } from "@bastani/atomic-sdk/workflows";
import workflow from "./workflows/review-to-merge/claude.ts";

const { id, tmuxSessionName } = await runWorkflow({
  workflow,
  inputs: { target_branch: "main" },
  detach: true,
});
```

Combine with `getSessionStatus(tmuxSessionName)` and `attachSession(id)` to build your own monitoring UI on top of the SDK.

### Embedding under a parent CLI — `runWorkflow` inside any Commander tree

The SDK no longer ships a Commander adapter — it doesn't need one. Just call `runWorkflow` from inside any Commander action:

```ts
import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic-sdk/workflows";
import workflow from "./workflows/deploy/claude.ts";

const program = new Command("my-app");

const deploy = program.command("deploy").description(workflow.description);
for (const input of getInputSchema(workflow)) {
  deploy.option(`--${input.name} <value>`, input.description ?? "");
}
deploy.action(async (rawOpts) => {
  await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
});

program.command("hello").action(() => console.log("hi"));

await program.parseAsync();
```

There's no re-entry boilerplate — the SDK ships its own internal orchestrator entry script (bundled inside `@bastani/atomic-sdk`) and re-execs *that* with positional args (`workflowSource`, `agent`, base64-encoded inputs). Your CLI is never re-imported, so there's nothing to guard against orchestrator-mode env vars. `bun add @bastani/atomic-sdk` is the only dependency you need — the user-facing `@bastani/atomic` CLI is **not** a peer requirement.

### Overriding the self-exec target

Inspired by the Claude Agent SDK's [`pathToClaudeCodeExecutable`](https://docs.claude.com/en/agent-sdk/typescript). By default the SDK self-execs into its own bundled dispatcher; pass `pathToAtomicExecutable` to route through a separately installed `atomic` binary instead:

```ts
await runWorkflow({
  workflow,
  inputs,
  // Bare command name — resolved via PATH at exec time, e.g. when
  // a globally installed `atomic` is on the user's PATH.
  pathToAtomicExecutable: "atomic",
});

await runWorkflow({
  workflow,
  inputs,
  // Or an absolute path to a specific binary build.
  pathToAtomicExecutable: "/usr/local/bin/atomic",
});
```

Set this when you have a reason to prefer a specific atomic binary (custom build, version pinning, distribution shape) — otherwise leave it unset and let the SDK use its bundled dispatcher.

### `WorkflowPicker` component

The interactive picker (the same one `atomic workflow -a claude` opens) is exposed as a component:

```ts
import { WorkflowPicker } from "@bastani/atomic-sdk/workflows/components";
```

Mount it inside your own OpenTUI app or imperatively via `WorkflowPickerPanel.create({ agent, registry })`.

### Registry rules

- `createRegistry()` returns an **immutable** registry. Each `.register(wf)` call returns a **new** registry — the original is unchanged. Chain calls to accumulate workflows.
- Each workflow is keyed by `${agent}/${name}` — the `(agent, name)` pair must be unique. Registering a duplicate throws immediately.
- Builtin workflows (`ralph`, `deep-research-codebase`, `open-claude-design`) are managed by `atomic`'s internal `createBuiltinRegistry()`. They are reserved — user-registered workflows with the same name will not shadow builtins when running the `atomic` CLI.

### Input precedence

`runWorkflow({ workflow, inputs })` runs `validateInputs(workflow, inputs)` for you, applying:

1. `defineWorkflow` default values (on each `WorkflowInput`) when no value is provided
2. The first declared enum value when `required: true` and no value is provided
3. Whatever you pass in `inputs`

CLI flags compose entirely at the calling-CLI layer — the SDK only sees the final `inputs` map.

### Builtin workflows via the `atomic` CLI

The `atomic workflow` command runs the built-in registry via the same primitives:

```bash
atomic workflow -n ralph -a claude "Build the auth module"
atomic workflow -n deep-research-codebase -a claude "How does auth work?"
atomic workflow -n open-claude-design -a claude
```

These are not affected by your own `createRegistry()` — they are separate.

<details id="migration-from-0x-directory-scanning-and-the-createworkflowcli-wrapper">
<summary><b>Migration from 0.x (directory-scanning) and the <code>createWorkflowCli</code> wrapper</b></summary>

> Two breaking changes: workflows must declare `source: import.meta.path`, and the `createWorkflowCli` / `toCommand` / `runCli` wrappers were removed in favour of primitives.

1. **Add `source: import.meta.path`** to every `defineWorkflow({ ... })` call. The SDK uses it to import the workflow module inside the orchestrator child process.
2. **Replace `createWorkflowCli(workflow).run()`** with a small Commander (or citty / yargs) entrypoint that calls `runWorkflow({ workflow, inputs })` — see the snippets above. The SDK no longer ships a CLI wrapper.
3. **Remove `handleOrchestratorReentry` / `runCli` calls** — the SDK ships its own orchestrator entry script and the dev's CLI is never re-execed.
4. **Update invocations**: replace `atomic workflow -n foo -a claude` with `bun run src/claude-worker.ts --<input>=<value>` for your custom workflows. For the Atomic builtin set (`ralph`, `deep-research-codebase`, `open-claude-design`) keep using `atomic workflow -n <name> -a <agent>`.

</details>

---

## Configuration

### `.atomic/settings.json`

Resolution order:

1. Local: `.atomic/settings.json`
2. Global: `~/.atomic/settings.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/flora131/atomic/main/assets/settings.schema.json",
  "version": 1,
  "scm": "github",
  "providers": {
    "claude": {
      "chatFlags": ["--model", "claude-sonnet-4-6"],
      "envVars": { "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "16384" }
    }
  }
}
```


| Field       | Type   | Description                                                                                                                                     |
| ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`   | string | JSON Schema URL for editor autocomplete                                                                                                         |
| `version`   | number | Config schema version (currently `1`)                                                                                                           |
| `scm`       | string | Source control provider — `github`, `azure-devops`, or `sapling`. Reconciles the GitHub / Azure DevOps MCP servers in agent configs on startup. |
| `providers` | object | Per-provider overrides for `claude`, `opencode`, `copilot`. `chatFlags` replaces built-in defaults entirely; `envVars` are merged               |

> Model selection and reasoning effort are managed by each underlying agent CLI (e.g. Claude Code's `/model`), not Atomic. Atomic's chat command spawns the agent's native TUI — use the agent's own controls.

### Agent-Specific Files

| Agent          | Folder       | Skills                                          | Context File |
| -------------- | ------------ | ----------------------------------------------- | ------------ |
| Claude Code    | `.claude/`   | `.claude/skills/` (symlink → `.agents/skills/`) | `CLAUDE.md`  |
| OpenCode       | `.opencode/` | `.agents/skills/`                               | `AGENTS.md`  |
| GitHub Copilot | `.github/`   | `.agents/skills/`                               | `AGENTS.md`  |

All three agents share the same skill set via `.agents/skills/`. Claude Code accesses them through a `.claude/skills/` symlink.

---

## Updating & Uninstalling

### Update

```bash
# Re-running the bootstrap upgrades to the latest stable release in place.
curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash         # macOS / Linux
irm https://raw.githubusercontent.com/flora131/atomic/main/install.ps1 | iex                  # Windows PowerShell

# Or if you installed via npm:
bun update -g @bastani/atomic
bun install -g @bastani/atomic@next  # prerelease
```

The first `atomic` run after upgrading auto-syncs tooling deps and global skills — no separate command needed.

### Uninstall

```bash
# macOS / Linux — remove the binary and rc-file PATH/completions hooks
rm -f ~/.local/bin/atomic
sed -i.bak '/# Atomic CLI/,+5d' ~/.bashrc ~/.zshrc 2>/dev/null || true

# Windows — remove the binary; PATH entry persists harmlessly until cleaned manually
Remove-Item -Path "$env:LOCALAPPDATA\atomic" -Recurse -Force

# If installed via npm
bun remove -g @bastani/atomic
```

<details>
<summary><b>Also remove global config and cached agent configs</b></summary>

```bash
# macOS / Linux
rm -rf ~/.atomic/

# Windows PowerShell
Remove-Item -Path "$env:USERPROFILE\.atomic" -Recurse -Force
```

</details>

---

## Troubleshooting

<details>
<summary><b>Git identity error</b></summary>

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

</details>

<details>
<summary><b>Windows: agents fail to spawn</b></summary>

Ensure the agent CLI is in your PATH. Atomic uses `Bun.which()`, which handles `.cmd`, `.exe`, and `.bat` extensions automatically.

</details>

---

## FAQ

<details>
<summary><b>Why not markdown, a coding agent alone, or a general agent framework?</b></summary>
Markdown is great for guidance: conventions, commands, repo notes, and checklists. Use Claude Code, OpenCode, or Copilot CLI directly for normal single-session coding. Atomic is for the point where the work needs branching, retries, parallel sessions, state, human approval, sandboxed execution, or reliable handoff between stages. General agent frameworks can do some of this, but you often rebuild coding-agent basics yourself: file editing, terminal interaction, MCP setup, hooks, session handling, and repo-specific context. Atomic starts from production coding agents and adds the workflow layer around them.
</details>

<details>
<summary><b>How does Atomic differ from Spec-Kit?</b></summary>

[Spec Kit](https://github.com/github/spec-kit) is GitHub's toolkit for "Spec-Driven Development." Both improve AI-assisted development, but solve different problems:

**In short:** Spec-Kit works well for greenfield projects where you start from a spec and use a single Copilot session to generate code. Atomic is built for the harder case — large existing codebases where you need to research what's already there before changing anything. Atomic gives you multi-session pipelines with isolated context windows, deterministic execution, and support for Claude Code, OpenCode, and Copilot CLI instead of just one agent.

| Aspect                   | Spec-Kit                                     | Atomic                                                                                              |
| ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Focus**                | Greenfield projects with spec-first workflow | Large existing codebases + greenfield — research-first or spec-first                                |
| **First Step**           | Define project principles and specs          | Analyze existing architecture with parallel research sub-agents                                     |
| **Workflow Definition**  | Shell scripts and markdown templates         | TypeScript Workflow SDK (`defineWorkflow()` → `.run()` → `.compile()`) with deterministic execution |
| **Session Management**   | Single agent session                         | Multi-session pipelines — sequential and parallel — each in isolated context windows                |
| **Data Flow**            | Manual — copy output between steps           | Controlled transcript passing via `ctx.transcript()` and `ctx.getMessages()`                        |
| **Agent Support**        | GitHub Copilot CLI                           | Claude Code + OpenCode + Copilot CLI — switch with a flag                                           |
| **Sub-Agents**           | Single general-purpose agent                 | 12 specialized sub-agents with scoped tools and isolated contexts                                   |
| **Skills**               | Not available                                | 57 built-in skills (development, design, docs, agent architecture)                                  |
| **Autonomous Execution** | Not available                                | Ralph — multi-hour autonomous sessions with plan/implement/review/debug loop                        |
| **Execution Guarantees** | Non-deterministic                            | Deterministic — strict step ordering, frozen definitions, controlled transcript access              |
| **Isolation**            | Not addressed                                | Devcontainer features for containerized execution                                                   |

</details>

<details>
<summary><b>How does Atomic differ from DeerFlow?</b></summary>

[DeerFlow](https://github.com/bytedance/deer-flow) is ByteDance's agent runtime built on LangGraph/LangChain. Both can run multi-agent work, but take different approaches:

**In short:** DeerFlow is a general-purpose agent system with a web UI. Atomic is narrowly focused on coding workflows. The key difference is that Atomic runs on top of production coding agents (Claude Code, OpenCode, Copilot CLI) rather than reimplementing coding tools through a generic API — you get each agent's native file editing, permissions, MCP integrations, and hooks out of the box. Atomic also gives you deterministic execution, which matters when encoding a team's dev process.

| Aspect                  | DeerFlow                                        | Atomic                                                                                        |
| ----------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Runtime**             | Python (LangGraph)                              | TypeScript (Bun)                                                                              |
| **Agent SDKs**          | OpenAI-compatible API                           | Claude Code + OpenCode + Copilot CLI native SDKs — write raw SDK code in each session         |
| **Focus**               | General-purpose agent tasks (research, reports) | Coding-specific: research, spec, implement, review, debug                                     |
| **Workflow Definition** | LangGraph state machines with graph nodes       | TypeScript Workflow SDK — `defineWorkflow()` → `.run()` → `.compile()`                        |
| **Execution Model**     | DAG-based with conditional edges                | Deterministic — strict step ordering, frozen definitions, controlled transcript passing       |
| **Parallelism**         | Via LangGraph branch nodes                      | Native parallel sessions via `Promise.all()` with `ctx.session()` in isolated context windows |
| **Sub-Agents**          | Researcher, coder, reporter nodes               | 12 specialized sub-agents with scoped tools (planner, worker, reviewer, debugger, etc.)       |
| **Skills**              | Not available                                   | 57 built-in skills auto-invoked by context                                                    |
| **Isolation**           | Sandbox containers                              | Devcontainer features + git worktrees                                                         |
| **Interface**           | Web UI (Streamlit)                              | Terminal chat with tmux-based session management                                              |
| **Autonomous**          | Not available                                   | Ralph — bounded iteration with plan/implement/review/debug loop                               |
| **Distribution**        | `pip install` + local server                    | `bun install -g` or devcontainer features                                                     |

</details>

<details>
<summary><b>How does Atomic differ from Hermes Agent?</b></summary>

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is Nous Research's general-purpose AI agent with a self-improving learning loop. Both are open source agent projects, but serve different use cases:

**In short:** Hermes is a broad AI assistant that learns across sessions and connects to messaging platforms. Atomic is coding-specific workflow software for engineering teams. It lets you encode your development process as deterministic TypeScript workflows that run identically across team members, machines, and CI. Atomic inherits production-hardened tools from Claude Code, OpenCode, and Copilot CLI — including their permission systems, MCP integrations, and hooks — giving you two independent security boundaries (devcontainer isolation + agent permissions). Fresh context per session keeps output sharp over multi-hour tasks. Developer-authored skills don't drift the way auto-generated ones can.

| Aspect                    | Hermes Agent                                                                                 | Atomic                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Focus**                 | General-purpose AI assistant (coding, messaging, smart home, research)                       | Coding-specific: multi-session workflows on coding agents                                                                                    |
| **Runtime**               | Python 3.11+ (uv)                                                                            | TypeScript (Bun)                                                                                                                             |
| **Agent SDKs**            | OpenAI-compatible API as universal adapter (200+ models via OpenRouter)                      | Claude Code + OpenCode + Copilot CLI native SDKs — write raw SDK code in each session                                                        |
| **Workflow Definition**   | Cron scheduler + subagent delegation                                                         | TypeScript Workflow SDK — `defineWorkflow()` → `.run()` → `.compile()`                                                                       |
| **Session Management**    | Single conversation loop with context compression                                            | Multi-session pipelines — sequential and parallel — each in isolated context windows                                                         |
| **Data Flow**             | In-context within a single conversation                                                      | Controlled transcript passing via `ctx.transcript()` and `ctx.getMessages()`                                                                 |
| **Self-Improvement**      | Closed learning loop — auto-creates skills from experience, persistent user model via Honcho | Skills authored by developers; memory via CLAUDE.md / AGENTS.md context files                                                                |
| **Sub-Agents**            | `delegate_task` spawns isolated subagents                                                    | 12 specialized sub-agents with scoped tools and model tiers (Opus, Sonnet, Haiku)                                                            |
| **Skills**                | 40+ tools + community Skills Hub (agentskills.io)                                            | 57 built-in skills (development, design, docs, agent architecture)                                                                           |
| **Interface**             | Terminal TUI + multi-platform messaging gateway (Telegram, Discord, Slack, WhatsApp, etc.)   | Terminal chat with tmux-based session management                                                                                             |
| **Isolation**             | Six terminal backends (local, Docker, SSH, Daytona, Singularity, Modal)                      | Devcontainer features + git worktrees                                                                                                        |
| **Autonomous Execution**  | Cron scheduler with inactivity-based timeouts                                                | Ralph — bounded iteration with plan/implement/review/debug loop                                                                              |
| **Execution Guarantees**  | Non-deterministic conversation loop                                                          | Deterministic — strict step ordering, frozen definitions, controlled transcript access                                                       |
| **Team Process Encoding** | Personal assistant — no concept of team-shared workflows                                     | Encode your team's dev process as TypeScript — repeatable across members, projects, and CI                                                   |
| **Coding Agent Tooling**  | Reimplements file/terminal tools from scratch via `model_tools.py`                           | Inherits production-hardened tool ecosystems from Claude Code, OpenCode, and Copilot CLI (file editing, permissions, MCP, hooks)             |
| **Reproducibility**       | Conversation loop produces different execution paths each run                                | Frozen workflow definitions run identically across machines, team members, and CI pipelines                                                  |
| **Context Quality**       | Lossy compression within a single conversation — degrades on long coding tasks               | Fresh context window per session with only distilled transcripts passed forward — stays sharp over multi-hour tasks                          |
| **Skill Authoring**       | Auto-created skills may drift, accumulate errors, or encode bad patterns over time           | Developer-authored, version-controlled skills — intentional and auditable                                                                    |
| **Security Model**        | Command approval + container backends (single boundary)                                      | Devcontainer isolation + coding agent permission systems (Claude Code permissions, Copilot safeguards) — two independent security boundaries |
| **Distribution**          | `uv` / `pip`                                                                                 | `bun install -g` or devcontainer features                                                                                                    |

</details>

---

## Contributing

See [DEV_SETUP.md](DEV_SETUP.md) for development setup, testing guidelines, and contribution workflow.

---

## License

MIT License — see [LICENSE](LICENSE) for details.

## Credits

- [Superpowers](https://github.com/obra/superpowers)
- [Anthropic Skills](https://github.com/anthropics/skills)
- [Ralph Wiggum Method](https://ghuntley.com/ralph/)
- [OpenAI Codex Cookbook](https://github.com/openai/openai-cookbook)
- [HumanLayer](https://github.com/humanlayer/humanlayer)
- [Impeccable](https://github.com/pbakaus/impeccable)
