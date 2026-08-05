<h1 align="center">Atomic Workflows</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  An open-source Atomic workflow extension: install it, author workflows in TypeScript, run them from chat.
</p>

Default to workflows for non-trivial work and requests with inherent structure plus a verifiable objective; reserve direct chat for tiny deterministic low-risk work. Workflow-first is not builtin-only or monolithic: Atomic can author custom TypeScript `workflow({...})` definitions inline, import reusable project/package workflows or builtins from `@bastani/workflows/builtin`, and nest them with `ctx.workflow(...)`. Imported children may nest further workflows within `maxDepth`, so compose proven research, implementation, design, verification, and approval graphs rather than copying them. Custom parents can also use runtime classification, dynamic fan-out and synthesis, adversarial verification, candidate tournaments, HIL gates, and bounded convergence.

Workflow stage sessions are created in process and receive a typed stage policy rather than inheriting subagent environment flags. Resource reload never mutates `process.env`; stage options carry the subagent management/fanout policy directly, so concurrent stage creation is race-free while existing tool allowlists and orchestration depth limits remain authoritative. Legacy child environment keys are only a compatibility path for older hosts.

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

Workflow lifecycle notices are enabled by default. They send steer prompts into the main chat/model context when a run completes, fails, or ends blocked, and when a user starts, pauses, quits, or resumes one. Awaiting-input prompts are tracked for dedupe/restore, but they do not wake the main chat agent. Configure lifecycle tracking in the same extension config file:

```json
{
  "workflowNotifications": {
    "enabled": true,
    "notifyOn": ["started", "completed", "failed", "blocked", "awaiting_input", "paused", "quit", "resumed"]
  }
}
```

Set `enabled` to `false` to disable all lifecycle notices, or narrow `notifyOn` to a non-empty list of selected events. Completion, failure, and blocked lifecycle notices are emitted for top-level workflow runs, use steer delivery, and wake an idle model so the lifecycle update enters the model context when it happens. When a fulfilled workflow body leaves admitted tool failures, the engine promotes the first admission and persists that exact tool origin for the failed notice. Ordinary body rejections retain their original error and failed graph nodes without claiming a tool origin because transparent native promises do not expose the source promise; this prevents a caught tool rejection from being misattributed when body code later throws the same object or primitive. Nested child workflow completion/failure is reflected inside the expanded parent graph instead of producing separate top-level completion cards. Awaiting-input states are tracked for dedupe/restore, but workflows do not enqueue main-chat `/workflow connect` cards for them; prompt state remains visible through workflow status/connect surfaces, avoiding stale actionable cards if a prompt resolves while the main chat is streaming.

Control notices report deliberate actions on a top-level run: `/workflow <name>` produces a `WORKFLOW STARTED` card (`▶`), `/workflow pause` a `WORKFLOW PAUSED` card (`⏸`, warning tone), `/workflow quit` a `WORKFLOW QUIT` card (`⏹`, warning tone, plus a `resumable` field), and `/workflow resume` a `WORKFLOW RESUMED` card (`▶`). All four travel the same steer delivery, capped-backoff retry, and card path as the failure notice. The paused and quit text says the stop was deliberate and user-requested and instructs the model not to resume the run or take the work over unless asked, hinting `/workflow resume <run-id>`; the resumed text does not, since the run is progressing again.

Only user actions notify. The matching `workflow({ action: "run" | "pause" | "quit" | "resume" })` tool calls stay silent, because the tool result already reports them to the agent, and `/workflow interrupt` raises nothing. Engine-internal transitions stay silent too — a notice exists only when a control path named an actor — which is what keeps answering a human-in-the-loop prompt, per-stage control, and the resume-acknowledgement pass from flooding the chat.

Each notice carries two attributions. *Origin* is who launched the run and renders on every kind as "which you started" or "which the user started"; it is recorded once at dispatch, persisted through session restore and durable resume, and inherited by a continuation from the run it continues. *Actor* is who performed this one event ("The user paused"). A run with no recorded origin omits the clause rather than guessing one.

