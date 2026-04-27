# Workflow Authors: Getting Started

This guide covers the basics of creating workflows with the `defineWorkflow().run().compile()` API and wiring them into a composition root.

## Composition root

A workflow's composition root is the TypeScript file a user runs via `bun`. The SDK exposes pure primitives — there's no opinionated wrapper. Compose them into whatever CLI library you prefer (Commander, citty, yargs, or none at all) and call `runWorkflow({ workflow, inputs })` from the action.

### Single workflow

```ts
// src/claude-worker.ts
import { Command } from "@commander-js/extra-typings";
import { getInputSchema, runWorkflow } from "@bastani/atomic/workflows";
import workflow from "./workflows/deploy/claude.ts";

const program = new Command();
for (const input of getInputSchema(workflow)) {
  program.option(`--${input.name} <value>`, input.description ?? "");
}
program.action(async (rawOpts) => {
  await runWorkflow({ workflow, inputs: rawOpts as Record<string, string> });
});
await program.parseAsync();
```

Run it:

```bash
bun run src/claude-worker.ts --prompt "your task"
bun run src/claude-worker.ts --field=value
```

### Multiple workflows

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
import claudeFlow from "./workflows/my-flow/claude.ts";
import copilotFlow from "./workflows/my-flow/copilot.ts";

const registry = createRegistry().register(claudeFlow).register(copilotFlow);
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

### Programmatic invocation (no CLI)

```ts
import { runWorkflow } from "@bastani/atomic/workflows";
import workflow from "./workflows/deploy/claude.ts";

const { id, tmuxSessionName } = await runWorkflow({
  workflow,
  inputs: { prompt: "task" },
  detach: true,
});
```

### Detach and monitor

`runWorkflow({ ..., detach: true })` returns immediately after the tmux session is created. Combine with `getSessionStatus(tmuxSessionName)`, `attachSession(id)`, and `stopSession(id)` from `@bastani/atomic/workflows` to build your own monitoring loop, or use the global `atomic session …` / `atomic workflow status` commands.

### Interactive picker

The same picker `atomic workflow -a claude` opens is exposed as a component:

```ts
import { WorkflowPickerPanel } from "@bastani/atomic/workflows/components";

const panel = await WorkflowPickerPanel.create({ agent: "claude", registry });
const result = await panel.waitForSelection();
panel.destroy();
if (result) {
  await runWorkflow({ workflow: result.workflow, inputs: result.inputs });
}
```

## Quick-start example

Use `defineWorkflow({...}).for("agent").run(callback).compile()` to define your workflow. Pass the agent as a runtime string argument to `.for()` — this narrows the context types for everything downstream. Inside the `.run()` callback, use `ctx.stage()` to spawn agent sessions dynamically. Each session gets its own tmux window and graph node. Use native TypeScript control flow (`for`, `if`, `Promise.all()`) for orchestration.

The runtime manages the full session lifecycle automatically — it creates the client, creates the session, runs your callback, then cleans up. You never need to manually disconnect or stop anything.

### Claude

```ts
// src/workflows/my-workflow/claude.ts
import { defineWorkflow, extractAssistantText } from "@bastani/atomic/workflows";

export default defineWorkflow({
    name: "my-workflow",
    source: import.meta.path,
    description: "A two-session pipeline",
    inputs: [
      { name: "prompt", type: "text", required: true, description: "task to perform" },
    ],
  })
  .for("claude")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    const describe = await ctx.stage(
      { name: "describe", description: "Ask Claude to describe the project" },
      {},
      {},
      async (s) => {
        await s.session.query(prompt);
        s.save(s.sessionId);
      },
    );

    await ctx.stage(
      { name: "summarize", description: "Summarize the previous session's output" },
      {},
      {},
      async (s) => {
        const research = await s.transcript(describe);
        await s.session.query(
          `Read ${research.path} and summarize it in 2-3 bullet points.`,
        );
        s.save(s.sessionId);
      },
    );
  })
  .compile();
```

### Copilot

```ts
// src/workflows/my-workflow/copilot.ts
import { defineWorkflow } from "@bastani/atomic/workflows";

export default defineWorkflow({
    name: "my-workflow",
    source: import.meta.path,
    description: "A two-session pipeline",
    inputs: [
      { name: "prompt", type: "text", required: true, description: "task to perform" },
    ],
  })
  .for("copilot")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    const describe = await ctx.stage(
      { name: "describe", description: "Ask the agent to describe the project" },
      {},
      {},
      async (s) => {
        await s.session.send({ prompt });
        s.save(await s.session.getMessages());
      },
    );

    await ctx.stage(
      { name: "summarize", description: "Summarize the previous session's output" },
      {},
      {},
      async (s) => {
        const research = await s.transcript(describe);
        await s.session.send({
          prompt: `Summarize the following in 2-3 bullet points:\n\n${research.content}`,
        });
        s.save(await s.session.getMessages());
      },
    );
  })
  .compile();
```

