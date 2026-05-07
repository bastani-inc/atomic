---
name: workflow-creator
description: Create or run Atomic CLI workflows with the `@bastani/atomic-sdk` npm package — using `defineWorkflow().run().compile()` and `ctx.stage()` across Claude, Copilot, and OpenCode SDKs. Use when authoring, editing, debugging, or designing agent pipelines including multi-stage automations, review/fix loops, parallel fan-out, headless/background stages, `ctx.inputs`, `WorkflowInput` schemas, registries, validation, picker UI, and single or multi-workflow composition roots. Use when scaffolding atomic-managed custom workflows under `.atomic/workflows/<name>/` (or `~/.atomic/workflows/<name>/`), registering them in `settings.json`, and verifying with `atomic workflow refresh`. Use when running existing workflows to kick off, monitor, check status, inspect on-disk state via `atomic workflow read`, gather inputs, or tear down sessions via `atomic workflow -n`, `atomic workflow inputs`, `atomic workflow status`, picker flows, or `atomic session kill`.
metadata:
  provider: atomic
---

# Workflow Creator

> **SDK package: `@bastani/atomic-sdk`.** This is the only npm package you ever need to install to author or run Atomic workflows. Install it with `bun add @bastani/atomic-sdk`. All workflow APIs are imported from `@bastani/atomic-sdk` (root barrel) or `@bastani/atomic-sdk/workflows` (authoring sub-barrel) — see §"Installing the workflow SDK" for the exact import-path map. **Do not** invent alternative names like `atomic-sdk`, `@atomic/sdk`, `@bastani/atomic` (that one is the user-facing CLI binary, *not* the SDK), or `@bastani/workflow-sdk`. The user-facing `@bastani/atomic` CLI is **not** required as a peer dependency.

You are a workflow architect specializing in the Atomic CLI `defineWorkflow().run().compile()` API exposed by the **`@bastani/atomic-sdk`** npm package. You translate user intent into well-structured workflow files that orchestrate multiple coding agent sessions using **programmatic SDK code** — Claude Agent SDK, Copilot SDK, and OpenCode SDK. Sessions are spawned dynamically via `ctx.stage(stageOpts, clientOpts, sessionOpts, callback)` inside the `.run()` callback, using native TypeScript control flow (loops, conditionals, `Promise.all()`) for orchestration. The runtime auto-creates the SDK client and session, injects them as `s.client` and `s.session`, runs the callback, then auto-cleans up.

You also serve as a **context engineering advisor** — use the design skills listed under "Design Advisory Skills" to make informed architectural decisions about session structure, data flow, prompt composition, and quality assurance.

Two user journeys live in this skill:

- **Authoring** a new workflow (or editing/debugging an existing one) → read on below.
- **Running** a workflow on the user's behalf ("run ralph on this spec", "is it done yet?", "kill it") → go to `references/running-workflows.md`.

## Reference Files

Load references on demand. **Only `getting-started.md` is always-load.** Everything else is conditional — pull it in when the task matches the trigger column.

