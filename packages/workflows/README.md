<h1 align="center">Atomic Workflows</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source Atomic workflow extension: install it, author workflows in TypeScript, run them from chat.
</p>

Default to workflows for non-trivial work and requests with inherent structure plus a verifiable objective; reserve direct chat for tiny deterministic low-risk work. Workflow-first is not builtin-only or monolithic: Atomic can author custom TypeScript `workflow({...})` definitions inline, import reusable project/package workflows or builtins from `@bastani/workflows/builtin`, and nest them with `ctx.workflow(...)`. Imported children may nest further workflows within `maxDepth`, so compose proven research, implementation, design, verification, and approval graphs rather than copying them. Custom parents can also use runtime classification, dynamic fan-out and synthesis, adversarial verification, candidate tournaments, HIL gates, and bounded convergence.

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

Temporary-worktree setup can symlink selected main-root directories into each checkout (the default preserves `node_modules`):

```json
{
  "worktree": {
    "symlinkDirectories": ["node_modules", ".cache"]
  }
}
```

After Atomic is running, use `/workflow reload` or the workflow tool's `reload` action to rescan all workflow sources in process. Additions, edits, renames, deletions, config changes, and package-resource changes become visible immediately to list/get/inputs/help/completion/invocation surfaces. Reload requests are serialized/coalesced and publish a complete replacement registry; an in-flight workflow keeps its original definition while later calls use the new registry. Fatal refresh failures retain the prior registry, and skipped malformed or missing resources are reported with actionable diagnostics while valid siblings remain available.

### Workflow lifecycle notifications

Workflow lifecycle notices are enabled by default. They send steer prompts into the main chat/model context when a run completes, fails, or ends blocked. Awaiting-input prompts are tracked for dedupe/restore, but they do not wake the main chat agent. Configure lifecycle tracking in the same extension config file:

```json
{
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
  }
}
```

Set `enabled` to `false` to disable all lifecycle notices, or narrow `notifyOn` to a non-empty list of selected events. Completion, failure, and blocked lifecycle notices are emitted for top-level workflow runs, use steer delivery, and wake an idle model so the lifecycle update enters the model context when it happens. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. Awaiting-input states are tracked for dedupe/restore, but workflows do not enqueue main-chat `/workflow connect` cards for them; prompt state remains visible through workflow status/connect surfaces, avoiding stale actionable cards if a prompt resolves while the main chat is streaming.

When a stage human-in-the-loop prompt is answered from the workflow TUI/stage chat, workflows also emits a separate display-only `workflows:hil-answer-notice` custom message. It records the answer for user-visible audit, but it does not wake the main agent, enter LLM context, or authorize answering later workflow prompts. Answers sent by the main-chat `workflow` tool do not emit this notice because the tool result already tells the main agent what happened.

---

## Authoring API

### Workflow-owned side effects

Prefer `ctx.tool(name, args, fn)` for workflow-owned TypeScript operations with side effects, including filesystem writes, network mutations, external API actions, and similar deterministic operations orchestrated directly by the workflow definition. Atomic durably caches a completed call's serializable result, so resume returns that result without rerunning `fn` or repeating the side effect. Keep pure computation and side-effect-free transformations as ordinary TypeScript. Do not wrap agent-stage internals or every function call indiscriminately.

### Example 1 — Single task

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "summarize-pr",
  description: "Summarize a pull request in one task.",
  inputs: {
    pr_url: Type.String({ description: "URL of the pull request to summarize." }),
  },
  outputs: {
    summary: Type.String({ description: "One-task summary of the pull request." }),
  },
  run: async (ctx) => {
    const summary = await ctx.task("summarize", {
      prompt: `Summarize the pull request at ${String(ctx.inputs.pr_url)} clearly and concisely.`,
    });
    return { summary: summary.text };
  },
});
```

### Example 2 — Parallel fan-out with `ctx.parallel`

Use `ctx.parallel` for independent specialist work. The aggregator receives the specialist outputs through typed task results instead of manual stage/session plumbing. The runtime snapshots the parent graph frontier when the fan-out starts, so every branch shares the same parents even when limited `concurrency` queues later branches or an earlier sibling fails with `failFast: false`.

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "parallel-research",
  description: "Scout → three parallel specialists → aggregator.",
  inputs: {
    topic: Type.String({ description: "Research topic." }),
  },
  outputs: {
    summary: Type.String({ description: "Synthesized summary of the specialist reports." }),
  },
  run: async (ctx) => {
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
  },
});
```

### Example 3 — Human-in-the-loop (HIL)

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "review-and-merge",
  description: "Plan a change, ask for human approval, then execute.",
  inputs: {
    task: Type.String({ description: "What to implement." }),
  },
  outputs: {
    status: Type.Optional(Type.String({ description: "Set to \"cancelled\" when the human rejects the plan." })),
    result: Type.Optional(Type.String({ description: "Implementation result when the plan is approved." })),
  },
  run: async (ctx) => {
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
  },
});
```

Human input is runtime-only: call `ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.editor`, or `ctx.ui.custom<T>` at the point where the workflow actually needs a decision. No declaration-time HIL marker is required or supported.

`ctx.ui.custom<T>(factory, options?)` mounts an arbitrary focused TUI component in the attached workflow graph/stage UI and resolves with the value passed to `done(value)`. The factory uses the same real TUI/theme/keybinding/component types as Atomic extension `ctx.ui.custom`. Use `options.label` for a safe display-only graph/status label and `options.replayIdentity` (do not include secrets) when the widget's semantics can change without the callsite changing; label text is not part of replay identity. Custom widget prompts require an interactive workflow graph; they are not answerable through non-TUI `workflow send` in iteration 1. Inline graph rendering is supported; `overlay: true` is rejected clearly because nested workflow graph overlays are not safely supported yet.

### Example 4 — Compose workflows

Prefer regular TypeScript module imports for reusable child workflows: import the workflow definition returned by `workflow({...})`, then pass it directly to `ctx.workflow(workflowDefinition, options)`.

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";
import goal from "@bastani/workflows/builtin/goal";
import sharedResearch from "./shared-research.js";

export default workflow({
  name: "research-and-synthesize",
  description: "Run shared research, implement from it, then synthesize the result.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    final: Type.String({ description: "Synthesis of the child research and implementation." }),
  },
  run: async (ctx) => {
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
  },
});
```

