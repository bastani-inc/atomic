# Context engineering for workflows

Design stage-local contracts and evidence-bearing handoffs so each model sees the smallest sufficient context and reviewers remain independent.

## Context Engineering

A workflow is an information-flow system, not just a list of prompts. Most workflow failures come from missing, stale, oversized, or poorly-routed context. Design every stage boundary deliberately.

### Locally Scoped Stage Prompts

Stage prompts should be local contracts, not miniature descriptions of the entire workflow runtime. Write prompts as if the stage could be executed independently from a fresh session with only the listed inputs. Include:

- the stage's current objective and what is out of scope for this stage
- the exact files, artifacts, child outputs, or user inputs it may use
- the expected output format, or the schema it must return when the workflow item is schema-enabled
- the checks, tools, or deterministic commands it should run when relevant
- the success criteria that let this stage stop

Avoid unrelated workflow internals such as reducer algorithms, future PR stages, sibling reviewer names, loop implementation details, or project-specific nicknames unless they are explicitly part of the current stage contract. If a term such as a gate name, ledger field, or workflow nickname is necessary, define it in the prompt before using it.

Choose context mode deliberately. Use `context: "fork"` or `forkFromSessionFile` for coherent long-running implementation stages that need continuity from their own earlier work. Use `context: "fresh"` for unbiased reviewer, evaluator, and gate stages so they inspect the current files and explicit artifacts rather than inheriting the implementer's assumptions. When continuity is needed across fresh stages, pass it explicitly through files, declared outputs, and `reads`.

### Context-Mode-Aware Prompt Text

Context mode is an execution property configured with `context`/`forkFromSessionFile`; it is not something the model can act on, so keep it out of prompt text:

- **Never describe the stage's own context mode.** Sentences like "you are running in a fresh context window", "your context is clean/non-forked", or "this is a forked session" add tokens without changing behavior. State the concrete action, inputs, and success criteria instead.
- **Fresh stages must not reference invisible context.** A fresh stage has no "previous conversation", cannot see sibling stages, and does not know the surrounding graph, so instructions like "compare against previous workflow reasoning" or "this runs in parallel with the locator pass" are noise at best and confusing at worst. Phrase the same intent stage-locally ("compare the working tree against the baseline branch"; "do your own scan; do not assume any other stage's output is available") and pass any state the stage genuinely needs through files, declared outputs, and `reads`.
- **Forked continuation prompts send only the delta.** A forked stage already carries the role, contracts, guidance, and output format from its own earlier prompts, so repeating them re-spends the tokens and invites drift between the two copies. Send what changed since the fork point — new artifacts, updated state, the next action — plus a one-line pointer back ("the contracts and report format established earlier in this thread still apply unchanged") instead of re-injecting the full text.
- **Keep one canonical copy of shared contracts.** When fresh and forked variants of a stage share guidance, render the full contract only in the prompt that first establishes it and reference it from continuations. If a continuation genuinely needs a contract restated (for example, after a schema change), that is a new contract version, not a repeat.

The builtin `goal` and `ralph` workflows follow this pattern: their first worker/orchestrator prompts carry the full contracts, while forked continuation turns send only the per-turn state (new receipts, the latest review artifacts, the rewritten research file) with a pointer back to the established guidance.

### Context Fundamentals

Treat context as a finite attention budget. Include only information needed for the current decision, place critical constraints near the beginning or end of prompts, and use progressive disclosure instead of loading every possible reference up front.

Common context sources:

- **System instructions:** persistent behavior and guardrails.
- **User inputs:** workflow inputs and human-in-the-loop decisions.
- **Retrieved documents:** files, search results, logs, API responses, and artifacts.
- **Message history:** useful for continuity, but grows quickly in long-running stages.
- **Tool outputs:** often the largest source of context bloat.

For long workflows, assume effective model performance degrades before the advertised context limit. Keep high-signal summaries and artifact references close to the stage that needs them.

### Context Degradation Patterns

Watch for these failure modes in long or multi-stage workflows:

| Pattern | Symptom | Mitigation |
|---------|---------|------------|
| Lost in the middle | Important constraints are ignored in long prompts | Repeat critical constraints near the end; shorten handoffs |
| Context poisoning | Bad or obsolete information steers later stages | Validate sources, overwrite stale artifacts, cite evidence |
| Distraction | Irrelevant context crowds out useful context | Pass only stage-specific files and summaries |
| Confusion | Similar instructions or duplicate facts conflict | Consolidate instructions and name artifacts clearly |
| Clash | User, system, or stage instructions disagree | Resolve conflicts before launching downstream stages |

Use compaction, file references, and bounded loops before context fills with transcript noise. In attached workflow stage chat, manual compaction shows `Compacting context...`, threshold compaction shows `Auto-compacting...`, and overflow recovery shows `Context overflow detected. Auto-compacting...` in the same animated status row used for normal model work. A successful compaction leaves the normal expandable `✻ Context compacted` boundary in the transcript; the boundary is reconstructed from the durable session and has a typed live fallback if the refreshed session snapshot is temporarily unavailable.

