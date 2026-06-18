<h1 align="center">Atomic Workflows</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source Atomic workflow extension: install it, author workflows in TypeScript, run them from chat.
</p>

<p align="center">
  <a href="#authoring-api">Authoring API</a>
  &nbsp;·&nbsp;
  <a href="#surfaces">Surfaces</a>
  &nbsp;·&nbsp;
  <a href="#builtin-workflows">Builtins</a>
  &nbsp;·&nbsp;
</p>


### Custom workflow directories

Adding workflow files under `.atomic/workflows/` (project scope) or `~/.atomic/agent/workflows/` (user scope) makes them discoverable automatically. To register additional discovery paths, add a workflow extension config file at `.atomic/extensions/workflow/config.json` for a project or `~/.atomic/agent/extensions/workflow/config.json` for your user account:

```json
{
  "workflows": {
    "team": { "path": "/shared/team/workflows" }
  }
}
```

### Workflow lifecycle notifications

Workflow lifecycle notices are enabled by default. They send steer prompts into the main chat/model context when a run completes or fails. Awaiting-input prompts are tracked for dedupe/restore, but they do not wake the main chat agent. Configure lifecycle tracking in the same extension config file:

```json
{
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "awaiting_input"]
  }
}
```

Set `enabled` to `false` to disable all lifecycle notices, or narrow `notifyOn` to a non-empty list of selected events. Completion and failure lifecycle notices are emitted for top-level workflow runs, use steer delivery, and wake an idle model so the lifecycle update enters the model context when it happens. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. Awaiting-input states are tracked for dedupe/restore, but workflows do not enqueue main-chat `/workflow connect` cards for them; prompt state remains visible through workflow status/connect surfaces, avoiding stale actionable cards if a prompt resolves while the main chat is streaming.

When a stage human-in-the-loop prompt is answered from the workflow TUI/stage chat, workflows also emits a separate display-only `workflows:hil-answer-notice` custom message. It records the answer for user-visible audit, but it does not wake the main agent, enter LLM context, or authorize answering later workflow prompts. Answers sent by the main-chat `workflow` tool do not emit this notice because the tool result already tells the main agent what happened.

---

## Authoring API

### Example 1 — Single task

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("summarize-pr")
  .description("Summarize a pull request in one task.")
  .input("pr_url", Type.String({ description: "URL of the pull request to summarize." }))
  .output("summary", Type.String({ description: "One-task summary of the pull request." }))
  .run(async (ctx) => {
    const summary = await ctx.task("summarize", {
      prompt: `Summarize the pull request at ${String(ctx.inputs.pr_url)} clearly and concisely.`,
    });
    return { summary: summary.text };
  })
  .compile();
```

### Example 2 — Parallel fan-out with `ctx.parallel`

Use `ctx.parallel` for independent specialist work. The aggregator receives the specialist outputs through typed task results instead of manual stage/session plumbing. The runtime snapshots the parent graph frontier when the fan-out starts, so every branch shares the same parents even when limited `concurrency` queues later branches or an earlier sibling fails with `failFast: false`.

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("parallel-research")
  .description("Scout → three parallel specialists → aggregator.")
  .input("topic", Type.String({ description: "Research topic." }))
  .output("summary", Type.String({ description: "Synthesized summary of the specialist reports." }))
  .run(async (ctx) => {
    const topic = ctx.inputs.topic;

    const reportPaths = {
      auth: ".atomic/workflows/runs/parallel-research/auth.md",
      db: ".atomic/workflows/runs/parallel-research/db.md",
      api: ".atomic/workflows/runs/parallel-research/api.md",
    } as const;

    await ctx.parallel([
      { name: "auth-specialist", task: `Research authentication patterns for: ${topic}`, output: reportPaths.auth, outputMode: "file-only" },
      { name: "db-specialist", task: `Research database layer for: ${topic}`, output: reportPaths.db, outputMode: "file-only" },
      { name: "api-specialist", task: `Research API surface for: ${topic}`, output: reportPaths.api, outputMode: "file-only" },
    ], { concurrency: 2, failFast: false });

    const summary = await ctx.task("aggregator", {
      prompt: [
        "Synthesize the specialist reports.",
        `Auth report: ${reportPaths.auth}`,
        `Database report: ${reportPaths.db}`,
        `API report: ${reportPaths.api}`,
        "Read the files at the paths above incrementally and only expand sections needed for the synthesis.",
      ].join("\n"),
      reads: Object.values(reportPaths),
    });
    return { summary: summary.text };
  })
  .compile();
```

### Example 3 — Human-in-the-loop (HIL)

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("review-and-merge")
  .description("Plan a change, ask for human approval, then execute.")
  .input("task", Type.String({ description: "What to implement." }))
  .output("status", Type.Optional(Type.String({ description: "Set to \"cancelled\" when the human rejects the plan." })))
  .output("result", Type.Optional(Type.String({ description: "Implementation result when the plan is approved." })))
  .run(async (ctx) => {
    const planPath = ".atomic/workflows/runs/review-and-merge/plan.md";
    const plan = await ctx.task("planner", {
      prompt: `Create a concise implementation plan for: ${String(ctx.inputs.task)}`,
      output: planPath,
    });

    const approved = await ctx.ui.confirm(`Proceed with this plan?\n\n${plan.text}`);
    if (!approved) return { status: "cancelled" };

    const result = await ctx.task("implementer", {
      prompt: [
        `Plan artifact: ${planPath}`,
        `Read the file at ${planPath} incrementally, then execute it exactly.`,
      ].join("\n"),
      reads: [planPath],
    });
    return { result: result.text };
  })
  .compile();
```

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` at the point where the workflow actually needs a decision. No builder-level declaration is required or supported.

