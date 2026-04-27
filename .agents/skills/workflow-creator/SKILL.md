---
name: workflow-creator
description: Create AND run Atomic CLI workflows (`defineWorkflow().run().compile()` with `ctx.stage()`) across Claude, Copilot, and OpenCode SDKs. Use for **authoring** when the user wants to build, edit, debug, or design agent pipelines — multi-stage automations, review/fix loops, parallel fan-out, headless/background stages, `defineWorkflow`, `ctx.stage`, `ctx.inputs`, declared `WorkflowInput` schemas, `runWorkflow`, `createRegistry`, `listWorkflows`, the SDK's metadata accessors (`getName`, `getInputSchema`, `getAgent`), `validateInputs`, the interactive workflow picker (`WorkflowPicker` from `@bastani/atomic/workflows/components`), single or multi-workflow composition roots. Use for **running** when the user wants to kick off, execute, monitor, or tear down an existing workflow — "run the ralph workflow", "start gen-spec", "is it done yet?", "what's the status?", "kill the session", or any mention of `atomic workflow -n`, `atomic workflow inputs`, `atomic workflow status`, the picker, or `atomic session kill`.
---

# Workflow Creator

You are a workflow architect specializing in the Atomic CLI `defineWorkflow().run().compile()` API. You translate user intent into well-structured workflow files that orchestrate multiple coding agent sessions using **programmatic SDK code** — Claude Agent SDK, Copilot SDK, and OpenCode SDK. Sessions are spawned dynamically via `ctx.stage(stageOpts, clientOpts, sessionOpts, callback)` inside the `.run()` callback, using native TypeScript control flow (loops, conditionals, `Promise.all()`) for orchestration. The runtime auto-creates the SDK client and session, injects them as `s.client` and `s.session`, runs the callback, then auto-cleans up.

You also serve as a **context engineering advisor** — use the design skills listed under "Design Advisory Skills" to make informed architectural decisions about session structure, data flow, prompt composition, and quality assurance.

Two user journeys live in this skill:

- **Authoring** a new workflow (or editing/debugging an existing one) → read on below.
- **Running** a workflow on the user's behalf ("run ralph on this spec", "is it done yet?", "kill it") → go to `references/running-workflows.md`.

## Reference Files

Load references on demand. **Only `getting-started.md` is always-load.** Everything else is conditional — pull it in when the task matches the trigger column.

| File | Load when |
|---|---|
| `getting-started.md` | **Always** — quick-start examples for all 3 SDKs, SDK exports, `SessionContext` field reference |
| `failure-modes.md` | Before shipping any multi-session workflow. 16 catalogued failures (silent + loud) with wrong-vs-right patterns and a pre-ship design checklist |
| `workflow-inputs.md` | When declaring structured inputs or documenting how a workflow is invoked — `WorkflowInput` schema, field-type selection, picker + CLI flag semantics, builtin-protection rules |
| `agent-sessions.md` | When writing SDK calls — `s.session.query()` (Claude), `s.session.send()` (Copilot), `s.client.session.prompt()` (OpenCode); includes session-lifecycle pitfalls and when to use `sendAndWait` with explicit timeouts |
| `control-flow.md` | When using loops, conditionals, parallel execution (`Promise.all`), headless fan-out, or review/fix patterns |
| `state-and-data-flow.md` | When passing data between sessions — `s.save()`, `s.transcript()`, `s.getMessages()`, file persistence, transcript compression |
| `running-workflows.md` | When the user asks you to **run** an existing workflow rather than author one |
| `computation-and-validation.md` | When adding deterministic computation, response parsing, validation, quality gates, or file I/O |
| `session-config.md` | When configuring model, tools, permissions, hooks, or structured output per SDK |
| `user-input.md` | When collecting user input **mid-workflow** (not at invocation time — use `workflow-inputs.md` for that) |
| `registry-and-validation.md` | When setting up `createRegistry()` and iterating it via `listWorkflows`, understanding key scheme, validate-on-register rules, and same-name collision detection (only relevant for the multi-workflow cli) |

## Scaffold a new workflow from scratch

When the user asks you to build a new workflow, follow this recipe exactly. The point of a fixed convention is that every atomic project looks the same — users, agents, and the `workflow-creator` skill all locate files the same way. Improvising paths makes the next agent's job harder.

### Runtime prerequisites (check before writing code)