The child executes as a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default, but user-facing status and graph views flatten it into the parent run. In practice it should feel like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported children appear in one expanded parent graph, while implementation-owned child run ids stay hidden from top-level `/workflow status` lists. The child still has a run id internally so the graph can attach to, pause, interrupt, or resume live child stages correctly. Inputs are strictly validated against the child workflow before it starts: unknown keys, missing required values, type mismatches, and invalid `select` choices fail before the child body runs. The parent receives the child's declared `outputs` on `child.outputs` after those outputs pass their declared runtime type checks.

For workflows intended to be called as children, declare an `outputs` entry for every non-default field a parent should rely on. `outputs` is only the schema/contract: use normal TypeScript in `run()` to gather values from any stage/task/child workflow and return those keys.

**Return convention:** child outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.summary`, the child workflow's `outputs` map must declare `summary` and `run()` must return `{ summary }`. `result` is not special and is never added for you: to expose `result`, declare `outputs: { result: schema }` and return `{ result }` like any other output. Returning a key that is not declared in `outputs` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs or remove it from the run() return` (the child-call variant reports `... child "<alias>" returned undeclared output "<key>" from "<childName>"`).

A reusable child module can simply default-export a workflow definition:

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "shared-research",
  description: "Reusable research helper.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    summary: Type.String(),
  },
  run: async (ctx) => {
    const report = await ctx.task("research", {
      prompt: `Research: ${String(ctx.inputs.topic)}`,
    });
    return { summary: report.text };
  },
});
```

Builtin workflows are also callable as modules for reuse:

```typescript
import {
  adversarialVerification, classifyAndAct, deepResearchCodebase,
  fanOutAndSynthesize, generateAndFilter, goal, loopUntilDone,
  openClaudeDesign, ralph, tournament,
} from "@bastani/workflows/builtin";
import goalWorkflow from "@bastani/workflows/builtin/goal";
import openClaudeDesignWorkflow from "@bastani/workflows/builtin/open-claude-design";
```

Only `workflow({...})` definitions can be passed to `ctx.workflow(...)`; registry names, strings, and path objects are intentionally not supported for child workflow calls. Missing or invalid module imports fail when the workflow file itself is loaded. A parent receives the child's declared `outputs` from the child `run()` return object. Missing required outputs, schema type mismatches, returning an undeclared output, and non-JSON-serializable returned child values fail the child call before the parent continues.

### Reusable Git worktrees

Use `gitWorktreeDir` when a workflow should run in a reusable Git worktree instead of the invoking checkout. The executor creates the worktree if it is missing, reuses it when it already exists as a same-repository worktree root, defaults workflow `ctx.cwd` to the matching path inside that worktree for `worktreeFromInputs`, and defaults stage/task `cwd` to that worktree path.

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "safe-implementation",
  description: "Run implementation stages in a reusable worktree.",
  inputs: {
    task: Type.String(),
    worktree: Type.String({ default: "" }),
    base_branch: Type.String({ default: "origin/main" }),
  },
  worktreeFromInputs: {
    gitWorktreeDir: "worktree",
    baseBranch: "base_branch",
  },
  outputs: {
    result: Type.String({ description: "Implementation result text." }),
  },
  run: async (ctx) => {
    const result = await ctx.task("implement", {
      task: String(ctx.inputs.task),
      // No cwd needed: when `worktree` is non-empty, this task runs from the
      // corresponding cwd inside that reusable Git worktree.
    });
    return { result: result.text };
  },
});
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
- If the requested path exists, it must be an actual Git worktree/checkout root belonging to the invoking repository. The invoking checkout itself, paths nested beneath it, foreign repositories, and existing subdirectories are rejected so writes do not silently land in the main checkout.
- If the path is missing, the parent directory is created and Git runs `git worktree add --detach <path> <baseBranch>` from the canonical main repository root. `baseBranch` defaults to `HEAD` when omitted. Missing targets whose existing parent resolves through a symlink beneath the invoking checkout are rejected.
- The default execution cwd preserves the caller's repo-relative cwd inside the worktree. For example, invoking a workflow from `repo/packages/api` with `gitWorktreeDir=../repo-wt` uses `../repo-wt/packages/api` for workflow `ctx.cwd` and stage/task execution.
- Symlinked repo/worktree paths preserve their logical spelling in the default cwd, matching Codex-style worktree behavior.
- An explicit absolute `cwd` inside the invoking checkout is remapped to the corresponding worktree path; an absolute `cwd` already inside the selected worktree is preserved. Relative values resolve from the worktree default cwd and cannot escape it. Foreign paths, lexical traversal, and symlink escapes fail before a session starts.
- Relative stage/task outputs follow the effective worktree cwd and cannot traverse or follow symlinks outside the selected worktree. Explicit absolute outputs remain caller-selected.

`worktree: true` on an authored `ctx.task(...)` is different: it creates a branch-backed temporary checkout at `<main-root>/.atomic/worktrees/<flattened-name>` using branch `worktree-<flattened-name>` and cleans up both checkout and branch afterward, including failures before the task callback starts. `/` in generated names is flattened to `+`, and creation stays anchored at the canonical main root even when Atomic is launched from a linked worktree. The base ref is an explicit `baseBranch`, then `origin/<default-branch>` (fetched when needed), then `HEAD`. Post-creation setup copies `.atomic/settings.local.json` plus untracked `.atomic/settings.json`, shares the main repository's Husky or populated `.git/hooks` directory through `core.hooksPath`, symlinks configured `worktree.symlinkDirectories`, and copies gitignored files matched by `.worktreeinclude`; tracked checkout content is never overwritten. When no task `cwd` is set, temporary isolation starts from the runner invocation cwd; relative task cwd values resolve from that same invocation cwd. Relative task outputs are persisted under distinct per-task runner-owned temporary artifact directories before cleanup; returned output artifact paths therefore remain readable, including with `outputMode: "file-only"`. Those relative paths cannot traverse or follow symlinks outside their runner-owned output root, and a pre-existing symlink or junction at the trusted artifact root is rejected. It is mutually exclusive with `gitWorktreeDir`, which is intended for named/reusable worktrees that remain available across retries and `/workflow resume`. Durable resume records the original invocation cwd and resolved reusable-worktree metadata, then replays from that original repository context rather than whichever cwd the resumed interactive session currently has. Reusable worktree setup is cached by canonical repository and target identity within a workflow run, independent of equivalent path spelling or `baseBranch`, and the selected checkout identity is revalidated before reuse. Read-only Git repository probes retry a transient timeout once, and slow Git subprocess failures include the exact command, cwd, timeout, elapsed time, exit status/signal, and spawn error details.

Worktrees provide checkout and cwd isolation, not an operating-system security sandbox. A process with permission to mutate arbitrary sibling paths can still race filesystem checks; use a container, VM, or another OS-enforced boundary for untrusted code.

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

`subagent` is available as a default workflow-stage tool with the same five-level nesting budget as main chat: a stage can launch recursively delegated subagents until the shared depth guard reaches five delegated levels, then deeper calls are blocked. `tools` allowlists apply to bundled extension tools as well as built-ins; if a stage sets `tools`, list every tool it should see. Workflow stages can explicitly list `subagent`, `web_search`, `fetch_content`, `intercom`, and other loaded extension tools, while `excludedTools` and `noTools: "all"` still win. Bundled `@bastani/subagents` agent definitions are available to the `subagent` tool in workflow stages, including workflows launched from a subagent child process.

### Model fallbacks

Stages and high-level task helpers can retry transient provider/model failures with an ordered `fallbackModels` list. The primary `model` is tried first, then each fallback, and finally the current Atomic-selected model when available. Fallbacks are only used for retryable model/provider failures such as rate limits, quota/usage-limit exhaustion (provider messages such as `The usage limit has been reached` and codes such as `usage_limit_reached`/`insufficient_quota` classify as retryable rate-limit failures so the chain advances to a candidate with remaining headroom), auth/provider outages, unavailable models, network timeouts, context-window overflows that Atomic's auto-compaction cannot resolve on the current model, and 5xx errors — ordinary tool, shell, validation, cancellation, and workflow-code failures are not retried.

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "fallback-review",
  description: "Review with a model fallback chain.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    review: Type.String({ description: "Reviewer output text." }),
    model: Type.Optional(Type.String({ description: "Model that produced the review." })),
    attemptedModels: Type.Optional(Type.Array(Type.String(), { description: "Models tried, in fallback order." })),
    modelAttempts: Type.Optional(Type.Array(Type.Unknown(), { description: "Per-attempt model fallback details." })),
  },
  run: async (ctx) => {
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
  },
});
```