`ctx.ui.custom<T>(factory, options?)` mounts an arbitrary focused TUI component in the attached workflow graph/stage UI and resolves with the value passed to `done(value)`. The factory uses the same real TUI/theme/keybinding/component types as Atomic extension `ctx.ui.custom`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` (do not include secrets) when the widget's semantics can change without the callsite changing; label text is not part of replay identity. Custom widget prompts require an interactive workflow graph; they are not answerable through non-TUI `workflow send` in iteration 1. Inline graph rendering is supported; `overlay: true` is rejected clearly because nested workflow graph overlays are not safely supported yet.

### Example 4 — Compose workflows

Prefer regular TypeScript module imports for reusable child workflows: import the compiled workflow definition, then pass it directly to `ctx.workflow(workflowDefinition, options)`.

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";
import goal from "@bastani/workflows/builtin/goal";
import sharedResearch from "./shared-research.js";

export default defineWorkflow("research-and-synthesize")
  .input("topic", Type.String())
  .output("final", Type.String({ description: "Synthesis of the child research and implementation." }))
  .run(async (ctx) => {
    const child = await ctx.workflow(sharedResearch, {
      inputs: { topic: ctx.inputs.topic },
    });

    const implementation = await ctx.workflow(goal, {
      inputs: { objective: `Implement improvements based on: ${String(child.outputs.summary)}` },
    });

    const final = await ctx.task("synthesize", {
      prompt: `Synthesize this research and implementation:\n\n${String(child.outputs.summary)}\n\n${String(implementation.outputs.result)}`,
    });
    return { final: final.text };
  })
  .compile();
```

The child executes as a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default, but user-facing status and graph views flatten it into the parent run. In practice it should feel like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported children appear in one expanded parent graph, while implementation-owned child run ids stay hidden from top-level `/workflow status` lists. The child still has a run id internally so the graph can attach to, pause, interrupt, resume, or kill live child stages correctly. Inputs are strictly validated against the child workflow before it starts: unknown keys, missing required values, type mismatches, and invalid `select` choices fail before the child body runs. The parent receives the child's declared `.output(...)` outputs on `child.outputs` after those outputs pass their declared runtime type checks.

For workflows intended to be called as children, declare `.output(...)` for every non-default field a parent should rely on. `.output(...)` is only the schema/contract: use normal TypeScript in `.run()` to gather values from any stage/task/child workflow and return those keys.

**Return convention:** child outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.summary`, the child workflow's `.run()` must both declare `.output("summary", schema)` and return `{ summary }`. `result` is not special and is never added for you: to expose `result`, declare `.output("result", schema)` and return `{ result }` like any other output. Returning a key that is not declared with `.output(...)` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", Type....) or remove it from the .run() return` (the child-call variant reports `... child "<alias>" returned undeclared output "<key>" from "<childName>"`).

A reusable child module can simply default-export a compiled workflow:

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("shared-research")
  .input("topic", Type.String())
  .output("summary", Type.String())
  .run(async (ctx) => {
    const report = await ctx.task("research", {
      prompt: `Research: ${String(ctx.inputs.topic)}`,
    });
    return { summary: report.text };
  })
  .compile();
```

Builtin workflows are also callable as modules for reuse:

```typescript
import { deepResearchCodebase, goal, openClaudeDesign, ralph } from "@bastani/workflows/builtin";
import goalWorkflow from "@bastani/workflows/builtin/goal";
import openClaudeDesignWorkflow from "@bastani/workflows/builtin/open-claude-design";
```

Only compiled workflow definitions can be passed to `ctx.workflow(...)`; registry names, strings, and path objects are intentionally not supported for child workflow calls. Missing or invalid module imports fail when the workflow file itself is loaded. A parent receives the child's declared `.output(...)` outputs from the child `.run()` return object. Missing required outputs, schema type mismatches, returning an undeclared output, and non-JSON-serializable returned child values fail the child call before the parent continues.

### Reusable Git worktrees

Use `gitWorktreeDir` when a workflow should run in a reusable Git worktree instead of the invoking checkout. The executor creates the worktree if it is missing, reuses it when it already exists as a same-repository worktree root, defaults workflow `ctx.cwd` to the matching path inside that worktree for `worktreeFromInputs`, and defaults stage/task `cwd` to that worktree path.

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("safe-implementation")
  .description("Run implementation stages in a reusable worktree.")
  .input("task", Type.String())
  .input("worktree", Type.String({ default: "" }))
  .input("base_branch", Type.String({ default: "origin/main" }))
  .worktreeFromInputs({
    gitWorktreeDir: "worktree",
    baseBranch: "base_branch",
  })
  .output("result", Type.String({ description: "Implementation result text." }))
  .run(async (ctx) => {
    const result = await ctx.task("implement", {
      task: String(ctx.inputs.task),
      // No cwd needed: when `worktree` is non-empty, this task runs from the
      // corresponding cwd inside that reusable Git worktree.
    });
    return { result: result.text };
  })
  .compile();
```

You can also pass worktree options per stage/task or as shared chain/parallel defaults:

```typescript
await ctx.stage("review", {
  gitWorktreeDir: "../review-worktree",
  baseBranch: "origin/main",
}).prompt("Review the current changes.");

await ctx.parallel([
  { name: "security", task: "Security review" },
  { name: "runtime", task: "Runtime review" },
], {
  gitWorktreeDir: "../review-worktree",
  baseBranch: "origin/main",
  failFast: false,
});
```

Worktree semantics:

- `gitWorktreeDir` must be used from inside a Git repository. Relative paths resolve from the logical invoking repository root; absolute paths are used as-is.
- If the requested path exists, it must be an actual Git worktree/checkout root belonging to the invoking repository. Existing subdirectories are rejected so writes do not silently land in the main checkout.
- If the path is missing, the parent directory is created and Git runs `git worktree add --detach <path> <baseBranch>`. `baseBranch` defaults to `HEAD` when omitted.
- The default execution cwd preserves the caller's repo-relative cwd inside the worktree. For example, invoking a workflow from `repo/packages/api` with `gitWorktreeDir=../repo-wt` uses `../repo-wt/packages/api` for workflow `ctx.cwd` and stage/task execution.
- Symlinked repo/worktree paths preserve their logical spelling in the default cwd, matching Codex-style worktree behavior.
- Explicit `cwd` still wins. Relative `cwd` values are resolved against the worktree default cwd; absolute `cwd` values are used as provided.

`worktree: true` is different: it creates temporary isolated worktrees for direct task/parallel/chain execution and cleans them up afterward. It is mutually exclusive with `gitWorktreeDir`, which is intended for named/reusable worktrees that remain available across retries.

For advanced integrations, the SDK also exports `setupGitWorktree(options)`, which returns `{ worktreeRoot, cwd, repositoryRoot, created }` and uses the same validation/path behavior as the executor.

### Structured stage results

`structured_output` is opt-in for workflow items. Add `schema` to `ctx.stage`, `ctx.task`, `ctx.chain` items, or `ctx.parallel` items when the stage must finish with machine-readable JSON:

```typescript
const Decision = Type.Object({
  approved: Type.Boolean(),
  findings: Type.Array(Type.String()),
}, { additionalProperties: false });

const decision = await ctx.stage("review-gate", { schema: Decision }).prompt(
  "Review the artifact and return the decision.",
);
// decision.approved is typed from the schema.
```

Atomic registers the canonical `structured_output` tool only for schema-enabled items and automatically adds it to explicit `tools` allowlists. The schema is used directly as the tool argument contract. A schema-backed `StageContext` supports one `prompt()` call because the final-answer tool is a single result contract; create another `ctx.stage(..., { schema })` for another structured prompt. If a turn completes without calling `structured_output`, or the tool call fails schema validation, Atomic sends up to three corrective follow-up prompts that include the exact contract/validation error before failing the item. `ctx.task`/`ctx.chain`/`ctx.parallel` results expose the captured value as `result.structured` and keep `result.text` as formatted JSON for handoffs.

`subagent` is available as a default workflow-stage tool with the same default two-hop nesting budget as main chat: a stage can launch a subagent, and that child can launch one nested subagent before the guard blocks further delegation. `tools` allowlists apply to bundled extension tools as well as built-ins; if a stage sets `tools`, list every tool it should see. Workflow stages can explicitly list `subagent`, `web_search`, `fetch_content`, `intercom`, and other loaded extension tools, while `excludedTools` and `noTools: "all"` still win. Bundled `@bastani/subagents` agent definitions are available to the `subagent` tool in workflow stages, including workflows launched from a subagent child process.

### Model fallbacks

Stages and high-level task helpers can retry transient provider/model failures with an ordered `fallbackModels` list. The primary `model` is tried first, then each fallback, and finally the current Atomic-selected model when available. Fallbacks are only used for retryable model/provider failures such as rate limits, quota/auth/provider outages, unavailable models, network timeouts, and 5xx errors — ordinary tool, shell, validation, cancellation, and workflow-code failures are not retried.

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("fallback-review")
  .description("Review with a model fallback chain.")
  .input("topic", Type.String())
  .output("review", Type.String({ description: "Reviewer output text." }))
  .output("model", Type.Optional(Type.String({ description: "Model that produced the review." })))
  .output("attemptedModels", Type.Optional(Type.Array(Type.String(), { description: "Models tried, in fallback order." })))
  .output("modelAttempts", Type.Optional(Type.Array(Type.Unknown(), { description: "Per-attempt model fallback details." })))
  .run(async (ctx) => {
    const review = await ctx.task("reviewer", {
      prompt: `Review this topic: ${String(ctx.inputs.topic)}`,
      model: "anthropic/claude-sonnet-4",
      fallbackModels: ["openai/gpt-5-mini", "github-copilot/gpt-5-mini"],
    });

    return {
      review: review.text,
      model: review.model,
      attemptedModels: review.attemptedModels ? [...review.attemptedModels] : undefined,
      modelAttempts: review.modelAttempts ? [...review.modelAttempts] : undefined,
    };
  })
  .compile();
```

Direct helpers and workflow tool direct modes can set task-local fallbacks or a top-level default:

```typescript
await runParallel([
  { name: "runtime-review", task: "Review runtime changes", model: "anthropic/claude-sonnet-4" },
  { name: "quality-review", task: "Review quality risks", fallbackModels: ["openai/gpt-5-mini"] },
], {
  fallbackModels: ["github-copilot/gpt-5-mini"],
});
```

When pi exposes its model registry, workflow runs validate user-specified `model` / `fallbackModels` before starting model-backed work and report all unavailable or ambiguous IDs together. Bare model IDs are accepted only when they resolve uniquely or match the current provider; otherwise use `provider/model`. Fallback attempts may send the same prompt/context to a different provider, so choose fallbacks that fit your cost, privacy, and data-handling requirements.

### `createRegistry` — grouping workflows

```typescript
import { createRegistry, defineWorkflow } from "@bastani/workflows";

const alpha = defineWorkflow("alpha").run(async () => ({})).compile();
const beta  = defineWorkflow("beta").run(async () => ({})).compile();
const gamma = defineWorkflow("gamma").run(async () => ({})).compile();