| File                            | Load when                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getting-started.md`            | **Always** — quick-start examples for all 3 SDKs, SDK exports, `SessionContext` field reference                                                                                                                       |
| `agent-setup-recipe.md`         | When the user is starting from zero (empty terminal, no project, "set me up", "how do I get started"). Deterministic env-detect → install → scaffold → smoke-test playbook with typed-error recovery hints            |
| `failure-modes.md`              | Before shipping any multi-session workflow. 16 catalogued failures (silent + loud) with wrong-vs-right patterns and a pre-ship design checklist                                                                       |
| `workflow-inputs.md`            | When declaring structured inputs or documenting how a workflow is invoked — `WorkflowInput` schema, field-type selection, picker + CLI flag semantics, builtin-protection rules                                       |
| `agent-sessions.md`             | When writing SDK calls — `s.session.query()` (Claude), `s.session.send()` (Copilot), `s.client.session.prompt()` (OpenCode); includes session-lifecycle pitfalls and when to use `sendAndWait` with explicit timeouts |
| `control-flow.md`               | When using loops, conditionals, parallel execution (`Promise.all`), headless fan-out, or review/fix patterns                                                                                                          |
| `state-and-data-flow.md`        | When passing data between sessions — `s.save()`, `s.transcript()`, `s.getMessages()`, file persistence, transcript compression                                                                                        |
| `running-workflows.md`          | When the user asks you to **run** an existing workflow rather than author one                                                                                                                                         |
| `computation-and-validation.md` | When adding deterministic computation, response parsing, validation, quality gates, or file I/O                                                                                                                       |
| `session-config.md`             | When configuring model, tools, permissions, hooks, or structured output per SDK                                                                                                                                       |
| `user-input.md`                 | When collecting user input **mid-workflow** (not at invocation time — use `workflow-inputs.md` for that)                                                                                                              |
| `registry-and-validation.md`    | When setting up `createRegistry()` and iterating it via `listWorkflows`, understanding key scheme, validate-on-register rules, and same-name collision detection (only relevant for the multi-workflow cli)           |

## Custom workflow modes — pick before you scaffold

Every new workflow lands in one of two layouts. The choice is not stylistic — it determines *where files live*, *how the workflow is invoked*, and *which entry-point pattern you use*. Pick before you write any code; mixing layouts mid-stream means rewriting the scaffold.

| Mode                                       | Where it lives                                                                                                                                                                                                       | How it's invoked                                                                                  | When to pick it                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 · Atomic-managed** (default)           | Project: `.atomic/workflows/<name>/` · Global: `~/.atomic/workflows/<name>/` · Each is a self-contained Bun package (own `package.json`, own `tsconfig.json`, own `node_modules`); registered in `settings.json` | `atomic workflow -n <name> -a <agent> [...]` after `atomic workflow refresh` confirms it loaded | The user asks "build me a workflow that does X" without scoping it to their own CLI. **This is the default.** Defaults to project-level (`.atomic/workflows/`); use `~/.atomic/workflows/` only when they explicitly say "global" or "user-level". |
| **2 · Dev-owned CLI**                      | `<repo>/src/workflows/<name>/<agent>.ts` + `<repo>/src/<agent>-worker.ts` (or `src/cli.ts` for multi-workflow registries)                                                                                            | `bun run src/<agent>-worker.ts --<flag>=<value>`                                                  | The user is building their *own* CLI surface, an internal tool, an `examples/` reference, or anything where the workflow is not meant to be discoverable by the wider `atomic` CLI |
| **1 + 2 combined**                         | Same file as Mode 2, plus `await hostLocalWorkflows([wf])` *before* their own `program.parseAsync()`                                                                                                                 | Both surfaces work — `atomic workflow -n …` AND the dev's own flags                               | The dev wants a polished standalone CLI **and** wants the workflow to show up in `atomic workflow list`. Token-gated dispatch means the two paths don't interfere.              |

**Default rule for the model:** if the user does not specify, scaffold Mode 1 in `.atomic/workflows/<name>/`. Confirm scope in one short question only when ambiguous (e.g. "global or project-scope?" when the wording suggests user-wide reuse).

For runnable reference workflows across both modes, study the in-repo examples first: <https://github.com/flora131/atomic/tree/main/examples>. Each example directory under `examples/` ships per-agent files plus a `<agent>-worker.ts` entry — copy the closest-fitting one as your starting point rather than authoring from a blank file.

### Mode 1 — Atomic-managed (project: `.atomic/workflows/<name>/`)

Use this when the user wants a workflow that integrates with `atomic workflow` (list, picker, status, refresh). The detailed playbook lives in `references/agent-setup-recipe.md` §"Mode 1 setup". Shape:

```
<repo>/
└── .atomic/
    ├── settings.json                          # registry of custom workflow entries
    └── workflows/
        └── <workflow-name>/                   # ← self-contained Bun package
            ├── package.json                   # own deps: @bastani/atomic-sdk + provider SDK
            ├── tsconfig.json
            ├── node_modules/                  # populated by `bun install` inside this dir
            └── index.ts                       # defineWorkflow → compile → hostLocalWorkflows
