---
title: "Subagents"
description: "Run focused Atomic child agents"
---

# Subagents

Atomic bundles `@bastani/subagents` for bounded specialist work in separate context, with the parent in control. Use one agent or parallel agents to locate code, analyze behavior, research references, reproduce failures, or simplify code when isolation or specialist expertise helps.

Keep interactive, exploratory, conceptual, and conversation-led work inline when direct user steering is more useful. Keep immediately blocking work local unless specialist expertise, context isolation, or an explicit delegation request makes a child worthwhile.

Delegate independent work you can overlap with your next steps, then continue without duplicating the child's task. Every subagent runs in the background: rely on completion notices rather than repeated short waits or status polls, and wait with `subagent({ action: "wait", id })` when a child's result becomes a dependency.

You do not need to install anything separately when you use `@bastani/atomic`.

Every subagent runs in the background. See [Background tasks](/background-tasks) for launch examples, the agent panel below the prompt, `/tasks`, shell output, cancellation, and completion notices.

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

Atomic decides whether delegation adds value, which specialist fits each bounded part, and whether the work should run as a single child, parallel group, or forked-context run. For multi-step work, the parent can launch children from codemode and continue from their completion notices.

## Browse agents

Open `/agents` to browse project, user, and built-in agents:

- Type to filter by name, description, or source. `/agents <query>` starts with a filter.
- Use arrows to select an agent and Enter to inspect its description, model and fallbacks, tools, definition path, and system prompt.
- Press Escape to return to the catalog, then to chat.

Browsing is read-only and never launches an agent.

The catalog is navigation, not an approval prompt. Leaving it open does not mark [Herdr](/herdr) blocked or hide active agent work; separate user-decision prompts still report their normal waits.

The catalog uses the same effective discovery rules as execution, so overridden definitions and disabled agents are not offered as separate launchable choices. Ask Atomic to create or modify an agent; the catalog does not change configuration.

## Let Atomic choose the child model

All builtin subagents default to `model: "auto"`, which runs your default model (the one you last chose with `/model`) at its default thinking level, or the launching session's model when no default model is configured. You can also set `auto` on a custom agent or call. A concrete per-call model overrides the builtin default. Custom agents with no model keep their existing inheritance. See [Automatic model selection](/subagents/reference#automatic-model-selection) for configuration and failure handling.

A child never waits on a model it cannot use. A model in a child's fallback chain whose provider has no credentials is skipped before the child starts, listed in its model attempts. A provider that rejects its credentials during the task is not asked again; the child moves to its next fallback of another provider. When no model in the chain has credentials, the launch fails at once with an error naming each model and the provider it lacks. See [Fallbacks and credentials](/models#fallbacks-and-credentials).

## Subagent execution is non-interactive

Supported subagent launches start immediately without opening a preview/editor prompt or waiting for terminal input. This applies to single, parallel, forked, fanout, and prompt-template execution. Ask any necessary questions in the parent conversation before delegating.

Prompt-template delegation comes from the separately installed `pi-prompt-template-model` extension, whose `requestDelegatedRun` emits `prompt-template:subagent:request`. If that caller must survive an extension reload, import `registerPromptTemplateBridgeRequestSettlement` from `@bastani/subagents`, register it before the emit, and unregister it from the normal response, cancellation, or abort path. The hook rejects the caller only when the old bridge drops a stale response emit; normal completion still arrives through `prompt-template:subagent:response`. Atomic cannot register this opt-in for an out-of-tree emitter.

Subagents now run and return their results directly. Atomic does not infer acceptance gates from prompt wording, inject `acceptance-report` instructions into child prompts, parse or strip `acceptance-report` blocks, or reject completed child runs because changed-file, test, or review evidence is missing. Put any evidence or validation requirements directly in the task text you give the parent or child agent.

## Background launches and waiting

Each child belongs to the session that launched it. Every launch runs in the background: the call returns once each child is admitted, with an observation whose reason is `default-background` and the child's task id. The child keeps running, is listed below the prompt and in `/tasks`, where you can open its chat and message it, and reports by a completion notice when it ends.

A launch that still passes `wait`, as older saved prompts, agents or workflows may, runs in the background too. When it asked for `wait: { kind: "foreground" }`, the first line of its result says that the foreground wait was removed and how to wait instead.

