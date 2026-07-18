# Author workflows

Define a typed workflow with the smallest runnable graph first, then add schemas, artifacts, human input, follow-on turns, and explicit exit behavior.

## Writing a Workflow

Workflow files are TypeScript modules that export a workflow definition:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "my-workflow",
  description: "Short description shown in workflow listings.",
  inputs: {
    prompt: Type.String({ description: "Task or question for the workflow." }),
  },
  outputs: {
    summary: Type.String({ description: "Synthesized findings and recommended next steps." }),
    reviewer_count: Type.Number({ description: "Number of parallel reviewers that ran." }),
  },
  run: async (ctx) => {
    const prompt = String(ctx.inputs.prompt);

    const scoutPath = ".atomic/workflows/runs/my-workflow/scout.md";
    const reviewPaths = {
      quality: ".atomic/workflows/runs/my-workflow/quality.md",
      runtime: ".atomic/workflows/runs/my-workflow/runtime.md",
    } as const;

    await ctx.task("scout", {
      prompt: `Map the relevant context for: ${prompt}`,
      context: "fresh",
      output: scoutPath,
      outputMode: "file-only",
    });

    const reviews = await ctx.parallel(
      [
        {
          name: "quality",
          prompt: `Scout artifact: ${scoutPath}\nRead the file at ${scoutPath} and inspect only sections needed for this quality review.`,
          reads: [scoutPath],
          output: reviewPaths.quality,
          outputMode: "file-only",
        },
        {
          name: "runtime",
          prompt: `Scout artifact: ${scoutPath}\nRead the file at ${scoutPath} and inspect only sections needed for this runtime review.`,
          reads: [scoutPath],
          output: reviewPaths.runtime,
          outputMode: "file-only",
        },
      ],
      { concurrency: 2 },
    );

    const final = await ctx.task("synthesis", {
      prompt: [
        `Quality review: ${reviewPaths.quality}`,
        `Runtime review: ${reviewPaths.runtime}`,
        "Read the files at the paths above incrementally, then synthesize findings and recommend next steps.",
      ].join("\n"),
      reads: Object.values(reviewPaths),
    });

    return { summary: final.text, reviewer_count: reviews.length };
  },
});
```

Authoring basics:

- `workflow({ ... })` returns the workflow definition directly for discovery; there is no builder terminal step.
- Workflow names normalize for lookup: trim, lowercase, convert whitespace/underscore to hyphen, remove other punctuation, and collapse hyphens.
- `description` sets the listing text.
- `inputs` declares typed user inputs.
- `worktreeFromInputs` optionally maps input names to workflow-wide reusable Git worktree defaults.
- `outputs` declares typed outputs that parent workflows receive from `ctx.workflow(childWorkflow, ...)`.
- `run: async (ctx) => { ... }` defines the workflow body.

Migrating an existing file from the removed `defineWorkflow(...).compile()` builder? See [Migrating from the `defineWorkflow()` Builder API](/workflow-migration#migrating-from-the-defineworkflow-builder-api) for the full method-to-key mapping, a before/after walkthrough, and a conversion checklist.

`prompt` and `task` are aliases for task text. Prefer `prompt` inside authored workflow files because it mirrors lower-level `stage.prompt(...)`; `task` remains useful in direct tool calls and chain examples.

Author workflows to create at least one tracked stage by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, `ctx.stage()`, or `ctx.workflow()` in the run body so each normal run has graph nodes to inspect, attach to, interrupt, resume, and render. Guard-only workflows may call `ctx.exit(...)` before creating a stage when they intentionally stop early.

### Stage follow-on user messages

`ctx.stage()` returns a `StageContext` with `sendUserMessage(content, options?)` for injecting a normal follow-on user turn into that stage's AgentSession. Use this when workflow code needs to continue an existing stage session after `stage.prompt(...)` has already resolved, including schema-backed stages where `prompt()` is intentionally one-shot because the structured-output tool may be called exactly once.

```ts
const gate = ctx.stage("review-gate", {
  schema: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
});
const decision = await gate.prompt("Review the implementation and call structured_output.");
if (!decision.approved) {
  await gate.sendUserMessage("Explain the highest-priority changes needed before approval.");
}
```

When the stage session is idle, `sendUserMessage()` starts the next user turn immediately and waits for that turn to finish under the normal workflow stage guard: it observes the stage concurrency limiter, workflow abort/cancellation signals, MCP scoping, readiness gates, and session metadata capture. If `sendUserMessage()` is the first live call on a `ctx.stage(...)` handle, Atomic records the stage as a normal running/completed graph node. If it is called after a prior `prompt()`/`complete()` has already completed the stage, the follow-on turn still uses internal abort/cancellation and concurrency protection while reusing the completed stage session.

The `content` argument mirrors the Atomic SDK and accepts either a string or text/image content blocks such as `[{ type: "text", text: "Describe this" }, { type: "image", data: "...", mimeType: "image/png" }]` when the underlying stage session supports native user-message delivery. Non-native fallback adapters only support string content and reject text/image block arrays instead of stringifying them. Idle non-native fallback delivery sends the follow-on string to the already-selected session directly, so workflow model fallback retries are not re-run for that injected turn. When the stage is already streaming, the message is queued as a follow-up by default; pass `{ deliverAs: "steer" }` to steer the active turn instead, or `{ deliverAs: "followUp" }` to be explicit. `deliverAs` only affects streaming delivery and is a no-op for idle sessions. Follow-on turns preserve the stage's `mcp.allow` / `mcp.deny` scope for the injected user turn, just like the original `prompt()`. The older `stage.steer(text)` and `stage.followUp(text)` methods are still available for queueing while a turn is active, but they do not start a new idle turn.

Externally produced traffic has a separate lifecycle rule. Intercom messages and async bash/subagent completion notices received while a workflow stage generation is still open are admitted immediately through the stage AgentSession's native steering/follow-up queue. The stage drains already-admitted work before publishing its terminal snapshot, including schema-backed turns that have already called `structured_output`. Closing the generation is atomic with admission: a notification admitted first belongs to that stage, while a detached result that arrives after close cannot reopen or mutate the completed stage and is surfaced once through the main-chat notification path instead. Stage completion never waits for producers that are still running; only traffic already admitted at the close boundary is drained. This does not change explicit `sendUserMessage()` calls or post-mortem stage chat, which remain deliberate user/workflow-authored follow-up turns on the retained session.

### Early exit with `ctx.exit()`

Use `ctx.exit(options?)` when workflow code intentionally stops the current run from a helper, branch, loop, or precondition guard without classifying the run as failed. `ctx.exit()` throws an executor-owned control signal and is typed as `never`, so code after it is unreachable. In async `run` bodies, prefer `return ctx.exit(...)` when the exit is the only path so TypeScript can see the non-returning branch.

```ts
export default workflow({
  name: "guarded-import",
  description: "",
  inputs: {},
  outputs: {
    scanned: Type.Number(),
  },
  run: async (ctx) => {
    const files = await findCandidateFiles(ctx.cwd);
    if (files.length === 0) {
      return ctx.exit({
        status: "skipped",
        reason: "No matching files",
        outputs: { scanned: 0 },
      });
    }

    const review = await ctx.task("review", { prompt: `Review ${files.join(", ")}` });
    return { scanned: files.length };
  },
});
```

`ctx.exit()` accepts `status: "completed" | "skipped" | "cancelled" | "blocked"`; it never accepts `"failed"` or `"killed"` because thrown errors and internal destructive cancellation keep those meanings. `status` defaults to `"completed"`. `reason` is persisted and shown in status surfaces, including the default `/workflow status` list and `/workflow status <runId>` detail, so do not put secrets in it. `outputs` may contain a partial subset of declared outputs; provided keys still must be declared in the workflow's `outputs` object, match their TypeBox schema, and be JSON-serializable. Missing required outputs are allowed only on the `ctx.exit(...)` path. Exited runs are terminal and not resumable; public `pause`, `interrupt`, and `quit`, plus internal destructive cancellation, keep their distinct existing behavior.

The first selected `ctx.exit({ outputs })` snapshots its output payload synchronously by value before JavaScript `finally` blocks or cleanup callbacks can mutate the caller-owned object. The snapshot preserves undeclared keys and invalid values until post-cleanup validation, so deleting an undeclared key or changing an invalid value after `ctx.exit(...)` does not change the terminal validation result. If reading `status`, `reason`, or `outputs` options, or enumerating/copying the output snapshot itself, throws, Atomic still selects the exit signal, runs workflow-exit cleanup when feasible, and then records a terminal non-resumable authoring failure (`resumable: false`) if no external terminal control won first.

After the first `ctx.exit(...)` wins, the executor treats that exit as a level-triggered gate. Later delayed calls to `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.workflow`, or graph-backed `ctx.ui.*` prompts rethrow the selected exit signal before creating stages, prompt nodes, child runs, or control handles. Retained `StageContext` handles from before the exit also become inert: `prompt`, `complete`, steering/follow-up, model/thinking controls, tree navigation, compaction, abort, and attached-pane session-realization paths refuse to touch or create an `AgentSession` after the exit is selected. `ctx.parallel` stops dequeuing queued work after exit even with `failFast: false` and limited concurrency; already-started stages and prompt nodes are finalized as `skipped` with a `workflow-exit` reason that prompt-node abort handling preserves instead of overwriting with a generic run-aborted reason.

Continuation replay also observes the exit gate. Replayed `ctx.stage(...).prompt(...)`, replayed `complete(...)`, graph-backed prompt-node replay, and completed child-boundary replay re-check for a selected exit after their replay microtask and before writing a current-run completed stage end. If `ctx.exit(...)` wins that gap, the pending replay finalizer is skipped/suppressed with the workflow-exit reason instead of creating a misleading completed stage in the resumed run.

The store is the terminal authority for all run-end races. `ctx.exit(...)` starts cleanup before validating exit outputs, and an internal destructive cancellation can still win the terminal `recordRunEnd` write while that cleanup is pending. When that happens, the SDK `RunResult`, `onRunEnd` callback, live store, and persisted `workflow.run.end` entries all report the canonical `killed` state; the losing `ctx.exit` status or validation failure is not returned and does not append a second run-end entry.

Control-signal probing is fail-closed. When the executor inspects an arbitrary thrown value or abort reason for internal workflow-exit markers, parent-exit markers, aggregate `errors`, `cause`, `reason`, or `scope`, throwing or inaccessible accessors are treated as “no signal for that branch.” The run then continues through ordinary failure finalization, or the ordinary killed path for external abort reasons, instead of letting author-defined getters escape the executor catch path or be misclassified as `ctx.exit(...)`.

### Guiding Principles

- Stage prompts should be locally scoped: describe only the current stage's objective, inputs, expected outputs, and success criteria.
- Avoid references to other stages unless the current stage explicitly receives and needs that information.
- Avoid workflow-specific or stage-specific vocabulary that is not explained inside the current prompt.
- Use clear software engineering terminology in self-described prompts.
- Avoid hard-coded regular expressions for condition matching when gating reviews or model outputs.
- Prefer schema-backed workflow stages (`ctx.stage(..., { schema })`, `ctx.chain` items, or `ctx.parallel` items) for review/gate decisions whenever model output needs to be evaluated; a schema-enabled item receives the structured-output tool automatically.
- Treat atomic workflow units as language model stages, not deterministic tools.
- When deterministic gates are needed, create small dedicated stages that instruct a model to run a specific tool or perform a specific check. This keeps gates adaptive to the current codebase while preserving explicit workflow structure.

### Context engineering guidance

Workflow guidance should also cover the context passed between stages:

- Prefer creating files or artifacts for substantial handoffs, then instruct the next stage to read the file, instead of dumping large text output directly into the next stage prompt or context.
- Prefer forked context for non-reviewer stages so long-running implementation work can preserve coherency and continuity.
- Prefer a clean context window for reviewer stages so earlier implementation stages do not bias the reviewer. Reviewers should evaluate the supplied artifacts, changed files, tests, and explicit criteria as independently as possible.

### Inputs

Inputs are declared with TypeBox `Type.*` schemas in the `inputs` object. Import `Type` from `typebox` directly in workflow files. Workflow packages still declare `typebox` as a peer dependency so TypeBox schemas resolve under `tsc` — see [Programmatic Usage](/workflow-reference#programmatic-usage). Common input schemas map to picker kinds and accepted runtime values:

| TypeBox schema | Picker kind | Accepted runtime value |
|---|---|---|
| `Type.String({ default? })` | text | string |
| `Type.Number({ default? })` | number | number |
| `Type.Integer({ default? })` | integer | integer (whole number) |
| `Type.Boolean({ default? })` | boolean | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { default? })` | select | one of the literal strings |

