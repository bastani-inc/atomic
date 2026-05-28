<h1 align="center">Atomic</h1>

<p align="center"><img width="800" height="450" alt="atomic-promo" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>Atomic is the workflow layer for coding agents, giving developers a programmable control plane for complex engineering work.</b><br>
  <i>An open-source, model-agnostic take on dynamic workflows for software engineering — with Pi extensions, custom models, MCP, sub-agents, artifacts, and review gates.</i>
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#spec-driven-development">Spec-driven development</a>
  &nbsp;·&nbsp;
  <a href="#when-should-i-use-atomic">When to use Atomic</a>
  &nbsp;·&nbsp;
  <a href="#faq">FAQ</a>
  &nbsp;·&nbsp;
  <a href="https://docs.bastani.ai/">Docs</a>
</p>

<p align="center">
  <a href="https://docs.bastani.ai/"><img src="https://img.shields.io/badge/docs-atomic-blue" alt="Docs"></a>
  <a href="https://discord.gg/9CvdXUGXR4"><img src="https://img.shields.io/badge/join%20community-discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://deepwiki.com/flora131/atomic"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/Bun-Runtime-f9f1e1?logo=bun&logoColor=black" alt="Bun"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

## Get started

### Prerequisites

- **Node.js 24 LTS or newer** — Atomic requires the latest Node LTS runtime. Check with `node --version`.
- **A package manager** — use npm (included with Node), pnpm, Yarn, or Bun. Use Bun 1.3.14+ for Bun installs or workflow-authoring examples.
- **Model-provider access** — bring an API key or sign in with `/login` after startup.
- **A compatible terminal** — for the best TUI experience, use a terminal with Kitty keyboard protocol support. See [Terminal setup](./packages/coding-agent/docs/terminal-setup.md). On Windows, use Git Bash or WSL.

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

