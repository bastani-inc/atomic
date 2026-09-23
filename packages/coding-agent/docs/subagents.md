---
title: "Subagents"
description: "Run focused Atomic child agents"
---

# Subagents

Atomic bundles `@bastani/subagents` for bounded specialist work in separate context, with the parent in control. Use one agent or parallel agents to locate code, analyze behavior, research references, reproduce failures, or simplify code when isolation or specialist expertise helps.

Keep interactive, exploratory, conceptual, and conversation-led work inline when direct user steering is more useful. Keep immediately blocking work local unless specialist expertise, context isolation, or an explicit delegation request makes a child worthwhile.

Delegate independent work you can overlap with your next steps, then continue without duplicating the child's task. Foreground observation is available when you need a specialist's result next. Otherwise, rely on completion notices rather than repeated short waits or status polls. Wait when the result becomes a dependency.

You do not need to install anything separately when you use `@bastani/atomic`.

Background subagents are supported. See [Background tasks](/background-tasks) for launch examples, the below-prompt status indicator, `/tasks`, shell output, cancellation, and completion notices.

## Where to go next

Subagents are focused child agents you delegate bounded work to. Read this page for natural-language use and execution behavior, then continue:

- [Custom subagents](/subagents/authoring) — define, scope, and configure your own.
- [Subagent reference](/subagents/reference) — fallback model resolution and reasoning levels.

## Start with natural language

Ask Atomic to coordinate subagents in plain language:

```text
Map the authentication flow with focused subagents before we change it.
```

```text
Run a parallel review composition: one pass for current behavior, one for failure modes, and one for existing patterns.
```

```text
Research the upstream library behavior online, then compare it with our local implementation.
```

Atomic decides whether delegation adds value, which specialist fits each bounded part, and whether the work should run as a single child, parallel group, or forked-context run. Multiple steps, files, tests, validation, or parallelism alone do not require a workflow; clearly delegated long-running autonomous work that needs durable stages, checkpoints, resumability, HIL, gates, retries, or loops is usually better served by a workflow.

## Browse agents

Open `/agents` to browse project, user, and built-in agents:

- Type to filter by name, description, or source. `/agents <query>` starts with a filter.
- Use arrows to select an agent and Enter to inspect its description, model and fallbacks, tools, definition path, and system prompt.
- Press Escape to return to the catalog, then to chat.

Browsing is read-only and never launches an agent.

The catalog is navigation, not an approval prompt. Leaving it open does not mark [Herdr](/herdr) blocked or hide active agent work; separate user-decision prompts still report their normal waits.

The catalog uses the same effective discovery rules as execution, so overridden definitions and disabled agents are not offered as separate launchable choices. Ask Atomic to create or modify an agent; the catalog does not change configuration.

## Let Atomic choose the child model

