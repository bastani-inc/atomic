# Choose a workflow shape

Choose the lightest execution shape that still owns the task's control flow, evidence, and convergence criteria. Start with the decision rules, then adapt a starter graph.

## When to Use Workflows

Workflows are the default execution path when a request is non-trivial or combines inherent structure with a verifiable objective. Choose a workflow before direct chat when the prompt includes any of these signals:

- implementation, build, debugging/diagnosis, bug-fix, migration, new-feature, scoped multi-file, or validated docs/code work
- multiple subtasks, dependencies, handoffs, uncertainty, or parallel/sequential stages
- review, validation, QA, approval, evidence, or human-input gates
- long-running or resumable background execution, saved artifacts, or important model fallback chains
- reusable automation or a loop/stop condition such as `do X until Y`, `review/fix until passing`, or `run checks and fix until green`

Use direct chat only for tiny, deterministic, low-risk answers or edits where stage tracking clearly costs more than it adds, typically a single-file/no-test/no-review change. Decide inline versus workflow before the first tool call; reconnaissance is already inline execution. Once workflow fit is clear, limit pre-workflow reconnaissance to the few reads needed to sharpen the objective and validation criteria, and put deeper research or behavior probing inside the run.

Do not confuse workflow-first with force-fitting a builtin. Discover named builtin, project, user, and package workflows; use direct `task`, `tasks`, or `chain` calls for simple tracked shapes; or write a task-specific TypeScript `workflow({...})` inline with normal coding tools. Rich custom workflows can compose the starter patterns below: classify and branch at runtime, fan out and synthesize artifacts, run worker/verifier/reducer repair cycles, generate and filter or tournament-rank candidates, and loop until explicit evidence says the work is done. Write the definition, reload workflow resources, and run it; the workflow tool has no create action.

If inline work drifts past roughly ten exploratory tool calls without an artifact, edit, or commit, or repeats a "verify one more thing" loop, save the findings to a context file and hand the task to the best-fit named or custom workflow through `reads`. Sunk research is transferable, not a reason to continue inline.

| User goal | Use |
|-----------|-----|
| Run, inspect, connect to, pause, interrupt, quit, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run an autonomous job that materially benefits from a durable goal ledger, bounded worker turns, named validation, and reviewer-gated completion | `/workflow goal objective="..."` so Atomic captures receipts, gates completion through reviewers, stops as `complete`, `blocked`, or `needs_human`, and can optionally run a final PR handoff with `create_pr=true` after approval |
| Run an autonomous job that materially benefits from a durable research-first pipeline, delegated implementation, and iterative review | `/workflow ralph prompt="..."` so Atomic can transform the prompt into a research question, research the codebase first, delegate implementation through sub-agents, review, and iterate; prompt text alone does not opt in to PR creation, so add `create_pr=true` only when you want the final `pull-request` stage and `pr_report` |
| Create or edit reusable automation | a TypeScript workflow definition exported from `workflow({...})` |
| Track one-off work without saving a workflow file | direct `workflow({ task })`, `workflow({ tasks })`, or `workflow({ chain })` calls |
| Make a workflow robust | design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

## Workflow Starter Patterns

When a workflow is larger than a single tracked task, start by choosing a small control-flow pattern before writing prompts. Naming the pattern keeps the stage graph understandable, makes validation gates explicit, and helps reviewers see why work is split across model sessions.

These patterns are composable. For example, a migration workflow might use **fan-out-and-synthesize** to fix many call sites, then **adversarial verification** to review each patch, and finally **loop until done** while tests still fail.

| Pattern | Use it when | Atomic shape |
|---|---|---|
| **Classify-and-act** | Inputs arrive in different categories and each category needs a different path, model, tool set, or output format. | `ctx.task("classify")` → deterministic branch → category-specific `ctx.task`, `ctx.chain`, `ctx.parallel`, or child `ctx.workflow(...)`. |
| **Fan-out-and-synthesize** | The task can be split into many independent slices that benefit from clean context windows. | `ctx.parallel([...])` with separate artifacts → synthesis barrier that reads the artifacts and merges the answer. |
| **Adversarial verification** | Outputs need independent checking against a rubric, security rule, factual source, or acceptance contract. | Worker stage(s) → fresh-context verifier stage(s) → reducer that accepts, rejects, or asks for repair. |
| **Generate-and-filter** | You need many candidate ideas, plans, names, fixes, or hypotheses before selecting the best few. | Generator fan-out → dedupe/filter stage → optional verifier/judge → final shortlist. |
| **Tournament** | The whole task is subjective or approach-sensitive, and comparative judgment is more reliable than absolute scoring. | Several agents attempt the same task → pairwise judges compare results → bracket reducer returns winners. |
| **Loop until done** | The amount of work is unknown up front, such as finding all failures, mining repeated issues, or iterating until checks pass. | Bounded loop with an explicit stop condition, progress ledger, per-iteration artifacts, and a max-iteration escape hatch. |

