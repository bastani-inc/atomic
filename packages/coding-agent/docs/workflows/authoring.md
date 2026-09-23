# Custom Workflow Authoring

Hand-write and maintain workflow TypeScript after you are comfortable with Atomic, or when a generated workflow does not meet your needs. This guide takes one workflow continuously from its module shape through inputs, outputs, stages, artifacts, reload, execution, and validation.

For reusable pieces, prefer importing builtin definitions and composing them with `ctx.workflow(...)` over copying their implementation.

## Or hand-write the TypeScript

Workflow files are plain TypeScript modules. Create `.atomic/workflows/explain-file.ts`:

```ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export default workflow({
  name: "explain-file",
  description: "Explain a file with tracked workflow stages.",
  inputs: {
    path: Type.String({ description: "File path to explain." }),
  },
  outputs: {
    explanation: Type.String({
      description: "Explanation of the file's purpose, risks, and key symbols.",
    }),
  },
  run: async (ctx) => {
    const explanation = await ctx.task("explain", {
      prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
      context: "fresh",
    });

    return { explanation: explanation.text };
  },
});
```

Run `/workflow reload` or restart Atomic, then list and run it:

```text
/workflow list
/workflow inputs explain-file
/workflow explain-file path="src/index.ts"
```

See [Writing a Workflow](#writing-a-workflow) for the full `workflow({...})` API and [WorkflowContext](/workflows/api-reference#workflowcontext) for `ctx.task` / `ctx.chain` / `ctx.parallel` / `ctx.stage` / `ctx.ui`.

## Writing a Workflow

### Automatic stage model selection

When the user delegates the choice of the best stage model, author `model: "auto"` instead of guessing a concrete model or effort. Keep explicit user model, effort, and constraint requests intact. Omitted model settings retain their existing defaults.

```ts
const result = await ctx.task("analyze", {
  model: "auto",
  prompt: `Analyze ${String(ctx.inputs.path)} against the supplied requirements.`,
  modelConstraints: { minContextWindow: 32000, maxInputCost: 5 },
});
```

`ctx.stage("analyze", { model: "auto" }).prompt(text)` works too. Set `model: "auto"` in chain or parallel shared options to route each stage separately. The decision uses the actual supplied prompt after input interpolation and chain context expansion, eligible models and efforts, and compact dated evaluation evidence rather than full guides. It ranks up to three distinct models with an effort for each, trying them in order before remaining configured fallbacks and the current chat model. File references remain references, not guessed file contents. See [automatic model selection](/subagents/reference#automatic-model-selection) for ranking and limits.

Long prompts are excerpted for model selection only; the stage still receives the full execution prompt. The excerpt preserves the beginning, end, and `<keepContext>...</keepContext>` spans. Protect essential selection requirements with those tags, since unprotected middle text may be omitted. If protected text cannot fit, the normal router context-limit and fallback behavior applies. Hard `modelConstraints` remain enforced independently.

The shared `routerModel` setting chooses the decision provider. It does not choose which workflow to launch. Jev can make the decision but never executes the stage. See [automatic stage operation](/workflows/operations#automatic-stage-models) for failures and resume behavior.

**Write workflow code for both Atomic hosts.** Standalone binaries run under Bun; npm installs run under Node. A `Bun.*` global is available only when Atomic itself runs under Bun. Otherwise it fails with `Bun is not defined`, even if Bun is installed separately.

Use APIs both hosts provide:

- `node:child_process` instead of `Bun.spawn`/`Bun.spawnSync`
- `node:fs` instead of `Bun.file`
- `node:path` instead of Bun's path helpers

Every example on this page follows that rule. A snippet that deliberately requires one host has a `host-specific:` comment naming it.

Workflow files are TypeScript modules that export a workflow definition:

```ts
import { workflow } from "@bastani/atomic/workflows";
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
- `autoAttach: true` opens the graph overlay when an interactive top-level named launch through `/workflow <name>` or the registered `workflow` tool is accepted. Only exact `true` is retained on the compiled definition; omission and `false` do not opt a definition into auto-attachment. Existing input-form launch behavior is unchanged.
- `heartbeatIntervalMinutes` declares the workflow's heartbeat cadence in minutes. Omission uses the `15`-minute default; `0` disables heartbeats for the workflow. Negative and non-finite values are rejected when the definition is authored. While a run is active, each boundary at `startedAt + n × interval` delivers a heartbeat card to the main chat as a queued steer that never interrupts an in-flight response. See [`heartbeatIntervalMinutes`](/workflows/api-reference#heartbeatintervalminutes).
- `inputs` declares typed user inputs.
- `worktreeFromInputs` optionally maps input names to workflow-wide reusable Git worktree defaults.
- `outputs` declares typed outputs that parent workflows receive from `ctx.workflow(childWorkflow, ...)`.
- `run: async (ctx) => { ... }` defines the workflow body.

`prompt` and `task` are aliases for task text inside authored workflow primitives. Prefer `prompt` because it mirrors lower-level `stage.prompt(...)`; `task` remains useful in `ctx.chain(...)` examples.

Author workflows to create at least one tracked execution node by calling `ctx.task()`, `ctx.chain()`, `ctx.parallel()`, `ctx.stage()`, `ctx.workflow()`, or `ctx.tool()` in the run body so each normal run has graph work to inspect and render. Stage nodes remain the attachable, interruptible, resumable chat units; durable tool nodes are non-chat execution. Guard-only workflows may call `ctx.exit(...)` before creating a node when they intentionally stop early.

### Source layout for authored workflows

Keep a small workflow in one readable entry file. Show its graph and control flow at the top level, name each stage for its responsibility, and make inputs, outputs, evidence, and success criteria explicit. A maintainer reading top to bottom should be able to identify branches, gates, artifacts, and stop conditions.

Avoid both monolithic prompt blocks and unnecessary fragmentation. Do not split short one-use prompts, create one file per stage, add wrapper-only modules, or hide the graph across files. Line counts alone are not a module boundary.

When a meaningful source boundary improves clarity, reuse, ownership, or testability, keep the graph and control flow in the top-level workflow entry file and extract cohesive concerns:

- long or reused prompt builders;
- shared TypeBox schemas and workflow-specific types;
- model-policy constants shared by several stages;
- deterministic helpers with their own testable behavior; and
- reusable child workflow definitions.

Put those support modules in a subdirectory below the top-level discovery directory — either one owned by a single workflow or a shared support directory for several workflows. Project and user discovery scans only top-level `.ts`/`.js`/`.mjs`/`.cjs` files in the workflow directory; the scan is non-recursive, so support modules in subdirectories are not scanned as extra top-level workflow candidates. Every top-level candidate in any of those four extensions is imported and each of its exports is shape-checked, so a support module left at the top level produces definition diagnostics for its non-workflow exports regardless of extension. Use `.js` import extensions from TypeScript source, following the repository convention.

For example, a custom workflow can keep its support code in a workflow-owned subdirectory:

```text
.atomic/workflows/code-review.ts
.atomic/workflows/code-review/prompts.ts
.atomic/workflows/code-review/schemas.ts
.atomic/workflows/code-review/model-policy.ts
```

The subdirectory is for cohesive, reusable support code, not a requirement to give every prompt or stage its own file.

### Workflow and extension responsibilities

Evaluate Atomic extension hooks when a workflow needs fine-grained, cross-cutting tool or session event control. Workflow TypeScript owns the inspectable DAG, stages, handoffs, durable `ctx.tool` side effects, and gates. Extension hooks own cross-cutting session and model-tool policy such as `tool_call` interception, input mutation, or blocking; `tool_result` transformation; context and provider hooks; lifecycle observation; or reusable custom tools. Use hooks only when cross-stage or cross-workflow event control is materially clearer than embedding the policy in each stage. Do not require a companion extension for ordinary workflow logic. See the authoritative [extension event documentation](/extensions/events#events) for hook contracts and ordering.

When a workflow depends on a companion extension, make that dependency explicit and package and document the extension with the workflow. If stages use `tools` allowlists, include any custom tools provided by the extension. Document the hook-driven behavior and keep the graph, stage contracts, artifacts, gates, and stop conditions visible in the workflow entry file so readers can distinguish inspectable workflow orchestration from event policy.

### Dynamic topology must remain acyclic

Atomic `workflow({ run })` definitions are imperative, dynamic TypeScript. The final graph is materialized only while `run(ctx)` executes and may depend on runtime inputs, branches, loops, files or network data, model or human output, helpers, and nested workflows. Discovery can report module import and definition-shape diagnostics: it loads the module, checks its exports, schemas, and `run` function, and rejects failures observable at that point. It does not execute every control-flow path or compile `run` into a complete graph. TypeScript and discovery cannot prove arbitrary dynamic acyclicity.

**Cyclic workflow graphs are unsupported. Workflow authors and coding agents MUST NOT create self-edges or dependency edges from the current frontier to an existing ancestor. Every materialized execution topology must remain a DAG. If a cycle cannot be removed, redesign or stop before launch.**

Before launch, sketch the expected node and dependency shape for every branch and loop. Reject any proposed edge from the current frontier to the node itself or an ancestor. Bounded loops must create distinct tracked work for each iteration, with stable per-iteration identity and call order for resume/replay; never reopen an ancestor below its downstream work.

Invalid structural cycle:

```text
Implement → Review → Validate
    ▲                    │
    └────── Repair ──────┘
```

`Repair` points back to the existing `Implement` ancestor.

Valid unrolled loop:

```text
Implement
   ↓
Review 1
   ↓
Validate 1
   ↓
Repair 1
   ↓
Review 2
   ↓
Validate 2
```

Each iteration creates new tracked nodes, so the materialized topology stays acyclic.

Retained-session activity without new dependency work is not a loop edge:

```text
Implement ✓
  activity: processing follow-up
```

Record such follow-up as non-topological activity metadata. Do not reopen the original node as a descendant of its own downstream review or validation work.

Discovery cannot prove every dynamic path acyclic. Validate your branches and resumed runs before relying on a definition.

### Guiding Principles

- **Locally scoped stage prompts** - State only the current objective, inputs, expected outputs, and success criteria. Define any vocabulary the stage needs. See [Locally Scoped Stage Prompts](/workflows/reliable-design#locally-scoped-stage-prompts).
- **DAG-only dynamic topology** - Treat `run(ctx)` as imperative code that materializes graph nodes at runtime. Keep every branch, loop iteration, and nested boundary acyclic; never add a self-edge or a parent edge to an ancestor, and redesign or stop before launch if one remains.
- **Clear vocabulary** - Use clear software engineering terminology in self-described prompts.
- **No regex gates** - Avoid hard-coded regular expressions that gate reviews or model outputs.
- **Schema-backed gates** - Prefer schema-backed workflow stages (`ctx.stage(..., { schema })`, `ctx.chain` items, or `ctx.parallel` items) for review/gate decisions whenever the workflow must evaluate model output; a schema-enabled item receives the structured-output tool automatically. See [Evaluation and Quality Gates](/workflows/reliable-design#evaluation-and-quality-gates).
- **Stages are model stages** - Treat atomic workflow units as language model stages, not deterministic tools.
- **Small deterministic-gate stages** - When deterministic gates are needed, create small dedicated stages that instruct a model to run a specific tool or perform a specific check. This keeps gates adaptive to the current codebase while preserving explicit workflow structure.
- **Checkpoint workflow-owned side effects** - Prefer `ctx.tool(name, args, fn)` for filesystem writes, network mutations, external API actions, and other side effects orchestrated directly by the workflow definition. Atomic durably caches a completed call's serializable result, so resume returns that result without rerunning `fn`. Keep pure computation and side-effect-free transformations as ordinary TypeScript. Do not wrap agent-stage internals or every function call indiscriminately. Do not retain `ctx.tool` for detached work after the workflow executor returns: terminal admission is closed first, and a later call rejects before its callback, retries, graph node, or checkpoint can begin.

### Context engineering guidance

Also document the context that stages pass to one another:

- For substantial handoffs, create files or artifacts and tell the next stage to read them instead of putting large text outputs in its prompt or context.
- Prefer forked context for non-reviewer stages so long-running implementation work keeps a coherent, continuous context.
- Prefer a clean context window for reviewer stages so earlier implementation stages do not bias the reviewer. Reviewers should evaluate the supplied artifacts, changed files, tests, and explicit criteria as independently as possible.

See [Context Engineering](/workflows/reliable-design#context-engineering) for details.

Protect a stage's role constraints, acceptance criteria, and prohibitions with `keepContext` so compaction cannot delete them out from under a long-running stage — see [Protect the contract from compaction](/workflows/reliable-design#protect-the-contract-from-compaction).

### Inputs

Inputs are declared with TypeBox `Type.*` schemas in the `inputs` object. Import `Type` from `typebox` directly in workflow files. Workflow packages still declare `typebox` as a peer dependency so TypeBox schemas resolve under `tsc` — see [Programmatic usage](/workflows/api-reference#programmatic-usage). Common input schemas map to picker kinds and accepted runtime values:

| TypeBox schema | Picker kind | Accepted runtime value |
|---|---|---|
| `Type.String({ default? })` | text | string |
| `Type.Number({ default? })` | number | number |
| `Type.Integer({ default? })` | integer | integer (whole number) |
| `Type.Boolean({ default? })` | boolean | boolean |
| `Type.Union([Type.Literal("a"), Type.Literal("b")], { default? })` | select | one of the literal strings |

A `Type.Union([Type.Literal(...)])` of string literals expresses a 'select': the input picker renders those literals as choices, and runtime validation rejects values outside them. Put `description` and `default` in the schema options object, e.g. `Type.String({ description: "…", default: "…" })`. An input is required when its schema is **not** wrapped in `Type.Optional(...)` and declares no `default`; wrap optional inputs in `Type.Optional(...)`. A `default` does not make an input optional — a defaulted input is always present after defaults are applied.

Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show these descriptions to users. Runtime validation uses TypeBox `Value` and is strict for both top-level named runs and `ctx.workflow(...)` child calls: Atomic rejects unknown keys, missing required values, type mismatches, non-JSON-serializable values, and union/literal values outside the declared choices before the workflow body starts. It does not coerce strings like `"3"` to numbers; pass `count=3` or JSON numbers when a schema declares `Type.Number()`.

In TypeScript workflow files, entries in `inputs` also narrow `ctx.inputs` for better intellisense: required/defaulted `Type.String()` inputs are `string`, `Type.Number()` is `number`, `Type.Boolean()` is `boolean`, a `Type.Union([Type.Literal(...)])` select is the literal string union, and `Type.Optional(...)` inputs include `undefined`. Use `Static<typeof schema>` when you need the inferred TypeScript type of a schema directly.

### Outputs

Workflow outputs are runtime contracts for completed workflow runs and for parent workflows that call a child with `ctx.workflow(childWorkflow, ...)`. A workflow normally returns a JSON-serializable object from `run`, and entries in the `outputs` object document, validate, and expose keys from that returned object. `ctx.exit({ outputs })` can expose a partial subset of the same declared output contract when the run intentionally stops early. Primitives, arrays, `null`, functions, symbols, `undefined` properties, `NaN`, and infinite numbers fail validation.

**Return convention:** outputs are return-object keys. Atomic never infers child workflow outputs from stage names, stage order, or the final assistant message. If a parent should read `child.outputs.foo`, the child workflow's `run` must both declare `outputs: { foo: schema }` and return `{ foo: value }`. `result` is not special, and Atomic never adds it: to expose `result`, declare it in `outputs` and return `{ result }` exactly like any other output. Returning a key that is not declared in `outputs` fails the run with `atomic-workflows: workflow "<name>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`.

**Reserved `status` output convention and structured failures:** if a workflow declares and returns a top-level `status` output with the string value `"failed"`, Atomic treats the run as failed instead of recording a successful completion. Returned `"blocked"`, `"needs_human"`, `"incomplete"`, `"active"`, and `"auth_blocked"` statuses are treated as blocked/incomplete terminal states rather than successful completions. The engine's own system-owned `budget_exceeded` stop is likewise blocked; a workflow-returned `budget_exceeded` value cannot forge that stop and is treated as a normal completion.

Independently of that convention, Atomic uses structured failure metadata captured from the run's blocking stage (`failedStageId`) or run-level failure metadata to keep recoverable auth, rate-limit, and provider fallback exhaustion blocked/resumable even when the workflow did not declare a `status` output. Atomic does not infer failure state by scanning arbitrary output text or by scanning every failed stage in an otherwise completed non-fail-fast branch.

When a workflow returns a reserved status, Atomic uses a non-empty top-level `summary` string as the run reason shown in lifecycle notices and status surfaces; if no non-empty value is present, Atomic falls back to non-empty top-level `remaining_work` and then `result` text. Use the reserved `status` convention only when the workflow is intentionally reporting its own terminal state (for example, a deterministic release gate that returns `{ status: "blocked", summary: "required checks are pending" }`, or a reviewer-gated workflow that returns `{ status: "needs_human", remaining_work: "provider credentials are missing" }`).

Do not use a top-level `status` field for unrelated external state such as a deployment/check the workflow only inspected; choose a domain-specific name like `deployment_status` or `gate_status` instead.

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

Atomic never adds a `result` output. A workflow exposes only the keys it declares in `outputs` and returns from `run`. To expose `result`, declare `outputs: { result: schema }` and return `{ result }`. Returning a key not declared in `outputs` fails with the `returned undeclared output` error quoted above. For a child workflow call, `<name>` is the child's name, and the parent surfaces the failure through the child-failure wrapper described in [Workflow Composition](#workflow-composition).

Declare outputs with TypeBox `Type.*` schemas. **Prefer precise schemas:** they give the `run` return and `child.outputs` precise `Static<>` types and validate the actual shape at runtime.

Use `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, or `Type.Object({}, { additionalProperties: true })` only for genuinely dynamic data whose shape you cannot know ahead of time.

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

Output schemas carry `description` in their options object. A declared output is required when its schema is **not** wrapped in `Type.Optional(...)`; wrap outputs that may be absent in `Type.Optional(...)`. A required output means the workflow `run` return object must contain that output before the run can complete; a missing required output fails with `missing output "<key>"`, and a declared value whose runtime type does not match the schema fails with `output "<key>" expected <type>, got <actual>`. For child workflow calls, the parent boundary fails before the parent continues.

On completion, Atomic validates declared outputs against their schemas with TypeBox `Value` and recursively checks every returned or exposed value for JSON serializability. During child output replay, Atomic also performs a structured-clone safety check after JSON validation so continuation can restore completed child workflow boundaries.

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

<a id="type-unsafe-t-escape-hatch-for-deeply-nested-values"></a>

#### `Type.Unsafe<T>()` escape hatch for deeply-nested values

When you already have a precise TypeScript type for a deeply-nested serializable value and don't want to hand-write the equivalent TypeBox schema, wrap a permissive runtime schema with `Type.Unsafe<MyType>(...)`. The **static** type becomes exactly `MyType` (so `ctx.inputs`, the `run` return, and `child.outputs` stay precise), while the **runtime** check stays as lenient as the wrapped schema. Use a `type` alias rather than an `interface` for the wrapped type — an `interface` has no implicit index signature, so it does not satisfy the serializable-output constraint:

```ts
import { workflow } from "@bastani/atomic/workflows";
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

`Type.Unsafe<T>()` does not deeply validate at runtime. Use it only when the producing code guarantees the shape. Prefer `Type.Object(...)` and `Type.Array(...)` when possible; reserve permissive schemas for genuinely dynamic values.

#### How types flow

- `ctx.inputs.x` is `Static<inputSchema>` for the input you declared as `inputs: { x: schema }` — required and defaulted schemas are always present, and `Type.Optional(...)` adds `| undefined`.
- TypeScript checks the `run` return against your declared outputs at **compile time** (a missing required output or wrong value type is a TypeScript error), and TypeBox `Value` checks it at **runtime** (rejecting undeclared keys and enforcing the declared shape recursively).
- `ctx.workflow(child)` returns a discriminated child result. When `child.exited === false`, `child.outputs` is the child's full declared `outputs` contract; when `child.exited === true`, `child.outputs` is `Partial<TOutputs>` because child `ctx.exit({ outputs })` may intentionally provide only a subset.

Use `Static<typeof schema>` (both `Static` and `TSchema` are re-exported from `@bastani/atomic/workflows`) when you need the inferred TypeScript type of a schema directly — for example to type a helper that builds an output value.

### Stage follow-on user messages

`ctx.stage()` returns a `StageContext` with `sendUserMessage(content, options?)` to inject a normal follow-on user turn into that stage's AgentSession. Use this when workflow code needs to continue an existing stage session after `stage.prompt(...)` has already resolved, including schema-backed stages where `prompt()` is intentionally one-shot because the structured-output tool may be called exactly once.

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

The `content` argument mirrors the Atomic SDK and accepts either a string or text/image content blocks such as `[{ type: "text", text: "Describe this" }, { type: "image", data: "...", mimeType: "image/png" }]` when the underlying stage session supports native user-message delivery. Non-native fallback adapters only support string content and reject text/image block arrays instead of stringifying them. Idle non-native fallback delivery sends the follow-on string to the already-selected session directly, so workflow model fallback retries are not re-run for that injected turn. During a controlled pause, the runner gates every `stage.sendUserMessage()` before selecting either native delivery or the `prompt()` fallback; therefore an adapter that omits optional `sendUserMessage()` is not prompted until explicit resume, and the admitted delivery runs once afterward.

When the stage is already streaming, the message is queued as a follow-up by default; pass `{ deliverAs: "steer" }` to steer the active turn instead, or `{ deliverAs: "followUp" }` to be explicit. `deliverAs` only affects streaming delivery and is a no-op for idle sessions. Follow-on turns preserve the stage's `mcp.allow` / `mcp.deny` scope for the injected user turn, just like the original `prompt()`. The older `stage.steer(text)` and `stage.followUp(text)` methods are still available for queueing while a turn is active, but they do not start a new idle turn. If that stage is paused before delivery, Atomic preserves every queued item—type, optional data, duplicate entries, raw content, and order within its steering or follow-up queue—without starting a queued model turn or workflow continuation; late context-bearing traffic joins the hold, and the existing stage `resume` action releases the queue once.

The two streaming modes have distinct, deterministic timing:

- **`steer`** is delivered at the next steering boundary: after the current assistant response has finished executing its whole tool batch, and before the next model request. It is not injected between two tool calls emitted by the same assistant response.
- **`followUp`** is delivered only when the agent would otherwise stop — no further tool-driven turns and no steering messages left.

Each queue is FIFO in admission order. There is no global FIFO *across* the two queues: steering keeps its semantic priority even when a follow-up was submitted earlier. A controlled pause hold delays eligibility but preserves both the queue class and the order within it. An abort, kill, or fatal provider failure ends the turn without consuming what is still queued.

A message you type into an attached stage chat and submit with Enter defaults to `steer`, matching normal (non-workflow) session steering, so a mid-run correction lands at the next steering boundary rather than at the end of the turn. Ctrl+F queues a follow-up instead. This is a property of the interactive surface, not of the API: an authored `stage.sendUserMessage()` call that names no `deliverAs` still defaults to follow-up while the stage is streaming.

Custom `AgentSessionAdapter` implementations must emit `{ type: "agent_start" }` through `subscribe()` when a submitted turn starts, then `{ type: "agent_end", messages }` when it ends. This applies to `sendUserMessage()` and the `prompt()` fallback. Do not delay start until completion. A synchronous subscription replay is a snapshot; after subscription returns, emit starts only for new turns. If an old replayed turn can end during a newer turn, attach the same stable string or numeric `turnId` to its start and end so the old event cannot clear the newer turn's ownership.

Native queue pause is an optional `StageSessionRuntime` optimization for custom adapters:

```ts
interface StageSessionRuntime {
  readonly queuedMessagesPaused?: boolean;
  pauseQueuedMessages?(): void;
  resumeQueuedMessages?(): boolean | Promise<boolean>;
}
```

Existing adapters may omit all three members and continue using the runner's prior fallback pause behavior: the active call is aborted, the workflow objective remains suspended, and public deliveries admitted through the stage handle wait until explicit resume. Adapters that implement the native capability must provide both methods. `pauseQueuedMessages()` synchronously gates raw queued steer/follow-up work before `abort()` settles; `resumeQueuedMessages()` releases that hold without starting a provider turn and returns `true` only when raw held work was released. Atomic's bundled `AgentSession` implements this stronger native hold, which preserves already-queued and late native traffic verbatim.

Reporting an already-held queue is a second optional `StageSessionRuntime` capability:

```ts
interface StageSessionRuntime {
  getSteeringMessages?(): readonly string[];
  getFollowUpMessages?(): readonly string[];
}
```

Implement these getters to expose messages queued before session attachment, including messages transferred during fallback or retained post-mortem chat. Atomic reads an initial snapshot, then follows ordinary `queue_update` events. Without the getters, only pre-attachment queue contents are unavailable to the view.

Intercom updates can interrupt current model work; subagent completion notices use the stage's message queues. Work accepted before stage close is handled before the terminal result. Closing cancels remaining stage-owned children and suppresses their late findings. A blocking sibling ask can still open an eligible retained conversation for post-mortem discussion without changing workflow state. Explicit `sendUserMessage()` remains the API for authored follow-up turns.

### Early exit with `ctx.exit()`

Use `ctx.exit(options?)` when workflow code intentionally stops the current run from a helper, branch, loop, or precondition guard with a chosen terminal status. `ctx.exit()` throws an executor-owned control signal and is typed as `never`, so code after it is unreachable. In async `run` bodies, prefer `return ctx.exit(...)` when the exit is the only path so TypeScript can see the non-returning branch.

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

`ctx.exit()` accepts `status: "completed" | "skipped" | "cancelled" | "blocked" | "failed"`; `status` defaults to `"completed"`. Choose `completed` when the objective was met and declared outputs are complete and trustworthy; `skipped` when a precondition made the run a valid no-op; `cancelled` when the work is no longer wanted, which is a decision rather than a defect; `blocked` when valid progress needs a changed condition or a later decision; and `failed` when required work was attempted and definitively could not complete. A bounded reviewer or repair loop that does not converge is `blocked`, not `failed`.

`reason` from a valid author exit is persisted and shown in status surfaces and lifecycle notices, including the default `/workflow status` list and `/workflow status <runId>` detail, so do not put secrets in it. An exit rejected during validation is finalized as an ordinary failed run rather than an accepted author exit. `outputs` may contain a partial subset of declared outputs; provided keys still must be declared in the workflow's `outputs` object, match their TypeBox schema, and be JSON-serializable. `failed` exits default to `resumable: false`; set `resumable: true` only when a later durable retry is intended. `resumable` is valid only with `status: "failed"`; supplying it for another status records a non-resumable authoring failure. A durable retry keeps the failed handle in the resume catalog and re-dispatches the workflow with completed checkpoints replayed. The low-level `resumeRun()` helper only inspects terminal runs; it reports the durable retry path instead of silently claiming that it resumed. The other exit statuses keep their existing non-resumable author-exit behavior. Public `pause` and `quit`, plus internal destructive cancellation, keep their distinct behavior.

An author-initiated failed exit returns to a parent as `{ exited: true, status: "failed" }` with its reason and partial outputs; it does not throw. An unintentional child failure still throws, so check `child.exited === true` before reading required child outputs and use the discriminator to branch. The lifecycle terminal notice uses the same steer/trigger-turn delivery path and references partial outputs so the launching agent does not need a separate status call.

Exit snapshots `outputs` before cleanup, so later mutation cannot repair an invalid payload. If reading or copying exit options fails, the run records a non-resumable authoring failure unless external terminal control already won.

After exit is selected, new tracked work and retained stage operations are refused. Queued parallel work does not start; active stages and prompts are skipped. External cancellation can win during cleanup, in which case the canonical result is `killed`.

On resume of an unfinished tool, a successful exit cannot skip that tool. Restore its matching call before new tracked work; otherwise Atomic reports `insufficient_state: replay topology mismatch`. Intentional failed, blocked, cancelled, or skipped exits remain available.

<a id="desktop-verification-with-cua-driver-in-ctx-tool" />

### Desktop verification with Cua Driver in `ctx.tool`

When a model chooses each desktop action, an authored model stage loads the bundled `cua-driver` skill and runs one-shot `cua-driver call <tool>` commands; see [Computer use](/computer-use#desktop-automation-with-cua-driver) for the face rule, installation, telemetry, and readiness. When your workflow's TypeScript owns the sequence and the postcondition, run the scenario with the [`@trycua/cua-driver`](https://www.npmjs.com/package/@trycua/cua-driver) TypeScript SDK inside `ctx.tool(name, args, fn, { timeoutMs })` so the observe → act → re-observe → assert loop is a durable, replayable node rather than a transcript.

Prerequisites and setup, each as one bounded attempt:

- `node` (preferred) or `bun` on the host. If neither is present, install one in a bounded attempt (Node via [fnm](https://github.com/Schniz/fnm) with `fnm install --lts` or the host's package manager, Bun via `curl -fsSL https://bun.sh/install | bash`) and report what the installer did; if the install is refused or fails, report that as the limitation rather than retrying.
- The `cua-driver` executable (`cua-driver --version`), installed with upstream's one-line installer if missing, followed by `cua-driver telemetry disable` once.
- The SDK installed at the exact driver version into a scratch directory outside the user's repository, for example `npm install @trycua/cua-driver@0.28.2 --prefix ~/.cache/atomic-cua`. The package ships per-platform native optional dependencies. Daemon-backed clients verify contract, tool-schema, capability, and protocol versions before each action and refuse on mismatch, so the pin must match `cua-driver --version`.

The scenario itself is a small script in that scratch directory. It acquires the driver with `CuaDriver.connect()` when a daemon is running, so it reuses the daemon's permission identity (on macOS, `CuaDriver.app`'s Accessibility and Screen Recording grants) and the persisted telemetry-off preference; upstream describes `connect()` as a compatibility and app-hosting path, which is exactly the role it plays here. Only when no daemon is reachable does it fall back to `CuaDriver.create()`, which loads the runtime into the node process. On macOS that in-process fallback attributes permissions to the node host, normally the terminal app, as a **separate grant** from the app's; `checkPermissions` is then read-only, and the host must fully quit and relaunch after granting. Save it as `~/.cache/atomic-cua/verify-counter.mjs`:

```js
// Reads {"daemon":true|false,"artifactsDir":"..."} from argv[2]; prints one JSON result line.
// Replace the app name, window title, element labels, and postcondition with ones you control.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActionTarget, ClickButton, ClickInput, ClickPosition, CuaDriver,
  GetWindowStateInput, InputDeliveryMode, ListAppsInput, ListWindowsInput,
} from "@trycua/cua-driver";

const { daemon, artifactsDir } = JSON.parse(process.argv[2]);
mkdirSync(artifactsDir, { recursive: true });
const unique = (items, what) => {
  if (items.length !== 1) throw new Error(`Expected one ${what}, found ${items.length}`);
  return items[0];
};
const finish = (result, detail) => {
  process.stdout.write(`${JSON.stringify({ result, detail })}\n`);
  process.exitCode = result === "verified" ? 0 : 1;
};

// The wrapper already set CUA_DRIVER_RS_TELEMETRY_ENABLED=false in this process's environment
// before the driver was constructed; the SDK is one of the faces that reports telemetry by default.
const driver = daemon ? await CuaDriver.connect() : CuaDriver.create(undefined);
try {
  const apps = await driver.listApps(ListAppsInput.new({}));
  const app = unique(apps.apps.filter((a) => a.name === "Window Demo" && a.running), "app");
  const windows = await driver.listWindows(ListWindowsInput.new({ pid: app.pid, onScreenOnly: true }));
  const window = unique(windows.windows.filter((w) => w.title === "Counter"), "window");
  const target = new ActionTarget.Window({ pid: app.pid, windowId: window.windowId });
  const snapshot = async (label) => {
    const state = await driver.getWindowState(
      GetWindowStateInput.new({
        pid: app.pid, windowId: window.windowId,
        includeAccessibilityTree: true, includeScreenshot: true,
        screenshotOutFile: join(artifactsDir, `${label}.png`),
      }),
    );
    if (state.degraded || state.truncated) throw new Error(`${label} snapshot is degraded or truncated`);
    // Keep the whole result (snapshot id, screenshot reference, degraded/truncated flags), not just
    // the elements, so the retained tree is provably from a complete snapshot. Ids are bigint.
    const json = JSON.stringify(state, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
    writeFileSync(join(artifactsDir, `${label}.json`), json);
    return state;
  };

  const before = await snapshot("before");
  const button = unique((before.elements ?? []).filter((e) => e.label === "Increment"), "button");
  const counter = unique((before.elements ?? []).filter((e) => e.label === "Count"), "counter");
  if (!button.elementToken || counter.value === undefined) throw new Error("Snapshot lacks the button token or counter value");

  let clicked = false;
  try {
    await driver.click(ClickInput.new({
      target,
      position: new ClickPosition.Element({ elementToken: button.elementToken }),
      deliveryMode: InputDeliveryMode.Background,
      button: ClickButton.Left, count: 1,
    }));
    clicked = true;
  } catch (error) {
    // A timeout or interrupted action before its response is "unknown": the postcondition below
    // decides, and the click is never replayed.
    if (!/timed out|ActionInterrupted/u.test(String(error))) throw error;
  }

  // Bounded poll on fresh snapshots; never a fixed sleep, never a second click.
  const deadline = Date.now() + 10_000;
  let after = await snapshot("after");
  let updated = unique((after.elements ?? []).filter((e) => e.label === "Count"), "counter");
  while (updated.value === counter.value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    after = await snapshot("after");
    updated = unique((after.elements ?? []).filter((e) => e.label === "Count"), "counter");
  }
  if (updated.value !== undefined && updated.value !== counter.value) {
    finish("verified", `Count ${counter.value} -> ${updated.value}`);
  } else {
    finish(clicked ? "refuted" : "unknown", `Count stayed ${counter.value}`);
  }
} catch (error) {
  finish("unknown", String(error));
} finally {
  try {
    await driver.shutdown();
  } finally {
    if ("uniffiDestroy" in driver && typeof driver.uniffiDestroy === "function") driver.uniffiDestroy();
  }
}
```

The workflow runs a readiness preflight as its own `ctx.tool` first, so a missing permission or session ends the run with `ctx.exit({ status: "blocked", reason })`. A blocked author exit is terminal and not resumable (see [Early exit with `ctx.exit()`](#early-exit-with-ctx-exit)), and the preflight's `{ ready: false }` result is a completed, cached checkpoint, so after the user grants the permission start a new run: its fresh preflight checks again instead of replaying the cached result. The scenario tool spawns `node` with `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` in the child environment, forwards `signal` so a quit or targeted abort kills the child, and maps anything but `verified` to a nonzero outcome:

```ts
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, workflow } from "@bastani/workflows";

const sdkDir = join(homedir(), ".cache", "atomic-cua");
const cuaEnv = { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" };

function run(command: string, args: string[], signal: AbortSignal, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd, env: cuaEnv, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    // A missing executable (ENOENT) or an abort arrives here rather than on "close"; treat it as a
    // failed command so the preflight can return its remediation instead of throwing.
    child.on("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export default workflow({
  name: "verify-counter",
  description: "Prove the Increment button changes the Count field in the Counter window.",
  inputs: { artifactsDir: Type.String({ description: "Directory for before/after state JSON and screenshots" }) },
  outputs: { result: Type.String(), detail: Type.String() },
  run: async (ctx) => {
    const preflight = await ctx.tool(
      "cua-preflight",
      { platform: process.platform },
      async ({ signal }) => {
        const version = await run("cua-driver", ["--version"], signal);
        if (version.code !== 0) {
          return { ready: false, reason: "cua-driver is not installed; run /bin/bash -c \"$(curl -fsSL https://cua.ai/driver/install.sh)\" (Windows: irm https://cua.ai/driver/install.ps1 | iex), then cua-driver telemetry disable" };
        }
        const status = await run("cua-driver", ["status"], signal);
        const daemon = status.code === 0;
        if (process.platform === "darwin" && daemon) {
          const permissions = await run("cua-driver", ["permissions", "status", "--json"], signal);
          const grants = permissions.code === 0
            ? (JSON.parse(permissions.stdout) as { accessibility?: boolean; screen_recording?: boolean })
            : {};
          if (grants.accessibility !== true || grants.screen_recording !== true) {
            return { ready: false, reason: "Missing macOS grant: run `cua-driver permissions grant`, toggle CuaDriver on under System Settings → Privacy & Security → Accessibility and Screen & System Audio Recording, then relaunch the daemon with `open -n -g -a CuaDriver --args serve`" };
          }
        }
        const apps = await run("cua-driver", ["call", "list_apps"], signal);
        if (apps.code !== 0) {
          return { ready: false, reason: `cua-driver call list_apps failed; start the daemon (macOS: open -n -g -a CuaDriver --args serve; Windows: cua-driver serve in the interactive session; Linux: cua-driver serve inside the graphical session): ${apps.stderr.trim()}` };
        }
        return { ready: true, daemon };
      },
      { timeoutMs: 60_000 },
    );
    if (!preflight.ready) {
      return ctx.exit({ status: "blocked", reason: preflight.reason });
    }

    const scenario = await ctx.tool(
      "verify-counter-scenario",
      { artifactsDir: ctx.inputs.artifactsDir, daemon: preflight.daemon },
      async ({ signal }) => {
        const args = JSON.stringify({ daemon: preflight.daemon, artifactsDir: ctx.inputs.artifactsDir });
        const child = await run("node", ["verify-counter.mjs", args], signal, sdkDir);
        const line = child.stdout.trim().split("\n").at(-1) ?? "";
        const parsed = line.startsWith("{") ? (JSON.parse(line) as { result: string; detail: string }) : undefined;
        const result = parsed?.result ?? "unknown";
        if (result !== "verified") {
          throw new Error(`desktop verification ${result}: ${parsed?.detail ?? child.stderr.trim()}`);
        }
        return { result, detail: parsed?.detail ?? "" };
      },
      { timeoutMs: 5 * 60_000 },
    );

    return scenario;
  },
});
```

A `verified` result is cached durably, so a resumed run does not click again. A thrown `refuted`, `blocked`, or `unknown` result fails the node and is not replayed from cache; a new run executes the preflight and the scenario again from a fresh snapshot, and a durable retry of a resumable failure replays the completed preflight checkpoint and re-runs only the scenario. Keep the artifacts directory outside the repository unless the evidence belongs in the deliverable, and never post the installation UUID from `cua-driver telemetry status` in a result or reason. Safety is the same on both faces: one controller per desktop, a dedicated session or account where practical, and an explicit stopping point before destructive or publishing actions.

### Classifier and image models in `ctx.tool`

Workflow stages run chat language models. A classifier or image-generation model is called from workflow TypeScript instead, with `@bastani/pi-ai` (the model library Atomic ships) inside `ctx.tool(name, args, fn, { timeoutMs })`, so the request is a durable, replayable node. The boundaries stay fixed: `model: "auto"` selects only chat language models, including chat models that accept image or PDF input; an image-generation or classifier model never executes a workflow stage; and the structured decision model behind `model: "auto"` (chosen by `routerModel`) may be a chat LM or a classifier, never an image model.

Discovery loads a workflow file with the project that owns it as the module root. The host provides `@bastani/atomic/workflows` and `typebox`; every other package resolves from that project's `node_modules`, in npm and standalone-binary installs alike. Install the library next to the workflow at the version `atomic --version` prints, because older releases have no `classify()` or `generateImages()`:

```sh
npm install --save-dev @bastani/pi-ai@"$(atomic --version)"
```

The library reads provider keys from the Atomic process environment (`TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`) or from an explicit `apiKey` request option. It does not read credentials stored by `/login`. Both operations resolve instead of throwing: check `stopReason === "stop"` before using a result, and forward the tool's `signal` so a quit or targeted abort cancels the request.

#### Classify a request before choosing a stage

Use a classifier for a narrow, structured decision such as routing an incoming request. This follows TypeSafe's [intent routing](https://docs.typesafe.ai/patterns/intent-routing.md) and [confidence-gated routing](https://docs.typesafe.ai/patterns/confidence-routing.md) patterns (index: [docs.typesafe.ai/llms.txt](https://docs.typesafe.ai/llms.txt)): one Choice question returns the selected option with a probability per option and a confidence value, and your code decides what to do with that answer. The classifier does **not** execute a stage; workflow code reads its answer and starts a chat stage or asks for human review. Pick thresholds for your own stakes, as TypeSafe's pattern pages do; a threshold is not a guarantee of correctness. In `.atomic/workflows/triage.ts`:

```ts
import { workflow } from "@bastani/atomic/workflows";
import { builtinModels } from "@bastani/pi-ai/providers/all";
import { Type } from "typebox";

export default workflow({
  name: "triage",
  description: "Route a support request to a suitable handler.",
  inputs: { request: Type.String() },
  outputs: { handler: Type.String() },
  run: async (ctx) => {
    const request = ctx.inputs.request;
    const decision = await ctx.tool("classify-intent", { request }, async ({ signal }) => {
      const models = builtinModels();
      const model = models.getModelOfType("classifier", "typesafe", "jev-latest");
      if (!model) throw new Error("TypeSafe classifier is unavailable");
      const result = await models.classify(model, {
        state: { request },
        questions: {
          intent: {
            type: "choice",
            instructions: "Which support handler should review this request?",
            criteria: {
              account: "Questions about an existing account",
              product: "Questions about product behavior",
              other: "Neither account nor product",
            },
          },
        },
      }, { signal });
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? "Classification failed");
      const intent = result.answers.intent;
      if (intent?.type !== "choice") throw new Error("Missing intent answer");
      return { choice: intent.choice, confidence: intent.confidence };
    }, { timeoutMs: 60_000 });

    // Only workflow code chooses the next action; uncertain requests go to a person.
    if (decision.confidence < 0.7 || decision.choice === "other") {
      return { handler: "human review required" };
    }
    await ctx.task(`${decision.choice}-review`, {
      prompt: `Review this ${decision.choice} request and propose a response: ${request}`,
    });
    return { handler: decision.choice };
  },
});
```

The cached `{ choice, confidence }` is what a resumed run replays; the classifier is not asked again. For a consequential action, add policy checks or `ctx.ui.confirm(...)` before the side effect. Without the extra install, a schema-backed stage or task (`ctx.task(name, { schema, prompt })`, as the `classify-and-act` builtin does) is the other way to make a validated decision; its answer comes from a chat LM, and any confidence it reports is text the model wrote, not a classifier probability.

#### Generate an image artifact in a durable tool step

For an illustrative asset or a design mock, call an image model inside `ctx.tool()` and write the returned base64 image to a file; the cached node returns only the path. Image generation uses `generateImages()`, never a stage prompt or `structured_output`. In `.atomic/workflows/preview-asset.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workflow } from "@bastani/atomic/workflows";
import { builtinModels } from "@bastani/pi-ai/providers/all";
import { Type } from "typebox";

export default workflow({
  name: "preview-asset",
  description: "Generate a draft visual asset for review.",
  inputs: { brief: Type.String() },
  outputs: { imagePath: Type.String() },
  run: async (ctx) => {
    const brief = ctx.inputs.brief;
    const outputDir = join(ctx.cwd ?? process.cwd(), ".atomic", "workflow-assets", ctx.runId ?? "local");
    const generated = await ctx.tool("generate-preview", { brief, outputDir }, async ({ signal }) => {
      const models = builtinModels();
      const model = models.getModelOfType("image", "openrouter", "google/gemini-2.5-flash-image");
      if (!model) throw new Error("OpenRouter image model is unavailable");
      const result = await models.generateImages(model, {
        input: [{ type: "text", text: `Draft visual asset: ${brief}` }],
      }, { signal });
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? "Image generation failed");
      const image = result.output.find((block) => block.type === "image");
      if (!image) throw new Error("The response contained no image");
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png";
      const imagePath = join(outputDir, `preview.${extension}`);
      await mkdir(dirname(imagePath), { recursive: true });
      await writeFile(imagePath, Buffer.from(image.data, "base64"));
      return { imagePath };
    }, { timeoutMs: 120_000 });
    return { imagePath: generated.imagePath };
  },
});
```

Hand the path to a later chat stage in its prompt. Review generated assets before publishing them or citing them as evidence: a generated image is not proof of a real-world state.

### Workflow Composition

Use workflow composition when a workflow calls a reusable user-defined workflow from the project or package, or a bundled builtin workflow, and consumes its outputs as a tracked boundary stage. Import the child definition with a normal TypeScript import, then pass it directly to `ctx.workflow(workflowDefinition, options)`. `ctx.workflow(...)` does not accept registry names, path objects, or string aliases.

Compose nested workflows through these tracked boundaries; do not call a child definition's `run` function recursively. Each repeated child call must remain a distinct boundary with stable iteration identity and call order so execution, replay, and hydration preserve an acyclic parent/child topology.

For workflows intended to be called by parent workflows, declare every field a parent should rely on in the child workflow's `outputs` object, including `result`. No output exists without declaration: a child exposes exactly its declared outputs, and returning an undeclared key fails the child call.

#### Compose with a user-defined workflow

User-defined workflows are ordinary TypeScript modules. Import the workflow definition with a relative module specifier and call it directly from the parent workflow:

```ts
// .atomic/workflows/shared-research.ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export default workflow({
  name: "shared-research",
  description: "",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    summary: Type.String({ description: "Research summary markdown." }),
    sources: Type.Optional(Type.Array(Type.String(), { description: "Source URLs and file references." })),
  },
  run: async (ctx) => {
    const result = await ctx.task("research", { prompt: `Research ${String(ctx.inputs.topic)}` });
    return { summary: result.text, sources: [] };
  },
});

// .atomic/workflows/research-and-synthesize.ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import sharedResearch from "./shared-research.js";

export default workflow({
  name: "research-and-synthesize",
  description: "Run shared research and synthesize it.",
  inputs: {
    topic: Type.String(),
  },
  outputs: {
    final: Type.String({ description: "Synthesis built from the child research summary." }),
    child_run_id: Type.String({ description: "Run id of the nested shared-research child." }),
  },
  run: async (ctx) => {
    const child = await ctx.workflow(sharedResearch, {
      inputs: { topic: ctx.inputs.topic },
      stageName: "run shared research",
    });
    if (child.exited === true) {
      return ctx.exit({ status: child.status, reason: child.exitReason ?? "shared research stopped early" });
    }

    const final = await ctx.task("synthesize", {
      prompt: `Synthesize:\n\n${String(child.outputs.summary)}`,
    });
    return { final: final.text, child_run_id: child.runId };
  },
});
```

#### Compose with builtin workflows

Builtin workflow definitions work like user-defined child definitions. Import several from the barrel:

```ts
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
} from "@bastani/atomic/workflows/builtin";
```

Or import one individual module:

```ts
import goal from "@bastani/atomic/workflows/builtin/goal";
import ralph from "@bastani/atomic/workflows/builtin/ralph";
```

Example parent that maps a repository and verifies the synthesis:

```ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";
import { adversarialVerification, fanOutAndSynthesize } from "@bastani/atomic/workflows/builtin";

export default workflow({
  name: "research-and-verify",
  description: "Map repository slices, synthesize evidence, and verify the report.",
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
      stageName: "repository research",
    });
    if (research.exited === true) {
      return ctx.exit({ status: research.status, reason: research.exitReason ?? "research stopped early" });
    }

    const verification = await ctx.workflow(adversarialVerification, {
      inputs: { task: `Verify the cited report at ${research.outputs.synthesis_path}` },
      stageName: "verify research report",
    });
    if (verification.exited === true) {
      return ctx.exit({ status: verification.status, reason: verification.exitReason ?? "verification stopped early" });
    }

    return {
      report_path: research.outputs.synthesis_path,
      approved: verification.outputs.approved,
    };
  },
});
```

Passing a definition directly to `ctx.workflow(...)` uses the child definition's normalized name for replay metadata and the default boundary label.

`ctx.workflow(workflowDefinition)` creates a boundary named `workflow:<workflow-name>` by default. Valid child graphs appear inside the parent graph, including nested stages and human-input prompts. Attach and control actions target the actual child stage even when names repeat. Child runs are not separate top-level status entries. The returned result has:

| Field | Meaning |
|---|---|
| `workflow` | Normalized child workflow name. |
| `runId` | Nested child run id. |
| `status` | `completed` for normal completion, or `skipped` / `cancelled` / `blocked` / `failed` when the child intentionally ended with `ctx.exit(...)`. An unintentional failed child still makes the parent child call throw. |
| `exited` | `false` for normal child completion; `true` when the child used `ctx.exit(...)` (including `ctx.exit({ status: "completed" })`). |
| `outputs` | Full declared child outputs when `exited === false`; partial declared child outputs when `exited === true`. |
| `exitReason` | Optional child `ctx.exit({ reason })` text, present only on the `exited === true` branch. |

`ctx.workflow()` options:

| Option | Meaning |
|---|---|
| `inputs` | Values validated against the child workflow's `inputs` schema map before the child starts. |
| `stageName` | Parent boundary stage label. Defaults to `workflow:<workflow-name>`. |

Output exposure rules:

```ts
const child = await ctx.workflow(sharedResearch);
if (child.exited === true) {
  child.outputs.summary; // string | undefined: ctx.exit({ outputs }) may be partial
} else {
  child.outputs.summary; // string: normal completion returned the full declared contract
  child.outputs.sources; // string[] | undefined: optional output declared by sharedResearch
}
```

A child exposes only outputs declared in `outputs` and returned from `run` or supplied to `ctx.exit({ outputs })`. There are no implicit outputs and no raw return-object passthrough. If `run` returns a key that was not declared in `outputs`, the child run fails with `atomic-workflows: workflow "<childName>" returned undeclared output "<key>"; declare it in outputs or remove it from the run return`, and the parent surfaces that failure through the wrapper `atomic-workflows: child workflow "<childName>" (<displayName>) failed with status failed: ...`. A child with no declared outputs therefore exposes no outputs.

Missing required outputs, schema type mismatches, and non-JSON-serializable returned values fail normal child completion before the parent continues; child `ctx.exit({ outputs })` allows missing required outputs but still validates every provided key and sets `child.exited === true` so parent code must handle the partial shape.

Pass only imported workflow definitions to `ctx.workflow(...)`, not registry names or paths. Missing modules or invalid exports fail discovery. Nested children count against `maxDepth`, default `4` total workflow levels.

A missing, empty, or invalid child graph retains a boundary summary rather than displaying unrelated nodes. Failed or skipped boundaries also retain summaries. Use `stageName` for a concise custom boundary label.

If the parent exits while a child runs, the child is cleaned up and becomes `cancelled`, non-resumable; active child stages and prompts are skipped. No further child work starts after parent exit.

Resume reuses a completed child boundary's recorded outputs without running it again. A child interrupted before completion starts from the beginning. If the parent exits during replay, the boundary is skipped rather than reported as newly completed.