All builtin subagents default to `model: "auto"`. Atomic selects a model and reasoning effort from your available catalog using its shipped evaluation guidance before launching each child, favouring cheaper models for exploration and routine implementation and stronger ones for review and verification. You can also set `auto` on a custom agent or call. A concrete per-call model overrides the builtin default. Custom agents with no model keep their existing inheritance. See [Automatic model selection](/subagents/reference#automatic-model-selection) for configuration and failure handling.

## Subagent execution is non-interactive

Supported subagent launches start immediately without opening a preview/editor prompt or waiting for terminal input. This applies to single, parallel, forked, fanout, and prompt-template execution. Ask any necessary questions in the parent conversation before delegating.

Prompt-template delegation comes from the separately installed `pi-prompt-template-model` extension, whose `requestDelegatedRun` emits `prompt-template:subagent:request`. If that caller must survive an extension reload, import `registerPromptTemplateBridgeRequestSettlement` from `@bastani/subagents`, register it before the emit, and unregister it from the normal response, cancellation, or abort path. The hook rejects the caller only when the old bridge drops a stale response emit; normal completion still arrives through `prompt-template:subagent:response`. Atomic cannot register this opt-in for an out-of-tree emitter.

Subagents now run and return their results directly. Atomic does not infer acceptance gates from prompt wording, inject `acceptance-report` instructions into child prompts, parse or strip `acceptance-report` blocks, or reject completed child runs because changed-file, test, or review evidence is missing. Put any evidence or validation requirements directly in the task text you give the parent or child agent.

## Owner-bound task observation

Runtime-created session contexts bind single launches to their actual session or workflow-stage owner. Choose observation behavior with `wait`:

- Omitted `wait` returns an admitted observation with reason `default-background`.
- `wait: {kind: "background"}` uses reason `explicit`.
- `wait: {kind: "foreground", budgetMs: 30000}` opts into foreground-first observation. The omitted foreground budget is 30000 ms.

Use `subagent({action: "wait", id: taskId})` to observe an existing task in the same owner without restarting it. It uses the owner's observation budget unless explicitly overridden.

The agent may choose foreground-first or background observation for each authorized call without asking the user merely to select a mode. When a foreground observation expires, the returned task is still running. Wait for terminal completion before using its result in dependent work. See [Choosing how long to wait](/background-tasks#choose-how-long-to-wait) for shell and subagent defaults and the separate execution-timeout behavior.

User steering or an incoming Intercom ask/send admitted to the waiting parent releases its active subagent observations, including both foreground launches and `action: "wait"`. This applies to main chat and live workflow-stage chat. The parent can handle the queued message and reply without cancelling the child, closing its owner, or interrupting another owner's waits. User input yields with reason `input-needed`; Intercom coordination yields with reason `intercom-coordination`. The original task can be observed again after handling the message.

An Intercom yield keeps the execution alive, including queued parallel siblings. Completion appears in the owning chat with the outcome, error, and response excerpt. Unbound SDK callers retain their existing result fields.

Durable `ctx.tool` callbacks wait for tasks admitted inside their callback before checkpointing, even when the launching observation yielded. Session lifetime closure cancels session-owned work; stage generation closure, not pane detach or fallback session replacement, owns stage tasks.

## Supervisor coordination

Every builtin specialist includes `intercom` for live coordination, including read-only researchers and locators. `debugger` and `worker` also declare `contact_supervisor`; prefer it for supervisor requests when available. Explicit parent tool allowlists, exclusions, `noTools`, and disabled Intercom still apply—builtin declarations do not override caller restrictions.

In a parallel run, `intercom.ask`, `contact_supervisor({ reason: "need_decision" })`, and `interview_request` wait only in the requesting child. The supervisor answers with ordinary `intercom({ action: "reply", message: "..." })`; use `pending` and `replyTo` to select the exact question when several asks are pending. The correlated reply returns to the same child execution, with its context and run identity intact. Do not relaunch the requester or its siblings to deliver an answer.

`intercom.send` and `contact_supervisor` progress updates return after delivery without waiting for a reply. An exact-child Intercom handshake can release the parallel call's foreground observations so the supervisor can handle the message. This is not execution cancellation: active siblings keep running, queued siblings start once capacity is available, and worktrees stay owned until their children exit. Background calls use the same communication path without needing to release an observation.

To update a working child, use ordinary Intercom `send` or `ask` with its exact connected name or full session ID from `intercom list`. An admitted child registers with Intercom when its session starts, so it is listed and reachable while it works even if it never calls Intercom itself. Foreground and background children treat it as a priority interrupt: the child's current model call or cancellable tool is cancelled and the message is handled next in the same child execution, without relaunching its task or repeating the original prompt. Tools that ignore cancellation finish first, and completed side effects are kept. Multiple updates stay in arrival order. A reply to an incoming ask uses ordinary `intercom.reply`; this does not change the single-child parent-targeted handoff described below.

Targeted `kill` stops only the selected child and cannot be resumed. Explicit batch cancellation and session/workflow-stage lifetime closure still stop the intended owned children, including pending reply waits. A late or duplicate reply cannot revive a terminal child. Ordinary Intercom group restrictions and the authorized cross-group `contact_supervisor` route are unchanged.

Completed, failed, interrupted, and cancelled noninteractive children cannot answer new Intercom asks, even when their retained registration still says `idle`. Such asks fail immediately with an explicit terminal-child error; an admitted ask also fails if its child terminates before replying. Launch a fresh child with the required context for follow-up work. This does not restrict live interactive idle sessions or workflow-stage post-mortem conversations, and does not change `send` delivery semantics.

### Peer coordination

Children do not have to route everything through the supervisor. Children launched in one parallel set, or with the same explicit `group`, share an Intercom group, and children launched by a workflow stage inherit that stage's invocation group. A child can run `intercom({ action: "list" })` to see live siblings and use ordinary `send` or `ask` with them directly: a locator hands file paths to the analyzer, two writers agree who owns which files or who runs the shared test suite, a debugger reuses a sibling's verified reproduction, or one reviewer challenges another's finding with evidence before each returns its own verdict. `contact_supervisor` stays reserved for supervisor decisions, and ordinary Intercom group restrictions still apply.

Peers do not coordinate spontaneously. When related work runs in parallel, name the peers and the expected exchange in each task prompt, keep it bounded, and require each child to return its own complete result rather than deferring to a sibling. Scope, product, and architecture decisions still go to the supervisor. Peer asks and one blocking supervisor request can wait concurrently in the same child; mutual asks work as long as both children process inbound work. The `intercom` skill (`/skill:intercom`) has copy-paste peer patterns.

### Single-child handoff

A claimed parent-targeted blocking request ends a single child and returns its question, attachments, agent identity, and `[TASK_CONTEXT]` through the parent's `subagent` call. Start a fresh child with the answer and handoff. In parallel runs and collected sibling launches, the requesting child instead stays alive and continues its ongoing execution after receiving the supervisor's reply.

The handoff explicitly tells the parent to start a fresh child with a normal launch such as `subagent({ agent: "worker", task: "[TASK_CONTEXT] ... Continue with this supervisor answer: ..." })`. The new child receives a new run identity. Completed, interrupted, and parent-question children are terminal for continuation; a prior run ID cannot revive one.

## Foreground supervisor coordination

See [Supervisor coordination](#supervisor-coordination) for parallel requests and [Single-child handoff](#single-child-handoff) for claimed single-child requests.

## Migration from acceptance gates

If you have older subagent calls or custom agents that used the removed gate fields:

- Remove `acceptance` properties from `subagent()` calls, task entries, and parallel task items. Atomic no longer reads these fields.
- Remove `completionGuard: false` from agent frontmatter and custom agent definitions. The no-mutation completion guard no longer exists, so the override has no effect and management rewrites strip it.
- Move validation, command, evidence, review, or residual-risk requirements into the natural-language task text passed to the parent or child agent.

## Bundled agents

Atomic currently bundles these agents from `@bastani/subagents`:

| Agent | Use it for | Edit files? |
|---|---|---|
| `codebase-locator` | Find relevant files, directories, tests, configs, and docs for a topic. | No |
| `codebase-analyzer` | Explain how specific code works and trace data flow with file references. | No |
| `codebase-pattern-finder` | Find similar implementations, conventions, and test examples to model after. | No |
| `codebase-research-locator` | Locate prior `research/` and `specs/` documents related to the task. | No |
| `codebase-research-analyzer` | Extract decisions, constraints, and still-relevant conclusions from prior local docs. | No |
| `codebase-online-researcher` | Research official docs, ecosystem behavior, and open-source source references online; it may persist reusable research notes. | Research notes only |
| `debugger` | Reproduce a concrete failure, prove its root cause, apply the smallest in-scope fix, and rerun the failing scenario. | Yes |
| `code-simplifier` | Simplify recently changed code under its behavior-preservation “doors” rubric. | Yes |
| `worker` | Implement an approved task or handoff, validate the narrow change, and escalate product, architecture, or scope decisions to its supervisor. | Yes |

Every bundled agent uses `model: "auto"`, without a pinned fallback chain. To pin a role, set `subagents.agentOverrides.<name>.model` in user or project settings, or pass a concrete `model` on one call. To restrict automatic choices, use `modelConstraints`, for example `{ "allowedEfforts": ["high"] }`. Routing and execution fallback do not change your main-chat model.

Read-oriented agents inspect and report. `debugger`, `code-simplifier`, and `worker` can edit files, so give them an explicit scope and validation target. The debugger should apply and validate an in-scope fix, not stop at a proposed patch.

## Review compositions

Atomic does not bundle a single generic review agent. Instead, compose specialists with distinct angles and let the parent session synthesize their findings before applying any fix.

Common review angles:

| Angle | Specialist pattern |
|---|---|
| Current behavior and regressions | `codebase-analyzer` inspects the changed flow and cites file/line evidence. |
| Failure modes | `debugger` runs in inspect-only mode to reproduce or reason about likely failures without editing. |
| Fit with project conventions | `codebase-pattern-finder` compares the patch with existing local examples. |
| Prior decisions | `codebase-research-locator` finds relevant docs, then `codebase-research-analyzer` extracts applicable constraints. |
| External API or library conformance | `codebase-online-researcher` checks authoritative sources and version-specific behavior. |

Example request:

```text
Review the current diff with fresh-context specialists: analyze correctness, inspect failure modes without editing, and compare the implementation to existing patterns. Synthesize only issues worth fixing now.
```

Compose those review and research passes with the `subagent` tool. Treat them as parent-side recipes, not bundled slash commands.

## Foreground work and control

Explicit foreground-first observations wait for the child until it settles or the observation yields. The child continues after a yield; owner-bound calls without `wait` use background observation by default.

Natural-language examples:

```text
Run the local research scan.
```

```text
Show me the current subagent status.
```

Tool examples:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references.", wait: { kind: "foreground", budgetMs: 30000 } })
```

Use `subagent({ action: "kill", id: "<task-or-run-id>" })` to terminally stop a live child. Killed children cannot be resumed; launch a fresh child with an explicit context handoff for follow-up work. The former `interrupt` action is no longer accepted. Replace subagent calls using `action: "interrupt"` with `action: "kill"`. Workflow controls use `pause`; host cancellation APIs are unchanged.

Cancelling the parent turn stops a running foreground child. This is terminal cancellation, not completion or a retryable failure. Atomic returns labelled partial findings from the run's modified `progress.md`, the last assistant text, or a cancellation notice with available artifact paths. Parallel siblings do not each receive duplicate copies of shared progress.

Use the returned task or run ID for status and kill. Neither action revives completed work. Expand status cards to see every child, full paths, task, parent, and any recorded termination cause; status inspection does not start work.

When a workflow stage closes, it cancels its remaining children and suppresses their late findings. Already-submitted Intercom sends are not retracted, so a transport acknowledgement is not proof that a finding appeared in parent chat. Deliberate post-mortem stage chat remains separate.

Live progress and completed results show each step's resolved model ID and effective reasoning level, including after a model fallback; parallel steps keep their metadata separate. Fast inference is part of the model ID, so an agent pinned to a fast variant renders it directly — `codebase-analyzer (openai-codex/gpt-5.6-sol-fast · thinking medium)` — with no separate `fast` badge. Select fast inference in an agent definition's `model` and fallback model fields, for example `openai-codex/gpt-5.6-sol-fast:medium`; normal and fast IDs stay distinct fallback candidates and distinct records. See [Providers](/providers#fast-models) for which providers publish fast variants and what each one sends upstream.

Owner-task rows, status cards, foreground result receipts, and background completion cards retain these settings too. Background launch receipts include the concrete model and known, capability-clamped reasoning level selected at admission, including inherited defaults, without waiting for child session startup. A launch receipt remains a snapshot; inspect `/tasks` for later session resolution or fallback changes. Settings that are not yet resolved remain unavailable rather than being guessed from the parent's display. Completion metadata is persisted with the notification so it remains visible when replaying chat history.

## Task inspection

Hosts with an owner task store expose `/tasks` and `/tasks <id>` for background agents and shells, including their retained terminal results. Foreground-only work is excluded. Enter opens detail; arrows select an explicit action. Cancel asks for confirmation of the selected task. Terminal tasks retain transcript inspection but omit foreground, cancellation, and stdin actions. Escape returns from detail or stdin before returning to the composer.

`/tasks` appears in slash-command autocomplete. The inspector groups agents and shells with counts, status symbols, and a highlighted selection. Task descriptions lead; the selected row shows secondary activity and tool counts. The header and footer remain visible in ordinary terminal sizes, with a compact fallback for short terminals.

The list opens as a compact inline widget, like the `/workflow connect` picker. Detail, transcript, input, and stop-confirmation pages are fullscreen; returning to the list preserves selection. Every agent row includes its resolved model and reasoning level when available, including completed background tasks.

While `/tasks` or its fullscreen transcript/detail view is active, Escape navigates back or closes that view; it does not cancel a pending `ask_user_question`. The questionnaire waits out of the way and returns with its selection intact after task navigation closes. With no task view active, Escape cancels the questionnaire normally.

In the default isolated CLI, background subagents continue running after their launch observation returns. The engine publishes a compact task-status indicator below the prompt box, without task rows or activity previews. Run `/tasks` to open the list and inspect individual tasks; task updates never open it automatically. Completed tasks leave the live indicator and remain available in completion cards and `/tasks`. Inspecting does not restart work or create a second task owner. Top-level model bash commands use this owner on POSIX and native Windows; native Windows PowerShell is also owner-bound. Commands inside subagent sessions retain their existing execution path. See [Background shells](/background-tasks#background-shells) for platform support and the separate execution timeout.

Transcript inspection uses a dedicated scrolling view with pinned identity, position, and controls. Retained child messages use the normal message renderers, excluding hidden reasoning and inline images. Missing capture is reported as `Transcript unavailable`; metrics never substitute for missing messages. Arrows scroll, PageUp/PageDown moves one viewport, and PageUp at the top loads earlier retained history. Home/End jumps within loaded history.

Live transcripts refresh streaming text and tool results without reopening. Earlier pages remain anchored, and leaving the view does not affect execution.

Detail views pin task identity, state, available metrics, and the selected action while PageUp/PageDown scrolls the body. Recent activity shows up to five retained tool actions; errors and input requests appear explicitly. Left returns to the previous view. `x` requests cancellation without bypassing confirmation or configured task bindings. Shell inspection shows a bounded output tail with omission markers.

After a confirmed `x` stop settles, the owning chat receives a visible **stopped** notification and the parent model receives the stop context, even if the child returns no final message. Repeated stops do not duplicate notifications or replace an already-recorded terminal result. Closing the owner still suppresses late completion delivery.

## Orchestrator model and group policy

Atomic applies the same delegation policy to any parent chat or workflow stage that orchestrates subagents. A named agent uses the model and fallback sequence declared by its agent definition, so the orchestrator normally omits the subagent tool's explicit `model` argument. An override needs either the user's exact model request or a documented task-specific reason recorded before launch; model diversity alone is not enough.

If an agent declares no model or fallback policy, the orchestrator consults the role guidance in [Model selection](/models/model-selection) and the measured per-evaluation scores in [Evals](/models/evals), then calls `workflow({ action: "models" })` when that tool is available. It may pin only a returned `fullId` and may add a thinking suffix only when the model entry lists that level. When the catalog tool is unavailable, the catalog is empty, or no catalog model matches the documented evidence and role constraints, the child stays unpinned and the orchestrator reports the limit instead of inventing a model or inspecting credentials.

Each workflow invocation automatically receives one stable, non-`"default"` Intercom group as typed admission policy. Its stages and delegated children carry that group across single, parallel, and follow-up work unless a call explicitly overrides `group`. Outside workflows, children inherit the launching session's resolved group. This isolates workflow runs from unrelated runs and the main chat while `contact_supervisor` retains its authorized cross-group route.

## Context and execution modes

Subagents can run with fresh or forked context:

- `context: "fresh"` starts a separate in-process child session with only the task and selected agent context.
- `context: "fork"` creates a real branched child session from the parent session leaf. It fails fast if the parent session cannot be forked; it does not silently downgrade to fresh context.

For adversarial review or research, prefer fresh context so the specialist inspects the repository directly. Use forked context when a writer needs the parent conversation history in a separate branch.

For parallel implementation work, `worktree: true` can give each child an isolated git worktree so concurrent edits do not clobber each other.

Observation yields do not release these worktrees. Cancelling a queued child before it starts, or closing the session or workflow-stage owner, still allows the batch's worktrees and branches to be removed after the remaining executions finish. Live children's changes stay in place until then; Atomic captures worktree diffs before cleanup.

Fresh children inherit the invoking session's SDK configuration, resource-discovery inputs, model/auth runtime and host callbacks. Child tool selections can narrow the parent's permissions but cannot restore disabled packages or excluded tools. Intercom has no mandatory bypass; a child without access receives no supervisor grant. Model fallback keeps the same inherited restrictions. See [SDK child configuration](/sdk#workflow-and-subagent-children).

Top-level parallel calls support up to 50 subagents after expanding each task's optional `count`. Two settings control the set:

- `parallel.maxTasks` defaults to 50 and can enforce a lower task limit.
- `parallel.concurrency` defaults to 3 and controls how many children run at once. Explicit configuration overrides the default; per-call `concurrency` takes precedence over configuration.

At most four turns per parent can run at once, even when a higher subagent concurrency is configured.

When one assistant response emits several sibling execution-mode `subagent` tool calls, Atomic collects that synchronous burst before starting a child and runs it as one indexed parallel set. Each original tool call still receives one result containing only the children it requested, and its live result, progress, control, and artifact updates are projected to that same route without sibling data. The TUI redraws the shared run as one aggregate parallel widget rather than retaining one widget per original call. A single call keeps its original SINGLE or PARALLEL mode, calls awaited in sequence remain separate runs, and management actions bypass collection. An execution call that arrives after a child has started still receives the existing in-progress rejection. Prefer one explicit `{ tasks: [...] }` call when planning parallel work; burst collection handles sibling calls emitted by a model.

For a collected burst, each call contributes its top-level `agent` task first and then its `tasks` entries in array order. Atomic preserves duplicates, expands `count` in place, and applies the configured task cap after flattening and expansion; the hard maximum remains 50. Each call-level `cwd` selects that call's agent-discovery scope and child base directory. A task-level `cwd` stays relative to that call base and changes only that child's execution directory, not agent discovery. This per-origin discovery rule applies only to collected sibling calls; an ordinary explicit `{ tasks: [...] }` call keeps one discovery scope from its top-level `cwd`. Per-call and per-task `group` values also stay with their originating children. Shared run options must match across every sibling call: `concurrency`, `worktree`, `context`, `share`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, and `agentScope`. A mismatch rejects the whole burst before any child launches and names the incompatible field.

For a collected `worktree: true` burst, every call-level `cwd` must resolve to the same path. That common path becomes the shared worktree root; differing origins reject the burst before launch, and any task-level `cwd` must still resolve to that root. Each projected caller result keeps shared worktree diff text and terminal control guidance while its child results and standard child-output sections remain route-local.

Use `group` on a call or task to select the child's [Intercom](/intercom) group. A named string joins that group; `true` creates one shared UUID group for a parallel set. Precedence is `explicit subagent group > inherited current-session group > config > "default"`. Workflow children inherit their invocation group. Children without Intercom access receive no group or supervisor channel. `contact_supervisor` can reach the authorized supervisor across group boundaries; ordinary Intercom remains group-bound.

Pending Intercom asks belong to the addressed session. A workflow child cannot inspect or answer its parent stage's pending asks, and sibling children keep separate pending lists.

Detached children remain owned by the workflow stage that launched them. When that stage completes, Atomic cancels every still-running owned child (single or parallel) with the existing parent-cancellation outcome (`status: "interrupted"`, `cause: "abort"`) and suppresses late findings and completion notifications instead of routing them to the parent/main chat. A detached child that finishes while its stage is still live notifies normally, and completing one stage does not affect children owned by other stages or sessions.

When a subagent call or parallel task uses a `cwd`, Atomic validates that working directory before starting the child runtime. Missing or non-directory paths are reported as `cwd` problems instead of lower-level runtime errors.

Single-agent calls also accept `reads: string[] | false`. Atomic prepends those files as read context for foreground execution through the same in-process session path. Relative entries resolve against the effective child `cwd` (including a relative top-level `cwd` resolved from the parent); absolute entries are unchanged. Invalid values fail before the child session starts.

Single-agent calls accept `progress: boolean` in foreground mode. `progress: true` creates a run-scoped `progress.md` under isolated subagent artifact storage and instructs the child to maintain it without writing `progress.md` into the child `cwd`; `progress: false` disables an agent's `defaultProgress`. When `progress` is omitted, the agent's default is inherited, except that inherited progress is suppressed for read-only tasks (`progress: true` still explicitly opts in). Foreground runs remove this run-owned progress storage after the child exits when `artifacts: false`, including children temporarily detached for intercom coordination. This is separate from `includeProgress: true`, which only includes detailed runtime progress telemetry in the final tool result and does not create or maintain a file.

```ts
subagent({ agent: "worker", task: "Implement the approved fix.", progress: true })
```

## Delegation and child boundaries

Delegation is exactly one level deep and cannot be configured. Children complete their assigned tasks directly; they cannot launch or kill other children. Children can still run background shells. Those shells appear in the parent's `/tasks`: the main chat's, or the current workflow stage's. See [Shells started by subagents](/background-tasks#shells-started-by-subagents). They may inspect definitions and status with `list`, `get`, and `status`; management-restricted children also cannot `create`, `update`, or `delete` definitions.

Child prompts omit parent orchestration artifacts and prior subagent control traffic. Tool availability does not grant delegation authority. The parent remains responsible for orchestration.

## Custom agents

Moved to [Custom subagents](/subagents/authoring#custom-agents).

## Fallback models

Moved to [Subagent reference](/subagents/reference#fallback-models).

## Reasoning levels

Moved to [Subagent reference](/subagents/reference#reasoning-levels).

## Related docs

- [Workflows](/workflows) for multi-stage reusable automation.
- [Intercom](/intercom) for cross-session messaging and supervisor escalation.
- [Skills](/skills) for reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) for user and project configuration.

## Owner-bound task projection

Moved to [Subagent reference](/subagents/reference#owner-bound-task-projection).
