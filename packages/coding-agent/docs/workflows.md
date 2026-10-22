> Atomic can help you create workflows. Ask it to turn a repeatable process into a tracked multi-stage workflow.

# Workflows

Atomic uses workflows to run executable engineering loops: reusable multi-stage automation with tracked stages, parallel branches, artifacts, human input, live status, checkpoints, and resumable background execution.

For model-tool launches, the router owns all semantic selection from neutral state — see [When to Use Workflows](#when-to-use-workflows). For deliberate definition authoring and composition, see [Choosing an Execution Shape](/workflows/reliable-design#choosing-an-execution-shape).

**Key capabilities:**
- **Tracked stages** - Name each step and inspect it in workflow status and graph views
- **Parallel branches** - Run independent research, review, or implementation branches concurrently
- **Context handoffs** - Pass summaries, artifacts, files, and schema-backed structured results between stages
- **Human input** - Pause for `ctx.ui.input`, `confirm`, `select`, `editor`, or custom TUI widget decisions during a run
- **Resumable control** - Pause, quit, resume, or connect to workflow runs
- **Intercom run notifications** - Deliver async run results and control notices (long-running, needs-attention, completed, failed) to a parent session over [Intercom](/intercom)
- **Artifacts** - Save large outputs to files instead of pushing everything through model context
- **Verification and gates** - Preserve evidence, run checks, and stop for human approval where reliability matters
- **Model fallback chains** - Retry important stages on fallback models when providers fail
- **Package distribution** - Ship workflows through Atomic packages, settings, or conventional directories

**Example use cases:**
- Well-defined autonomous jobs that benefit materially from durable execution state
- Long-running or background work with explicit completion criteria
- Codebase research with parallel local and external research stages
- Review/fix loops with independent reviewers and a synthesis stage
- Release planning with human approval gates
- Documentation audits that save findings as artifacts
- Multi-stage migrations, broad refactors, and validation/rollback plans
- Reusable team workflows distributed through npm, git, or project settings

## Choose your path

For deliberate definition authoring, start with the shipped builtins. If none fully fits, ask Atomic to design a task-specific workflow. Hand-write and maintain custom TypeScript once you are comfortable with Atomic, or when generated workflows do not meet the need.

Generated and hand-written workflows use the same runtime definition. Dynamic and custom describe how you author them, not incompatible runtime types. Model-tool launch selection remains router-owned.

Prefer composing builtin definitions with `ctx.workflow(...)` over copying or rebuilding their prompts, graphs, reducers, and gates.

1. [Builtins and dynamic workflows](/workflows/builtins) — choose a shipped workflow, then generate a task-specific definition when needed.
2. [Custom authoring](/workflows/authoring) — learn the TypeScript shape and build your first maintained workflow.
3. [Reliable design](/workflows/reliable-design) — design contracts, context, topology, gates, loops, and handoffs.
4. [Operations](/workflows/operations) — run, inspect, steer, pause, resume, and configure workflows.
5. [API reference](/workflows/api-reference) — look up definitions, contexts, options, results, and programmatic APIs.

For checking changes and sharing results in PRs, see [Verification and evidence](/workflows/verification). For general desktop, browser, and terminal work, including creative workflows, see [Computer use](/computer-use).

## When to Use Workflows

The agent decides whether a workflow fits. Non-trivial work with structure and a verifiable objective runs as a workflow unless you ask for inline execution: implementation, bug fixes, debugging, migrations, multi-file changes with validation, and requests phrased as "repeat until" or "fix until green". Brainstorming, discussion, unclear goals, tiny low-risk answers or edits, or an explicit request to work inline, quickly or without a workflow stays inline. To launch, inspect the input contract with `workflow inputs`, then call `workflow run` with the registered workflow name and inputs. Ask only for genuinely missing information.

Safety, authorization, testing and evidence requirements remain in force. For an active user-requested switch to inline, safely hold/stop the affected run and reconcile completed work and in-flight effects before continuing without duplicates. User `/workflow` commands launch directly; authored `ctx.workflow(...)` remains internal composition.

```ts
workflow({ action: "inputs", workflow: "fan-out-and-synthesize" })
workflow({ action: "run", workflow: "fan-out-and-synthesize", inputs: { prompt: "Map the repository by subsystem" } })
```

For deliberate definition authoring, do not force-fit a builtin: a builtin that matches 60% of the task and fights the other 40% is worse than a small custom graph. Discover named builtin, project, user, and package workflows; or author a task-specific TypeScript `workflow({...})` with normal coding tools when the definition needs richer branching, dynamic fan-out, artifacts, structured outputs, child workflows, human input, gates, retries, or loops.

Rich custom workflows can compose the [common workflow patterns](/workflows/reliable-design#common-workflow-patterns): classify and branch at runtime, fan out and synthesize artifacts, run worker/verifier/reducer repair cycles, generate and filter or tournament-rank candidates, and loop until explicit evidence says the work is done. Workflow definitions are composable TypeScript modules — see [Workflow Composition](/workflows/authoring#workflow-composition). Atomic can write the definition, reload workflow resources, and run it for the current task; the workflow tool has no create action.

For authored graphs, design elapsed time using [runtime-aware scheduling and estimates](/workflows/reliable-design#runtime-aware-scheduling-and-estimates). Use available CI/test history to place focused checks at slice boundaries, defer redundant full-suite runs to the final candidate, and overlap independent work with CI without bypassing required gates. Before launching, share a brief duration estimate without confidence labels. Inherit existing budget limits without asking for a budget choice before each launch, and override only limits the user explicitly requests. Preserve existing approval gates. An estimate is not a budget or guarantee. At completion, compare the estimate with actual elapsed time.

| User need | Use |
|-----------|-----|
| Run, inspect, connect to, pause, quit, resume, or check status for an existing workflow | `/workflow ...` or `workflow({ action: ... })` |
| Run repository-wide research | Compose `fan-out-and-synthesize` with repository-focused branches, artifact outputs, and a synthesis barrier, or author a smaller task-specific research workflow. |
| Run an implementation/review loop | Author a task-specific worker → fresh verifier → reducer loop with explicit evidence, repair bounds, and stop conditions. |
| Create or edit reusable automation | A TypeScript workflow definition exported from `workflow({...})` |
| Make a workflow robust | Design the stage graph, context handoffs, artifacts, validation gates, model fallbacks, and human approval points before coding |

## Provider rate limits

Workflow model chains skip accounts that are cooling down after a 429. If all eligible candidates are cooling down, the stage waits for the earliest reset instead of exhausting the chain. Atomic honors `Retry-After` seconds or HTTP dates when the provider exposes them, otherwise it uses exponential backoff with jitter, up to 60 seconds. A longer server deadline is still respected.

`retry.enabled` and `retry.maxRetries` in [settings](settings.md) bound retries for each candidate, including retries made within its session. Falling back does not grant the same candidate a fresh retry allowance. Disabling retries still allows an unused fallback, but does not retry a failed candidate. Waits count toward the workflow and structured-output time limits, and pause, quit, and cancellation remain available.

The model-facing `workflow status` listing identifies stages waiting on a cooldown. Stage details and task results include `rateLimits`, with the configured provider ID, `rateLimitCount`, `cooldownUntil`, and `waitingUntil` while the fallback scheduler waits. Deadlines are Unix timestamps in milliseconds. Counts are shared across the process, not summed per stage.

For high concurrency, an SDK host or workflow can set an optional shared request budget before starting model work:

```ts
import { configureProviderRequestBudget } from "@bastani/atomic";

configureProviderRequestBudget("openai-1", { maxRequests: 30, intervalMs: 60_000 });
configureProviderRequestBudget("openai-2", { maxRequests: 30, intervalMs: 60_000 });
```

Each budget limits starts in a rolling time window. OpenAI, Anthropic, Azure, Mistral, pi-messages, and explicit Codex SSE transports count HTTP attempts, including their internal retries. Other transports count model-stream starts; their own internal retries are not counted separately. Budgets do not limit tokens or simultaneous streams.

Waiting for a budget slot does not consume an OpenAI or Anthropic SDK HTTP timeout. Workflow and structured-output time limits still include that wait.

Pass `undefined` as the second argument to remove a budget, for example `configureProviderRequestBudget("openai-1", undefined)`. Configure budgets on each process start; do not put this setup behind a replay-cached `ctx.tool` call.

Use the exact configured provider IDs. Separate provider IDs for separate accounts have independent limits; multiple IDs pointing to the same account do not share a limit. Cooldowns, counters, and budgets are process-local and reset when Atomic restarts. Recorded stage statistics remain available, but they do not restore a live limiter or coordinate separate Atomic processes.