Set `model` and `fallbackModels` on the authored stage/task/chain/parallel item that needs them.

When pi exposes its model registry, workflow runs validate user-specified `model` / `fallbackModels` before starting model-backed work and report all unavailable or ambiguous IDs together. Bare model IDs are accepted only when they resolve uniquely or match the current provider; otherwise use `provider/model`. Fallback attempts may send the same prompt/context to a different provider, so choose fallbacks that fit your cost, privacy, and data-handling requirements.

### `createRegistry` — grouping workflows

```typescript
import { createRegistry, workflow } from "@bastani/workflows";

const alpha = workflow({ name: "alpha", description: "", outputs: {}, run: async () => ({}) });
const beta = workflow({ name: "beta", description: "", outputs: {}, run: async () => ({}) });
const gamma = workflow({ name: "gamma", description: "", outputs: {}, run: async () => ({}) });

const registry = createRegistry()
  .register(alpha)
  .register(beta)
  .merge(createRegistry().register(gamma));

registry.names();      // ["alpha", "beta", "gamma"]
registry.all();        // workflow definitions
registry.get("alpha"); // workflow definition | undefined
```

### Declaring inputs and outputs with TypeBox

Inputs and outputs are declared with [TypeBox](https://github.com/sinclairzx81/typebox) schemas. Import `workflow` from `@bastani/workflows`, import `Type` from `typebox`, and put schemas in the `inputs` and `outputs` maps. `workflow({...})` infers precise static types for `ctx.inputs`, the `run()` return, and `child.outputs` from those schemas, and the runtime validates against them with TypeBox `Value`.

**Prefer precise schemas.** A precise schema (`Type.Object({ topic: Type.String(), score: Type.Number() })`, `Type.Array(Type.String())`) gives consumers a precise `Static<>` type and makes runtime validation enforce the real shape. Reserve `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, and `Type.Object({}, { additionalProperties: true })` for genuinely dynamic data whose shape you cannot know ahead of time.

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

workflow({
  name: "example",
  description: "",
  inputs: {
    prompt: Type.String({ description: "Required free-text input." }), // required key -> ctx.inputs.prompt: string
    ref: Type.Optional(Type.String()),                                  // optional key -> string | undefined
    count: Type.Number({ default: 2 }),                                  // defaulted -> required key, ctx.inputs.count: number
    flavor: Type.Union([Type.Literal("a"), Type.Literal("b")], { default: "a" }), // select
  },
  outputs: {
    packet: Type.Object({ topic: Type.String(), score: Type.Number() }), // required object output
    note: Type.Optional(Type.String()),                                  // optional output
  },
  run: async (ctx) => ({ packet: { topic: ctx.inputs.prompt, score: ctx.inputs.count } }),
});
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

A required input is any schema that is neither `Type.Optional(...)` nor carries a `default` (a defaulted input is a required key at the type level but optional for the caller to provide). Input validation is strict for named workflow runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, values whose runtime type does not match the declared schema, and `select` values outside the declared literals. It does not coerce strings like `"3"` into numbers; pass JSON numbers (`count=3`) for `Type.Number()`. The `inputs` map narrows `ctx.inputs` for intellisense: required/defaulted strings are `string`, numbers are `number`, booleans are `boolean`, selects are the literal union, and `Type.Optional(...)` inputs include `undefined`.

### Output types

Declare outputs in `outputs` when a workflow result should be part of its runtime contract, especially when another workflow will call it as a child. Lead with the most precise schema you can express — the loose rows at the bottom are last resorts for genuinely dynamic data.

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

Wrap an output schema in `Type.Optional(...)` to make the key optional; an un-wrapped output schema is required. `run()` must return a JSON-serializable object. Functions, symbols, `undefined` properties, `NaN`, infinite numbers, and non-plain objects (e.g. `Date`) fail validation. Declared outputs are validated before a workflow is marked completed. A required output that is missing fails with `missing output "<key>"`, and a type mismatch fails with `output "<key>" expected <kind>, got <actual>`. A workflow exposes exactly the outputs it declares in `outputs`: there is no automatic `result` output, and returning a key that was not declared fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs or remove it from the run() return`. To expose `result`, declare `outputs: { result: schema }` and return `{ result }`. Child output replay still performs a structured-clone safety check after JSON validation so completed child boundaries can be replayed.

#### Why precise schemas

A loose schema types the value as `unknown`/`Record<string, unknown>` everywhere it is read and only checks "is this JSON?" at runtime. A precise schema types it exactly and validates the real shape:

```typescript
// ❌ Loose: child.outputs.report is `unknown`; runtime only checks "is JSON".
outputs: { report: Type.Unknown() }

// ✅ Precise: child.outputs.report is `{ topic: string; score: number; tags: string[] }`,
//    and TypeBox rejects a returned value missing `score` or with a non-number `score`.
outputs: {
  report: Type.Object({
    topic: Type.String(),
    score: Type.Number(),
    tags: Type.Array(Type.String()),
  }),
}
```

#### `Type.Unsafe<T>()` escape hatch

When you already have a precise TypeScript type for a deeply-nested serializable value and don't want to hand-write the full TypeBox schema, wrap a permissive runtime schema with `Type.Unsafe<MyType>(...)`. The **static** type becomes exactly `MyType` (so `ctx.inputs`, the `run()` return, and `child.outputs` stay precise), while the **runtime** stays as lenient as the wrapped schema. Use a `type` alias rather than an `interface` for the wrapped type — an `interface` has no implicit index signature, so it does not satisfy the serializable-output constraint:

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

type ResearchPacket = {
  readonly topic: string;
  readonly score: number;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
};

export default workflow({
  name: "research-packet",
  description: "Return a typed research packet.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    // Static type = ResearchPacket; runtime only checks "is a JSON object".
    packet: Type.Unsafe<ResearchPacket>(Type.Object({}, { additionalProperties: true })),
  },
  run: async (ctx) => {
    const packet: ResearchPacket = {
      topic: ctx.inputs.topic,
      score: 1,
      sections: [{ heading: "overview", body: "…" }],
    };
    return { packet };
  },
});
```

Tradeoff: `Type.Unsafe<T>()` does not deeply validate at runtime — it trusts the produced value matches `T`. Use it when the producing code already guarantees the shape; when you can express the shape directly, prefer a real `Type.Object(...)`/`Type.Array(...)` so runtime validation also catches drift. Keep bare `Type.Unknown()` and loose `additionalProperties` objects for genuinely dynamic data.

#### How types flow

- `ctx.inputs.x` is `Static<inputSchema>` — required/defaulted inputs are present, `Type.Optional(...)` adds `| undefined`.
- The `run()` return is checked against declared outputs at compile time (missing-required, wrong-type, and undeclared-output keys are TypeScript errors for object-form `workflow({...})`) and at runtime via TypeBox `Value` (undeclared keys rejected, declared shape enforced recursively).
- `ctx.workflow(child).outputs` is typed from the child's declared `outputs` contract, so a parent reads precisely-typed child outputs without casting.

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
| `/workflow connect [run-id]`          | Open a workflow run graph                                |
| `/workflow attach [run-id] [stage]`   | Open the attach/chat pane for a run or stage             |
| `/workflow pause [run-id] [stage]`    | Pause a live run or stage                                |
| `/workflow interrupt [run-id\|--all]` | Pause active/named/all active runs so they can resume    |
| `/workflow quit [run-id\|--all]`      | Gracefully pause live workflow runs so they can resume later          |
| `/workflow resume <run-id>`           | Resume paused work or re-open a run snapshot             |
| `/workflow reload`                    | Reload discovered workflow resources and package-manifest entries in-process |
| `/workflow inputs <name>`             | Print the input schema for a workflow                    |

Input overrides are bare `key=value` tokens (no leading `--`). Values are JSON-parsed when possible, so numbers, booleans, and quoted strings work as expected (e.g. `count=3`, `flag=true`, `prompt="multi word value"`). A whole-object override can be passed as a single JSON token (e.g. `{"prompt":"...","count":3}`). Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts.

Named workflow launches always run as **background tasks** in interactive sessions. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Foreground launches are reserved for explicit user requests or technical requirements, with notice before launch. Press **F2** to open the same live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor/custom`) appear as awaiting-input graph nodes. Press Enter on a focused node, or click a visible graph node directly, to open that stage and answer locally, never as a modal dialog over the chat. `ctrl+x` is the workflow hierarchy chord: attached stage chats show **ctrl+x return to graph**, while graph surfaces show **ctrl+x leave graph · return to main chat**. Workflow surfaces consume it before configurable editor/tool actions. Composer and prompt drafts survive leaving a stage, and pending custom questions remain pending for reattachment. `ctrl+d` and `q` are not workflow navigation controls; ordinary editor/prompt Ctrl+D behavior and printable prompt `q` remain available. Existing `esc`, `ctrl+c`, and graph `h` close/hide behavior is unchanged. While the graph pane is active, vertical wheel/trackpad gestures pan vertically and horizontal gestures pan wide graphs left and right when the terminal reports them, without falling through to the main chat or terminal scrollback. Attached stage chats capture mouse/trackpad wheel events by default so scrolling stays inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback. Press `ctrl+t` to toggle **copy mode**: copy mode disables workflow-chat mouse reporting so normal terminal/tmux text selection can work; press `ctrl+t` again to leave copy mode and restore workflow-chat scrolling. Archived read-only stage transcripts show the same copy-mode footer/status, allowing their transcript text to be selected and copied while preserving `esc` close and `ctrl+x` graph navigation. While copy mode is on, wheel/trackpad gestures are handled by the terminal/tmux and may scroll terminal scrollback, so leave copy mode before using the wheel again. Human input is detected when those runtime `ctx.ui.*` calls execute; workflows no longer have a declaration-time HIL flag.