### Pattern diagrams

#### 1. Classify-and-act

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

#### 2. Fan-out-and-synthesize

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

#### 3. Adversarial verification

```text
┌─ 3  Adversarial verification ────────────────────────────┐
│                                                          │
│                                                          │
│                                 ┌──────────┐             │
│               ├────────────────▸│verifier A│             │
│               │                 └──────────┘             │
│  ┌──────┐     │                 ┌──────────┐             │
│  │worker│◂────┼────────────────▸│verifier B│             │
│  └──────┘     │                 └──────────┘             │
│               │                 ┌──────────┐             │
│               ├────────────────▸│verifier C│             │
│                                 └──────────┘             │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Give verifiers fresh context and a concrete rubric with pass/fail evidence requirements.
- Separate production from judgment to reduce self-preferential bias.
- Ask verifiers to find blockers, not to rewrite the candidate unless repair is explicitly their role.

#### 4. Generate-and-filter

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

#### 5. Tournament

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

#### 6. Loop until done

```text
┌─ 6  Loop until done ─────────────────────────────────────┐
│                                                          │
│      yes, spawn another                                  │
│     ╭────────────────╮                                   │
│     ▾                │                                   │
│  ┌─────┐      ┌─────────────┐  no   ┌────┐               │
│  │agent│─────▸│new findings?│──────▸│done│               │
│  └─────┘      └─────────────┘       └────┘               │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Best practices:
- Define both success and escape conditions before the loop starts.
- Keep a durable ledger of attempted work, findings, failures, and validation evidence.
- Bound loops by iterations, budget, or convergence criteria so they fail inspectably instead of drifting.

### Choosing a starter pattern

- Pick **classify-and-act** when routing correctness matters more than breadth.
- Pick **fan-out-and-synthesize** when the work divides cleanly into independent slices.
- Pick **adversarial verification** when the main risk is a plausible but wrong answer.
- Pick **generate-and-filter** when the output quality depends on exploring a large option space.
- Pick **tournament** when multiple whole-solution strategies should compete under one rubric.
- Pick **loop until done** when the workflow should continue until evidence says it is finished, not until a preselected number of stages completes.

Record the selected pattern in your spec or workflow README, then adapt the diagram to the actual stage graph. If the final design does not resemble any starter pattern, explain why in the workflow's design notes.

## Choosing an Execution Shape

"Use a workflow" is not one decision — it is a ladder of execution shapes with different costs and guarantees. This section is written as agent-facing guidance: it is the self-prompt an orchestrating agent should run before the first tool call on a new request, and it doubles as documentation for humans who want to steer that choice explicitly.

The shapes, cheapest first:

| Shape | What it is | Guarantees you gain | Cost you pay |
|---|---|---|---|
| **Inline** | Answer or edit directly in the current session. | Lowest latency, zero ceremony. | No tracking, no gates, no isolation, easy to drift. |
| **Inline + subagents** | Bounded specialist delegation (locate/analyze/research/debug passes, noisy command investigation, parallel read-only fanouts) while the parent keeps control and synthesizes. | Context isolation for noisy or parallel evidence-gathering. | No completion gate, no durable stages; the parent is the only reviewer. |
| **Direct one-off shapes** | `workflow({ task })`, `workflow({ tasks })`, or `workflow({ chain })` without saving a definition. | Stage tracking, artifacts, model fallbacks, monitoring, resume. | Linear/parallel control flow only; no custom branching or loops. |
| **Named workflows** | Installed builtin, project, user, or package workflows (`goal`, `ralph`, `deep-research-codebase`, `open-claude-design`, ...). | A proven graph: bounded loops, reviewer gates, ledgers, evidence contracts, tuned model chains. | The task must actually match the graph's objective and inputs. |
| **Custom workflow** | A task-specific TypeScript `workflow({...})` authored inline, composing the starter patterns. | Exactly the control flow the task needs: runtime branching, dynamic fan-out, custom gates, tournaments, bounded loops. | Authoring and reload time; you own the design quality. |
| **Composed/nested workflows** | A custom parent that imports proven definitions and calls `ctx.workflow(child)`. | Reuse of hardened children (research, review loops) inside custom control flow, within `maxDepth`. | Parent/child input-output contracts must be mapped deliberately. |

### The self-prompt

Ask these questions in order and stop at the first shape that satisfies every remaining requirement. Decide before the first tool call and state the decision; reconnaissance already counts as inline execution.