One request produces one notice. A whole-run pause or resume reports at run scope; a stage-scoped pause or resume that leaves siblings paused reports at stage scope, and one that stops or restarts the whole run reports the run instead. A quit reports the quit alone, never the pause it publishes on the way. Because control actions are reversible, they are deduplicated by run id together with the occurrence timestamp (`pausedAt`/`quitAt`/`resumedAt`), so pause → resume → pause → resume notifies four times while repeated snapshot invalidations at one unchanged state notify once. Resuming reports a resume and never a start, whoever asked for it. Resuming a failed or blocked run launches a continuation under a fresh run id and its notice names both; resuming a quit run reuses the original workflow id so durable checkpoints replay, so that notice names the one id. A run already started, paused, or quit when notifications install (restore, replay, `/reload`, session-preserving reinstall) is seeded as delivered and stays silent, and nested child runs never notify at top level.

When a stage human-in-the-loop prompt is answered from the workflow TUI/stage chat, workflows also emits a separate display-only `workflows:hil-answer-notice` custom message. It records the answer for user-visible audit, but it does not wake the main agent, enter LLM context, or authorize answering later workflow prompts. Answers sent by the main-chat `workflow` tool do not emit this notice because the tool result already tells the main agent what happened.

---

## Authoring API

### Dynamic topology is DAG-only

Atomic `workflow({ run })` definitions are imperative, dynamic TypeScript. Discovery loads modules and validates imports and definition shape, but it does not compile every `run` path into a complete graph or prove acyclicity. Runtime inputs, branches, loops, external data, model or human output, helpers, and nested workflows determine the materialized topology during execution.

**Cyclic workflow graphs are unsupported. Authors and coding agents MUST NOT create a self-edge or a dependency edge from the current frontier to an existing ancestor. Every materialized execution topology must remain a DAG. Redesign or stop before launch if a cycle cannot be removed.**

Sketch branches, loops, and nested boundaries before launch. Bounded loops must create distinct tracked work per iteration with stable identity and call order; never reopen an ancestor beneath its downstream work. Compose children through `ctx.workflow(...)` boundaries rather than recursive `run` invocation. Keep retained-session follow-up that creates no dependency work as activity, not a back-edge.

Execution, replay, and DBOS hydration are the authoritative topology-validation points. Runtime topology changes should add incremental edge checks and DBOS hydration validation; prompt guidance and TypeScript types cannot replace these checks.

### Workflow-owned side effects

Prefer `ctx.tool(name, args, fn)` for workflow-owned TypeScript operations with side effects, including filesystem writes, network mutations, external API actions, and similar deterministic operations orchestrated directly by the workflow definition. Each invocation creates a non-chat, non-attachable durable graph node before `fn` runs; it may appear before, between, after, or without model stages. Atomic durably caches a completed call's serializable result, so resume returns that result without rerunning `fn` or repeating the side effect. Tool-only workflows are valid tracked execution, while a normal return with no stage, child, tool, or explicit exit remains invalid. Keep pure computation and side-effect-free transformations as ordinary TypeScript. Do not wrap agent-stage internals or every function call indiscriminately. The executor closes tool admission before publishing any terminal outcome; calling a retained `ctx.tool` function afterward returns a rejected native promise and creates no callback, retry, graph node, or checkpoint.

Checks that may fail as part of a repair loop can opt into `failureMode: "return"`. That overload returns a typed `{ ok: true, value, attempts, cached } | { ok: false, error, attempts, cached }` outcome after configured retries. Failure details preserve exposed `exitCode`, `stdout`, and `stderr`; persisted text is best-effort secret-redacted and limited to 16 KiB per field. A recoverable failure keeps its tool node failed but lets author code continue. Replay returns the same durable outcome with `cached: true` and does not rerun the callback. Cancellation and storage faults still throw. Atomic never injects this evidence into a later prompt: pass the needed fields to a repair stage or artifact explicitly, and use distinct serializable arguments for each bounded rerun.