Named launches return only after startup admission, while the admitted workflow body and stages remain background work. Pre-body setup failures (including invalid input-bound reusable worktrees) are returned immediately from the original tool call as structured failed results with the concrete error and allocated run id; Atomic does not first claim that the workflow started, and it removes the unadmitted run so corrected inputs can be retried immediately. Failures after admission continue to use normal background status and lifecycle notices.

Graceful quit is idempotent for already-paused runs and preserves unresolved `ctx.ui` prompts in DBOS. Stable author-callsite-and-composed-nested-scope reservations are created before prompting and released by exact current-format token generation after answer checkpoint, rejection, or abort. Answering while quit/paused cannot advance workflow code until explicit resume.

Workflow durability requires DBOS/Postgres. Atomic configures and launches DBOS lazily on the first workflow action, reuses that process-wide instance, and awaits readiness before durable execution or control. Initialization or persistence failures fail the workflow action; no alternate backend is selected. `DBOS_SYSTEM_DATABASE_URL` selects an existing database when supplied; otherwise Atomic runs DBOS against its own embedded Postgres (npm-distributed binaries, detached `pg_ctl` daemon under `~/.atomic/postgres` on port 5439, shared across sessions and never stopped by Atomic), with DBOS's `dbos-db` Docker container only as a platform fallback. Concurrent Atomic sessions safely share one database: unique per-process executor ids, owner/heartbeat metadata on running workflows, and first-writer-wins claims on contended status transitions prevent double dispatch. Running workflows never appear as resume targets in any session; stale-heartbeat (crashed) ones surface as red `crashed` rows, paused rows render yellow, failed/blocked red, completed green, and the open picker live-updates on local changes plus a bounded cross-session poll.