const registry = createRegistry()
  .register(alpha)
  .register(beta)
  .merge(createRegistry().register(gamma));

registry.names();      // ["alpha", "beta", "gamma"]
registry.all();        // compiled workflow definitions
registry.get("alpha"); // compiled workflow definition | undefined
```

### Declaring inputs and outputs with TypeBox

Inputs and outputs are declared with [TypeBox](https://github.com/sinclairzx81/typebox) schemas. Import `Type` from `@bastani/workflows` (alongside `defineWorkflow`) and pass a schema to `.input(key, schema)` / `.output(key, schema)`. The builder infers precise static types for `ctx.inputs`, the `.run()` return, and `child.outputs` from those schemas, and the runtime validates against them with TypeBox `Value`.

**Prefer precise schemas.** A precise schema (`Type.Object({ topic: Type.String(), score: Type.Number() })`, `Type.Array(Type.String())`) gives consumers a precise `Static<>` type and makes runtime validation enforce the real shape. Reserve `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, and `Type.Object({}, { additionalProperties: true })` for genuinely dynamic data whose shape you cannot know ahead of time.

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

defineWorkflow("example")
  .input("prompt", Type.String({ description: "Required free-text input." }))   // required key -> ctx.inputs.prompt: string
  .input("ref", Type.Optional(Type.String()))                                    // optional key -> string | undefined
  .input("count", Type.Number({ default: 2 }))                                    // defaulted -> required key, ctx.inputs.count: number
  .input("flavor", Type.Union([Type.Literal("a"), Type.Literal("b")], { default: "a" })) // select
  .output("packet", Type.Object({ topic: Type.String(), score: Type.Number() })) // required object output
  .output("note", Type.Optional(Type.String()))                                   // optional output
  .run(async (ctx) => ({ packet: { topic: ctx.inputs.prompt, score: ctx.inputs.count } }))
  .compile();
```

`Static` and `TSchema` are also re-exported from `@bastani/workflows` for advanced typing.

### Input schema reference

| Schema                                                       | Picker kind | Notes                                            |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------ |
| `Type.String({ default?, description? })`                    | `text`      | Free-form string                                 |
| `Type.Number({ default?, description? })`                    | `number`    | Finite number                                    |
| `Type.Integer({ default?, description? })`                   | `integer`   | Integer                                          |
| `Type.Boolean({ default?, description? })`                   | `boolean`   | True/false toggle                                |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { default? })` | `select` | Enumerated string choices                        |
| `Type.Optional(schema)`                                      | —           | Makes the key optional (`T \| undefined`)        |

A required input is any schema that is neither `Type.Optional(...)` nor carries a `default` (a defaulted input is a required key at the type level but optional for the caller to provide). Input validation is strict for named workflow runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, values whose runtime type does not match the declared schema, and `select` values outside the declared literals. It does not coerce strings like `"3"` into numbers; pass JSON numbers (`count=3`) for `Type.Number()`. `.input(...)` narrows `ctx.inputs` for intellisense: required/defaulted strings are `string`, numbers are `number`, booleans are `boolean`, selects are the literal union, and `Type.Optional(...)` inputs include `undefined`.

### Output types

Declare outputs with `.output(key, schema)` when a workflow result should be part of its runtime contract, especially when another workflow will call it as a child. Lead with the most precise schema you can express — the loose rows at the bottom are last resorts for genuinely dynamic data.

| Schema                                              | Runtime value accepted                              |
| --------------------------------------------------- | --------------------------------------------------- |
| `Type.String()`                                     | string                                              |
| `Type.Number()`                                     | finite number (rejects `NaN`)                       |
| `Type.Integer()`                                    | integer                                             |
| `Type.Boolean()`                                    | boolean                                             |
| `Type.Union([Type.Literal(...)])`                   | one of the declared literal strings                 |
| `Type.Array(Type.String())`                         | array of the declared element type (use the real type) |
| `Type.Object({ topic: Type.String(), ... })`        | object matching the declared shape                  |
| `Type.Unsafe<T>(runtimeSchema)`                     | precise static `T`, lenient runtime (escape hatch)  |
| `Type.Array(Type.Unknown())`                        | any JSON array (last resort, dynamic only)          |
| `Type.Object({}, { additionalProperties: true })`   | any JSON object (last resort, dynamic only)         |
| `Type.Unknown()` / `Type.Any()`                     | any JSON-serializable value (last resort)           |

Wrap an output schema in `Type.Optional(...)` to make the key optional; an un-wrapped output schema is required. `.run()` must return a JSON-serializable object. Functions, symbols, `undefined` properties, `NaN`, infinite numbers, and non-plain objects (e.g. `Date`) fail validation. Declared outputs are validated before a workflow is marked completed. A required output that is missing fails with `missing output "<key>"`, and a type mismatch fails with `output "<key>" expected <kind>, got <actual>`. A workflow exposes exactly the outputs it declares with `.output(...)`: there is no automatic `result` output, and returning a key that was not declared fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it with .output("<key>", Type....) or remove it from the .run() return`. To expose `result`, declare `.output("result", schema)` and return `{ result }`. Child output replay still performs a structured-clone safety check after JSON validation so completed child boundaries can be replayed.

#### Why precise schemas

A loose schema types the value as `unknown`/`Record<string, unknown>` everywhere it is read and only checks "is this JSON?" at runtime. A precise schema types it exactly and validates the real shape:

```typescript
// ❌ Loose: child.outputs.report is `unknown`; runtime only checks "is JSON".
.output("report", Type.Unknown())