A `Type.Union([Type.Literal(...)])` of string literals is how a 'select' is expressed: the input picker renders those literals as the selectable choices, and runtime validation rejects any value outside them. Put `description` and `default` in the schema options object, e.g. `Type.String({ description: "…", default: "…" })`. An input is required when its schema is **not** wrapped in `Type.Optional(...)` and declares no `default`; wrap optional inputs in `Type.Optional(...)`. A `default` does not make an input optional — a defaulted input is always present after defaults are applied.

Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show them to the user. Runtime validation uses TypeBox `Value` and is strict for both top-level named runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, type mismatches, non-JSON-serializable values, and union/literal values outside the declared choices before the workflow body starts. It does not coerce strings like `"3"` to numbers; pass `count=3` or JSON numbers when a schema declares `Type.Number()`.

In TypeScript workflow files, entries in `inputs` also narrow `ctx.inputs` for better intellisense: required/defaulted `Type.String()` inputs are `string`, `Type.Number()` is `number`, `Type.Boolean()` is `boolean`, a `Type.Union([Type.Literal(...)])` select is the literal string union, and `Type.Optional(...)` inputs include `undefined`. Use `Static<typeof schema>` when you need the inferred TypeScript type of a schema directly.

### Outputs

Workflow outputs are runtime contracts for completed workflow runs and for parent workflows that call a child with `ctx.workflow(childWorkflow, ...)`. A workflow normally returns a JSON-serializable object from `run`, and entries in the `outputs` object document, validate, and expose keys from that returned object. `ctx.exit({ outputs })` can expose a partial subset of the same declared output contract when the run intentionally stops early. The top-level return must be a plain JSON object: primitives, arrays, `null`, functions, symbols, `NaN`, and infinite numbers fail validation. Before output validation, Atomic drops top-level properties whose value is `undefined`; an omitted required key then fails as missing, while an omitted optional key remains absent.