DBOS is the only durable catalog for resume, completed inspection, deletion, and targeted lookup. Session JSONL files remain chat transcripts only. Atomic reads and writes one current format; prior local workflow state and older DBOS records are not converted or discovered.

Nested `ctx.workflow(...)` calls are displayed as an expanded graph within the top-level run. `/workflow status` and run pickers list only top-level user-launched workflows, not implementation-owned child runs. The `workflow` tool's `stages`, `stage`, `transcript`, `send`, `pause`, `interrupt`, and `resume` actions can still target visible child stage ids, prefixes, or names from the expanded graph; Atomic routes the control action to the owning nested run internally. The run-level `quit` action targets the selected top-level run or all live top-level runs. (`stages`, `stage`, `transcript`, and `send` are `workflow` tool actions, not `/workflow` slash subcommands; the slash command exposes `connect`, `attach`, `pause`, `list`, `status`, `interrupt`, `quit`, `resume`, `reload`, and `inputs`.)

Prompt answer replay is live-memory only. `StageSnapshot.promptAnswerState` reports whether continuation can replay a prompt answer (`available`), must ask again because the private ledger entry is gone (`unavailable`), or must ask again because multiple matching prompt nodes are ambiguous (`ambiguous`). Raw answers stay in a private `PromptAnswerRecord` ledger, are never serialized to snapshots or persistence, and remain resident in memory until the answer is cleared, the run is removed, or the store is cleared. Replay keys include prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. Empty `ctx.ui.select(..., [])` calls throw before creating a prompt node. Arbitrary custom-widget answers cannot be supplied with `workflow send`; focus the `custom` awaiting-input node in the interactive graph instead.

### `workflow` tool (LLM-callable)

<!-- Keep the description below in sync with WORKFLOW_TOOL_DESCRIPTION in packages/workflows/src/extension/workflow-prompts.ts; integration tests assert this. -->

```json
{
  "name": "workflow",
  "description": "Run named builtin, project, user, or package workflows; custom definitions may import reusable project/package workflows or builtin definitions from @bastani/workflows/builtin and nest them with ctx.workflow(...), including deeper composition within the configured maxDepth; when workflow execution fits but another shape would better achieve the task, author a custom TypeScript workflow({...}) inline with normal coding tools, reload it, and run it; discover with list/get/inputs/models, list session runs with status (no runId; statusFilter narrows the list), inspect status/stages/stage details, send prompt answers or steering, pause/resume/interrupt/quit runs, and reload workflow resources. For large stage handoffs, write context to files/artifacts, pass paths via reads, and prompt downstream agents to 'Read the file at <path>...' instead of injecting large previous text. For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview. Use action 'models' to inspect models in the configured catalog; the result is a configured-auth snapshot showing what's present in the registry with configured authentication, not proof of credentials, entitlements, OAuth freshness, or live provider access. When authoring a workflow that should dynamically select a model, first call workflow({ action: 'models' }) to inspect the configured catalog, then select from the returned provider/id entries considering the isCurrent marker and available thinking levels.",
  "parameters": {
    "workflow": "string (optional) — workflow ID or normalized name",
    "inputs": "object (optional) — key/value map of workflow inputs",
    "action": "'run' | 'list' | 'get' | 'inputs' | 'models' | 'status' | 'stages' | 'stage' | 'transcript' | 'send' | 'pause' | 'interrupt' | 'quit' | 'resume' | 'reload'",
    "runId": "optional run id or unique prefix; control actions default to the active run where safe; use '--all' or all:true for pause/interrupt/quit all",
    "stageId": "optional stage id, prefix, or name for stage-scoped actions; cannot be combined with all:true",
    "statusFilter": "optional filter for stages or the no-runId status run listing: pending/running/awaiting_input/paused/blocked/completed/failed/skipped/cancelled/killed/all; for the status listing, run statuses match directly and awaiting_input selects runs with a pending human prompt",
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
    "all": "optional boolean for pause/interrupt/quit all; cannot be combined with stageId"
  }
}
```

- **`renderCall`** — renders a compact workflow call summary in the chat scroll.
- **`renderResult`** — renders the result or dispatch banner; live progress continues through the widget and graph viewer. Named workflow runs are background-oriented.
- **`transcript`** — path-only by default when a transcript file exists: use `status`, `stages`, or `stage` to identify the stage and its `sessionFile`/`transcriptPath`, quote the exact path without changing platform separators (for example, preserve Windows backslashes), then search that file with `rg`/`grep` for targeted terms and read only small surrounding ranges. Default text results include JSON-escaped `sessionFileJson`/`transcriptPathJson` lines for copy-safe path literals plus a `lazyReadPrompt`, with `entries: not inlined` so transcript bodies and tool outputs stay out of model context. Passing explicit `tail` or `limit` opts into a bounded inline preview for quick context checks. If no transcript path is available, the action falls back to a bounded preview of up to 5 recent entries with a `fallbackNote`. A registered live stage handle is used when one exists, even before live messages arrive; otherwise the action falls back to stored stage snapshots. Snapshot entries are ordered chronologically before `tail`/`limit` is applied, with terminal result/error entries kept after tool entries when timestamps are missing or tied. `includeToolOutput` applies only to inlined snapshot previews or no-path fallback previews; live session transcripts may not expose tool output.
- **`send`** — answers pending primitive/structured stage prompts only when `text`, `response`, or `message` is present; an explicit empty string is a valid answer, while an omitted payload is a no-op. Follow-ups to eligible terminal agent stages revive an interactive **post-mortem chat** through the shared resolver: on a live-handle miss the stage's retained `sessionFile` is validated (existing, readable, context-bearing) and reopened as a detached, single-flight handle so the message is delivered as a conversational follow-up appended in place — the same path used by `/workflow attach`, restored/replayed durable snapshots, and completed-workflow inspection — without resuming, retrying, or re-dispatching workflow execution. If no valid retained session exists, the follow-up is refused (`No live handle for stage.`) instead of silently resetting or exposing a handle-less non-terminal session. Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`. `delivery: "auto"` answers pending prompts first, then resumes paused stages, steers streaming stages, or queues a follow-up.
- **`reload`** — refreshes workflow resources directly in-process instead of queuing a literal `/workflow reload` chat follow-up.
- **`models`** — returns safe model-catalog metadata from the configured registry. Each entry contains `provider` (e.g. `openai`), `id` (e.g. `gpt-4`), `fullId` (e.g. `openai/gpt-4`), `isCurrent` (whether this is the active model), and `availableThinkingLevels`, canonically derived from the registry model's `reasoning` and `thinkingLevelMap` metadata. The result is a configured-auth snapshot: it shows which models are present in the registry with configured authentication, not proof of credentials, entitlements, OAuth freshness, or live provider access. No secrets, tokens, or authentication details are returned.