### Compression and Artifact Handoffs

Optimize for tokens per completed task, not simply the smallest prompt. Aggressive compression can force later stages to rediscover information.

A good compressed handoff includes:

- objective and current status
- decisions already made
- files, symbols, commands, and artifact paths with evidence
- open questions and known risks
- rejected alternatives when they matter
- next action expected from the downstream stage

Use `output`, `outputMode: "file-only"`, `reads`, and `chainDir` for large research bundles, logs, or reviewer outputs. Keep summaries compact and let downstream stages read full artifacts only when needed. In the downstream stage prompt, explicitly say something like `Read the file at ${artifactPath} before continuing.` Do not inject full session tails, all previous stage outputs, or every prior review round into later prompts by default; pass the latest relevant artifact paths and make older history discoverable from a ledger or index file.

Substantial handoffs should travel through files or durable artifacts instead of hidden transcript assumptions. This keeps stage prompts small, makes review/audit possible, and lets later stages reread the authoritative material without depending on what a previous model happened to summarize.

```ts
const researchPath = ".atomic/workflows/runs/context-demo/research.md";
await ctx.task("researcher", {
  task: "Map the subsystem and save the report.",
  output: researchPath,
  outputMode: "file-only",
});

const review = await ctx.task("reviewer", {
  task: [
    `Research artifact: ${researchPath}`,
    `Read the file at ${researchPath} incrementally and inspect only the sections needed for this review.`,
  ].join("\n"),
  reads: [researchPath],
});
```

### Multi-Agent and Parallel Patterns

Use parallel stages for context isolation and independent work, not just for role labels. Good parallel branches have distinct evidence-gathering or review angles:

- locator / mapper: where relevant files and systems live
- analyzer: how the current implementation works
- pattern finder: how similar code is written elsewhere
- external researcher: what upstream docs or APIs require
- reviewer/evaluator: whether outputs satisfy the validation contract

Have the parent workflow synthesize results rather than letting branches silently make conflicting decisions. If branches must agree, design an explicit consensus or adjudication stage.

### Filesystem Context

Use files as the overflow layer for workflow context:

```text
.atomic/workflows/runs/<run-name>/
  research.md
  reviews/
    correctness.md
    docs.md
  artifacts/
    raw-log.txt
    summary.json
```

Recommended patterns:

- write large tool outputs to files and return concise references
- store plans, state, and reviewer findings in structured markdown or JSON
- pass artifact paths via `reads`; prompt agents with `Read the file at <path>...` rather than pasting artifacts into `{previous}`
- for review loops, pass the latest review-round artifact first and let a ledger/index point to older rounds only when needed
- give parallel branches separate output paths to avoid write conflicts
- use `grep`, globbing, and line-range reads instead of loading entire logs
- clean scratch files or keep them under run-specific directories

### Evaluation and Quality Gates

Build validation into the workflow instead of waiting for a final manual check. Useful gates include:

- deterministic checks: tests, typechecks, linters, schema validation, command exit codes
- rubric checks: completeness, correctness, evidence quality, risk coverage, user fit
- reviewer stages: fresh-context reviewers that inspect artifacts and current files
- LLM-as-judge stages: direct scoring, pairwise comparison, or rubric-based grading for subjective outputs

Prefer schema-enabled workflow items for model review and gate decisions. Atomic passes the schema directly to the final-answer tool and captures the tool arguments; it no longer adds separate structured-output parsing, object-root restrictions, or sidecar validation. Object-shaped decision schemas with explicit booleans/enums, findings arrays, confidence, evidence fields, and error reporting are usually easiest to consume, but array or primitive schemas are valid when they fit the handoff. Avoid brittle regular-expression matching against free-form prose such as “looks good”, “approved”, or “PASS”.

Use small dedicated model stages for adaptive gates when deterministic code alone cannot decide what to check. For example, a stage can read an artifact, inspect the repo, run a named tool or command, and then emit a structured decision by configuring `schema` on that workflow item. Keep that stage's prompt narrow: tell it the specific check to perform, the files/tools it may use, and the structured decision it must return.

When using LLM judges, mitigate bias by defining score anchors, asking for evidence, calibrating against examples, and keeping length/order effects in mind. Track pass rates and failures over time for reusable workflows.

### Tools, MCP, Memory, and Hosted Execution

Constrain each stage to the tools it needs. Too many tools increase ambiguity and token cost; too few tools force brittle workarounds. Tool descriptions should make inputs, side effects, and error handling clear.

Use per-stage `mcp` allow/deny lists when a workflow needs external systems but some stages should remain read-only or isolated. Use memory or durable project knowledge only when cross-run continuity is genuinely required; otherwise prefer explicit inputs and artifacts.

Hosted or remote agent workflows need additional design work: sandbox setup, dependency caching, auth boundaries, artifact transfer, concurrency limits, and multiplayer/session handoff behavior. Optimize startup before the user begins the run; do not make each stage rebuild its environment.

### Task Fit and Project Design

