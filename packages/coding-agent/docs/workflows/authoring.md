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

**A workflow executes inside whichever host is running Atomic, so its code has to work on both.** Standalone binaries are Bun-compiled while npm installs run under Node, and the active host is what loads your workflow file — so a `Bun.*` global reaches a workflow only when Atomic itself is running under Bun, and fails with `Bun is not defined` otherwise. Installing Bun separately does not change this. Write workflow code against APIs both hosts provide: `node:child_process` instead of `Bun.spawn`/`Bun.spawnSync`, `node:fs` instead of `Bun.file`, `node:path` instead of Bun's path helpers. Every example on this page follows that rule; a snippet that deliberately requires one host is marked with a `host-specific:` comment naming it.

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

Keep a small, readable workflow in one entry file and write it for human maintainers. Keep the graph and control flow visible in the top-level workflow entry file, use stage names that state each stage's responsibility, and make its inputs, outputs, evidence, and success contract explicit. A developer reading the entry file from top to bottom should be able to identify the graph, branches, gates, artifacts, and stop conditions. Avoid both monolithic prompt blobs and gratuitous fragmentation: do not split short one-use prompts, create one file per stage, add wrapper-only modules, hide the graph across files, or use line counts alone as a module boundary.

When a meaningful source boundary improves clarity, reuse, ownership, or testability, keep the graph and control flow in the top-level workflow entry file and extract cohesive concerns:

- long or reused prompt builders;
- shared TypeBox schemas and workflow-specific types;
- model-policy constants shared by several stages;
- deterministic helpers with their own testable behavior; and
- reusable child workflow definitions.

Put those support modules in a subdirectory below the top-level discovery directory — either one owned by a single workflow or a shared support directory for several workflows. Project and user discovery scans only top-level `.ts`/`.js`/`.mjs`/`.cjs` files in the workflow directory; the scan is non-recursive, so support modules in subdirectories are not scanned as extra top-level workflow candidates. Every top-level candidate in any of those four extensions is imported and each of its exports is shape-checked, so a support module left at the top level produces definition diagnostics for its non-workflow exports regardless of extension. Use `.js` import extensions from TypeScript source, following the repository convention.

The repository uses this shape in `.atomic/workflows/release-docs.ts`: the entry file keeps the graph and imports deterministic helpers from `.atomic/workflows/lib/release-docs.ts`, a shared support directory that also holds the separate `publish-release` helper. A workflow-owned subdirectory is an equally valid layout for a custom workflow:

```text
.atomic/workflows/code-review.ts
.atomic/workflows/code-review/prompts.ts
.atomic/workflows/code-review/schemas.ts
.atomic/workflows/code-review/model-policy.ts
```

The subdirectory is for cohesive, reusable support code, not a requirement to give every prompt or stage its own file.

### Workflow and extension responsibilities