### F2 keyboard shortcut

Press **F2** while a workflow is running to open the DAG overlay for the active run.

### Execution model

`@bastani/workflows` follows Atomic's package/extension model: Atomic loads `src/extension/index.ts` from the package `atomic.extensions` manifest, with legacy `pi.extensions` still supported, then the extension registers the `workflow` tool, `/workflow` slash command, renderers, widget, and lifecycle hooks in-process.

For interactive use, run workflows through `/workflow <name> [key=value ...]` or let the LLM call the `workflow` tool. In non-interactive (`-p` / `--print` / `--mode json`) sessions, `/workflow <name> key=value` and LLM calls to the `workflow` tool remain available for deterministic workflows. The input picker and graph picker are disabled, top-level `ctx.ui.*` is unavailable, and stage child sessions exclude `ask_user_question`. Named workflow dispatch waits for the terminal run snapshot before returning.

Because human input is runtime-only and workflows no longer carry a declaration-time HIL marker, headless dispatch does not reject a workflow just because its source contains `ctx.ui.*`. If you copy the HIL example above into a non-interactive session, it can pass dispatch and then fail when execution reaches the prompt with an error such as `atomic-workflows: interactive ctx.ui.confirm is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage` (the primitive name varies, including `ctx.ui.custom`). Run those workflows interactively, or guard/remove runtime `ctx.ui.*` calls before using headless mode.

For library or package authoring, define reusable workflows with `workflow({...})` and export the returned definition. Hand-written objects with `__piWorkflow: true` are rejected by discovery and composition; `workflow({...})` is the public authoring surface. Standalone TypeScript workflow packages import `workflow` from `@bastani/workflows` and `Type` from `typebox` directly with no local `.d.ts` file or `declare module` shim. Migration from the removed builder API is mechanical: move `.description(...)` to `description`, `.input(key, schema)` calls into `inputs`, `.output(key, schema)` calls into `outputs`, `.worktreeFromInputs(...)` to `worktreeFromInputs`, and the `.run(fn)` callback to `run: fn`; delete `.compile()`. The former imperative `runWorkflow` object-form API is removed; use workflow definitions with the exported `run()` / registry helpers for programmatic execution.

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "audit-auth",
  description: "Audit the authentication module.",
  inputs: {
    prompt: Type.String({ default: "Investigate the auth module" }),
  },
  outputs: {
    summary: Type.String(),
  },
  run: async (ctx) => {
    const result = await ctx.task("audit", { prompt: ctx.inputs.prompt });
    return { summary: result.text };
  },
});
```

The `workflow` tool accepts named workflow execution (`workflow` plus `inputs`), discovery, inspection, messaging, run control, and reload. Author stage graphs with `ctx.task`, `ctx.chain`, and `ctx.parallel` inside workflow definitions.

For large handoffs, prefer artifact paths over prompt injection: write stage output to `output`, set `outputMode: "file-only"` when the parent only needs the path, pass paths with `reads`, and instruct downstream agents explicitly with wording like `Read the file at <path>...`. Reserve `previous`/`{previous}` for compact summaries; avoid passing full session histories, all prior stage outputs, or every review round directly into the next model prompt. In review loops, save JSON review artifacts and pass only the latest review-round artifact, with a ledger or index file linking older rounds when needed.

Workflow stage sessions follow Atomic SDK directory defaults: `DefaultResourceLoader` is initialized with the project `cwd` and the Atomic default `~/.atomic/agent` directory, while legacy `.pi` paths remain readable where the SDK supports multiple config directories. A stage-supplied `agentDir` is treated as an explicit user override; a stage-supplied `resourceLoader` owns discovery, with `cwd`/`agentDir` left for session naming and tool path resolution.

To inspect a workflow's input schema inside pi, use `/workflow inputs <name>` or `/workflow <name> --help`.

---

## Builtin workflows

### Six composable pattern workflows

The six common patterns ship as full builtins and are discoverable/runnable by name:

| Workflow | Graph and use | Inputs (defaults) | Parent-consumable outputs |
|---|---|---|---|
| `classify-and-act` | structured classifier → deterministic action; HIL fallback for low confidence | `prompt`; `categories` (3 defaults), `confidence_threshold=0.75` | result, category/confidence, classification/action paths |
| `fan-out-and-synthesize` | partition → bounded artifact fan-out → evidence synthesis barrier | `prompt`; `max_branches=4`, `max_concurrency=4` | result, partitions, branch/synthesis/manifest paths |
| `adversarial-verification` | worker → fresh rubric verifiers → reducer → bounded repair | `task`; `verifier_count=3`, `max_repairs=2` | result, approval, repairs, candidate/review/verifier paths |
| `generate-and-filter` | candidate fan-out → dedupe/filter → optional judge → shortlist | `prompt`; `num_candidates=8`, `shortlist_size=3`, `use_judge=true`, `max_concurrency=4` | result, shortlist and candidate/filter/judge/final/manifest paths |
| `tournament` | independent attempts → order-balanced pairwise judges → bracket reducer | `prompt`; `num_attempts=4`, `max_concurrency=4` | result, winner, attempt/judge/bracket paths |
| `loop-until-done` | durable ledger → iteration/evaluator loop → complete or inspectable exhaustion | `prompt`; `max_iterations=5` | result/status, ledger, iteration/evaluation paths, remaining work |

All six are exported from `@bastani/workflows/builtin` as definitions (`classifyAndAct`, `fanOutAndSynthesize`, `adversarialVerification`, `generateAndFilter`, `tournament`, and `loopUntilDone`). Import and nest them through `ctx.workflow(definition, { inputs, stageName })`; nested calls respect `maxDepth`. Prefer composition over copying their prompts or graphs: children contribute their stages, dedicated prompts, gates, artifacts, HIL nodes, and declared outputs to the expanded parent graph.

A migration parent can nest all three definitions: fan out the fix pass, independently verify the produced patch set, then run a bounded evidence loop until the repository tests pass:

```ts
import { adversarialVerification, fanOutAndSynthesize, loopUntilDone } from "@bastani/workflows/builtin";

