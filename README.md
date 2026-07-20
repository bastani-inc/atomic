<h1 align="center">Atomic — The Verifiable Coding Agent Runtime</h1>

<p align="center"><img width="800" height="450" alt="Atomic coding agent runtime" src="./assets/atomic-promo.gif" /></p>

<p align="center">
  <b>Run verifiable engineering loops with control, alignment, and confidence.</b>
</p>

<p align="center">
  Build agent work as explicit execution graphs with scoped context, specialized agents, structured handoffs, bounded stages, parallel branches, executable checks, evidence artifacts, review gates, and human approvals.<br>
  Build the foundations of your own software factory without turning engineering into a black box.
</p>

<p align="center">
  <a href="#get-started"><b>Get started →</b></a>
  &nbsp;·&nbsp;
  <a href="#how-atomic-works">How it works</a>
  &nbsp;·&nbsp;
  <a href="#what-you-get">What you get</a>
  &nbsp;·&nbsp;
  <a href="#faq">FAQ</a>
  &nbsp;·&nbsp;
  <a href="https://docs.bastani.ai/">Docs</a>
</p>

<p align="center">
  <a href="https://docs.bastani.ai/"><img src="https://img.shields.io/badge/docs-atomic-blue" alt="Docs"></a>
  <a href="https://discord.gg/9CvdXUGXR4"><img src="https://img.shields.io/badge/join%20community-discord-5865F2?logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://deepwiki.com/bastani-inc/atomic"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/TypeScript-7.x-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center">
  If Atomic is useful to you, star the repository ⭐
</p>

---

## Built for developers who want assurance

Atomic grew from collective work on coding agents and developer infrastructure where plausible output was not enough. As agents become more capable, the harness around them must become more deliberate.

Developers should control what agents see, how work is divided, what crosses boundaries, what evidence must exist, which checks permit progress, and where humans decide. Context, orchestration, and verification are core infrastructure. They should be inspectable, changeable, and owned by the developers who use them.

Closed platforms may have more resources or distribution. Atomic builds this infrastructure in the open so developers can inspect it, adapt it, and own it.

Build in the open. Question the defaults. Keep control of the process. ☠︎

---

## Get started

### Prerequisites

- **Node.js 22.19 or newer** — check with `node --version`.
- **A package manager** — use npm, pnpm, Yarn, or Bun. Use Bun 1.3.14+ for Bun installs or workflow-authoring examples.
- **Model-provider access** — use a supported subscription login or API key.

### Install

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

Atomic does not require package install scripts. Add `--ignore-scripts` to the install command if you want to disable dependency lifecycle scripts during installation.

### Authenticate and run

Atomic supports subscription login for Codex, Claude, GitHub Copilot, and Cursor (experimental), as well as API-key providers such as OpenRouter:

```bash
atomic
/login   # then select your provider
```

Claude login from a third-party harness uses Anthropic extra usage billed per token rather than Claude plan limits. Cursor support uses private APIs, may conflict with Cursor's terms, and could affect the authenticated account. See [Providers & Models](./packages/coding-agent/README.md#providers--models) before using either integration.