Three things have to exist on the host or the first `bun run` will fail. If any are missing, tell the user before scaffolding — fixing them afterward is more frustrating than getting them out of the way up front.

- **[Bun](https://bun.sh/)** as the JavaScript runtime — Atomic and the SDK rely on `Bun.spawn`, native pty handling, and Bun-specific module resolution. **They do not run on Node.js.** Verify with `bun --version`. If the user has only `node`, direct them to install Bun first (`curl -fsSL https://bun.sh/install | bash`) — `npm install @bastani/atomic` and `node src/claude-worker.ts` will both fail.
- **Terminal multiplexer** — every `ctx.stage()` runs inside a detachable session on the `atomic` tmux socket. That's what makes `-d/--detach` possible and what keeps the orchestrator alive when the user's terminal disconnects. `tmux` on macOS/Linux (`brew install tmux` / distro package manager), [`psmux`](https://github.com/psmux/psmux) on Windows. Verify with `which tmux` or `where.exe psmux`.
- **At least one authenticated coding agent CLI** — the runtime spawns `claude` / `opencode` / `copilot` at each stage and talks to it via its SDK. The agent whose workflow file targets via `.for("claude")` / `.for("copilot")` / `.for("opencode")` must be installed and logged in. If the user says "build a workflow for Claude" and `claude --version` fails, that's the first thing to surface.

Only Bun is a `bun add` dependency in spirit — tmux/psmux and the agent CLIs are separate processes the SDK orchestrates. The global `atomic` CLI installer doesn't install tmux/psmux or the agents either, so SDK-only users and CLI users share the same prereqs. A devcontainer using the `ghcr.io/flora131/atomic/<agent>:1` feature bundles all three, which is the fastest way to unblock a user who's stuck on install friction.

### Project layout

```
<repo>/
├── package.json
├── tsconfig.json
└── src/
    ├── workflows/
    │   └── <workflow-name>/
    │       ├── claude.ts        # one file per agent you target
    │       ├── copilot.ts
    │       └── opencode.ts
    └── <agent>-worker.ts        # one composition root per agent
```

One workflow per directory, one file per agent, one composition-root file per agent. If the user wants only one agent, ship just `claude.ts` (or whichever) plus `claude-worker.ts` — the layout still holds.

### Steps

**1. Initialize the project** (skip if `package.json` already exists):

```bash
bun init -y
bun add @bastani/atomic
# plus the provider SDK(s) you target:
bun add @anthropic-ai/claude-agent-sdk    # for claude
bun add @github/copilot-sdk               # for copilot
bun add @opencode-ai/sdk                  # for opencode
```

**2. Write the workflow** at `src/workflows/<name>/<agent>.ts`. This is the bulk of the work — see the per-agent templates in `references/getting-started.md` §"Quick-start example". Minimal Claude skeleton:

```ts
// src/workflows/<name>/claude.ts
import { defineWorkflow } from "@bastani/atomic/workflows";

export default defineWorkflow({
  name: "<workflow-name>",
  source: import.meta.path,                 // ← required: the SDK re-imports this path
  description: "<one-line description>",
  inputs: [
    { name: "prompt", type: "text", required: true, description: "<what the user supplies>" },
  ],
})
  .for("claude")
  .run(async (ctx) => {
    await ctx.stage({ name: "step-1" }, {}, {}, async (s) => {
      await s.session.query(ctx.inputs.prompt ?? "");
      s.save(s.sessionId);
    });
  })
  .compile();
```

**3. Write the composition root** at `src/<agent>-worker.ts`. The SDK exposes pure primitives; compose them into any CLI library you like. A small Commander entrypoint:

```ts
// src/claude-worker.ts
import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic/workflows";
import workflow from "./workflows/<name>/claude.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
});
await program.parseAsync();
```

Multi-workflow variant (only when the user actually wants many workflows under one CLI — otherwise prefer one worker file per agent):

```ts
// src/cli.ts
import { Command } from "@commander-js/extra-typings";
import {
  createRegistry,
  getInputSchema,
  getName,
  listWorkflows,
  runWorkflow,
} from "@bastani/atomic/workflows";
import reviewFlow from "./workflows/review/claude.ts";
import specFlow from "./workflows/spec/claude.ts";

const registry = createRegistry().register(reviewFlow).register(specFlow);
const program = new Command();
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

**4. Typecheck**:

```bash
bun typecheck       # if the user has a typecheck script
# or:
bunx tsc --noEmit
```

**5. Run**:

```bash
bun run src/claude-worker.ts --prompt "<test task>"       # attached
```

For detached runs and monitoring, either use the global `atomic` CLI (which has `session` / `status` / `workflow status` subcommands wired in) or wire the SDK's session primitives — `listSessions`, `getSessionStatus`, `attachSession`, `stopSession` — into your own CLI's subcommands.

**6. Monitor and manage** with the global atomic CLI:

```bash
atomic session list                     # all running workflows on the atomic socket
atomic workflow status <session-name>   # JSON status for one workflow
atomic workflow status                  # status for every running workflow
atomic session connect <session-name>   # reattach to a detached run
atomic session kill <session-name> -y   # tear it down (-y is mandatory for agents)
```

Every session lives on the shared `atomic` tmux socket regardless of which path spawned it, so workflows you start with `runWorkflow({ ... })` show up in `atomic session list` too. If you want to ship your own equivalents inside your CLI, drop in the session primitives:

```ts
import {
  listSessions,
  stopSession,
  attachSession,
  getSessionStatus,
} from "@bastani/atomic/workflows";
```

Full details (the `needs_review` state, worked examples, `bunx atomic` fallback) live in `references/running-workflows.md`.

That's the whole scaffold. If the user has more than two stages or parallel fan-out, the changes all happen inside step 2 (the `.run()` callback) — steps 1, 3, 4, 5, 6 are the same regardless of workflow complexity.

### When in doubt

- **Single agent, single workflow** — the 90% case. One `<agent>.ts` + one `<agent>-worker.ts`. Done.
- **Same workflow across agents** — three `<agent>.ts` files that share helpers from `src/workflows/<name>/helpers/`; three `<agent>-worker.ts` files. See `references/getting-started.md` §"Quick-start example" for the per-agent SDK differences.
- **Multiple workflows in one CLI** — build a `createRegistry().register(...)` pipeline and iterate it via `listWorkflows(registry)` to mount one Commander subcommand per workflow. Use a `src/cli.ts` composition root instead of per-agent workers.

If the user's need doesn't match any of these, ask them which shape they want before scaffolding — don't guess.

## Information Flow Is a First-Class Design Concern

**A workflow is an information flow problem, not a sequence of prompts.**
Before writing any `ctx.stage()` call, answer for every session boundary:

- What context does this session need, how will it reach the session
  (prompt handoff, file, single multi-turn stage), and what happens if the
  context window fills up?

For Copilot and OpenCode, every `ctx.stage()` is a fresh conversation;
Claude reuses a tmux pane per stage. Read these before shipping any
multi-session workflow:

- `references/agent-sessions.md` §"Critical pitfall: session lifecycle
  controls what context is available" — lifecycle table, context-loss
  patterns, and per-SDK details.
- `references/failure-modes.md` — silent + loud failures with wrong-vs-right
  patterns and the pre-ship design checklist.
- `references/state-and-data-flow.md` — `s.save()`, `s.transcript()`, and
  file-based handoff patterns.

## Design Advisory Skills

Workflow quality depends on two disciplines: **prompt engineering** (crafting
clear, structured prompts each session receives) and **context engineering**
(ensuring the right information reaches each session without exceeding token
budgets). Use `prompt-engineer` to improve individual session prompts —
clarity, XML structure, few-shot examples, chain-of-thought — and the
context engineering skills below to design information flow between sessions.

| Design Concern | Skill | Trigger |
|---|---|---|
| Prompt clarity and structure | `prompt-engineer` | Every workflow — clear instructions, XML tags, examples, chain-of-thought |
| Session prompt structure | `context-fundamentals` | Every workflow — token budgeting, prompt positioning, progressive disclosure |
| Context failure prevention | `context-degradation` | Long conversations, accumulated state, multi-turn loops |
| Transcript compression | `context-compression` | Passing large transcripts between sessions |
| Multi-session architecture | `multi-agent-patterns` | Coordination topology, handoff protocols, error propagation |
| Cross-run persistence | `memory-systems` | Retaining knowledge across separate executions |
| Custom tools and capabilities | `tool-design` | Sessions exposing custom tools |
| File-based coordination | `filesystem-context` | Sessions sharing state via files |
| Remote execution | `hosted-agents` | Sandboxed or remote environments |
| Token efficiency | `context-optimization` | Compaction triggers, observation masking, cache-friendly ordering |
| Quality gates | `evaluation` | Review loops or quality checkpoints |
| LLM-as-judge review | `advanced-evaluation` | Automated review sessions judging other sessions' output |
| Task-model fit | `project-development` | Validating whether a task is viable for agent automation |
| Deliberative reasoning | `bdi-mental-states` | Explainable reasoning chains or formal cognitive models |

## How Workflows Work

A workflow is a TypeScript file with a single `.run()` callback that
orchestrates agent sessions dynamically. Inside the callback, `ctx.stage()`
spawns sessions — each gets its own tmux window and graph node (unless
running in headless mode). Native TypeScript handles all control flow:
loops, conditionals, `Promise.all()`, `try`/`catch`.

```ts
import { defineWorkflow, extractAssistantText } from "@bastani/atomic/workflows";

export default defineWorkflow({
    name: "my-workflow",
    source: import.meta.path,
    description: "...",
    inputs: [
      { name: "prompt", type: "text", required: true, description: "task to perform" },
    ],
  })
  .for("claude")
  .run(async (ctx) => {
    const step1 = await ctx.stage({ name: "step-1" }, {}, {}, async (s) => { /* s.client, s.session */ });
    await ctx.stage({ name: "step-2" }, {}, {}, async (s) => { /* s.client, s.session */ });
  })
  .compile();
```

The runtime manages the full session lifecycle — callback return marks
completion; throws mark errors. `.compile()` produces a branded
`WorkflowDefinition` consumed by the CLI.

### Background (headless) stages

Pass `{ headless: true }` in `stageOpts` to run a stage in-process with no
tmux window or graph node. The callback interface is identical
(`s.client`, `s.session`, `s.save()`, `s.transcript()` all work). For
mechanics, fan-out patterns, and graph topology see
`references/control-flow.md` §"Headless stages" and
`references/agent-sessions.md` per-SDK "Headless mode" sections.

### Installing the workflow SDK

Install `@bastani/atomic` plus the native SDK(s) you target
(`@anthropic-ai/claude-agent-sdk`, `@github/copilot-sdk`,
`@opencode-ai/sdk`).

### Composition root

Workflows are wired into a **composition root** — a TypeScript file the
user runs with `bun`. The SDK exposes pure primitives:

- `runWorkflow({ workflow, inputs, detach? })` — spawn a workflow's tmux session.
- `createRegistry()` / `listWorkflows(reg)` / `getWorkflow(reg, agent, name)` — build and iterate a registry.
- `getName(wf) / getAgent(wf) / getDescription(wf) / getInputSchema(wf) / getSource(wf) / getMinSDKVersion(wf)` — read workflow metadata.
- `validateInputs(wf, raw)` — apply defaults and validate against the declared schema.
- `listSessions / getSession / stopSession / attachSession / getSessionStatus / getSessionTranscript` — manage running tmux sessions on the shared atomic socket.
- `WorkflowPicker` (from `@bastani/atomic/workflows/components`) — the interactive picker `atomic workflow -a claude` uses.

You compose them into whatever CLI library you prefer. The SDK never
re-execs the dev's CLI — it ships its own orchestrator entry script and
re-execs *that* with positional args.

```ts
// src/claude-worker.ts — single workflow with a small Commander entrypoint
import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic/workflows";
import workflow from "./workflows/my-workflow/claude.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
});
await program.parseAsync();