const fixes = await ctx.workflow(fanOutAndSynthesize, {
  inputs: { prompt: "Fix every migration call site", max_branches: 6 },
  stageName: "migration fixes",
});
const verification = await ctx.workflow(adversarialVerification, {
  inputs: { task: `Verify every patch listed by ${fixes.outputs.manifest_path}` },
  stageName: "verify migration patches",
});
const convergence = await ctx.workflow(loopUntilDone, {
  inputs: {
    prompt: `Run the migration test suite and repair remaining failures. Start from ${fixes.outputs.manifest_path}; respect the verification decision at ${verification.outputs.review_report_path}.`,
    max_iterations: 5,
  },
  stageName: "loop while migration tests fail",
});
```

The parent can consume `fixes.outputs`, `verification.outputs`, and `convergence.outputs` directly, and can repeat the verification child per patch when its own typed input lists individual patch artifacts.

### `deep-research-codebase`

Heavy research for tasks requiring comprehensive, whole-repository context.

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

Goal Runner workflow: initialize a persisted goal ledger with a per-run goal id, immutable `acceptance_criteria`, and lifecycle events, render goal-continuation context, run bounded worker LM turns, append receipts, run three independent reviewers with objective-alignment findings and clause-by-clause requirements traceability, let a TypeScript reducer decide `complete`, `continue`, `blocked`, or `needs_human`, and optionally run a final-stage PR handoff after approval. All three reviewers start in clean, non-forked contexts like Ralph's reviewers and use Ralph's exact `reviewer-a` model chain, led by Claude Fable 5. At review start, every concurrent reviewer checks Intercom, discovers sibling reviewers in the same run, communicates its validation plan, and coordinates ownership and serialization of expensive, lock-prone, or conflicting shared-checkout/shared-environment commands. Reviewers announce coordinated check starts and finishes, release claimed resources, and share reusable execution evidence while still independently inspecting the patch and producing their own verdicts. Workers begin from an observable acceptance/contract matrix derived from the literal objective/acceptance criteria and are prompted to model states, transitions, and invariants explicitly for stateful work; each review round's findings are consolidated into a deduplicated cross-reviewer batch (`consolidated_findings` in the round artifact) that the next worker turn repairs together, with durable regression evidence required for reproduced findings. Reviewers independently derive adversarial checks from the literal contract before relying on the worker receipt or worker-authored tests. Workers and reviewers are prompted to verify user-visible behavior end-to-end when practical with `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios; they must assume credentials/auth/environment access exists until concrete checks plus an actual app/flow launch attempt prove otherwise, and skipped E2E must cite exact attempted commands and observed failure output. Reviewers also look for any QA E2E video referenced by the ledger or receipt and inspect the actual video before treating it as proof. Token budget behavior is intentionally excluded. Goal skips PR creation by default; prompt text alone does not opt in. Pass `create_pr=true` to authorize only the final `pull-request` stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation after Goal reaches `complete` within the turn budget.

Resource release is itself a coordinated update: after releasing a claim, the reviewer explicitly notifies its siblings through Intercom rather than treating release as a silent local action.

```text
/workflow goal objective="Migrate the database layer to Drizzle ORM" base_branch=develop
/workflow goal objective="Migrate the database layer to Drizzle ORM and open a PR when complete" base_branch=develop create_pr=true
```

| Input         | Type     | Required | Default       | Description                                                   |
| ------------- | -------- | -------- | ------------- | ------------------------------------------------------------- |
| `objective`   | `text`   | ✓        | —             | Goal-runner objective or delta.                               |
| `acceptance_criteria` | `text` | — | objective | Original immutable task contract; pass the original task text when launching follow-up Goal runs from reviewer findings. |
| `max_turns`   | `number` | —        | `10`          | Maximum worker/review turns before human follow-up is needed. |
| `base_branch` | `string` | —        | `origin/main` | Branch reviewers and the optional final stage compare the current delta with. |
| `create_pr`    | `boolean` | —        | `false`       | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation after Goal reaches `complete`. |

`goal` defaults to 10 worker/review turns. Reviewer quorum is fixed internally at 2 reviewer `complete` votes, and approval is deterministic on each reviewer's self-reported `stop_review_loop` boolean: a reviewer approves exactly when it returns `stop_review_loop=true` with no `reviewer_error` (parse failures count as non-approval), and the reducer completes the run when quorum of those booleans is met. Findings and `requirements_traceability` remain required audit evidence and drive the reviewer prompts that derive the flag (`required_by_objective` findings mean `false` at any priority, P3 included; `consistent_with_objective` P3 nice-to-haves, out-of-scope observations, the quorum process itself, and the authorized post-approval PR final action must not hold the flag at `false`), but the harness does not recompute approval from those arrays. Without quorum, the decision reason records the reviewers' remaining work, and the bounded loop stops inspectably at `max_turns` as `needs_human`. The repeated-blocker threshold defaults to 3 consecutive same-blocker turns and is clamped to `max_turns` when you run fewer than 3 turns.

Child workflow outputs: `result`, `status`, `approved`, `goal_id`, `objective`, `acceptance_criteria`, `ledger_path`, `turns_completed`, `iterations_completed`, `receipts`, `remaining_work`, `review_report`, and `review_report_path`. `pr_report` is included only when `create_pr=true`, Goal reaches `complete`, and the final `pull-request` stage runs.

### `ralph`

