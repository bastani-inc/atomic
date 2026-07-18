<h1 align="center">Atomic — The Verifiable Coding Agent Runtime</h1>

<p align="center"><img width="800" height="450" alt="atomic-promo" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>The verifiable runtime for coding agents.</b><br>
  <b>Run verifiable engineering loops with control, alignment, and confidence. Build your own software factory with verification built in.</b><br>
  <i>Define work as an execution graph of bounded stages and gates, with scoped tools, enforced checks, auditable artifacts, and human approvals. Atomic runs and records that graph so agent work is verifiable by design.</i>
</p>

<p align="center">
  Atomic turns agent work into controlled, directed acyclic workflow graphs you can trust: instructions are explicit, dependencies are visible, stages are bounded, checks are enforced, approvals can block progress, and every run leaves auditable artifacts.
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#verifiable-agent-runs">Verifiable runs</a>
  &nbsp;·&nbsp;
  <a href="#why-atomic">Why Atomic</a>
  &nbsp;·&nbsp;
  <a href="#faq">FAQ</a>
  &nbsp;·&nbsp;
  <a href="https://docs.bastani.ai/">Docs</a>
</p>

<p align="center">
  <a href="https://docs.bastani.ai/"><img src="https://img.shields.io/badge/docs-atomic-blue" alt="Docs"></a>
  <a href="https://discord.gg/9CvdXUGXR4"><img src="https://img.shields.io/badge/join%20community-discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://deepwiki.com/bastani-inc/atomic"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/Bun-Runtime-f9f1e1?logo=bun&logoColor=black" alt="Bun"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  If you like Atomic and want to support it, the easiest way is to star our repo ⭐
</p>

---

## Get started

### Prerequisites

- **Node.js 24 LTS or newer** — Atomic requires the latest Node LTS runtime. Check with `node --version`.
- **A package manager** — use npm (included with Node), pnpm, Yarn, or Bun. Use Bun 1.3.14+ for Bun installs or workflow-authoring examples.
- **Model-provider access** — Atomic supports subscription login for Codex, Anthropic, Cursor (experimental), and the Z.ai coding plan, plus OpenRouter with an API key.

### Install

With npm:

```bash
npm install -g @bastani/atomic
```

With pnpm:

```bash
pnpm add -g @bastani/atomic
```

With bun:

```bash
bun add -g @bastani/atomic
```

Atomic does not require package install scripts. If you want to disable dependency lifecycle scripts during the Atomic install, you can add `--ignore-scripts` to the install command.

### Authenticate and run

Atomic works best with a subscription-backed provider (Codex, Anthropic, Cursor (experimental), or the Z.ai coding plan) or an OpenRouter API key:

```bash
atomic
/login   # then select your provider
```

