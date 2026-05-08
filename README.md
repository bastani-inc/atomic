<p align="center">
  <img src="assets/atomic.png" alt="Atomic" width="800">
</p>

<h1 align="center">Atomic</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source CLI and TypeScript SDK for Claude Code, OpenCode, and GitHub Copilot CLI.
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#why-atomic">Why Atomic</a>
  &nbsp;·&nbsp;
  <a href="#key-features">Key features</a>
  &nbsp;·&nbsp;
  <a href="#table-of-contents">Table of contents</a>
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

## Get started

The easiest way to install Atomic is through the install script.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | bash

# Windows (PowerShell 5.1+ or 7+)
irm https://raw.githubusercontent.com/flora131/atomic/main/install.ps1 | iex
```

You can also install it with the following commands:

**Using Node.js**

**npm**

```bash
npm install -g @bastani/atomic
```

**Bun**

```bash
bun add -g @bastani/atomic
```

Then run your first autonomous workflow:

```bash
atomic workflow -n ralph -a claude "Build a REST API for user management"
```

> ⚠️ Workflows run with agent permission checks **disabled** so pipelines don't block on prompts. Use a [devcontainer](#containerized-execution) or [git worktree](https://git-scm.com/docs/git-worktree) — not your host machine.

<details>
<summary><b>Prerequisites, version pinning, devcontainer, SDK-only</b></summary>

**Prerequisites** — Atomic spawns coding agents inside a tmux session, so the host needs:

- A terminal multiplexer — [tmux](https://github.com/tmux/tmux) (macOS/Linux) or [psmux](https://github.com/psmux/psmux) (Windows). Auto-installed on first `atomic` run via your platform's package manager.
- At least one authenticated coding agent CLI — [Claude Code](https://code.claude.com/docs/en/quickstart), [OpenCode](https://opencode.ai), or [GitHub Copilot CLI](https://github.com/features/copilot/cli). Install and `claude` / `opencode` / `copilot` to authenticate.

**Pin a version:** `bash install.sh 0.4.47` (same trailing-arg form works for `.ps1` and `.cmd`).

**Devcontainer** — recommended for autonomous workflows. Add one feature to `.devcontainer/devcontainer.json`:

| Feature                              | Agent        |
| ------------------------------------ | ------------ |
| `ghcr.io/flora131/atomic/claude:1`   | Claude Code  |
| `ghcr.io/flora131/atomic/opencode:1` | OpenCode     |
| `ghcr.io/flora131/atomic/copilot:1`  | Copilot CLI  |

Templates per agent live in [`.devcontainer/`](./.devcontainer/).

**SDK-only** — skip the global binary, use `defineWorkflow` in your own project:

```bash
bun init -y && bun add @bastani/atomic-sdk @anthropic-ai/claude-agent-sdk
```

You still need tmux/psmux + an authenticated agent CLI at runtime.

</details>

<details>
<summary><b>Upgrading from a previous version</b></summary>

**From 0.6.x or earlier (SDK users):** the SDK moved from `@bastani/atomic` to `@bastani/atomic-sdk`.

```bash
bun remove @bastani/atomic && bun add @bastani/atomic-sdk
```

Update imports: `from "@bastani/atomic/workflows"` → `from "@bastani/atomic-sdk/workflows"`. The CLI keeps the same package name.

For SDK API changes (`createWorkflowCli` removal, `source: import.meta.path`, etc.), see [SDK migration](#migration-from-0x).

</details>

---

## Why Atomic

Coding agents are great inside a single session — they inspect code, edit files, and explain their work. The trouble starts when a task is ambiguous, tied to specific exit criteria, long-running, or anchored in a large codebase. You end up reminding the agent of the process, copying output between sessions, and deciding when a human needs to review.

**Atomic turns that process into code.** A workflow can branch, retry, run stages in parallel, isolate sessions, pass only the right transcript forward, pause for human approval, and run inside a devcontainer so the agent is never loose on your host.

| | |
|---|---|
| **Start with your own process** | Automate the repetitive parts of research, debugging, review, migrations, or PR prep — one TypeScript file, versioned with the repo. |
| **Scale to your team** | Encode review gates, quality checks, and approvals so every teammate runs the same workflow instead of manually steering an agent. |
| **Keep the coding agent** | Atomic adds structure around Claude Code, OpenCode, and Copilot CLI — without rebuilding file editing, tool use, MCP setup, hooks, or context handling. |
| **Own the outer loop** | Workflows, gates, handoffs, and the execution graph are TypeScript you can read, edit, and version — not a black-box harness improvising process. |

> Build the workflow once. Run it across agents, repos, and teams.

---

## Key features

Atomic ships three top-level building blocks: **workflows**, **skills**, and **specialized sub-agents**. Everything else in this README is reference material on top.

### 1. Workflows

Atomic workflows separate orchestration from execution: control flow is deterministic TypeScript — frozen definitions, strict step ordering, and explicit transcript handoffs between stages — while each stage runs a full coding agent with unconstrained tool use and reasoning.

| Workflow                 | What it does                                                                                                                                          | Example input                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ralph`                  | Autonomous plan → orchestrate → simplify → review loop that keeps iterating until two reviewers agree (or `max_loops` hits). For multi-hour unattended coding on a bounded task. | `atomic workflow -n ralph -a claude "Implement the caching layer per research/docs/2026-05-07-caching.md"`                                 |
| `deep-research-codebase` | Parallel research across a large codebase, written to a dated `research/docs/` doc you can hand to future workflows or specs. Token-heavy — reach for it on large migrations or cross-service work. For smaller, single-question research, use the [`/research-codebase`](#2-skills) skill instead. | `atomic workflow -n deep-research-codebase -a copilot "Map every callsite of the legacy auth middleware so we can migrate to session-v2"` |
| `open-claude-design`     | End-to-end design generation: discovers your design system, generates from a prompt, refines with feedback, and exports a handoff directory.          | `atomic workflow -n open-claude-design -a opencode --prompt="Team activity feed" --reference=./mocks/feed.png --output-type=prototype`     |
| _author your own_        | Anything outside the built-ins — review-to-merge, migration, triage, release pipelines. Describe it in natural language and the [`workflow-creator`](#2-skills) skill scaffolds a `defineWorkflow()` file with typed CLI flags. | _"Use the `workflow-creator` skill to scaffold a workflow for `claude` that takes an `--issue=<n>` flag, pulls the GitHub issue, and runs an implementation pass identical to the built-in `ralph` workflow against the described features."_ |

For full input schemas, run `atomic workflow inputs <name> -a <agent>`. SDK details in [Workflow SDK](#workflow-sdk); runnable references in [`examples/`](./examples).

### 2. Skills

Structured capability modules that give agents best practices and reusable workflows. Atomic ships **57 skills** at `.agents/skills/<name>/SKILL.md`. They auto-invoke when the agent detects a relevant trigger, or you can call them directly with `/<skill-name>` (Claude Code) or natural language (OpenCode / Copilot CLI).

**Top skills to know first:**

| Skill               | Invoke with                       | Purpose                                                                          |
| ------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `init`              | `/init`                           | Generate `CLAUDE.md` / `AGENTS.md` by exploring the codebase                     |
| `prompt-engineer`   | natural language                  | Sharpen your research prompts, workflow inputs, or any agent prompt before you run it |
| `research-codebase` | `/research-codebase "<question>"` | Dispatch parallel sub-agents to analyze the codebase and write a research doc    |
| `create-spec`       | `/create-spec "<research-path>"`  | Produce a technical execution spec grounded in a research document               |
| `workflow-creator`  | natural language                  | Generate a multi-agent workflow definition using `defineWorkflow()` + a registry |
| `tdd`               | natural language                  | Red-green-refactor with a built-in testing-anti-patterns guide                   |
| `explain-code`      | `/explain-code "<path>"`          | Deep-dive explanation of specific code using DeepWiki                            |
| `gh-create-pr`      | `/gh-create-pr`                   | Commit, push, and open a GitHub PR (also `/ado-create-pr`, `/sl-submit-diff`)    |
| `playwright-cli`    | natural language                  | Automate browser interactions, tests, screenshots                                |
| `impeccable`        | natural language                  | Create distinctive, production-grade frontend interfaces                         |
| `find-skills`       | natural language                  | Discover and install community skills you don't have yet                         |

<details>
<summary><b>Full catalog</b> — all 57 skills, grouped by category</summary>

**Development workflows:** `init`, `research-codebase`, `create-spec`, `workflow-creator`, `explain-code`, `find-skills`, `tdd`, `prompt-engineer`

**Context engineering:** `context-fundamentals`, `context-degradation`, `context-compression`, `context-optimization`, `filesystem-context`, `memory-systems`, `multi-agent-patterns`, `tool-design`, `hosted-agents`, `project-development`, `bdi-mental-states`

**TypeScript & runtime:** `typescript-expert`, `typescript-advanced-types`, `typescript-react-reviewer`, `bun`, `opentui`

**Frontend design & UI polish:** `impeccable`, `polish`, `critique`, `audit`, `layout`, `typeset`, `colorize`, `adapt`, `animate`, `delight`, `clarify`, `distill`, `quieter`, `bolder`, `overdrive`, `harden`, `optimize`, `arrange`, `extract`, `normalize`, `onboard`, `shape`, `teach-impeccable`, `frontend-design`, `ux-design-virtuoso`

**Evaluation:** `evaluation`, `advanced-evaluation`

**Documents & parsing:** `pdf`, `xlsx`, `docx`, `pptx`, `liteparse`

**Source control & automation:** `gh-commit`, `gh-create-pr`, `ado-commit`, `ado-create-pr`, `sl-commit`, `sl-submit-diff`, `playwright-cli`

**Meta:** `skill-creator`

> **Source-control MCP servers are disabled by default.** Set `scm` in `.atomic/settings.json` (or run `atomic config set scm <provider>`) to `github`, `azure-devops`, or `sapling` to enable the matching MCP server. `sapling` disables both.

Run `ls .agents/skills/` for the live, on-disk list.

</details>

### 3. Specialized sub-agents

Purpose-built agents with scoped context, tools, and termination conditions. Run `/agents` in any chat to list them; they're auto-dispatched by skills and workflows, or invoke directly with `Task(subagent_type="<name>", ...)`.

| Sub-agent                    | Purpose                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `planner`                    | Decompose specs into structured task lists with dependency tracking |
| `worker`                     | Implement single focused tasks (multiple workers run in parallel)   |
| `reviewer`                   | Audit implementations against specs and best practices              |
| `orchestrator`               | Coordinate complex multi-step workflows                             |
| `debugger`                   | Debug errors, test failures, and unexpected behavior                |
| `code-simplifier`            | Simplify and refine code for clarity and maintainability            |
| `codebase-locator`           | Locate files, directories, and components                           |
| `codebase-analyzer`          | Analyze implementation details of specific components               |
| `codebase-pattern-finder`    | Find similar implementations and usage examples                     |
| `codebase-online-researcher` | Research using web sources and DeepWiki                             |
| `codebase-research-locator`  | Find prior research documents in `research/`                        |
| `codebase-research-analyzer` | Deep dive on existing research topics                               |

<details>
<summary><i>Why specialized agents instead of one general agent?</i></summary>

LLMs have an architectural limitation: the more context they hold, the harder it is to attend to the right information. A single agent juggling a spec, dozens of files, tool outputs, and its own reasoning will lose details, repeat work, or hallucinate connections. Specialized sub-agents fix this with **context isolation** (fresh, minimal context per job), **tool scoping** (a `reviewer` can't edit files; a `worker` can't spawn other workers), and **parallel execution** (independent agents run concurrently).

</details>

---

## Table of contents

- [Get started](#get-started)
- [Why Atomic](#why-atomic)
- [Key features](#key-features)
  - [Workflows](#1-workflows)
  - [Skills](#2-skills)
  - [Specialized sub-agents](#3-specialized-sub-agents)
- [Two surfaces: CLI and SDK](#two-surfaces-cli-and-sdk)
- [Example use cases](#example-use-cases)
- [Security & permissions](#security--permissions)
- [Workflow SDK](#workflow-sdk)
- [Building your own atomic-powered app](#building-your-own-atomic-powered-app)
- [Containerized execution](#containerized-execution)
- [Workflow panel](#workflow-panel)
- [Managing sessions](#managing-sessions)
- [Commands reference](#commands-reference)
- [Configuration](#configuration)
- [Updating & uninstalling](#updating--uninstalling)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)
- [Credits](#credits)

---

## Two surfaces: CLI and SDK

Atomic ships two things that share one workflow runtime — use either or both.

|                       | Atomic CLI                                            | Atomic SDK                                                  |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| **What it is**        | Global `atomic` binary                                | `@bastani/atomic-sdk/workflows` TypeScript library          |
| **Install**           | `install.sh` / `install.ps1` or `bun install -g`      | `bun add @bastani/atomic-sdk` inside your project           |
| **What you get**      | `atomic chat`, three built-in workflows, sessions, the workflow panel, atomic skills | `defineWorkflow`, `runWorkflow`, session primitives, typed errors |
| **When to reach for** | Autonomous out-of-the-box behavior or interactive chat | Encode your own multi-session pipelines                     |

Both call the same runtime (tmux/psmux session graph, provider SDKs, detach/reattach). Neither depends on the other.

---

## Example use cases

These are workflows you'd author with `defineWorkflow` — see [Workflow SDK](#workflow-sdk) for the API.

- **Review-to-merge pipeline** — review code, run CI in parallel, open a PR, notify Slack, wait for approval, merge.
- **Support ticket → draft PR** — reproduce the issue, find root cause, try a fix in a sandbox, run tests, pause for review.
- **Production alert investigation** — pull the failing trace, inspect recent commits, rank likely causes, draft a fix or page on-call with evidence.
- **Parallel UX testing** — run persona-specific agents against the same feature, aggregate structured feedback into tasks.
- **Large migration or refactor** — research, split into safe batches, run implementation + review passes, keep artifacts.

---

## Security & permissions

> [!CAUTION]
> Atomic workflows run coding agents with **all permission checks disabled** so pipelines don't block on prompts. Run them in a [devcontainer](#containerized-execution) or [git worktree](https://git-scm.com/docs/git-worktree) — not on your host machine.

| Agent                  | How permissions are bypassed                                         | Key flags / settings                                                  |
| ---------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Claude Code**        | CLI flag disables the interactive permission prompt                  | `--dangerously-skip-permissions`                                      |
| **GitHub Copilot CLI** | CLI flag enables auto-execution; SDK auto-approves all tool requests | `--yolo`, `COPILOT_ALLOW_ALL=true`, `onPermissionRequest: approveAll` |
| **OpenCode**           | Permissions handled programmatically through the event stream        | Auto-replied via SSE events                                           |

Override per-project via `ProviderOverrides` in `.atomic/settings.json` — `chatFlags` replaces defaults entirely; `envVars` are merged.

---

## Workflow SDK

The Workflow SDK (`@bastani/atomic-sdk/workflows`) lets you encode your team's process as TypeScript — spawn agent sessions dynamically with native control flow (`for`, `if`, `Promise.all()`), pass state explicitly, and watch each stage appear in a live graph.

### Minimal example

```ts
import { defineWorkflow } from "@bastani/atomic-sdk/workflows";

export default defineWorkflow({
  name: "review-to-merge",
  description: "Review → CI → PR → Approve → Merge",
  source: import.meta.path,
}).for("claude")
  .run(async (ctx) => {
    const review = await ctx.stage({ name: "review" }, {}, {}, async (s) => {
      await s.session.query("Review uncommitted changes for correctness, security, style.");
      s.save(s.sessionId);
    });

    await Promise.all([
      ctx.stage({ name: "security-scan" }, {}, {}, async (s) => {
        await s.session.query("Run `bun audit` and scan for leaked secrets.");
        s.save(s.sessionId);
      }),
      ctx.stage({ name: "ci-checks" }, {}, {}, async (s) => {
        await s.session.query("Run `bun lint` and `bun test`.");
        s.save(s.sessionId);
      }),
    ]);

    await ctx.stage({ name: "merge" }, {}, {}, async (s) => {
      const t = await s.transcript(review);
      await s.session.query(`Read ${t.path}, open a PR, and ask the user to confirm before merging.`);
      s.save(s.sessionId);
    });
  })
  .compile();
```

Wire it to a CLI in `src/claude-worker.ts` and run with `bun run src/claude-worker.ts --target_branch=main`. The SDK ships pure primitives — compose with Commander, citty, yargs, or any TUI library.

### Key capabilities

| Capability                       | Description                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Dynamic session spawning**     | `ctx.stage()` spawns sessions at runtime — each gets its own tmux window and graph node              |
| **Native TS control flow**       | `for`, `if/else`, `Promise.all()`, `try/catch` — no framework DSL                                    |
| **Review gates & approvals**     | Pause for human input, run review stages, decide whether the next stage continues                   |
| **Session return values**        | Callbacks return data: `const h = await ctx.stage(...); h.result`                                    |
| **Transcript passing**           | Access prior output via handle (`s.transcript(handle)`) or name                                      |
| **Declared input schemas**       | Add `inputs: [...]` and the CLI gets `--<field>=<value>` flags with validation                       |
| **Headless stages**              | `headless: true` runs in-process — invisible in graph, identical callback API                        |
| **Provider-agnostic**            | Write raw Claude / Copilot / OpenCode SDK code inside each callback                                  |
| **Auto-inferred graph**          | Topology derived from `await` / `Promise.all` patterns                                               |
| **Deterministic execution**      | Frozen definitions, strict step ordering, controlled transcript access                               |

<details>
<summary><b>Full SDK reference</b> — builder, context, session APIs, options, save semantics</summary>

#### Builder API

| Method                                  | Purpose                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `defineWorkflow({ name, description })` | Entry point — returns a `WorkflowBuilder`              |
| `.for(agent)`                           | Pin to `"claude"`, `"copilot"`, or `"opencode"`        |
| `.run(async (ctx) => { ... })`          | Set the workflow body                                  |
| `.compile()`                            | **Required** — terminal method that seals the workflow |

#### `ctx` (WorkflowContext)

| Property               | Description                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `ctx.inputs`           | Typed inputs — only declared field names are valid keys (compile-time enforced)                   |
| `ctx.agent`            | `"claude"` \| `"copilot"` \| `"opencode"`                                                         |
| `ctx.stage(...)`       | Spawn a session — returns `SessionHandle<T>` with `name`, `id`, `result`                          |
| `ctx.transcript(ref)`  | Get a completed session's transcript (`{ path, content }`)                                        |
| `ctx.getMessages(ref)` | Get a completed session's raw native messages                                                     |

#### `s` (SessionContext, inside each callback)

| Property            | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `s.client`          | Pre-created provider SDK client                      |
| `s.session`         | Pre-created provider session                         |
| `s.inputs`          | Same typed inputs as `ctx.inputs`                    |
| `s.sessionId`       | Session UUID                                         |
| `s.sessionDir`      | This session's storage directory on disk             |
| `s.save(messages)`  | Save output for downstream sessions                  |
| `s.transcript(ref)` | Get a completed session's transcript                 |
| `s.stage(...)`      | Spawn a nested sub-session (child in the graph)      |

#### Saving transcripts (per provider)

| Provider     | How to save                                                       |
| ------------ | ----------------------------------------------------------------- |
| **Claude**   | `s.save(s.sessionId)` — auto-reads via `getSessionMessages()`     |
| **Copilot**  | `s.save(await session.getMessages())`                             |
| **OpenCode** | `s.save(result.data!)` — pass the full `{ info, parts }` response |

#### Sending prompts (per provider)

| Agent        | How to prompt                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **Claude**   | `await s.session.query(prompt)`                                                                       |
| **Copilot**  | `await s.session.send({ prompt })`                                                                    |
| **OpenCode** | `await s.client.session.prompt({ sessionID: s.session.id, parts: [{ type: "text", text: prompt }] })` |

#### Key rules

1. Every workflow must call `.run()` then `.compile()`.
2. Session names must be unique within a workflow run.
3. `transcript()` / `getMessages()` only access **completed** sessions.
4. Set `source: import.meta.path` on every `defineWorkflow({ ... })`.
5. Built-in workflow names (`ralph`, `deep-research-codebase`, `open-claude-design`) are reserved.

> When the SDK updates, ask the `workflow-creator` skill: _"Update this workflow to use the latest SDK patterns."_

</details>

### Runnable examples

[`examples/`](./examples) ships small complete user apps — `claude-worker.ts` / `copilot-worker.ts` / `opencode-worker.ts` per agent, each a small Commander entrypoint that calls `runWorkflow({ workflow, inputs })`.

| Example                         | What it demonstrates                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `hello-world`                   | Minimal single-session workflow with structured inputs                                |
| `sequential-describe-summarize` | Two stages passing data via `s.save()` → `s.transcript(handle)`                       |
| `parallel-hello-world`          | `Promise.all()` fan-out and transcript merge                                          |
| `headless-test`                 | Visible seed → 3 parallel headless stages → visible merge                             |
| `hil-favorite-color`            | Human-in-the-loop prompt mid-workflow                                                 |
| `structured-output-demo`        | Per-SDK structured output (JSON-schema validation, Zod)                               |
| `review-fix-loop`               | Draft → loop(review → fix) with bounded iterations and early exit                     |
| `multi-workflow`                | Two Claude workflows under one `cli.ts` via `listWorkflows(registry)`                 |
| `commander-embed`               | Mount an atomic workflow under a parent Commander CLI                                 |
| `pane-navigation`               | Driver CLI for the SDK pane-navigation primitives                                     |

Each directory has its own `README.md` with the run command and explanation. Run with `bun install && bun run <agent>-worker.ts --<input>=<value>`.

---

## Building your own atomic-powered app

`@bastani/atomic-sdk/workflows` is a library, not just a CLI. Use it directly to ship your own TypeScript app that runs your team's workflows.

> **SDK-only users:** you don't need the global `atomic` binary, but you still need [Bun](https://bun.sh/) (the SDK does not run on Node.js), tmux/psmux, and at least one authenticated agent CLI.

### Primitives

| Primitive                                                                                                  | Purpose                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `defineWorkflow`                                                                                           | Author a workflow                                                    |
| `createRegistry`                                                                                           | Build an immutable registry of workflows for iteration / lookup      |
| `listWorkflows / getWorkflow`                                                                              | Iterate or resolve `(agent, name)` → workflow                        |
| `getName / getAgent / getInputSchema / getDescription / getSource / getMinSDKVersion`                      | Read workflow metadata                                               |
| `validateInputs(wf, raw)`                                                                                  | Run the same validation pipeline atomic uses                         |
| `runWorkflow({ workflow, inputs, detach?, pathToAtomicExecutable? })`                                      | Spawn the orchestrator session and (optionally) attach               |
| `listSessions / getSession / stopSession / attachSession / detachSession / getSessionStatus / getSessionTranscript` | Manage running tmux sessions on the shared atomic socket             |
| `nextWindow / previousWindow / gotoOrchestrator`                                                           | Pure tmux pane-navigation verbs                                      |
| `MissingDependencyError / SessionNotFoundError / WorkflowNotCompiledError / InvalidWorkflowError / IncompatibleSDKError` | Typed errors — catch with `instanceof` for friendly CLI output       |

### Single workflow

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
  await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
});
await program.parseAsync();
```

### Multiple workflows — registry

```ts
import { createRegistry, getName, getInputSchema, listWorkflows, runWorkflow } from "@bastani/atomic-sdk/workflows";
import reviewToMerge from "./workflows/review-to-merge/claude.ts";
import genSpec from "./workflows/gen-spec/claude.ts";

const registry = createRegistry().register(reviewToMerge).register(genSpec);
const program = new Command("my-app");

for (const wf of listWorkflows(registry)) {
  const sub = program.command(getName(wf)).description(wf.description);
  for (const input of getInputSchema(wf)) sub.option(`--${input.name} <value>`, input.description ?? "");
  sub.action(async (rawOpts) => runWorkflow({ workflow: wf, inputs: rawOpts as Record<string, string> }));
}
await program.parseAsync();
```

See [`examples/multi-workflow/`](./examples/multi-workflow) for a full runnable version.

### Programmatic invocation

`runWorkflow` is a plain async function — no CLI required:

```ts
const { id, tmuxSessionName } = await runWorkflow({
  workflow,
  inputs: { target_branch: "main" },
  detach: true,
});
```

Combine with `getSessionStatus(tmuxSessionName)` and `attachSession(id)` to build your own monitoring UI.

### Overriding the self-exec target

By default the SDK self-execs into its own bundled dispatcher; pass `pathToAtomicExecutable: "atomic"` (or an absolute path) to route through a separately installed binary instead — useful for custom builds or version pinning.

### Registering workflows with the `atomic` CLI

Add an entry to `.atomic/settings.json` under `workflows`. Each entry points at an external command that exposes its workflow via `hostLocalWorkflows([wf])`:

```jsonc
{
  "workflows": {
    "pr-review": {
      "command": "bunx",
      "args": ["./.atomic/workflows/pr-review/index.ts"],
      "agents": ["claude"]
    }
  }
}
```

Inside the entry file, end with `await hostLocalWorkflows([workflow])`. After editing `settings.json`, run `atomic workflow refresh` to re-spawn the metadata loader. Inspect saved artifacts with `atomic workflow read --sessionId <id> [--stageId <name>]` — points at `~/.atomic/sessions/<runId>/`.

For the full authoring playbook see the [`workflow-creator` skill](.agents/skills/workflow-creator/SKILL.md). The `custom-workflow-bunx` example is the minimal reference.

<details id="migration-from-0x">
<summary><b>Migration from 0.x</b> — directory-scanning + <code>createWorkflowCli</code></summary>

Two breaking changes:

1. **Add `source: import.meta.path`** to every `defineWorkflow({ ... })` call.
2. **Replace `createWorkflowCli(workflow).run()`** with a Commander/citty/yargs entrypoint that calls `runWorkflow({ workflow, inputs })`. The SDK no longer ships a CLI wrapper.
3. **Remove `handleOrchestratorReentry` / `runCli`** — the SDK ships its own orchestrator entry script.
4. **Update invocations** for custom workflows: `atomic workflow -n foo -a claude` → `bun run src/claude-worker.ts --<input>=<value>`. Built-ins (`ralph`, `deep-research-codebase`, `open-claude-design`) keep working as `atomic workflow -n <name>`.

</details>

---

## Containerized execution

Atomic ships **devcontainer features** that bundle the CLI, agent, and dependencies into isolated containers — the recommended way to run autonomous agents safely.

| Feature                              | Installs             |
| ------------------------------------ | -------------------- |
| `ghcr.io/flora131/atomic/claude:1`   | Atomic + Claude Code |
| `ghcr.io/flora131/atomic/opencode:1` | Atomic + OpenCode    |
| `ghcr.io/flora131/atomic/copilot:1`  | Atomic + Copilot CLI |

Minimal `devcontainer.json`:

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

Templates per agent live in [`.devcontainer/`](./.devcontainer/). First run takes ~1 minute to warm up.

---

## Workflow panel

During `atomic workflow` execution, Atomic renders a live workflow panel built on [OpenTUI](https://github.com/anomalyco/opentui) over the workflow's tmux session graph: nodes per `.stage()` with status, edges for sequential / parallel dependencies, Ralph's task list with dependency arrows updated in real time, pane previews, and visible `s.save()` / `s.transcript()` handoffs.

`atomic chat -a <agent>` has no Atomic-owned UI — it spawns the native agent CLI directly inside a tmux session, so chat features (streaming, `@` mentions, `/slash-commands`, model selection) come from the agent CLI itself.

---

## Managing sessions

Every chat and workflow runs inside an isolated tmux session on a dedicated socket (your personal tmux is untouched).

```bash
atomic session list                 # all sessions
atomic session connect              # interactive picker
atomic session connect <name>       # by name
atomic session kill                 # interactive multi-select
atomic session kill --all --yes     # kill all, skip prompts
```

Session names follow `atomic-chat-<id>` or `atomic-wf-<workflow>-<id>`. Scope with `atomic chat session …` or `atomic workflow session …`. Filter by agent with `-a <agent>` (repeatable).

Run a workflow in the background with `-d` / `--detach`:

```bash
atomic workflow -n ralph -a claude -d "build the auth module"
atomic workflow session connect atomic-wf-claude-ralph-<id>
```

---

## Commands reference

| Command                                    | Description                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `atomic chat -a <agent>`                   | Spawn the native agent CLI inside a tmux session                                                  |
| `atomic workflow -n <name> -a <agent>`     | Run a built-in or registered workflow                                                             |
| `atomic workflow`                          | Interactive picker (no `-n`)                                                                      |
| `atomic workflow list [-a <agent>]`        | List available workflows, grouped by source                                                       |
| `atomic workflow refresh`                  | Reload custom workflows from `settings.json` and report loaded + broken entries                   |
| `atomic workflow read --sessionId <id>`    | Print on-disk path under `~/.atomic/sessions/<runId>/`; add `--stageId <name>` for a single stage |
| `atomic workflow status [<id>]`            | Query workflow state                                                                              |
| `atomic workflow inputs <name> -a <agent>` | Print a workflow's declared input schema as JSON                                                  |
| `atomic session list / connect / kill`     | See [Managing sessions](#managing-sessions)                                                       |
| `atomic completions <shell>`               | Output shell completion script (bash, zsh, fish, powershell)                                     |
| `atomic config set <k> <v>`                | Set configuration values (`telemetry`, `scm`)                                                     |
| `atomic update [--check]`                  | Self-update; PM-managed installs print the matching `<pm> update -g` hint                         |
| `atomic uninstall [--purge]`               | Remove the binary, PATH entries, completions; `--purge` also wipes `~/.atomic`                    |

### `atomic workflow` flags

| Flag                 | Description                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `-n, --name <name>`  | Workflow name (required for direct runs; omit for the picker)                                                            |
| `-a, --agent <name>` | `claude` \| `opencode` \| `copilot`                                                                                      |
| `-d, --detach`       | Start in the background; attach later with `atomic workflow session connect <name>`                                      |
| `--<field>=<value>`  | Structured input for workflows that declare an `inputs` schema                                                           |
| `[prompt...]`        | Positional prompt — requires the workflow to declare a `prompt` input                                                    |

### Global flags

| Flag            | Description                                |
| --------------- | ------------------------------------------ |
| `-y, --yes`     | Auto-confirm all prompts (non-interactive) |
| `--no-banner`   | Skip ASCII banner display                  |
| `-v, --version` | Show version number                        |

<details>
<summary><b>Shell completions setup</b> (bash, zsh, fish, PowerShell)</summary>

Cache the completion script once so new shells don't re-spawn the atomic binary:

```bash
# Bash
mkdir -p ~/.atomic/completions && atomic completions bash > ~/.atomic/completions/atomic.bash
echo '[ -f "$HOME/.atomic/completions/atomic.bash" ] && source "$HOME/.atomic/completions/atomic.bash"' >> ~/.bashrc

# Zsh
mkdir -p ~/.atomic/completions && atomic completions zsh > ~/.atomic/completions/atomic.zsh
echo '[ -f "$HOME/.atomic/completions/atomic.zsh" ] && source "$HOME/.atomic/completions/atomic.zsh"' >> ~/.zshrc

# Fish
atomic completions fish > ~/.config/fish/completions/atomic.fish

# PowerShell
$cache = Join-Path $HOME '.atomic\completions\atomic.ps1'
New-Item -ItemType Directory -Force -Path (Split-Path $cache) | Out-Null
atomic completions powershell | Out-File -FilePath $cache -Encoding utf8
Add-Content $PROFILE "`nif (Test-Path `"$cache`") { . `"$cache`" }"
```

The bootstrap installer sets this up automatically.

</details>

---

## Configuration

`.atomic/settings.json` (local) overrides `~/.atomic/settings.json` (global):

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
  },
  "workflows": {
    "pr-review": {
      "command": "bunx",
      "args": ["./.atomic/workflows/pr-review/index.ts"],
      "agents": ["claude"]
    }
  }
}
```

| Field       | Description                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `scm`       | Source control provider — `github`, `azure-devops`, or `sapling`. Reconciles the matching MCP servers on startup.    |
| `providers` | Per-agent overrides (`claude`, `opencode`, `copilot`). `chatFlags` replaces defaults entirely; `envVars` are merged. |
| `workflows` | Custom workflow registry — each value is `{ command, args?, agents }` pointing at a `hostLocalWorkflows([wf])` entry. Run `atomic workflow refresh` after editing. |

### Agent-specific files

| Agent          | Folder       | Skills                          | Context file |
| -------------- | ------------ | ------------------------------- | ------------ |
| Claude Code    | `.claude/`   | `.claude/skills/` (symlink)     | `CLAUDE.md`  |
| OpenCode       | `.opencode/` | `.agents/skills/`               | `AGENTS.md`  |
| GitHub Copilot | `.github/`   | `.agents/skills/`               | `AGENTS.md`  |

All three share the same skill set via `.agents/skills/`. Model selection / reasoning effort are managed by each underlying agent CLI, not Atomic.

---

## Updating & uninstalling

**Update** — same channel you installed through. `atomic update --check` shows your version, the latest, and the recommended command.

```bash
atomic update                            # bootstrap-installed binary (self-update)
npm update -g @bastani/atomic            # or: bun update -g, pnpm update -g, yarn global upgrade
```

**Uninstall:**

```bash
atomic uninstall              # removes binary, PATH entries, completions; keeps ~/.atomic
atomic uninstall --purge      # also wipes ~/.atomic

# If installed via npm:
npm uninstall -g @bastani/atomic    # or bun remove -g, etc.
```

`atomic uninstall` refuses on PM-managed installs and prints the right `<pm> remove -g` command.

> **Windows + Bun heads-up:** `bun remove -g` may leave the bin shim and platform package behind ([oven-sh/bun#11970](https://github.com/oven-sh/bun/issues/11970)). If `atomic` still resolves, also delete `%USERPROFILE%\.bun\bin\atomic.exe`, `atomic.bunx`, and `%USERPROFILE%\.bun\install\global\node_modules\@bastani\atomic-windows-*`.

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

Ensure the agent CLI is in your PATH. Atomic uses `Bun.which()`, which handles `.cmd`, `.exe`, `.bat`.

</details>

---

## FAQ

<details>
<summary><b>Why not markdown, a coding agent alone, or a general agent framework?</b></summary>

Markdown is great for guidance: conventions, commands, repo notes. Use Claude Code, OpenCode, or Copilot CLI directly for normal single-session coding. Atomic is for the point where the work needs branching, retries, parallel sessions, state, human approval, sandboxed execution, or reliable handoff between stages. General agent frameworks can do some of this, but you often rebuild coding-agent basics yourself: file editing, terminal interaction, MCP setup, hooks, session handling, repo-specific context. Atomic starts from production coding agents and adds the workflow layer around them.

</details>

<details>
<summary><b>How does Atomic differ from Spec-Kit?</b></summary>

[Spec-Kit](https://github.com/github/spec-kit) is GitHub's spec-driven development toolkit. **Spec-Kit works well for greenfield projects with a single Copilot session. Atomic is built for the harder case** — large existing codebases where you research first, with multi-session pipelines, isolated context windows, deterministic execution, and support for Claude Code + OpenCode + Copilot CLI.

| Aspect                  | Spec-Kit                       | Atomic                                                                                |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| **Focus**               | Greenfield, spec-first         | Large existing codebases — research-first or spec-first                               |
| **Workflow definition** | Shell scripts + markdown       | TypeScript Workflow SDK with deterministic execution                                  |
| **Session management** | Single agent session            | Multi-session pipelines, sequential and parallel, in isolated context windows         |
| **Agent support**       | GitHub Copilot CLI             | Claude Code + OpenCode + Copilot CLI                                                  |
| **Sub-agents / skills** | Single general agent / none    | 12 specialized sub-agents + 57 built-in skills                                        |
| **Autonomous execution** | Not available                 | Ralph — multi-hour autonomous plan/implement/review/debug loop                        |

</details>

<details>
<summary><b>How does Atomic differ from DeerFlow?</b></summary>

[DeerFlow](https://github.com/bytedance/deer-flow) is ByteDance's general-purpose agent runtime on LangGraph. **DeerFlow is a general-purpose agent system with a web UI; Atomic is narrowly focused on coding workflows.** Atomic runs on top of production coding agents (Claude Code, OpenCode, Copilot CLI) rather than reimplementing coding tools through a generic API — you get each agent's native file editing, permissions, MCP integrations, and hooks out of the box.

| Aspect             | DeerFlow                                | Atomic                                                                                  |
| ------------------ | --------------------------------------- | --------------------------------------------------------------------------------------- |
| **Runtime**        | Python (LangGraph)                      | TypeScript (Bun)                                                                        |
| **Agent SDKs**     | OpenAI-compatible API                   | Claude Code + OpenCode + Copilot CLI native SDKs                                        |
| **Execution**      | DAG with conditional edges              | Deterministic — strict step ordering, frozen definitions, controlled transcript passing |
| **Sub-agents**     | Researcher / coder / reporter           | 12 specialized sub-agents with scoped tools                                             |
| **Interface**      | Web UI (Streamlit)                      | Terminal chat with tmux session management                                              |
| **Autonomous**     | Not available                           | Ralph — bounded plan/implement/review/debug loop                                        |

</details>

<details>
<summary><b>How does Atomic differ from Hermes Agent?</b></summary>

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is Nous Research's general-purpose AI assistant with a self-improving learning loop. **Hermes is a broad personal assistant that learns across sessions; Atomic is coding-specific workflow software for engineering teams.** Atomic encodes your dev process as deterministic TypeScript workflows that run identically across teammates, machines, and CI, and inherits production-hardened tools from Claude Code, OpenCode, and Copilot CLI (giving you two independent security boundaries: devcontainer + agent permissions).

| Aspect                | Hermes Agent                                            | Atomic                                                                                          |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Focus**             | Personal AI assistant (coding + messaging + smart home) | Coding-specific multi-session workflows for teams                                               |
| **Runtime**           | Python                                                  | TypeScript (Bun)                                                                                |
| **Agent SDKs**        | OpenAI-compatible adapter                               | Claude Code + OpenCode + Copilot CLI native SDKs                                                |
| **Execution**         | Single conversation loop with context compression       | Multi-session pipelines, fresh context per session, controlled transcript passing               |
| **Skills**            | Auto-created (may drift)                                | 57 developer-authored, version-controlled skills                                                |
| **Reproducibility**   | Different paths each run                                | Frozen workflow definitions run identically across machines and CI                              |
| **Security**          | Command approval + container backends                   | Devcontainer isolation + coding agent permission systems (two independent boundaries)           |

</details>

---

## Contributing

See [DEV_SETUP.md](DEV_SETUP.md) for development setup, testing guidelines, and contribution workflow.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Superpowers](https://github.com/obra/superpowers)
- [Anthropic Skills](https://github.com/anthropics/skills)
- [Ralph Wiggum Method](https://ghuntley.com/ralph/)
- [OpenAI Codex Cookbook](https://github.com/openai/openai-cookbook)
- [HumanLayer](https://github.com/humanlayer/humanlayer)
- [Impeccable](https://github.com/pbakaus/impeccable)