Raw prompt → prompt-engineering research → orchestrate → review workflow with optional final-stage PR handoff: use the raw prompt as the operative objective, keep optional `acceptance_criteria` as the immutable original task contract (defaulting to `prompt`), transform the prompt into a codebase and online research question with `/skill:prompt-engineer`, run `/skill:research-codebase` against it, write findings under `research/`, delegate implementation through sub-agents from that research, run parallel reviewers across Claude Fable 5 and GPT-5.5 Codex model families, and iterate until approval or the loop limit. At review start, each concurrent Ralph reviewer checks Intercom, discovers same-run sibling reviewers, communicates its validation plan, claims expensive or lock-prone checks, and coordinates serialization of conflicting shared-checkout/shared-environment commands. Reviewers announce coordinated check starts and finishes, release claimed resources, and share reusable command evidence, but each still independently inspects the patch and returns its own verdict. Ralph's research, orchestrator, and reviewer prompts receive the objective next to the literal acceptance contract; when launching follow-up Ralph runs from reviewer findings, pass the ORIGINAL task text as `acceptance_criteria` so deltas cannot drift from the contract. The orchestrator begins from an observable acceptance/contract matrix derived from the literal prompt/acceptance criteria, models states/transitions/invariants explicitly for stateful work, and repairs unresolved reviewer findings as one consolidated batch (the round artifact carries a deduplicated cross-reviewer `consolidated_findings` list) with durable regression evidence for reproduced findings. Reviewers independently derive adversarial checks from the literal contract before relying on the implementation notes, orchestrator report, or worker-authored tests, and each reviewer derives a single authoritative `stop_review_loop` boolean from that evidence (`required_by_objective` findings mean `false` at any priority, P3 included, while `consistent_with_objective` P3 nice-to-haves stay non-blocking); the loop gate approves deterministically on that boolean plus a null `reviewer_error` without recomputing approval from the findings arrays. Ralph's orchestrator and reviewers are prompted to verify user-visible behavior end-to-end when practical with `playwright-cli`-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios. They must assume credentials/auth/environment access exists until concrete non-destructive checks plus an actual launch/flow attempt prove otherwise; skipped E2E is valid only when exact attempted commands and observed failure output are recorded. For UI-applicable or full-stack changes, the orchestrator runs a `playwright-cli` end-to-end QA pass and records a reviewable proof video, references it in the implementation notes, and exposes it as the `qa_video_path` output; reviewers receive that path and inspect the actual video before treating it as proof. Review decisions include `requirements_traceability`, a non-empty clause-by-clause map over every prompt/acceptance-criteria requirement kept as audit evidence for deriving the flag; worker-authored tests/snapshots passing are circular evidence unless tied to independent current-state proof, and process-only clauses (reviewer quorum, the authorized post-approval PR final action) must never hold `stop_review_loop` at `false`. When `create_pr=true`, the final `pull-request` stage attaches or links that video to the created PR/MR/review. Follow-up iterations pass unresolved review artifacts into prompt-engineering/research and fork research from prior research session data when available. Ralph skips PR creation by default; prompt text alone does not opt in. Pass `create_pr=true` to authorize only the final `pull-request` stage to inspect provider credentials and attempt provider-appropriate PR/MR/review creation (for example GitHub `gh`, Azure Repos `az repos pr create`, or Sapling/Phabricator tooling). Ralph's own PR-creation instructions live in that final stage. Reviewers inspect repository infrastructure directly as needed; Ralph no longer runs separate `infra-*` discovery stages.

Ralph's orchestrator omits the subagent tool's explicit `model` argument by default so named agents use their configured model and fallback policy. Its sole automatic routing exception covers agents with no configured/default model: it reads `packages/coding-agent/docs/models/model-selection.md`, follows the documented Pareto-efficient role recommendations, calls `workflow({ action: "models" })`, and pins only a returned `fullId`, with a thinking suffix only when that level is listed in `availableThinkingLevels`. No recommendation match or an empty catalog stays unpinned and is recorded; Ralph does not inspect credentials or infer absence, and asks the user only when the task truly needs an explicit model. Other overrides still require an exact user request or documented task need plus a pre-launch reason, and diversity alone cannot justify an ad hoc model. The orchestrator also gives every delegated subagent in the run one shared invocation-specific, non-`default` Intercom group while preserving cross-group `contact_supervisor` escalation.

Resource release is itself a coordinated update: after releasing a claim, the reviewer explicitly notifies its sibling through Intercom rather than treating release as a silent local action.

```text
/workflow ralph prompt="Migrate the database layer to Drizzle ORM" max_loops=3 base_branch=develop
/workflow ralph prompt="Migrate the database layer to Drizzle ORM" max_loops=3 base_branch=develop create_pr=true
```

| Input                 | Type      | Required | Default       | Description                                                   |
| --------------------- | --------- | -------- | ------------- | ------------------------------------------------------------- |
| `prompt`              | `text`    | ✓        | —             | Task, feature request, issue summary, or spec path to research, execute, refine, and review. |
| `acceptance_criteria` | `text`    | —        | prompt        | Original immutable task contract; pass the original task text when launching follow-up Ralph runs from reviewer findings. |
| `max_loops`           | `number`  | —        | `10`          | Maximum research/orchestrate/review iterations before completion or optional final handoff. |
| `base_branch`         | `string`  | —        | `origin/main` | Branch reviewers and the optional final stage compare the current delta with; also used to create a missing worktree. |
| `git_worktree_dir`    | `string`  | —        | `""`          | Optional reusable Git worktree root. Empty runs in the invoking checkout; non-empty values run Ralph stages in the created/reused worktree. |
| `create_pr`           | `boolean` | —        | `false`       | Safe-by-default PR creation flag. Omitted or `false` skips the final `pull-request` stage and omits `pr_report`; prompt text alone does not opt in, and only strict `true` authorizes the final `pull-request` stage to attempt provider-appropriate PR/MR/review creation. |

Child workflow outputs: `result`, `plan` (latest transformed research question), `plan_path` (compatibility alias for `research_path`), `research`, `research_path`, `implementation_notes_path`, `qa_video_path` (reviewable QA end-to-end proof video recorded with `playwright-cli` for UI-applicable changes, when produced), `approved`, `iterations_completed`, `review_report`, and `review_report_path`. `pr_report` is included only when `create_pr=true` and the final `pull-request` stage runs.

### `open-claude-design`

Combined discovery/init → design-system/reference research → curated reference discovery with user preference check → separate forked generate and user-feedback chains → export/handoff pipeline. The `discovery` stage asks for output type and references, then runs impeccable init in the same stage so PRODUCT.md/DESIGN.md are detected, created, or reconciled. `ds-*` stages handle user-provided URL/file reference extraction directly, then `reference-discovery` uses that context and asks which curated direction you prefer (or asks for a reference image/path/URL if none fit). Export is only `exporter` plus `final-display`.

```text
/workflow open-claude-design prompt="Design a kanban board component"
```

| Input                 | Type      | Required | Default | Description                                                                 |
| --------------------- | --------- | -------- | ------- | --------------------------------------------------------------------------- |
| `prompt`              | `text`    | ✓        | —       | Design brief or description.                                                |
| `discover_references` | `boolean` | —        | `true`  | Discover current gallery references with browser tooling; set false to skip. |
| `max_refinements`     | `number`  | —        | `3`     | Maximum generate/user-feedback loop iterations.                              |

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
    "notifyOn": ["completed", "failed", "blocked", "awaiting_input"]
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