// ✅ Precise: child.outputs.report is `{ topic: string; score: number; tags: string[] }`,
//    and TypeBox rejects a returned value missing `score` or with a non-number `score`.
.output("report", Type.Object({
  topic: Type.String(),
  score: Type.Number(),
  tags: Type.Array(Type.String()),
}))
```

#### `Type.Unsafe<T>()` escape hatch

When you already have a precise TypeScript type for a deeply-nested serializable value and don't want to hand-write the full TypeBox schema, wrap a permissive runtime schema with `Type.Unsafe<MyType>(...)`. The **static** type becomes exactly `MyType` (so `ctx.inputs`, the `.run()` return, and `child.outputs` stay precise), while the **runtime** stays as lenient as the wrapped schema. Use a `type` alias rather than an `interface` for the wrapped type — an `interface` has no implicit index signature, so it does not satisfy the serializable-output constraint:

```typescript
import { defineWorkflow, Type } from "@bastani/workflows";

type ResearchPacket = {
  readonly topic: string;
  readonly score: number;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
};

export default defineWorkflow("research-packet")
  .input("topic", Type.String())
  // Static type = ResearchPacket; runtime only checks "is a JSON object".
  .output("packet", Type.Unsafe<ResearchPacket>(Type.Object({}, { additionalProperties: true })))
  .run(async (ctx) => {
    const packet: ResearchPacket = {
      topic: ctx.inputs.topic,
      score: 1,
      sections: [{ heading: "overview", body: "…" }],
    };
    return { packet };
  })
  .compile();
```

Tradeoff: `Type.Unsafe<T>()` does not deeply validate at runtime — it trusts the produced value matches `T`. Use it when the producing code already guarantees the shape; when you can express the shape directly, prefer a real `Type.Object(...)`/`Type.Array(...)` so runtime validation also catches drift. Keep bare `Type.Unknown()` and loose `additionalProperties` objects for genuinely dynamic data.

#### How types flow

- `ctx.inputs.x` is `Static<inputSchema>` — required/defaulted inputs are present, `Type.Optional(...)` adds `| undefined`.
- The `.run()` return is checked against declared outputs at compile time (missing-required and wrong-type are TypeScript errors) and at runtime via TypeBox `Value` (undeclared keys rejected, declared shape enforced recursively).
- `ctx.workflow(child).outputs` is typed from the child's declared `.output(...)` contract, so a parent reads precisely-typed child outputs without casting.

`Static` and `TSchema` are re-exported from `@bastani/workflows`; use `Static<typeof schema>` when you need a schema's inferred TypeScript type directly.

---

## Surfaces

### Slash commands

| Command                               | Description                                              |
| ------------------------------------- | -------------------------------------------------------- |
| `/workflow <name> [key=value ...]`    | Start a named workflow, passing optional input overrides |
| `/workflow <name> --help`             | Print the workflow's input schema                        |
| `/workflow list`                      | List all registered workflows with descriptions          |
| `/workflow status [run-id]`           | Show active plus retained terminal/current-session runs, or details for one run |
| `/workflow connect [run-id]`          | Attach to a workflow run overlay                         |
| `/workflow attach [run-id] [stage]`   | Open the attach/chat pane for a run or stage             |
| `/workflow pause [run-id] [stage]`    | Pause a live run or stage                                |
| `/workflow interrupt [run-id\|--all]` | Pause active/named/all active runs so they can resume    |
| `/workflow kill [run-id\|--all]`      | Kill in-flight workflow runs; killed runs are retained for inspection |
| `/workflow resume <run-id>`           | Resume paused work or re-open a run snapshot             |
| `/workflow reload`                    | Reload discovered workflow resources and package-manifest entries in-process |
| `/workflow inputs <name>`             | Print the input schema for a workflow                    |

Input overrides are bare `key=value` tokens (no leading `--`). Values are JSON-parsed when possible, so numbers, booleans, and quoted strings work as expected (e.g. `count=3`, `flag=true`, `prompt="multi word value"`). A whole-object override can be passed as a single JSON token (e.g. `{"prompt":"...","count":3}`). Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts.

Workflows always run as **background tasks** in interactive sessions — the chat editor stays free while a run executes. Press **F2** (or `/workflow connect <run-id>`) to attach to the live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor/custom`) appear as awaiting-input graph nodes. Press Enter on the node to answer locally, never as a modal dialog over the chat. Human input is detected when those runtime `ctx.ui.*` calls execute; workflows no longer have a declaration-time HIL flag.

Nested `ctx.workflow(...)` calls are displayed as an expanded graph within the top-level run. `/workflow status` and run pickers list only top-level user-launched workflows, not implementation-owned child runs. The `workflow` tool's `stages`, `stage`, `transcript`, `send`, `pause`, `interrupt`, and `resume` actions can still target visible child stage ids, prefixes, or names from the expanded graph; Atomic routes the control action to the owning nested run internally. (`stages`, `stage`, `transcript`, and `send` are `workflow` tool actions, not `/workflow` slash subcommands; the slash command exposes `connect`, `attach`, `pause`, `list`, `status`, `interrupt`, `kill`, `resume`, `reload`, and `inputs`.)

Prompt answer replay is live-memory only. `StageSnapshot.promptAnswerState` reports whether continuation can replay a prompt answer (`available`), must ask again because the private ledger entry is gone (`unavailable`), or must ask again because multiple matching prompt nodes are ambiguous (`ambiguous`). Raw answers stay in a private `PromptAnswerRecord` ledger, are never serialized to snapshots or persistence, and remain resident in memory until the answer is cleared, the run is removed, or the store is cleared. Replay keys include prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. Empty `ctx.ui.select(..., [])` calls throw before creating a prompt node. Arbitrary custom-widget answers cannot be supplied with `workflow send`; focus the `custom` awaiting-input node in the interactive graph instead.