**Return convention:** outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.foo`, the child workflow's `run` must both declare `outputs: { foo: schema }` and return `{ foo: value }`. `result` is not special and is never added for you: to expose `result`, declare it in `outputs` and return `{ result }` exactly like any other output. Returning a key that is not declared in `outputs` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs: { "<key>": Type.... } or remove it from the .run() return`.

**Reserved `status` output convention and structured failures:** if a workflow declares and returns a top-level `status` output with the string value `"failed"`, Atomic treats the run as failed instead of recording a successful completion. Returned `"blocked"`, `"needs_human"`, `"incomplete"`, `"active"`, and `"auth_blocked"` statuses are treated as blocked/incomplete terminal states rather than successful completions. Independently of that convention, Atomic uses structured failure metadata captured from the run's blocking stage (`failedStageId`) or run-level failure metadata to keep recoverable auth, rate-limit, and provider fallback exhaustion blocked/resumable even when the workflow did not declare a `status` output. Atomic does not infer failure state by scanning arbitrary output text or by scanning every failed stage in an otherwise completed non-fail-fast branch. When a reserved status is returned, a non-empty top-level `summary` string becomes the run reason shown in lifecycle notices and status surfaces; if it is absent, Atomic falls back to non-empty top-level `remaining_work` and then `result` text. Use the reserved `status` convention only when the workflow is intentionally reporting its own terminal state (for example, a deterministic release gate that returns `{ status: "blocked", summary: "required checks are pending" }`, or a reviewer-gated workflow that returns `{ status: "needs_human", remaining_work: "provider credentials are missing" }`). Do not use a top-level `status` field for unrelated external state such as a deployment/check you merely inspected; choose a domain-specific name like `deployment_status` or `gate_status` instead.