### OpenCode

```ts
// src/workflows/my-workflow/opencode.ts
import { defineWorkflow } from "@bastani/atomic/workflows";

export default defineWorkflow({
    name: "my-workflow",
    source: import.meta.path,
    description: "A two-session pipeline",
    inputs: [
      { name: "prompt", type: "text", required: true, description: "task to perform" },
    ],
  })
  .for("opencode")
  .run(async (ctx) => {
    const prompt = ctx.inputs.prompt ?? "";

    const describe = await ctx.stage(
      { name: "describe", description: "Ask the agent to describe the project" },
      {},
      { title: "describe" },
      async (s) => {
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [{ type: "text", text: prompt }],
        });
        s.save(result.data!);
      },
    );

    await ctx.stage(
      { name: "summarize", description: "Summarize the previous session's output" },
      {},
      { title: "summarize" },
      async (s) => {
        const research = await s.transcript(describe);
        const result = await s.client.session.prompt({
          sessionID: s.session.id,
          parts: [{ type: "text", text: `Summarize the following in 2-3 bullet points:\n\n${research.content}` }],
        });
        s.save(result.data!);
      },
    );
  })
  .compile();
```

Reading top-to-bottom: `describe → summarize`. Each session spawns a graph node and tmux window.

## Native TypeScript control flow

Sessions are spawned dynamically, so you can use loops, conditionals, and `Promise.all()`:

```ts
// Parallel sessions
const [a, b] = await Promise.all([
  ctx.stage({ name: "task-a" }, {}, {}, async (s) => { /* ... */ }),
  ctx.stage({ name: "task-b" }, {}, {}, async (s) => { /* ... */ }),
]);

// Loop with dynamic sessions
for (let i = 1; i <= maxIterations; i++) {
  const result = await ctx.stage({ name: `step-${i}` }, {}, {}, async (s) => {
    // ... do work ...
    return someValue; // available as result.result
  });
  if (result.result === "done") break;
}

// Conditional sessions
if (needsReview) {
  await ctx.stage({ name: "review" }, {}, {}, async (s) => { /* ... */ });
}
```

## Headless (background) stages

Set `headless: true` in the stage options to run the provider SDK
in-process instead of spawning a tmux window — invisible in the graph,
identical callback API.

```ts
const result = await ctx.stage(
  { name: "background-task", headless: true },
  {}, {},
  async (s) => {
    const result = await s.session.query("Analyze the codebase.");
    s.save(s.sessionId);
    return extractAssistantText(result, 0);
  },
);
```

For per-provider mechanics, the canonical fan-out pattern (visible seed →
parallel headless → visible merge), and topology semantics, see
`control-flow.md` §"Headless stages: transparent to graph topology" and the
per-SDK "Headless mode" sections in `agent-sessions.md`. Failure visibility
caveats live in `failure-modes.md` §F15.

## SDK exports

The `@bastani/atomic/workflows` package exports the workflow authoring and composition primitives. For native SDK types and utilities, install and import from the provider packages directly.

**Composition root:**
- `createRegistry()` — factory for an empty, immutable, chainable registry. Chain `.register(wf)` to add workflow definitions. Each call returns a new registry. Throws on duplicate `${agent}/${name}` key.
- `runWorkflow({ workflow, inputs })` — the workflow-CLI factory. `target` accepts a compiled `WorkflowDefinition`, an array of them, or a `Registry` — the cli normalizes internally. `options` supports `inputs?`, `entry?` (path to re-exec on `--detach`; defaults to `process.argv[1]`), and `extend?` (attach sibling commands to the standalone `run()` CLI).
- `createRegistry()` — factory for an immutable, chainable registry. Only needed when you want dynamic/programmatic composition; pass workflows directly to `runWorkflow` otherwise.
- `Registry` — type for the registry object (see `registry-and-validation.md`)
- `WorkflowCli` — exposes `run(options?)`. `run()` options: `{ name?, agent?, inputs?, argv?: string[] | false, detach? }`.
- `CreateWorkflowCliOptions`, `ArgvMode` — options types

**Builder:**
- `defineWorkflow` — entry point; returns a chainable `WorkflowBuilder`. Use `.for("agent")` on the builder to narrow types to a specific provider.
- `WorkflowBuilder` — the builder class (rarely needed directly)

**Types** (import with `import type`):
- `AgentType` — `"copilot" | "opencode" | "claude"`
- `Transcript` — `{ path: string, content: string }` from `ctx.transcript()`
- `SavedMessage` — union of provider-specific message types
- `SaveTranscript` — overloaded save function type
- `SessionContext` — the context object passed to `ctx.stage()` callbacks
- `SessionHandle<T>` — returned by `ctx.stage()`, carries `{ name, id, result }`
- `SessionRunOptions` — `{ name, description?, headless? }` for `ctx.stage()` first argument
- `StageClientOptions<A>` — provider-specific client init options for `ctx.stage()` second argument
- `StageSessionOptions<A>` — provider-specific session create options for `ctx.stage()` third argument
- `ProviderClient<A>` — the `s.client` type, resolved by agent type
- `ProviderSession<A>` — the `s.session` type, resolved by agent type
- `ClaudeSessionWrapper` — Atomic wrapper for Claude sessions (exposes `s.session.query()`, which returns `SessionMessage[]`)
- `SessionRef` — `string | SessionHandle<unknown>` for transcript/message lookups
- `WorkflowContext` — top-level context passed to `.run()` callback
- `WorkflowOptions` — `{ name, description? }` workflow metadata
- `WorkflowDefinition` — sealed output of `.compile()`