### `workflow` tool (LLM-callable)

<!-- Keep the description below in sync with WORKFLOW_TOOL_DESCRIPTION in packages/workflows/src/extension/index.ts; integration tests assert this. -->

```json
{
  "name": "workflow",
  "description": "Run named workflows or direct one-off task/tasks/chain workflows; discover with list/get/inputs, inspect status/stages/stage details, send prompt answers or steering, pause/resume/interrupt/kill runs, and reload workflow resources. For large stage handoffs, write context to files/artifacts, pass paths via reads, and prompt downstream agents to 'Read the file at <path>...' instead of injecting large previous text. For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.",
  "parameters": {
    "workflow": "string (optional) — workflow ID or normalized name",
    "inputs": "object (optional) — key/value map of workflow inputs",
    "action": "'run' | 'list' | 'get' | 'inputs' | 'status' | 'stages' | 'stage' | 'transcript' | 'send' | 'pause' | 'interrupt' | 'kill' | 'resume' | 'reload'",
    "runId": "optional run id or unique prefix; control actions default to the active run where safe; use '--all' or all:true for pause/interrupt/kill all",
    "stageId": "optional stage id, prefix, or name for stage-scoped actions; cannot be combined with all:true",
    "statusFilter": "optional stages filter: pending/running/awaiting_input/paused/blocked/completed/failed/skipped/all",
    "format": "optional agent-facing output format: text or json",
    "limit": "transcript-only explicit maximum number of recent entries; omitted with tail omitted uses the path-only default when sessionFile/transcriptPath exists",
    "tail": "transcript-only explicit last-N entry count; overrides limit for quick recent-context checks",
    "includeToolOutput": "transcript-only flag for inlined snapshot preview/fallback tool-event output; does not bypass the path-only default; prefer rg/grep on the exact quoted sessionFile/transcriptPath for large outputs",
    "text": "optional string payload for send/resume; explicit empty text answers pending prompts",
    "response": "optional structured payload for answering pending prompts; explicit empty response is valid",
    "message": "optional string payload for send/resume when text is not provided",
    "delivery": "optional send delivery mode: auto, answer, prompt, steer, followUp, or resume; auto prioritizes answer, then resume, steer, followUp",
    "promptId": "optional pending prompt identifier for send/answer",
    "reason": "optional human-readable reload reason",
    "all": "optional boolean for pause/interrupt/kill all; cannot be combined with stageId",
    "task": "optional direct task object (name + prompt/task) or root task string for direct chain/parallel runs",
    "tasks": "optional array of direct task objects (parallel direct run)",
    "chain": "optional array of direct task objects and/or { parallel: [...] } groups (sequential direct run)",
    "chainName": "optional label for a direct chain run",
    "concurrency": "optional parallelism limit for direct tasks/chain",
    "failFast": "optional fail-fast toggle for direct parallel work",
    "async": "optional boolean to dispatch a run in the background",
    "intercom": "optional intercom coordination options",
    "chainDir": "optional directory for direct chain artifacts",
    "session/task options": "per-stage overrides also accepted at the top level and on direct task items — schema, model, thinkingLevel, fallbackModels, tools, noTools, customTools, mcp, context, cwd, output, outputMode, reads, worktree, gitWorktreeDir, baseBranch, maxOutput, artifacts, and more"
  }
}
```

- **`renderCall`** — renders a compact workflow call summary in the chat scroll.
- **`renderResult`** — renders the result or dispatch banner; live progress continues through the widget and graph viewer. Named workflow runs are background-oriented.
- **`transcript`** — path-only by default when a transcript file exists: use `status`, `stages`, or `stage` to identify the stage and its `sessionFile`/`transcriptPath`, quote the exact path without changing platform separators (for example, preserve Windows backslashes), then search that file with `rg`/`grep` for targeted terms and read only small surrounding ranges. Default text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals plus a `lazyReadPrompt`, with `entries: not inlined` so transcript bodies and tool outputs stay out of model context. Passing explicit `tail` or `limit` opts into a bounded inline preview for quick context checks. If no transcript path is available, the action falls back to a bounded preview of up to 5 recent entries with a `fallbackNote`. A registered live stage handle is used when one exists, even before live messages arrive; otherwise the action falls back to stored stage snapshots. Snapshot entries are ordered chronologically before `tail`/`limit` is applied, with terminal result/error entries kept after tool entries when timestamps are missing or tied. `includeToolOutput` applies only to inlined snapshot previews or no-path fallback previews; live session transcripts may not expose tool output.
- **`send`** — answers pending primitive/structured stage prompts only when `text`, `response`, or `message` is present; an explicit empty string is a valid answer, while an omitted payload is a no-op. Follow-ups to completed or failed stages reuse retained `sessionFile` metadata when available so the conversation resumes from the archived stage transcript instead of starting empty; if no session metadata was retained, the follow-up is refused instead of silently resetting. Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`. `delivery: "auto"` answers pending prompts first, then resumes paused stages, steers streaming stages, or queues a follow-up.
- **`reload`** — refreshes workflow resources directly in-process instead of queuing a literal `/workflow reload` chat follow-up.

### F2 keyboard shortcut

Press **F2** while a workflow is running to open the DAG overlay for the active run.

### Execution model

`@bastani/workflows` follows Atomic's package/extension model: Atomic loads `src/extension/index.ts` from the package `atomic.extensions` manifest, with legacy `pi.extensions` still supported, then the extension registers the `workflow` tool, `/workflow` slash command, renderers, widget, and lifecycle hooks in-process.

For interactive use, run workflows through `/workflow <name> [key=value ...]` or let the LLM call the `workflow` tool. In non-interactive (`-p` / `--print` / `--mode json`) sessions, `/workflow <name> key=value` and LLM calls to the `workflow` tool remain available for deterministic workflows. The input picker and graph picker are disabled, top-level `ctx.ui.*` is unavailable, and stage child sessions exclude `ask_user_question`. Named workflow dispatch waits for the terminal run snapshot before returning.

Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow just because its source contains `ctx.ui.*`. If you copy the HIL example above into a non-interactive session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: interactive ctx.ui.confirm is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage` (the primitive name varies, including `ctx.ui.custom`). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