The `outputs` object is a schema contract, not an automatic stage selector. To expose values from any stage, capture the stage/task/child result in normal TypeScript and return it from `run` under the desired key:

```ts
export default workflow({
  name: "review-with-summary",
  description: "Review with returned artifacts.",
  inputs: {},
  outputs: {
    research_artifact: Type.String(),
    review: Type.String(),
  },
  run: async (ctx) => {
    const researchPath = ".atomic/workflows/runs/review-with-summary/research.md";
    await ctx.task("research", {
      prompt: "Research the target.",
      output: researchPath,
      outputMode: "file-only",
    });
    const review = await ctx.task("review", {
      prompt: `Research artifact: ${researchPath}\nRead the file at ${researchPath} incrementally and summarize risks.`,
      reads: [researchPath],
    });

    return {
      research_artifact: researchPath,
      review: review.text,
    };
  },
});
```

There is no automatic `result` output. A workflow exposes exactly the keys it declares in `outputs` and returns from `run` — nothing more. To expose `result`, declare `outputs: { result: schema }` and return `{ result }` like any other output. If `run` returns a key that was never declared in `outputs`, the run fails with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs: { "<key>": Type.... } or remove it from the .run() return` (for a child workflow call, `<name>` is the child's own name, and the parent surfaces the failure through the child-failure wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`).