New tool checkpoints retain stable graph identity, invocation order, parents, and timing. A current-format checkpoint created before tool topology was added still replays safely: its cached output remains authoritative and the callback is never rerun. Root inspection derives deterministic fallback identity/order from checkpoint identity and record order; replay inside a child attempts to append topology metadata with the current child/boundary ownership without replacing the original output checkpoint. That additive migration write is best-effort: a storage rejection leaves the live replay cached in its inferred child, does not poison a later durable flush, and is retried by a later replay. Until one retry succeeds, a fresh completed inspection can only show the legacy record through the deterministic root fallback with topology unavailable; historical child ownership cannot be reconstructed from the old record alone. Fresh completed inspection reconstructs available tool topology but does not persist a workflow's declared root output; that existing limitation is separate from live `run()` output and graph correctness.

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
import { adversarialVerification, fanOutAndSynthesize } from "@bastani/workflows/builtin";

export default workflow({
  name: "research-and-verify",
  description: "Map repository slices, synthesize cited evidence, then verify the report.",
  inputs: { topic: Type.String() },
  outputs: {
    report_path: Type.String(),
    approved: Type.Boolean(),
  },
  run: async (ctx) => {
    const research = await ctx.workflow(fanOutAndSynthesize, {
      inputs: {
        prompt: `Partition repository research for: ${ctx.inputs.topic}. Save cited findings per slice and synthesize conflicts.`,
        max_branches: 6,
      },
    });
    if (research.exited) return ctx.exit({ status: research.status, reason: research.exitReason ?? "research stopped early" });

    const verification = await ctx.workflow(adversarialVerification, {
      inputs: { task: `Verify the cited report at ${research.outputs.synthesis_path}` },
    });
    if (verification.exited) return ctx.exit({ status: verification.status, reason: verification.exitReason ?? "verification stopped early" });

    return {
      report_path: research.outputs.synthesis_path,
      approved: verification.outputs.approved,
    };
  },
});
```

The child executes as a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default, but user-facing status and graph views recursively replace that boundary with a valid, non-empty child graph whose run reciprocally identifies the parent run and boundary stage. Every boundary parent connects to every child root, and every child terminal connects to each downstream dependent. Repeated or sibling children keep distinct virtual node ids and exact `{ runId, stageId }` control targets even when local stage ids or names collide, so attach, send, pause, interrupt, resume, stage selection, and post-mortem chat reach the true owning run and stage. Implementation-owned child runs stay out of top-level `/workflow status` lists.

For durable runs, Atomic writes and awaits a versioned boundary-start identity before child code can run. That record fixes the boundary id, child run id, owning root/parent, source order and parents, replay scope, alias, workflow, and a deterministic fingerprint of the child definition plus exact validated inputs across pause, process restart, cached replay, and completed inspection. Distinct-input parallel calls therefore keep their own cache even when restart reverses dispatch order; repeated identical calls share the fingerprint but retain a per-invocation ordinal. A completed child boundary and its `ctx.tool` side effects replay exactly once from the root's scoped checkpoints; only incomplete work continues.

If no valid child graph can stand in for the boundary—including a failed or skipped boundary, a missing or empty child graph, stale or mismatched ownership metadata, or a recursive link that cannot produce a valid expansion—the expanded graph keeps the boundary summary instead of flattening an unrelated or invalid child. Exact expanded ids resolve first; a local id, prefix, or stage name is accepted only when it identifies one visible stage. Inputs are strictly validated against the child workflow before it starts: unknown keys, missing required values, type mismatches, and invalid `select` choices fail before the child body runs. The parent receives the child's declared `outputs` on `child.outputs` after those outputs pass their declared runtime type checks.

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
  adversarialVerification,
  classifyAndAct,
  fanOutAndSynthesize,
  generateAndFilter,
  goal,
  loopUntilDone,
  openClaudeDesign,
  ralph,
  tournament,
} from "@bastani/workflows/builtin";
import fanOutAndSynthesizeWorkflow from "@bastani/workflows/builtin/fan-out-and-synthesize";
import goalWorkflow from "@bastani/workflows/builtin/goal";
import ralphWorkflow from "@bastani/workflows/builtin/ralph";
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
| `/workflow attach [run-id] [stage]`   | Open live stage chat or explicit terminal post-mortem chat |
| `/workflow pause [run-id] [stage]`    | Pause a live run or stage                                |
| `/workflow interrupt [run-id\|--all]` | Pause active/named/all active runs so they can resume    |
| `/workflow quit [run-id\|--all]`      | Gracefully pause live workflow runs so they can resume later          |
| `/workflow resume <run-id>`           | Resume paused work or re-open a run snapshot             |
| `/workflow reload`                    | Reload discovered workflow resources and package-manifest entries in-process |
| `/workflow inputs <name>`             | Print the input schema for a workflow                    |

Input overrides are bare `key=value` tokens (no leading `--`). Values are JSON-parsed when possible, so numbers, booleans, and quoted strings work as expected (e.g. `count=3`, `flag=true`, `prompt="multi word value"`). A whole-object override can be passed as a single JSON token (e.g. `{"prompt":"...","count":3}`). Runtime validation is strict: unknown input keys, missing required values, type mismatches, and invalid `select` choices fail before a named workflow run starts.

Named workflow launches always run as **background tasks** in interactive sessions. Run `/workflow connect <run>` to see agents working and chat with and steer each stage. Foreground launches are reserved for explicit user requests or technical requirements, with notice before launch. Press **F2** to open the same live graph viewer; HIL prompts (`ctx.ui.input/confirm/select/editor/custom`) appear as awaiting-input graph nodes. Press Enter on a focused node, or click a visible graph node directly, to open that stage and answer locally, never as a modal dialog over the chat. `ctrl+x` is the workflow hierarchy chord: attached stage chats show **ctrl+x return to graph**, while graph surfaces show **ctrl+x leave graph · return to main chat**. Workflow surfaces consume it before configurable editor/tool actions. Composer and prompt drafts survive leaving a stage, and pending custom questions remain pending for reattachment. `ctrl+d` and `q` are not workflow navigation controls; ordinary editor/prompt Ctrl+D behavior and printable prompt `q` remain available. Existing `esc`, `ctrl+c`, and graph `h` close/hide behavior is unchanged. While the graph pane is active, vertical wheel/trackpad gestures pan vertically and horizontal gestures pan wide graphs left and right when the terminal reports them, without falling through to the main chat or terminal scrollback. Attached stage chats capture mouse/trackpad wheel events by default so scrolling stays inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback. Press `ctrl+t` to toggle **copy mode**: copy mode disables workflow-chat mouse reporting so normal terminal/tmux text selection can work; press `ctrl+t` again to leave copy mode and restore workflow-chat scrolling. Archived read-only stage transcripts show the same copy-mode footer/status, allowing their transcript text to be selected and copied while preserving `esc` close and `ctrl+x` graph navigation. While copy mode is on, wheel/trackpad gestures are handled by the terminal/tmux and may scroll terminal scrollback, so leave copy mode before using the wheel again. Human input is detected when those runtime `ctx.ui.*` calls execute; workflows no longer have a declaration-time HIL flag.

Typing into an attached stage chat and pressing Enter steers: the message is consumed after the current assistant response finishes its tool batch and before the next model request, matching normal session steering. Ctrl+F queues a follow-up, consumed only when the agent would otherwise stop. Queued entries belong to the stage session rather than the pane, so leaving the stage and reattaching restores the pending `Steering:` / `Follow-up:` rows, and a detached stage node carries a `✉ N queued` badge in the graph.

Named launches return only after startup admission, while the admitted workflow body and stages remain background work. Pre-body setup failures (including invalid input-bound reusable worktrees) are returned immediately from the original tool call as structured failed results with the concrete error and allocated run id; Atomic does not first claim that the workflow started, and it removes the unadmitted run so corrected inputs can be retried immediately. Failures after admission continue to use normal background status and lifecycle notices.

Graceful quit is idempotent for already-paused runs and preserves unresolved `ctx.ui` prompts in DBOS. Pausing or interrupting a stage also holds every queued steering and follow-up item in place: no queued turn, late context-bearing delivery, or workflow continuation starts while the stage is paused, and the existing `resume` action releases the items once in their existing per-queue order without queue release itself starting a provider turn. Stable author-callsite-and-composed-nested-scope reservations are created before prompting and released by exact current-format token generation after answer checkpoint, rejection, or abort. Answering while quit/paused cannot advance workflow code until explicit resume.

Workflow durability requires DBOS/Postgres. Atomic configures and launches DBOS lazily on the first workflow action, reuses that process-wide instance, and awaits readiness before durable execution or control. Initialization or persistence failures fail the workflow action; no alternate backend is selected. `DBOS_SYSTEM_DATABASE_URL` selects an existing database when supplied; otherwise Atomic runs DBOS against its own embedded Postgres (npm-distributed binaries, detached `pg_ctl` daemon under `~/.atomic/postgres` on port 5439, shared across sessions and never stopped by Atomic), with DBOS's `dbos-db` Docker container only as a platform fallback. Concurrent Atomic sessions safely share one database: unique per-process executor ids, owner/heartbeat metadata on running workflows, and first-writer-wins claims on contended status transitions prevent double dispatch. Running workflows never appear as resume targets in any session; stale-heartbeat (crashed) ones surface as red `crashed` rows, paused rows render yellow, failed/blocked red, completed green, and the open picker live-updates on local changes plus a bounded cross-session poll.

DBOS is the only durable catalog for resume, completed inspection, deletion, and targeted lookup. Session JSONL files remain chat transcripts only. Atomic reads one current durable format and does not convert prior local state or pre-current DBOS records. A completed current-format child checkpoint created before boundary-start or invocation-fingerprint identity existed is shown only when its child checkpoints reciprocally prove the same root, parent run, boundary, child owner, and scope. Active checkpoints without a provable invocation fingerprint, and malformed, duplicate, stale, nonreciprocal, mixed, aliased, cyclic, orphaned, or unsupported topology, fail closed before cache exposure or child/control dispatch: Atomic does not invent a child link or execute child code to repair it.

Nested `ctx.workflow(...)` calls are displayed as an expanded graph within the top-level run. `/workflow status` and run pickers list only top-level user-launched workflows, not implementation-owned child runs. After a fresh process starts, active and completed graphs retain source stage ids, order, parent edges, lifecycle status, boundary ownership, and exact `{ runId, stageId }` control targets. The `workflow` tool's `stages`, `stage`, `transcript`, `pause`, `interrupt`, and `resume` actions route a uniquely identified visible child stage to that nested owner; `send` uses the same routing only while the root is nonterminal, and ambiguous local ids or names are rejected. Run-level `quit` still targets the selected top-level run or all live top-level runs. Completed graph inspection is read-only even when no stage transcript remains. `/workflow attach <root-run> <nested-stage>` remains the explicit user-driven path for retained post-mortem chat and routes to the true child owner without resuming or mutating execution. Programmatic `workflow send` rejects terminal roots before nested-owner routing or session probing. (`stages`, `stage`, `transcript`, and `send` are `workflow` tool actions, not `/workflow` slash subcommands; the slash command exposes `connect`, `attach`, `pause`, `list`, `status`, `interrupt`, `quit`, `resume`, `reload`, and `inputs`.)

Raw stage-chat prompt answer replay is live-memory only. `StageSnapshot.promptAnswerState` reports whether continuation can replay a raw stage-chat answer (`available`), must ask again because the private ledger entry is gone (`unavailable`), or must ask again because multiple matching prompt nodes are ambiguous (`ambiguous`). Raw answers stay in a private `PromptAnswerRecord` ledger, are never serialized to snapshots or persistence, and remain resident in memory until the answer is cleared, the run is removed, or the store is cleared. Durable `ctx.ui` responses are separate DBOS checkpoints: resume returns those cached responses without asking again, and graph-backed UI re-materializes the answered prompt node from metadata. Replay keys include prompt kind, message text, select choices, input/editor initial value, custom prompt identity hash, and hashed author callsite, so changing any of those inputs may intentionally re-ask on continuation. Empty `ctx.ui.select(..., [])` calls throw before creating a prompt node. Arbitrary custom-widget answers cannot be supplied with `workflow send`; focus the `custom` awaiting-input node in the interactive graph instead.

### `workflow` tool (LLM-callable)

<!-- Keep the description below in sync with WORKFLOW_TOOL_DESCRIPTION in packages/workflows/src/extension/workflow-prompts.ts; integration tests assert this. -->

```json
{
  "name": "workflow",
  "description": "Run named builtin, project, user, or package workflows; custom definitions may import reusable project/package workflows or builtin definitions from @bastani/workflows/builtin and nest them with ctx.workflow(...), including deeper composition within the configured maxDepth; when workflow execution fits but another shape would better achieve the task, author a custom TypeScript workflow({...}) inline with normal coding tools, reload it, and run it; after successfully creating and reloading a newly authored custom workflow, report the folder containing its generated code as 'Custom workflow created. You can inspect its code at: <workflow-folder-path>'; do this only for newly created custom workflows, never builtin or pre-existing workflows; discover with list/get/inputs/models, list session runs with status (no runId; statusFilter narrows the list), inspect status/stages/stage details, send prompt answers or steering only while the root workflow is nonterminal, pause/resume/interrupt/quit runs, and reload workflow resources. For large stage handoffs, write context to files/artifacts, pass paths via reads, and prompt downstream agents to 'Read the file at <path>...' instead of injecting large previous text. Wrap critical parts of run inputs and steering messages in <keepContext>...</keepContext> so compaction preserves them verbatim in the stages that inherit them; tag role constraints, prohibitions, must-hold criteria, and identifiers, not background or bulk reference material. For transcripts, prefer status/stages/stage to get sessionFile/transcriptPath, quote the exact path without rewriting separators (Windows backslashes are valid), then search it with rg/grep and read small ranges; transcript is path-only by default when sessionFile/transcriptPath exists, explicit tail/limit returns bounded previews, and missing transcript paths fall back to a small preview. Use action 'models' to inspect models in the configured catalog; the result is a configured-auth snapshot showing what's present in the registry with configured authentication, not proof of credentials, entitlements, OAuth freshness, or live provider access. When authoring a workflow that should dynamically select a model, first call workflow({ action: 'models' }) to inspect the configured catalog, then select from the returned provider/id entries considering the isCurrent marker and available thinking levels.",
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
- **`send`** — operates only while the authoritative root workflow is nonterminal. It answers pending primitive/structured stage prompts only when `text`, `response`, or `message` is present; an explicit empty string is a valid answer, while an omitted payload is a no-op. `delivery: "auto"` answers pending prompts first, then resumes paused stages, steers streaming stages, or starts/queues the eligible live turn. Terminal `completed`, `failed`, `skipped`, `cancelled`, `killed`, and terminal `blocked` roots fail closed with `status: "failed"`, `code: "WORKFLOW_TERMINAL"`, `delivery: "rejected"`, the requested root id/status, and guidance to start a new workflow (or proceed inline only for small, deterministic, low-risk work). The preflight guard rejects already-terminal roots before stage resolution, nested-owner routing, prompt inspection, retained-session probing/revival, handle lookup, message admission, or delivery selection, so it creates no session/handle/model/tool/file work, appends no transcript, answers no input, and mutates no workflow/stage snapshot. Missing or malformed retained sessions receive the same error without probing. A second check against the same shared authority runs at final synchronous SDK admission: if a live root terminates while retained-session creation is pending, Atomic rejects the send, disposes its unclaimed provisional session/handle, and starts no prompt, model, tool/file, transcript, or workflow-state work. Concurrent explicit `/workflow attach` or Intercom claims remain independent. Use `/workflow attach <run-id> <stage>` as the user-driven post-mortem path; that chat can append to a valid retained session but never resumes or changes workflow execution state.
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

Custom `AgentSessionAdapter` runtimes may optionally expose `queuedMessagesPaused`, `pauseQueuedMessages()`, and `resumeQueuedMessages()` on public `StageSessionRuntime`. Existing adapters that omit them retain the prior fallback pause behavior: the active call is aborted and runner-admitted public deliveries stay deferred until explicit resume. When both methods are present, Atomic uses the stronger native hold so raw queued steer/follow-up work is gated before abort settles and released without starting a provider turn. Atomic's official runtime implements this optional capability.

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

### Repository-wide research

For broad repository uncertainty, compose `fan-out-and-synthesize` with a partition prompt that produces distinct subsystem slices, writes each branch to an artifact, and requires the synthesis barrier to cite concrete paths and resolve conflicting findings. Use `/skill:research-codebase` when one focused subsystem or question is enough.

```text
/workflow fan-out-and-synthesize prompt="Partition session persistence by subsystem, save cited findings per branch, and synthesize the end-to-end flow"
```

### Task-specific implementation and review

Domain-specific implementation should use a custom worker → fresh verifier → reducer graph when no installed pattern covers the complete contract. Keep literal acceptance criteria visible to each reviewer, execute deterministic checks through workflow-owned tools, consolidate evidence-backed findings into bounded repair rounds, and stop on explicit approval, blocked evidence, or iteration exhaustion. Keep PR/MR creation, release, deployment, and publication as separately authorized post-approval actions.

### `goal`

Goal runs a bounded autonomous implementation loop with a durable objective ledger, immutable acceptance criteria, sub-agent orchestration receipts, parallel reviewers, and a deterministic reducer. It returns `complete`, `blocked`, or `needs_human`; set `create_pr=true` only to authorize the final PR/MR/review stage after approval.

```text
/workflow goal objective="Update CLI docs, add one example, and validate the docs build"
```

Inputs: required `objective`; optional `acceptance_criteria`, `max_turns=10`, `base_branch=origin/main`, `git_worktree_dir=""`, and `create_pr=false`.

### `ralph`

Ralph runs prompt refinement, codebase research, delegated implementation, and independent multi-model review in a bounded loop. It can start from a task, issue, or spec path; set `create_pr=true` only to authorize the post-approval final stage.

```text
/workflow ralph prompt="Implement specs/rate-limit.md and validate burst traffic" max_loops=3
```

Inputs: required `prompt`; optional `acceptance_criteria`, `max_loops=10`, `base_branch=origin/main`, `git_worktree_dir=""`, and `create_pr=false`.

For either workflow, keep PR/MR creation out of the task text and pass the original task as `acceptance_criteria` on follow-up runs to prevent contract drift.

### `open-claude-design`

Combined discovery/init → design-system/reference research → curated reference discovery with user preference check → separate forked generate and user-feedback chains → export/handoff pipeline. The `discovery` stage asks for output type and references, then runs impeccable init in the same stage so PRODUCT.md/DESIGN.md are detected, created, or reconciled. `ds-*` stages handle user-provided URL/file reference extraction directly, then `reference-discovery` uses that context and asks which curated direction you prefer (or asks for a reference image/path/URL if none fit). Export is only `exporter` plus `final-display`.

Each refinement round pauses at a deterministic run-level prompt before its `user-feedback-*` stage starts (the stage's browser long-poll never sets `awaiting_input`, so the gate is where the wait surfaces). The prompt fires the needs-attention badge and names the preview path and `file://` URL; choose `Start live review` to open the browser session (the stage prints the live `http://` review URL first — see it with `/workflow connect`), or `Skip remaining review rounds and export as-is` to accept the current design. Headless runs skip the gate. A feedback stage that fails outright fails the run; only a completed review with no requested changes counts as approval.

Research context moves between stages as artifact files, not inline prompt payloads: the project design context is written to `<artifact_dir>/design-context.md` and the curated references brief to `<artifact_dir>/references.md`; `reference-discovery` reads the design context, and the generate and exporter stages read both files via `reads`. Only verbatim user annotations and the word-capped prior design summary travel inline.

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
    "notifyOn": ["started", "completed", "failed", "blocked", "awaiting_input", "paused", "quit", "resumed"]
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