For library or package authoring, define reusable workflows with the builder and export the compiled definition. Hand-written objects with `__piWorkflow: true` are rejected by discovery and composition; `defineWorkflow(...).compile()` is the public authoring surface. Standalone TypeScript workflow packages can import `defineWorkflow` and `Type` from `@bastani/workflows` directly with no local `.d.ts` file or `declare module` shim. The former imperative `runWorkflow` object-form API is removed; use compiled workflow definitions with the exported `run()` / registry helpers for programmatic execution.

```ts
import { defineWorkflow, Type } from "@bastani/workflows";

export default defineWorkflow("audit-auth")
  .input("prompt", Type.String({ default: "Investigate the auth module" }))
  .output("summary", Type.String())
  .run(async (ctx) => {
    const result = await ctx.task("audit", { prompt: ctx.inputs.prompt });
    return { summary: result.text };
  })
  .compile();
```

The `workflow` tool still supports direct one-off `task`, `tasks`, and `chain` modes for agent-initiated orchestration. Those direct modes are runtime tool inputs, not workflow definition files.

For large handoffs, prefer artifact paths over prompt injection: write stage output to `output`, set `outputMode: "file-only"` when the parent only needs the path, pass paths with `reads`, and instruct downstream agents explicitly with wording like `Read the file at <path>...`. Reserve `previous`/`{previous}` for compact summaries; avoid passing full session histories, all prior stage outputs, or every review round directly into the next model prompt. In review loops, save JSON review artifacts and pass only the latest review-round artifact, with a ledger or index file linking older rounds when needed.

Workflow stage sessions follow Atomic SDK directory defaults: `DefaultResourceLoader` is initialized with the project `cwd` and the Atomic default `~/.atomic/agent` directory, while legacy `.pi` paths remain readable where the SDK supports multiple config directories. A stage-supplied `agentDir` is treated as an explicit user override; a stage-supplied `resourceLoader` owns discovery, with `cwd`/`agentDir` left for session naming and tool path resolution.

To inspect a workflow's input schema inside pi, use `/workflow inputs <name>` or `/workflow <name> --help`.

---

## Builtin workflows

### `deep-research-codebase`

Scout + research-history chain → two parallel specialist waves → aggregator. Ideal for deep investigation of a codebase topic across locator, pattern, analyzer, and ecosystem angles.

```text
/workflow deep-research-codebase prompt="How does session persistence work?"
```

| Input             | Type     | Required | Default | Description                                               |
| ----------------- | -------- | -------- | ------- | --------------------------------------------------------- |
| `prompt`          | `text`   | ✓        | —       | Research question or topic to investigate.                |
| `max_partitions`  | `number` | —        | `100`   | Maximum number of codebase partitions to explore.         |
| `max_concurrency` | `number` | —        | `100`   | Maximum number of workflow stages to run concurrently.    |

Final Markdown research documents are written to dated `research/` paths relative to the current working directory, with a numeric suffix if needed to avoid overwriting an existing document. Hidden run artifacts are written under `research/.deep-research-<run-id>/`.

Child workflow outputs: `result`, `findings`, `research_doc_path`, `artifact_dir`, `manifest_path`, `partitions`, `explorer_count`, `specialist_count`, `max_concurrency`, and `history`.

### `goal`

Goal Runner workflow: initialize a persisted goal ledger with a per-run goal id and lifecycle events, render goal-continuation context, run bounded worker LM turns, append receipts, run three independent reviewers, and let a TypeScript reducer decide `complete`, `continue`, `blocked`, or `needs_human`. Workers and reviewers are prompted to verify user-visible behavior end-to-end when practical with `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios. Token budget behavior is intentionally excluded.

```text
/workflow goal objective="Migrate the database layer to Drizzle ORM" base_branch=develop
```

| Input         | Type     | Required | Default       | Description                                                   |
| ------------- | -------- | -------- | ------------- | ------------------------------------------------------------- |
| `objective`   | `text`   | ✓        | —             | Goal-runner objective.                                        |
| `max_turns`   | `number` | —        | `10`          | Maximum worker/review turns before human follow-up is needed. |
| `base_branch` | `string` | —        | `origin/main` | Branch reviewers compare the current delta with.              |

`goal` defaults to 10 worker/review turns. Reviewer quorum is fixed internally at 2 reviewer `complete` votes. The repeated-blocker threshold defaults to 3 consecutive same-blocker turns and is clamped to `max_turns` when you run fewer than 3 turns.

Child workflow outputs: `result`, `status`, `approved`, `goal_id`, `objective`, `ledger_path`, `turns_completed`, `iterations_completed`, `receipts`, `remaining_work`, `review_report`, and `review_report_path`.

### `ralph`

Prompt-engineering → research → orchestrate → review workflow with optional final-stage PR handoff: transform the user prompt into a codebase and online research question with `/skill:prompt-engineer`, run `/skill:research-codebase` against it, write findings under `research/`, delegate implementation through sub-agents from that research, run parallel reviewers, and iterate until approval or the loop limit. Ralph's orchestrator and reviewers are prompted to verify user-visible behavior end-to-end when practical with `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios. For UI-applicable or full-stack changes, the orchestrator runs a `playwright-cli` end-to-end QA pass and records a reviewable proof video, references it in the implementation notes, and exposes it as the `qa_video_path` output; when `create_pr=true`, the final `pull-request` stage attaches or links that video to the created PR/MR/review. Follow-up iterations pass unresolved review artifacts into prompt-engineering/research and fork research from prior research session data when available. Ralph skips PR creation by default; prompt text alone does not opt in. Pass `create_pr=true` to authorize only the final `pull-request` stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation (for example GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling). Ralph's own PR-creation instructions live in that final stage. Reviewers inspect repository infrastructure directly as needed; Ralph no longer runs separate `infra-*` discovery stages.