```

Five-step rhythm:

1. **Verify prerequisites** — Bun, tmux/psmux, an authenticated agent CLI (devcontainers using `ghcr.io/flora131/atomic/<agent>:1` bundle all three).
2. **Scaffold the package** — `mkdir -p .atomic/workflows/<name> && cd .atomic/workflows/<name> && bun init -y` + `bun add @bastani/atomic-sdk @anthropic-ai/claude-agent-sdk` (or the provider SDK matching the agent the user picked).
3. **Write the workflow** at `.atomic/workflows/<name>/index.ts`:

   ```ts
   #!/usr/bin/env bun
   import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic-sdk";

   const workflow = defineWorkflow({
     name: "<workflow-name>",
     source: import.meta.path,
     description: "<one-line description>",
     inputs: [{ name: "prompt", type: "text", required: true, description: "..." }],
   })
     .for("claude")
     .run(async (ctx) => {
       await ctx.stage({ name: "step-1" }, {}, {}, async (s) => {
         await s.session.query(ctx.inputs.prompt);
         s.save(s.sessionId);
       });
     })
     .compile();

   await hostLocalWorkflows([workflow]);
   ```

   The `source: import.meta.path` is mandatory — the orchestrator re-imports this path. The trailing `await hostLocalWorkflows([wf])` is what makes the file responsive to atomic's token-gated `_emit-workflow-meta` and `_atomic-run` sub-commands.

4. **Register in `settings.json`** — append to `.atomic/settings.json` (project-local) or `~/.atomic/settings.json` (global; create if missing). The schema URL gives JSON intellisense in editors.

   ```jsonc
   {
     "$schema": "https://raw.githubusercontent.com/flora131/atomic/main/assets/settings.schema.json",
     "version": 1,
     "workflows": {
       "<workflow-name>": {
         "command": "bunx",
         "args": ["./.atomic/workflows/<workflow-name>/index.ts"],
         "agents": ["claude"]
       }
     }
   }
   ```

   Use `~/.atomic/workflows/<name>/...` (absolute) in the `args` for global workflows so `cwd` doesn't change resolution.

5. **Refresh and verify** — run `atomic workflow refresh`. This re-spawns the metadata loader for every entry and emits a structured report. Inside an atomic chat session it auto-defaults to JSON; outside, text. Either way:

   - `loaded` entries confirm the workflow is now invocable via `atomic workflow -n <name> -a <agent>`.
   - `broken` entries surface the exact `reason`, `fix`, and `settings` path on their own lines so the model can self-correct without prose parsing.

   On clean load, smoke-test with `atomic workflow -n <name> -a <agent> "<test prompt>"`.

### Mode 2 — Dev-owned CLI

Use this when the user is building their own CLI (an internal tool, an example, a one-off script). Shape:

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

Same five-step rhythm, but the entry point is `runWorkflow({ workflow, inputs })` inside a Commander/citty/yargs handler. Detailed playbook: `references/agent-setup-recipe.md` §"Mode 2 setup".

The when-in-doubt rules within Mode 2:

- **Single agent, single workflow** — the 90% case. One `<agent>.ts` + one `<agent>-worker.ts`. Done.
- **Same workflow across agents** — three `<agent>.ts` files that share helpers from `src/workflows/<name>/helpers/`; three `<agent>-worker.ts` files.
- **Multiple workflows in one CLI** — build a `createRegistry().register(...)` pipeline and iterate it via `listWorkflows(registry)` to mount one Commander subcommand per workflow. Use a `src/cli.ts` composition root instead of per-agent workers.

### Mode 1 + 2 combined

The same workflow file calls `await hostLocalWorkflows([wf])` *before* setting up its own Commander program. Atomic's two internal sub-commands (`_emit-workflow-meta`, `_atomic-run`) are token-gated and `process.exit(0)` after handling, so the dev's own argv parser never sees them on bare invocation. Use this when the workflow needs to be discoverable through `atomic workflow` AND directly runnable as a standalone Bun script.

If the user's need doesn't match any of these, ask before scaffolding — picking wrong here means rewriting 100% of the scaffold.

For monitoring and lifecycle management after a run is live, the global `atomic` CLI (`atomic session list`, `atomic workflow status`, `atomic session kill -y`) and the SDK session primitives (`listSessions`, `getSession`, `getSessionStatus`, `attachSession`, `detachSession`, `stopSession`, `nextWindow`, `previousWindow`, `gotoOrchestrator`) both operate on the shared `atomic` tmux socket — workflows started either way show up in both surfaces. The lifecycle six (`listSessions`, `getSession`, `getSessionStatus`, `attachSession`, `stopSession`, plus `getSessionTranscript`) live on both `@bastani/atomic-sdk` and `@bastani/atomic-sdk/workflows`; the four control-plane verbs (`detachSession`, `nextWindow`, `previousWindow`, `gotoOrchestrator`) live on the root barrel only. See `references/running-workflows.md` for the `awaiting_input` / `needs_review` HIL states and worked teardown examples, and `examples/pane-navigation/` for a reference driver CLI exercising the navigation primitives.

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

| Design Concern                | Skill                  | Trigger                                                                      |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------- |
| Prompt clarity and structure  | `prompt-engineer`      | Every workflow — clear instructions, XML tags, examples, chain-of-thought    |
| Session prompt structure      | `context-fundamentals` | Every workflow — token budgeting, prompt positioning, progressive disclosure |
| Context failure prevention    | `context-degradation`  | Long conversations, accumulated state, multi-turn loops                      |
| Transcript compression        | `context-compression`  | Passing large transcripts between sessions                                   |
| Multi-session architecture    | `multi-agent-patterns` | Coordination topology, handoff protocols, error propagation                  |
| Cross-run persistence         | `memory-systems`       | Retaining knowledge across separate executions                               |
| Custom tools and capabilities | `tool-design`          | Sessions exposing custom tools                                               |
| File-based coordination       | `filesystem-context`   | Sessions sharing state via files                                             |
| Remote execution              | `hosted-agents`        | Sandboxed or remote environments                                             |
| Token efficiency              | `context-optimization` | Compaction triggers, observation masking, cache-friendly ordering            |
| Quality gates                 | `evaluation`           | Review loops or quality checkpoints                                          |
| LLM-as-judge review           | `advanced-evaluation`  | Automated review sessions judging other sessions' output                     |
| Task-model fit                | `project-development`  | Validating whether a task is viable for agent automation                     |
| Deliberative reasoning        | `bdi-mental-states`    | Explainable reasoning chains or formal cognitive models                      |

## How Workflows Work

A workflow is a TypeScript file with a single `.run()` callback that
orchestrates agent sessions dynamically. Inside the callback, `ctx.stage()`
spawns sessions — each gets its own tmux window and graph node (unless
running in headless mode). Native TypeScript handles all control flow:
loops, conditionals, `Promise.all()`, `try`/`catch`.

```ts
import { defineWorkflow, extractAssistantText } from "@bastani/atomic-sdk/workflows";

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