**Response utilities:**
- `extractAssistantText(messages, afterIndex)` — extract plain text from the `SessionMessage[]` returned by `s.session.query()` for Claude; use `extractAssistantText(result, 0)` to get the full assistant response text

**Validation helpers:**
- `validateClaudeWorkflow` — static validation for Claude workflow source files; warns on direct `createClaudeSession` or `claudeQuery` usage
- `validateCopilotWorkflow` — static validation for Copilot workflow source files; warns on manual `new CopilotClient` or `client.createSession()` usage
- `validateOpenCodeWorkflow` — static validation for OpenCode workflow source files; warns on manual `createOpencodeClient()` or `client.session.create()` usage

**Native SDK dependencies:**

The Atomic runtime provides `s.client` and `s.session` with types resolved from the native SDKs. If you need to name those types in your own code, or use SDK utilities and advanced APIs, import them directly from the provider packages:

| Provider | Package | Key imports |
|----------|---------|-------------|
| Copilot | `@github/copilot-sdk` | `SessionEvent`, `CopilotClient`, `CopilotSession`, `approveAll`, `defineTool` |
| Claude | `@anthropic-ai/claude-agent-sdk` | `SessionMessage`, `query` |
| OpenCode | `@opencode-ai/sdk/v2` | `SessionPromptResponse`, `OpencodeClient`, `Session` |

## `SessionContext` reference

| Field | Type | Description |
|-------|------|-------------|
| `client` | `ProviderClient<A>` | Pre-created SDK client (auto-managed by runtime) |
| `session` | `ProviderSession<A>` | Pre-created provider session (auto-managed by runtime) |
| `inputs` | `{ [K in N]?: string }` | Typed inputs for this run — only declared field names are valid keys. Accessing an undeclared field is a compile-time error. See `workflow-inputs.md`. |
| `agent` | `AgentType` | Which agent is running |
| `transcript(ref)` | `(ref: SessionRef) => Promise<Transcript>` | Get prior session's transcript as `{ path, content }` |
| `getMessages(ref)` | `(ref: SessionRef) => Promise<SavedMessage[]>` | Get prior session's raw native messages |
| `save` | `SaveTranscript` | Save this session's output for downstream sessions |
| `sessionDir` | `string` | Path to session storage directory |
| `paneId` | `string` | tmux pane ID (or `headless-<name>-<id>` for headless stages) |
| `sessionId` | `string` | Session UUID |
| `stage(opts, clientOpts, sessionOpts, fn)` | `<T>(...) => Promise<SessionHandle<T>>` | Spawn a nested sub-session (child of this session in the graph) |

## Reference files

The full table of references with load triggers lives in SKILL.md
§"Reference Files". Pull `failure-modes.md` before shipping any
multi-session workflow, and `agent-sessions.md` whenever writing SDK calls.

## Builtin reference implementations

The SDK ships two builtin workflows registered via `createBuiltinRegistry()` (internal to the `atomic` CLI). They demonstrate production patterns for all three SDKs:

- **`ralph`** (`src/sdk/workflows/builtin/ralph/`) — iterative plan → orchestrate → review → debug loop with consecutive clean-pass detection, shared helpers for prompts/parsing/git, and cross-SDK adaptation
- **`deep-research-codebase`** (`src/sdk/workflows/builtin/deep-research-codebase/`) — deterministic codebase scout → LOC-based heuristic explorer partitioning → parallel explorers → aggregator with file-based handoffs and context-aware prompt engineering

Both include `helpers/` directories with SDK-agnostic logic (prompt builders, parsers, heuristics) and per-agent `index.ts` files showing how the same workflow topology adapts to Claude, Copilot, and OpenCode. Their composition root pattern (`runWorkflow(via runWorkflow primitives).run()`) is the same pattern user apps follow.

## Type safety

The SDK avoids `any` and uses `unknown` only at well-defined boundaries (e.g., `SessionRef = string | SessionHandle<unknown>` for handle-erased lookups). `SessionContext` fields are precisely typed, and native provider types may appear inside Atomic generic aliases and runtime values — if you need to name those types in your own code, import them from the provider SDK directly. Use `import type` for type-only imports. Use `.for("agent")` to narrow `s.client` and `s.session` to the correct provider types. Declare `inputs` inline so TypeScript enforces typed access on `ctx.inputs`.
