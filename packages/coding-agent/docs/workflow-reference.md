# Workflow API reference

Look up workflow primitives, task and stage options, model controls, worktree guarantees, tool surfaces, and programmatic package APIs.

## Fast Inference for Workflow Stages

Workflow stages can opt into faster, higher-priority inference on supported providers so multi-stage runs finish sooner. This is currently delivered through Codex fast mode.

### Codex fast mode

Use `/fast` to manage Codex fast mode separately for normal chat and workflow-stage sessions. The settings are `codexFastMode.chat` and `codexFastMode.workflow`; workflow stages use the workflow scope, not the chat scope.

Fast mode is eligible only for supported `openai/*` and `openai-codex/*` providers. It does not apply to `github-copilot/*`, Azure OpenAI, OpenRouter, or custom OpenAI-compatible providers. When applied, workflow stage displays keep the raw model id and expose `fast` as a separate marker/stage metadata indicator.

Enable workflow fast mode deliberately for broad workflows: parallel fan-out and fallback attempts can multiply priority-tier requests and cost.


## Workflow Primitives

Prefer high-level primitives because they create tracked graph nodes, provide consistent handoff semantics, and keep workflow definitions easier to read.

| Need | Use |
|------|-----|
| One LLM/session task with workflow tracking | `ctx.task(name, options)` |
| Dependent sequential tasks | `ctx.chain(steps, options?)` |
| Independent concurrent branches | `ctx.parallel(steps, options?)` |
| Reusable child workflow | Call `ctx.workflow(workflowDefinition, options?)` |
| Human input during a workflow run | `ctx.ui.input/confirm/select/editor/custom` |
| Pure deterministic computation, parsing, or file I/O | Plain TypeScript in `run` or helpers |
| Fine-grained session control | `ctx.stage(name, options?)` |

Use `previous` and `{previous}` for compact handoffs only. If no placeholder is present, the runtime appends context, so a large `previous` payload can silently bloat the next model prompt. Chain defaults are:

- first missing task uses `{task}` from chain options or the root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

For large handoffs, write artifacts to files, pass their paths with `reads`, and tell downstream stages to read those files incrementally. Put the instruction in the downstream prompt explicitly, e.g. `Read the file at ${artifactPath} and use only the sections needed for this stage.` Prefer `outputMode: "file-only"` when the parent only needs the artifact path.

`ctx.parallel` snapshots the current graph frontier when the fan-out starts. Every branch in that call uses the same parent set, including branches dequeued later because of a limited `concurrency` value and branches that continue after an earlier sibling fails with `failFast: false`. Downstream stages then depend on all settled parallel branches instead of accidentally chaining queued siblings behind one another.

### Fine-Grained Stages

Use `ctx.stage(name, options?)` when `ctx.task` is too coarse and you need direct control over the underlying stage session. `StageContext` supports:

- prompting and completion: `prompt(text, options?)`, `complete(text, options?)`
- live input: `sendUserMessage(content, options?)`, `steer(text)`, `followUp(text)`, `subscribe(listener)`
- session metadata: `sessionId`, `sessionFile`
- model controls: `setModel`, `setThinkingLevel`, `cycleModel`, `cycleThinkingLevel`
- state access: `agent`, `model`, `thinkingLevel`, `messages`, `isStreaming`
- tree/context controls: `navigateTree(...)`, `compact(...)`, `abortCompaction()`
- current operation abort: `abort()`

## Task and Stage Options

Common task/stage options include:

- `prompt` or `task`
- `previous` for small handoff context; use artifact paths plus `reads` for large outputs, logs, research bundles, or reviewer payloads
- `context: "fresh" | "fork"`, `forkFromSessionFile`
- `model`, `fallbackModels`, `thinkingLevel`, `scopedModels`, `modelRegistry` — `model` and each `fallbackModels` entry accept a `model_name:thinking_effort` reasoning suffix and an optional parenthesized context-window token such as `model (1m)` (see [Reasoning levels](/workflow-reference#reasoning-levels) and [Context windows](/workflow-reference#context-windows)); the standalone `thinkingLevel` is deprecated
- `contextWindow`, `contextWindowStrict` — stage-wide context-window budget mapped to the SDK `createAgentSession` options of the same name (non-strict by default)
- `tools`, `noTools`, `customTools`, `mcp: { allow?: string[], deny?: string[] }`
- `schema` for a structured final answer from this workflow item
- `output`, `outputMode`, `reads`, `worktree`, `gitWorktreeDir`, `baseBranch`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`, `agentDir`
- advanced host-supplied SDK seams: `authStorage`, `resourceLoader`, `sessionManager`, `settingsManager`, `sessionStartEvent`

Workflow stages inherit the active host session directory only when the host is using a non-default session location. For example, headless runs launched with `atomic --mode json --session-dir <dir> -p '/workflow <name> ...'` write the main chat transcript and every stage transcript under `<dir>`; the same applies when the non-default directory comes from `ATOMIC_CODING_AGENT_SESSION_DIR` or settings. If no non-default host session directory is configured, stage sessions keep using Atomic's normal global session store. A per-stage `sessionDir` option always overrides the inherited host directory, including for forked stages (`context: "fork"`, `forkFromSessionFile`).

`schema` is opt-in. When a `ctx.stage` call, `ctx.task` call, `ctx.chain` item, or `ctx.parallel` item includes a TypeBox schema or plain JSON Schema descriptor object, Atomic registers a schema-specific final-answer tool for that item only. The schema may describe object, array, or primitive final values; the captured value is the JSON value passed to the tool. The prompt result is the captured structured value for `ctx.stage(..., { schema }).prompt(...)`; task/chain/parallel results also include `result.structured` and keep `result.text` as formatted JSON for handoffs. Because the result contract is single-use, a schema-backed `StageContext` supports one `prompt()` call; create a new `ctx.stage(..., { schema })` for each additional structured prompt. If a turn finishes without calling `structured_output`, or the tool call fails schema validation, Atomic sends up to three corrective follow-up prompts that quote the concrete contract/validation error and remind the model to call `structured_output` instead of replying with plain JSON. If the item also uses an explicit `tools` allowlist, Atomic automatically adds the final-answer tool to that allowlist. Items without `schema` do not receive it from the normal tool registry.

`subagent` is available as a default workflow-stage tool, with the same five-level nesting budget as main chat: a workflow stage can launch recursively delegated subagents until the shared depth guard reaches five delegated levels, then deeper calls are blocked. `tools` remains an allowlist across built-in tools and bundled extension tools; if you set `tools`, list every tool the stage should see. Explicitly listing tools such as `subagent`, `web_search`, `fetch_content`, or `intercom` exposes those tools to the stage, while `excludedTools` and `noTools: "all"` still win. The bundled subagent definitions from `@bastani/subagents` are available to the `subagent` tool in workflow stages; when a workflow is itself running inside a subagent child process, Atomic isolates stage resource discovery from the parent child-process flags so `subagent` remains available while workflow-stage nested-depth guards remain in force.

Workflow stages use the same upstream-compatible `bash` tool as normal Atomic sessions. If `bash` is enabled for a stage, commands run through the configured shell with the stage process permissions; workflow options no longer include a command-level allow/deny field for shell text. Use `tools`/`noTools` to expose or hide shell access, prefer narrower custom tools for repeatable operations, and run workflows inside a container, VM, or other sandbox when command allowlisting or stronger isolation is required.

`gitWorktreeDir` selects a reusable Git worktree root for `ctx.stage`, `ctx.task`, `ctx.chain`, and `ctx.parallel`. If the path is missing, Atomic creates it with `git worktree add --detach <path> <baseBranch>`; if it exists, it must be a same-repository worktree root located outside the invoking checkout. The invoking checkout itself, nested targets inside it, and missing targets whose symlinked parent resolves inside it are rejected before Git creates or reuses a worktree. The default stage cwd becomes the matching cwd inside the worktree and preserves the invoking repo-relative subdirectory. An explicit absolute `cwd` inside the invoking repository is remapped to the corresponding location inside the selected worktree; an absolute `cwd` already inside that worktree is preserved. Relative values resolve from the worktree cwd and cannot escape it. Any `cwd` that would escape either lexically or through a symlink fails before the stage session starts instead of silently running elsewhere. Runner-managed reusable-worktree relative direct output paths follow the effective worktree cwd and cannot traverse or follow symlinks outside the selected worktree. Temporary-worktree relative direct outputs are persisted under distinct per-task runner-owned temporary artifact directories before cleanup so returned artifacts remain readable, including with `outputMode: "file-only"`; they likewise cannot escape their output root, and Atomic rejects a pre-existing symlink or junction at the trusted artifact root. Explicit absolute outputs and nonblank explicit `chainDir` locations remain caller-selected, while blank `chainDir` values are treated as omitted. `gitWorktreeDir` is mutually exclusive with `worktree: true`: use `gitWorktreeDir` for named/reusable worktrees and `worktree: true` for temporary direct-mode worktrees that are cleaned up even when startup fails before the workflow callback. Temporary isolation defaults to the runner invocation cwd when a task cwd is omitted, and relative task cwd values resolve from that invocation cwd. Atomic caches reusable setup by canonical repository and target identity within a workflow run, independent of equivalent path spelling or `baseBranch`, and revalidates the selected checkout identity before reuse, retries one transient timeout from read-only Git repository probes, and reports the exact Git command, cwd, timeout, elapsed time, exit status/signal, and spawn error details when preflight fails. Worktrees provide checkout and cwd isolation, not an operating-system security sandbox; use a container, VM, or another OS-enforced boundary for untrusted code that can race or mutate arbitrary filesystem paths.

To bind user inputs to a workflow-wide worktree default, set `worktreeFromInputs` in `workflow({...})`:

```ts
export default workflow({
  name: "safe-implementation",
  description: "",
  inputs: {
    task: Type.String(),
    git_worktree_dir: Type.String({ default: "" }),
    base_branch: Type.String({ default: "origin/main" }),
  },
  outputs: {
    result: Type.String({ description: "Implementation result text." }),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_branch" },
  run: async (ctx) => {
    const result = await ctx.task("implement", { task: String(ctx.inputs.task) });
    return { result: result.text };
  },
});
```

For lower-level integrations, `@bastani/workflows` also exports `setupGitWorktree({ gitWorktreeDir, baseBranch, cwd })`, returning `{ worktreeRoot, cwd, repositoryRoot, created }` with the same validation, symlink-preserving path handling, and cwd-preservation behavior used by workflow stages.

`fallbackModels` retries transient provider/model failures with the primary `model` first, then each fallback, then the current Atomic-selected model when available. It is for rate limits, quota/usage-limit exhaustion (provider messages such as `The usage limit has been reached` and codes such as `usage_limit_reached`/`insufficient_quota` classify as retryable rate-limit failures so the chain advances to a candidate provider/model with remaining headroom), auth/provider outages, unavailable models, network timeouts, generic transport errors such as `Connection error.` / `fetch failed`, and 5xx errors — not workflow-code errors, tool failures, validation failures, or cancellations.

A candidate that is **request/context incompatible** with the current turn — for example an HTTP 400/413/422 bad/unprocessable/payload-too-large request, an unsupported tool or parameter, a context-length/context-window overflow, or a `too large` / `invalid_request` / `bad_request` error — also advances the chain to the next candidate rather than stopping. This ensures that if none of the configured candidates can serve the request, the workflow stage falls back to the currently selected user model instead of hard-failing. Refusals, content-filter/safety blocks, cancellations, and task failures still stop the chain and are never retried on another model.

When a finished stage's session is reattached for a follow-up (for example a post-completion follow-up, or after the CLI is reloaded), the stage resumes on the model the session last settled on — the one that actually worked — instead of replaying the chain from the primary. If that model fails again with a transient/retryable error, the full chain is retried from the primary.

### Reasoning levels

Each `model` and `fallbackModels` entry accepts a `model_name:thinking_effort` suffix that sets the reasoning effort for that candidate (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The selected model's capability map still governs whether `xhigh` or `max` is available. The effort travels with the model string, so a single fallback chain can mix efforts — for example a high-effort primary that degrades to lower-effort, cheaper fallbacks:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-sonnet-4:high",
  fallbackModels: ["openai/gpt-5:medium", "anthropic/claude-haiku-4-5:off"],
});
```

The standalone `thinkingLevel` stage option is deprecated. It still applies as a default to any candidate without a suffix, and when both are present the suffix wins, but new workflows should fold the effort into the model strings:

```diff
-  model: "openai/gpt-5.5",
-  fallbackModels: ["anthropic/claude-opus-4-8"],
-  thinkingLevel: "high",
+  model: "openai/gpt-5.5:high",
+  fallbackModels: ["anthropic/claude-opus-4-8:high"],
```

This applies everywhere a stage accepts a model: direct `ctx.task`/`ctx.chain`/`ctx.parallel` options, `ctx.stage` options, builtin workflow stage definitions, and workflow parameters. `fallbackThinkingLevels` is an optional compatibility helper aligned by index to `fallbackModels`; it applies only to fallback entries that do not already carry a suffix. Each `WorkflowModelAttempt` reports the resolved model and the effective reasoning effort used for that attempt.

### Context windows

A `model`/`fallbackModels` entry may also request a context-window budget with a parenthesized size token in the model-name portion — placed *before or after* the optional `:reasoning` suffix so it never collides with the reasoning level. This mirrors GitHub Copilot's `Claude Opus 4.8 (1M context)` model-name convention:

```ts
await ctx.task("review", {
  task: "Review the diff",
  model: "anthropic/claude-fable-5:high",
  // The copilot opus fallback runs at its largest advertised (long-context) window.
  // Use (long) for a size-agnostic marker, or a rounded long-tier label like (1m).
  fallbackModels: ["github-copilot/claude-opus-4.8 (long):xhigh", "anthropic/claude-opus-4-8:xhigh"],
});
```

The token accepts the same compact sizes as the `--context-window` flag (`1m`, `1.1m`, `936k`, `400k`, or a raw token count), plus a generic `(long)` marker, and is resolved against that specific candidate model's advertised windows:

- `(long)` — a size-agnostic long-context marker that selects the model's advertised long tier regardless of its exact size, so the same token works across models with different long tiers;
- a request at or below the model's default window keeps the default;
- a request above the default selects the long tier — an exact supported window is used as-is, otherwise the smallest supported window at or above the request is selected, rounding **up** so a rounded marker like `(1m)` or `(1.1m)` lands on the long tier even when it sits slightly above or below the marker size (e.g. `(1m)` selects claude-opus-4.8's 1M tier and gpt-5.5's 1.05M tier; `(1.1m)` matches gpt-5.5's rounded long-tier label);
- when the model exposes no larger tier (or is unavailable), the request is dropped and the session keeps the model's default (short) window — a non-strict, automatic fallback.

The budget applies only to the candidate that carries the token; other primary and fallback models in the same chain are unaffected. A parenthesized token that is not a valid size (for example `(preview)`) is left attached to the model id rather than being treated as a context window. Without the token, a tiered model **pins its natural default (short) window** in a workflow stage, so a persisted interactive long-context preference does not leak into workflow runs — use the `(1m)` token or the `contextWindow` stage option to opt into long context. For stage-wide selection you can instead set the `contextWindow` (and `contextWindowStrict`) stage option, which maps to the SDK `createAgentSession` options of the same name.

## Programmatic Usage

`@bastani/workflows` is an Atomic package extension. It registers:

- `/workflow <name> key=value ...` for interactive named runs
- `/workflow connect|attach|pause|interrupt|quit|resume|status|inputs|reload` for live control, inspection, and rediscovery
- the `workflow` tool for agent-initiated orchestration and direct one-off runs
Workflow definition files must export definitions produced by `workflow({...})`. Keep non-workflow runtime helpers (widget factories, shared utilities) in a subdirectory the discovery scan ignores, such as `.atomic/workflows/lib/` — see [Workflow Locations](/workflow-discovery#workflow-locations). The former imperative object-form runner is not part of the public SDK, and authored workflow files cannot import `runWorkflow` from `@bastani/workflows`.

Standalone TypeScript workflow packages type-check the SDK import with no hand-authored `.d.ts`, no `declare module` shim, and no `tsconfig` `paths` alias. The SDK types ship with `@bastani/atomic`, so a workflow package depends only on `@bastani/atomic` (plus a `typebox` peer):

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "map-workflow-sdk",
  description: "Map the workflow SDK.",
  inputs: {
    prompt: Type.String({ default: "map workflow sdk" }),
  },
  outputs: {},
  run: async (ctx) => {
    await ctx.task("map", { prompt: ctx.inputs.prompt });
    return {};
  },
});
```

How those types resolve depends on what else the package imports:

- A package that imports `@bastani/atomic` anywhere (for example, an extension shipped in the same package) picks the workflow SDK types up automatically. `@bastani/atomic`'s root declarations reference the ambient bridge, so no extra configuration is needed.
- A pure workflow-only package — one that imports nothing but `@bastani/workflows` — adds a single opt-in so TypeScript loads the ambient bridge. Set it once for the project in `tsconfig.json`:

  ```jsonc
  {
    "compilerOptions": {
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "types": ["@bastani/atomic/workflows/ambient"]
    }
  }
  ```

  or add a single reference directive at the top of one workflow file:

  ```ts
  /// <reference types="@bastani/atomic/workflows/ambient" />
  ```

Either form makes `import { workflow } from "@bastani/workflows"`, `import { Type } from "typebox"`, and the `@bastani/workflows/builtin/*` composition imports resolve under `tsc` (`moduleResolution: NodeNext`) with no hand-authored `.d.ts`, no `declare module` shim, and no `paths` alias. `@bastani/workflows` is not a separate npm package — its types ship with `@bastani/atomic` — so list both `@bastani/atomic` and `typebox` (workflow files import `Type` from `typebox`) in `peerDependencies`. Runtime discovery and loading via `atomic.workflows` are unchanged: Atomic's loader still supplies the SDK when workflow files execute.

The `workflow` tool still supports direct one-off `task`, `tasks`, and `chain` modes. Direct chains support `chainName` for status/artifact grouping and `chainDir` as a shared directory for relative reads, outputs, and worktree diffs.

Use `createRegistry()` when code needs to group definitions explicitly:

```ts
import { createRegistry, workflow } from "@bastani/workflows";
import { Type } from "typebox";

const alpha = workflow({
  name: "alpha",
  description: "",
  inputs: {},
  outputs: {
    text: Type.String({ description: "Alpha task output text." }),
  },
  run: async (ctx) => {
    const result = await ctx.task("alpha", { prompt: "Run alpha." });
    return { text: result.text };
  },
});

const registry = createRegistry().register(alpha);
registry.names();
registry.get("alpha");
```


## Additional runtime API details preserved from the package README

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
- If the path is missing, the parent directory is created and Git runs `git worktree add --detach <path> <baseBranch>`. `baseBranch` defaults to `HEAD` when omitted. Missing targets whose existing parent resolves through a symlink beneath the invoking checkout are rejected.
- The default execution cwd preserves the caller's repo-relative cwd inside the worktree. For example, invoking a workflow from `repo/packages/api` with `gitWorktreeDir=../repo-wt` uses `../repo-wt/packages/api` for workflow `ctx.cwd` and stage/task execution.
- Symlinked repo/worktree paths preserve their logical spelling in the default cwd, matching Codex-style worktree behavior.
- An explicit absolute `cwd` inside the invoking checkout is remapped to the corresponding worktree path; an absolute `cwd` already inside the selected worktree is preserved. Relative values resolve from the worktree default cwd and cannot escape it. Foreign paths, lexical traversal, and symlink escapes fail before a session starts.
- Runner-managed relative direct output paths follow that effective worktree cwd and cannot traverse or follow symlinks outside the selected worktree. Explicit absolute outputs and nonblank explicit `chainDir` locations remain caller-selected; blank `chainDir` values are treated as omitted.

`worktree: true` is different: it creates temporary isolated worktrees for direct task/parallel/chain execution and cleans them up afterward, including failures before the workflow callback starts. When no task `cwd` is set, temporary isolation starts from the runner invocation cwd; relative task cwd values resolve from that same invocation cwd. Relative direct outputs without a nonblank `chainDir` are persisted under distinct per-task runner-owned temporary artifact directories before cleanup; returned output artifact paths therefore remain readable, including with `outputMode: "file-only"`. Those relative paths cannot traverse or follow symlinks outside their runner-owned output root, and a pre-existing symlink or junction at the trusted artifact root is rejected. It is mutually exclusive with `gitWorktreeDir`, which is intended for named/reusable worktrees that remain available across retries and `/workflow resume`. Durable resume records the original invocation cwd and resolved reusable-worktree metadata, then replays from that original repository context rather than whichever cwd the resumed interactive session currently has. Reusable worktree setup is cached by canonical repository and target identity within a workflow run, independent of equivalent path spelling or `baseBranch`, and the selected checkout identity is revalidated before reuse. Read-only Git repository probes retry a transient timeout once, and slow Git subprocess failures include the exact command, cwd, timeout, elapsed time, exit status/signal, and spawn error details.

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

## Extension surfaces preserved from the package README

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

Named workflow launches always run as **background tasks** in interactive sessions. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Model-launched direct `task`, `tasks`, and `chain` calls must set top-level `async: true` so the chat editor stays free, and their raw/rendered accepted results include the same connect guidance; inspection and control calls are unaffected. Foreground launches are reserved for explicit user requests or technical requirements, with notice before launch. Press **F2** to open the same live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor/custom`) appear as awaiting-input graph nodes. Press Enter on a focused node, or click a visible graph node directly, to open that stage and answer locally, never as a modal dialog over the chat. `ctrl+x` is the workflow hierarchy chord: attached stage chats show **ctrl+x return to graph**, while graph surfaces show **ctrl+x leave graph · return to main chat**. Workflow surfaces consume it before configurable editor/tool actions. Composer and prompt drafts survive leaving a stage, and pending custom questions remain pending for reattachment. `ctrl+d` and `q` are not workflow navigation controls; ordinary editor/prompt Ctrl+D behavior and printable prompt `q` remain available. Existing `esc`, `ctrl+c`, and graph `h` close/hide behavior is unchanged. While the graph pane is active, vertical wheel/trackpad gestures pan vertically and horizontal gestures pan wide graphs left and right when the terminal reports them, without falling through to the main chat or terminal scrollback. Attached stage chats capture mouse/trackpad wheel events by default so scrolling stays inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback. Press `ctrl+t` to toggle **copy mode**: copy mode disables workflow-chat mouse reporting so normal terminal/tmux text selection can work; press `ctrl+t` again to leave copy mode and restore workflow-chat scrolling. Archived read-only stage transcripts show the same copy-mode footer/status, allowing their transcript text to be selected and copied while preserving `esc` close and `ctrl+x` graph navigation. While copy mode is on, wheel/trackpad gestures are handled by the terminal/tmux and may scroll terminal scrollback, so leave copy mode before using the wheel again. Human input is detected when those runtime `ctx.ui.*` calls execute; workflows no longer have a declaration-time HIL flag.

Graceful quit is idempotent for already-paused runs and preserves unresolved `ctx.ui` prompts in DBOS. Stable author-callsite-and-composed-nested-scope reservations are created before prompting and released by exact current-format token generation after answer checkpoint, rejection, or abort. Answering while quit/paused cannot advance workflow code until explicit resume.

Workflow durability requires DBOS/Postgres. Atomic configures and launches DBOS lazily on the first workflow action, reuses that process-wide instance, and awaits readiness before durable execution or control. Initialization or persistence failures fail the workflow action; no alternate backend is selected. `DBOS_SYSTEM_DATABASE_URL` selects an existing database when supplied; otherwise Atomic runs DBOS against its own embedded Postgres (npm-distributed binaries, detached `pg_ctl` daemon under `~/.atomic/postgres` on port 5439, shared across sessions and never stopped by Atomic), with DBOS's `dbos-db` Docker container only as a platform fallback. Concurrent Atomic sessions safely share one database: unique per-process executor ids, owner/heartbeat metadata on running workflows, and first-writer-wins claims on contended status transitions prevent double dispatch. Running workflows never appear as resume targets in any session; stale-heartbeat (crashed) ones surface as red `crashed` rows, paused rows render yellow, failed/blocked red, completed green, and the open picker live-updates on local changes plus a bounded cross-session poll.

DBOS is the only durable catalog for resume, completed inspection, deletion, and targeted lookup. Session JSONL files are never scanned as a workflow catalog; with `persistRuns` enabled they may also contain workflow lifecycle metadata, inputs, outputs, errors, and stage-session references. Atomic reads and writes one current format; prior local workflow state and older DBOS records are not converted or discovered.

Nested `ctx.workflow(...)` calls are displayed as an expanded graph within the top-level run. `/workflow status` and run pickers list only top-level user-launched workflows, not implementation-owned child runs. The `workflow` tool's `stages`, `stage`, `transcript`, `send`, `pause`, `interrupt`, and `resume` actions can still target visible child stage ids, prefixes, or names from the expanded graph; Atomic routes the control action to the owning nested run internally. The run-level `quit` action targets the selected top-level run or all live top-level runs. (`stages`, `stage`, `transcript`, and `send` are `workflow` tool actions, not `/workflow` slash subcommands; the slash command exposes `connect`, `attach`, `pause`, `list`, `status`, `interrupt`, `quit`, `resume`, `reload`, and `inputs`.)

Prompt-answer replay through the live store is memory-only. `StageSnapshot.promptAnswerState` reports whether continuation can replay a prompt answer (`available`), must ask again because the private ledger entry is gone (`unavailable`), or must ask again because multiple matching prompt nodes are ambiguous (`ambiguous`). Raw answers in the private live-store `PromptAnswerRecord` ledger are never serialized into stage snapshots and remain resident until the answer is cleared, the run is removed, or the store is cleared. Durable `ctx.ui.input`, `confirm`, `select`, `editor`, and `custom` responses are separately stored as DBOS UI checkpoint response values so they can replay after restart; treat that database as sensitive. Replay identity uses prompt kind, message, select choices, input/editor initial value, custom prompt identity hash, and a hashed author callsite. Changing any of those identity inputs intentionally creates a different prompt and may re-prompt. An empty `select` choice list throws before a node is created. A pending custom widget cannot be answered through `workflow send`.

### `workflow` tool (LLM-callable)

{/* Keep the description below in sync with WORKFLOW_TOOL_DESCRIPTION in packages/workflows/src/extension/workflow-prompts.ts; integration tests assert this. */}

```json
{
  "name": "workflow",
  "description": "Run named builtin, project, user, or package workflows, or direct one-off task/tasks/chain workflows; custom definitions may import reusable project/package workflows or builtin definitions from @bastani/workflows/builtin and nest them with ctx.workflow(...), including deeper composition within the configured maxDepth; when workflow execution fits but another shape would better achieve the task, author a custom TypeScript workflow({...}) inline with normal coding tools, reload it, and run it; discover with list/get/inputs, inspect status/stages/stage details, send prompt answers or steering, pause/resume/interrupt/quit runs, and reload workflow resources. For large stage handoffs, write context to files/artifacts, pass paths via reads, and prompt downstream agents to 'Read the file at <path>...' instead of injecting large previous text. For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview.",
  "parameters": {
    "workflow": "string (optional) — workflow ID or normalized name",
    "inputs": "object (optional) — key/value map of workflow inputs",
    "action": "'run' | 'list' | 'get' | 'inputs' | 'status' | 'stages' | 'stage' | 'transcript' | 'send' | 'pause' | 'interrupt' | 'quit' | 'resume' | 'reload'",
    "runId": "optional run id or unique prefix; control actions default to the active run where safe; use '--all' or all:true for pause/interrupt/quit all",
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
    "all": "optional boolean for pause/interrupt/quit all; cannot be combined with stageId",
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
- **`send`** — answers pending primitive/structured stage prompts only when `text`, `response`, or `message` is present; an explicit empty string is a valid answer, while an omitted payload is a no-op. Follow-ups to eligible terminal agent stages revive an interactive **post-mortem chat** through the shared resolver: on a live-handle miss the stage's retained `sessionFile` is validated (existing, readable, context-bearing) and reopened as a detached, single-flight handle so the message is delivered as a conversational follow-up appended in place — the same path used by `/workflow attach`, restored/replayed durable snapshots, and completed-workflow inspection — without resuming, retrying, or re-dispatching workflow execution. If no valid retained session exists, the follow-up is refused (`No live handle for stage.`) instead of silently resetting or exposing a handle-less non-terminal session. Arbitrary `ctx.ui.custom<T>` widget prompts require the interactive workflow graph and return a clear unsupported message when targeted through `send`. `delivery: "auto"` answers pending prompts first, then resumes paused stages, steers streaming stages, or queues a follow-up.
- **`reload`** — refreshes workflow resources directly in-process instead of queuing a literal `/workflow reload` chat follow-up.

### F2 keyboard shortcut

Press **F2** while a workflow is running to open the DAG overlay for the active run.

### Execution model

`@bastani/workflows` follows Atomic's package/extension model: this bundled package currently declares `src/extension/index.ts` through its legacy `pi.extensions` manifest entry, while the loader also supports the preferred `atomic.extensions` key for packages that declare it. The extension registers the `workflow` tool, `/workflow` slash command, renderers, widget, and lifecycle hooks in-process.

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

The `workflow` tool still supports direct one-off `task`, `tasks`, and `chain` modes for agent-initiated orchestration. Those direct modes are runtime tool inputs, not workflow definition files.

For large handoffs, prefer artifact paths over prompt injection: write stage output to `output`, set `outputMode: "file-only"` when the parent only needs the path, pass paths with `reads`, and instruct downstream agents explicitly with wording like `Read the file at <path>...`. Reserve `previous`/`{previous}` for compact summaries; avoid passing full session histories, all prior stage outputs, or every review round directly into the next model prompt. In review loops, save JSON review artifacts and pass only the latest review-round artifact, with a ledger or index file linking older rounds when needed.

Workflow stage sessions follow Atomic SDK directory defaults: `DefaultResourceLoader` is initialized with the project `cwd` and the Atomic default `~/.atomic/agent` directory, while legacy `.pi` paths remain readable where the SDK supports multiple config directories. A stage-supplied `agentDir` is treated as an explicit user override; a stage-supplied `resourceLoader` owns discovery, with `cwd`/`agentDir` left for session naming and tool path resolution.

To inspect a workflow's input schema inside pi, use `/workflow inputs <name>` or `/workflow <name> --help`.


## Model reasoning details preserved from the package README

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