The workflow SDK ships as a **single npm package: `@bastani/atomic-sdk`**.
Install it with Bun, then add the native provider SDK(s) for whichever
agents you target:

```bash
bun add @bastani/atomic-sdk            # required — the workflow SDK
bun add @anthropic-ai/claude-agent-sdk # if you target Claude
bun add @github/copilot-sdk            # if you target Copilot
bun add @opencode-ai/sdk               # if you target OpenCode
```

`@bastani/atomic-sdk` is sufficient on its own — the user-facing
`@bastani/atomic` CLI is a **separate** package and is **not** a peer
dependency of the SDK. The SDK ships its own bundled orchestrator
dispatcher; do not install `@bastani/atomic` just to author or run
workflows.

Import paths exposed by `@bastani/atomic-sdk`:

| Import path                                  | Exports                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@bastani/atomic-sdk`                        | Root barrel — session lifecycle (`listSessions`, `getSession`, `getSessionStatus`, `attachSession`, `stopSession`, `getSessionTranscript`) plus control-plane verbs (`detachSession`, `nextWindow`, `previousWindow`, `gotoOrchestrator`) |
| `@bastani/atomic-sdk/workflows`              | Authoring sub-barrel — `defineWorkflow`, `runWorkflow`, `createRegistry`, `listWorkflows`, `getWorkflow`, metadata getters, `validateInputs`, `extractAssistantText`, the lifecycle six (re-exported), and the typed errors `MissingDependencyError` / `SessionNotFoundError` / `WorkflowNotCompiledError` / `InvalidWorkflowError` |
| `@bastani/atomic-sdk/workflows/components`   | `WorkflowPickerPanel` (the interactive picker UI)                                                                                        |
| `@bastani/atomic-sdk/errors`                 | `IncompatibleSDKError` (separate from the `/workflows` errors because it's about SDK-version compatibility, not workflow runtime)        |

If you find yourself reaching for any other package name to import
workflow APIs, stop — you are on the wrong path. Everything authoring-
and runtime-related lives under `@bastani/atomic-sdk`.

### Composition root

Workflows are wired into a **composition root** — a TypeScript file the
user runs with `bun`. The SDK exposes pure primitives:

- `runWorkflow({ workflow, inputs, detach?, pathToAtomicExecutable? })` — spawn a workflow's tmux session. Leave `pathToAtomicExecutable` unset and the SDK auto-detects: in `bun run` mode it spawns its own bundled dispatcher via host bun; in a `bun build --compile`d host it auto-defaults to `process.execPath` so the consumer's own binary self-dispatches the internal sub-command (the `@bastani/atomic-sdk/workflows` barrel installs the argv handler at module-load time — no consumer boilerplate). Set the option only to override that default, e.g. to route through a separately installed atomic binary (absolute path or bare command name resolved via PATH). Mirrors the Claude Agent SDK's [`pathToClaudeCodeExecutable`](https://docs.claude.com/en/agent-sdk/typescript).
- `createRegistry()` / `listWorkflows(reg)` / `getWorkflow(reg, agent, name)` — build and iterate a registry.
- `getName(wf) / getAgent(wf) / getDescription(wf) / getInputSchema(wf) / getSource(wf) / getMinSDKVersion(wf)` — read workflow metadata.
- `validateInputs(wf, raw)` — apply defaults and validate against the declared schema.
- **Session lifecycle** — `listSessions / getSession / stopSession / attachSession / getSessionStatus / getSessionTranscript` are exported from both the root `@bastani/atomic-sdk` barrel and the `/workflows` sub-barrel. `detachSession` is exported only from the **root** barrel (`@bastani/atomic-sdk`) — not from `/workflows`.
- **Pane navigation** — `nextWindow / previousWindow / gotoOrchestrator` are exported only from the **root** `@bastani/atomic-sdk` barrel (not from `/workflows`). Pure tmux verbs: they update the session's current-window pointer and return immediately. Never auto-attach — an attached client sees the change live; if no client is watching, the next `attachSession` call lands on the new window. Compose `nextWindow(id) + attachSession(id)` for navigate-then-attach.
- **Typed errors** (catch with `instanceof` to render friendly CLI messages) — `MissingDependencyError` (tmux/psmux/bun missing), `SessionNotFoundError` (id not on the atomic socket), `WorkflowNotCompiledError` (forgot `.compile()`), `InvalidWorkflowError` (default export not a `WorkflowDefinition`) all live on the `@bastani/atomic-sdk/workflows` barrel. `IncompatibleSDKError` (workflow's `minSDKVersion` newer than the installed `@bastani/atomic-sdk`) and `NoDispatcherError` (SDK can't locate its dispatcher — surfaces only when an explicit empty `pathToAtomicExecutable` defeats the auto-default) are exported separately from `@bastani/atomic-sdk/errors`. All thrown by SDK primitives; all carry the relevant payload field (`dependency`, `id`, `path`, version pair, or `searchedFor` for `NoDispatcherError`).
- `WorkflowPickerPanel` (from `@bastani/atomic-sdk/workflows/components`) — the interactive picker `atomic workflow -a claude` uses.

You compose them into whatever CLI library you prefer. In `bun run` mode
the SDK ships its own orchestrator entry script (bundled inside
`@bastani/atomic-sdk`) and re-execs *that* with positional args, so the
dev's CLI is never re-entered. In `bun build --compile`d hosts the SDK
re-execs the consumer's own binary — but transparently: the
`@bastani/atomic-sdk/workflows` barrel intercepts the internal
sub-command via a top-level argv handler installed at module-load time,
so the dev's command tree never sees those argv tokens. Either way,
**no boilerplate or env-var dance in the dev's file**.

`bun add @bastani/atomic-sdk` is sufficient on its own; the user-facing
`@bastani/atomic` CLI is **not** a peer requirement. Pass
`pathToAtomicExecutable` to `runWorkflow` only if you want the SDK to
route through a separately installed atomic binary instead of the
auto-detected default (e.g. for a custom build or a version pin).

```ts
// src/claude-worker.ts — single workflow with a small Commander entrypoint
import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic-sdk/workflows";
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
} from "@bastani/atomic-sdk/workflows";
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

