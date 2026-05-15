<h1 align="center">Atomic</h1>

<p align="center"><img width="800" height="450" alt="atomic-promo" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source CLI and TypeScript SDK for coding agents.
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#why-atomic">Why Atomic</a>
  &nbsp;·&nbsp;
  <a href="#key-features">Key features</a>
  &nbsp;·&nbsp;
  <a href="https://docs.bastani.ai/">Docs</a>
</p>

<p align="center">
  <a href="https://docs.bastani.ai/"><img src="https://img.shields.io/badge/docs-atomic-blue" alt="Docs"></a>
  <a href="https://deepwiki.com/flora131/atomic"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/Bun-Runtime-f9f1e1?logo=bun&logoColor=black" alt="Bun"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

---

## Get started

```bash
curl -fsSL https://raw.githubusercontent.com/flora131/atomic/main/install.sh | sh
```

**Windows** (PowerShell 5.1+ or 7+):

```powershell
irm https://raw.githubusercontent.com/flora131/atomic/main/install.ps1 | iex
```

Or with npm:

```bash
npm install -g @bastani/atomic
```

**Authenticate and run**

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

See [Providers & Models](./packages/coding-agent/README.md#providers--models) for the full provider list (API keys + subscriptions). For non-interactive use, `atomic -p "<prompt>"` prints the response and exits.

> ⚠️ Workflows run with agent permission checks **disabled** so pipelines don't block on prompts. Run autonomous workflows inside a devcontainer, VM, or remote dev machine — not your host machine.

<details>
<summary><b>Prerequisites, devcontainer</b></summary>

**Prerequisites** — Atomic is a self-contained coding-agent binary. The only requirement is access to a supported model provider: either an API key (Anthropic, OpenAI, Google, Azure, Bedrock, Vertex, …) or an existing subscription (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot) via `/login`. See [Providers & Models](./packages/coding-agent/README.md#providers--models).

**Devcontainer / VM** — recommended for autonomous workflows. Atomic runs in any standard devcontainer or VM image; install it inside the container with `npm install -g @bastani/atomic` (or the install script) and supply provider credentials via environment variables.

See [Programmatic Usage](./packages/coding-agent/README.md#programmatic-usage) for the SDK and RPC entry points.

</details>

---

## Why Atomic

Coding agents are great inside a single session — they inspect code, edit files, and explain their work. The trouble starts when a task is ambiguous, tied to specific exit criteria, long-running, or anchored in a large codebase. You end up reminding the agent of the process, copying output between sessions, and deciding when a human needs to review.

**Atomic turns that process into code.** A workflow can branch, retry, run stages in parallel, isolate sessions, pass only the right transcript forward, pause for human approval, and run inside a devcontainer so the agent is never loose on your host.

|                                 |                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Start with your own process** | Automate the repetitive parts of research, debugging, review, migrations, or PR prep — one TypeScript file, versioned with the repo.                    |
| **Scale to your team**          | Encode review gates, quality checks, and approvals so every teammate runs the same workflow instead of manually steering an agent.                      |
| **Keep the coding agent**       | Atomic adds structure around Claude Code, OpenCode, and Copilot CLI — without rebuilding file editing, tool use, MCP setup, hooks, or context handling. |
| **Own the outer loop**          | Workflows, gates, handoffs, and the execution graph are TypeScript you can read, edit, and version — not a black-box harness improvising process.       |

> Build the workflow once. Run it across agents, repos, and teams.

---

## Key features

Atomic ships three top-level building blocks: **workflows**, **skills**, and **specialized sub-agents**. Everything else in this README is reference material on top.

### 1. Workflows

Atomic workflows separate orchestration from execution: control flow is deterministic TypeScript — frozen definitions, strict step ordering, and explicit transcript handoffs between stages — while each stage runs a full coding agent with unconstrained tool use and reasoning.

| Workflow                 | What it does                                                                                                                                                                                                                                                                                        | Example input                                                                                                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ralph`                  | Autonomous plan → orchestrate → simplify → review loop that keeps iterating until two reviewers agree (or `max_loops` hits). For multi-hour unattended coding on a bounded task.                                                                                                                    | `/workflow ralph prompt="Implement the caching layer per research/docs/2026-05-07-caching.md"`                                                                                                                           |
| `deep-research-codebase` | Parallel research across a large codebase, written to a dated `research/docs/` doc you can hand to future workflows or specs. Token-heavy — reach for it on large migrations or cross-service work. For smaller, single-question research, use the [`/research-codebase`](#2-skills) skill instead. | `/workflow deep-research-codebase prompt="Map every callsite of the legacy auth middleware so we can migrate to session-v2"`                                                                                             |
| `open-claude-design`     | End-to-end design generation: discovers your design system, generates from a prompt, refines with feedback, and exports a handoff directory.                                                                                                                                                        | `/workflow open-claude-design prompt="Team activity feed" reference=./mocks/feed.png output_type=prototype`                                                                                                              |
| _author your own_        | Anything outside the built-ins — review-to-merge, migration, triage, release pipelines. Describe it in natural language and the [`workflow`](#2-skills) skill scaffolds a `defineWorkflow()` file with typed CLI flags.                                                                             | _"Use the `workflow` skill to scaffold a workflow that takes an `--issue=<n>` flag, pulls the GitHub issue, and runs an implementation pass identical to the built-in `ralph` workflow against the described features."_ |

Run `/workflow list` to see installed workflows and `/workflow inputs <name>` for the full input schema. `/workflow status <id>` and `/workflow resume <id>` manage running and paused runs. SDK details in [Workflow SDK](#workflow-sdk); runnable references in [`examples/`](./examples).

### 2. Skills

Structured capability modules that give agents best practices and reusable patterns. Atomic bundles **9 skills** — 7 from [`packages/workflows/skills/`](./packages/workflows/skills/), 1 from [`packages/subagents/skills/`](./packages/subagents/skills/), and 1 from [`packages/intercom/skills/`](./packages/intercom/skills/). They auto-invoke when the agent detects a relevant trigger, or you can call them directly with `/skill:<name>`.

| Skill               | Purpose                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research-codebase` | Dispatch parallel sub-agents to analyze the codebase and write a dated research doc under `research/`                                                                 |
| `create-spec`       | Produce a technical execution spec (in `specs/`) grounded in research documents                                                                                       |
| `workflow`          | Create, run, inspect, and improve pi/atomic workflows — scaffolds `defineWorkflow()` files, drives `/workflow run/status/resume`                                      |
| `subagent`          | Delegate work to bundled or custom sub-agents with chains, parallel groups, async runs, and forked context — the orchestration skill behind the bundled sub-agents    |
| `intercom`          | Coordinate session-to-session — send messages, delegate tasks, and handle `contact_supervisor` escalations from child sub-agents on the same machine                  |
| `prompt-engineer`   | Sharpen prompts, research questions, and workflow inputs using prompt-engineering best practices                                                                      |
| `tdd`               | Red-green-refactor loop with a built-in testing-anti-patterns guide                                                                                                   |
| `playwright-cli`    | Automate browser interactions, tests, and screenshots                                                                                                                 |
| `impeccable`        | Design, redesign, audit, or polish frontend interfaces (Anthropic's frontend-design skill, vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable)) |

### 3. Specialized sub-agents

Purpose-built agents with scoped context, tools, and termination conditions. Atomic bundles **8 sub-agents** from [`packages/subagents/agents/`](./packages/subagents/agents/). They're auto-dispatched by skills and workflows.

| Sub-agent                    | Purpose                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `codebase-locator`           | Locate files, directories, and components relevant to a task (a super search/find/ls tool)            |
| `codebase-analyzer`          | Analyze implementation details of specific components                                                 |
| `codebase-pattern-finder`    | Find similar implementations and usage examples in the codebase                                       |
| `codebase-online-researcher` | Fetch up-to-date docs and authoritative sources from the web (uses `playwright-cli`)                  |
| `codebase-research-locator`  | Discover prior research documents in `research/` that are relevant to the current task                |
| `codebase-research-analyzer` | Deep-dive analysis of local research documents to extract decisions, rationale, and technical details |
| `code-simplifier`            | Clean up, simplify, and refine recently written code without changing behavior                        |
| `debugger`                   | Debug errors, test failures, and unexpected behavior (uses `tdd` and `playwright-cli`)                |

<details>
<summary><i>Why specialized agents instead of one general agent?</i></summary>

LLMs have an architectural limitation: the more context they hold, the harder it is to attend to the right information. A single agent juggling a spec, dozens of files, tool outputs, and its own reasoning will lose details, repeat work, or hallucinate connections. Specialized sub-agents fix this with **context isolation** (fresh, minimal context per job), **tool scoping** (a `codebase-locator` can't edit files; a `code-simplifier` can't reach the web), and **parallel execution** (independent agents run concurrently).

</details>

---

## Documentation

Full documentation lives at **[docs.bastani.ai](https://docs.bastani.ai/)** — the CLI and SDK reference, security model, containerized execution, the workflow panel, session management, configuration, troubleshooting, FAQ, and side-by-side comparisons with Spec-Kit, DeerFlow, and Hermes.

The docs are open source — the same content is browsable on GitHub at [flora131/docs](https://github.com/flora131/docs). Open a PR there to suggest a change.

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