1. **Is the outcome provable?** If success can be stated as evidence (tests green, artifact exists, behavior demonstrated, reviewer approves), the task is workflow-shaped. If no proof is possible or needed, inline is probably fine.
2. **Is there structure?** Multiple subtasks, dependencies, handoffs, or parallel slices push past inline. A single focused evidence-gathering pass does not.
3. **Is there a loop or gate?** Any "until Y", "fix until passing", review/approval gate, or unknown-length repair cycle requires an engine that owns the stop condition — a workflow, never an improvised inline retry loop or a stretched subagent chain.
4. **Is it one task or a queue of tasks?** "Address all open issues" or "fix every ticket assigned to me" is a factory request, not one workflow. Enumerate and dependency-classify the items first, then follow [Task queues and software factories](/workflow-when-to-use#task-queues-and-software-factories): independent items become separate per-item runs; dependent items share one composed graph.
5. **Does an installed graph already fit?** If a named workflow's objective and inputs cover essentially the whole task, run it. Do not force-fit: a builtin that matches 60% of the task and fights the other 40% is worse than a small custom graph.
6. **Does the control flow need shapes builtins don't offer?** Runtime classification, per-item dynamic fan-out, generate-and-filter, tournaments, or domain-specific gates mean authoring a custom workflow from the starter patterns.
7. **Is a sub-problem already solved by a proven graph?** Nest it with `ctx.workflow(...)` instead of re-authoring its prompts and gates. Composition beats duplication whenever a child's input/output contract can be mapped cleanly.
8. **Is it only specialist evidence-gathering?** If the parent keeps control, no completion gate is needed, and the work is bounded (a debug pass, a parallel research fanout, one noisy investigation), inline subagents are enough — and cheaper than a workflow.
9. **Is it truly tiny?** Deterministic, low-risk, single-file/no-test/no-review — answer or edit inline and stop.

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

- **0–3 total:** inline. Adding stages costs more than it buys.
- **4–6 total, Iteration ≤ 1, no gate:** inline subagents (parent-controlled) or a direct one-off `task`/`tasks`/`chain` when tracking and artifacts help.
- **7+ total, or Iteration = 2, or Verifiability = 2 with a review/approval gate:** a real workflow. Prefer a named workflow when one fits the whole task; otherwise author a custom graph, nesting proven children where sub-problems overlap.
- **Any single hard signal overrides the arithmetic:** an explicit loop/stop condition, an approval or evidence gate, or a request for durable/background execution puts the task in workflow territory regardless of total score.

Two common misuses the rubric exists to prevent: stretching parent-controlled subagent calls into an ad hoc implement→review→retry pipeline (that is adversarial verification without an engine — use a workflow and let its stages delegate specialists), and unbounded inline reconnaissance (after roughly ten exploratory calls with no artifact, write findings to a context file and hand off through `reads`; sunk research transfers, it is not a reason to stay inline).

### Task queues and software factories

Some requests are not one task but a queue of them: "address all open issues", "fix every Linear ticket assigned to me", "burn down the TODO backlog", "upgrade every service to the new SDK". These fire-and-forget factory requests get their own decision step, because the biggest mistake is jumping straight to one monolithic workflow that grinds through the queue serially in a single ever-growing context.

**Triage the queue before choosing the shape.** The first action is always a cheap enumeration-and-dependency pass, not implementation: list the items (issue tracker query, ticket API, grep for TODOs), then classify how they relate:

- **Independent items** — different subsystems, no shared files, no ordering constraints, each individually verifiable.
- **Dependent items** — one blocks another, they touch the same files/modules, they share a migration or API change, or their acceptance criteria reference each other.
- **Clustered** — the queue splits into groups: dependencies inside a group, independence between groups.

**Independent items → many small runs, not one big one.** Spawn one workflow run per item (typically `goal` with the item's text as the objective and acceptance criteria, `create_pr=true` for per-item PRs), each in its own `git_worktree_dir`, running in the background. One run per item buys what a monolith cannot:

- **Isolation:** a hard item that stalls or fails does not poison the remaining ones; each run resumes, retries, or can be stopped independently.
- **Clean contexts:** every item starts with full attention on its own objective instead of inheriting twenty finished tickets of transcript.
- **Independent evidence:** per-item reviewer gates, receipts, and PRs that a human can merge or reject one at a time.
- **Real parallelism:** runs proceed concurrently, bounded by however many you choose to have in flight at once (worktrees prevent filesystem collisions).

Do not spawn unbounded: dispatch in waves (for example 3–5 concurrent runs), wait for lifecycle notices, then dispatch the next wave — and report the dispatch plan (item → run id → worktree) so the queue is auditable.

**Dependent items → one graph that encodes the ordering.** When items block each other or share a change surface, isolation stops being a feature — separate runs would fight over the same files or implement against stale assumptions. Encode the dependency structure explicitly instead:

- **A composed parent workflow** that nests a proven child (for example `ctx.workflow(goal, ...)` per item) in dependency order, passing each item's outputs/artifacts to its dependents — the preferred form, because each item still gets its own bounded loop and reviewer gate while the parent owns sequencing.
- **A single monolithic workflow** only when the items are so entangled they are really one task with subtasks (one migration touching every call site is one task, not a queue).

**Clustered queues → both.** Compose within a cluster, fan out across clusters: each cluster becomes one run (a composed parent or a single `goal` objective covering the cluster), and independent clusters are dispatched as parallel background runs in waves.

The self-prompt for factory requests, condensed: **enumerate → classify dependencies → fan out runs where independent, compose graphs where dependent → dispatch in bounded waves → report the plan.** When dependency classification is uncertain, prefer smaller independent runs and let per-item reviewer gates catch collisions — a rejected PR is cheaper than a monolith that carried a bad assumption through the whole queue.

### Prompting the choice

Humans can steer the shape directly. The strongest levers, in rough order of effect:

- **Name the shape or workflow.** "Do this inline", "use subagents to investigate", "run the goal workflow", or "write a custom workflow for this" is honored over the agent's own scoring.
- **State acceptance criteria.** Verbatim acceptance criteria make the objective provable, which both selects workflow execution and pins the immutable contract that `goal`/`ralph` reviewers enforce.
- **State the loop.** "Iterate until tests pass", "review and fix until approved" — loop wording is a hard workflow signal and defines the stop condition.
- **State the evidence.** Asking for a PR, a QA video, test output, or reviewer sign-off tells the agent which gates the graph needs.
- **State the boundary.** "Work in a separate worktree", "don't create the PR yet", or "stop after implementation" separates the implementation loop from explicitly authorized final actions.
- **State the queue policy.** For factory requests, say how to split and gate the queue: "one workflow and PR per issue", "these three tickets depend on each other — do them in order in one run", "triage first and show me the dependency plan before dispatching", or "no more than three runs at a time". Absent a policy, the agent triages dependencies itself and defaults to independent per-item runs with per-item evidence.

Absent these levers, the agent applies the self-prompt and rubric above — so a prompt that mentions none of them is delegating the shape decision, not avoiding it.

## Atomic vs Claude Code Dynamic Workflows

Claude Code Dynamic Workflows and Atomic are trying to solve a similar class of problem: important software engineering work is too large for one agent pass, so the system should split the job into stages, run agents in parallel, verify the result, and keep enough state to finish long-running work.

Atomic's category is broader and more explicit: it is the loop engine for engineering work. The difference is where control lives and how much of the loop you can inspect, version, extend, and connect to your stack.

| Dimension | Atomic | Claude Code Dynamic Workflows |
| --- | --- | --- |
| Core idea | Open-source, repo-native loop engine for coding agents. You can run built-ins, tell the coding agent to use a workflow for a task, describe new loops in natural language for Atomic to scaffold dynamically, or version them as explicit TypeScript files. | Claude dynamically creates orchestration scripts for a task and fans work out to many parallel Claude subagents. |
| Best fit | Teams that want repeatable software engineering loops they can inspect, version, extend, connect to tools, and run across providers. | Claude Code users who want Claude to decide when a task needs a larger dynamic workflow and orchestrate it automatically. |
| Workflow control | The process is explicit: stages, inputs, handoffs, retries, artifacts, model choices, checkpoints, and human gates are part of the workflow definition. | The process is generated dynamically by Claude for the current task, with confirmation before the first workflow run. |
| Models | Model-agnostic. Atomic connects directly to supported API-key and subscription providers, and workflows can use model fallback chains. | Claude-first. Availability is tied to Claude Code, Claude plans, and Anthropic-supported API/cloud channels. |
| Extensibility | Built on Pi extensions: add tools, TUI, MCP, web access, intercom, skills, prompt templates, themes, custom providers, and packaged workflows. | Optimized for Claude Code's built-in dynamic orchestration experience rather than an open extension SDK you own in-repo. |
| Artifacts and auditability | Research docs, specs, logs, transcripts, reviewer notes, check output, and final summaries can live in the repo or workflow run directory. | Progress is saved and resumable, but the orchestration is primarily a Claude Code runtime behavior. |
| Cost/scale posture | You choose the graph and concurrency. Atomic can be small and deterministic, or broad when you intentionally design a larger workflow. | Designed for large fan-outs, including tens to hundreds of subagents; Anthropic notes it can consume substantially more tokens than a typical Claude Code session. |