```text
/workflow ralph prompt="Migrate the database layer to Drizzle ORM" max_loops=3 base_branch=develop
/workflow ralph prompt="Migrate the database layer to Drizzle ORM" max_loops=3 base_branch=develop create_pr=true
```

| Input              | Type      | Required | Default       | Description                                                   |
| ------------------ | --------- | -------- | ------------- | ------------------------------------------------------------- |
| `prompt`           | `text`    | ✓        | —             | Task, feature request, issue summary, or spec path to research, execute, refine, and review. |
| `max_loops`        | `number`  | —        | `10`          | Maximum research/orchestrate/review iterations before completion or optional final handoff. |
| `base_branch`      | `string`  | —        | `origin/main` | Branch reviewers and the optional final stage compare the current delta with; also used to create a missing worktree. |
| `git_worktree_dir` | `string`  | —        | `""`          | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Ralph stages in the created/reused worktree. |
| `create_pr`        | `boolean` | —        | `false`       | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation. |

Child workflow outputs: `result`, `plan` (latest transformed research question), `plan_path` (compatibility alias for `research_path`), `research`, `research_path`, `implementation_notes_path`, `qa_video_path` (reviewable QA end-to-end proof video recorded with `playwright-cli` for UI-applicable changes, when produced), `approved`, `iterations_completed`, `review_report`, and `review_report_path`. `pr_report` is included only when `create_pr=true` and the final `pull-request` stage runs.

### `open-claude-design`

Design-system onboarding → reference import → generation → refinement → export/handoff pipeline.

```text
/workflow open-claude-design prompt="Design a kanban board" output_type=prototype
```

| Input             | Type     | Required | Default     | Description                                                          |
| ----------------- | -------- | -------- | ----------- | -------------------------------------------------------------------- |
| `prompt`          | `text`   | ✓        | —           | Design brief or description.                                         |
| `reference`       | `text`   | —        | —           | Optional URL, path, screenshot, or design doc.                       |
| `output_type`     | `select` | —        | `prototype` | `prototype`, `wireframe`, `page`, `component`, `theme`, or `tokens`. |
| `design_system`   | `text`   | —        | —           | Existing design-system reference / Design.md path.                   |
| `max_refinements` | `number` | —        | `3`         | Maximum critique/apply refinement iterations.                        |

Child workflow outputs: `output_type`, `design_system`, `artifact`, `handoff`, `approved_for_export`, `refinements_completed`, `import_context`, `run_id`, `artifact_dir`, `preview_path`, `preview_file_url`, `spec_path`, `spec_file_url`, and `playwright_cli_status`. `open-claude-design` has no `result` output; it exposes only the declared fields listed here.

---

## Custom workflow discovery

`@bastani/workflows` discovers workflow files from project-local paths, user-global paths, configured workflow paths, installed Atomic package resources, and bundled workflows:

| Location                           | Scope      | Example path                                                                           |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `.atomic/workflows/*.ts`           | Project    | `.atomic/workflows/my-workflow.ts`                                                     |
| `~/.atomic/agent/workflows/*.ts`   | User       | `~/.atomic/agent/workflows/my-workflow.ts`                                             |
| `workflows.<name>.path` in config  | Configured | see config example below                                                               |
| Installed Atomic package workflows | Package    | `atomic.workflows`, legacy `pi.workflows`, or `workflows/` / `workflow/` directories   |
| Bundled workflows                  | Built-in   | shipped with `@bastani/workflows`                                                      |

Config-based discovery (`~/.atomic/agent/extensions/workflow/config.json` or `.atomic/extensions/workflow/config.json`):

```json
{
  "workflows": {
    "my-team-workflows": { "path": "/shared/team/workflows" }
  },
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "awaiting_input"]
  }
}
```

---

## License

MIT — see [LICENSE](LICENSE).

---

**Development:** see [DEV_SETUP.md](../../DEV_SETUP.md) for setup, testing, layout, and the local-extension dev loop.

## Model reasoning levels

Workflow stage `model` and `fallbackModels` strings support suffix-first reasoning levels using the `model_name:thinking_effort` syntax: append `:off`, `:minimal`, `:low`, `:medium`, `:high`, or `:xhigh` to the model id (for example `openai/gpt-5:high` or `anthropic/claude-haiku-4-5:off`). A suffix on a fallback candidate controls only that retry attempt, so fallback chains can mix reasoning levels.

The older `thinkingLevel` stage option remains accepted as a deprecated default for candidates without a suffix. If both are present, the model suffix wins. Migrate legacy `thinkingLevel` stages by folding the effort into the model strings:

```diff
-  model: "openai/gpt-5.5",
-  fallbackModels: ["anthropic/claude-opus-4-8"],
-  thinkingLevel: "high",
+  model: "openai/gpt-5.5:high",
+  fallbackModels: ["anthropic/claude-opus-4-8:high"],
```

`fallbackThinkingLevels` is an optional compatibility helper aligned by index to `fallbackModels`; it is used only for fallback entries that do not already include a suffix.