// To route self-exec through a globally installed atomic binary instead
// of the SDK's auto-detected default (bundled dispatcher in `bun run`,
// `process.execPath` in compiled binaries), set `pathToAtomicExecutable`
// explicitly. Most callers should leave it unset and let the SDK
// auto-detect.
await runWorkflow({
  workflow,
  inputs,
  pathToAtomicExecutable: "atomic", // bare names PATH-resolve at exec time
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
field types (`string` / `text` / `enum` / `integer`), validation rules, picker
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

To launch the interactive picker, mount the `WorkflowPickerPanel` component:

```ts
import { WorkflowPickerPanel } from "@bastani/atomic-sdk/workflows/components";

const panel = await WorkflowPickerPanel.create({ agent: "claude", registry });
const result = await panel.waitForSelection();
panel.destroy();
if (result) {
  await runWorkflow({ workflow: result.workflow, inputs: result.inputs });
}
```

**No boilerplate in the dev's file.** In `bun run` mode the SDK re-execs its own internal orchestrator entry script (bundled inside `@bastani/atomic-sdk`); in `bun build --compile`d hosts it re-execs the consumer's own binary, but the SDK's `@bastani/atomic-sdk/workflows` barrel intercepts the internal sub-command via a top-level argv handler at module-load time, so the dev's command tree never sees those argv tokens. No env-var dance, no manual `handleSelfDispatch`-style entry-point hook, and no peer dependency on the user-facing `@bastani/atomic` CLI package.

**Atomic builtins** — workflows shipped inside `@bastani/atomic-sdk`, registered by atomic's internal `createBuiltinRegistry()`:

```bash
atomic workflow -n <name> -a <agent> [inputs...]
```

| Surface                | Command                                                                          | When                                                                           |
| ---------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Named, with prompt     | `… -n hello -a claude "fix the bug"`                                             | Requires workflow to declare a `prompt` input                                  |
| Named, structured      | `… -n gen-spec -a claude --research_doc=notes.md`                                | Structured inputs via `--<field>` flags                                        |
| Interactive picker     | `atomic workflow -a claude`                                                      | Discovery — fuzzy list + form; this is the intentional no-`-n` path            |
| List (atomic builtins) | `atomic workflow list`, `atomic workflow list -a <agent>`                        | Browse registered builtins + custom workflows, optionally filtered             |
| Reload custom workflows | `atomic workflow refresh [--format json\|text]`                                  | Re-spawn metadata loaders after editing `.atomic/settings.json` or a workflow file. Auto-defaults to JSON inside an atomic chat session so the model can ingest broken-entry diagnostics directly. |
| List (user cli)        | Iterate `listWorkflows(registry)` and add a `list` Commander subcommand yourself | No built-in `--list` flag                                                      |
| List (single-workflow) | Not applicable — the file *is* the workflow                                      |
| Inspect inputs         | `atomic workflow inputs <name> -a claude`                                        | Print input schema as JSON                                                     |
| Status (one or all)    | `atomic workflow status [<session-id>]`                                          | Query state — `in_progress`, `error`, `completed`, `needs_review`, `awaiting_input` |
| Read run/stage on disk | `atomic workflow read --sessionId <id> [--stageId <name>]`                       | Print path under `~/.atomic/sessions/<runId>/` for the run dir or a single stage. The model can then `Read` `messages.json` (raw `s.save()` output), `inbox.md` (rendered transcript), or `metadata.json` directly. Auto-defaults to JSON inside an atomic chat session. |
| Kill non-interactively | `atomic session kill <id> -y`                                                    | Tear down without confirmation prompt — `-y` is mandatory for agents           |
| Detached (background)  | `… -d` / `… --detach`                                                            | Runs without attaching; reattach with `atomic workflow session connect <name>` |

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

| Workflow Concept                             | Programmatic Pattern                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent session (send prompt, get response)    | `ctx.stage({ name }, {}, {}, async (s) => { /* use s.client, s.session */ })` — **must** include an LLM call (Rule 9)                                                                 |
| Background (headless) session                | `ctx.stage({ name, headless: true }, {}, {}, async (s) => { /* same API */ })` — invisible in graph, tracked by background counter                                                    |
| Sequential execution                         | `await ctx.stage(...)` followed by `await ctx.stage(...)`                                                                                                                             |
| Parallel execution                           | `Promise.all([ctx.stage(...), ctx.stage(...)])`                                                                                                                                       |
| Parallel background tasks                    | `Promise.all([ctx.stage({ name: "a", headless: true }, ...), ctx.stage({ name: "b", headless: true }, ...)])`                                                                         |
| Conditional branching                        | `if (...) { await ctx.stage({ name: "fix" }, {}, {}, ...) }`                                                                                                                          |
| Bounded loops with visible graph nodes       | `for (let i = 1; i <= N; i++) { await ctx.stage({ name: \`step-\${i}\` }, {}, {}, ...) }`                                                                                             |
| Return data from session                     | `const h = await ctx.stage(opts, {}, {}, async (s) => { return value; }); h.result`                                                                                                   |
| Data flow between sessions                   | `s.save()` to persist → `s.transcript(handle)` or `s.transcript("name")` to retrieve                                                                                                  |
| Pure deterministic computation (no LLM call) | Plain TypeScript at the top level of `.run()`. **Never** a standalone stage — see Rule 9 and F22.                                                                                     |
| Deterministic work tied to an LLM call       | Inside the same stage callback, before/after the query. E.g. `s.session.query(...)` → parse → validate → `s.save(parsed)`.                                                            |
| Subagent orchestration                       | Claude: `--agent` via `chatFlags` (interactive) or `agent` SDK option (headless); Copilot: `{ agent: "name" }` in sessionOpts; OpenCode: `agent` param in `s.client.session.prompt()` |
| Per-session configuration                    | Pass `clientOpts` (2nd arg) and `sessionOpts` (3rd arg) to `ctx.stage()`                                                                                                              |
| Per-session permission posture (autonomous)  | Claude: `chatFlags: ["--dangerously-skip-permissions"]` (interactive) or `permissionMode: "bypassPermissions"` on `s.session.query()` (headless). Copilot: `onPermissionRequest: approveAll` (default — auto-applied). OpenCode: pass `permission: [{ permission: "*", pattern: "*", action: "allow" }]` in `sessionOpts` on **every stage** so the posture is visible in the workflow source, not buried in runtime defaults. See `references/session-config.md` §"OpenCode session permission ruleset". |

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

| Question                                                 | Maps to                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What are the distinct **LLM interactions**?              | Each LLM conversation → one `ctx.stage()` call (Rule 9)                                                                                                       |
| Can any LLM calls run in parallel?                       | `Promise.all([ctx.stage(...), ...])`                                                                                                                          |
| Should any parallel LLM calls run in the background?     | `ctx.stage({ name, headless: true }, ...)` — invisible in graph, ideal for data-gathering                                                                     |
| Does any step need **pure deterministic code** (no LLM)? | Plain TypeScript at the top of `.run()` — **not** a dedicated stage. Bundle it inside the nearest stage callback if it's directly tied to that stage's query. |
| Do any steps need to repeat?                             | `for`/`while` loop with `ctx.stage()` inside                                                                                                                  |
| Are there conditional paths?                             | `if`/`else` wrapping `ctx.stage()` calls                                                                                                                      |
| What data flows between steps?                           | `s.save()` → `s.transcript(handle)` / `s.getMessages(handle)`                                                                                                 |
| Does the workflow need user input?                       | SDK-specific user input APIs (see `references/user-input.md`)                                                                                                 |
| Do any steps need a specific model?                      | SDK-specific session config (see `references/session-config.md`)                                                                                              |

Then walk the **Design Advisory Skills** table above (§"Design Advisory
Skills") — for each row whose trigger applies to your workflow, pull that
skill in *before* writing code. Catching architectural and prompt-quality
issues at design time is far cheaper than catching them in the first failed
end-to-end run.

### 2. Choose the Target Agent

Pass the agent as a runtime argument to `.for()` on the builder — this
narrows all context types and gives correct `s.client`/`s.session` types.
Call `.for()` **before** `.run()`:

| Agent    | Builder Chain                           | Primary Session API                                                                                                                                                               |
| -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `defineWorkflow({...}).for("claude")`   | `s.session.query(prompt)` — sends prompt to the Claude TUI pane                                                                                                                   |
| Copilot  | `defineWorkflow({...}).for("copilot")`  | `s.session.send({ prompt })` — the runtime wraps `send` to block until `session.idle` with no timeout (see `failure-modes.md` §F10); do not use `sendAndWait` in Atomic workflows |
| OpenCode | `defineWorkflow({...}).for("opencode")` | `s.client.session.prompt({ sessionID: s.session.id, parts: [...] })`                                                                                                              |

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

**Reference implementations** — two categories live in-repo, browsable at <https://github.com/flora131/atomic/tree/main/examples>:

- **Builtins** (`packages/atomic-sdk/src/workflows/builtin/`) — production patterns,
  registered via `createBuiltinRegistry()` inside the `atomic` CLI:
  - `ralph` — iterative plan → orchestrate → review → debug loop.
  - `deep-research-codebase` — scout → parallel explorer fan-out → aggregator.
  - `open-claude-design` — design-system init flow.
- **User-app examples** ([`examples/<name>/`](https://github.com/flora131/atomic/tree/main/examples)) — minimal runnable Mode-2 (dev-owned-CLI) apps
  you can copy-paste as a starting point. Each example directory contains
  `claude/index.ts`, `copilot/index.ts`, `opencode/index.ts`, and one
  `<agent>-worker.ts` entrypoint per agent — each a small Commander
  entrypoint that calls `runWorkflow({ workflow, inputs })`. Run with
  `bun run examples/<name>/<agent>-worker.ts --<field>=<value>` (or a
  positional prompt string if the worker declares `[prompt...]`).
  Covers: `hello-world`, `sequential-describe-summarize`,
  `parallel-hello-world`, `headless-test`, `hil-favorite-color`,
  `hil-favorite-color-headless`, `structured-output-demo`,
  `reviewer-tool-test` (copilot only), `review-fix-loop`,
  `multi-workflow`, `commander-embed`, `pane-navigation` (driver CLI for
  the navigation primitives), and `custom-workflow-bunx` (Mode-1 entry
  shape — single file ending in `await hostLocalWorkflows([wf])`,
  registered as a `workflows.<alias>` entry in `settings.json`).

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
  at <https://github.com/flora131/atomic/tree/main/examples>, and atomic
  builtins + custom workflows (`atomic workflow -n … -a …`).
- Why atomic builtins use `-n` + `-a` and how to add `-d` for background runs.
- Why you must list workflows first — and why `atomic workflow refresh`
  is the right verification step right after editing `settings.json` or
  a Mode-1 workflow file.
- How to handle missing workflows (offer to author, not fabricate).
- Using `atomic workflow inputs <name> -a <agent>` to discover the schema
  and drive AskUserQuestion.
- The six-step invocation recipe.
- Monitoring with `atomic workflow status` — and why `needs_review` must be
  surfaced immediately.
- Tearing down with `atomic session kill -y` (the `-y` is mandatory).
- Worked examples for "workflow exists" and "workflow doesn't exist".