Set an API key and start a session:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
atomic
```

Or sign in to an existing subscription:

```bash
atomic
/login   # then select a provider — Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, …
```

After signing in, run `/atomic` to start the guided onboarding for workflows, examples, and next steps.

See [Providers & Models](./packages/coding-agent/README.md#providers--models) for the full provider list (API keys + subscriptions). For non-interactive use, `atomic -p "<prompt>"` prints the response and exits.

> ⚠️ Workflows run with agent permission checks **disabled** so pipelines don't block on prompts. Run autonomous workflows inside a devcontainer, VM, or remote dev machine — not your host machine.

<details>
<summary><b>Prerequisites, devcontainer</b></summary>

**Prerequisites** — install Node.js 24 LTS+, a global package manager, model-provider access, and a compatible terminal. See [Providers & Models](./packages/coding-agent/README.md#providers--models) and [Terminal setup](./packages/coding-agent/docs/terminal-setup.md).

**Devcontainer / VM** — recommended for autonomous workflows. Atomic runs in any standard devcontainer or VM image with Node.js 24 LTS+ installed; install it inside the container with `npm install -g @bastani/atomic` (or the install script) and supply provider credentials via environment variables.

See [Programmatic Usage](./packages/coding-agent/README.md#programmatic-usage) for the SDK and RPC entry points.

</details>

---

## Spec-driven development

The fastest way to understand Atomic is to follow the built-in spec-driven development loop:

```text
research the codebase -> create a spec -> run the implementation workflow -> review the artifacts
```

### 1. Research the codebase

Use focused research when you know the subsystem or question:

```text
/skill:research-codebase how the rate limiter works in src/middleware/
```

Atomic dispatches specialized agents, writes grounded findings into the repo, and leaves behind research that future runs can reuse.

For heavy work — migrations, large refactors, cross-cutting behavior, or anything that touches many packages — run repo-wide deep research:

```text
/workflow deep-research-codebase prompt="Map every callsite of the legacy auth middleware so we can migrate to session-v2"
```

*You can also invoke workflows conversationally — for example, `run deep research to map every callsite of the legacy auth middleware so we can migrate to session-v2` — if you prefer not to use a slash command.*

`deep-research-codebase` works like a repo indexing pass: scout the codebase, fan out parallel specialist research, aggregate the findings, and write durable Markdown artifacts under `research/`. That research becomes shared project memory.

### 2. Create the spec

Turn research into an implementation-ready plan:

```text
/skill:create-spec from research/docs/2026-03-rate-limit.md
```

If you are not sure what you want yet, brainstorm with Atomic first: explore trade-offs, compare approaches, then ask it to save the selected direction as a spec. Either way, the output is a repo-native artifact under `specs/` that an engineer can review before implementation starts.

### 3. Implement with `goal` or `ralph`

Ask Atomic in natural language to use the workflow that matches the scope:

```text
Use goal to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, and finish when burst traffic returns 429 with Retry-After.
Run ralph to port the VS Code desktop shell from Electron to Tauri/Rust while preserving extension loading, IPC, workspace state, and settings migration.
```

Use `goal` for small-to-medium scope changes when you can identify the work surface, state the exact outcome you want, and name the validation that proves it is done — for example specific tests, lint/typecheck commands, docs builds, or observable behavior. It keeps the run bounded, captures receipts in a goal ledger, gates completion through reviewers, and stops as `complete`, `blocked`, or `needs_human`.

Keep using `ralph` for larger migrations, broad refactors, multi-package changes, and spec-to-PR work where you want Atomic to plan the approach, delegate implementation through sub-agents, simplify, review, iterate, and prepare a pull-request report.

---

## Why Atomic

Coding agents are useful for local edits and short interactive sessions. The bigger opportunity is automating the developer workflows around them: research, planning, implementation, review, release prep, incident response, migrations, QA, docs, and anything else a team can describe as repeatable engineering work.

**Atomic is a programmable control plane for developer workflows.** Define the steps, branch when needed, run stages in parallel, isolate context, save artifacts, call tools, run checks, and stop for human approval before the next critical action. If a workflow matters, Atomic gives you a way to automate it, inspect it, and extend it.

We built Atomic so you can stop babysitting the coding agent. Instead of watching every step, re-prompting when context drifts, and wondering whether the right checks ran, you get a workflow that produces inspectable artifacts and confidence in the result.

Atomic's point of view is simple: developers should own the automation layer for their work. Do not leave important engineering tasks to a black-box autonomous session and hope the agent followed the right process. Make the workflow explicit, model-agnostic, inspectable, repeatable, and auditable.

---

## What Atomic is / what Atomic is not

### Atomic is

- A workflow automation layer for developers and coding agents.
- A way to automate any repeatable developer workflow: research, specs, implementation, checks, review, release prep, incident response, docs, and handoff.
- An open-source coding-agent CLI and TypeScript workflow SDK.
- A powerful, extensible Pi-based harness with first-party workflow, sub-agent, MCP, web-access, and intercom extensions bundled in.
- A model-agnostic way to connect providers, tools, approvals, and artifacts into explicit engineering workflows instead of a single fragile agent session.

### Atomic is not

- A wrapper around Claude Code, Codex, Cursor, OpenCode, or Copilot CLI.
- A replacement for those tools when you want a quick interactive coding session.
- A generic agent framework where you build agents from primitives.
- A promise that model output is deterministic.
- A markdown checklist that the model may or may not follow.

---

## When should I use Atomic?

Use Atomic when the work is bigger than one prompt and the process matters.

Atomic is for developers who want **control over the workflow**, not blind delegation to a model. You define the process, keep human-in-the-loop gates at critical stages, inspect the artifacts, and verify exactly which checks ran before trusting the result.

Reach for Atomic when you are doing:

- Large refactors that need research, staged edits, tests, and review.
- Migrations across many files, packages, or services.
- Spec-driven feature work where research and plans should live in the repo.
- Debugging flows that need reproduction, diagnosis, fix, and verification.
- Codebase research that should become durable team memory.
- Repeatable sequences you currently run by hand: research -> plan -> implement -> simplify -> test -> review.
- Markdown instructions, prompts, or checklists that you want the agent to actually follow as executable workflow steps.

You probably do not need Atomic for a small one-file edit, a quick code question, or a casual interactive pairing session.

---

## What happens during a run?

An Atomic workflow is an explicit execution graph around model-backed agent sessions:

```text
issue or goal -> research -> spec or plan -> branch or workspace -> agent steps -> artifacts -> checks -> review gate -> final output
```

Each step can:

- run an Atomic coding-agent session with scoped context,
- call tools and MCP servers,
- run shell commands,
- save artifacts such as research, specs, transcripts, logs, diffs, and check output,
- pass selected output to later steps,
- run steps in parallel,
- retry or branch based on results,
- pause for human approval before continuing.

Atomic makes the **workflow** deterministic and inspectable: step order, inputs, handoffs, checks, gates, and artifacts are explicit. The model's exact text and code output is still generated by the selected model and can vary.

---

## What you get

Atomic ships three top-level building blocks: **workflows**, **skills**, and **specialized sub-agents**.

### 1. Workflows

Workflows define the outer loop: inputs, steps, branches, parallelism, retries, checks, artifacts, and human review gates. Each stage runs an Atomic coding-agent session with the model provider you configured.

| Workflow                 | What it does                                                                                                                                                                                                                                                                           | Example input                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`                   | Focused workflow for small-to-medium changes when you can name the scope, exact desired outcome, and validation in the objective. It runs bounded worker turns, stores receipts in a goal ledger, requires reviewer quorum before completion, and stops as `complete`, `blocked`, or `needs_human`. | `/workflow goal objective="Update the CLI docs for --json, include one example, run the docs build, and finish when it passes"`                                                                |
| `ralph`                  | Heavier plan → orchestrate → simplify → discover → review loop for larger migrations, broad refactors, multi-package changes, and spec-to-PR work. It writes RFC-style specs, delegates implementation through sub-agents, iterates on reviewer feedback, and prepares a PR report. | `/workflow ralph prompt="Plan, implement, review, and prepare a PR for specs/2026-03-rate-limit.md"`                                                                                          |
| `deep-research-codebase` | Repo-wide research for broad, cross-cutting questions. It scouts the codebase, runs parallel specialist waves, aggregates findings, and writes durable research artifacts under `research/`. Prefer `/skill:research-codebase` for a focused subsystem or question.                    | `/workflow deep-research-codebase prompt="How do payment retries work end to end?"`                                                                                                           |
| `open-claude-design`     | End-to-end design generation: discovers your design system, generates from a prompt, refines with feedback, and exports a handoff directory.                                                                                                                                           | `/workflow open-claude-design prompt="Team activity feed" reference=./mocks/feed.png output_type=prototype`                                                                                   |
| _author your own_        | Anything outside the built-ins: issue-to-PR, review-to-merge, migration, triage, release, compliance, or team-specific review pipelines. Describe the process in natural language and Atomic can scaffold a `defineWorkflow()` file with typed CLI flags.                              | _"Create a reusable workflow that takes an issue, writes a plan, creates a branch, runs implementation and review stages, runs tests and lint, then stops for approval before final output."_ |