Before turning a process into a workflow, validate that it is a good automation target:

| Proceed when | Avoid or redesign when |
|--------------|------------------------|
| The task needs synthesis across sources | The task requires exact deterministic computation only |
| The output is natural language or judgment with a rubric | The workflow must be perfectly deterministic every run |
| Errors can be caught by review or validation gates | A single hallucination would be unacceptable |
| Stages can be cached, retried, or inspected | Every step depends on unverified previous guesses |
| A manual prototype works on representative inputs | The model lacks required context and cannot retrieve it |

For complex workflows, structure the implementation as a pipeline: acquire context, prepare prompts/artifacts, process with LLM stages, parse or validate outputs, and render the final result.

## Design Checklist

Before implementing or shipping a non-trivial workflow, answer these questions:

- **Purpose and fit:** What concrete outcome should the workflow produce? Is the task naturally multi-stage, parallel, resumable, or reusable? What is out of scope?
- **Inputs:** Which values should be declared as inputs? What is the narrowest schema type? Which defaults are safe?
- **Starter pattern:** Which [workflow starter pattern](/workflow-when-to-use#workflow-starter-patterns) best matches the task, and where does the actual design intentionally diverge?
- **Stage decomposition:** For each stage, what question does it answer, what context does it need, what output should it return, and what model/tool/MCP requirements does it have?
- **Local stage contract:** Can this stage prompt stand alone with its current objective, inputs/artifacts, expected outputs, tools/checks, and success criteria, without unexplained workflow internals or future-stage assumptions?
- **Prompt vocabulary:** Do stage, reviewer, and reducer prompts describe the concrete action, available evidence, and success criteria that the stage can see locally, instead of assuming the model knows the workflow graph's name or surrounding context? Avoid phrasing like "the create-PR workflow stage" or "this Foo workflow" unless that name is explicitly supplied as user-visible context or materially affects behavior.
- **Information flow:** For every edge between stages, is `previous` enough, or should the handoff use structured returns, files, `reads`, `output`, or `outputMode`?
- **Output contract:** Which outputs should be declared in `outputs`, which stage/task/child results should `run` return for those keys, and what runtime type must each value have? If another workflow may call this workflow as a child, which non-default outputs should the parent rely on?
- **Context size:** Can downstream stages succeed from the handoff alone? Should large transcripts, logs, or research bundles be summarized or saved as artifacts?
- **Control flow:** Should the workflow use `ctx.chain`, `ctx.parallel`, `ctx.ui`, bounded loops, `failFast`, or `fallbackModels`?
- **User experience:** Are stage names readable in status and graph views? Is the final output compact? Are important artifacts saved with stable paths?
- **Validation:** What success criteria, review gates, deterministic checks, or evaluator stages prove the workflow did the right thing? Are model gates schema-backed instead of regex/prose-matched, and do adaptive gates run as focused model stages with explicit tool/check instructions?
- **Final actions:** Does the workflow distinguish implementation/review convergence from post-approval final actions such as PR/MR/review creation, release tagging, deployment, or publication? Are reviewers and reducers prompted to approve and hand off when implementation and validation criteria are proven and only an explicitly authorized final action remains?

Good workflows are information-flow systems, not just prompt sequences. Keep stage prompts focused, preserve evidence with file paths or artifacts, and pass only the context each downstream stage needs.

## Common Mistakes

- Do not fabricate workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy workflow tool fields like `agent`, `stage`, or run-control `name`.
- Do not pass strings such as `"goal"` or path objects to `ctx.workflow(...)`; import the workflow definition from `@bastani/workflows/builtin` or another TypeScript module first.
- Do not rely on undeclared child outputs; returning a key that is not declared in `outputs` fails the run. Declare every child-workflow field you expose in `outputs` — including `result` — and return values matching those schemas from `run`.
- Do not expect to select or rename child outputs at the call site; parent workflows receive the child's declared output contract as `child.outputs` after checking `child.exited === false`, and a partial declared-output map when `child.exited === true`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Use `interrupt` or `pause` when the user asks to pause specific live work resumably; use `quit` for a graceful run-level process boundary.
- Keep stage names readable because they appear in workflow status and UI.
- Do not ask a stage to reason from workflow or stage names that are only orchestration labels. Model stages see their local prompt/artifacts/tools; describe the action to perform and the evidence to use (`review the current code delta`, `create/update the review request`) instead of relying on labels such as `the create-PR workflow stage`, `this Goal run`, or `the Ralph reviewer`.
- Do not write stage prompts that depend on hidden workflow-wide awareness; make each model stage locally scoped and self-described.
- Do not parse model gate decisions from ad-hoc prose with regular expressions; configure `schema` on a focused workflow item and consume `result.structured`.
- Do not make reviewers fail an implementation gate solely because an authorized final action has not run yet. Represent that remainder as a post-approval next action (for example `finalActionRemaining` / `nextAction`) and let the final stage perform it.
- Return compact structured decisions and save large artifacts to files; artifact handoffs should still use files when the next stage does not need the whole payload in context.