A running child sends the parent a [task heartbeat](/background-tasks#task-heartbeats) every 15 minutes by default, with its current tool call, time since its last activity, and turn, tool-call and token counts. Set `heartbeatMs` on the call, or on a `tasks` entry, to change that child's cadence; `0` turns it off.

When you issue several single-agent calls in one turn, each returns only its own task. Background completions appear as visible notices and notify the parent agent.

These calls share the `concurrency` limit, or the configured subagent parallel limit when omitted. A returned launch or an ended wait does not free a running child's slot; queued children start when execution capacity becomes available.

Use `subagent({ action: "wait", id: taskId })` to wait for an existing task in the same owner without restarting it. It waits up to the owner's agent wait budget (`tasks.wait.agentBudgetMs`, 30 seconds by default) unless `budgetMs` overrides it. Pressing Esc ends the wait at once and ends the turn. Either way the child keeps running, and its completion notice still arrives when it finishes.

A background launch result names the child's Intercom target as `intercomTarget` (for example `subagent-worker-1a2b3c4d-1`), and `subagent({ action: "status", id: taskId })` names it on the task's record too. Each task id maps to exactly one target, so send to that name rather than deriving one from the task id.

Until a child starts its first turn, `status` reports where its start is, never just `running`. A line such as `task-1-0-7 (subagent-worker-1a2b3c4d-1) is starting: creating its agent session for 95s (120s since launch, attempt 1 of 2)` comes first, and the record carries a `start` field with the step and how long it and the start have run. The steps are opening its session, loading its resources, waiting for a resource-admission permit, creating its agent session, registering on Intercom, and dispatching its task. `/tasks` and task heartbeats show the step as the task's current action. A start that runs out of its start budget (`sessionStartTimeoutMs`, 5 minutes by default) is shown as `stalled` with the step it stalled in and is retried once, as soon as the stalled start has let go of its session. If the retry runs out of its budget too, the task fails with `Subagent did not start: its start stalled <step> after <N>s and was retried once; the retry stalled <step> after <M>s`, and the launching session gets the failure notice. A stalled start that still holds its session after half its budget (at most 30 seconds), for example because an extension's `session_start` never returns, is not retried: the task fails with its timeout and says why.

When a task has settled, `action: "wait"` and `action: "status"` show its output after the task record: up to 16 KB of text, a `Full output:` path to a private copy of the complete result, and a `Requested output:` line naming the `output` file you asked for (background runs included). Atomic keeps the 256 most recent private copies across sessions in a temporary directory readable only by you and removes them when it exits. After a copy expires, a retained task can still show a short answer that matches text in its transcript. If the exact output cannot be recovered, `wait` and `status` point you to the earlier result or `/tasks <id>`. With `outputMode: "file-only"` the text is only the saved-file reference, and the private copy holds the file's contents.

The agent decides for each call whether its next step needs the child's result, without asking the user to choose. When a wait ends at its budget, the task is still running. Wait for terminal completion before using its result in dependent work. See [Choosing how long to wait](/background-tasks#choose-how-long-to-wait) for shell and subagent defaults and the separate execution-timeout behavior.

User steering or an incoming Intercom ask/send admitted to the waiting parent ends its active `action: "wait"` calls. The parent can handle the queued message and reply without cancelling the child, closing its owner, or interrupting another owner's waits. User input yields with reason `input-needed`; Intercom coordination yields with reason `intercom-coordination`. The original task can be observed again after handling the message.

An Intercom yield keeps the execution alive, including queued parallel siblings. Completion appears in the owning chat with the outcome, error, and response excerpt. Unbound SDK callers retain their existing result fields.

Closing the session stops its running children; reopening that session restores unfinished children from their saved sessions.

## Supervisor coordination

Every builtin specialist includes `intercom` for live coordination, including read-only researchers and locators. `debugger` and `worker` also declare `contact_supervisor`; prefer it for supervisor requests when available. Explicit parent tool allowlists, exclusions, `noTools`, and disabled Intercom still apply—builtin declarations do not override caller restrictions. A child whose tools leave out `read` or `search` gets one read-only tool, `session_history`, after compaction first clears its context, so it can recover from its own session's history and nothing else; see [Agents without read or search](/compaction#agents-without-read-or-search).

`intercom.ask`, `contact_supervisor({ reason: "need_decision" })`, and `interview_request` wait only in the requesting child, in a single or a parallel run. The supervisor answers with ordinary `intercom({ action: "reply", message: "..." })`; use `pending` and `replyTo` to select the exact question when several asks are pending. The correlated reply returns to the same child execution, with its context and run identity intact. Do not relaunch the requester or its siblings to deliver an answer.

`intercom.send` and `contact_supervisor` progress updates return after delivery without waiting for a reply. A child's message reaches its busy supervisor through an exact-child Intercom handshake. Nothing is cancelled: active siblings keep running, queued siblings start once capacity is available, and worktrees stay owned until their children exit.

To update a working child, use ordinary Intercom `send` or `ask` with its exact connected name or full session ID from `intercom list`. An admitted child registers with Intercom when its session starts and before its first turn, so it is listed and reachable while it works even if it never calls Intercom itself. If the broker is briefly unreachable then, the child's start waits in its `registering on Intercom` step and retries until it registers or its start budget runs out. A child's `contact_supervisor` reaches the session that launched it, by the Intercom id that session registered under. If the broker refuses the child's supervisor authorization, the child keeps offering it for up to 30 seconds, since a broker restart refuses it until the launching session has reconnected. It keeps the authorization once that session is back. If the authorization is still refused after that, for example because it was never valid, the child still starts without it. `contact_supervisor` then reports that the authorization was refused, and the child offers it again the next time it connects to Intercom. Children handle it in the same child execution, without relaunching the task or repeating the original prompt, according to the sender's `delivery` option. Messages from sibling children, the supervisor, and you all work the same way:

| `delivery` | When a busy recipient gets it | Use it for |
|---|---|---|
| `"steer"` (default) | After its current tool calls finish. Its work is never cancelled. | Ordinary coordination, findings, and updates |
| `"followUp"` | Only after it finishes and stops | Low-priority notes, or anything meant for "after you're done" |
| `"interrupt"` | Immediately. Its current model call or cancellable tool call is cancelled, then the message is handled next. | An urgent correction or a stop order |

The sender chooses `delivery` for each message; override the default by urgency. It applies to every sender, including peers, the supervisor, and you. With `"interrupt"`, tools that ignore cancellation finish first, and completed side effects are kept. Multiple updates stay in arrival order. A reply to an incoming ask uses ordinary `intercom.reply`.

[Run control](#run-control) (`pause`, `quit`) stops only the selected child, and it stays resumable. Explicit batch cancellation stops the selected children for good, including pending reply waits. Closing or switching away from a session also stops its children, but they stay resumable, as described next. A late or duplicate reply cannot revive a terminal child. Ordinary Intercom group restrictions and the authorized cross-group `contact_supervisor` route are unchanged.

If Atomic exits or crashes while background subagents are still running, they come back when you reopen the session: each unfinished child is relaunched from its own saved session with a continuation prompt. The same applies when you switch away from the session with `/new`, `/resume` to another session, or `/fork`: its running children stay resumable and are restored when you reopen it. A restored child first receives the steering and follow-up messages it had queued and not read, once, in order. A restored child keeps its Intercom name and group and gets a fresh supervisor authorization, so you can keep messaging it. It continues on its own model and thinking level, not on ones you switched to since, and runs on the agent definition it was launched with, even when a project agent of the same name would now shadow it, and a child launched with `context: "fork"` keeps its Intercom bridge instructions under `intercomBridge.mode: "fork-only"`. Messages sent to it by any session in its group wait for it, from the moment the reopened session starts, until it has been restored; see [Intercom operations](/intercom/operations#connection-states-and-recovery). Only children that were still running are relaunched automatically; a child that finished, was paused or quit, or was cancelled for good stays as it was, and you can continue a resumable one with `resume`. Only the session that launched a child restores it: a fork of that session (`/fork`, `atomic --fork`) copies the child's record but never relaunches or reports it. If a child cannot be restored, for example because its session file or agent definition is gone, the agent gets a notice that it is gone. The notice names the child's agent, task, run and child ids, working directory, worktree and branch, and saved session, gives the `subagent` call that launches it again when its task was recorded (in its worktree when it had one, so it continues from that work), or says where to find the launching call when it was not, and the `git` commands that show what it left behind. That notice is given once: the child is then recorded as gone in the session, so later restarts neither retry the restoration nor repeat the notice.

A child's own session is saved next to its parent's session file when the parent has one. A parent in the default session database has none, so its children's sessions are saved under `~/.atomic/agent/subagent-sessions/<parent session id>/` and survive a reboot.

Completed, failed, interrupted, and cancelled noninteractive children cannot answer new Intercom asks, even when their retained registration still says `idle`. Such asks fail immediately with an explicit terminal-child error; an admitted ask also fails if its child terminates before replying. For follow-up work, [resume](#run-control) a resumable child or launch a fresh child with the required context. This does not restrict live interactive idle sessions, and does not change `send` delivery semantics. A message that reaches a child as it finishes is either answered before the child completes or refused with that terminal-child error, never accepted and left unanswered.

### Peer coordination

Peer-to-peer (swarm) coordination is the default. There are no limits on communication between agents; it is encouraged whenever you need to. The supervisor is not a message relay: relaying adds latency, loses detail, and fills the supervisor's context, while children that talk directly converge faster. Children launched in one parallel set, or with the same explicit `group`, share an Intercom group. A child can run `intercom({ action: "list" })` to see live siblings and use ordinary `send` or `ask` with them directly: a locator hands file paths to the analyzer, two writers agree who owns which files or who runs the shared test suite, a debugger reuses a sibling's verified reproduction, or one reviewer challenges another's finding with evidence before each returns its own verdict. `contact_supervisor` stays reserved for supervisor decisions, and ordinary Intercom group restrictions still apply.

Children coordinate spontaneously: they discover peers with `list`, broadcast findings, claim shared files or expensive steps, ask and answer each other, hand work along a chain, and debate as much as is useful, then each returns its own complete result rather than deferring to a sibling. Explicit user approval gates and authorization for destructive or external actions still apply. Peer asks and one blocking supervisor request can wait concurrently in the same child; mutual asks work as long as both children process inbound work. The `intercom` skill (`/skill:intercom`) has copy-paste peer patterns.

For example, three reviewers launched as one parallel set work as a swarm, and the parent reads their three final results:

```typescript
const peerRules =
  "Your siblings review the same diff. Run intercom list to find them, share every confirmed finding, " +
  "ask them whatever you need, and debate disagreements with evidence. Then return your own structured verdict.";

subagent({
  tasks: [
    { agent: "reviewer", task: `Review correctness of the auth changes. ${peerRules}` },
    { agent: "reviewer", task: `Review security of the auth changes. ${peerRules}` },
    { agent: "reviewer", task: `Review test coverage of the auth changes. ${peerRules}` },
  ],
});
```

### Scaling a swarm

Swarm size scales with the task. For very complex work, or when you ask for heavy parallelism, the agent can run hundreds or thousands of agents. They organize themselves into teams and coordinate peer-to-peer, like an organization, and useful behavior emerges from their exchanges rather than from one central plan.

These are the limits that apply:

- **Children per parallel set.** One set holds up to `parallel.maxTasks` children (default 1000, no hard cap). `parallel.concurrency` and `parallel.runningCapacity` (each default 1000) bound how many run at once per parent. For more than 1000, raise all three, as shown in [Context and execution modes](#context-and-execution-modes).
- **Nesting.** Subagent delegation is one level deep: only the parent launches children.
- **Teams.** Intercom groups have no member limit. Give each team its own `group` so its members coordinate internally. Team members can reach the parent across group boundaries with `contact_supervisor`.

For example, a parallel set can launch 1,000 children with the default limits. Lower `parallel.concurrency` to run fewer at once. Your provider rate limits and machine memory also limit how many children can work at once.

### Single-child handoff without a task host

An SDK session without a task host runs a single child directly, and its `subagent` call waits for it. There, a claimed parent-targeted blocking request ends the child and returns its question, attachments, agent identity, and `[TASK_CONTEXT]` through that call. The handoff tells the parent to start a fresh child with a normal launch such as `subagent({ agent: "worker", task: "[TASK_CONTEXT] ... Continue with this supervisor answer: ..." })`. The new child receives a new run identity. Every other child stays alive and continues its ongoing execution after receiving the supervisor's reply.

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

Every bundled agent uses `model: "auto"`, without a pinned fallback chain. To pin a role, set `subagents.agentOverrides.<name>.model` in user or project settings, or pass a concrete `model` on one call. Execution fallback does not change your main-chat model. A concrete `model` runs as named: the child falls back only to its agent's own `fallbackModels`, and otherwise fails with an error that names the model. See [Fallback models](/subagents/reference#fallback-models).

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

## From codemode scripts

When `codemode` and `subagent` are active, `tools.subagent()` launches the same background children as a direct call. It resolves at admission, **not** at completion. Children belong to the parent session, not the script: they keep running if it returns, throws, or times out. Each child sends its completion notice to the parent. A subagent cannot use its own script to delegate further.

```js
const { tasks } = await tools.subagent({
  tasks: [{ agent: "worker", task: "Check the examples" }, { agent: "worker", task: "Check the links" }],
  group: true,
});
store("checks", tasks);
return tasks;
```

A single `{ agent, task }` launch returns the same `{ action: "launch", tasks }` shape. Each admitted slot has `agent`, `state` (`admitted` or `queued`), a `taskId` for this attempt, a stable `childId`, and an `intercomTarget` when messaging is available. Children in the same group can message each other. A refused slot has `state: "refused"` and a `reason`; failures before admission can reject the whole call. Do not retry successful siblings.

- `list` returns executable `agents`; `get` with `agent` returns matching `definitions`. `models` returns the configured catalog, with `fullId`, `isCurrent`, and `availableThinkingLevels`. Creating, updating, and deleting definitions requires a direct tool call.
- `status` returns `children` launched by this session, including their state and an available `resumeCall`. Pass `id` for one child. After reopening the parent, rediscover its children this way instead of repeating a launch, even if the script failed before storing its receipt.
- `wait` takes a **task** id and optional `budgetMs` (the owner's agent wait budget, normally 30 seconds; `0` checks immediately). If the script reaches its own deadline first, the script ends and its wait is cancelled; the child continues running and sends its completion notice to the parent. An owner configured to wait indefinitely uses a 30-second default in scripts. An `outcome` of `settled` includes the child's `childId`, `result.status` and available output, and a `resumeCall` such as `{ action: "resume", id: "<child-id>" }` when the child completed, failed, or was paused or quit; `outputPath`, when present, points to the full output beyond the excerpt. `running` means observation yielded; ending a wait or interrupting its script does not stop the child.
- `pause` and `quit` take `id` or `all: true` for this session's children. `resume` takes `id` and an optional `message`; it continues the child's saved session and returns the new task id in `children`. Use `id`, not the legacy `runId` alias, from scripts.

For temporary worktrees, `status` can show `finishing` while `wait` still returns `running`. A `worktreeNote` on a status row or wait reply, or `worktreeNotes` on a stop reply, tells you when cleanup is pending or another child still holds the batch. Do not remove the directory while either is true. These notes are separate from the child's output.

## Waiting and control

A launch returns once its children are admitted. To use a child's result in the same turn, wait for it explicitly; the wait ends when the child settles, when its budget runs out, or when you press Esc, and the child keeps running in the last two cases.

Natural-language examples:

```text
Run the local research scan.
```

```text
Show me the current subagent status.
```

Tool examples:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references." })
subagent({ action: "wait", id: "<task id>", budgetMs: 120000 })
```

Use [run control](#run-control) to stop, hold, or continue a child.

Main chat and subagent chats show the same `∀` working line. Its changing verb is followed by elapsed time and a token count; `↑` means a request is waiting for content, and `↓` means content has arrived. Zero token counts stay hidden. A retry or a switch to a fallback model continues the same count from the turn's first request. Reopening the chat shows the current wait without restarting the clock. When the turn finishes, is interrupted or runs out of attempts, a dim row keeps its elapsed time and tokens until the next turn. A warning that a follow-up could not be delivered is separate: it does not mean the provider stopped trying.

Each launch shows `Agent(<agent> · <short task title>)` with its state, elapsed time and tokens. Elapsed time starts when the child is dispatched, includes session startup and retries, and stops when the child finishes, stops or is released. Queue time and cleanup do not count. Waiting silently or handing the conversation back for Intercom does not stop the clock. When a child wakes or resumes, its original launch card shows the elapsed time for the new run. A management hint appears only when the task can be selected. Ctrl+O expands the prompt, tool calls and result. Completion notices show the agent's name and first result line. If an older transcript is unavailable, expansion shows the full retained result and an unavailable-transcript message rather than an empty tool-call list.

Cancelling the parent turn ends its wait, never the child: a running subagent keeps running and reports by its completion notice. Stop a child with [run control](#run-control) or from `/tasks`. In an SDK session without a task host, whose `subagent` call waits for its children, cancelling the call stops them for good. Atomic then returns labelled partial findings from the run's modified `progress.md`, the last assistant text, or a cancellation notice with available artifact paths. Parallel siblings do not each receive duplicate copies of shared progress.

Use the returned task or run ID for status and run control. Expand status cards to see every child, full paths, task, parent, and any recorded termination cause; status inspection does not start work. Atomic keeps the in-process status of the 256 most recently finished subagent runs, as `/tasks` keeps the 256 most recently finished tasks; a run with a child still pending, running or continued is always kept. A child of an older run is no longer listed under its run's path, and still resumes with `subagent({ action: "resume", id })` from its saved session.

Live progress and completed results show each step's resolved model ID and effective reasoning level, including after a model fallback; parallel steps keep their metadata separate. Fast inference is part of the model ID, so an agent pinned to a fast variant renders it directly — `codebase-analyzer (openai-codex/gpt-5.6-sol-fast · thinking medium)` — with no separate `fast` badge. Select fast inference in an agent definition's `model` and fallback model fields, for example `openai-codex/gpt-5.6-sol-fast:medium`; normal and fast IDs stay distinct fallback candidates and distinct records. See [Providers](/providers#fast-models) for which providers publish fast variants and what each one sends upstream.

Task details and run status retain the concrete model and known, capability-clamped reasoning level selected at admission, including inherited defaults. Inspect `/tasks` for later session resolution or fallback changes. Compact launch and completion blocks reserve space for the task, state, time and tokens instead of repeating model labels. Settings that are not yet resolved remain unavailable rather than being guessed from the parent's display. Completion notices persist model and reasoning metadata in their saved details but do not display a model line, including when replaying chat history.

### Run control

Use these `subagent` actions to control a child: `pause`, `resume`, and `quit`. `id` accepts the child id (`<runId>:<index>`), its task id, its Intercom name, or the run id of a run that launched one child.

```ts
subagent({ action: "pause", id: "<child-id>" })   // stop now; queued messages wait for resume
subagent({ action: "pause", all: true })          // every running child this session launched
subagent({ action: "quit", id: "<child-id>" })    // graceful stop; stays resumable
subagent({ action: "quit", all: true })           // also covers already-paused children
subagent({ action: "resume", id: "<child-id>", message: "Focus on the failing test first." })
```

- **`pause`** stops the child's current turn and holds its queued steering and follow-ups in place; `resume` delivers them once, in order, before its own `message`. Intercom messages sent to a paused child wait until you resume it, as long as the same Atomic process keeps running.
- **`quit`** stops the child gracefully, including one that is already paused. The session that launched the child can resume it later.
- A paused or quit child is **paused · awaiting resume**. The `pause` or `quit` result and the parent's completion notice say so and name the exact call, `subagent({ action: "resume", id: "<child-id>" })`. The notice reads, for example, `Subagent worker quit · paused, awaiting resume: …` with `Stop reason: quit` (or `pause`); it never says the execution has ended. A child that completed or failed gets a notice that says the execution has ended and not to restart it merely to retrieve its result, then names the call that continues it, for example `Resume it with subagent({ action: "resume", id: "a760c0ec:0", message: "…" }) to continue it with a follow-up.`, and, when the notice knows it, the Intercom name the child takes messages under again once resumed. The `wait` and `status` output of a completed or failed child names the same call after its `Output of <task-id> (…):` header. Children cancelled for good get the `This execution has ended` notice without a resume call.
- `subagent({ action: "status", id: "<child-id>" })` (or its task id) reports a paused or quit child as `<agent> (<child-id>, <intercom-name>) quit · paused · awaiting resume` with its resume call, and `subagent({ action: "status" })` lists every such child under **Awaiting resume**. Both read the session's child records, so a quit child stays listed after Atomic restarts. It is not relaunched when the session reopens; it waits for `resume`.
- A parallel child still waiting for a free slot behind its concurrency limit can be paused or quit too, by id or with `all: true`. It then does not start when a slot frees; `resume` starts it on its original task, with `message`, if given, added after the task. This also works after Atomic restarts: the child starts as a new launch under the same child id, Intercom name, and group, with its original agent, task, working directory or worktree, model, thinking level, and skills. A child that inherited your model and thinking level keeps the ones you had when you launched it, even if you have switched since; if that model is no longer available, resume reports the child as gone instead of starting it on your current model. A child launched with `context: "fork"` starts on the copy of your conversation it was launched with; if that copy no longer exists, resume reports the child as gone instead of starting it without your conversation. A child that was still waiting for a slot when Atomic exited starts the same way when its session reopens.
- A resumed child of a parallel run, queued or not, waits for a free slot under that run's concurrency limit, as its original launch did. A paused or quit child holds no slot.
- **`resume`** continues the child from its own saved session, under the same child id, Intercom name, and group, with fresh supervisor authorization. For a paused, quit, or interrupted child, `message` is delivered once as its next prompt, and after replying the child continues where it left off. For a completed or failed child, `message` is one fresh prompt in the same session, with nothing queued after it. Without `message`, the child is asked to continue where it left off, or to stop if its task is finished; this works for completed and failed children too. `all: true` is not accepted for `resume`.

Paused, quit, interrupted, completed, and failed children are resumable, including a paused child that you later quit. So are children whose session you closed or switched away from, whether Atomic exited or crashed, or you used `/new`, `/resume` to another session, or `/fork`; they are restored when that session reopens. These children are terminal, and `resume` returns an error that says why:

- **Killed**: cancelled for good by an owner or batch cancellation. Confirming a stop in the agent panel or `/tasks` quits the subagent resumably instead.
- **Gone**: it could not be restored after a restart.

An Intercom `send` or `ask` to a child that has no live session, because it completed, failed, was stopped or cancelled, does not return a bare `Session not found` while the session that launched it is connected. The sender gets an error that says how the child ended and names the call to make, for example `Subagent "subagent-worker-aabcf28b-1" completed and has no live session (recipient_completed). Its launching session can continue it with subagent({ action: "resume", id: "aabcf28b:0", message: "<your message>" }).` A send made in the moment a child's session closes waits up to 20 seconds for that answer, and is delivered if the child reconnects instead. See [Subagents with no live session](/intercom/reference#subagents-with-no-live-session) for the error codes.

Resume also refuses a child that is still running (pause or quit it first) and an id this session did not launch. That includes a child that is running again because a wake reopened it, for example after a released child's call finished or a late result reached a finished child: the error reads `<agent> (<child-id>, <intercom-name>) is already running as task <task-id>; pause or quit it first.` To reach a running child without stopping it, send it an Intercom message. A resume that arrives while a wake or another resume is still reopening the child gives that error as soon as the new task starts. You can use the task ID from the launch receipt immediately, even before the child's record is saved or after reopening the owner's view. Resume does not wait for a sibling to save or for the child to register on Intercom. A resume that fails, for example because the child's agent is no longer defined, keeps its `worktree: true` worktree with its changes and branch.

Interrupting your turn (Esc) ends a `pause`, `resume`, or `quit` call that is still waiting; the call's result says what happened. A stop that was already requested goes on, so the child still ends paused or quit. If the resume is still checking the child's state or queued to wake it, the child does not run it or receive its `message`. You can retry when you are ready; pending saves still finish. A resume that had already begun reopening the child goes on, and `subagent({ action: "status", id })` shows how it went.

An SDK session without a task host runs its subagents directly and records them in its session the same way, so `pause`, `resume` (with or without `message`, queued messages included) and `quit` work there by id and with `all: true`, also after the session is reopened. A child resumed there runs in the background, and its result arrives as a completion notice. Closing the session stops such a child; reopening the session relaunches it automatically, and the messages it had queued and not read are delivered once, in order. For a terminal child, launch a fresh child with an explicit context handoff.

#### Released subagents

A background subagent that waits more than a minute on a tool call marked `detachable` (extension tools opt in with `detachable: true`) is **released**: the call keeps running, but the child gives up its session, task and Intercom connection and holds nothing else while it waits. Nothing paused it, and it needs no `resume`: it wakes by itself when the call finishes. Its parent gets a notice that reads `Subagent <name> released while waiting on <tool> (<call id>)` and says it wakes by itself. The notice appears in the parent's chat as `◌ <name> is waiting on <tool> (<call id>)`, with the same still, dim `◌` mark every other view gives the child, without starting a turn, and the parent's model reads it with its next turn. `/tasks`, the agent panel and a chat's task footer list the child under **Waiting** with a still `◌` mark and `waiting on <tool>`, naming the tools it waits on; its detail in `/tasks` reads `Waiting on <tool>` and adds the call ids. Opening the child shows its saved conversation without waking it, with a note that says what it waits on, that it wakes by itself, and which of its shells still run. Alt+W (`app.tasks.openWaited`) opens the output of its newest running shell, from that chat or from its row in `/tasks`, and ← goes back. The launch card in the parent's chat shows it with the same `◌` mark and `Waiting on <tool>`, and shows it running or finished again once it wakes or ends. A message you send from that chat wakes it, as an Intercom message does. Pressing `x` twice on its row stops it as `quit` does, so it no longer wakes by itself and waits for a resume. When it wakes, its later run replaces it in these lists. `subagent({ action: "status" })` lists it as `released · waiting on <tool> (<call id>)` and says it is not paused. A child you pause or quit is reported as `paused · awaiting resume`, and its notice keeps the `⏸` mark.

- Any subagent with an owning session can be released, including one your turn waits for with `action: "wait"`: that wait then ends and reports the child released.
- When the call finishes, the child wakes from its saved session and continues the turn with the call's result. You can `/reload` while it wakes: the same task appears as running without a second `resume`.
- An Intercom message or ask sent to a released child wakes it too. Senders wait while it wakes, and it receives every message once, in the order they were sent. Calls it is still waiting on are marked as still running, and their results arrive later as messages.
- An ask already awaiting a child's reply stays open if the child is released, also when the ask came through another node's broker with [multi-node Intercom routing](/intercom/operations#running-intercom-across-machines); it can be answered after the child wakes, on any node. A woken child keeps its Intercom session id; if it cannot, an asker on another node does not learn the new id, and its wait ends at its reply timeout. If the child is gone instead, or the session that launched it drops it or closes, an asker on the same broker is told it disconnected, and an asker on another node waits until its reply timeout.
- Steering and follow-up messages the child had queued and not yet read when it was released are delivered when it wakes, once and in order. Turn-starting Intercom messages, extension messages and background completion notices accepted during release are kept too, with steering or follow-up delivery. Their cards are saved once, and their context is delivered once on wake. Extension messages with `excludeFromContext: true` keep only their saved cards and never reach the model. This release guarantee does not apply to `deliverAs: "nextTurn"`.
- A result that arrives while a woken child is running is kept, and wakes the child again once that run ends.
- `pause` and `quit` on a released child only stop it from being woken; results that arrive meanwhile are kept and delivered when you `resume` it. `resume` wakes it with your `message` if given, as soon as fewer than `parallel.runningCapacity` of the session's released children are waking; it does not count once the child runs, and results that arrive while that run goes on are saved with the child at once.
- Released children wake through the session that launched them. If that session's connection closes while they wait, Intercom keeps their holds: a message to one waits up to 20 seconds and then gets a retryable `recipient_owner_suspended` error, and when the same session is back it takes its released children over and is asked to wake them for the messages waiting then.
- Each run of a child that has finished stays listed in `/tasks` as one small record, with no live session, socket or timer, until that session closes.
- The results a wake carries are saved with the child before the child is reopened, so a restart in between wakes it with them instead of running the finished call again. If a wake fails, for example because the child's agent is no longer defined, the results it carried stay saved with the child. `status` shows the failure, its code and what to do, and the session that launched the child gets one notice. `resume` tries again and delivers the saved results.
- If a child record could not be saved, `status` reports the last failure and its hint for the launching session. Check the session store before retrying; unsaved state cannot survive a restart.
- When you reopen the session after Atomic restarts, a released child's detachable calls start again with the same call ids and arguments, without a model turn; new results wake it. Mark a tool `detachable` only if running it twice is safe. An Intercom question is not sent again: its original reply or timeout wakes the child. If it was waiting on both an Intercom question and another detached call, that other call is not restarted automatically. If the broker itself restarts, an open question to a session on the same broker is lost and the child receives the timeout; with multi-node routing, a question to a session on another node is kept in the shared database and still takes its reply. A child already holding its call's result is woken with it instead. At most `parallel.runningCapacity` of a session's released children wake at a time. If a call's tool is no longer available, the child waits for its next message or `resume`.
- A shell `wait` without a `budgetMs` waits until its task finishes, so a child that waits on its own background shell this way is released too, and the task's result wakes it. A shell task a released child started that finishes while it is released wakes it with the task's completion notice. While it is paused, quit or finished, the notice waits for its next run. It is never sent to the session that launched the child.
- An Intercom `ask`, and `contact_supervisor` with `need_decision` or `interview_request`, release a waiting child too: the reply reaches the session that launched it and wakes the child with that reply as the call's result, once. With [multi-node Intercom routing](/intercom/operations#running-intercom-across-machines), a reply sent through another machine's broker reaches it the same way; while multi-node routing is still starting or unavailable, the child stays live while waiting for the reply instead.

When waking or keeping track of a released subagent fails, `status` and the notice show a typed `ReleasedChildError`. Its `code` says why:

| Code | When it happens | What to do |
| --- | --- | --- |
| `child-record-missing` | The session waking the child has no record of it. | Wake it from the session that launched it. |
| `child-record-unreadable` | The child's latest record is in a session that is not open in this process. | Open the session that launched the child and try again from it. |
| `child-unrestorable` | The child's session or agent cannot be restored, for example because its agent is no longer defined. | Fix what the reason names, then `resume` it, or launch a new subagent. |
| `record-append-failed` | The child's record could not be saved to the session store. Retryable. | Check the session store. Until the record is saved, a restart would not know this state of the child. |
| `hold-failed` | Sends to the released child could not be held at the Intercom broker, for example because another session holds that child. Retryable. The notice names only the children whose reservation failed, once for each release of a child, until a reservation of it succeeds. A retry skips a child that has since resumed or finished. After reconnect, Atomic checks a delayed wake refusal against the restored reservation. If the broker confirms the same release is still held, no failure is reported. Only this check can delay the warning, by up to five seconds if the broker does not answer. Fresh refusals and refusals from older brokers are reported immediately. | Check that Intercom is connected. Until the reservation exists, sends to the child are answered as not found. |
| `completion-not-held` | A shell task finished after the child that started it ran again or ended. | Nothing: the notice waits for the child's next run. The session that launched the child never receives it. |
| `wake-failed` | A wake failed for any other reason. Retryable. | The results are kept: `resume` the child to try again. |

The `kill` action was removed, and `interrupt` before it. Calls with either are rejected with an error that names `quit` as the replacement. For `kill` it reads:

```text
The subagent action "kill" was removed. Use { action: "quit", id } to stop a child gracefully; it stays resumable with { action: "resume", id, message? }.
```

Each background launch block follows the child's latest state after `/resume` or `atomic --session <id>`. It distinguishes running, done, failed and stopped work, and identifies paused or interrupted children that can resume. A resumed child updates its original launch block; the control call confirms the action. Expand a block to inspect its retained prompt, tool calls and result. Earlier `pause`, `resume` and `quit` calls keep their own results, and rejected calls show their error.

A parallel launch keeps a separate `Agent(...)` block for every child, in launch order. A child that could not start shows its failure and short reason; expand for the full text. Other children continue and report their own results. The call itself fails only when no child started.

## Task inspection

Hosts with an owner task store expose `/tasks` and `/tasks <id>` for subagents and background shells, including their retained terminal results. A shell command its tool call still waits on is excluded. Enter or Right opens the selected task's chat or output, or its detail page when no transcript is available. Press `x` twice within 3 seconds to stop a running task, or once to dismiss a finished row. Escape returns one view at a time without stopping work.

Stopping a subagent from `/tasks` uses `quit` and keeps it resumable. Its row shows **Stopped** (`◼`), and its chat reads `Stopped · send to resume`. Send a message from that chat, or use `subagent({ action: "resume", id })`, to continue it. A child whose owner ended, or whose saved state is unavailable, remains read-only.

`/tasks` appears in slash-command autocomplete. The bottom sheet replaces the prompt area while the conversation remains visible above it. Its header counts **Needs input**, **Working**, **Waiting** (subagents released while they wait on a call, which wake by themselves) and **Done**, and each task occupies one line with a status mark, name, task and elapsed time. The header and footer remain visible in ordinary terminal sizes, with a compact fallback for short terminals.

Space opens a peek card under the selected row without hiding the list. The card shows the model and reasoning level, current activity and usage when available. A working subagent also has a reply box; type a message and press Enter to send it. Detail, transcript and input pages use the full screen. Returning to the list preserves selection.

In the interactive CLI, a subagent's `ask_user_question` and extension dialogs wait in that subagent's own chat. Its task shows that it needs input. Open the task's transcript to answer; the main chat and sibling sessions remain usable and cannot answer the question accidentally. Leaving the subagent's view keeps its question and form state pending. In a several-question form, Left steps through earlier tabs, then leaves from the first question; at the start of a typed answer or note, it leaves without clearing the draft. The hint line shows the active Back key. Escape in the question cancels it without approving anything. Timed dialogs show their remaining seconds. PageUp/PageDown page a selection with more than ten choices; otherwise they scroll the transcript.

Plain RPC clients and SDK hosts without a task inspector keep receiving child questions through their existing input presentation. SDK hosts should route `humanInput` requests by the asking `sessionId`; see [Human input without a terminal](/sdk#human-input-without-a-terminal).

Opening `/tasks` while the main chat has a question does not answer or cancel that main-chat question. It returns with its selection intact when task navigation closes.

In the default isolated CLI, background subagents continue running after their launch observation returns. The agent panel below the prompt lists each one with its task, elapsed time and tokens; press ↓ on an empty prompt and Enter on a row to open its chat, or run `/tasks` to inspect individual tasks. Task updates never open either automatically. Completed tasks leave the panel as soon as they finish and remain available in completion notices and `/tasks`. Inspecting does not restart work or create a second task owner. Top-level model bash commands use this owner on POSIX and native Windows; native Windows PowerShell is also owner-bound. Commands inside subagent sessions retain their existing execution path. See [Background shells](/background-tasks#background-shells) for platform support and the separate execution timeout.

Transcript inspection shows the child's conversation as a chat: it opens at the latest message, follows new output, and loads earlier retained history as you scroll toward the top. Thinking blocks follow Ctrl+T and tool output follows Ctrl+O. Compaction boundaries, branch summaries, and extension notices appear as they do in the chat. Missing capture is reported as `Transcript unavailable`; metrics never substitute for missing messages. See [Inspect tasks](/background-tasks#inspect-tasks) for the controls.

A subagent's chat has an attached composer: accent-coloured rules around the prompt, the top one naming the subagent, its task and its state (`debugger · #5220 spawn lock · 18m`). The empty prompt reads `Message debugger…`, or `Answer debugger…` while it waits on a question. The name is the agent's name, or its Intercom name when it has none. Pending messages, the working line and the usage meter sit above the prompt, and the model and folder line and the subagent's own running tasks, as agent-panel rows, sit below it. While the subagent runs in this session, the usage meter and model line show its own session (the model line only while the subagent is idle; while it works, no status line shows below the prompt), and a transcript opened mid-turn shows the working line and any messages already queued for it. A subagent that has finished, or runs in another process, still lists its active tasks below the prompt in the same rows. Typing `/tasks` there opens that subagent's own tasks, including the shells it ran, instead of the parent's. Escape or Left on that list returns to the subagent's chat. In the subagent's chat itself, Left on an empty prompt goes back and Escape interrupts the subagent's current turn without leaving or ending it. The main chat's `/tasks` lists only the main chat's own tasks: its shells, and the subagents it launched, not the shells those subagents ran.

After Escape interrupts a subagent's turn, its task stays running while the child waits. Its stopped row stays in `/tasks`, and in the agent panel while other background work is still running; `x` still requires confirmation to quit the task rather than dismissing it. Your next message or the completion of its own background work can start another turn. This includes a resumed subagent interrupted while it replays a message that arrived before it stopped: it answers your next message, then continues with the task it was resumed with. You can interrupt that turn again, including while it is starting, to leave the child waiting. If a message cannot start a turn because it could not be saved, fix the storage problem and send another message; the child stays available. When a later turn finishes without another interrupt, the task completes and its parent receives the result. Sending another message in the finished child's chat resumes it in its saved session; the same chat can resume it again after later completions.

At the prompt, `/` offers `/tasks` and the subagent's own `/skill:` commands, and `@` file mentions and Tab complete paths in the subagent's working directory. A skill command reaches the subagent expanded from its own skills, as the subagent would expand it.

Type in a transcript's prompt and press Enter to message the child through its Intercom target, as an Intercom message from your session would. The child records the message, so it appears in the transcript once delivered; a message Intercom refuses or does not confirm stays in the prompt with the reason.

Live transcripts refresh streaming text, tool results, and compaction status without reopening. Earlier pages remain anchored, and leaving the view does not affect execution.

Detail views pin task identity, state, available metrics, and the selected action while PageUp/PageDown scrolls the body. Recent activity shows up to five retained tool actions; errors and input requests appear explicitly. Left returns to the previous view. On the list or detail page, press `x` twice within 3 seconds to stop an active task, or once to dismiss a finished task. Configured task bindings take precedence. In a transcript, `x` is ordinary typing. Shell inspection shows a bounded output tail with omission markers.

After a confirmed `x` stop settles, the owning chat receives a **quit · awaiting resume** notice line and the parent model receives the quit context, even if the child returns no final message. Repeated stops do not duplicate notifications or replace an already-recorded terminal result. Closing the owner still suppresses late completion delivery.

## Orchestrator model and group policy

Atomic applies the same delegation policy to any parent chat that orchestrates subagents. A named agent uses the model and fallback sequence declared by its agent definition, so the orchestrator normally omits the subagent tool's explicit `model` argument. An override needs either the user's exact model request or a documented task-specific reason recorded before launch; model diversity alone is not enough.

When a task needs a specific model, the orchestrator calls `subagent({ action: "models" })`. It may pin only a returned `fullId` and may add a thinking suffix only when the model entry lists that level. When the catalog tool is unavailable, the catalog is empty, or no catalog model fits, the child stays unpinned and the orchestrator reports the limit instead of inventing a model or inspecting credentials.

Children inherit the launching session’s Intercom group across single, parallel, and follow-up work. Set `group` on a launch to use a different group; `contact_supervisor` can still reach the parent across group boundaries.

## Context and execution modes

Subagents can run with fresh or forked context:

- `context: "fresh"` starts a separate in-process child session with only the task and selected agent context.
- `context: "fork"` creates a branched child session at the parent's last settled entry. After a clear or compaction, the child normally copies only its retained context and settings. To read earlier turns, follow the boundary's history link or open the parent session. A store without a fork-window reader, or a child whose context refers to a saved tool output from before the boundary, keeps the full branch as before. If the parent session cannot be forked, the launch fails; it does not silently downgrade to fresh context.

For adversarial review or research, prefer fresh context so the specialist inspects the repository directly. Use forked context when a writer needs the parent conversation history in a separate branch.

For parallel implementation work, `worktree: true` can give each child an isolated git worktree so concurrent edits do not clobber each other.

Observation yields do not release these worktrees. The batch's worktrees and branches are removed once every child that uses them has finished; Atomic first saves each worktree's changes as a patch under the run's `worktree-diffs/<run id>` artifact directory. When a child is paused or quit, or stays resumable because you closed or switched away from its session, its worktree is kept only if it has uncommitted or untracked changes or commits that are not in the run's base; a clean worktree is removed with the others. Resuming the child continues in its kept worktree, or recreates a removed one from the run's base with its saved patch applied, so a resumed completed child starts with its earlier changes. A resumed child keeps its worktree until it finishes again, and then saves a new patch (`task-<n>-<agent>.<execution>.patch`) rather than overwriting the earlier one. Cancelling a child for good, including a queued one, lets its worktree be removed. If you never resume a stopped child that has unsaved changes, its worktree stays on disk under `.atomic/worktrees/`.

For a temporary worktree, completion, pause, quit, and a failed resume wait for Atomic to finish using the directory. Pause-all and quit-all stop children in order, queued children first. Git cleanup on one child does not delay the next stop. Saving a patch leaves a retained checkout intact, including its local settings and the difference between staged and unstaged edits. If a running sibling keeps the batch's worktrees, the reply says so; wait for it before removing them. The launch card checks the current worktree state. If a child fails or cannot start, its original error stays unchanged; any current hold appears separately. Cleanup notices aren't part of the child's output or its byte count. Esc ends your wait immediately without cancelling cleanup. If cleanup takes more than ten seconds, the reply warns you that it continues in the background; don't remove the worktree until it finishes. If a git command times out, check the worktree for unsaved changes before removing it.

**If your integration helps a child finish:** subscribe to `pi.events.on("subagent:finishing", handler)` before launching it. For each temporary worktree execution, the handler receives `{ runId, index, taskId, cwd, status }`. Use that signal to let a Git filter's helper or a pause reservation proceed. It is not permission to remove the directory. Git filters invoked by Atomic's child cleanup can also check `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` directly. A filter that still waits for the terminal report can stall: Atomic can't publish that report while the filter is using the checkout. To support older Atomic versions, also accept their terminal notification and make your helper idempotent. Named worktrees and plain children do not send the worktree signal.

The directory guarantee applies while Atomic is running. After a crash, Atomic replays an undelivered completion from the session; if an orphaned Git process survived the crash, that notice does not certify that the process exited. Check the checkout before removing it.

### Named worktrees

To run a child on a branch you choose, pass `worktree: { branch, base?, path? }` on a single call, a parallel call (it applies to each task without its own), or a task:

```typescript
subagent({ agent: "worker", task: "Fix the parser", worktree: { branch: "fix/parser" } })
subagent({
  tasks: [
    { agent: "worker", task: "Add the API", worktree: { branch: "feat/api", base: "origin/main" } },
    { agent: "worker", task: "Add the UI", worktree: { branch: "feat/ui", path: "../ui-worktree" } },
  ],
})
```

Before the child starts, Atomic checks out `branch` in a worktree at `path` (relative to the call's `cwd`; default `.atomic/worktrees/<branch>`, with `/` in the branch name written as `+`). A new branch starts at `base`; without `base`, at the current branch's upstream, or `HEAD` when it has none. Atomic resolves the start point in the caller's worktree, including an explicit `HEAD` or a commit-message search such as `:/initial commit`. An existing branch that is not checked out anywhere is checked out as it is. When that branch is already checked out at that path, the worktree is reused as it is, so a later call can continue there. The call is refused before any child starts when the branch is checked out somewhere else, or the path already holds something other than that branch's worktree.

Concurrent calls for different branches and paths run in parallel without blocking each other. Reusing a completed worktree, including one locked with `git worktree lock` or created with `--no-checkout`, does not wait for unrelated checkouts (for `--no-checkout --lock`, pass a `--reason` other than Git's internal `initializing` marker or its translation, which Atomic treats as an external checkout still in progress). Calls for the same branch and path wait for the first checkout to finish and reuse it. Calls for the same branch at different paths wait for the first checkout and then refuse the second path because the branch is already checked out.

While a launch waits for another checkout, its progress names the worktree it is waiting for. Esc or cancellation stops the wait or the running checkout. If an external `git` process holds `index.lock` or leaves an initializing worktree at the target path for more than 30 seconds, the call fails with `another git process seems to be running at <path>`. This also waits for Git's translated initialization markers and pending HEAD updates. If a previous named-worktree checkout was interrupted before completing its index or reference updates, the next launch for that target fails immediately with `an interrupted named-worktree checkout left an incomplete worktree at <path>`.

To recover, first confirm that no Git process is using the worktree or repository, and inspect and save any files you need. Run `git worktree unlock <path>`, remove the worktree directory, then run `git worktree prune`. Inspect the reported Git metadata directory for a stale `HEAD.lock` and the repository's branch reference for a stale `.lock` file, and remove those stale locks before launching again. If the worktree metadata is intact, `git worktree remove --force --force <path>` can remove the worktree instead. Do not repair a partial checkout by deleting only `index.lock`.

An external `git worktree add` can briefly make another worktree's `commondir` file unreadable. Atomic retries that error at most five times over one second, and only while its own target is empty and Git has removed its incomplete registration. If the error persists, let the other Git command finish and launch again; do not remove another worktree's metadata. A partially populated target is refused rather than checked out again.

A Git checkout hook must not synchronously create another named worktree for the same branch or path; run that launch after the hook returns, or target a different branch and path. Atomic stops an active Git checkout and its attached hook processes when the launch is cancelled or the host exits while the checkout is still running. If cancellation or host exit interrupts a post-checkout hook after Git has finished populating the worktree's index, a later launch reuses the completed checkout. Background processes started by a hook survive a normal checkout exit, as with Git itself; do not use background hooks to modify a worktree after checkout returns.

A named worktree is yours: Atomic never removes it or its branch, saves no patch, and does not copy files or link `node_modules` into it. The child's record names it like any worktree, so the restore notice shows it, and resuming the child continues there, checking the branch out again at that path if the worktree was removed. A named worktree cannot be combined with `worktree: true` in one call.

Use a named worktree rather than running `git worktree add` in the same turn as the launch: tool calls in one message run at the same time, so a launch whose `cwd` is a worktree another call is still creating fails with `cwd does not exist`. That error says so; launch after the other call returns, or pass `worktree: { … }`.

Fresh children inherit the invoking session's SDK configuration, resource-discovery inputs, model/auth runtime and host callbacks. Child tool selections can narrow the parent's permissions but cannot restore disabled packages or excluded tools. Intercom has no mandatory bypass; a child without access receives no supervisor grant. Model fallback keeps the same inherited restrictions. See [SDK child configuration](/sdk).

Top-level parallel calls apply these settings from `~/.atomic/agent/extensions/subagent/config.json` after expanding each task's optional `count`:

- `parallel.maxTasks` defaults to 1000 and limits the number of tasks in a parallel set. There is no hard upper cap; raise or lower it as needed.
- `parallel.concurrency` defaults to 1000 and limits how many children are dispatched at once. Per-call `concurrency` takes precedence.
- `parallel.runningCapacity` defaults to 1000 and limits simultaneously running child turns per parent.

To run more than 1000 children at once, raise concurrency and running capacity as well as the task limit:

```json
{
  "parallel": {
    "maxTasks": 2000,
    "concurrency": 2000,
    "runningCapacity": 2000
  }
}
```

Running capacity is selected when a parent's first child is created. Restart Atomic after changing this setting to apply the new capacity.

`resumeInFlight` controls what happens when a session starts or is resumed to subagents you paused or quit that are still awaiting resume:

```json
{ "resumeInFlight": "ask" }
```

- `"never"` (the default) leaves them listed under **Awaiting resume** in `subagent({ action: "status" })` until you resume them.
- `"ask"` shows one confirmation that lists each subagent by name and id, such as "2 interrupted subagent(s) can resume from their own sessions: ... Resume now?". Choosing No leaves them awaiting resume. Without an interactive UI it behaves like `"never"`.
- `"auto"` resumes them, each continuing from its own session, and its result reaches the session that launched it.

Starting Atomic and resuming a session (`/resume`) recover children; `/reload`, `/new`, and forking do not. Only subagents launched by the session being started or resumed are affected. Any other value is reported when the config loads and treated as `"never"`.

When one assistant response emits several sibling execution-mode `subagent` tool calls, Atomic collects that synchronous burst before starting a child and runs it as one indexed parallel set. Each original tool call still receives one result containing only the children it requested, and its live result, progress, control, and artifact updates are projected to that same route without sibling data. The TUI redraws the shared run as one aggregate parallel widget rather than retaining one widget per original call. A single call keeps its original SINGLE or PARALLEL mode, calls awaited in sequence remain separate runs, and management actions bypass collection. An execution call that arrives after a child has started still receives the existing in-progress rejection. Prefer one explicit `{ tasks: [...] }` call when planning parallel work; burst collection handles sibling calls emitted by a model.

For a collected burst, each call contributes its top-level `agent` task first and then its `tasks` entries in array order. The same list is checked against the per-call limit and launched even if all other calls in the message fail. Atomic preserves duplicates, expands `count` in place, and applies `parallel.maxTasks` after flattening and expansion. Each call-level `cwd` selects that call's agent-discovery scope and child base directory. A task-level `cwd` stays relative to that call base and changes only that child's execution directory, not agent discovery. This per-origin discovery rule applies only to collected sibling calls; an ordinary explicit `{ tasks: [...] }` call keeps one discovery scope from its top-level `cwd`. Per-call and per-task `group` values also stay with their originating children. A call's named `worktree: { … }` stays with its own children, so sibling calls can each name a different one. Shared run options must match across every sibling call: `concurrency`, `worktree: true`, `context`, `share`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, and `agentScope`. A mismatch rejects the whole burst before any child launches and names the incompatible field. Two tasks in one call writing to the same resolved output path fail only that call, including in named worktrees. An output conflict only between calls fails the merged run. Calls with a known setup error do not count toward the remaining calls’ combined task limit; an absolute output path can be checked even before a worktree exists.

For a collected `worktree: true` burst, every call-level `cwd` must resolve to the same path. That common path becomes the shared worktree root; differing origins reject the burst before launch, and any task-level `cwd` must still resolve to that root. Each projected caller result keeps shared worktree diff text and terminal control guidance while its child results and standard child-output sections remain route-local.

Use `group` on a call or task to select the child's [Intercom](/intercom) group. A named string joins that group; `true` creates one shared UUID group for a parallel set. Precedence is `explicit subagent group > inherited current-session group > config > "default"`. Children without Intercom access receive no group or supervisor channel. `contact_supervisor` can reach the authorized supervisor across group boundaries; ordinary Intercom remains group-bound.

Pending Intercom asks belong to the addressed session. A child cannot inspect or answer its parent's pending asks, and sibling children keep separate pending lists.

When a subagent call or parallel task uses a `cwd`, Atomic validates that working directory before starting the child runtime. Missing or non-directory paths are reported as `cwd` problems instead of lower-level runtime errors.

Single-agent calls also accept `reads: string[] | false`. Atomic prepends those files as read context through the same in-process session path. Relative entries resolve against the effective child `cwd` (including a relative top-level `cwd` resolved from the parent); absolute entries are unchanged. Invalid values fail before the child session starts.

Single-agent calls accept `progress: boolean`. `progress: true` creates a run-scoped `progress.md` under isolated subagent artifact storage and instructs the child to maintain it without writing `progress.md` into the child `cwd`; `progress: false` disables an agent's `defaultProgress`. When `progress` is omitted, the agent's default is inherited, except that inherited progress is suppressed for read-only tasks (`progress: true` still explicitly opts in). Atomic removes this run-owned progress storage after the child exits when `artifacts: false`. Parallel tasks with `progress` enabled share one run-scoped `progress.md` in the same artifact storage, never in a task's `cwd` or the project directory. This is separate from `includeProgress: true`, which only includes detailed runtime progress telemetry in the final tool result and does not create or maintain a file.

```ts
subagent({ agent: "worker", task: "Implement the approved fix.", progress: true })
```

### Subagent start timeouts

A child must start within its start budget: open its session, load its resources, create its agent session (including any wait for a resource-admission permit), and dispatch its task. The budget is 5 minutes. Waiting for a running slot under `parallel.runningCapacity` does not count, and a resumed child's budget ends once its session is up. Set `sessionStartTimeoutMs` in the same `config.json` to change it:

```json
{ "sessionStartTimeoutMs": 600000 }
```

The value is a whole number of milliseconds from 1 to 2147483647. Any other value is reported when the config loads, and children keep the 5-minute budget.

A child that runs out of budget fails with a `SessionStartTimeoutError` instead of staying running. Its message, also shown by `subagent({ action: "status" })`, names the step the child was still in, and its `phase` says what blocked it:

| `phase` | What blocked the start | What to do |
| --- | --- | --- |
| `admission` | The child was still waiting for a session permit from its resource admission. | Free capacity in that admission, then retry. |
| `setup` | The child was still opening its session, loading its resources, or creating its agent session, including its extensions' startup. | Check the session store and extension startup, or raise `sessionStartTimeoutMs`, then retry. |
| `dispatch` | The child's session was up but its task had not been dispatched, for example an extension's `input` or `before_agent_start` handler was still running. | Check those handlers, then retry. |
| `event-loop` | The process's main thread was too busy to make progress: during the whole budget its event loop turned fewer than 100 times, at 200 ms or more per turn. | Reduce the work running in the same process, then retry. |

SDK hosts and other callers of the subagent runner receive the error serialized as `startError` on the child's result. Rehydrate it to branch on it; see [Session start errors](/sdk/reference#session-start-errors) for its fields:

```typescript
import { isSessionStartTimeoutError, rehydrateSessionStartError } from "@bastani/atomic";

if (result.startError) {
  const error = rehydrateSessionStartError(result.startError);
  if (isSessionStartTimeoutError(error) && error.phase === "admission") {
    // Free admission capacity, then launch the child again.
  }
}
```

## Delegation and child boundaries

Delegation is exactly one level deep and cannot be configured. Children complete their assigned tasks directly; they cannot launch other children or `pause`, `resume`, or `quit` them. Children can still run background shells. Those shells run in the parent's task owner, but only the child's own `/tasks` lists them and only the child receives their notices. See [Shells started by subagents](/background-tasks#shells-started-by-subagents). They may inspect definitions and status with `list`, `get`, `status`, and `wait`; management-restricted children also cannot `create`, `update`, or `delete` definitions.

Child prompts omit parent orchestration artifacts and prior subagent control traffic. Tool availability does not grant delegation authority. The parent remains responsible for orchestration.

## Custom agents

Moved to [Custom subagents](/subagents/authoring#custom-agents).

## Fallback models

Moved to [Subagent reference](/subagents/reference#fallback-models).

## Reasoning levels

Moved to [Subagent reference](/subagents/reference#reasoning-levels).

## Related docs

- [Orchestration](/orchestration) for multi-step work with codemode and subagents.
- [Intercom](/intercom) for cross-session messaging and supervisor escalation.
- [Skills](/skills) for reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) for user and project configuration.

## Owner-bound task projection

Moved to [Subagent reference](/subagents/reference#owner-bound-task-projection).