Using one of these providers is the best way to get the full Atomic workflow experience. **If Atomic is missing a provider you want, [open an issue](https://github.com/bastani-inc/atomic/issues/new) and we'll add it that day.**

For API-key-only setup, export the key before starting Atomic:

```bash
export OPENROUTER_API_KEY=sk-or-...
atomic
```

After authenticating, run `/atomic` for workflow guides, examples, and next steps. On a fresh install, Atomic also shows a one-time workflow-engine explanation after any What's New notes and directly above the normal input box.

See [Providers & Models](./packages/coding-agent/README.md#providers--models) for the full provider list (API keys + subscriptions). For non-interactive use, `atomic -p "<prompt>"` prints the response and exits.

> ⚠️ Workflows run with agent permission checks **disabled** so pipelines don't block on prompts. Run autonomous workflows inside a devcontainer, VM, or remote dev machine — not your host machine.

<details>
<summary><b>Prerequisites, devcontainer</b></summary>

**Prerequisites** — install Node.js 24 LTS+, a global package manager, model-provider access, and a compatible terminal. See [Providers & Models](./packages/coding-agent/README.md#providers--models) and [Terminal setup](./packages/coding-agent/docs/terminal-setup.md).

**Devcontainer / VM** — recommended for autonomous workflows. Atomic runs in any standard devcontainer or VM image with Node.js 24 LTS+ installed; install it inside the container with `npm install -g @bastani/atomic` (or the install script) and supply provider credentials via environment variables.

See [Programmatic Usage](./packages/coding-agent/README.md#programmatic-usage) for the SDK and RPC entry points.

</details>

### Migrating from another coding agent

Atomic publishes an agent-readable **[`llms.txt`](https://docs.bastani.ai/llms.txt)**. Ask your current coding agent to:

```text
Install and set up Atomic by following https://docs.bastani.ai/llms.txt.
```

---

## Verifiable agent runs

Atomic is the **runtime**. **Loops** are repeatable agent systems you can build on it. **Workflows** make durable loops executable through stages, tools, prompts, checks, artifacts, gates, and approvals. Describe a loop in natural language or define it as a workflow in TypeScript when a clearly delegated autonomous job materially benefits from those capabilities.

Use Atomic for implementation, debugging, migration, refactoring, release prep, QA, docs, and other work with real done criteria. Keep interactive work inline and use bounded subagents when the parent should remain in control. Loop or stop-condition phrasing such as "do X until Y", "repeat until", "iterate until", "review/fix until passing", "run checks and fix until green", or "keep going until done" is a key workflow signal when the user delegates execution: choose a workflow so the stop condition, retries, evidence, and convergence are tracked.

Atomic can power:

- **Coding loops** — research, plan, implement, test, review, and ship.
- **Auto-research loops** — gather context, fan out analysis, synthesize findings, and write reports.
- **Developer assistant loops** — recurring tasks with memory, tools, checkpoints, and approval.
- **Issue triage loops** — classify, reproduce, deduplicate, route, prioritize, and draft fixes.
- **Content and research pipelines** — collect sources, analyze, draft, review, and publish.
- **Internal ops agents** — repeatable processes with approvals and logs.
- **Engineering automation** — migrations, release prep, QA, docs, incidents, and compliance.
- **Custom agent products** — build on Atomic's runtime, SDK, tools, and workflows.

Use case examples:

**Focused codebase research skill.**

```text
/skill:research-codebase how the rate limiter works in src/middleware/
```

**Deep codebase research workflow.**

```text
/workflow deep-research-codebase prompt="Map every callsite of the legacy auth middleware so we can migrate to session-v2"
```

**Create-spec skill.**

```text
/skill:create-spec from research/docs/2026-03-rate-limit.md
```

**Need an autonomous, durable research-first implementation run? Use Ralph.** Ralph can start from a spec, GitHub issue, or crisp ticket description when its research, delegated implementation, iterative review, and durable execution add material value.

```text
Run ralph to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, and finish when burst traffic returns 429 with Retry-After.
```

Add `create_pr=true` to either `ralph` or `goal` only when you want that workflow's final pull-request stage and report after the review gate approves; prompt text alone does not opt in.

**Need a durable, reviewer-gated one-off run? Use goal.** Give it the task, expected outcome, and validation. Goal fits clearly delegated autonomous changes when its ledger and gates add material value. Multiple files, tests, or validation alone do not require it, but loop or stop-condition wording is a key workflow signal when the user delegates execution. It keeps the run bounded, captures receipts in a goal ledger, gates completion through reviewers, stops as `complete`, `blocked`, or `needs_human`, and can optionally run a final pull-request stage with `create_pr=true` after approval.

```text
Use goal to update the CLI docs for --json, include one example, run the docs build, and finish when the build passes.
```

---

## Why Atomic

Coding agents are powerful, but trust breaks when the process is hidden. Atomic is the control plane for agent work you need to verify: it enforces scoped instructions, bounded stages, tool access, artifacts, checks, review gates, checkpoints, and human approvals.

Use it for runs like:

- Research -> spec -> implement -> test -> review for features and refactors.
- Reproduce -> diagnose -> patch -> verify for bugs.
- Map callsites -> migrate in waves -> run checks for cross-repo changes.
- Inspect diffs -> fix risks -> re-check for reviews.
- Release, QA, docs, or compliance work that needs evidence and approval gates.

The point is trustworthy autonomy: agents follow the runtime, you inspect the proof, and long-running work stays controllable, auditable, resumable, and reviewable.

## What developers are saying

> "Atomic feels like a stronger development interface. I can keep long-running tasks in an inspectable shell instead of tangled in chat."

> "I can rely on bundled workflows and skills instead of stitching together separate tools."

> "I spend less time babysitting agents because Atomic gives them a codified path for common tasks, so I can focus on product and architecture decisions."

## What makes a run verifiable?

Verifiability is runtime behavior.

Atomic defines what runs, what context each stage receives, what it must produce, which checks pass next, and where humans approve. Artifacts make that enforced process auditable.

Atomic verifiability comes from:

- **Workflow-shaped execution** through staged, bounded runs with scoped context, tools, handoffs, and done criteria.
- **Evidence artifacts and receipts** for persistent proof of claims, diffs, commands, outputs, blockers, and remaining risk.
- **Structured output contracts** for schema-validated handoffs, decisions, and failure states.
- **Adversarial review** through fresh-context verifier passes that inspect the actual work against the contract.
- **Reducer-enforced gates** for deterministic approve, retry, block, or human-escalation decisions.
- **Executable validation before approval** through runtime checks, external tools, and human gates before risky steps.
- **Checkpoints and resumability** for long-running or parallel work.

The selected model still generates text and code. Confidence comes from runtime-enforced structure, evidence, and review.

## Connect your engineering stack

Atomic works with the tools already available in your development environment. These are examples, not a fixed integration list: Atomic workflows can use any tool your development environment exposes through CLIs, MCP, APIs, scripts, or custom extensions.

| Need | Tools | How Atomic connects |
| ---- | ----- | ------------------- |
| Code and reviews | <img width="24" alt="GitHub" src="https://cdn.simpleicons.org/github/181717/FFFFFF" /> <img width="24" alt="GitLab" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/gitlab/gitlab-original.svg" /> <img width="24" alt="Git" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/git/git-original.svg" /> | CLI tools like `gh`/`glab`, MCP, or web access |
| Tickets and docs | <img width="24" alt="Jira" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/jira/jira-original.svg" /> <img width="24" alt="Linear" src="https://cdn.simpleicons.org/linear/5E6AD2/FFFFFF" /> <img width="24" alt="Notion" src="https://cdn.simpleicons.org/notion/000000/FFFFFF" /> <img width="24" alt="Slack" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/slack/slack-original.svg" /> | MCP servers, APIs, or custom tools |
| Build and runtime | <img width="24" alt="Docker" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/docker/docker-original.svg" /> <img width="24" alt="Kubernetes" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/kubernetes/kubernetes-original.svg" /> <img width="24" alt="AWS" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/amazonwebservices/amazonwebservices-original-wordmark.svg" /> <img width="24" alt="Google Cloud" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/googlecloud/googlecloud-original.svg" /> <img width="24" alt="Azure" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/azure/azure-original.svg" /> | Installed CLIs such as `docker`, `kubectl`, `aws`, `gcloud`, or `az` |
| Observability and data | <img width="24" alt="Sentry" src="https://cdn.simpleicons.org/sentry/362D59/FFFFFF" /> <img width="24" alt="Datadog" src="https://cdn.simpleicons.org/datadog/632CA6/FFFFFF" /> <img width="24" alt="PostgreSQL" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/postgresql/postgresql-original.svg" /> | CLIs, MCP servers, APIs, or custom tools |
| UI validation | <img width="24" alt="Playwright" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/playwright/playwright-original.svg" /> <img width="24" alt="Chrome" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/chrome/chrome-original.svg" /> | Built-in skills and browser automation |

You bring the credentials and permissions; Atomic brings the runtime that lets workflows use them in staged, inspectable, verifiable runs.

---

## What you get

Atomic ships three top-level building blocks for verifiable agent runs: **workflows**, **skills**, and **specialized subagents**.

### 1. Workflows

Workflows define the executable process: inputs, stages, branches, parallelism, retries, checks, artifacts, checkpoints, and human review gates. Default to workflows for non-trivial work and requests with inherent structure plus a verifiable objective; use direct chat for tiny deterministic low-risk work. Workflow-first is not builtin-only or monolithic: Atomic can author custom TypeScript `workflow({...})` definitions inline, import reusable project/package workflows or builtins from `@bastani/workflows/builtin`, and nest them with `ctx.workflow(...)`. Nested children may compose further workflows within `maxDepth`, enabling reusable research, implementation, design, verification, and approval graphs alongside dynamic fan-out, HIL gates, and bounded loops.

| Workflow                 | What it does                                                                                                                                                                                                                                                                                                                                                                | Example input                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`                   | Durable execution for autonomous work that benefits from bounded worker turns, receipts in a goal ledger, named validation, and reviewer-gated completion. It stops as `complete`, `blocked`, or `needs_human`, and only prepares a pull-request report when `create_pr=true` after approval. Task size alone is not a reason to select it. | `/workflow goal objective="Update the CLI docs for --json, include one example, run the docs build, and finish when it passes"` |
| `ralph`                  | Durable research-first execution for autonomous work that benefits from prompt engineering, repo research, delegated implementation, and iterative review. It writes research artifacts under `research/`, follows up on reviewer feedback, and only prepares a pull-request report when `create_pr=true`. Task size alone is not a reason to select it. | `/workflow ralph prompt="Port the rate-limit rollout to the new API gateway" create_pr=true` |
| `deep-research-codebase` | Repo-wide research for broad, cross-cutting questions. It scouts the codebase, runs parallel specialist waves, aggregates findings, and writes durable research artifacts under `research/`. Prefer `/skill:research-codebase` for a focused subsystem or question.                                                                                                         | `/workflow deep-research-codebase prompt="How do payment retries work end to end?"`                                                                                                           |
| `open-claude-design`     | End-to-end design generation: interviews for output type/references, discovers your design system, generates from a prompt, refines with feedback, and exports a handoff directory.                                                                                                                                                                                        | `/workflow open-claude-design prompt="Team activity feed prototype using ./mocks/feed.png as a reference"`                                                                                    |
| _author your own_        | Anything outside the built-ins: issue-to-PR, review-to-merge, migration, triage, release, compliance, or team-specific review pipelines. Describe the process in natural language and Atomic can scaffold a typed `workflow({...})` file with CLI inputs.<br><br>Atomic prompts your coding agent to reference these docs by default, but you can skim them to guide workflow construction yourself: choose a [starter pattern](./packages/coding-agent/docs/workflow-when-to-use.md#workflow-starter-patterns), then review [Author workflows](./packages/coding-agent/docs/workflow-authoring.md), [Guiding Principles](./packages/coding-agent/docs/workflow-authoring.md#guiding-principles), [context handoffs](./packages/coding-agent/docs/workflow-context.md#compression-and-artifact-handoffs), the [Design Checklist](./packages/coding-agent/docs/workflow-context.md#design-checklist), and [Common Mistakes](./packages/coding-agent/docs/workflow-context.md#common-mistakes). When designing a workflow, treat existing [Atomic workflows](./packages/coding-agent/docs/workflow-builtins.md), [subagents](./packages/coding-agent/docs/subagents.md), and [skills](./packages/coding-agent/docs/skills.md) as building blocks you can compose into your own process; they already package capabilities tuned for developer workflows, so you can leverage them instead of recreating that behavior from scratch. | _"Create a reusable workflow that takes an issue, writes a plan, creates a branch, runs implementation and review stages, runs tests and lint, then stops for approval before final output."_ |

Run `/workflow list` to see installed workflows and `/workflow inputs <name>` for input schemas. `/workflow status <id>`, `/workflow connect <id>`, `/workflow quit <id>`, and `/workflow resume <id>` manage running or paused runs; quit pauses work gracefully so it remains resumable. Run `/workflow connect <run>` to see agents working and chat with or steer each stage, or ask in the current chat for status or steering at any point. Runnable references live in [`packages/coding-agent/examples/`](./packages/coding-agent/examples).

### 2. Skills

Skills are reusable expert instructions and process modules. They auto-invoke when Atomic detects a relevant trigger, or you can call them directly with `/skill:<name>`.

| Skill               | Purpose                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research-codebase` | Dispatch parallel sub-agents to analyze a focused area and write a dated research doc under `research/`                                                               |
| `create-spec`       | Produce a technical execution spec under `specs/`, grounded in research documents and engineer feedback                                                               |
| `subagent`          | Delegate work to bundled or custom sub-agents with chains, parallel groups, async runs, and forked context                                                            |
| `intercom`          | Coordinate session-to-session: send messages, delegate tasks, and handle `contact_supervisor` escalations from child sub-agents on the same machine                   |
| `prompt-engineer`   | Sharpen prompts, research questions, and workflow inputs using prompt-engineering best practices                                                                      |
| `tdd`               | Red-green-refactor loop with a built-in testing-anti-patterns guide                                                                                                   |
| `tmux`              | Control tmux-compatible terminal sessions for interactive CLIs: capture panes, send keys, paste text, and verify terminal app behavior                                |
| `playwright-cli`    | Automate browser interactions, run end-to-end UI checks, record reviewable videos, and work with Playwright tests                                                     |
| `liteparse`         | Fast, local, model-free extraction of text, tables, and values from PDF, DOCX, PPTX, XLSX, and image files via the `lit` CLI                                          |
| `impeccable`        | Design, redesign, audit, or polish frontend interfaces (vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable))                                    |

### 3. Specialized sub-agents

Sub-agents are purpose-built agents with scoped context, tools, and termination conditions. Atomic bundles **8 sub-agents** from [`packages/subagents/agents/`](./packages/subagents/agents/). Workflows and skills use them to split large jobs into smaller, auditable passes.

| Sub-agent                    | Purpose                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `codebase-locator`           | Locate files, directories, and components relevant to a task                                          |
| `codebase-analyzer`          | Analyze implementation details of specific components                                                 |
| `codebase-pattern-finder`    | Find similar implementations and usage examples in the codebase                                       |
| `codebase-online-researcher` | Fetch up-to-date docs and authoritative sources from the web (uses `playwright-cli`)                  |
| `codebase-research-locator`  | Discover prior research documents in `research/` that are relevant to the current task                |
| `codebase-research-analyzer` | Deep-dive analysis of local research documents to extract decisions, rationale, and technical details |
| `code-simplifier`            | Clean up, simplify, and refine recently written code without changing behavior                        |
| `debugger`                   | Debug errors, test failures, and unexpected behavior (uses `tdd` and `playwright-cli`)                |

<details>
<summary><i>Why specialized agents instead of one general agent?</i></summary>

LLMs have an architectural limitation: the more context they hold, the harder it is to attend to the right information. A single agent juggling a spec, dozens of files, tool outputs, and its own reasoning will lose details, repeat work, or hallucinate connections. Specialized sub-agents help with **context isolation** (fresh, minimal context per job), **tool scoping** (a `codebase-locator` cannot edit files; a `code-simplifier` cannot reach the web), and **parallel execution** (independent agents run concurrently).

</details>

---

## Documentation

Full documentation lives at **[docs.bastani.ai](https://docs.bastani.ai/)** — the CLI and SDK reference, security model, containerized execution, the workflow panel, session management, configuration, troubleshooting, FAQ, and side-by-side comparisons with Claude Code Dynamic Workflows, Spec-Kit, DeerFlow, and Hermes.

The docs are open source in this repository under [`packages/coding-agent/docs`](./packages/coding-agent/docs). Open a PR against this project to suggest a change.

---

## What Atomic is / what Atomic is not

### Atomic is

- The verifiable coding agent runtime.
- A runtime for building and running agent loops in natural language or TypeScript.
- A control plane for loops that prompt agents, run tools, enforce checks, create artifacts, and stop for approval.
- An open-source terminal runtime and TypeScript workflow SDK.
- A model-agnostic harness for providers, tools, MCP, subagents, artifacts, checks, and review gates.

### Atomic is not

- Just another coding assistant.
- A wrapper around Claude Code, Codex, Cursor, OpenCode, or Copilot CLI.
- A generic agent framework where you assemble every primitive from scratch.
- A promise that model output is deterministic.
- A checklist that the model may or may not follow.

---

## What happens during a run?

An Atomic workflow run is a directed acyclic execution graph. Stages become nodes, dependencies become edges, parallel work becomes branches, and checks and approvals control what may proceed.

```text
issue or goal -> research -> plan -> agent stages -> artifacts -> checks -> review gate -> final output
```

Each stage can prompt an agent, run tools, call MCP servers, save artifacts, pass selected output forward, branch, retry, run in parallel, or pause for approval.

The graph structure is deterministic and inspectable. Model output can vary; the stage order, inputs, handoffs, checks, gates, and artifacts are explicit.

---

## Built on Pi, extended for verifiable runs

Atomic is the Atomic-branded fork of Pi's coding-agent CLI. The published `@bastani/atomic` package bundles first-party workflow, subagent, MCP, web-access, and intercom extensions.

That means Atomic is itself the coding-agent runtime: the selected model gets file editing, shell, write/edit tools, MCP, skills, workflows, and subagent capabilities inside Atomic. Atomic connects to model providers directly through API keys or supported subscription login.

Pi gives Atomic a mature, extensible harness. Atomic adds the runtime layer for verifiable agent work: workflow files, review gates, auditable artifacts, resumable runs, checkpoints, and multi-stage execution.

---

## FAQ

### Is Atomic another coding agent?

Atomic is a coding-agent CLI, but its main product idea is the verifiable runtime around the agent session: scoped instructions, stages, checks, artifacts, checkpoints, subagents, review gates, and human approvals.

### Why not just use Claude Code, Codex, Cursor, or OpenCode?

Use interactive coding tools for fast back-and-forth. Use Atomic when work needs a verifiable run you can control and inspect: research, specs, implementation stages, tests, lint, reviewer passes, artifacts, and approval before handoff.

Atomic is not running those tools under the hood. It is a Pi-based coding-agent harness and verifiable runtime that connects to model providers directly.

### How is Atomic different from Claude Code Dynamic Workflows?

Claude Code Dynamic Workflows and Atomic both split larger work into stages, run agents in parallel, verify results, and preserve enough state to finish long-running tasks.

Atomic's category is broader and more explicit: the verifiable coding agent runtime. The difference is where control lives and how much of the run you can inspect, version, extend, verify, and connect to your stack.

| Dimension                  | Atomic                                                                                                                                                                                                                                                                  | Claude Code Dynamic Workflows                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core idea                  | Open-source, repo-native runtime for verifiable coding-agent runs. You can run built-ins, tell the coding agent to use a workflow for a task, describe new runs in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents.                                                   |
| Best fit                   | Teams that want repeatable software engineering runs they can control, inspect, version, extend, connect to tools, and verify.                                                                                                                                                  | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically.                                          |
| Workflow control           | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, checkpoints, and human gates are part of the workflow definition.                                                                                                                              | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run.                                              |
| Models                     | Model-agnostic. Atomic connects directly to supported API-key and subscription providers, and workflows can use model fallback chains.                                                                                                                                  | Claude-first. Availability is tied to Claude Code, Claude plans, and Anthropic-supported API/cloud channels.                                                       |
| Extensibility              | Built on Pi extensions: add tools, TUI, MCP, web access, intercom, skills, prompt templates, themes, custom providers, and packaged workflows.                                                                                                                          | Optimized for Claude Code's built-in dynamic orchestration experience rather than an open extension SDK you own in-repo.                                           |
| Artifacts and auditability | Research docs, specs, logs, transcripts, reviewer notes, check output, and final summaries can live in the repo or workflow run directory.                                                                                                                              | Progress is saved and resumable, but the orchestration is primarily a Claude Code runtime behavior.                                                                |
| Cost/scale posture         | You choose the graph and concurrency. Atomic can be small and deterministic, or broad when you intentionally design a larger workflow.                                                                                                                                  | Designed for large fan-outs, including tens to hundreds of subagents; Anthropic notes it can consume substantially more tokens than a typical Claude Code session. |

### Why not markdown checklists or CLAUDE.md?

Markdown instructions help set context, but the model still has to remember and follow them. Atomic runs the process: which stage runs, what context it receives, what artifact it must produce, what checks run next, and where a human approves.

### Is Atomic deterministic?

Atomic makes the run structure deterministic: stage order, inputs, handoffs, checks, gates, and artifacts are explicit. Model output is generated by the selected model and can vary.

### Why not LangGraph or a generic agent framework?

Atomic is repo-native and software-engineering-native. It is designed around verifiable engineering runs: issues, research docs, specs, branches, diffs, tests, lint, artifacts, reviewers, workflow files, approvals, and PR-ready handoffs — not around building a generic agent application from primitives.

### Where do artifacts live?

Research lives in `research/`, specs live in `specs/`, and workflow runs can persist plans, logs, transcripts, reviewer notes, check output, and final summaries. These artifacts make each run auditable after Atomic has enforced the verifiable process at runtime.

---

## Workflow playbook

Want better results from coding agents and workflow systems? Read the [Workflow Playbook](./docs/workflow-playbook.md) for a practical, personal guide to writing tighter objectives, constraining scope, steering long-running work, validating results, and turning agent output into reliable engineering handoffs.

---

## Support & ideas

Join the [Atomic Discord community](https://discord.gg/9CvdXUGXR4) to get in touch with us and other Atomic users. Use it for questions and help, feedback or feature ideas, and sharing what you've been able to build with Atomic.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [DEV_SETUP.md](DEV_SETUP.md) for development setup and testing details.

Looking to contribute workflows? Check out the atomic-workflows repo [here](https://github.com/lavaman131/atomic-workflows).

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Pi](https://pi.dev)
- [Superpowers](https://github.com/obra/superpowers)
- [Anthropic Skills](https://github.com/anthropics/skills)
- [Ralph Wiggum Method](https://ghuntley.com/ralph/)
- [OpenAI Codex Cookbook](https://github.com/openai/openai-cookbook)
- [HumanLayer](https://github.com/humanlayer/humanlayer)
- [Impeccable](https://github.com/pbakaus/impeccable)