Missing a provider? [Open an issue](https://github.com/bastani-inc/atomic/issues/new) or contribute an integration.

For API-key setup, export the key before starting Atomic:

```bash
export OPENROUTER_API_KEY=sk-or-...
atomic
```

Atomic stores provider credentials in `~/.atomic/agent/auth.json` and creates the file with owner-only permissions where the platform supports them. For non-interactive use, `atomic -p "<prompt>"` prints the response and exits.

After authenticating, run `/atomic` for workflow guides, examples, and next steps. A fresh install also shows a one-time workflow-engine introduction.

> ⚠️ Atomic has no built-in sandbox or command-level shell permission gate. Tools and extensions run with your user permissions. Run autonomous work inside a devcontainer, VM, or remote development machine—not on a host with sensitive data or credentials.

<details>
<summary><b>Devcontainer, terminal, and SDK references</b></summary>

Atomic runs in a standard devcontainer or VM with Node.js 22.19+ installed. Install it inside the container with a package manager and pass provider credentials through environment variables.

See [Terminal setup](./packages/coding-agent/docs/terminal-setup.md), [Security](./packages/coding-agent/docs/security.md), and [Programmatic Usage](./packages/coding-agent/README.md#programmatic-usage) for the SDK and RPC entry points.

</details>

### Bring your skill stack

Already have agent skills? Bring them into Atomic by pointing Atomic at their existing directories or placing them in its project or user skill locations. Atomic implements the Agent Skills standard, and configured Claude Code or Codex skill directories can be used without rewriting them. See [Skills](./packages/coding-agent/docs/skills.md#using-skills-from-other-harnesses).

When a skill captures a repeatable process, ask Atomic to author it as a durable workflow. Atomic inspects the skill and writes reviewable TypeScript using the [workflow guide](./packages/coding-agent/docs/workflows.md) and its examples.

```text
Inspect the existing skill `<skill-name-or-path>`—including its SKILL.md, scripts, references, and assets—and consult Atomic’s workflow docs and runnable TypeScript examples; then author a reusable TypeScript `workflow({...})` that preserves the skill’s intent while turning its repeatable process into durable multi-stage execution with precise typed inputs and declared outputs, artifact-backed handoffs for substantial context, explicit validation gates, and bounded retries or stop conditions where appropriate; add and run representative tests or smoke cases for the applicable success, validation-failure, and retry/stop paths, reload and verify workflow discovery, and ask me only questions whose answers materially change the design—otherwise state sensible assumptions and proceed.
```

### Migrating from another coding agent

Atomic publishes an agent-readable **[`llms.txt`](https://docs.bastani.ai/llms.txt)**. Ask your current coding agent to:

```text
Install and set up Atomic by following https://docs.bastani.ai/llms.txt.
```

---

## How Atomic works

Atomic is the runtime. Workflows encode durable processes through stages, tools, prompts, checks, artifacts, gates, and approvals. Skills supply reusable expert instructions. Specialized subagents handle focused work while a parent agent or workflow controls the larger task.

Atomic is a fork of Pi, so it works with the providers, tools, MCP servers, skills, and extensions already in your Pi stack.

A workflow's stage dependencies form a directed acyclic graph. Bounded loops and retries are control structures around those stages; Atomic records each attempt and its outcome in the execution graph. This keeps retries visible without turning the run into an unbounded conversation.

```text
issue or goal → research → plan → agent stages → artifacts → checks → review gate → final output
```

A stage can prompt an agent, run tools, call MCP servers, save artifacts, pass selected output forward, branch, retry, run in parallel, or pause for approval. Model output can vary. The workflow definition makes stage order, inputs, handoffs, configured checks, gates, and artifacts explicit.

Use direct chat for small, interactive work. Use a skill or bounded subagent when the parent should stay in control. Use a workflow when a delegated job needs durable stages, retries, evidence, resumability, or approval gates. Phrases such as “repeat until,” “review and fix until passing,” or “run checks until green” signal that the stop condition should be encoded and bounded.

Atomic can support:

- **Engineering runs** — research, plan, implement, test, review, and release.
- **Debugging and migrations** — reproduce, diagnose, patch, migrate in waves, and verify.
- **Research and triage** — gather context, fan out analysis, classify issues, and synthesize findings.
- **QA, docs, and compliance** — run repeatable checks with evidence and approval points.
- **Custom agent products** — build on Atomic's runtime, SDK, tools, and workflows.

### Examples

Focused codebase research:

```text
/skill:research-codebase how the rate limiter works in src/middleware/
```

Deep codebase research:

```text
/workflow deep-research-codebase prompt="Map every callsite of the legacy auth middleware so we can migrate to session-v2"
```

A research-first implementation with Ralph:

```text
Run ralph to implement specs/2026-03-rate-limit.md, run the focused rate-limit tests, and finish when burst traffic returns 429 with Retry-After.
```

A reviewer-gated one-off run with Goal:

```text
Use goal to update the CLI docs for --json, include one example, run the docs build, and finish when the build passes.
```

`goal` keeps receipts in a ledger and gates completion through independent reviewers and a deterministic reducer. `ralph` adds durable research and delegated implementation before iterative review. Add `create_pr=true` only when you want either workflow to run its pull-request stage after approval; prompt text alone does not opt in.

---

## What you get

Atomic ships three top-level building blocks: workflows, skills, and specialized subagents.

### 1. Workflows

Workflows define inputs, stages, branches, parallelism, retries, checks, artifacts, checkpoints, and human review gates. Atomic can author TypeScript `workflow({...})` definitions, import reusable project or package workflows, and nest workflows with `ctx.workflow(...)` within a configured `maxDepth`.

| Workflow                 | What it does                                                                                                                                                         | Example input                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `goal`                   | Bounded autonomous work with receipts in a goal ledger, named validation, and reviewer-gated completion.                                                             | `/workflow goal objective="Update the CLI docs for --json, include one example, run the docs build, and finish when it passes"` |
| `ralph`                  | Research-first work with prompt refinement, codebase research, delegated implementation, and iterative review.                                                       | `/workflow ralph prompt="Port the rate-limit rollout to the new API gateway" create_pr=true`                                    |
| `deep-research-codebase` | Repo-wide research with parallel specialist waves and durable artifacts under `research/`.                                                                           | `/workflow deep-research-codebase prompt="How do payment retries work end to end?"`                                             |
| `open-claude-design`     | Design generation that gathers requirements and references, discovers the design system, refines output, and exports a handoff.                                      | `/workflow open-claude-design prompt="Team activity feed prototype using ./mocks/feed.png as a reference"`                      |
| _author your own_        | Issue-to-PR, migration, triage, release, compliance, or another process your team needs. Start with the [workflow guide](./packages/coding-agent/docs/workflows.md). | _“Create a workflow that plans, implements, runs tests and lint, reviews the diff, then stops for approval.”_                   |

Run `/workflow list` to see installed workflows and `/workflow inputs <name>` for input schemas. Use `/workflow status <id>`, `/workflow connect <id>`, `/workflow quit <id>`, and `/workflow resume <id>` to manage runs. Quitting pauses work so it can resume later. Runnable references live in [`packages/coding-agent/examples/`](./packages/coding-agent/examples).

### 2. Skills

Skills are reusable expert instructions and process modules. Atomic can select one from its description, or you can call it with `/skill:<name>`.

| Skill               | Purpose                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `research-codebase` | Analyze a focused area and write a dated research document.                                  |
| `create-spec`       | Produce a technical execution spec grounded in research and engineer feedback.               |
| `subagent`          | Delegate work through single agents, chains, parallel groups, async runs, or forked context. |
| `intercom`          | Coordinate parent, child, and peer sessions on the same machine.                             |
| `prompt-engineer`   | Refine prompts, research questions, and workflow inputs.                                     |
| `skill-creator`     | Create, improve, and evaluate reusable skills.                                               |
| `tdd`               | Apply a red-green-refactor loop and testing guidance.                                        |
| `tmux`              | Drive and verify terminal applications.                                                      |
| `playwright-cli`    | Automate browser interactions and end-to-end UI checks.                                      |
| `liteparse`         | Extract text, tables, and values from documents and images.                                  |
| `impeccable`        | Design, audit, and refine frontend interfaces.                                               |

### 3. Specialized subagents

Subagents are purpose-built agents with scoped context, tools, and termination conditions. Atomic bundles nine definitions from [`packages/subagents/agents/`](./packages/subagents/agents/).

| Subagent                     | Purpose                                                    |
| ---------------------------- | ---------------------------------------------------------- |
| `worker`                     | Implement a bounded task and return a concise result.      |
| `codebase-locator`           | Locate files and components relevant to a task.            |
| `codebase-analyzer`          | Analyze implementation details.                            |
| `codebase-pattern-finder`    | Find similar implementations and usage examples.           |
| `codebase-online-researcher` | Fetch current documentation and authoritative web sources. |
| `codebase-research-locator`  | Find relevant prior research in the repository.            |
| `codebase-research-analyzer` | Extract decisions and rationale from local research.       |
| `code-simplifier`            | Refine recent code without changing behavior.              |
| `debugger`                   | Reproduce, diagnose, and verify fixes for failures.        |

Large, mixed, or growing contexts can make attention harder. Specialized agents reduce that risk through isolation, focus, tool scoping, and deliberate handoffs. Independent tasks can also run in parallel.

## Connect your engineering stack

Atomic uses tools exposed through CLIs, MCP servers, APIs, scripts, or custom extensions. These examples are not a fixed integration list.

| Need                   | Examples                                     | How Atomic connects                                                  |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| Code and reviews       | GitHub, GitLab, Git                          | CLIs such as `gh` and `glab`, MCP, or web access                     |
| Tickets and docs       | Jira, Linear, Notion, Slack                  | MCP servers, APIs, or custom tools                                   |
| Build and runtime      | Docker, Kubernetes, AWS, Google Cloud, Azure | Installed CLIs such as `docker`, `kubectl`, `aws`, `gcloud`, or `az` |
| Observability and data | Sentry, Datadog, PostgreSQL                  | CLIs, MCP servers, APIs, or custom tools                             |
| UI validation          | Playwright, Chrome                           | Built-in skills and browser automation                               |

You supply the credentials and permissions. The workflow defines how agents may use the available tools.

---

## What Atomic is / what Atomic is not

### Atomic is

- A coding agent runtime and terminal application.
- A context-engineering system for scoped sessions, tools, handoffs, and verifier passes.
- A TypeScript workflow SDK for explicit execution graphs, checks, artifacts, and gates.
- A model-agnostic harness for providers, MCP, subagents, skills, and extensions.
- Infrastructure that developers can inspect, version, change, and own.

### Atomic is not

- A promise that more agents improve engineering.
- A black-box swarm.
- A claim that model output is deterministic or correct by default.
- A checklist that a model may choose to follow.
- A wrapper around Claude Code, Codex, Cursor, OpenCode, or Copilot CLI.
- A replacement for engineering judgment.

---

## Documentation

Full documentation lives at **[docs.bastani.ai](https://docs.bastani.ai/)**. It covers the CLI and SDK, security, containerized execution, workflow authoring and monitoring, session management, configuration, troubleshooting, and provider setup.

The docs live in this repository under [`packages/coding-agent/docs`](./packages/coding-agent/docs). Open a pull request to suggest a change.

## FAQ

### Is Atomic another coding agent?

Atomic includes a coding-agent CLI. Its main product idea is the runtime around the agent session: scoped context, stages, tools, checks, artifacts, checkpoints, subagents, review gates, and human approvals.

### Why not use Claude Code, Codex, Cursor, or OpenCode?

Use any interactive coding tool that fits the job. Use Atomic when work needs an explicit process you can inspect, version, resume, and verify. Atomic connects to model providers directly rather than running those tools underneath it.

### How is Atomic different from products that fan out many agents?

Atomic can fan work out too. The difference is not whether agents run in parallel; it is whether developers control the context, handoffs, execution graph, evidence, checks, and approval rules around that work. Parallel execution increases throughput. Assurance comes from the process you define and enforce.

### Is Atomic deterministic?

The selected model can produce different output across runs. Workflow structure, stage dependencies, inputs, handoffs, configured checks, gates, and artifact paths are explicit. Deterministic reducers can apply declared approval rules to reviewer output.

### Why not Markdown checklists or `CLAUDE.md`?

Markdown helps set context, but a model still has to follow it. An Atomic workflow runs declared stages and tools, validates configured outputs, records configured artifacts, and applies defined gates.

### Why not LangGraph or a generic agent framework?

Atomic is repo-native and focused on software engineering work: issues, research, specs, branches, diffs, tests, lint, artifacts, reviewers, approvals, and handoffs. It provides a coding-agent runtime rather than a set of generic application primitives.

### Where do artifacts live?

Research commonly lives in `research/`, specs in `specs/`, and workflow run data in the workflow run directory. A workflow can persist plans, logs, transcripts, reviewer notes, check output, and summaries for later inspection.

---

## Workflow playbook

Read the [Workflow Playbook](./docs/workflow-playbook.md) for practical guidance on writing objectives, constraining scope, steering long-running work, validating results, and producing engineering handoffs.

## Support & ideas

Join the [Atomic Discord community](https://discord.gg/9CvdXUGXR4) for questions, help, feedback, feature ideas, and examples of what you have built.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [DEV_SETUP.md](DEV_SETUP.md) for development setup and testing.

To contribute workflows, see the [atomic-workflows repository](https://github.com/lavaman131/atomic-workflows).

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