Outputs are declared with TypeBox `Type.*` schemas in the `outputs` object. **Prefer precise schemas.** A precise schema gives a precise `Static<>` type for the `run` return and for any parent reading `child.outputs`, and it makes runtime validation enforce the real shape instead of waving values through. Reach for `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, or `Type.Object({}, { additionalProperties: true })` only for genuinely dynamic data whose shape you cannot know ahead of time.

| TypeBox schema | Static type | Accepted runtime value |
|---|---|---|
| `Type.String({ ... })` | `string` | string |
| `Type.Number({ ... })` | `number` | finite number |
| `Type.Integer({ ... })` | `number` | integer |
| `Type.Boolean({ ... })` | `boolean` | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { ... })` | `"a" \| "b"` | one of the literal strings |
| `Type.Array(Type.String())` | `string[]` | array of strings |
| `Type.Object({ topic: Type.String(), score: Type.Number() })` | `{ topic: string; score: number }` | object matching that shape |
| `Type.Unsafe<MyInterface>(runtimeSchema)` | `MyInterface` | whatever `runtimeSchema` accepts (escape hatch) |
| `Type.Array(Type.Unknown())` | `unknown[]` | any JSON array (last resort, dynamic only) |
| `Type.Object({}, { additionalProperties: true })` | `Record<string, unknown>` | any JSON object (last resort, dynamic only) |
| `Type.Unknown()` / `Type.Any()` | `unknown` / `any` | any JSON-serializable value (last resort) |

Output schemas carry `description` in their options object. A declared output is required when its schema is **not** wrapped in `Type.Optional(...)`; wrap outputs that may be absent in `Type.Optional(...)`. A required output means the workflow `run` return object must contain that output before the run can complete; a missing required output fails with `missing output "<key>"`, and a declared value whose runtime type does not match the schema fails with `output "<key>" expected <type>, got <actual>`. For child workflow calls, the parent boundary fails before the parent continues. Declared outputs are validated against the declared schema with TypeBox `Value` on completion, and every returned/exposed value is recursively validated as JSON-serializable. Child output replay still performs a structured-clone safety check after JSON validation so continuation can restore completed child workflow boundaries.

#### Prefer precise schemas

A loose output like `Type.Unknown()` or `Type.Object({}, { additionalProperties: true })` types the `run` return and `child.outputs.x` as `unknown`/`Record<string, unknown>`, so every consumer must cast or guard before using the value, and runtime validation only checks "is this JSON?" instead of the real shape. Declaring the shape fixes both at once:

```ts
// ❌ Loose: child.outputs.report is `unknown`; nothing checks the shape at runtime.
outputs: {
  report: Type.Unknown(),
}

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

The same rule applies to inputs: `inputs: { counts: Type.Array(Type.Number()) }` makes `ctx.inputs.counts` a `number[]`, while `Type.Array(Type.Unknown())` only gives you `unknown[]`.

#### `Type.Unsafe<T>()` escape hatch for deeply-nested values

When you already have a precise TypeScript type for a deeply-nested serializable value and don't want to hand-write the equivalent TypeBox schema, wrap a permissive runtime schema with `Type.Unsafe<MyType>(...)`. The **static** type becomes exactly `MyType` (so `ctx.inputs`, the `run` return, and `child.outputs` stay precise), while the **runtime** check stays as lenient as the wrapped schema. Use a `type` alias rather than an `interface` for the wrapped type — an `interface` has no implicit index signature, so it does not satisfy the serializable-output constraint:

```ts
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

type ResearchPacket = {
  readonly topic: string;
  readonly score: number;
  readonly sections: readonly { readonly heading: string; readonly body: string }[];
};

export default workflow({
  name: "research-packet",
  description: "",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    packet: Type.Unsafe<ResearchPacket>(Type.Object({}, { additionalProperties: true })),
  },
  run: async (ctx) => {
    const packet: ResearchPacket = {
      topic: ctx.inputs.topic,
      score: 1,
      sections: [{ heading: "overview", body: "…" }],
    };
    return { packet }; // statically checked against ResearchPacket
  },
});
```

Tradeoff: `Type.Unsafe<T>()` does not deeply validate at runtime — it trusts that the produced value matches `T`. Use it when the producing code already guarantees the shape (the `contract-complex-leaf` contract workflow does exactly this, wrapping `Type.Unsafe<ComplexPacket>(...)` and `Type.Unsafe<readonly ComplexRecord[]>(...)` around permissive runtime schemas). When you can express the shape directly, prefer a real `Type.Object(...)`/`Type.Array(...)` so runtime validation also catches drift. Keep bare `Type.Unknown()` and `Type.Object({}, { additionalProperties: true })` for the rare cases where the value is genuinely dynamic.

#### How types flow

- `ctx.inputs.x` is `Static<inputSchema>` for the input you declared as `inputs: { x: schema }` — required and defaulted schemas are always present, and `Type.Optional(...)` adds `| undefined`.
- The `run` return is checked against your declared outputs at **compile time** (a missing required output or a wrong value type is a TypeScript error) and at **runtime** via TypeBox `Value` (undeclared keys are rejected and the declared shape is enforced recursively).
- `ctx.workflow(child)` returns a discriminated child result. When `child.exited === false`, `child.outputs` is the child's full declared `outputs` contract; when `child.exited === true`, `child.outputs` is `Partial<TOutputs>` because child `ctx.exit({ outputs })` may intentionally provide only a subset.

Use `Static<typeof schema>` (both `Static` and `TSchema` are re-exported from `@bastani/workflows`) when you need the inferred TypeScript type of a schema directly — for example to type a helper that builds an output value.


## Additional authoring examples preserved from the package README

## Authoring API

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
    if (!approved) {
      return ctx.exit({
        status: "cancelled",
        reason: "The human rejected the implementation plan.",
        outputs: { status: "cancelled" },
      });
    }

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


## Additional schema guidance preserved from the package README

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

Wrap an output schema in `Type.Optional(...)` to make the key optional; an un-wrapped output schema is required. `run()` must return a JSON-serializable object. Functions, symbols, `NaN`, infinite numbers, and non-plain objects (e.g. `Date`) fail validation. Top-level properties whose value is `undefined` are removed before validation, so required keys fail as missing and optional keys are omitted. Declared outputs are validated before a workflow is marked completed. A required output that is missing fails with `missing output "<key>"`, and a type mismatch fails with `output "<key>" expected <kind>, got <actual>`. A workflow exposes exactly the outputs it declares in `outputs`: there is no automatic `result` output, and returning a key that was not declared fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs: { "<key>": Type.... } or remove it from the .run() return`. To expose `result`, declare `outputs: { result: schema }` and return `{ result }`. Child output replay still performs a structured-clone safety check after JSON validation so completed child boundaries can be replayed.

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