Run `/workflow list` to see installed workflows and `/workflow inputs <name>` for input schemas. `/workflow status <id>`, `/workflow connect <id>`, and `/workflow resume <id>` manage running or paused runs. Runnable references live in [`packages/coding-agent/examples/`](./packages/coding-agent/examples).

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
| `playwright-cli`    | Automate browser interactions, tests, and screenshots                                                                                                                 |
| `impeccable`        | Design, redesign, audit, or polish frontend interfaces (Anthropic's frontend-design skill, vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable)) |

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

## Built on Pi, extended for workflows

Atomic is the Atomic-branded fork of Pi's coding-agent CLI. The published `@bastani/atomic` package bundles first-party workflow, sub-agent, MCP, web-access, and intercom extensions.

That means Atomic is itself the coding-agent runtime: the selected model gets file editing, shell, write/edit tools, MCP, skills, workflows, and sub-agent capabilities inside Atomic. Atomic connects to model providers directly through API keys or supported subscription login.

Pi gives Atomic a mature, extensible harness. Atomic adds process-as-code for coding-agent work: workflow files, review gates, artifacts, resumable runs, and multi-stage execution.

---

## FAQ

### Is Atomic another coding agent?

Atomic is a coding-agent CLI with a workflow layer built in. It connects to model providers and gives the selected model tools for repo work, but the main product idea is the explicit process around that agent session: research, specs, stages, checks, artifacts, and review gates.

### Why not just use Claude Code, Codex, Cursor, or OpenCode?

Use interactive coding tools when you want a fast back-and-forth session. Use Atomic when the work needs a repeatable engineering process you can inspect: repo research, spec creation, implementation stages, tests, lint, reviewer passes, artifacts, and human approval before final handoff.

Atomic is not running those tools under the hood. It is a Pi-based coding-agent harness that connects to model providers directly.

### How is Atomic different from Claude Code Dynamic Workflows?

Claude Code Dynamic Workflows and Atomic are trying to solve a similar class of problem: important software engineering work is too large for one agent pass, so the system should split the job into stages, run agents in parallel, verify the result, and keep enough state to finish long-running work.

The difference is where control lives.

| Dimension | Atomic | Claude Code Dynamic Workflows |
| --- | --- | --- |
| Core idea | Open-source, repo-native workflow automation for coding agents. You can run built-ins, tell the coding agent to use a workflow for a task, describe new workflows in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents. |
| Best fit | Teams that want repeatable software engineering workflows they can inspect, version, extend, and run across providers. | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically. |
| Workflow control | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, and human gates are part of the workflow definition. | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run. |
| Models | Model-agnostic. Atomic connects directly to supported API-key and subscription providers, and workflows can use model fallback chains. | Claude-first. Availability is tied to Claude Code, Claude plans, and Anthropic-supported API/cloud channels. |
| Extensibility | Built on Pi extensions: add tools, TUI, MCP, web access, intercom, skills, prompt templates, themes, custom providers, and packaged workflows. | Optimized for Claude Code's built-in dynamic orchestration experience rather than an open extension SDK you own in-repo. |
| Artifacts and auditability | Research docs, specs, logs, transcripts, reviewer notes, check output, and final summaries can live in the repo or workflow run directory. | Progress is saved and resumable, but the orchestration is primarily a Claude Code runtime behavior. |
| Cost/scale posture | You choose the graph and concurrency. Atomic can be small and deterministic, or broad when you intentionally design a larger workflow. | Designed for large fan-outs, including tens to hundreds of subagents; Anthropic notes it can consume substantially more tokens than a typical Claude Code session. |

### Why not markdown checklists or CLAUDE.md?

Markdown instructions help set context, but the model still has to remember and follow them. Atomic turns the process into executable workflow steps: which stage runs, what context it receives, what artifact it must produce, what checks run next, and where a human must approve.

### Is Atomic deterministic?

Atomic makes the workflow deterministic: step order, inputs, handoffs, checks, gates, and artifacts are explicit. The model's output is not deterministic; it is generated by the selected model during each agent session.

### Why not LangGraph or a generic agent framework?

Atomic is repo-native and software-engineering-native. It is designed around issues, research docs, specs, branches, diffs, tests, lint, artifacts, reviewers, workflow files, and PR-ready handoffs — not around building a generic agent application from primitives.

### Where do artifacts live?

Research lives in `research/`, specs live in `specs/`, and workflow runs can persist plans, logs, transcripts, reviewer notes, check output, and final summaries. The goal is to make every important agent decision inspectable after the run.

---

## Documentation

Full documentation lives at **[docs.bastani.ai](https://docs.bastani.ai/)** — the CLI and SDK reference, security model, containerized execution, the workflow panel, session management, configuration, troubleshooting, FAQ, and side-by-side comparisons with Claude Code Dynamic Workflows, Spec-Kit, DeerFlow, and Hermes.

The docs are open source in this repository under [`packages/coding-agent/docs`](./packages/coding-agent/docs). Open a PR against this project to suggest a change.

---

## Support & ideas

Join the [Atomic Discord community](https://discord.gg/9CvdXUGXR4) to get in touch with us and other Atomic users. Use it for questions and help, feedback or feature ideas, and sharing what you've been able to build with Atomic.

---

## Contributing

See [DEV_SETUP.md](DEV_SETUP.md) for development setup, testing guidelines, and contribution workflow.

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
