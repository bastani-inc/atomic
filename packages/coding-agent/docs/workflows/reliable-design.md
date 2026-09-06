# Reliable Workflow Design

Use this guide to turn an objective into an acyclic, evidence-producing workflow with explicit contracts, context boundaries, verification, and stop conditions. Read [Custom Workflow Authoring](/workflows/authoring) first if you have not built a workflow definition yet.

First honor the user's task-scoped [execution-mode choice](/workflows/verification#execution-mode). Explicit inline/no-workflow requests override the routing rubric below, including complex tasks and review loops; preserve the same safety and verification bar without creating a hidden workflow. For workflow authoring, carry the [domain/environment verification and media evidence contract](/workflows/verification) into worker, reviewer and final handoff prompts.

## Choosing an Execution Shape

"Use a workflow" is not one decision — it covers several execution shapes with different costs and guarantees. This section is written as agent-facing guidance: it is the self-prompt an orchestrating agent should run before the first tool call on a new request, and it doubles as documentation for humans who want to steer that choice explicitly.

> **Multi-item routing rule:** Enumerate requested implementation items and prove their dependencies before launch. Run independent items as separate concurrent top-level workflow runs with bounded concurrency, one explicit worktree and root failure boundary per item. Preserve ordered composition only for real code, artifact, contract, decision, approval, or merged-result dependencies.

The shapes, cheapest first:

| Shape | What it is | Guarantees you gain | Cost you pay |
|---|---|---|---|
| **Inline** | Answer or edit directly in the current session. | Lowest latency, zero ceremony. | No tracking, no gates, no isolation, easy to drift. |
| **Inline + subagents** | Bounded specialist delegation while the parent keeps control and synthesizes. | Context isolation for noisy or parallel evidence-gathering. | No completion gate or durable stages; the parent remains the reviewer. |
| **Named workflows** | Installed builtin, project, user, or package workflows. | A tested graph with known inputs, outputs, gates, and artifacts. | The task must match the graph's objective and contract. |
| **Custom workflow** | A task-specific TypeScript `workflow({...})` composed from common patterns. | Exact control flow for runtime branching, fan-out, gates, tournaments, and bounded loops. | Authoring and reload time; you own design quality. |
| **Composed/nested workflows** | A parent that imports definitions and calls `ctx.workflow(child)`. | Reuse of tested children inside custom control flow, within `maxDepth`. | Parent/child input-output contracts must be mapped deliberately. |

### The self-prompt: pre-launch workflow architecture

For every non-trivial workflow task, perform a short workflow-architecture pass before the first launch. Choose the execution shape before starting substantive work; reconnaissance already counts as inline execution. Derive the task's implementation lifecycle needs, whole-codebase research needs, independent work slices, competing strategies, exact API/type/build contracts, schema or generated-artifact contracts, state-transition/lifecycle behavior, deterministic stop conditions, and required evidence.

For coding tasks, that pass also infers repository intent from repo-level behavior before objectives and acceptance criteria freeze: mine git history (including `git log --show-signature`), merged PRs, issues, commits, and review comments for unwritten conventions — commit signing, message style and issue linking, changelog discipline, PR size and review norms — weighing the requesting user's own activity highest so the authored contract captures norms no doc states. Non-coding tasks mine their analogous available context sources (issue trackers, long-form docs, chat or comment threads, prior artifacts) the same way. Inferred conventions fill contract gaps; they never override the stated objective or explicit repository docs.

Use this compact coverage matrix internally (it may stay concise for a straightforward task), and let every unresolved material row change the graph choice:

```text
requirement/risk | required evidence | workflow/stage that produces it | gap
```

For any custom or composed graph, add this row and resolve it before launch:

```text
acyclic topology | node/edge sketch for branches and loops | architecture pass | unresolved back-edge
```

Answer these topology questions as part of the pass:

1. Which stages may repeat?
2. Does each iteration create distinct tracked work?
3. What is the current frontier before each repeated stage?
4. Could any proposed parent edge target an ancestor or the node itself?
5. Are nested child workflows composed through boundaries rather than recursive `run` invocation?
6. Does resume/replay rely on stable per-iteration identity and call order?

Sketch expected nodes and dependencies for each branch, loop, and nested boundary. Any unresolved self-edge or back-edge must change the workflow design before launch.

Compare candidate workflow **guarantees**, not only broad descriptions. A named graph fits only when it covers the task's lifecycle **and** produces the evidence required for every material requirement/risk. A generic implementation workflow can cover the lifecycle while missing exact API/type/build contracts, schemas/generated artifacts, state transitions, or domain-specific gates. **Do not treat "has reviewers" as proof that a task-specific risk is covered.**

Ask these questions in order and stop at the cheapest shape that satisfies every remaining coverage row:

1. **Is the outcome provable?** If success can be stated as evidence (tests green, artifact exists, behavior demonstrated, reviewer approves), the task fits a workflow. If no proof is possible or needed, inline is probably fine.
2. **Is there structure?** Multiple subtasks, dependencies, handoffs, or parallel slices rule out inline execution. A single focused evidence-gathering pass does not.
3. **Is there a loop or gate?** Any "until Y", "fix until passing", review/approval gate, or unknown-length repair cycle requires a workflow that enforces the stop condition, never an improvised inline retry loop or an overextended subagent call.
4. **Is it one task or a queue of tasks?** "Address all open issues" or "fix every ticket assigned to me" is a factory request, not one workflow. Enumerate and dependency-classify the items first, then follow [Task queues and software factories](#task-queues-and-software-factories): independent items become bounded concurrent top-level per-item runs; dependent items share one ordered composed graph; independent dependency clusters become separate top-level runs.
5. **Does an installed graph supply complete coverage?** Run a named workflow only if its objective, inputs, lifecycle, and produced evidence cover every material row. Do not force-fit a broad-but-partial match ([When to Use Workflows](/workflows#when-to-use-workflows)).
6. **What routing signals shape the graph?** Broad repository uncertainty points to repository-focused Fan-out-and-synthesize; independent slices to Fan-out-and-synthesize; plausible-but-wrong contract risk to Adversarial verification or a task-specific verification stage; competing architectures or implementations to Generate-and-filter or Tournament; an explicit repeat-until condition to Loop until done; implementation work to a task-specific worker/reviewer loop; and exact API/build/schema requirements to dedicated deterministic gates.
7. **Does a tested graph solve only part of the task?** Author one custom parent and nest that definition with `ctx.workflow(...)`, placing the missing research, verification, or deterministic gates around it instead of copying its prompts and gates.
8. **Is it only specialist evidence-gathering?** If the parent keeps control, no completion gate is needed, and the work is bounded (a debug pass, a parallel research fanout, one noisy investigation), inline subagents are enough—and cheaper than a workflow.
9. **Is it truly tiny?** Deterministic, low-risk, single-file/no-test/no-review—answer or edit inline and stop.

A first named workflow launch commits the selected execution shape for the turn. For one task, end the turn after that launch. For an independent queue, the selected shape is a bounded launch wave: issue every planned per-item top-level launch up to the concurrency bound before ending the turn. Do not casually chain unplanned unrelated top-level workflow launches. When one task needs multiple workflow capabilities or dependent items need ordered handoffs, design composition **before** launch: author one custom parent, import project/package definitions or builtins from `@bastani/atomic/workflows/builtin`, and call `ctx.workflow(...)`. Nested children preserve their stages and guarantees within the expanded graph up to `maxDepth`, but they remain under the parent's root lifecycle and failure boundary.

Choose the cheapest complete graph. Routing cues are not a reason to add decorative stages: avoid duplicated research and review loops. Before launch, state the selected graph, why one broad builtin is sufficient or insufficient, the evidence each major stage produces, and the stop/repair conditions. A simple direct match can be one sentence; a composed graph should briefly name its children and task-specific gates.

### Stage model and thinking-level assignment

Before launching an authored workflow, assign every model stage a **role**, **failure cost**, **primary model**, **thinking level**, and **fallback policy**. Read [Model Selection](/models/model-selection) for the role defaults and [Evals](/models/evals) for the measured per-evaluation scores — its task-type picker maps each stage type (terminal debugging, knowledge-work planning, tool-calling loops, document research, code-reading review) to the eval that measures it and the models that lead it — but treat thinking levels in benchmark rows as measurement configurations, not production defaults. Reserve `max` for high-cost-of-error roles or an explicit user request; use `high` for demanding mapping, lifecycle analysis, compatibility, planning, synthesis, triage, and repair; use `medium` for user-impact review and final reporting; and keep deterministic checks as tool nodes with no model call.

Print this compact assignment before launch, with a short cost/quality rationale for each model stage:

```text
Stage | Model | Thinking | Role
map | <catalog fullId> | high | codebase mapping
approve | <catalog fullId> | max | final approval
report | <catalog fullId> | medium | final reporting
tests | — | — | deterministic check (tool node)
```

An explicit user request for a thinking level always wins over the role default, but the requested level must still be supported by the configured catalog. Apply the role and failure-cost policy independently to the primary and every fallback; a fallback must not inherit `max` mechanically. Call `workflow({ action: "models" })`, use only each returned entry's `fullId` and `availableThinkingLevels`, and if the role level is unsupported choose another catalog model or leave the stage unpinned rather than inventing a suffix. An empty or unavailable catalog is not a reason to fabricate a model or level. Deterministic typechecks, tests, schema checks, runtime probes, and artifact inspection remain durable tool gates rather than model self-report.

When an arbitrary task-specific workflow has plausible-but-wrong contract risk, design a bounded evidence-backed adversarial loop:

1. Give a fresh-context, grumpy/skeptical-but-fair reviewer the literal objective. It should aggressively seek realistic counterexamples without inventing requirements or accepting hand-waving and circular worker-authored evidence, then emit a structured verifier plan: exact probe, inputs, command/assertion, expected success condition, and requirement/risk covered.
2. For known contracts, author direct task-specific `ctx.tool(...)` gates up front. For adversarially discovered risks, let the model select high-value probes in structured output, but execute the selected compile, test, schema generation/validation, runtime, and artifact-inspection checks authoritatively through durable workflow-owned `ctx.tool(...)` calls. The model must not self-report outcomes.
3. Feed the actual tool results to a skeptical evaluation stage. It classifies failures and emits one consolidated, evidence-backed, bounded repair payload for the implementation child.
4. After repair, rerun the deterministic verifier tools until the declared pass condition succeeds or the iteration budget is exhausted. Define pass, repair, failure, and iteration-limit conditions before launch.

Use `ctx.tool` for workflow-owned external checks and side effects that benefit from durable checkpointing. Leave pure transformations as ordinary TypeScript; do not wrap every model-stage action in a tool call. A custom-loop pre-launch declaration must name the skeptical reviewer, deterministic verifier gates, how model-selected plans become tool executions, how evidence reaches evaluation/repair, and the bounded success/failure condition.

### Judging task complexity

Complexity is a property of risk, not effort. Score a task on five axes and let the **worst axis dominate** — complexity is not the sum:

| Axis | Low | High |
|---|---|---|
| **Blast radius** | one file, one function | crosses module/package boundaries; touches shared contracts (APIs, schemas, migrations) |
| **Uncertainty** | the exact edit is known before opening the file | the location or cause of the behavior is unknown |
| **Verifiability cost** | type-checker or a glance confirms it | multi-step validation: build + tests + runtime behavior + artifact checks |
| **Dependency structure** | independent steps | ordered handoffs where an early mistake propagates |
| **Failure cost** | reversible edit | wire formats, published APIs, data migrations, releases |

A one-line change to a serialization format is complex (high failure cost, exact contract). A 500-line mechanical rename is simple (zero uncertainty, type-checker-verified). The common trap is judging by effort instead of risk: long-but-mechanical is simple; short-but-contractual is not.

Fast tells, usable in the first 30 seconds:

- **Done-condition test:** if the success condition does not fit in one sentence, the task is complex or underspecified — clarify before guessing.
- **The "and" test:** "fix X and update docs and add a test" is three tasks in one sentence; enumerate and classify each.
- **Loop words:** "until it passes", "keep trying" make the task at least moderate — iteration is expected.
- **Working-memory test:** more than about three interacting constraints at once means complex.

**Threshold.** A task earns a workflow when at least two of these are true, or any one is strongly true:

1. Two or more distinct phases with a real handoff (research → implement, implement → verify), not just steps.
2. The done-condition needs proof — tests, builds, review, or a contract check. If "how do you know it works?" is a fair question, a verification stage is waiting to exist.
3. Iteration is expected — an anticipated repair loop, not a straight line.
4. Failure cost is high — even a one-line change gets adversarial verification.
5. The work outlives one attention span — losing mid-task state is a real risk.

The honest form of the threshold is a comparison: workflow overhead is roughly constant and small, while the cost of being wrong inline scales with uncertainty × failure cost — so the line crosses at "moderate" on any single axis. Guard against the ratchet failure mode: a task that looked simple, then accumulated exploratory calls, ad-hoc fixes, and an untracked mental TODO list is a workflow being run badly in-head; apply the ten-call rule from [When to Use Workflows](/workflows#when-to-use-workflows). Map axes to action: all low → inline now; only uncertainty high → short recon, then re-judge; any axis high with a checkable outcome → workflow with a stage producing evidence for the worst axis; failure cost high → add deterministic or adversarial gates regardless of the rest. When the mapping stays ambiguous, fall through to the [scoring rubric](#scoring-rubric) below.

### Scoring rubric

When the ladder is ambiguous, score the task on six dimensions (0–2 each):

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| **Structure** | one action | a few sequential steps | many steps, dependencies, or parallel slices |
| **Verifiability** | no objective check | spot-checkable | provable by tests, builds, artifacts, or review evidence |
| **Iteration** | one pass suffices | may need one repair round | unknown-length loop until evidence passes |
| **Risk** | trivial, reversible | scoped multi-file change | regressions, migrations, releases, or user-visible behavior |
| **Duration** | seconds to minutes | tens of minutes | long-running, background, or resumable across sessions |
| **Isolation** | one context is fine | one noisy investigation to quarantine | many slices needing clean contexts or adversarial independence |

Interpretation:

- **0–3 total:** inline. Adding stages creates more work than value.
- **4–6 total, Iteration ≤ 1, no gate:** inline subagents when the parent should retain control, or a small named/custom workflow when tracking and artifacts matter.
- **7+ total, or Iteration = 2, or Verifiability = 2 with a review/approval gate:** a real workflow. Prefer a named workflow when one fits the whole task; otherwise author a custom graph, nesting proven children where sub-problems overlap.
- **Any single hard signal overrides the arithmetic:** an explicit loop/stop condition, an approval or evidence gate, or a request for durable/background execution puts the task in workflow territory regardless of total score.

When workflow execution is permitted, use the rubric to select tracked implementation/review loops and transfer bounded reconnaissance through `reads`. It does not override an explicit inline request. In either mode, stop unbounded reconnaissance by recording findings and taking the next concrete in-scope action.

### Task queues and software factories

Some requests are not one task but a queue of them: "address all open issues", "fix every Linear ticket assigned to me", "burn down the TODO backlog", or "implement issue A and create a PR after; also implement issue B and create a PR after". One monolithic worker loop would process the queue serially in a growing context and make unrelated work share one root failure boundary.

Do not confuse splitting a queue across runs with splitting one objective across slices. Queue triage separates unrelated implementation items into top-level lifecycles; [Stacked implementation slices](#stacked-implementation-slices-starter-pattern) keeps one dependent objective in one parent and verifies each ordered child slice before the next.

**Interpret ordering words locally unless a cross-item dependency is explicit.** "Implement A and create PR A after; implement B and create PR B after" normally means `implement A → validate A → PR A` and `implement B → validate B → PR B`; those two item lifecycles may run concurrently. It does not mean `PR A → start B`. Serialize only when the user or repository evidence says, for example, "implement B after A is merged", "B builds on A's branch", "use A's generated schema in B", or "do these in order". Do not infer a cross-item sequence from list order or from "create a PR after" when "after" naturally refers to that item's own implementation. Prove the dependency before serializing independent workflow items. If wording remains materially ambiguous after dependency research, ask one grouped clarification instead of silently serializing.

**Triage before dispatch:**

1. Enumerate every requested item.
2. Inspect stated issue, PR, branch, and approval dependencies.
3. Check whether each prerequisite is already merged into the base each run will use. A merged prerequisite does not serialize current items when every base contains it. An unmerged prerequisite delays only the item or dependency cluster that consumes it; unrelated items remain eligible for separate concurrent workflow runs under the queue's bound.
4. Check likely shared files, API contracts, migrations, generated artifacts, and release or deployment effects. A shared unmerged contract can create a dependency even when items edit different files.
5. Classify items as **independent**, **dependent**, or **clustered**.
6. Dispatch independent items or clusters concurrently with an explicit concurrency bound; preserve dependency order inside each cluster.
7. Report an item → run ID → worktree → branch → result/PR map. After each terminal lifecycle notice, inspect that run's status detail before updating its result/PR fields.

| Relationship | Execution shape |
|---|---|
| Independent issues in separate code areas | Separate top-level workflow runs in bounded parallel waves |
| A prerequisite is already merged into every selected base | Treat the prerequisite as satisfied; run otherwise independent items in parallel |
| Same files or a shared unmerged API, schema, migration, or generated artifact | One ordered/composed workflow, or one ordered run per dependent cluster |
| One issue explicitly builds on another branch, PR, artifact, decision, approval, or merged result | Sequential dependency |
| Independent clusters with internal dependencies | Separate cluster runs in parallel; compose or sequence items inside each cluster |
| Material dependency remains unclear | Ask one grouped clarification before implementation |

**Workflow run isolation and Git worktree isolation are separate guarantees.** A top-level run provides its own context, progress, lifecycle controls, retry state, and root failure boundary. A worktree provides a separate checkout and Git state; it is not an operating-system sandbox. Several worktrees inside one sequential root do not create concurrent top-level runs or independent root failure boundaries, while concurrent writer runs without separate worktrees can still conflict. Use both for independent implementation items.

A natural-language request for a worktree does not configure runner isolation. Inspect the named workflow's inputs first. Each per-item definition must declare and implement its reusable-worktree and branch inputs, and the dispatcher must pass distinct values explicitly. With `worktreeFromInputs`, a missing target is created as a detached checkout from `baseBranch`, while an existing same-repository worktree is reused as-is. Neither case checks out the feature branch named by a separate `branch` input, so the item workflow must enforce that branch step itself.

**Supported example: two independent top-level issue runs with a bound of 2.** First save this complete project workflow as `.atomic/workflows/issue-to-pr.ts`, then run `/workflow reload`. It is a user-defined workflow built only from supported authoring APIs, not a bundled workflow name that Atomic installs by default.

```ts
// .atomic/workflows/issue-to-pr.ts
import { spawnSync } from "node:child_process";
import { workflow } from "@bastani/atomic/workflows";
import { Type, type Static } from "typebox";

const reviewDecision = Type.Object(
  {
    approved: Type.Boolean(),
    findings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

function spawnCommand(argv: readonly string[], cwd: string) {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("spawnCommand requires a command");
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  // A command that could not be spawned at all arrives on `error` with a null
  // status, so it has to be raised here or it reads as an ordinary failure.
  if (result.error) throw result.error;
  return result;
}

function runCommand(argv: readonly string[], cwd: string): string {
  const result = spawnCommand(argv, cwd);
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status !== 0) {
    throw new Error(`${argv.join(" ")} failed (${result.status})\n${stderr || stdout}`);
  }
  return stdout;
}

export default workflow({
  name: "issue-to-pr",
  description: "Implement, review, check, and open one issue PR in its own worktree.",
  inputs: {
    issue: Type.String(),
    git_worktree_dir: Type.String(),
    base_ref: Type.String({ default: "origin/main" }),
    pr_base: Type.String({ default: "main" }),
    branch: Type.String(),
    checks: Type.Array(Type.Array(Type.String(), { minItems: 1 }), { minItems: 1 }),
  },
  outputs: {
    result: Type.String(),
    pr_url: Type.String(),
    branch: Type.String(),
    worktree: Type.String(),
  },
  worktreeFromInputs: { gitWorktreeDir: "git_worktree_dir", baseBranch: "base_ref" },
  run: async (ctx) => {
    const { issue, branch, checks } = ctx.inputs;
    const cwd = ctx.cwd ?? ctx.inputs.git_worktree_dir;
    const baseRef = ctx.inputs.base_ref;

    await ctx.tool("select-feature-branch", { branch, base_ref: baseRef }, async () => {
      const probe = spawnCommand(
        ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
        cwd,
      );
      if (probe.status === 0) return runCommand(["git", "switch", branch], cwd);
      if (probe.status !== 1) throw new Error((probe.stderr ?? "").trim());
      return runCommand(["git", "switch", "-c", branch, baseRef], cwd);
    });

    await ctx.task("implement", {
      context: "fork",
      prompt: [
        `Implement ${issue}.`,
        "Add or update tests, make the smallest correct change, and commit all changes.",
        "Do not create the PR; this workflow does that only after review and checks pass.",
      ].join("\n"),
    });

    let approved = false;
    for (let round = 1; round <= 2; round += 1) {
      const review = await ctx.task(`review-${round}`, {
        context: "fresh",
        schema: reviewDecision,
        prompt: [
          `Review the current ${branch} diff against ${baseRef} for ${issue}.`,
          "Inspect the code and tests. Approve only when the issue is fully met and the patch is safe.",
          "Return structured_output with approved and evidence-backed findings.",
        ].join("\n"),
      });
      const decision = review.structured as Static<typeof reviewDecision>;
      if (decision.approved) {
        approved = true;
        break;
      }
      if (round === 2) {
        throw new Error(`review bound exhausted: ${decision.findings.join("; ")}`);
      }
      await ctx.task(`repair-${round}`, {
        context: "fork",
        prompt: [
          `Repair ${issue} on ${branch}.`,
          ...decision.findings.map((finding) => `- ${finding}`),
          "Run relevant checks and commit the repair. Do not create a PR.",
        ].join("\n"),
      });
    }
    if (!approved) throw new Error("review did not approve the patch");

    await ctx.tool("require-clean-commit", { branch }, async () => {
      const pending = runCommand(["git", "status", "--porcelain"], cwd);
      if (pending !== "") throw new Error("implementation left uncommitted changes");
      return { commit: runCommand(["git", "rev-parse", "HEAD"], cwd) };
    });

    for (const [index, argv] of checks.entries()) {
      await ctx.tool(`check-${index + 1}`, { argv }, async () => runCommand(argv, cwd));
    }

    await ctx.tool("push-feature-branch", { branch }, async () =>
      runCommand(["git", "push", "--set-upstream", "origin", branch], cwd),
    );
    const prUrl = await ctx.tool("create-pr", { issue, branch, base: ctx.inputs.pr_base }, async () =>
      runCommand(
        ["gh", "pr", "create", "--base", ctx.inputs.pr_base, "--head", branch, "--title", issue, "--body", `Implements ${issue}.`],
        cwd,
      ),
    );

    return {
      result: `completed ${issue}`,
      pr_url: prUrl,
      branch,
      worktree: cwd,
    };
  },
});
```

The workflow binding creates or validates the reusable worktree before `run` starts. The first durable tool then creates or checks out the requested feature branch, so worktree setup's detached checkout never becomes the implementation branch. The item run owns branch setup → implementation → bounded review/repair → deterministic checks → push → PR creation. A failed review or check fails that item before push/PR.

Inspect the new target with `workflow({ action: "inputs", workflow: "issue-to-pr" })`. Then issue these two ordinary named-run tool calls in the same dispatch turn and end the turn. Interactive named launches return after startup admission instead of waiting for terminal completion, so the two run bodies overlap. Starting exactly two item runs and admitting no third until one ends enforces the bound of 2; the top-level tool has no batch-only worker loop or hidden concurrency field.

```ts
workflow({
  action: "run",
  workflow: "issue-to-pr",
  inputs: {
    issue: "#2101 fix cache-key normalization",
    git_worktree_dir: "../atomic-issue-2101",
    base_ref: "origin/main",
    pr_base: "main",
    branch: "fix/2101-cache-key",
    checks: [["bun", "test", "test/unit/cache-key.test.ts"]],
  },
})

workflow({
  action: "run",
  workflow: "issue-to-pr",
  inputs: {
    issue: "#2102 correct CLI help output",
    git_worktree_dir: "../atomic-issue-2102",
    base_ref: "origin/main",
    pr_base: "main",
    branch: "fix/2102-cli-help",
    checks: [["bun", "test", "test/unit/cli-help.test.ts"]],
  },
})
```

For a longer queue, wait for a terminal lifecycle notice before filling an open slot; do not poll. Keep each returned top-level run ID with its item metadata. Lifecycle notices carry terminal status/error, not declared workflow outputs.

After each terminal lifecycle notice, inspect the completed or failed run by its returned ID with the supported per-run status action:

```ts
workflow({ action: "status", runId: "<run-id-for-#2101>", format: "json" })
workflow({ action: "status", runId: "<run-id-for-#2102>", format: "json" })
```

Each JSON response has `action: "statusDetail"` and a `detail` object. Read `detail.status` and `detail.error`. For a completed run, read its declared outputs from `detail.result` and require a string `detail.result.pr_url` before filling that item's result/PR fields; do not infer the PR URL from the lifecycle notice or stage prose. A completed detail without the required result or `pr_url` is a reporting-contract failure.

For a failed run, record `detail.error` and leave the PR field as `no PR` when the failure occurred before `create-pr`. If failure may have occurred during or after that durable tool, inspect its status/tool detail or the GitHub PR list before retrying so the dispatcher does not create a duplicate PR. In either case, free the dispatcher slot, keep unrelated top-level runs active, and do not treat a failed run's partial result as successful output. Only after these per-run inspections should the dispatcher fill the final map:

| Item | Run ID | Worktree | Branch | Result / PR |
|---|---|---|---|---|
| `#2101` | `7f31a2c0-...` | `../atomic-issue-2101` | `fix/2101-cache-key` | `completed` / `<PR-2101-URL>` |
| `#2102` | `b84d090e-...` | `../atomic-issue-2102` | `fix/2102-cli-help` | `failed: review/repair bound exhausted` / no PR |

The second failure does not cancel, pause, or roll back the first run, and it does not block unrelated later items from using an open dispatcher slot. A first item's review, repair, or check failure must not block unrelated items; if it would, reconsider whether the queue was placed in one root workflow by mistake.

This example uses **top-level named runs**, not nested `ctx.workflow(...)` children. Each launch appears in top-level status, gets its own lifecycle notices and controls, and owns an independent root failure boundary. Nested children are hidden from top-level run lists and expand inside one parent graph; a failed child call normally fails its parent, and parent exit cancels in-flight children. Use nested children to preserve ordered composition inside a truly dependent item or cluster, not to claim separate root lifecycles for independent queue items.

The factory self-prompt is: **enumerate → inspect and classify dependencies → fan out top-level runs where independent → compose where dependent → dispatch in bounded waves → report the map.**

### Prompting the choice

Humans can steer the shape directly:

- **Name the shape or installed workflow.** "Do this inline", "use subagents to investigate", or "write a custom workflow for this" overrides automatic scoring.
- **State acceptance criteria.** Verbatim criteria make the objective provable and define reviewer and reducer contracts.
- **State the loop.** "Iterate until tests pass" or "review and fix until approved" defines a hard workflow stop condition.
- **State the evidence.** A QA video, test output, generated artifact, or reviewer sign-off tells the graph which gates it needs.
- **State the boundary.** "Work in a separate worktree", "do not create a PR", or "stop after implementation" separates implementation from final actions.
- **State the queue policy.** Say how to split, order, isolate, and bound queued items; otherwise Atomic runs the [dependency-triage and bounded-dispatch playbook](#task-queues-and-software-factories) before implementation. Ordinary list order and per-item "create a PR after" wording do not create a cross-item dependency.

Absent these controls, Atomic applies the self-prompt and rubric above; a prompt that names none of them delegates the shape decision rather than avoiding it.

## The Run Contract

**A run's contract is its objective plus its acceptance criteria. Only the user may change it. Every stage that receives a change must hand it to the next stage.**

This is the single most important rule for getting predictable results out of a multi-stage run, and it is the rule most often broken by accident.

### Only the user may change the contract

A workflow launches with a contract: the objective and, when supplied, explicit acceptance criteria. Two parties relate to it very differently:

- **You may amend it at any time.** A mid-run message — steering, a follow-up, resume text — is authoritative. If you say "also handle the detached path," that is a new requirement, and the run adopts it from that moment.
- **Agents may not amend it at all.** An implementer that notices a nearby bug, a cleaner abstraction, or a missing feature has found *deferred work*, not a new criterion. It records the observation and keeps building to the contract.

### Amendments must reach the next stage

An amendment that stays inside the session that received it is invisible to everything downstream. That produces the failure this rule exists to prevent:

> You steer the implementation stage to add a requirement. The implementer adopts it and builds it. The reviewers were launched with the original criteria, so they score the added work as unrequested scope and the original criteria as contradicted. The run then burns review loops arguing about a contract mismatch nobody can see.

So every builtin stage prompt carries a **steering propagation contract**:

- Restate every objective-relevant steering message in your report or handoff artifact, under an explicit `Contract amendments received` heading, verbatim when short.
- Keep user-authored amendments visibly separate from your own observations, so the next stage can tell a required clause from an agent proposal.
- Treat amendments inherited from an upstream stage as contract clauses. Cover them in acceptance and traceability work; never classify them as out-of-scope.
- Resolve ambiguity before implementing. Use `intercom` to ask the supervisor or originating stage when one is reachable; otherwise state the conflict and implement the narrowest reading consistent with the launch contract.
- Propagate nothing else this way. Tool preferences, working style, and your own ideas are not amendments.

Every bundled workflow wraps its run context once at the definition entry point, so each `ctx.task`, `ctx.chain`, and `ctx.parallel` prompt carries the contract automatically. Do the same in a custom workflow:

```ts
import { withSteeringPropagationContext } from "@bastani/atomic/workflows/builtin/steering-context";

export default workflow({
  name: "my-workflow",
  // ...
  run: async (ctx) => await runMyWorkflow(withSteeringPropagationContext(ctx)),
});
```

Wrapping the context rather than each call site means a stage added later inherits the pattern instead of silently dropping amendments.

### Scope discipline

The mirror of "only the user may amend" is that the agent holds the line. Every builtin implementation stage carries this contract:

> Before writing code, state the goal in one sentence and list the acceptance criteria. That list is the contract. Freeze it.

While implementing:

- **Done means the contract, not "good."** When all criteria pass, stop. Polish, refactors, and "while I'm here" fixes are new work, not this work.
- **Every addition must trace to a criterion.** If you cannot point at the criterion a change serves, do not make it. Log it instead.
- **Keep a deferred list, not a growing diff.** When you notice a bug, smell, or missing feature outside the contract, write one line in a deferred note and move on. Surface it at the end.
- **Distinguish blockers from improvements.** Change scope only if a criterion is impossible or wrong as written — and say so explicitly before proceeding, rather than silently absorbing the work.
- **Watch for the tells.** "It would be cleaner if…", "we should also…", "this really ought to…" mean you are about to move the goalpost. Stop and check the contract.
- **Prefer the smallest diff that satisfies the contract.** Fewer files touched, fewer abstractions introduced, no speculative generality for futures nobody asked for.

At the end, report three things: what the contract was, evidence each criterion passes, and the deferred list. Scope changes belong in the report, never in the diff.

### Protect the contract from compaction

A long-running stage gets compacted, and compaction ranks lines individually rather than preserving whole instructions. That ranking has a bias worth knowing: an objective is verbose and restated, while the constraint that bounds it is usually one line. Rank them independently and the constraint is the cheaper deletion — so what survives is coherent, actionable, and missing its boundary conditions. A prohibition removed from context reads as permission.

Wrap contract text in `keepContext` so it survives verbatim regardless of the compression ratio:

```ts
import { keepContext, workflow } from "@bastani/atomic/workflows";

const prompt = [
  keepContext("Research only. Do not implement code changes."),
  `Investigate: ${ctx.inputs.question}`,
].join("\n\n");
```

Every line of the span is protected, tag lines included. The guarantee is mechanical rather than advisory: protected lines are removed from the planner's deletion ranges after it responds. Because the tag lines are protected too, the span is re-detected on each later boundary — which matters, since every compaction re-ranks the previous compaction's output, so a constraint must survive every cycle rather than only the first. Tags must sit on their own line, and a span is scoped to one message. User and assistant messages may both protect — stage prompts, run inputs, and steering arrive as user messages, and a stage may pin its own core information — while tags inside tool results are inert, so file, page, or command output a stage reads cannot mark itself unreclaimable.

`keepContext` is a pure string helper, not a `ctx.*` primitive: it creates no graph node and has no side effect, so call it anywhere a prompt is assembled. It is idempotent, so composing already-wrapped text will not nest.

Tag:

- role constraints that bound a stage to part of the work — "research only", "review and report, do not repair";
- acceptance criteria and immutable contracts a later stage is judged against;
- explicit prohibitions;
- identifiers a stage must not lose, such as a target branch, worktree path, or run ID.

Do not tag bulk context. Protected lines count against the keep target rather than raising it, so a large protected span makes the surrounding transcript compress harder. Tag the constraint, not the material it applies to — pass that through files and `reads`.

Every builtin does this for its own invariants: the steering propagation contract, the literal objective contract, scope discipline, worktree discipline, per-run acceptance criteria, and the research/review role constraints are all protected. See [Compaction](/compaction#keepcontext-tags) for the retention mechanism.

#### Tagging is not only for workflow authors

The tags are plain text, so they work anywhere text becomes a stage prompt — you do not need to be writing a workflow definition to use them. Two cases matter in everyday use, and both apply to an agent driving the `workflow` tool on your behalf.

**Run inputs.** Workflows inject their inputs into stage prompts, so anything you tag in an input is inherited by the stages that receive it:

```
workflow({ action: "run", workflow: "ralph", inputs: {
  prompt: "<keepContext>\nResearch and implement issue #2170. Do not touch the release pipeline.\n</keepContext>\n\n" + issueBody,
  acceptance_criteria: "<keepContext>\n1. ...\n2. ...\n</keepContext>",
}})
```

Note what is tagged and what is not: the constraint and the criteria are protected, the quoted issue body is not. A launch prompt is usually mostly reference material, and protecting all of it would raise the keep target so far that stages lose the transcript evidence they need.

**Steering.** A `send` amendment is authoritative and stages must carry it forward, but it is one short message arriving late into an already-long session, competing against the entire transcript for retention. Tagging it keeps it alive until the stage acts on it:

```
intercom({ action: "send", to: "workflow:<rootRunId>/<stage>", message:
  "<keepContext>\nNew requirement: the fix must not change the public API.\n</keepContext>" })
```

An agent launching or steering a run should make this call per message rather than tagging by habit — protect the clause that must hold, and leave the surrounding explanation to be compacted normally.

### Practical consequences

- **Steer freely — it is the supported amendment channel.** You do not need to restart a run to add a requirement.
- **Say what you mean as a requirement.** "It would be nice if…" reads as guidance; "also handle X" reads as a clause. Stages are told to distinguish them.
- **Expect amendments in the reports.** If a stage received one and its report has no `Contract amendments received` section, the amendment did not propagate and downstream stages will not honor it.
- **A growing diff with no new criteria is a defect.** That is the tell that scope discipline slipped, and it is a legitimate reason to stop a run.

## Scope-Guard Starter Pattern

Use a scope guard when a worker may find valid adjacent work and a later reviewer or repair stage could treat that finding as part of the current task. The guard is an independent reviewer built from existing workflow composition. It controls scope only: code reviewers and deterministic checks still decide whether the candidate is correct.

Do not add a `watchdog` field, stage option, or custom runtime primitive for this pattern. Choose the lightest existing shape that fits the boundary:

| Need | Shape |
|---|---|
| One check at a plan, handoff, repair, or completion boundary | A fresh `ctx.task(...)` downstream of the worker |
| One checker session that needs several prompts or explicit timing | A fresh `ctx.stage(...)`, with all of its turns completed before downstream dependency work starts |
| Steering while the worker generation is open | Fresh guard and forked worker items in one `ctx.parallel(...)`, using inherited same-group Intercom |

### Canonical scope contract

Create one inspectable contract artifact before guarded work starts. Treat it as immutable for that run and include:

- the literal objective;
- required scope and allowed files or systems;
- explicit non-goals;
- stage boundaries and expected lifecycle order; and
- acceptance criteria and required evidence.

Every worker, guard, reviewer, and repair continuation reads the same path. Do not copy the contract into several prompts that can drift, and do not let a stage overwrite it. If a human changes the objective, write a new versioned contract and start a new guarded unit of work instead of silently changing the active contract.

Large plans, diffs, logs, reviewer reports, and decision history belong in artifacts. Pass their paths with `reads` where the primitive supports it, tell fresh stages to read the needed sections, and keep Intercom messages short. A fresh guard must not rely on a sibling transcript or hidden graph state.

### Decision contract and actions

For each proposed material expansion, the guard records one evidence-backed classification and action:

| Classification | Evidence threshold | Action |
|---|---|---|
| `required` | The literal objective, stated review feedback, acceptance criteria, or required validation directly demands it. | Permit the smallest change that satisfies that demand. |
| `dependent` | The selected in-scope implementation would otherwise violate a cited existing contract or proven prerequisite. | Permit only the prerequisite and record the contract that makes it necessary. |
| `follow-up` | The finding is valid but the current objective and selected implementation do not require it. | Record it once and continue without implementing it. It does not block this run. |
| `unclear` | Evidence cannot decide a material product, public API, security, migration, or scope choice. | Block that expansion and request a supervisor or human decision through a blocking Intercom exchange or `ctx.ui`. |

Use a stable key for each proposal, such as `public-error-shape` or `transport-timeout`. Keep one row per key, merge repeated evidence into that row, and cap the log (the examples use 20 entries). Do not let the guard and worker echo the same finding back and forth. The persisted decision artifact is the source for later review and repair stages; chat messages only steer the open turn.

A useful decision record contains `key`, `classification`, concrete `evidence`, and `action`. A guard failure or missing coordination channel never means approval.

### Fallback policy

Pick and document one policy before the run:

| Policy | When Intercom or the guard is unavailable |
|---|---|
| `warn` | Mark live steering unavailable, forbid unreviewed expansion, and run a fresh boundary `ctx.task(...)` before the next material change. |
| `block` | Stop before expansion and request a decision with `ctx.ui`; in headless mode, fail with the unresolved decision instead of widening scope. |
| `off` | Skip the guard only because the workflow author or user explicitly disabled it. Preserve the original scope and do not infer approval for adjacent work. |

Use `block` for risky public contracts, data changes, security behavior, releases, or publication. `warn` is a practical default when a boundary review can replace live steering. Never degrade silently from `block` to `warn` or from guarded execution to `off`.

Ordinary `intercom` is mandatory in every workflow model stage. `noTools: "all"`, restrictive `tools` allowlists, and `excludedTools` continue to restrict every other tool but cannot remove Intercom, so live steering remains available.

### Lifecycle, topology, and context rules

- Keep the graph acyclic. A boundary guard is an ordinary downstream reviewer node. Live Intercom steering is activity inside already-running parallel stages, not a new graph edge.
- Never make a guard watch itself, recursively start another guard, reopen a terminal task, or add a dependency from the current frontier to an ancestor. Complete all turns on a retained guard before starting downstream dependency work.
- Messages admitted before a worker generation closes drain through that stage boundary. Late messages do not reopen or mutate its terminal workflow state. Give each live branch a bounded stop rule; `ctx.parallel(...)` releases downstream work only after all started branches settle, even when one finishes first.
- Persist decisions under stable keys. Pause/resume, model fallback, durable replay, and nested workflows then reread the artifact instead of sending duplicate interventions.
- Omit `group` for ordinary use. The worker, guard, nested workflows, and delegated subagents inherit the top-level workflow invocation's stable Intercom group. Set an explicit group only for intentional isolation; an override isolates that stage from ordinary same-group peers while leaving it steerable from the invocation context, which retains directional list/send/live-ask control over the subgroups it owns.
- Use `context: "fresh"` for guards, reviewers, and judges. They should see only the contract, candidate, decision artifacts, and current files.
- Use `context: "fork"` plus `forkFromSessionFile` for implementation, debugging, and repair roles that need continuity with an owned earlier session. `context: "fork"` alone does not name a fork source; an initial worker with no prior lineage may start fresh. A later continuation should use the earlier worker's `sessionFile` when available. Do not fork an independent guard from the worker it judges.
- Send a forked continuation only the delta after the fork point: new evidence, the decision artifact, any human answer, and the next action. Keep the full shared contract in its canonical file.

Expected lifecycle state is not a defect. If the contract says `candidate → validation → approval → push/publish`, a guard at the candidate or validation boundary must not reject the patch merely because it is unpushed or unpublished. Only the later publication stage owns that action.

### Runnable boundary-task example

Use a fresh task when one check at a material boundary is enough. This complete project workflow keeps the worker lineage coherent, saves a structured decision log, and sends ambiguity to `ctx.ui` before the continuation:

```ts
// .atomic/workflows/scope-guard-boundary.ts
import { workflow } from "@bastani/atomic/workflows";
import { Type, type Static } from "typebox";

const decisionLogSchema = Type.Object(
  {
    decisions: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          classification: Type.Union([
            Type.Literal("required"),
            Type.Literal("dependent"),
            Type.Literal("follow-up"),
            Type.Literal("unclear"),
          ]),
          evidence: Type.Array(Type.String(), { minItems: 1 }),
          action: Type.String(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 20 },
    ),
  },
  { additionalProperties: false },
);

type DecisionLog = Static<typeof decisionLogSchema>;

function continueWorker(sessionFile: string | undefined) {
  return sessionFile === undefined
    ? { context: "fork" as const }
    : { context: "fork" as const, forkFromSessionFile: sessionFile };
}

export default workflow({
  name: "scope-guard-boundary",
  description: "Check scope at an implementation boundary.",
  inputs: {
    scope_contract: Type.String(),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/scope-guard-boundary" }),
  },
  outputs: {
    decision_log: Type.String(),
  },
  run: async (ctx) => {
    const contract = ctx.inputs.scope_contract;
    const candidate = `${ctx.inputs.artifact_dir}/candidate.md`;
    const decisionLog = `${ctx.inputs.artifact_dir}/scope-decisions.json`;

    const worker = await ctx.task("prepare candidate", {
      context: "fresh",
      reads: [contract],
      prompt: [
        `Read the immutable scope contract at ${contract}.`,
        "Implement only the required scope and summarize changed files and evidence.",
        "Do not implement valid adjacent findings; include them in the candidate summary.",
      ].join("\n"),
      output: candidate,
      outputMode: "file-only",
    });

    const checked = await ctx.task("scope boundary", {
      context: "fresh",
      reads: [contract, candidate],
      schema: decisionLogSchema,
      prompt: [
        `Read ${contract} and ${candidate}. Inspect the current candidate.`,
        "Classify each material expansion as required, dependent, follow-up, or unclear.",
        "Cite concrete evidence and state the action. Return at most 20 unique keys.",
        "Follow-up work must not block. Unclear expansion requires a human decision.",
        "Judge scope only; do not approve implementation correctness.",
      ].join("\n"),
      output: decisionLog,
      outputMode: "file-only",
    });

    if (checked.structured === undefined) throw new Error("scope guard returned no decision log");
    const decisions = checked.structured as DecisionLog;
    const unclear = decisions.decisions.filter((item) => item.classification === "unclear");
    const humanDecision = unclear.length === 0
      ? "No unclear scope decisions."
      : await ctx.ui.editor([
          "Resolve these scope decisions before the worker continues:",
          ...unclear.map((item) => `- ${item.key}: ${item.evidence.join("; ")}`),
        ].join("\n"));

    await ctx.task("continue worker", {
      ...continueWorker(worker.sessionFile),
      reads: [contract, decisionLog],
      prompt: [
        `Read the decision log at ${decisionLog}.`,
        `Human decision: ${humanDecision}`,
        "Apply only required and dependent actions. Record follow-up items without implementing them.",
        "The original contract and output rules remain unchanged.",
      ].join("\n"),
    });

    return { decision_log: decisionLog };
  },
});
```

The materialized order is `prepare candidate → scope boundary → optional human prompt → continue worker`. Each step is new downstream work; no edge points back to the original worker.

### Runnable retained-stage example

Use `ctx.stage(...)` when one independent checker needs a retained conversation. Run its tracked `prompt()` once, then use `sendUserMessage(...)` for a bounded post-prompt turn on that same session; a second tracked `prompt()` on the finalized stage is invalid.

```ts
// .atomic/workflows/scope-guard-retained.ts
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

function continueWorker(sessionFile: string | undefined) {
  return sessionFile === undefined
    ? { context: "fork" as const }
    : { context: "fork" as const, forkFromSessionFile: sessionFile };
}

export default workflow({
  name: "scope-guard-retained",
  description: "Retain one independent checker for a bounded multi-turn review.",
  inputs: {
    scope_contract: Type.String(),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/scope-guard-retained" }),
  },
  outputs: {
    decision_log: Type.String(),
  },
  run: async (ctx) => {
    const contract = ctx.inputs.scope_contract;
    const candidate = `${ctx.inputs.artifact_dir}/candidate.md`;
    const decisionLog = `${ctx.inputs.artifact_dir}/scope-decisions.md`;

    const worker = await ctx.task("prepare candidate", {
      context: "fresh",
      reads: [contract],
      prompt: `Read ${contract}, prepare the scoped candidate, and summarize evidence.`,
      output: candidate,
      outputMode: "file-only",
    });

    const guard = ctx.stage("retained scope guard", { context: "fresh" });
    await guard.prompt([
      `Read the immutable contract at ${contract} and candidate at ${candidate}.`,
      "Classify each material proposal as required, dependent, follow-up, or unclear.",
      "Write one deduplicated row per stable key, at most 20 rows, with evidence and action.",
      "Follow-up means record only; unclear means request a human decision.",
      "Judge scope only, not implementation correctness.",
    ].join("\n"), { output: decisionLog, outputMode: "file-only" });
    await guard.sendUserMessage([
      `Recheck the complete candidate against ${contract}.`,
      `If evidence changes a classification, use the write tool to replace ${decisionLog}.`,
      "Keep the artifact complete, deduplicated, and bounded to 20 rows; do not return a delta.",
      "If no decision changes, leave the artifact unchanged and say so.",
    ].join("\n"));


    const humanDecision = await ctx.ui.editor(
      `Review ${decisionLog}. Resolve each unclear row, or state that none remain.`,
    );

    await ctx.task("apply retained decision", {
      ...continueWorker(worker.sessionFile),
      reads: [contract, decisionLog],
      prompt: [
        `Read ${decisionLog}.`,
        `Human decision: ${humanDecision}`,
        "Apply required and dependent actions only. Do not implement follow-up rows.",
      ].join("\n"),
    });

    return { decision_log: decisionLog };
  },
});
```

The tracked prompt creates the guard node and decision artifact. `sendUserMessage(...)` starts one retained follow-on turn after that node finalizes; it does not create or reopen graph work. The follow-on updates the artifact directly only when evidence changes, and it finishes before the human prompt or worker continuation starts.

### Runnable live-parallel example

Use a live peer only when steering during generation adds clear value. Both branches omit `group`, so Atomic places them in the workflow invocation's same Intercom group. The guard first performs a bounded Intercom status handshake and returns; later blocking `intercom.ask` calls can reopen its retained conversation for classification. After both parallel branches settle, a fresh task reads that transcript and persists the final deduplicated decision artifact. Normal late sends are not part of this handshake.

```ts
// .atomic/workflows/scope-guard-live.ts
import { workflow } from "@bastani/atomic/workflows";
import { Type, type Static } from "typebox";

const coordinationSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("available"),
      Type.Literal("unavailable"),
      Type.Literal("off"),
    ]),
    evidence: Type.String(),
  },
  { additionalProperties: false },
);

type Coordination = Static<typeof coordinationSchema>;

function workerContext(sessionFile: string | undefined) {
  return sessionFile === undefined
    ? { context: "fresh" as const }
    : { context: "fork" as const, forkFromSessionFile: sessionFile };
}

export default workflow({
  name: "scope-guard-live",
  description: "Run a worker with a live same-group scope peer.",
  inputs: {
    scope_contract: Type.String(),
    worker_session_file: Type.Optional(Type.String({
      description: "Earlier worker session to continue; omit when no worker lineage exists.",
    })),
    fallback_policy: Type.Union([
      Type.Literal("warn"),
      Type.Literal("block"),
      Type.Literal("off"),
    ], { default: "warn" }),
    artifact_dir: Type.String({ default: ".atomic/workflows/runs/scope-guard-live" }),
  },
  outputs: {
    decision_log: Type.String(),
    review: Type.String(),
  },
  run: async (ctx) => {
    const contract = ctx.inputs.scope_contract;
    const fallbackPolicy = ctx.inputs.fallback_policy;
    const candidate = `${ctx.inputs.artifact_dir}/candidate.md`;
    const coordinationPath = `${ctx.inputs.artifact_dir}/scope-coordination.json`;
    const decisionLog = `${ctx.inputs.artifact_dir}/scope-decisions.md`;

    const branches = await ctx.parallel(
      [
        {
          name: "worker",
          ...workerContext(ctx.inputs.worker_session_file),
          reads: [contract],
          prompt: [
            `Read the immutable scope contract at ${contract}.`,
            `The declared Intercom fallback policy is ${fallbackPolicy}.`,
            "Unless policy is off, connect to Intercom and find the scope-guard peer in this workflow group.",
            "Before material expansion, send at most 20 blocking asks with a stable key and evidence.",
            "Apply required or dependent replies only. Record follow-up findings without implementing them.",
            "For an unclear reply, wait for human input instead of widening scope.",
            "If Intercom is unavailable: warn forbids expansion, block stops before expansion, and off keeps the original scope without a guard.",
            "Return the complete candidate summary; do not send a late ready notice.",
          ].join("\n"),
          output: candidate,
          outputMode: "file-only",
        },
        {
          name: "scope guard",
          context: "fresh",
          reads: [contract],
          schema: coordinationSchema,
          prompt: [
            `Read the immutable scope contract at ${contract}.`,
            `The declared fallback policy is ${fallbackPolicy}.`,
            "If policy is off, do not connect; return status off with evidence.",
            "Otherwise call intercom status once and return available or unavailable with evidence.",
            "When a later blocking ask reopens this conversation, classify its stable key as required, dependent, follow-up, or unclear.",
            "Reply with concrete evidence and one action. Do not approve implementation correctness.",
            "Never originate another guard or send a normal late message.",
          ].join("\n"),
          output: coordinationPath,
          outputMode: "file-only",
        },
      ],
      { concurrency: 2, failFast: true },
    );

    const guardResult = branches[1];
    if (guardResult?.structured === undefined) throw new Error("scope guard returned no coordination status");
    const coordination = guardResult.structured as Coordination;
    const guardTranscript = coordination.status === "available"
      ? guardResult.sessionFile
      : undefined;
    const transcriptReads = guardTranscript === undefined ? [] : [guardTranscript];
    const effectiveStatus = fallbackPolicy === "off"
      ? "off"
      : coordination.status === "available" && guardTranscript !== undefined
        ? "available"
        : "unavailable";
    const humanDecision = effectiveStatus === "unavailable" && fallbackPolicy === "block"
      ? await ctx.ui.editor("Intercom is unavailable. Resolve scope before any blocked expansion continues.")
      : "No fallback human decision required.";

    if (fallbackPolicy === "off") {
      await ctx.task("record scope guard off", {
        context: "fresh",
        prompt: "Record that the scope guard was explicitly off and that no expansion was approved.",
        output: decisionLog,
        outputMode: "file-only",
      });
    } else {
      await ctx.task("persist scope decisions", {
        context: "fresh",
        reads: [contract, candidate, coordinationPath, ...transcriptReads],
        prompt: [
          `Read ${contract}, ${candidate}, ${coordinationPath}, and any supplied guard transcript.`,
          `Effective coordination status: ${effectiveStatus}. Fallback policy: ${fallbackPolicy}.`,
          `Fallback human decision: ${humanDecision}`,
          "Persist one complete decision log with at most 20 unique stable keys.",
          "Classify each expansion as required, dependent, follow-up, or unclear with evidence and action.",
          "When warn has no transcript, perform the fresh boundary scope check here.",
          "Follow-up does not block. Unclear remains blocked unless the human decision resolves it.",
        ].join("\n"),
        output: decisionLog,
        outputMode: "file-only",
      });
    }

    const review = await ctx.task("independent correctness review", {
      context: "fresh",
      reads: [contract, candidate, decisionLog],
      prompt: [
        `Read ${contract}, ${candidate}, and ${decisionLog}.`,
        "Inspect the current files and run the required checks.",
        "Review correctness independently; do not turn follow-up scope findings into blockers.",
      ].join("\n"),
    });

    return { decision_log: decisionLog, review: review.text };
  },
});
```

The parallel fan-out has one shared parent frontier and downstream persistence waits for both branches. Blocking asks use the guard's retained conversation; the fresh persistence task turns the final transcript into the bounded artifact before correctness review. If Intercom is unavailable, `warn` runs that task as a boundary check, `block` requires `ctx.ui`, and `off` records that no guard approval exists.

## Fast inference for workflow stages

Stages select faster inference the same way they select any other model: by naming it. Where a provider publishes a fast variant, its canonical selectable ID is the base model ID plus `-fast`, so a stage pins `openai-codex/gpt-5.6-sol-fast` — with an optional thinking suffix, `openai-codex/gpt-5.6-sol-fast:medium` — in its `model` field, and lists fast and normal IDs in its fallback model fields in whatever order it wants:

```ts
await ctx.task({
  name: "triage",
  model: "openai-codex/gpt-5.6-sol-fast:medium",
  fallbackModels: ["openai-codex/gpt-5.6-sol:medium"],
  prompt: "…",
});
```

There is no fast-mode setting, no scope inheritance, and no separate `fast` marker. Normal and fast IDs are distinct fallback candidates and distinct `modelAttempts` entries, and stage model metadata carries the exact selected ID, so a run's records show precisely which one served each attempt. Graph node cards keep their dependency metadata focused on topology.

`workflow({ action: "models" })` lists fast variants alongside their normal siblings, so a workflow can discover them at runtime. See [Providers](/providers#fast-models) for which providers publish fast variants and what each one sends upstream.

Pin fast variants deliberately in broad workflows. Parallel fan-out and fallback attempts multiply provider requests, and priority-tier requests are billed at a higher rate.

## Context Engineering

A workflow is an information-flow system, not just a list of prompts. Most workflow failures come from missing, stale, oversized, or poorly-routed context. Design every stage boundary deliberately.

### Locally Scoped Stage Prompts

Stage prompts should define local contracts, not describe the full workflow runtime. Write prompts as if the stage could be executed independently from a fresh session with only the listed inputs. A useful compact shape is `Role · Goal · Success criteria · Constraints · Tools · Output · Stop rules`; omit sections that do not change behavior. Include:

- the stage's current objective and what is out of scope for this stage
- the exact files, artifacts, child outputs, or user inputs it may use; put long inputs before the final instruction
- context-dependent tool routes and permission boundaries, without describing tools the stage cannot call
- the expected output format and length, or the schema it must return when the workflow item is schema-enabled
- the checks, tools, or deterministic commands it should run when relevant, plus evidence required for progress or completion claims
- the success criteria and blocker conditions that let this stage stop

State important constraints once. Reserve absolute wording for safety, required fields, forbidden actions, gating derivations, and other true invariants; express search, iteration, and delegation choices as decision rules. Ask for conclusions, commands, observed results, and citations—not private reasoning or generic self-verification.

Avoid unrelated workflow internals such as reducer algorithms, future PR stages, sibling reviewer names, loop implementation details, or project-specific nicknames unless they are explicitly part of the current stage contract. If a term such as a gate name, ledger field, or workflow nickname is necessary, define it in the prompt before using it.

Choose context mode deliberately. Use `context: "fork"` or `forkFromSessionFile` for coherent long-running implementation stages that need continuity from their own earlier work. Use `context: "fresh"` for unbiased reviewer, evaluator, and gate stages so they inspect the current files and explicit artifacts rather than inheriting the implementer's assumptions. When continuity is needed across fresh stages, pass it explicitly through files, declared outputs, and `reads`.

### Context-Mode-Aware Prompt Text

Context mode is an execution property configured with `context`/`forkFromSessionFile`; the model cannot act on context mode, so keep it out of prompt text:

- **Never describe the stage's own context mode.** Sentences like "you are running in a fresh context window", "your context is clean/non-forked", or "this is a forked session" add tokens without changing behavior. State the concrete action, inputs, and success criteria instead.
- **Fresh stages must not reference invisible context.** A fresh stage has no "previous conversation", cannot see sibling stages, and does not know the surrounding graph, so instructions like "compare against previous workflow reasoning" or "this runs in parallel with the locator pass" do not help and may confuse the model. Phrase the same intent stage-locally ("compare the working tree against the baseline branch"; "do your own scan; do not assume any other stage's output is available") and pass any state the stage needs through files, declared outputs, and `reads`.
- **Forked continuation prompts send only the delta.** A forked stage already carries the role, contracts, guidance, and output format from its own earlier prompts, so repeating them uses more tokens and can make the two copies diverge. Send what changed since the fork point — new artifacts, updated state, the next action — plus a one-line pointer back ("the contracts and report format established earlier in this thread still apply unchanged") instead of re-injecting the full text.
- **Keep one canonical copy of shared contracts.** When fresh and forked variants of a stage share guidance, render the full contract only in the prompt that first establishes it and reference it from continuations. If a continuation needs a contract restated (for example, after a schema change), that is a new contract version, not a repeat.

Long-running worker/reviewer workflows should follow this pattern: establish the complete contract once, then send forked continuation turns only the latest state and artifact paths with a pointer back to the established guidance.

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
| Lost in the middle | Important constraints are ignored in long prompts | Shorten the handoff; place documents first and the final query/critical contract last |
| Context poisoning | Bad or obsolete information steers later stages | Validate sources, overwrite stale artifacts, cite evidence |
| Distraction | Irrelevant context crowds out useful context | Pass only stage-specific files and summaries |
| Confusion | Similar instructions or duplicate facts conflict | Consolidate each shared contract into one canonical copy and name artifacts clearly |
| Clash | User, system, or stage instructions disagree | Resolve conflicts before launching downstream stages |

Use compaction, file references, and bounded loops before context fills with transcript noise. In attached workflow stage chat, manual compaction shows `Compacting context...`, threshold compaction shows `Auto-compacting...`, and overflow recovery shows `Context overflow detected. Auto-compacting...` in the same animated status row used for normal model work. That label is a fact about the stage session rather than about the pane, so detaching to the graph and reattaching while compaction is still running restores the same reason-specific label instead of falling back to the generic `Working...` row; it clears as soon as the compaction ends. A successful compaction leaves the normal expandable `✻ Context compacted` boundary in the transcript; the boundary is reconstructed from the durable session and has a typed live fallback if the refreshed session snapshot is temporarily unavailable.

### Compression and Artifact Handoffs

Optimize for tokens per completed task, not the smallest prompt. Aggressive compression can force later stages to rediscover information.

A compressed handoff includes:

- objective and current status
- decisions already made
- files, symbols, commands, and artifact paths with evidence
- open questions and known risks
- rejected alternatives when they matter
- next action expected from the downstream stage

Pass file references, not content. This is the strongly encouraged default for every handoff — between stages and back to the caller — and it is what keeps a multi-stage run affordable. Use `output` with `outputMode: "file-only"` and `reads` for research bundles, logs, plans, diffs, reviewer reports, and any other stage product that can grow. In the downstream stage prompt, say `Read the file at ${artifactPath} before continuing.` Do not inject full session tails, all previous stage outputs, or every prior review round into later prompts by default; pass the latest relevant artifact paths and make older history discoverable from a ledger or index file.

Three rules make that work in practice:

1. **One owner per artifact.** The runner writes the stage's completed answer to `output` and appends later completed answers from the same generation as numbered supplements. This preserves a report when an admitted clarification arrives before generation close, without copying tool progress or earlier history into the artifact. Completed handoffs are immutable under later chat. State corrections explicitly, and use a new tracked stage and output path for an intentional replacement. The runner also writes the companion transcript outside the repository and tells the model the output contract. Describe the deliverable in your prompt, not the plumbing. Search the transcript with `rg` for supporting details that belong outside the curated artifact.
2. **Do not read an artifact back just to return it.** `outputMode: "file-only"` exists so the parent receives a compact reference. Calling `readFile` on that artifact and returning its text as a workflow output cancels the saving and drops the whole report into the caller's context window. Return the reference and a `*_path` output instead.
3. **Return paths from the workflow.** Declared outputs are consumed by the calling session, so a workflow's `result` should be a reference plus explicit `*_path` outputs. Callers that need the body read the path; callers that only need the outcome pay nothing for it. When a detail is missing from the curated artifact, search its companion transcript with `rg` and inspect a narrow range.

Substantial handoffs should travel through files or durable artifacts instead of hidden transcript assumptions. This keeps stage prompts small, makes review/audit possible, and lets later stages reread the authoritative material without depending on what a previous model summarized. Remember that `reads` passes paths rather than content: a stage reads the file when it runs, so the artifact must hold the real report at that moment.

```ts
const researchPath = ".atomic/workflows/runs/context-demo/research.md";
await ctx.task("researcher", {
  task: "Map the subsystem and return the complete report as your final message.",
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

Use parallel stages to isolate context and separate independent work, not merely to assign role labels. Good parallel branches have distinct evidence-gathering or review angles:

- locator / mapper: where relevant files and systems live
- analyzer: how the current implementation works
- pattern finder: how similar code is written elsewhere
- external researcher: what upstream docs or APIs require
- reviewer/evaluator: whether outputs satisfy the validation contract

Have the parent workflow synthesize results rather than letting branches silently make conflicting decisions. If branches must agree, design an explicit consensus or adjudication stage.

### Filesystem Context

Use files when workflow context grows too large:

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

Prefer schema-enabled workflow items for model review and gate decisions. Atomic passes the schema directly to the final-answer tool and captures the tool arguments; it no longer adds separate structured-output parsing, object-root restrictions, or sidecar validation. Object-shaped decision schemas with explicit booleans/enums, findings arrays, confidence, evidence fields, and error reporting are usually easiest to consume, but array or primitive schemas are valid when they fit the handoff. Avoid brittle regular-expression matching against free-form prose such as “looks good”, “approved”, or “PASS”. Define each convergence field's derivation once and consume it deterministically rather than recomputing approval from narrative text.

Use small dedicated model stages for adaptive gates when deterministic code alone cannot decide what to check. For example, a stage can read an artifact, inspect the repo, run a named tool or command, and then emit a structured decision by configuring `schema` on that workflow item. Keep that stage's prompt narrow: tell it the specific check to perform, the files/tools it may use, the evidence to report, and the structured decision it must return. Require progress and completion claims to map to current tool results; when evidence is unavailable, the stage should identify the unverified claim or blocker rather than infer success.

When using LLM judges, reduce bias by defining score anchors, requesting observable evidence and criteria-based justification, calibrating against examples, and keeping length/order effects in mind. Do not ask for chain-of-thought or reconstructed internal reasoning. Track pass rates and failures over time for reusable workflows.

### Tools, MCP, Memory, and Hosted Execution

Constrain each stage to the tools it needs. Too many tools increase ambiguity and token cost; too few tools force brittle workarounds. Tool descriptions should make inputs, side effects, and error handling clear.

Use per-stage `mcp` allow/deny lists when a workflow needs external systems but some stages should remain read-only or isolated. Use memory or durable project knowledge only when cross-run continuity is required; otherwise prefer explicit inputs and artifacts.

Hosted or remote agent workflows need additional design work: sandbox setup, dependency caching, auth boundaries, artifact transfer, concurrency limits, and multiplayer/session handoff behavior. Optimize startup before the user begins the run; do not make each stage rebuild its environment.

### Task Fit and Project Design

Before turning a process into a workflow, confirm that it suits automation:

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
- **Common pattern:** Which [common workflow pattern](#common-workflow-patterns) best matches the task, and where does the actual design intentionally diverge?
- **Stage decomposition:** For each stage, what question does it answer, what context does it need, what output should it return, and what model/tool/MCP requirements does it have?
- **Local stage contract:** Can this stage prompt stand alone with its current objective, inputs/artifacts, expected outputs, tools/checks, and success criteria, without unexplained workflow internals or future-stage assumptions?
- **Prompt vocabulary:** Do stage, reviewer, and reducer prompts describe the concrete action, available evidence, and success criteria that the stage can see locally, instead of assuming the model knows the workflow graph's name or surrounding context? Avoid phrasing like "the create-PR workflow stage" or "this Foo workflow" unless that name is explicitly supplied as user-visible context or materially affects behavior.
- **Information flow:** For every edge between stages, is `previous` enough, or should the handoff use structured returns, files, `reads`, `output`, or `outputMode`?
- **Output contract:** Which outputs should be declared in `outputs`, which stage/task/child results should `run` return for those keys, and what runtime type must each value have? If another workflow may call this workflow as a child, which non-default outputs should the parent rely on?
- **Context size:** Can downstream stages succeed from the handoff alone? Should large transcripts, logs, or research bundles be summarized or saved as artifacts?
- **Control flow:** Should the workflow use `ctx.chain`, `ctx.parallel`, `ctx.ui`, bounded loops, `failFast`, or `fallbackModels`?
- **Acyclic topology:** What node and dependency shape can each branch, bounded loop, and nested workflow boundary materialize? Which stages repeat, does each iteration create distinct tracked work with stable identity and call order, and what is the current frontier before each repeat? Could any proposed parent edge target the node itself or an ancestor? Are nested children composed through `ctx.workflow(...)` boundaries rather than recursive `run` invocation? Redesign or stop before launch if any self-edge or back-edge remains.
- **Scope control:** Could valid adjacent findings expand the patch? If so, where will a fresh scope guard read the immutable contract, how will it classify and persist bounded decisions, which `warn`/`block`/`off` fallback applies, and which worker session owns any forked continuation?
- **User experience:** Are stage names readable in status and graph views? Is the final output compact? Are important artifacts saved with stable paths?
- **Validation:** What success criteria, review gates, deterministic checks, or evaluator stages prove the workflow did the right thing? Are model gates schema-backed instead of regex/prose-matched, and do adaptive gates run as focused model stages with explicit tool/check instructions?
- **Final actions:** Does the workflow distinguish implementation/review convergence from post-approval final actions such as PR/MR/review creation, release tagging, deployment, or publication? Are reviewers and reducers prompted to approve and hand off when implementation and validation criteria are proven and only an explicitly authorized final action remains?

Good workflows are information-flow systems, not just prompt sequences. Keep stage prompts focused, preserve evidence with file paths or artifacts, and pass only the context each downstream stage needs.

## Common Mistakes

- Do not invent workflow names; list first.
- Do not guess input keys; inspect with `inputs` or `get` first.
- Do not call `create`, `update`, or `delete` on the workflow tool; definitions are code-authored.
- Do not use legacy workflow tool fields like `agent`, `stage`, or run-control `name`.
- Do not pass strings or path objects to `ctx.workflow(...)`; import the workflow definition from `@bastani/atomic/workflows/builtin` or another TypeScript module first.
- Do not create a self-edge or a dependency edge from the current frontier to an existing ancestor. Cyclic workflow graphs are unsupported; redesign or stop before launch when a cycle cannot be removed.
- Do not model a bounded loop by reopening an earlier node beneath its downstream work. Create distinct tracked work per iteration and keep retained-session follow-up as non-topological activity when it adds no dependency work.
- Do not claim TypeScript or workflow discovery proves a dynamic workflow acyclic. Discovery diagnoses imports and definition shape; execution, replay, and DBOS hydration are the runtime topology boundary.
- Do not rely on undeclared child outputs; returning a key that is not declared in `outputs` fails the run. Declare every child-workflow field you expose in `outputs` — including `result` — and return values matching those schemas from `run` (see [Outputs](/workflows/authoring#outputs)).
- Do not expect to select or rename child outputs at the call site; parent workflows receive the child's declared output contract as `child.outputs` after checking `child.exited === false`, and a partial declared-output map when `child.exited === true`.
- Do not expect named workflow runs to block the chat turn; they are background tasks.
- Use `interrupt` or `pause` when the user asks to pause specific live work resumably; use `quit` for a graceful run-level process boundary.
- Keep stage names readable because they appear in workflow status and UI.
- Do not ask a stage to reason from workflow or stage names that are only orchestration labels. Model stages see their local prompt, artifacts, tools, and reads; describe the concrete action and evidence instead of referring to an implementation-specific nickname.
- Do not write stage prompts that depend on hidden workflow-wide awareness; make each model stage locally scoped and self-described ([Locally Scoped Stage Prompts](#locally-scoped-stage-prompts)).
- Do not parse model gate decisions from ad-hoc prose with regular expressions; configure `schema` on a focused workflow item and consume `result.structured`.
- Do not make reviewers fail an implementation gate solely because an authorized final action has not run yet. Represent that remainder as a post-approval next action (for example `finalActionRemaining` / `nextAction`) and let the final stage perform it.
- Do not let scope guards approve correctness or turn follow-up findings into blockers. Keep scope decisions separate from code review and deterministic validation, and do not reject expected pre-publication state assigned to a later lifecycle stage.
- Return compact structured decisions and save large artifacts to files; artifact handoffs should still use files when the next stage does not need the whole payload in context.

These mistakes cover workflow tool usage and authoring. For run-prompt anti-patterns, see the [Anti-patterns](#anti-patterns) table in [Workflow Best Practices](#workflow-best-practices).

## Workflow Best Practices

This playbook helps coding agents and workflow systems produce better results.

Treat an agent as a capable engineering partner that needs a clear objective, tight scope, explicit validation, and occasional steering.

Most weak agent runs fail for predictable reasons: the goal is vague, the scope is too broad, validation is missing, or the agent keeps following the wrong signal. This playbook addresses these failure modes.

The examples below are synthetic and intentionally generic. Replace placeholders like `[component]`, `[test command]`, and `[workflow]` with your own project details.

---

### The core loop

The core workflow pattern is:

```text
Objective -> Scope -> Done criteria -> Run -> Inspect -> Steer -> Validate -> Summarize
```

Apply this loop per independently verifiable implementation item. When a request contains several items, first use the [task-queue triage and bounded per-item dispatch rule](#task-queues-and-software-factories); do not make one item's inspect/steer/validate cycle block an unrelated item.

Use this sequence:

1. Define the end state.
2. Constrain the blast radius.
3. State what counts as done.
4. Run the agent or workflow.
5. Inspect status before reading details.
6. Steer only when the run is off track, blocked, or missing criteria.
7. Require evidence before accepting the result.
8. Ask for a summary, handoff, or next-step plan.

A good workflow prompt states both the task and its success criteria.

---

### Prompt anatomy

A strong workflow prompt usually includes:

#### Objective

What should be true when the work is complete?

```text
Implement `[specific behavior]` in `[component]`.
```

#### Context

What does the agent need to know before acting?

```text
This is needed because `[reason]`. The relevant code likely lives near `[area]`.
```

#### Scope

What is the agent allowed to change?

```text
Only touch files directly required for `[behavior]`.
```

#### Non-goals

What should the agent avoid?

```text
Do not redesign `[subsystem]`, refactor unrelated code, or change public behavior outside `[case]`.
```

#### Done criteria

How will we know the work is complete?

```text
Done means:
- `[new behavior]` works.
- `[existing behavior]` is unchanged.
- `[test command]` passes.
- The final response includes changed files, validation results, and remaining risks.
```

#### Stop conditions

When should the agent stop and ask instead of guessing?

```text
If this requires changing `[public API/security behavior/data migration]`, stop and ask first.
```

---

### Core principles

#### 1. Start with the end state

Describe what should be true at the end, not just what the agent should investigate.

Bad:

```text
Look into the login issue.
```

Better:

```text
Fix the login redirect regression. Done means users who sign in from `[page]` return to `[expected destination]`, and `[test command]` passes.
```

#### 2. Keep scope tight

Agents often expand into nearby cleanup, which can help, but most workflow runs should stay bounded.

Use phrases like:

- `Only touch files required for this behavior.`
- `Do not refactor unrelated code.`
- `Preserve existing behavior for [case].`
- `Make the smallest correct change.`

#### 3. Separate implementation from validation

Relevant evidence, not the agent's claim, determines whether a change is done.

Evidence can include:

- a targeted test,
- a broader regression test,
- a smoke command,
- a typecheck or lint command,
- a structured output contract check,
- or a clear manual verification step.

#### 4. Prefer evidence over speculation

When something fails, steer the agent back to the observable signal: the error, failing test, log line, user behavior, or broken contract.

```text
Treat the failing assertion as the source of truth. Do not guess from nearby code alone.
```

#### 5. Use staged thinking

For ambiguous work, separate the flow into stages:

```text
Investigate -> identify root cause -> propose fix -> implement -> validate -> summarize
```

If the cause is not clear, do not let the agent make broad, speculative changes.

#### 6. Steer, do not micromanage

The best steering messages are short and corrective. They add constraints, redirect attention, or provide a decision.

Usually, state only what changed instead of rewriting the whole prompt.

#### 7. Treat failed validation as the next task

A failed test becomes the next objective.

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

#### 8. Interrupt stale or wrong work

If a run is solving the wrong problem, based on outdated assumptions, or duplicating another run, stop it. Continuing usually creates more cleanup.

#### 9. Inspect at the right level

For long-running workflows, do not start by reading every log. Check:

1. overall status,
2. current stage,
3. blocker or failure reason,
4. relevant stage details only if needed.

#### 10. Ask for synthesis before handoff

Before switching from investigation to implementation, or from implementation to review, ask for a concise synthesis:

```text
Summarize root cause, proposed fix, files involved, validation plan, and remaining risks.
```

---

### Common Workflow Patterns

For workflows larger than one tracked task, choose a small control-flow pattern before writing prompts. **Workflow authors should favor these common patterns by default:** naming the pattern up front keeps the stage graph understandable, makes validation gates explicit, and helps reviewers see why work is split across model sessions. Reach for a bespoke structure only when none of these patterns fit.

The first six patterns below have runnable builtins. For example, a migration workflow can nest [**fan-out-and-synthesize**](/workflows/builtins#six-composable-pattern-builtins) for call-site fixes, [**adversarial-verification**](/workflows/builtins#six-composable-pattern-builtins) per patch, and [**loop-until-done**](/workflows/builtins#six-composable-pattern-builtins) while tests still fail. Import and compose the builtin definitions instead of copying their prompts/graphs. **Scope guard** and **Stacked implementation slices** are authoring starter patterns rather than builtins; compose scope guard's [boundary-task, retained-stage, or live-parallel form](#scope-guard-starter-pattern) from current primitives, and use stacked slices to unroll dependent implementation children through existing `ctx.workflow(...)` boundaries. **Constructive quorum** is an accepted reviewer-coordination pattern used by `goal` and `ralph`; it is prompt guidance rather than a standalone builtin.

These patterns organize work **inside one root lifecycle**. They do not replace the [task-queue rule](#task-queues-and-software-factories): independent whole implementation items normally get separate top-level runs and failure boundaries, while real dependency clusters may use these patterns inside each cluster run. Constructive quorum shapes bounded deliberation inside parallel reviewer stages; stacked implementation slices split one objective inside that lifecycle; queue triage splits separate whole items.

| Pattern | Use it when | Atomic shape |
|---|---|---|
| **Classify-and-act** | Inputs arrive in different categories and each category needs a different path, model, tool set, or output format. | `ctx.task("classify")` → deterministic branch → category-specific `ctx.task`, `ctx.chain`, `ctx.parallel`, or child `ctx.workflow(...)`. |
| **Fan-out-and-synthesize** | The task can be split into many independent slices that benefit from clean context windows. | `ctx.parallel([...])` with separate artifacts → synthesis barrier that reads the artifacts and merges the answer. |
| **Adversarial verification** | Outputs need independent checking against a rubric, security rule, factual source, or acceptance contract. | Worker stage(s) → fresh-context verifier stage(s) → reducer that accepts, rejects, or asks for repair. |
| **Generate-and-filter** | You need many candidate ideas, plans, names, fixes, or hypotheses before selecting the best few. | Generator fan-out → dedupe/filter stage → optional verifier/judge → final shortlist. |
| **Tournament** | The whole task is subjective or approach-sensitive, and comparative judgment is more reliable than absolute scoring. | Several agents attempt the same task → seeded ring and pivot rounds score each candidate pair by criterion → reducer reports the winner and full ranking. |
| **Loop until done** | The amount of work is unknown up front, such as finding all failures, mining repeated issues, or iterating until checks pass. | Bounded loop with an explicit stop condition, progress ledger, per-iteration artifacts, and a max-iteration escape hatch. |
| **Constructive quorum** | Several fresh-context verifiers judge the same artifact and a tallied vote could mask a defect one verifier found or block on one verifier's misreading. | Parallel verifiers form independent preliminary verdicts → exactly one bounded Intercom evidence-exchange round (share and challenge evidence) → each emits its own final structured verdict → deterministic reducer counts votes. |
| **Scope guard** | A worker or repair stage may turn valid adjacent findings into unplanned work. | Immutable contract artifact → fresh boundary or live scope checker → bounded decision artifact → forked worker continuation; correctness review stays separate. |
| **Stacked implementation slices** | One dependent implementation objective is too broad for one verified diff but can be divided into ordered, independently verifiable concerns. | Pre-launch slice plan → sequential child `ctx.workflow(...)` boundaries (`goal`, `ralph`, or a task-specific child) → each slice's gates → next slice based on the previous verified branch and worktree, or stop/report at the first failure. |

Constructive quorum relies on existing Intercom mechanics: every workflow invocation gets its own stable Intercom group, and parallel stages and delegated subagents inherit it when they can use Intercom. Reviewers can therefore reach siblings without authoring group plumbing; keep the evidence exchange bounded and leave quorum counting to the deterministic reducer.

#### Pattern diagrams

##### 1. Classify-and-act

Builtin definition and contracts: [Six composable pattern builtins](/workflows/builtins#six-composable-pattern-builtins).

```text
┌─ 1  Classify-and-act ────────────────────────────────────┐
│                                                          │
│                             ┌───────┐                    │
│                         ╭──▸│agent A│                    │
│                         │   └───────┘                    │
│  ┌────┐  ┌──────────┐   │   ┌───────┐                    │
│  │task│─▸│classifier│───┼──▸│agent B│ ◂ chosen           │
│  └────┘  └──────────┘   │   └───────┘                    │
│                         │   ┌───────┐                    │
│                         ╰──▸│agent C│                    │
│                             └───────┘                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Make the classifier return a structured category and confidence, not free-form prose.
- Keep each action branch isolated with the minimum tools and context it needs.
- Add a fallback or human-input branch for low-confidence classifications.

##### 2. Fan-out-and-synthesize

Builtin definition and contracts: [Six composable pattern builtins](/workflows/builtins#six-composable-pattern-builtins).

```text
┌─ 2  Fan-out-and-synthesize ──────────────────────────────┐
│                                                          │
│            ┌───────┐                                     │
│          ╭▸│agent 1│──╮                                  │
│          │ └───────┘  │                                  │
│          │ ┌───────┐  │                                  │
│          ├▸│agent 2│──┤                                  │
│  ┌────┐  │ └───────┘  │ ┌───────┐  ┌──────────┐          │
│  │task│──┤ ┌───────┐  ├▸│barrier│─▸│synthesize│          │
│  └────┘  ├▸│agent 3│──┤ └───────┘  └──────────┘          │
│          │ └───────┘  │                                  │
│          │ ┌───────┐  │                                  │
│          ╰▸│agent 4│──╯                                  │
│            └───────┘                                     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Partition by files, sources, claims, candidates, or work items that can be evaluated independently.
- Save each branch to a separate artifact and pass paths with `reads` instead of inlining all branch output.
- Treat synthesis as a barrier: it waits for every branch, deduplicates, resolves conflicts, and cites evidence.

##### 3. Adversarial verification

Builtin definition and contracts: [Six composable pattern builtins](/workflows/builtins#six-composable-pattern-builtins).

```text
┌─ 3  Adversarial verification ────────────────────────────┐
│                                                          │
│                                                          │
│  ┌──────┐       ┌──────────┐                             │
│  │worker│───╮──▸│verifier A│──╮                          │
│  └──────┘   │   └──────────┘  │                          │
│             │   ┌──────────┐  │   ┌───────┐              │
│             ├──▸│verifier B│──┼──▸│reducer│              │
│             │   └──────────┘  │   └───────┘              │
│             │   ┌──────────┐  │                          │
│             ╰──▸│verifier C│──╯                          │
│                 └──────────┘                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Give verifiers fresh context and a concrete rubric with pass/fail evidence requirements. For task-specific contract risk, use a grumpy/skeptical-but-fair persona that seeks realistic counterexamples, stays within the literal objective, rejects hand-waving and circular worker-authored evidence, and reports only actionable evidence-backed defects.
- Separate adversarial probe design from authoritative execution. Require a structured verifier plan with each exact probe, inputs, command/assertion, expected success condition, and covered requirement/risk; then run selected compile, test, schema generation/validation, runtime, or artifact checks through durable workflow-owned `ctx.tool(...)` calls. Actual tool results—not model self-report—feed judgment and consolidated repair.
- Known contracts may use direct task-specific `ctx.tool(...)` gates designed before launch; uncertain risks may use model-selected probes executed by those deterministic tools. Rerun the tools after repair until the declared pass condition or iteration limit.
- Ask verifiers to find blockers and not rewrite the candidate unless you explicitly assign them to repair it. Keep pure transformations as ordinary TypeScript rather than wrapping every model-stage action in `ctx.tool`.
- Decompose the rubric into named criteria and score each in its own call. Compound rubrics can latch onto one salient factor; the reference scan reports 76.4% for the best single criterion versus 78.3% for a three-criterion ensemble (§4.3).
- Aggregate by mean plus an explicit veto for genuinely disqualifying findings, never a unanimity AND across verifiers: unanimity makes false-reject grow as 1−(1−p)^K while the false-accept it buys only decays as (1−p)^K. See [Verification scaling](#verification-scaling).
- The shipped `adversarial-verification` builtin accepts `criteria` as a record of criterion names to descriptions or as a `criteria.md` Markdown string; the shared `verification-criteria` module also canonicalizes string lists and `CriterionInput` lists. Its public doors are `parse_rubric`, `normalize_criteria`, `select_criteria`, and `decide_verification`, using the `Criterion`, `CriterionInput`, `CriterionScore`, and `Finding` shapes; `NoCriteria` and `EmptyCriterion` are explicit rubric errors.
- A `criteria.md` rubric may have a `#` title, an optional `##` section whose heading contains `ground truth` (normally `## Ground Truth Note`; the first such section wins), and must include a `##` section whose heading contains `criteri` (normally `## Criteria`) whose `### Name {#id}` headings own non-empty criterion bodies. HTML comments are ignored; an omitted `{#id}` is slugged to lowercase alphanumeric/underscore text (up to 40 characters), with a fallback `criterion` id and encounter-order `_2`/`_3` deduplication. `parse_rubric` rejects a rubric with no criterion headings or an empty criterion body.
- `VERIFICATION_SCALE` anchors integer scores from 1 (certainly fails) through 20 (verified correct). `select_criteria` preserves the requested id order and rejects unknown ids; `decide_verification` accepts only with quorum, a mean at or above the policy threshold, and no `veto` finding, while an invalid report remains metadata rather than a score.
- Keep a scoring family in the `SHARED HEAD ‖ VARYING TAIL` layout from `verification-prompts`: the byte-identical head contains the task, ground-truth note, candidate bodies (or caller-provided read paths), and scale anchors in that order; the tail contains only the criterion name and description plus the output-format instruction. Candidate-specific bodies stay in the shared head, not the varying tail, so sibling criteria can reuse the cached prefix.
- Inline the whole candidate family only while every body is at most `32 * 1024` UTF-8 bytes (`MAX_INLINE_CANDIDATE_BYTES`). If any body is larger, switch the whole family to caller-bound paths, preserving path order and duplicates; an oversized pathless family is rejected rather than guessed.
- `warm_first_fan_out` schedules the first-seen step for each prefix before releasing the remaining steps, establishing the provider's warm prefix before sibling criteria or pair slots vary. Warm failures are observed without fail-fast, the remaining phase is still attempted before the error is rethrown, and successful results return in input order.
- The builtin input defaults are `verifier_count=3`, `max_repairs=2`, `accept_mean=14` on the 1–20 scale, and `reask_limit=1`; omitted `criteria` uses the `task_fit`, `evidence`, and `completeness` record. A round expects one schema-valid score for every criterion/verifier cell, and the normal call shape is criteria length multiplied by verifier count.
- Invalid criterion reports are written as invalid artifacts and re-asked in bounded waves up to `reask_limit`; an invalid or missing report is counted in `invalidCount` only and is never converted into a fail vote or included in the mean. If the required quorum is still missing after the re-asks, the round is `indeterminate` rather than silently narrowing the decision.
- `score_table_path` names the durable `verification-summary-<round>.json` for the final round. Its object contains `scores` (`criterion_id`, integer `score`, `evidence`, and `findings` with `finding` plus `severity`), `mean`, `invalidCount`, the `decision` (`accept`, `repair`, or `indeterminate` with its corresponding mean/findings or missing count), and folded `usage`; `review_report_path` carries repair guidance or quorum evidence.

##### 4. Generate-and-filter

Builtin definition and contracts: [Six composable pattern builtins](/workflows/builtins#six-composable-pattern-builtins).

```text
┌─ 4  Generate-and-filter ─────────────────────────────────┐
│                                                          │
│                                                          │
│  ┌─────┐   ┌────┐                      ┌────┐            │
│  │gen A│──▸│idea│───╮              ╭──▸│best│            │
│  └─────┘   └────┘   │              │   └────┘            │
│  ┌─────┐   ┌────┐   │  ┌──────┐    │   ┌────┐            │
│  │gen B│──▸│idea│───┼─▸│filter│────┼──▸│best│            │
│  └─────┘   └────┘   │  └──────┘    │   └────┘            │
│  ┌─────┐   ┌────┐   │              │   ┌╌╌╌╌╌╌╌╌╌┐       │
│  │gen C│──▸│idea│───╯              ╰──▸╎discarded╎       │
│  └─────┘   └────┘                      └╌╌╌╌╌╌╌╌╌┘       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Generate more candidates than you need, then filter hard by an explicit rubric.
- Dedupe before judging so near-identical candidates do not dominate the shortlist.
- Use this for exploration, naming, design options, hypotheses, and lightweight eval ideas.
- When the filter ranks candidates rather than applying a threshold, use the same judge guidance as Tournament: graded per-criterion integer scores rather than binary keep/drop, a Bradley–Terry preference from the score gap so near-ties stay near-ties, and K repeats with candidates swapped between the A and B slots. See [Verification scaling](#verification-scaling).
- For a custom ranking filter, reuse the shared `verification-criteria` module and its `criteria.md` parser rather than inventing a binary keep/drop rubric; stable criterion ids let the judge select the same criteria in each comparison. See [Adversarial verification](#3-adversarial-verification) for the accepted shapes and score decision.

##### 5. Tournament

Builtin definition and contracts: [Six composable pattern builtins](/workflows/builtins#six-composable-pattern-builtins).

```text
┌─ 5  Tournament ──────────────────────────────────────────┐
│                                                          │
│  ┌─────────┐                                             │
│  │attempt A│──╮  ┌───────┐                               │
│  └─────────┘  ├─▸│judge 1│───╮                           │
│  ┌─────────┐  │  └───────┘   │                           │
│  │attempt B│──╯              │   ┌─────┐  ┌──────┐       │
│  └─────────┘                 ├──▸│final│─▸│winner│       │
│  ┌─────────┐                 │   └─────┘  └──────┘       │
│  │attempt C│──╮  ┌───────┐   │                           │
│  └─────────┘  ├─▸│judge 2│───╯                           │
│  ┌─────────┐  │  └───────┘                               │
│  │attempt D│──╯                                          │
│  └─────────┘                                             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Use pairwise comparison when absolute scores are noisy or subjective.
- Randomize or balance presentation order where possible to reduce order bias.
- Keep the judge rubric short and require rationale tied to observable criteria.
- Have judges emit graded per-criterion integer scores rather than a binary winner, then derive a Bradley–Terry preference from the score gap so near-ties stay near-ties.
- Repeat each pair K times with the candidates swapped between the A and B slots; the swap cancels positional bias within the pair and variance falls as O(1/K). In the reference scan's discrete-judge study, 26.7% of pairs tied at K=1; with slot swaps, the reported K=1→16 result moved from 74.7% to 77.5%.
- See [Verification scaling](#verification-scaling) for score granularity and call-budget trade-offs.
- The shipped tournament inputs use `num_attempts=4` and `max_concurrency=4`; `n_evaluations=2` repeats each criterion/directed pair, `pivots=1` selects the second comparison phase's pivot candidates, and `seed=0` drives the deterministic schedule. `criteria` is optional and accepts a markdown rubric, a string-to-description record, a string list, or a `CriterionInput` list; omission uses the shipped three-criterion Correctness, Completeness, and Evidence and task fit rubric. Optional ordered `models` ids are assigned round-robin to attempt slots.
- `comparisons_path` points to `comparisons.json`, whose ledger records the task and seed, `params` (`n`, `pivots`, `n_evaluations`, and normalized `criteria`), per-job `comparisons` rows (`a`, `b`, phase, criterion id, repeat, slot-swap flag, scores or an `invalid` marker, preference, and judge artifact path), aggregate `pairs`, weights/counts, the complete `ranking`, and optional model assignment. Its `budget` records planned versus executed judge stages, including re-asks; invalid reports remain auditable rows and an all-invalid pair remains marked invalid rather than becoming a score.

##### 6. Loop until done

Builtin definition and contracts: [Six composable pattern builtins](/workflows/builtins#six-composable-pattern-builtins).

```text
┌─ 6  Loop until done ─────────────────────────────────────┐
│                                                          │
│  ┌───────┐   ┌─────────────┐  no   ┌────┐                │
│  │agent 1│──▸│new findings?│──────▸│done│                │
│  └───────┘   └──────┬──────┘       └────┘                │
│                     │ yes, spawn distinct work           │
│                     ▾                                    │
│                 ┌───────┐   ┌────────────┐               │
│                 │agent 2│──▸│next check …│               │
│                 └───────┘   └────────────┘               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Define both success and escape conditions before the loop starts.
- Keep a durable ledger of attempted work, findings, failures, and validation evidence.
- Bound loops by iterations, budget, or convergence criteria so exhausting a bound produces an inspectable failure instead of letting the loop continue indefinitely.
- Materialize every iteration as distinct tracked work with stable iteration identity and call order. Never represent repetition by a self-edge, a back-edge to an ancestor, or reopening an ancestor below its downstream work.
- Record a progress magnitude in the ledger beside the boolean stop bit; a flat or decreasing series is the stall signal that the loop is burning iterations without moving.
- Treat the trend as a monitoring and escalate-to-human signal, never a kill switch: the explicit stop condition remains authoritative. See [Verification scaling](#verification-scaling).
- The builtin defaults `max_iterations=5`, `progress_scoring=true`, and `progress_repeats=1`; set `progress_scoring` false to omit advisory scoring, while `progress_repeats` is the repeat count passed to the scoring primitive. Each scored iteration adds a `progress` entry to `progress-ledger.json` with `score`, `perRepeat` (null for an invalid repeat), `trend`, and the classifier `window`; the ledger also emits `progress_curve`, `final_trend`, and `progress_disclaimer`.
- Progress scores use the anchored 1–20 scale and average valid repeat scores per checkpoint. `classify_trend` uses `window=3`, `riseDelta=1.5`, and `fallDelta=-1.5`; it compares equal leading/trailing halves of the trailing two windows, drops an odd middle sample, and classifies inclusive threshold crossings as `rising`, `flat`, or `regressing`. A short series is `flat` evidence.
- The trend is monitoring and escalation evidence only: it never kills, terminates, or approves a loop, and the explicit evaluator stop condition remains authoritative. `progress_curve`, `final_trend`, and `progress_disclaimer` are advisory outputs, not alternate closure signals.

##### 7. Constructive quorum

This prompt-level reviewer pattern is used by the `goal` and `ralph` builtins; it does not add a reducer or quorum mechanism.

```text
┌─ 7  Constructive quorum ──────────────────────────────────┐
│                                                          │
│  ┌──────────────┐   ┌──────────────┐                    │
│  │reviewer A    │   │reviewer B    │   independent       │
│  │preliminary   │   │preliminary   │   assessments        │
│  │verdict       │   │verdict       │                    │
│  └──────┬───────┘   └──────┬───────┘                    │
│         ╰──── Intercom: one evidence round ────╮        │
│                share · challenge · correct     │        │
│                         ┌──────────────────────┘        │
│                         ▾                               │
│              ┌──────────────────┐   ┌───────────────┐   │
│              │final structured  │──▸│deterministic  │   │
│              │verdicts + change │   │reducer counts │   │
│              │evidence          │   │votes          │   │
│              └──────────────────┘   └───────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Give every reviewer an independent preliminary assessment before it reads sibling findings or verdicts.
- Run exactly one bounded evidence-exchange round. Share concrete findings and evidence, challenge blocking claims, and stop rather than opening a second round.
- Change a verdict only through evidence, never deference. Each reviewer emits its own final structured verdict and records whether deliberation changed it and which evidence caused the change.
- Let the existing deterministic reducer count the final votes; deliberation shapes votes but does not replace quorum counts or the `stop_review_loop` contract.

##### Stacked implementation slices starter pattern

Use this authoring pattern when one implementation objective should land as a stack of small, independently verified changes. It is not a queue dispatcher: the slices belong to one dependency chain, so slice N+1 starts only after slice N is verified.

During the pre-launch architecture pass, enumerate the slices in the coverage matrix. Give every slice its own objective, acceptance criteria, changed-file scope, and verification gates. Target roughly 100–500 changed lines between verification points by default, but treat that as a reviewability default rather than a law: keep a genuinely atomic mechanical change or generated-artifact refresh in one slice, and do not split a small objective just to reach a count.

```text
┌─ Stacked implementation slices ─────────────────────────────┐
│ plan → prepare branch/worktree → child slice 1 → gates      │
│                                      │ verified              │
│                                      ▼                       │
│              prepare branch from slice 1's verified branch  │
│                                      ▼                       │
│                         child slice 2 → gates              │
│                                      │ failed → stop/report │
└─────────────────────────────────────────────────────────────┘
```

Run each slice through a child workflow that owns its implement/review/repair lifecycle. Import `goal` or `ralph` from `@bastani/atomic/workflows/builtin`, or use a task-specific child when neither builtin matches. Before each child, use a durable `ctx.tool(...)` step to create or check out the slice's explicit branch in its worktree. `worktreeFromInputs` creates a missing target with a detached checkout and reuses an existing target as-is; `base_branch` and `git_worktree_dir` do not create or check out a feature branch by themselves. Create slice N+1's branch from slice N's verified branch, then pass that previous branch as `base_branch` and give the child a distinct `git_worktree_dir`.

The parent should verify each child before creating the next boundary. If a gate fails, stop at the first failed gate, report that slice as unverified, and retain the earlier verified slices and their branch/worktree records. Do not roll earlier slices back and do not continue past the failure.

The calls below are deliberately unrolled. Repeat the downstream shape for the planned slices, giving every call a fresh child boundary and distinct tracked nodes; do not reopen an ancestor or add a back-edge.

```ts
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Type } from "typebox";
import { workflow } from "@bastani/atomic/workflows";
import { goal } from "@bastani/atomic/workflows/builtin";

function spawnCommand(argv: readonly string[], cwd: string) {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("spawnCommand requires a command");
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  // A command that could not be spawned at all arrives on `error` with a null
  // status, so it has to be raised here or it reads as an ordinary failure.
  if (result.error) throw result.error;
  return result;
}

function runCommand(argv: readonly string[], cwd: string): string {
  const result = spawnCommand(argv, cwd);
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.status !== 0) {
    throw new Error(`${argv.join(" ")} failed (${result.status})\n${stderr || stdout}`);
  }
  return stdout;
}

export default workflow({
  name: "stacked-slices",
  inputs: {
    slice1_branch: Type.String({ default: "stacked/slice-1" }),
    slice2_branch: Type.String({ default: "stacked/slice-2" }),
  },
  outputs: {},
  run: async (ctx) => {
    const repoRoot = runCommand(["git", "rev-parse", "--show-toplevel"], ctx.cwd ?? process.cwd());
    const slice1Branch = ctx.inputs.slice1_branch;
    const slice2Branch = ctx.inputs.slice2_branch;
    if (slice1Branch === slice2Branch) {
      return ctx.exit({ status: "blocked", reason: "slice branches must be distinct" });
    }

    const prepareSliceWorktree = async (
      toolName: string,
      branch: string,
      gitWorktreeDir: string,
      baseBranch: string,
    ) => {
      const worktreePath = resolve(repoRoot, gitWorktreeDir);
      await ctx.tool(
        toolName,
        { branch, base_branch: baseBranch, git_worktree_dir: gitWorktreeDir },
        async () => {
          const current = spawnCommand(
            ["git", "-C", worktreePath, "branch", "--show-current"],
            repoRoot,
          );
          if (current.status === 0) {
            const checkedOutBranch = (current.stdout ?? "").trim();
            if (checkedOutBranch !== branch) {
              throw new Error(`${worktreePath} is checked out on ${checkedOutBranch || "detached HEAD"}, expected ${branch}`);
            }
            return { branch, worktree: worktreePath };
          }

          const branchProbe = spawnCommand(
            ["git", "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            repoRoot,
          );
          if (branchProbe.status === 0) {
            runCommand(["git", "worktree", "add", worktreePath, branch], repoRoot);
          } else if (branchProbe.status === 1) {
            runCommand(["git", "worktree", "add", "-b", branch, worktreePath, baseBranch], repoRoot);
          } else {
            throw new Error((branchProbe.stderr ?? "").trim() || `could not inspect branch ${branch}`);
          }
          return { branch, worktree: worktreePath };
        },
      );
    };

    await prepareSliceWorktree("prepare-slice-1-branch", slice1Branch, "../slice-1", "origin/main");
    const slice1 = await ctx.workflow(goal, {
      inputs: {
        objective: "Implement the first independently verified concern.",
        acceptance_criteria: "The first concern builds, passes its focused tests, and commits all changes on the current feature branch.",
        base_branch: "origin/main",
        git_worktree_dir: "../slice-1",
        create_pr: false,
      },
      stageName: "slice 1",
    });
    if (slice1.exited === true || slice1.outputs.approved !== true) {
      return ctx.exit({ status: "blocked", reason: "slice 1 is unverified" });
    }

    await prepareSliceWorktree("prepare-slice-2-branch", slice2Branch, "../slice-2", slice1Branch);
    const slice2 = await ctx.workflow(goal, {
      inputs: {
        objective: "Implement the next concern on the verified slice-1 branch.",
        acceptance_criteria: "The second concern builds, passes its focused tests, preserves slice 1, and commits all changes on the current feature branch.",
        base_branch: slice1Branch,
        git_worktree_dir: "../slice-2",
        create_pr: false,
      },
      stageName: "slice 2",
    });
    if (slice2.exited === true || slice2.outputs.approved !== true) {
      return ctx.exit({ status: "blocked", reason: "slice 2 is unverified; slice 1 remains verified" });
    }

    return {};
  },
});
```

The `prepareSliceWorktree` tools run before their child boundaries and use `git worktree add -b`, so each child starts in a named feature branch. Once the path exists, the child's worktree binding reuses it as-is; `base_branch` remains the comparison base for its reviewers. The child owns implementation, review, repair, and acceptance, while the parent owns branch/worktree setup and the stop boundary.

Use `ralph` or a task-specific child in the same positions when its input contract fits better. For a longer stack, keep the same explicit downstream shape: create each next named branch from the previous verified branch, pass that previous branch as the next child's `base_branch`, and use a distinct worktree. Do not replace the chain with a loop that points back to an ancestor. A final handoff can report `slice → branch → worktree → verified/failed` from the explicit inputs and preparation records without reopening completed child work.

#### Verification scaling

This is authoring guidance for custom workflows, not a description of shipped builtin inputs:

- Use an anchored 1–20 integer scale as the default score granularity.
- Providers expose no token logprobs, so a K-sample average is the substitute; K=16 parity costs roughly 16× the call cost, making K a budget decision.
- Treat pool diversity as a bet on the selector's oracle ceiling. In the reference scan's pivot tournament, best-of-3 selection reached 86.5% ±1.1 against 79.4% pass@1 with a 92.1% oracle ceiling, while best-of-5 reached 88.0% ±0.6 against 78.7% pass@1 with a 96.6% oracle ceiling. A chance-level selector can make a more diverse pool worse, so widen the pool only once the judge beats chance.
- Self-verification—having the same model judge its own rollouts—still gained +7.1 over pass@1 in the best-of-3 comparison (86.5% versus 79.4%) and +9.3 in the best-of-5 comparison (88.0% versus 78.7%).
- For a cheap operating point, an author can use one pivot and K=2 repeats for a best-of-3-shaped comparison budget; this is an authoring recipe, not a shipped default.
- For the shipped primitive references, see [Adversarial verification](#3-adversarial-verification) for criteria parsing, warm-first scoring, re-asks, and score summaries; [Tournament](#5-tournament) for inputs and `comparisons.json`; [Loop until done](#6-loop-until-done) for progress ledger/trend outputs; and [Goal](/workflows/builtins#goal)/[Ralph](/workflows/builtins#ralph) for re-verification and convergence evidence.

#### Choosing a common workflow pattern

- Pick **classify-and-act** when routing correctness matters more than breadth.
- Pick **fan-out-and-synthesize** when the work divides cleanly into independent slices.
- Pick **adversarial verification** when the main risk is a plausible but wrong answer.
- Pick **generate-and-filter** when output quality depends on exploring a large option space.
- Pick **tournament** when multiple whole-solution strategies should compete under one rubric.
- Pick **loop until done** when the workflow should continue until evidence says it is finished, not until a preselected number of stages completes.
- Pick **constructive quorum** when several fresh-context verifiers judge one artifact and a simple tally could hide a defect or preserve one verifier's misreading; use one bounded evidence exchange before each verifier emits its own final vote.
- Pick **scope guard** when valid adjacent findings could expand a worker or repair stage beyond its immutable contract; choose a boundary task by default and live parallel steering only when timing requires it.
- Pick **stacked implementation slices** when one dependent implementation objective needs ordered, independently verified layers. Keep the 100–500 line range as a default with atomic-change escapes; create or check out each named branch before its child, create each next branch from the previous verified branch, pass that previous branch as `base_branch`, use a distinct `git_worktree_dir`, and stop at the first failed gate.

Record the selected pattern in your spec or workflow README, then adapt the diagram to the stage graph. If the final design does not resemble any common pattern, explain why in the workflow's design notes.

---

### Steering patterns

#### Tighten scope

**Signal:** The agent starts expanding into adjacent cleanup, unrelated files, or broad refactors.

**Steer:**

```text
Narrow this to `[specific behavior]` in `[component]`. Do not refactor unrelated code or change `[adjacent area]`. Done means `[specific acceptance criteria]`.
```

**Why:** Prevents risky changes and keeps the run reviewable.

---

#### Add missing done criteria

**Signal:** The agent has a plan, but no clear completion criteria.

**Steer:**

```text
Use these done criteria:
1. `[behavior]` works.
2. `[regression]` remains unchanged.
3. `[test command]` passes.
4. Report files changed and validation results.
```

**Why:** Makes completion verifiable.

---

#### Redirect an off-track stage

**Signal:** The workflow is investigating the wrong area or solving the wrong problem.

**Steer:**

```text
Stop pursuing `[wrong direction]`. The relevant signal is `[error/test/user behavior]`. Re-focus on `[target area]` and continue from there.
```

**Why:** Saves time and prevents wrong assumptions from compounding.

---

#### Respond to a blocked prompt

**Signal:** The workflow asks for approval, a choice, or clarification.

**Steer:**

```text
Choose `[option]`. Continue only if `[condition]`; otherwise stop and report the blocker.
```

**Why:** Keeps the workflow unblocked without adding ambiguity.

---

#### Turn failed validation into the next task

**Signal:** Tests, typecheck, lint, build, or smoke checks fail.

**Steer:**

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

**Why:** Prevents accepting partially working output.

---

#### Ask for synthesis

**Signal:** The workflow has gathered information, but the next action is unclear.

**Steer:**

```text
Synthesize the current findings into: root cause, proposed fix, files likely involved, validation plan, and remaining risks.
```

**Why:** Turns findings into a usable plan.

---

#### Pause, stop, or rerun

**Signal:** A run is stale, duplicated, superseded, or based on outdated assumptions.

**Steer:**

```text
Pause this run; it has been superseded by `[new context]`. Resume only with `[updated objective]`, or stop and summarize current state.
```

**Why:** Avoids conflicting changes and wasted work.

---

### Copy-paste templates

#### Start a workflow

```text
Objective:
Implement/fix `[specific behavior]` in `[component]`.

Context:
`[short context about why this matters or where to look]`

Scope:
- Only touch files required for `[behavior]`.
- Do not refactor unrelated code.
- Preserve existing behavior for `[existing case]`.

Done criteria:
- `[new behavior]` works.
- `[regression case]` still works.
- `[test command]` passes.
- Report changed files, validation results, and any risks.

Stop conditions:
- If this requires `[risky decision]`, stop and ask first.
```

#### Tighten scope

```text
Tighten scope to `[specific target]`.

Do not work on:
- `[excluded area 1]`
- `[excluded area 2]`
- broad cleanup or unrelated refactors

Continue only on the path needed to satisfy:
`[acceptance criterion]`.
```

#### Add acceptance criteria

```text
Add these acceptance criteria before continuing:

1. User can `[action]`.
2. System handles `[edge case]`.
3. Existing behavior `[existing behavior]` is unchanged.
4. `[test command]` passes.
5. Final response includes validation evidence.
```

#### Redirect a stage

```text
This stage is off track.

Stop investigating `[wrong area]`.
The relevant signal is `[error/output/requirement]`.
Refocus on `[correct area]`.

Next:
1. Reproduce or inspect `[signal]`.
2. Identify root cause.
3. Make the smallest fix.
4. Run `[validation command]`.
```

#### Handle failed validation

```text
Validation failed:

Command:
`[command]`

Failure:
`[short sanitized failure summary]`

Treat this as the source of truth.
Fix only the root cause.
Rerun the failing command.
If it still fails, summarize the blocker and stop.
```

#### Ask for synthesis

```text
Synthesize current progress into:

- What was attempted
- What changed
- What evidence supports the result
- What remains uncertain
- Recommended next steps
- Exact validation commands run
```

#### Turn findings into implementation steps

```text
Convert the findings into an implementation plan:

1. Files/components to change
2. Order of changes
3. Tests to add or update
4. Validation commands
5. Risks or edge cases
6. Stop conditions
```

#### Prepare a release gate

```text
Prepare `[version]` as a `[release kind]` release.

Requirements:
- Verify changelog entries are complete.
- Run `[test command]`.
- Run `[build/package command]`.
- Do not publish unless all validation passes.
- If any gate fails, stop and report blockers.

Final response should include:
- Version
- Checks run
- Results
- Files changed
- Publish readiness
```

---

### Concrete examples

#### Example 1: Fixing a failing test

**Scenario:** A package has one failing unit test after a recent change.

**Initial objective:**

```text
Fix the failing `[unit test]`. Do not rewrite the module. Done means the test passes and nearby tests still pass.
```

**Steering message:**

```text
Stop exploring unrelated failures. Focus only on the assertion mismatch in `[test file]`.
```

**Validation:** Run `[targeted test command]`, then `[nearby test command]`.

**Outcome:** Small fix applied, regression test passes, and the workflow reports exact commands and results.

---

#### Example 2: Repairing a workflow definition

**Scenario:** A custom workflow no longer returns the expected structured output.

**Initial objective:**

```text
Validate `[workflow]` and fix its output contract. Done means the smoke run returns `[required fields]`.
```

**Steering message:**

```text
Treat the missing output field as the root issue. Do not change unrelated stage prompts.
```

**Validation:** Reload workflow, run minimal smoke input, inspect structured result.

**Outcome:** Contract fixed, smoke test passes, and the workflow can be reused safely.

---

#### Example 3: Investigating before implementing

**Scenario:** A user-reported bug is ambiguous.

**Initial objective:**

```text
Investigate `[bug]`, identify root cause, and propose the smallest fix. Do not implement until the cause is clear.
```

**Steering message:**

```text
Synthesize findings first: root cause, affected path, proposed fix, and validation plan.
```

**Validation:** Add or run a reproduction test before changing code.

**Outcome:** Clear implementation plan produced, then delegated as a scoped fix.

---

### Anti-patterns

These anti-patterns target run prompts; [Common Mistakes](#common-mistakes) covers workflow tool and authoring mistakes.

| Anti-pattern | Better approach |
| --- | --- |
| `Fix this.` | `Fix [specific failure]; done means [test command] passes.` |
| No validation step | Require tests, smoke checks, typecheck, or explicit manual verification. |
| Broad refactors | Constrain the run to the files needed for the objective. |
| Letting a wrong stage continue | Redirect or interrupt as soon as the agent follows the wrong signal. |
| Accepting unverified summaries | Ask for changed files, commands run, results, and remaining risks. |
| Mixing investigation and implementation too early | Ask for root cause and proposed fix before code changes. |
| Ignoring blocked stages | Answer directly with one decision and any constraints. |
| Continuing stale runs | Pause, stop, or rerun with updated context. |
| Reading every log | Inspect status, then stages, then only relevant details. |
| Publishing without gates | Require release validation and explicit stop conditions. |
| Serializing independent issues from list order | Triage dependencies, then launch separate top-level item runs under a concurrency bound. |

---

### Quick reference

Before starting a workflow, include:

- [ ] Objective
- [ ] Context
- [ ] Scope
- [ ] Non-goals
- [ ] Done criteria
- [ ] Validation command
- [ ] Reporting requirements
- [ ] Stop conditions
- [ ] Queue dependency classification, concurrency bound, and item → run/worktree/branch map (when several implementation items are requested)

Before accepting a workflow result, ask:

- [ ] What changed?
- [ ] Why was this the right fix?
- [ ] What evidence supports it?
- [ ] Which commands were run?
- [ ] What still might be risky?
- [ ] Is anything blocked or unresolved?

Clearer prompts help agents produce better results.