// src/cli.ts — many workflows via createRegistry + listWorkflows
import {
  createRegistry,
  getInputSchema,
  getName,
  listWorkflows,
  runWorkflow,
} from "@bastani/atomic/workflows";
import claudeWorkflow from "./workflows/my-workflow/claude.ts";
import copilotWorkflow from "./workflows/my-workflow/copilot.ts";

const registry = createRegistry()
  .register(claudeWorkflow)
  .register(copilotWorkflow);

const program = new Command();
for (const wf of listWorkflows(registry)) {
  const sub = program.command(getName(wf));
  for (const input of getInputSchema(wf)) {
    sub.option(`--${input.name} <value>`, input.description ?? "");
  }
  sub.action(async (rawOpts) => {
    await runWorkflow({ workflow: wf, inputs: rawOpts as Record<string, string> });
  });
}
await program.parseAsync();
```

For programmatic invocation (no CLI at all), call `runWorkflow` directly:

```ts
const { id, tmuxSessionName } = await runWorkflow({
  workflow,
  inputs: { prompt: "fix the auth bug" },
  detach: true,
});
```

For full registry mechanics, key scheme, and validate-on-register behaviour see `references/registry-and-validation.md`.

### Two context levels

`WorkflowContext` (`ctx`) drives orchestration in `.run()`; `SessionContext`
(`s`) drives agent work inside each stage callback. Full field reference in
`references/getting-started.md` §"`SessionContext` reference".

### Declared inputs

Workflows receive user data exclusively through `ctx.inputs` / `s.inputs`,
declared inline as `inputs: WorkflowInput[]` on `defineWorkflow()`.
TypeScript restricts `ctx.inputs` to declared keys (undeclared access is a
compile-time error). Load `references/workflow-inputs.md` for schema shape,
field types (`string` / `text` / `enum`), validation rules, picker
semantics, and the "declare your prompt input explicitly" pattern.

### Invocation surfaces

Two invocation paths:

**User's own app** — the dev controls the CLI shape entirely. Whatever flags they declare in their Commander/citty/yargs program are the user-facing UX. A typical layout (see snippets above):

```bash
# Single-workflow worker — flags match the workflow's declared inputs
bun run src/claude-worker.ts --prompt "fix the bug"
bun run src/claude-worker.ts --research_doc=notes.md --focus=standard

