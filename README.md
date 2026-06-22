<h1 align="center">Atomic — The Loop Engine For All (∀) Engineering Work</h1>

<p align="center"><img width="800" height="450" alt="atomic-promo" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>Loops for all (∀).</b><br>
  <b> Atomic runs reliable coding-agent loops for the work software engineers do every day.</b><br>
  <i>Describe the loop in natural language. Program it when reliability matters. Run it with stages, tools, artifacts, subagents, verification, review gates, checkpoints, and human approvals.</i>
</p>

<p align="center">
  Real engineering matter. Agents should not just sound confident, they should leave proof. Atomic fights demo hype with explicit stages, artifacts, verification, review, and approval gates.
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#production-grade-development-loops">Production-grade loops</a>
  &nbsp;·&nbsp;
  <a href="#why-atomic">When to use Atomic</a>
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
- **Model-provider access** — Use `/login` after startup. Supports provider subscriptions and APIs.

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

> ⚠️ **Workflow migration note:** The `defineWorkflow(...).compile()` builder API was removed in [#1457](https://github.com/bastani-inc/atomic/pull/1457). Custom workflows must now author with the `workflow({ name?, description, inputs, outputs, run })` object form — import `workflow` from `@bastani/workflows` and `Type` from `typebox` — and compose child workflows with normal TypeScript module imports passed to `ctx.workflow(workflowDefinition, options)` (registry names and path objects are no longer accepted). If an existing workflow no longer loads, ask Atomic to update it using the [workflow migration guide](./packages/coding-agent/docs/workflows.md#migrating-from-the-defineworkflow-builder-api) and the [workflow composition example](./packages/workflows/README.md#example-4--compose-workflows).

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

## Production-grade development loops

You do not have to run every step. Pick the smallest loop that fits the work:

**Need codebase context? Run research.**

```text
/skill:research-codebase how the rate limiter works in src/middleware/
```

For broad, cross-repo questions, run deep research instead:

```text
/workflow deep-research-codebase prompt="Map every callsite of the legacy auth middleware so we can migrate to session-v2"
```

**Want a reviewed plan first? Create a spec.**

```text
/skill:create-spec from research/docs/2026-03-rate-limit.md
```

**Ready to implement planned work? Use Ralph.** Ralph can start from a spec, GitHub issue, or crisp ticket description. It researches as needed, implements, reviews, records a QA proof video for UI/full-stack changes when practical, and iterates.

```text
Run ralph to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, and finish when burst traffic returns 429 with Retry-After.
```

If you want a PR too, ask Ralph to create one at the end.

**Small one-off task? Use goal.** Give it the task, expected outcome, and validation.

```text
Use goal to update the CLI docs for --json, include one example, run the docs build, and finish when the build passes.
```

---

## Why Atomic

Coding agents are good at local edits, but bigger work fails when the process is implicit: research gets skipped, acceptance criteria drift, checks are forgotten, and "done" arrives without evidence.

Atomic is a development interface and loop engine for that work. It separates long-running tasks from chat in an inspectable shell, bundles workflows and skills for common engineering paths, and brings research, planning, implementation, review, and validation into one coherent place.

Use it for loops like:

- Research -> spec -> implement -> test -> review for features and refactors.
- Reproduce -> diagnose -> patch -> verify for bugs.
- Map callsites -> migrate in waves -> run checks for cross-repo changes.
- Inspect diffs -> fix risks -> re-check for reviews.
- Release, QA, docs, or compliance work that needs evidence and approval gates.

The point is lower-touch agent work: give agents a codified path for common tasks so you can focus on product and architecture decisions instead of babysitting tools. Some loops take longer because they research, verify, and review — that is what makes the output easier to inspect, resume, and trust.

## What developers are saying

> "Atomic feels like a stronger development interface. I can keep long-running tasks in an inspectable shell instead of tangled in chat."

> "I can rely on bundled workflows and skills instead of stitching together separate tools."

> "I spend less time babysitting agents because Atomic gives them a codified path for common tasks, so I can focus on product and architecture decisions."

## What makes a loop reliable?

Reliable means the agent does not just say it finished. It leaves evidence.

Atomic reliability comes from:

- **Stages** that make the process explicit instead of one oversized autonomous prompt.
- **Isolated context** so research, implementation, review, and verification can each focus on the right inputs.
- **Tools and MCP access** for shell commands, repository edits, external systems, and team-specific actions.
- **Durable artifacts** such as research docs, specs, transcripts, logs, diffs, reviewer notes, and check output.
- **Verification checks** that prove the requested behavior, not merely that the agent feels confident.
- **Subagent delegation** for locator, analyzer, debugger, reviewer, simplifier, web, browser, and terminal passes.
- **Checkpoints and resumability** for long-running work that should survive interruption and continue with state.
- **Review gates and human approvals** before risky, costly, or externally visible steps.

Atomic makes the loop deterministic and inspectable: step order, inputs, handoffs, checks, gates, and artifacts are explicit. The selected model still generates the text and code, so correctness comes from evidence and review rather than a promise of deterministic model output.

## Connect your engineering stack

Atomic works with the tools already available in your development environment. These are examples, not a fixed integration list: Atomic workflows can use any tool your development environment exposes through CLIs, MCP, APIs, scripts, or custom extensions.

| Need | Tools | How Atomic connects |
| ---- | ----- | ------------------- |
| Code and reviews | <img width="24" alt="GitHub" src="https://cdn.simpleicons.org/github/181717/FFFFFF" /> <img width="24" alt="GitLab" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/gitlab/gitlab-original.svg" /> <img width="24" alt="Git" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/git/git-original.svg" /> | CLI tools like `gh`/`glab`, MCP, or web access |
| Tickets and docs | <img width="24" alt="Jira" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/jira/jira-original.svg" /> <img width="24" alt="Linear" src="https://cdn.simpleicons.org/linear/5E6AD2/FFFFFF" /> <img width="24" alt="Notion" src="https://cdn.simpleicons.org/notion/000000/FFFFFF" /> <img width="24" alt="Slack" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/slack/slack-original.svg" /> | MCP servers, APIs, or custom tools |
| Build and runtime | <img width="24" alt="Docker" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/docker/docker-original.svg" /> <img width="24" alt="Kubernetes" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/kubernetes/kubernetes-original.svg" /> <img width="24" alt="AWS" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/amazonwebservices/amazonwebservices-original-wordmark.svg" /> <img width="24" alt="Google Cloud" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/googlecloud/googlecloud-original.svg" /> <img width="24" alt="Azure" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/azure/azure-original.svg" /> | Installed CLIs such as `docker`, `kubectl`, `aws`, `gcloud`, or `az` |
| Observability and data | <img width="24" alt="Sentry" src="https://cdn.simpleicons.org/sentry/362D59/FFFFFF" /> <img width="24" alt="Datadog" src="https://cdn.simpleicons.org/datadog/632CA6/FFFFFF" /> <img width="24" alt="PostgreSQL" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/postgresql/postgresql-original.svg" /> | CLIs, MCP servers, APIs, or custom tools |
| UI validation | <img width="24" alt="Playwright" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/playwright/playwright-original.svg" /> <img width="24" alt="Chrome" src="https://cdn.jsdelivr.net/gh/devicons/devicon@v2.16.0/icons/chrome/chrome-original.svg" /> | Built-in skills and browser automation |

You bring the credentials and permissions; Atomic brings the runtime that lets workflows use them in staged, inspectable loops.

---

## What you get

Atomic ships three top-level building blocks for executable engineering loops: **workflows**, **skills**, and **specialized subagents**.

### 1. Workflows

Workflows define the executable loop: inputs, stages, branches, parallelism, retries, checks, artifacts, checkpoints, and human review gates. Each stage runs an Atomic coding-agent session with the model provider you configured.

| Workflow                 | What it does                                                                                                                                                                                                                                                                                                                                                                | Example input                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal`                   | Focused workflow for small-to-medium changes when you can name the scope, exact desired outcome, and validation in the objective. It runs bounded worker turns, stores receipts in a goal ledger, requires reviewer quorum before completion, and stops as `complete`, `blocked`, or `needs_human`.                                                                         | `/workflow goal objective="Update the CLI docs for --json, include one example, run the docs build, and finish when it passes"`                                                               |
| `ralph`                  | Heavier prompt-engineering → research → orchestrate → review loop for larger migrations, broad refactors, and multi-package changes. It writes research artifacts under `research/`, delegates implementation through sub-agents from those findings, iterates on reviewer feedback with follow-up research, and only prepares a pull-request report when `create_pr=true`. | `/workflow ralph prompt="Port the rate-limit rollout to the new API gateway" create_pr=true`                                                                                                  |
| `deep-research-codebase` | Repo-wide research for broad, cross-cutting questions. It scouts the codebase, runs parallel specialist waves, aggregates findings, and writes durable research artifacts under `research/`. Prefer `/skill:research-codebase` for a focused subsystem or question.                                                                                                         | `/workflow deep-research-codebase prompt="How do payment retries work end to end?"`                                                                                                           |
| `open-claude-design`     | End-to-end design generation: discovers your design system, generates from a prompt, refines with feedback, and exports a handoff directory.                                                                                                                                                                                                                                | `/workflow open-claude-design prompt="Team activity feed" reference=./mocks/feed.png output_type=prototype`                                                                                   |
| _author your own_        | Anything outside the built-ins: issue-to-PR, review-to-merge, migration, triage, release, compliance, or team-specific review pipelines. Describe the process in natural language and Atomic can scaffold a typed `workflow({...})` file with CLI inputs.                                                                                                                   | _"Create a reusable workflow that takes an issue, writes a plan, creates a branch, runs implementation and review stages, runs tests and lint, then stops for approval before final output."_ |

Run `/workflow list` to see installed workflows and `/workflow inputs <name>` for input schemas. `/workflow status <id>`, `/workflow connect <id>`, and `/workflow resume <id>` manage running or paused runs. Runnable references live in [`packages/coding-agent/examples/`](./packages/coding-agent/examples).

### 2. Skills

Skills are reusable expert instructions and process modules. They auto-invoke when Atomic detects a relevant trigger, or you can call them directly with `/skill:<name>`.

| Skill                 | Purpose                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research-codebase`   | Dispatch parallel sub-agents to analyze a focused area and write a dated research doc under `research/`                                                               |
| `create-spec`         | Produce a technical execution spec under `specs/`, grounded in research documents and engineer feedback                                                               |
| `subagent`            | Delegate work to bundled or custom sub-agents with chains, parallel groups, async runs, and forked context                                                            |
| `intercom`            | Coordinate session-to-session: send messages, delegate tasks, and handle `contact_supervisor` escalations from child sub-agents on the same machine                   |
| `prompt-engineer`     | Sharpen prompts, research questions, and workflow inputs using prompt-engineering best practices                                                                      |
| `tdd`                 | Red-green-refactor loop with a built-in testing-anti-patterns guide                                                                                                   |
| `tmux`                | Control tmux-compatible terminal sessions for interactive CLIs: capture panes, send keys, paste text, and verify terminal app behavior                                |
| `playwright-cli`      | Automate browser interactions, run end-to-end UI checks, record reviewable videos, and work with Playwright tests                                                     |
| `effective-liteparse` | Fast, local, model-free extraction of text, tables, and values from PDF, DOCX, PPTX, XLSX, and image files via the `lit` CLI                                          |
| `impeccable`          | Design, redesign, audit, or polish frontend interfaces (Anthropic's frontend-design skill, vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable)) |

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

- The loop engine for all engineering work: a runtime for reliable coding-agent loops.
- A way to automate repeatable developer processes: research, specs, implementation, checks, review, release prep, incident response, docs, QA, and handoff.
- An open-source coding-agent CLI and TypeScript workflow SDK.
- A powerful, extensible Pi-based harness with first-party workflow, subagent, MCP, web-access, and intercom extensions bundled in.
- A model-agnostic way to connect providers, tools, approvals, and artifacts into explicit engineering loops instead of a single fragile agent session.

### Atomic is not

- A wrapper around Claude Code, Codex, Cursor, OpenCode, or Copilot CLI.
- A replacement for those tools when you want a quick interactive coding session.
- A generic agent framework where you build agents from primitives.
- A promise that model output is deterministic.
- A markdown loop library or checklist that the model may or may not follow.

---

## What happens during a run?

An Atomic loop is an explicit execution graph around model-backed agent sessions:

```text
issue or goal -> research -> spec or plan -> branch or workspace -> agent stages -> artifacts -> checks -> review gate -> final output
```

Each stage can:

- run an Atomic coding-agent session with scoped context,
- call tools and MCP servers,
- run shell commands,
- save artifacts such as research, specs, transcripts, logs, diffs, and check output,
- pass selected output to later stages,
- run stages in parallel,
- retry or branch based on results,
- pause for human approval before continuing.

Atomic makes the **loop structure** deterministic and inspectable: stage order, inputs, handoffs, checks, gates, and artifacts are explicit. The model's exact text and code output is still generated by the selected model and can vary.

---

## Built on Pi, extended for loops

Atomic is the Atomic-branded fork of Pi's coding-agent CLI. The published `@bastani/atomic` package bundles first-party workflow, subagent, MCP, web-access, and intercom extensions.

That means Atomic is itself the coding-agent runtime: the selected model gets file editing, shell, write/edit tools, MCP, skills, workflows, and subagent capabilities inside Atomic. Atomic connects to model providers directly through API keys or supported subscription login.

Pi gives Atomic a mature, extensible harness. Atomic adds the loop engine for coding-agent work: workflow files, review gates, artifacts, resumable runs, checkpoints, and multi-stage execution.

---

## FAQ

### Is Atomic another coding agent?

Atomic is a coding-agent CLI, but its main product idea is the loop engine around the agent session. It connects to model providers and gives the selected model tools for repo work, then adds explicit process: research, specs, stages, checks, artifacts, checkpoints, subagents, review gates, and human approvals.

### Why not just use Claude Code, Codex, Cursor, or OpenCode?

Use interactive coding tools when you want a fast back-and-forth session. Use Atomic when the work needs a repeatable engineering loop you can inspect: repo research, spec creation, implementation stages, tests, lint, reviewer passes, artifacts, and human approval before final handoff.

Atomic is not running those tools under the hood. It is a Pi-based coding-agent harness and loop runtime that connects to model providers directly.

### How is Atomic different from Claude Code Dynamic Workflows?

Claude Code Dynamic Workflows and Atomic are trying to solve a similar class of problem: important software engineering work is too large for one agent pass, so the system should split the job into stages, run agents in parallel, verify the result, and keep enough state to finish long-running work.

Atomic's category is broader and more explicit: it is the loop engine for engineering work. The difference is where control lives and how much of the loop you can inspect, version, extend, and connect to your stack.

| Dimension                  | Atomic                                                                                                                                                                                                                                                                  | Claude Code Dynamic Workflows                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core idea                  | Open-source, repo-native loop engine for coding agents. You can run built-ins, tell the coding agent to use a workflow for a task, describe new loops in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents.                                                   |
| Best fit                   | Teams that want repeatable software engineering loops they can inspect, version, extend, connect to tools, and run across providers.                                                                                                                                                  | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically.                                          |
| Workflow control           | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, checkpoints, and human gates are part of the workflow definition.                                                                                                                              | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run.                                              |
| Models                     | Model-agnostic. Atomic connects directly to supported API-key and subscription providers, and workflows can use model fallback chains.                                                                                                                                  | Claude-first. Availability is tied to Claude Code, Claude plans, and Anthropic-supported API/cloud channels.                                                       |
| Extensibility              | Built on Pi extensions: add tools, TUI, MCP, web access, intercom, skills, prompt templates, themes, custom providers, and packaged workflows.                                                                                                                          | Optimized for Claude Code's built-in dynamic orchestration experience rather than an open extension SDK you own in-repo.                                           |
| Artifacts and auditability | Research docs, specs, logs, transcripts, reviewer notes, check output, and final summaries can live in the repo or workflow run directory.                                                                                                                              | Progress is saved and resumable, but the orchestration is primarily a Claude Code runtime behavior.                                                                |
| Cost/scale posture         | You choose the graph and concurrency. Atomic can be small and deterministic, or broad when you intentionally design a larger workflow.                                                                                                                                  | Designed for large fan-outs, including tens to hundreds of subagents; Anthropic notes it can consume substantially more tokens than a typical Claude Code session. |

### Why not markdown checklists or CLAUDE.md?

Markdown instructions help set context, but the model still has to remember and follow them. Prompt libraries tell an agent what loop to follow; Atomic runs the loop. It turns the process into executable stages: which stage runs, what context it receives, what artifact it must produce, what checks run next, and where a human must approve.

### Is Atomic deterministic?

Atomic makes the loop structure deterministic: stage order, inputs, handoffs, checks, gates, and artifacts are explicit. The model's output is not deterministic; it is generated by the selected model during each agent session.

### Why not LangGraph or a generic agent framework?

Atomic is repo-native and software-engineering-native. It is designed around engineering loops: issues, research docs, specs, branches, diffs, tests, lint, artifacts, reviewers, workflow files, approvals, and PR-ready handoffs — not around building a generic agent application from primitives.

### Where do artifacts live?

Research lives in `research/`, specs live in `specs/`, and workflow runs can persist plans, logs, transcripts, reviewer notes, check output, and final summaries. The goal is to make every important agent decision inspectable after the run.

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