Evaluate Atomic extension hooks when a workflow needs fine-grained, cross-cutting tool or session event control. Workflow TypeScript owns the inspectable DAG, stages, handoffs, durable `ctx.tool` side effects, and gates. Extension hooks own cross-cutting session and model-tool policy such as `tool_call` interception, input mutation, or blocking; `tool_result` transformation; context and provider hooks; lifecycle observation; or reusable custom tools. Use hooks only when cross-stage or cross-workflow event control is materially clearer than embedding the policy in each stage. Do not require a companion extension for ordinary workflow logic. See the authoritative [extension event documentation](/extensions#events) for hook contracts and ordering.

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

Runtime and replayed topology checks are the authoritative cycle boundary. If code that materializes or restores topology changes, cover every new parent edge with incremental edge checks and validate reconstruction during execution, replay, and DBOS hydration. Authoring guidance cannot replace those runtime checks or make malformed durable topology safe.

### Guiding Principles

- **Locally scoped stage prompts** - Describe only the current stage's objective, inputs, expected outputs, and success criteria. Avoid references to other stages unless the current stage explicitly receives and needs that information, and avoid workflow-specific or stage-specific vocabulary that is not explained inside the current prompt. See [Locally Scoped Stage Prompts](/workflows/reliable-design#locally-scoped-stage-prompts) for the expanded contract.
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

Outputs are declared with TypeBox `Type.*` schemas in the `outputs` object. **Prefer precise schemas.** A precise schema gives a precise `Static<>` type for the `run` return and for any parent reading `child.outputs`, and it makes runtime validation enforce the real shape instead of accepting values without checking that precise shape. Reach for `Type.Unknown()`, `Type.Any()`, `Type.Array(Type.Unknown())`, or `Type.Object({}, { additionalProperties: true })` only for genuinely dynamic data whose shape you cannot know ahead of time.

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

Tradeoff: `Type.Unsafe<T>()` does not deeply validate at runtime — it trusts that the produced value matches `T`. Use it when the producing code already guarantees the shape (the `contract-complex-leaf` contract workflow does exactly this, wrapping `Type.Unsafe<ComplexPacket>(...)` and `Type.Unsafe<readonly ComplexRecord[]>(...)` around permissive runtime schemas). When you can express the shape directly, prefer a real `Type.Object(...)`/`Type.Array(...)` so runtime validation also catches drift. Keep bare `Type.Unknown()` and `Type.Object({}, { additionalProperties: true })` for the rare cases where the value is genuinely dynamic.

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

Each queue is FIFO in admission order. There is no global FIFO *across* the two queues: steering keeps its semantic priority even when a follow-up was submitted earlier. A controlled pause or interrupt hold delays eligibility but preserves both the queue class and the order within it. An abort, kill, or fatal provider failure ends the turn without consuming what is still queued.

A message you type into an attached stage chat and submit with Enter defaults to `steer`, matching normal (non-workflow) session steering, so a mid-run correction lands at the next steering boundary rather than at the end of the turn. Ctrl+F queues a follow-up instead. This is a property of the interactive surface, not of the API: an authored `stage.sendUserMessage()` call that names no `deliverAs` still defaults to follow-up while the stage is streaming.

Custom `AgentSessionAdapter` implementations must make asynchronous idle-turn ownership observable through their public `subscribe()` stream: emit `{ type: "agent_start" }` when the submitted message has entered the turn, before waiting for that turn to finish, and emit `{ type: "agent_end", messages }` when that turn terminates. This applies both to native `sendUserMessage()` implementations and to the required `prompt()` fallback when `sendUserMessage` is omitted. Atomic retains the resulting logical ownership after releasing serialized message admission, so a concurrent second message is routed as steering/follow-up rather than another prompt even when the adapter publishes `isStreaming` asynchronously after `agent_start`. Correlated turn generations prevent a late end or older delivery settlement from clearing a newer owner. A subscription may replay earlier lifecycle state synchronously during registration; an untagged synchronous replay is treated as a snapshot and does not consume a later current-turn end. If an adapter can emit a delayed end for a replayed turn while a newer turn is active, it must attach the same stable string or numeric `turnId` to that replayed `agent_start` and its matching `agent_end`; Atomic then correlates the old end without disturbing current ownership. After `subscribe()` returns, adapters must emit `agent_start` only for newly started turns, never as a delayed replay of an earlier turn. Adapters that enter streaming synchronously are also detected through `isStreaming`; the bundled Atomic session additionally retains its internal handshake for compatibility. Implementations must not delay the current turn's `agent_start` until turn completion.

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

A session announces its queue by `queue_update`, so a queue that exists before Atomic's listeners reach that session is announced to nobody — which happens when a retiring session hands its pending messages to the session replacing it, and when a retained session is reopened for post-mortem chat holding what it was queued. Atomic reads these two methods once, as it attaches a session, and replays the missed snapshot to that stage's listeners; every later change still arrives as an ordinary event. An adapter that omits them loses nothing it had before: only a queue predating the attach is invisible, and a session that starts empty never had one.

Externally produced traffic has a separate lifecycle rule. Intercom messages and subagent completion notices received while a workflow stage generation is still open are admitted through the stage AgentSession's native steering/follow-up queue. For a busy stage, admission into the generation boundary happens synchronously before the exact foreground subagent owner's probe/commit detach handshake; model-visible queue insertion waits inside that admitted delivery until the handshake is claimed or falls back after an unclaimed/vanished owner. A commit accepted within a parallel foreground group releases aggregate supervision for every active sibling while retaining their process and eventual-result ownership. Reserving admission before the asynchronous handshake prevents terminal close from overtaking an in-flight Intercom delivery, while waiting inside the reservation prevents a blocking child request from queueing behind either a single foreground tool call or a parallel aggregate still waiting on another child. The stage drains already-admitted work before publishing its terminal snapshot, including schema-backed turns that have already called `structured_output`.

Closing the generation is atomic with admission: a notification admitted first belongs to that stage, while ordinary detached notifications arriving after close cannot reopen or mutate the completed stage and are surfaced once through the main-chat notification path instead. A blocking sibling `intercom.ask` is the deliberate exception: when the completed stage retains a valid conversation, Atomic schedules a post-mortem turn in that conversation so it can inspect the exact ask and reply without changing terminal workflow state. Failed running-stage admission and failed post-mortem admission return correlated actionable errors to the asker instead of consuming the full reply timeout.

Stage completion never waits for producers that are still running; only traffic already admitted at the close boundary is drained. Explicit `sendUserMessage()` calls and post-mortem stage chat remain deliberate user/workflow-authored follow-up turns on the retained session.

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

`reason` from a valid author exit is persisted and shown in status surfaces and lifecycle notices, including the default `/workflow status` list and `/workflow status <runId>` detail, so do not put secrets in it. An exit rejected during validation is finalized as an ordinary failed run rather than an accepted author exit. `outputs` may contain a partial subset of declared outputs; provided keys still must be declared in the workflow's `outputs` object, match their TypeBox schema, and be JSON-serializable. `failed` exits default to `resumable: false`; set `resumable: true` only when a later durable retry is intended. `resumable` is valid only with `status: "failed"`; supplying it for another status records a non-resumable authoring failure. A durable retry keeps the failed handle in the resume catalog and re-dispatches the workflow with completed checkpoints replayed. The low-level `resumeRun()` helper only inspects terminal runs; it reports the durable retry path instead of silently claiming that it resumed. The other exit statuses keep their existing non-resumable author-exit behavior. Public `pause`, `interrupt`, and `quit`, plus internal destructive cancellation, keep their distinct existing behavior.

An author-initiated failed exit returns to a parent as `{ exited: true, status: "failed" }` with its reason and partial outputs; it does not throw. An unintentional child failure still throws, so check `child.exited === true` before reading required child outputs and use the discriminator to branch. The lifecycle terminal notice uses the same steer/trigger-turn delivery path and references partial outputs so the launching agent does not need a separate status call.

The first selected `ctx.exit({ outputs })` snapshots its output payload synchronously by value before JavaScript `finally` blocks or cleanup callbacks can mutate the caller-owned object. The snapshot preserves undeclared keys and invalid values until post-cleanup validation, so deleting an undeclared key or changing an invalid value after `ctx.exit(...)` does not change the terminal validation result.

If reading `status`, `reason`, `resumable`, or `outputs`, or enumerating/copying the output snapshot itself, throws, Atomic still selects the exit signal, runs workflow-exit cleanup when feasible, and then records a terminal non-resumable authoring failure (`resumable: false`) if no external terminal control won first.

After the first `ctx.exit(...)` wins, the executor treats that exit as a level-triggered gate. Later delayed calls to `ctx.stage`, `ctx.task`, `ctx.chain`, `ctx.parallel`, `ctx.workflow`, or graph-backed `ctx.ui.*` prompts rethrow the selected exit signal before creating stages, prompt nodes, child runs, or control handles. Retained `StageContext` handles from before the exit also become inert: `prompt`, `complete`, steering/follow-up, model/thinking controls, tree navigation, compaction, abort, and attached-pane session-realization paths refuse to touch or create an `AgentSession` after the exit is selected.

`ctx.parallel` stops dequeuing queued work after exit even with `failFast: false` and limited concurrency; already-started stages and prompt nodes are finalized as `skipped` with a `workflow-exit` reason that prompt-node abort handling preserves instead of overwriting with a generic run-aborted reason.

Continuation replay also observes the exit gate. Replayed `ctx.stage(...).prompt(...)`, replayed `complete(...)`, graph-backed prompt-node replay, and completed child-boundary replay re-check for a selected exit after their replay microtask and before writing a current-run completed stage end. If `ctx.exit(...)` wins that gap, the pending replay finalizer is skipped/suppressed with the workflow-exit reason instead of creating a misleading completed stage in the resumed run.

The store is the terminal authority for all run-end races. `ctx.exit(...)` starts cleanup before validating exit outputs, and an internal destructive cancellation can still win the terminal `recordRunEnd` write while that cleanup is pending. When that happens, the SDK `RunResult`, `onRunEnd` callback, live store, and persisted `workflow.run.end` entries all report the canonical `killed` state; the losing `ctx.exit` status or validation failure is not returned and does not append a second run-end entry.

Control-signal probing is fail-closed. When the executor inspects an arbitrary thrown value or abort reason for internal workflow-exit markers, parent-exit markers, aggregate `errors`, `cause`, `reason`, or `scope`, throwing or inaccessible accessors are treated as “no signal for that branch.” The run then continues through ordinary failure finalization, or the ordinary killed path for external abort reasons, instead of letting author-defined getters escape the executor catch path or be misclassified as `ctx.exit(...)`.

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

`ctx.workflow(workflowDefinition)` starts a nested workflow behind a parent boundary stage named `workflow:<workflow-name>` by default. User-facing status and graph views flatten a valid child graph into the parent run recursively, so composition behaves like inlining the child workflow code: child stages, HIL prompt nodes, and deeper imported workflows appear in one expanded graph. When Atomic hides a valid import boundary, every boundary parent connects to every child root, and every child terminal connects to each downstream dependent of the boundary. Every visible child node keeps a distinct virtual graph ID and its exact `{ runId, stageId }` control target, even when sibling or repeated child workflows reuse local stage IDs or names. Attach, send, pause, interrupt, resume, stage selection, and post-mortem chat therefore route to the nested run and stage that actually own the node. Implementation-owned child runs are not shown as separate top-level `/workflow status` entries. The returned child result has:

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

Pass only workflow definitions to `ctx.workflow(...)`. Import reusable workflows with TypeScript `import` statements first; registry names are only for top-level named runs, not `ctx.workflow(...)` arguments. If a module is missing or does not export a workflow definition, workflow discovery fails when loading that module. Nested child workflows count against `maxDepth` (default `4` total workflow levels).

Atomic hides an import boundary only when the referenced child run is non-empty and reciprocally identifies that parent run and boundary stage. The same rule applies recursively at deeper nesting levels. If no valid child graph can stand in for the boundary—including a failed or skipped boundary, a missing or empty child graph, stale or mismatched ownership metadata, or a recursive link that cannot produce a valid expansion—the graph keeps the boundary summary node instead of flattening an unrelated or invalid child. Running and completed boundaries with valid child graphs are flattened; completed summaries still retain the child workflow name, full child run id, and exposed output count for replay/debugging when fallback is required.

Use `stageName` when the parent needs a more specific label, but keep it concise so the child summary remains readable in the graph.

If a parent workflow exits through `ctx.exit(...)` while a child workflow is in flight, the parent executor only skips the parent boundary and sends the child a typed parent-exit abort reason. The hidden child executor owns child cleanup: active child stages and prompt nodes are skipped for `workflow-exit`, live child stage handles/sessions are disposed, and the child run is finalized as terminal `cancelled` (not `killed`) and non-resumable.

The child executor writes each skipped child `workflow.stage.end` exactly once before its child `workflow.run.end`, and parent exit finalization waits for that child cleanup before writing the parent `workflow.run.end`, so restored sessions do not reconstruct the child as interrupted or failed. The skipped parent boundary clears any live child-run edge before store or persistence updates, so status/graph views do not display stale child stages from a boundary that did not complete. A delayed parent branch that calls `ctx.workflow(...)` after the exit gate is selected does not create a boundary or child run.

Continuation replay treats the parent child-workflow boundary as the durable checkpoint: a previously completed child boundary replays with the original exposed outputs and without re-running the child, while a child that failed or was interrupted before completion starts again from the beginning on continuation. If `ctx.exit(...)` wins while a completed boundary is being replayed but before replay finalization, the boundary is finalized as skipped and its preloaded child metadata is omitted from store, persistence, restore, and expanded graph views.