# Multi-workflow CLI — one subcommand per workflow
bun run src/cli.ts review --target_branch=main
bun run src/cli.ts spec   --research_doc=notes.md
```

To launch the interactive picker, mount the `WorkflowPicker` component:

```ts
import { WorkflowPickerPanel } from "@bastani/atomic/workflows/components";

const panel = await WorkflowPickerPanel.create({ agent: "claude", registry });
const result = await panel.waitForSelection();
panel.destroy();
if (result) {
  await runWorkflow({ workflow: result.workflow, inputs: result.inputs });
}
```

The dev's CLI is **never** re-execed. The SDK ships an internal orchestrator entry script and re-execs that with positional args — no env-var dance, no boilerplate re-entry code in the dev's file.

**Atomic builtins** — workflows shipped inside `@bastani/atomic`, registered by atomic's internal `createBuiltinRegistry()`:

```bash
atomic workflow -n <name> -a <agent> [inputs...]
```

Surface | Command | When
---|---|---
Named, with prompt | `… -n hello -a claude "fix the bug"` | Requires workflow to declare a `prompt` input
Named, structured | `… -n gen-spec -a claude --research_doc=notes.md` | Structured inputs via `--<field>` flags
Interactive picker | `atomic workflow -a claude` | Discovery — fuzzy list + form; this is the intentional no-`-n` path
List (atomic builtins) | `atomic workflow list`, `atomic workflow list -a <agent>` | Browse registered builtins, optionally filtered
List (user cli) | Iterate `listWorkflows(registry)` and add a `list` Commander subcommand yourself | No built-in `--list` flag
List (single-workflow) | Not applicable — the file *is* the workflow
Inspect inputs | `atomic workflow inputs <name> -a claude` | Print input schema as JSON
Status (one or all) | `atomic workflow status [<session-id>]` | Query state — `in_progress`, `error`, `completed`, `needs_review`
Kill non-interactively | `atomic session kill <id> -y` | Tear down without confirmation prompt — `-y` is mandatory for agents
Detached (background) | `… -d` / `… --detach` | Runs without attaching; reattach with `atomic workflow session connect <name>`

Any of the named shapes above (positional or structured) accepts
`-d` / `--detach` to run without attaching. Use it when you're automating
from a script and want the CLI to return as soon as the session is spawned.

### Declaring SDK compatibility (`minSDKVersion`)

Opt-in version gate for workflows that depend on a specific SDK release.
**Default is unset — do not add it to new workflows unless you have a
concrete reason.**

```ts
defineWorkflow({
  name: "uses-new-api",
  source: import.meta.path,
  minSDKVersion: "0.6.0", // refuse to load on older CLI
})
```

When set to a version newer than the installed CLI, the workflow refuses to
load and surfaces a visible row in `atomic workflow list` and the picker
(rather than silently vanishing). Set it only when the workflow calls a
newly-added SDK surface (new `stage()` option, new helper export, new
provider method); omit it for workflows on stable APIs. Full semver
semantics and the visible-diagnostic contract live in
`references/registry-and-validation.md`.

## Structural Rules (hard constraints)

Enforced by the builder, loader, and runtime:

1. **`.run()` required** — the builder must have a `.run(async (ctx) => { ... })` call.
2. **`.compile()` required** — the chain must end with `.compile()`.
3. **Every workflow is a named `export`** — export the compiled definition from the workflow file (default or named). It is then imported and passed to `registry.register(...)` in the composition root.
4. **Unique session names** — every `ctx.stage()` call must use a unique `name` across the workflow run.
5. **Completed-only reads** — `transcript()` and `getMessages()` only access sessions whose callback has returned and saves have flushed. Attempting to read a still-running session throws.
6. **Graph topology is auto-inferred** — the runtime derives parent-child edges from `await`/`Promise.all` patterns. Sequential `await` creates a chain; `Promise.all([...])` branches from the same parent; a stage after `Promise.all` receives all parallel stages as parents. Headless stages are **transparent** to the graph — they don't consume or update the execution frontier. See `references/control-flow.md` for full details.
7. **Do not manually create clients or sessions** — the runtime auto-creates `s.client` and `s.session` from `clientOpts` and `sessionOpts`. Use `s.session.query()`, `s.session.send()`, and `s.client.session.prompt()` instead.
8. **Headless stages share the same callback interface** — `s.client`, `s.session`, `s.save()`, `s.transcript()`, and return values all work identically in headless mode. The only differences are: no tmux window, no graph node, and a virtual `paneId`.
9. **Every `ctx.stage()` must contain at least one LLM interaction** — a `s.session.query()` / `s.session.send()` / `s.client.session.prompt()` call. A stage that runs only TypeScript (file I/O, git commands, HTTP calls, parsing, validation) spawns a visible tmux pane that sits idle on the agent welcome screen for the whole stage, confusing users watching the graph. See `references/failure-modes.md` §F22. Pure deterministic code belongs in `.run()` outside any stage; deterministic follow-up *paired* with a query (e.g. parse → validate → save after `s.session.query()`) belongs in the same callback.

## Concept-to-Code Mapping

Every workflow pattern maps directly to TypeScript code:

| Workflow Concept | Programmatic Pattern |
|---|---|
| Agent session (send prompt, get response) | `ctx.stage({ name }, {}, {}, async (s) => { /* use s.client, s.session */ })` — **must** include an LLM call (Rule 9) |
| Background (headless) session | `ctx.stage({ name, headless: true }, {}, {}, async (s) => { /* same API */ })` — invisible in graph, tracked by background counter |
| Sequential execution | `await ctx.stage(...)` followed by `await ctx.stage(...)` |
| Parallel execution | `Promise.all([ctx.stage(...), ctx.stage(...)])` |
| Parallel background tasks | `Promise.all([ctx.stage({ name: "a", headless: true }, ...), ctx.stage({ name: "b", headless: true }, ...)])` |
| Conditional branching | `if (...) { await ctx.stage({ name: "fix" }, {}, {}, ...) }` |
| Bounded loops with visible graph nodes | `for (let i = 1; i <= N; i++) { await ctx.stage({ name: \`step-\${i}\` }, {}, {}, ...) }` |
| Return data from session | `const h = await ctx.stage(opts, {}, {}, async (s) => { return value; }); h.result` |
| Data flow between sessions | `s.save()` to persist → `s.transcript(handle)` or `s.transcript("name")` to retrieve |
| Pure deterministic computation (no LLM call) | Plain TypeScript at the top level of `.run()`. **Never** a standalone stage — see Rule 9 and F22. |
| Deterministic work tied to an LLM call | Inside the same stage callback, before/after the query. E.g. `s.session.query(...)` → parse → validate → `s.save(parsed)`. |
| Subagent orchestration | Claude: `--agent` via `chatFlags` (interactive) or `agent` SDK option (headless); Copilot: `{ agent: "name" }` in sessionOpts; OpenCode: `agent` param in `s.client.session.prompt()` |
| Per-session configuration | Pass `clientOpts` (2nd arg) and `sessionOpts` (3rd arg) to `ctx.stage()` |

### When to use a stage vs. plain TypeScript

Before reaching for `ctx.stage()`, ask: **does this block need an LLM?**

```ts
// ✓ OK — query + deterministic parse in the same callback
const plan = await ctx.stage({ name: "plan" }, {}, {}, async (s) => {
  const messages = await s.session.query("Produce a step-by-step plan.");
  const text = extractAssistantText(messages, 0);
  const parsed = parsePlan(text);       // deterministic — fine here
  s.save(parsed);
  return parsed;
});

// ✓ OK — plain TS at the top of .run() between stages
const plannedFiles = plan.result.files.filter(f => f.endsWith(".ts"));
const startedAt = Date.now();

// ✗ NOT OK — a stage whose callback is pure code with no query
await ctx.stage({ name: "write-report" }, {}, {}, async (s) => {
  await fs.writeFile("report.md", buildReport(plan.result)); // no LLM!
});
// This spawns a tmux pane that stays on the Claude/Copilot welcome
// screen for the whole stage. The user watching the graph sees an
// empty pane and wonders why no prompt ever appeared.

// ✓ OK — do the deterministic work inline in .run()
await fs.writeFile("report.md", buildReport(plan.result));
```

Rule of thumb: **one stage, one LLM conversation.** If the block has no
`s.session.query()` / `s.session.send()` / `s.client.session.prompt()`,
it's not a stage.

For full pattern examples with code, see `references/control-flow.md`
(loops, conditionals, review/fix, graph topology, headless fan-out),
`references/state-and-data-flow.md` (data passing, file coordination,
transcript compression), and `references/computation-and-validation.md`
(parsing, validation, quality gates).

## Authoring Process

### 1. Understand the User's Goal

Map the user's intent to sessions and patterns:

| Question | Maps to |
|----------|---------|
| What are the distinct **LLM interactions**? | Each LLM conversation → one `ctx.stage()` call (Rule 9) |
| Can any LLM calls run in parallel? | `Promise.all([ctx.stage(...), ...])` |
| Should any parallel LLM calls run in the background? | `ctx.stage({ name, headless: true }, ...)` — invisible in graph, ideal for data-gathering |
| Does any step need **pure deterministic code** (no LLM)? | Plain TypeScript at the top of `.run()` — **not** a dedicated stage. Bundle it inside the nearest stage callback if it's directly tied to that stage's query. |
| Do any steps need to repeat? | `for`/`while` loop with `ctx.stage()` inside |
| Are there conditional paths? | `if`/`else` wrapping `ctx.stage()` calls |
| What data flows between steps? | `s.save()` → `s.transcript(handle)` / `s.getMessages(handle)` |
| Does the workflow need user input? | SDK-specific user input APIs (see `references/user-input.md`) |
| Do any steps need a specific model? | SDK-specific session config (see `references/session-config.md`) |

Then walk the **Design Advisory Skills** table above (§"Design Advisory
Skills") — for each row whose trigger applies to your workflow, pull that
skill in *before* writing code. Catching architectural and prompt-quality
issues at design time is far cheaper than catching them in the first failed
end-to-end run.

### 2. Choose the Target Agent

Pass the agent as a runtime argument to `.for()` on the builder — this
narrows all context types and gives correct `s.client`/`s.session` types.
Call `.for()` **before** `.run()`:

| Agent | Builder Chain | Primary Session API |
|-------|---------------|---------------------|
| Claude | `defineWorkflow({...}).for("claude")` | `s.session.query(prompt)` — sends prompt to the Claude TUI pane |
| Copilot | `defineWorkflow({...}).for("copilot")` | `s.session.send({ prompt })` — the runtime wraps `send` to block until `session.idle` with no timeout (see `failure-modes.md` §F10); do not use `sendAndWait` in Atomic workflows |
| OpenCode | `defineWorkflow({...}).for("opencode")` | `s.client.session.prompt({ sessionID: s.session.id, parts: [...] })` |

The runtime manages client/session lifecycle automatically. For native SDK
types and advanced APIs, import directly from the provider packages
(`@github/copilot-sdk`, `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk/v2`).

For cross-agent support, create one workflow file per agent. Use shared
helper modules for SDK-agnostic logic. A typical layout:

```
src/workflows/my-workflow/
├── claude.ts          # Claude-specific SDK code  — exports a WorkflowDefinition
├── copilot.ts         # Copilot-specific SDK code — exports a WorkflowDefinition
├── opencode.ts        # OpenCode-specific SDK code— exports a WorkflowDefinition
└── helpers/
    ├── prompts.ts     # Prompt builders (SDK-agnostic)
    ├── parsers.ts     # Response parsers (SDK-agnostic)
    └── validation.ts  # Validation logic (SDK-agnostic)
```

Register each variant in the composition root:

```ts
import { claudeWorkflow } from "./workflows/my-workflow/claude.ts";
import { copilotWorkflow } from "./workflows/my-workflow/copilot.ts";

const registry = createRegistry()
  .register(claudeWorkflow)
  .register(copilotWorkflow);
```

### 3. Write the Workflow File

Write the workflow file using the SDK-specific patterns. See
`references/getting-started.md` for full quick-start examples for all 3
SDKs (send/save/extract patterns, idle handling), and
`references/agent-sessions.md` for per-SDK API details and lifecycle
caveats.

**Reference implementations** — two categories live in-repo:

- **Builtins** (`src/sdk/workflows/builtin/`) — production patterns,
  registered via `createBuiltinRegistry()` inside the `atomic` CLI:
  - `ralph` — iterative plan → orchestrate → review → debug loop.
  - `deep-research-codebase` — scout → parallel explorer fan-out → aggregator.
  - `open-claude-design` — design-system init flow.
- **User-app examples** (`examples/<name>/`) — minimal runnable user apps
  you can copy-paste as a starting point. Each example directory contains
  `claude/index.ts`, `copilot/index.ts`, `opencode/index.ts`, and one
  `<agent>-worker.ts` entrypoint per agent — each a small Commander
  entrypoint that calls `runWorkflow({ workflow, inputs })`. Run with
  `bun run examples/<name>/<agent>-worker.ts --<field>=<value>` (or a
  positional prompt string if the worker declares `[prompt...]`).
  Covers: `hello-world`, `parallel-hello-world`, `headless-test`,
  `hil-favorite-color`, `hil-favorite-color-headless`,
  `structured-output-demo`, `reviewer-tool-test` (copilot only).

Both sets demonstrate shared helpers, context-aware prompt building,
deterministic heuristics, and cross-SDK adaptation.

### 4. Wire, typecheck, run

The composition root is always three lines (see §"Scaffold a new workflow from scratch" above for the exact template and multi-workflow variant). After writing it:

```bash
bun typecheck
bun run src/<agent>-worker.ts --prompt "<test task>"
```

Other invocation shapes you may want to demonstrate to the user once the workflow runs:

```bash
# Single-workflow worker — flags match the workflow's declared inputs
bun run src/<agent>-worker.ts --<field>=<value>             # structured inputs
bun run src/<agent>-worker.ts "free-form prompt text"       # positional fallback (if wired)

# Multi-workflow CLI — one subcommand per workflow
bun run src/cli.ts <workflow-name> --<field>=<value>        # structured
bun run src/cli.ts <workflow-name> "free-form prompt text"  # positional fallback (if wired)

# Atomic builtins — these use -n/-a/-d (atomic CLI's own flags, not user-app flags)
atomic workflow -n <name> -a <agent> "<prompt>"             # attached run
atomic workflow -n <name> -a <agent> -d "<prompt>"          # detached (background)
```

For detached user-app runs, pass `detach: true` to `runWorkflow` or wire your own `--detach` flag in your Commander entrypoint. For the atomic builtins (`ralph`, `deep-research-codebase`, `open-claude-design`), see `references/running-workflows.md` for monitoring and teardown.

## Running an Existing Workflow

If the user asks you to **run** (or "kick off" / "start" / "execute") a
workflow — not author one — the workflow already exists and you just need
to invoke it correctly. That's a different playbook from authoring.

**Read `references/running-workflows.md`.** It covers:

- Three invocation paths: user's own app (per-input `--<flag>` flags wired
  by the dev, using Commander or another CLI library), repo-shipped examples
  (same pattern), and atomic builtins (`atomic workflow -n … -a …`).
- Why atomic builtins use `-n` + `-a` and how to add `-d` for background runs.
- Why you must list workflows first.
- How to handle missing workflows (offer to author, not fabricate).
- Using `atomic workflow inputs <name> -a <agent>` to discover the schema
  and drive AskUserQuestion.
- The six-step invocation recipe.
- Monitoring with `atomic workflow status` — and why `needs_review` must be
  surfaced immediately.
- Tearing down with `atomic session kill -y` (the `-y` is mandatory).
- Worked examples for "workflow exists" and "workflow doesn't exist".
