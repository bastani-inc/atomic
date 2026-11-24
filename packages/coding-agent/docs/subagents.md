---
title: "Subagents"
description: "Run focused Atomic child agents"
---

# Subagents

Atomic bundles `@bastani/subagents` so the parent chat can delegate bounded work to specialist child agents in separate sessions. Nothing extra needs to be installed.

When to delegate:

- Delegate independent research, analysis, debugging, or parallel implementation work that can overlap with other steps.
- Keep interactive, exploratory, or immediately blocking tasks in the main chat unless specialist focus or context isolation adds value.
- Every subagent runs in the background. Let completion notices notify the parent instead of polling, and call `subagent({ action: "wait", id })` only when the next step depends on a child's result.

See [Background tasks](/background-tasks) for the agent panel, `/tasks`, shell output, cancellation, and completion notices.

## Where to go next

- [Custom subagents](/subagents/authoring) explains how to define, scope, and configure custom agents.
- [Subagent reference](/subagents/reference) covers discovery order, `auto` model selection, fallbacks, reasoning levels, and task projection.

## Start with natural language

Describe what you want delegated in plain language:

```text
Map the authentication flow with focused subagents before we change it.
```

```text
Run a parallel review: one pass for current behavior, one for failure modes, and one for existing patterns.
```

```text
Research the upstream library behavior online, then compare it with our local implementation.
```

Atomic chooses the specialist and execution shape (single child, parallel batch, or forked context). For multi-step work, the parent can also launch children from [codemode scripts](#from-codemode-scripts).

## Browse agents

Run `/agents` (or `/agents <query>`) to inspect project, user, package, and built-in agents:

- Type to filter by name, description, or source. Select an agent and press `Enter` to view its model, fallbacks, tools, path, and system prompt.
- Press `Esc` to go back to the list, then back to chat.

`/agents` is read-only and never launches or edits agents. It uses the same discovery rules as execution, so shadowed or disabled definitions are hidden. Leaving it open does not mark [Herdr](/herdr) blocked.

## Let Atomic choose the child model

All built-in subagents default to `model: "auto"`, which runs your default model (last chosen with `/model`) at its default thinking level, or the launching session's model when no default is set. Per-call `model` overrides the default, and custom agents without `model` inherit normally. See [Automatic model selection](/subagents/reference#automatic-model-selection).

- Providers without configured credentials are skipped before launch and recorded in model attempts.
- A provider that rejects credentials mid-run is skipped for subsequent fallbacks.
- If no candidate in the chain has credentials, launch fails immediately and lists each missing provider. See [Fallbacks and credentials](/models#fallbacks-and-credentials).

## Subagent execution is non-interactive

Subagent launches start immediately without preview prompts or terminal input across single, parallel, forked, and prompt-template runs. Ask clarifying questions in the parent chat before delegating.

Subagents return their results directly. Atomic does not infer acceptance gates or parse `acceptance-report` blocks, so put required tests, commands, or evidence checks in the task prompt.

## Background launches and waiting

Every `subagent` launch runs in the background and returns at admission (`reason: "default-background"`) with each child's `taskId` and `intercomTarget` (for example `subagent-worker-1a2b3c4d-1`). Use `intercomTarget` verbatim when messaging a child. Legacy calls that pass `wait` still run in the background, and `wait: { kind: "foreground" }` adds a note pointing to `action: "wait"`.

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references." })
subagent({ action: "wait", id: "<taskId>", budgetMs: 120000 })
subagent({ action: "status", id: "<taskId>" })
```

- **Waiting.** `subagent({ action: "wait", id: taskId, budgetMs? })` observes an existing task in the same owner up to `budgetMs` (default `tasks.wait.agentBudgetMs`, `30000` ms). Ending a wait on budget or pressing `Esc` leaves the child running. Wait for terminal completion before depending on its result. See [Choosing how long to wait](/background-tasks#choose-how-long-to-wait).
- **Concurrency.** Multiple single-agent launches in one turn share `concurrency` (or the configured parallel limit). Returning from launch or ending a wait does not free a running slot.
- **Heartbeats.** Running children send [task heartbeats](/background-tasks#task-heartbeats) every 15 minutes by default, reporting current tool, idle time, turns, tool calls, and tokens. Override with `heartbeatMs` on the call or task entry (`0` disables).
- **Startup progress and retries.** Before its first turn, `status` reports the exact startup step (`opening its session`, `loading its resources`, `waiting for a resource-admission permit`, `creating its agent session`, `registering on Intercom`, or `dispatching its task`) with elapsed time and a structured `start` field. If startup exceeds `sessionStartTimeoutMs` (default 5 minutes), Atomic marks the attempt `stalled` and retries once after releasing its session.
- **Stalled startup failures.** If a stalled attempt still holds its session after half the budget (capped at 30 seconds), it fails without retrying. Two stalled attempts fail with `Subagent did not start: its start stalled <step> after <N>s and was retried once; the retry stalled <step> after <M>s`.
- **Settled output.** `wait` and `status` append up to 16 KB of output, `Full output: <path>` (a private copy; Atomic keeps the 256 most recent copies in a private temp directory and cleans them on exit), and `Requested output:` when an `output` file was specified. With `outputMode: "file-only"`, only the saved-file reference returns inline.
- **Yielding to user or Intercom.** User steering (`input-needed`) or an inbound Intercom message (`intercom-coordination`) yields active `wait` calls so the parent can respond without cancelling children or queued siblings. You can wait on the task again afterward.
- **Session close and reopen.** Closing a session stops running children. Reopening it automatically restores unfinished children from their saved sessions.

## Supervisor coordination

All built-in specialists include `intercom`. `debugger` and `worker` also include `contact_supervisor` for escalating decisions to the parent. Parent tool allowlists, exclusions, `noTools`, and disabled Intercom still apply. A child without `read` or `search` receives a read-only `session_history` tool after compaction so it can recover its own history (see [Agents without read or search](/compaction#agents-without-read-or-search)).

- **Supervisor decision waits vs. `intercom` `ask`.** `contact_supervisor({ reason: "need_decision" })` and `interview_request` wait only in the requesting child and resume that same child when the supervisor replies via `intercom({ action: "reply", message: "..." })` (use `pending` and `replyTo` when multiple asks are open). Never relaunch the child to answer it. By contrast, `intercom` `ask` never blocks: it returns at delivery (after any `wait` budget) and delivers late replies as messages.
- **Non-blocking updates.** `intercom` `send` and `contact_supervisor({ reason: "progress_update" })` return immediately without cancelling or disrupting siblings or worktrees.
- **Messaging a running child.** Children register on Intercom before their first turn, retrying while starting if the broker is briefly unreachable (supervisor authorization retries up to 30 seconds across broker restarts before starting without it). Address the child with its name or full ID from `intercom list`, and set `delivery` to `"steer"` (default), `"followUp"`, or `"interrupt"` based on urgency. See [Intercom reference](/intercom/reference#the-intercom-tool) for delivery modes and parameters.
- **Ended and terminal children.** Single-target `intercom` `send` and `ask` calls to completed or failed children return `queued: true` and resume the child (late `ask` replies arrive as messages). Messages to paused or quit children queue until the launching session continues them. Immediate rejection applies only to permanently cancelled (`killed`) children, pattern sends, calls past the resume rate or chain bounds, or an `ask` that hits a still-connected registration marked `replyCapability: "terminal"` before disconnecting. In-flight pending asks fail if the child ends before replying.

### Automatic restore on reopen

If Atomic exits, crashes, or you switch sessions (`/new`, `/resume`, `/fork`), running children stay resumable and relaunch automatically when you reopen the launching session. They keep their Intercom name, group, model, thinking level, original agent definition, `context: "fork"` bridge instructions, and unread queued steering or follow-up messages (delivered once in order).

Inbound Intercom messages wait while the child restores (see [Intercom operations](/intercom/operations#connection-states-and-recovery)). Finished, paused, quit, and permanently cancelled children are not auto-relaunched, and session forks (`/fork`, `--fork`) never relaunch the original session's children. If a child cannot be restored (for example because its session or agent definition is missing), Atomic emits one recovery notice with its IDs, worktree or branch, `git` inspection commands, and relaunch call, then marks it gone.

### Child session storage and worktree snapshots

A child keeps its session in the launching session's storage: SQLite by default, or the libSQL or PostgreSQL database you selected. Children resume, wake, and export wherever their parent opens, including another machine sharing the same database.

A JSONL-backed parent keeps each child's session as a file beside its own session file, and `sessionDir` (or `defaultSessionDir`) keeps fresh children's sessions as files in that directory. A parent that saves nothing (`--no-session` or memory storage) keeps child sessions in memory; a finished child's history moves to a temporary file that Atomic cleans up on exit.

A fresh child's session is marked internal so `/resume`, `atomic -r`, `-c`, and `history://sessions` omit it, while a `context: "fork"` child's session is listed as a fork of its parent. A child's result names its session file or `history://sessions/<id>`. Older sessions saved under `~/.atomic/agent/subagent-sessions/` remain readable in `/tasks` and restorable.

In a blob-capable store, children record [worktree snapshots](/worktree-snapshots) of checkouts they modify. Resuming the parent restores each shared checkout from the newest capture among the parent and its finished children, while named worktrees and restored active children continue from their own snapshots.

### Peer coordination

Peer-to-peer coordination is the default. Siblings in a parallel batch, or sharing an explicit `group`, discover each other with `intercom({ action: "list" })` and communicate directly with `send` and `ask` instead of routing through the supervisor.

- Share findings, divide file ownership or expensive test runs, reuse verified reproductions, and challenge disagreements with evidence. Each child still returns its own complete result.
- Reserve `contact_supervisor` for supervisor decisions. Ordinary Intercom group boundaries and user approval gates still apply. Peer asks and one blocking supervisor ask can wait concurrently. See `/skill:intercom` for peer patterns.

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

Atomic supports large parallel swarms organized into peer-coordinating teams:

- **Parallel limits.** `parallel.maxTasks`, `parallel.concurrency`, and `parallel.runningCapacity` each default to `1000` with no hard upper cap. Raise all three in `config.json` to exceed 1,000, or lower `parallel.concurrency` to throttle. Provider rate limits and host memory remain practical bounds.
- **Nesting.** Delegation is strictly one level deep. Only the parent launches children.
- **Teams.** Intercom groups have no member cap. Assign each team its own `group` for internal messaging; members can still reach the parent via `contact_supervisor`.

### Single-child handoff without a task host

In an SDK session without a task host, a single child runs directly while `subagent` waits. A claimed parent-targeted blocking request ends the child and returns its question, attachments, identity, and `[TASK_CONTEXT]` so the parent can launch a fresh child (`subagent({ agent: "worker", task: "[TASK_CONTEXT] ... Continue with this supervisor answer: ..." })`). Every other child continues in place when answered.

## Migration from acceptance gates

If older calls or agent definitions still use removed gate fields:

- Remove `acceptance` from `subagent()` calls and task entries.
- Remove `completionGuard: false` from agent frontmatter (management edits strip it automatically).
- Put required commands, tests, or evidence checks directly in the task prompt.

## Bundled agents

| Agent | Purpose | Edits files? |
| --- | --- | --- |
| `codebase-locator` | Find relevant files, directories, tests, configs, and docs. | No |
| `codebase-analyzer` | Explain code behavior and trace data flow with file:line references. | No |
| `codebase-pattern-finder` | Find similar implementations, conventions, and test patterns. | No |
| `codebase-research-locator` | Find related `research/` and `specs/` documents. | No |
| `codebase-research-analyzer` | Extract decisions and active constraints from local docs. | No |
| `codebase-online-researcher` | Research official docs, libraries, and open-source code online. | Research notes only |
| `debugger` | Reproduce a failure, prove root cause, apply the minimal fix, and validate it. | Yes |
| `code-simplifier` | Simplify recent changes while preserving behavior. | Yes |
| `worker` | Implement an approved task, validate the change, and escalate scope decisions. | Yes |

All bundled agents use `model: "auto"` with no pinned fallback chain. Pin a role via `subagents.agentOverrides.<name>.model` in settings or a per-call `model` argument. A concrete `model` runs only that model plus the agent's own `fallbackModels` (see [Fallback models](/subagents/reference#fallback-models)).

## Review compositions

Compose specialists from distinct angles and synthesize their findings in the parent session:

| Angle | Specialist |
| --- | --- |
| Current behavior and regressions | `codebase-analyzer` with file:line citations |
| Failure modes | `debugger` in inspect-only mode (no edits) |
| Project conventions | `codebase-pattern-finder` |
| Prior decisions | `codebase-research-locator` followed by `codebase-research-analyzer` |
| External API conformance | `codebase-online-researcher` |

```text
Review the current diff with fresh-context specialists: analyze correctness, inspect failure modes without editing, and compare the implementation to existing patterns. Synthesize only issues worth fixing now.
```

## From codemode scripts

When both `codemode` and `subagent` are active, `tools.subagent()` launches the same background children and resolves at admission, not completion. Admitted children belong to the parent session and continue even if the script returns, throws, or times out. Subagents cannot launch nested children from codemode.

```js
const { tasks } = await tools.subagent({
  tasks: [
    { agent: "worker", task: "Check the examples" },
    { agent: "worker", task: "Check the links" },
  ],
  group: true,
});
store("checks", tasks);
return tasks;
```

Single `{ agent, task }` and parallel `{ tasks }` calls both return `{ action: "launch", tasks }`. Each slot has `agent`, `state` (`admitted`, `queued`, or `refused` with `reason`), `taskId`, `childId`, and `intercomTarget` when available. Do not retry already-admitted siblings if one slot is refused.

- **`list`, `get`, and `models`.** Inspect executable `agents`, matching `definitions`, or the model catalog (`fullId`, `isCurrent`, `availableThinkingLevels`). Creating, updating, or deleting agent definitions requires a direct tool call.
- **`status`.** Returns `children` launched by this session (pass `id` for one child) with state and any `resumeCall`. Use `status` after reopening a parent to rediscover children instead of relaunching.
- **`wait`.** Takes a task `id` and optional `budgetMs` (default 30 seconds, even if the owner waits indefinitely; `0` checks immediately). Script timeouts cancel `wait`, not the child. Returns `outcome: "settled"` (with `childId`, `result.status`, output excerpt, `outputPath`, and `resumeCall`) or `running`.
- **`pause`, `quit`, and `resume`.** `pause` and `quit` accept `id` or `all: true`. `resume` takes `id` and optional `message` and returns the new task ID in `children`. Always pass `id` rather than the legacy `runId` alias.
- **Temporary worktrees.** `status` can show `finishing` while `wait` still returns `running`. Check `worktreeNote` or `worktreeNotes` before removing any worktree directory.

## Waiting and control

- **Working line (`∀`).** Shows the `∀` status line with verb, elapsed time, and tokens (`↑` waiting for content, `↓` streaming; zero counts stay hidden) for whichever agent you are viewing. Retries and fallbacks continue the same count, and switching away and back keeps elapsed time.
- **Launch cards.** Each child renders `Agent(<agent> · <short task title>)` with state, elapsed time (dispatch to finish, stop, or release, excluding queue and cleanup time), and tokens. Press `Ctrl+O` to expand prompt, tool calls, and result; collapsed cards release those fields from memory. Parallel launches show one card per child and fail only if zero children start.
- **Model metadata.** Live progress, `/tasks`, and run status show each step's resolved model and capability-clamped reasoning effort (including fast model IDs like `openai-codex/gpt-5.6-sol-fast · thinking medium`). Compact launch cards and completion notices omit the model line to save space while persisting metadata in saved details.
- **Status history.** Atomic retains in-process status for the 256 most recent finished runs, and always keeps active runs. Older children remain resumable via `subagent({ action: "resume", id })`.
- **Cancelling a parent turn.** Pressing `Esc` in the parent ends `action: "wait"`, not the child. In an SDK session without a task host, cancelling the waiting `subagent` call stops children permanently and returns labelled partial findings (`progress.md`, last assistant text, or artifact paths).

### Run control

Control children with `pause`, `quit`, and `resume`. The `id` parameter accepts a child ID (`<runId>:<index>`), task ID, Intercom name, or single-child run ID:

```ts
subagent({ action: "pause", id: "<child-id>" })   // Stop now; hold queued messages for resume
subagent({ action: "pause", all: true })          // Pause all running children of this session
subagent({ action: "quit", id: "<child-id>" })    // Graceful stop; stays resumable
subagent({ action: "quit", all: true })           // Covers running and already-paused children
subagent({ action: "resume", id: "<child-id>", message: "Focus on the failing test first." })
```

- **`pause`.** Stops the active turn and keeps queued steering or follow-up messages to deliver once in order before `resume`'s `message`. Intercom messages to a paused child do not resume it; they wait with no time limit and reach it after `resume`'s `message`.
- **`quit`.** Stops the child gracefully, including paused children, while keeping it resumable.
- **Awaiting resume.** Paused and quit children report `paused · awaiting resume` (`Subagent worker quit · paused, awaiting resume: ...` with `Stop reason: quit` or `pause`) and include the exact `subagent({ action: "resume", id: "<child-id>" })` call. `status` lists them under **Awaiting resume** across restarts without auto-relaunching. Completed and failed notices state that execution ended and also provide the `resume` call and Intercom name.
- **Queued parallel children.** You can `pause` or `quit` a child still waiting for a concurrency slot. `resume` starts it with its original task, optional `message`, model, thinking level, worktree, and fork copy, and re-enters the concurrency queue. If its original model or fork copy no longer exists, `resume` reports it as gone instead of substituting silently.
- **`resume`.** Continues the child's saved session under the same child ID, Intercom name, and group with fresh supervisor auth (`all: true` is not supported). For paused, quit, or interrupted children, `message` runs before continuing. For completed or failed children, `message` starts a fresh turn. Omitting `message` prompts the child to continue or stop if done.
- **Resumable vs. terminal.** Paused, quit, interrupted, completed, failed, and session-closed children are resumable. **Killed** (explicit owner or batch cancellation) and **Gone** (unrestorable after restart) children are terminal and reject `resume`. Running children also reject `resume` (`<agent> (<child-id>, <intercom-name>) is already running as task <task-id>; pause or quit it first.`); use Intercom to message a running child. Failed resumes preserve `worktree: true` checkouts.
- **Interrupting control calls.** Pressing `Esc` stops waiting on `pause`, `quit`, or `resume`. Stops already requested still complete, while unstarted resumes cancel cleanly.
- **SDK without task host.** `pause`, `quit`, and `resume` work identically; resumed children run in the background and deliver completion notices.
- **Removed actions.** `kill` and `interrupt` were removed. Calls fail and direct you to `{ action: "quit", id }`:

```text
The subagent action "kill" was removed. Use { action: "quit", id } to stop a child gracefully; it stays resumable with { action: "resume", id, message? }.
```

#### Messages that resume a finished child

Any session allowed to message a child under ordinary Intercom group and reach rules can bring it back. A single-target `send` or `ask` to a child that completed or failed returns at once with `queued: true`. The launching session resumes the child with its own model, tools, and agent definition, delivers the message first, and adds a prompt naming who sent it. An `ask` receives its reply later as a message.

A paused or quit child is not resumed by another session's message. The message waits until the launching session resumes the child, then arrives after that resume's `message`.

Queued messages survive Intercom broker crashes and machine restarts, and wait while the launching session is closed or disconnected. If a message can no longer reach the child because the child is cancelled or gone, or the launching session ends or stays away for 7 consecutive days, the sender receives one delivery failure. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent).

- **Resuming another session's child.** Calling `subagent({ action: "resume", id: "<intercom-name>", message })` for a child another session launched sends `message` through that wake queue. A running child rejects `resume` and tells you to message it over Intercom instead.
- **Ownership and bounds.** The launching session always keeps the resumed child, its completion notice, its `/tasks` and agent-panel row, and `pause` or `quit` control. Its transcript records which session's message resumed it. Messages resume a child at most 6 times in 10 minutes, and agents waking each other stop after 4 consecutive resumes.
- **Inactive children that cannot resume.** When a send or ask cannot resume a child (because it was permanently cancelled, it was a pattern send, resume bounds refused it, or the sender runs an older Atomic), Intercom returns an error naming its `resume` call while the parent stays connected, waiting up to 20 seconds if the parent is closing. See [Subagents with no live session](/intercom/reference#subagents-with-no-live-session).

#### Released subagents

A background subagent that waits more than one minute on a `detachable: true` tool call, a budgetless shell `wait`, an `intercom` `ask`, or a blocking `contact_supervisor` (`need_decision` or `interview_request`) is **released**. The waited call keeps running while the child releases its session, task, and Intercom socket and wakes automatically when the result arrives.

- **What you see.** The parent chat shows a dim, non-turn-starting notice `` `◌ <name> is waiting on <tool> (<call id>)` `` (`Subagent <name> released while waiting on <tool> (<call id>)`). `/tasks`, the agent panel, and the launch card list it under **Waiting** with `◌` and `waiting on <tool>`. `subagent({ action: "status" })` reports `released · waiting on <tool> (<call id>)`.
- **Late results.** If something else wakes the child first, the waited call returns as still running. When its result arrives later, or when a background shell the child launched finishes while released, the child receives a notice card in its own chat naming the tool, outcome, and output. The child reads each result once, and the notice starts its turn when nothing else does.
- **Continuation notes.** When Atomic continues a subagent automatically (after a restart, a `resume` without a message, or an arriving wake result), the child receives a short note in its chat (`Continuing after Atomic restarted`, `Continuing where it left off`, or `Woken: what it waited for arrived`). A `resume` with a message delivers both the message and the note in one turn.
- **Inspecting a released child.** Viewing the child on the chat screen shows its saved transcript without waking it, ending with the `◌` notice and any running shells. On the main screen, the newest waited shell shows a clickable `· alt+w opens it` hint, and `Alt+W` (`app.tasks.openWaited`) opens that shell in `/tasks` (`←` goes back).
- **Waking or holding.** Sending a message while viewing the child, sending an Intercom `send` or `ask`, or calling `resume` wakes it immediately. Pressing `x` twice or calling `pause` or `quit` stops auto-wake and holds arriving results until you `resume`.
- **Active waits and queued messages.** Any parent `action: "wait"` yields and reports the child released. Queued steering or follow-up messages, turn-starting Intercom or extension messages, and background notices accepted during release are persisted and delivered once on wake (`excludeFromContext: true` keeps cards only; `deliverAs: "nextTurn"` is not covered). Open Intercom asks to a released child stay open across local and [multi-node Intercom routing](/intercom/operations#running-intercom-across-machines).
- **Crash recovery and restarts.** Incoming wake results persist before reopening the child so a crash or failed wake keeps them for `resume`. If the launching session temporarily disconnects, Intercom holds messages for up to 20 seconds before returning retryable `recipient_owner_suspended`. On reopen after restart, detachable tool calls restart with the same call IDs and arguments (mark only idempotent tools `detachable: true`), while open local Intercom asks time out and multi-node DB asks stay alive.
- **Capacity and shell ownership.** A child that had already finished is not relaunched merely because an ask it sent was interrupted by a restart; it is notified the next time it runs. At most `parallel.runningCapacity` released children wake concurrently. A released child's background shells wake only that child, never the parent.

When tracking or waking a released child fails, `status` and notices report a typed `ReleasedChildError`:

| Code | Cause | Action |
| --- | --- | --- |
| `child-record-missing` | Current session has no record of this child. | Wake from the launching session. |
| `child-record-unreadable` | Child's latest record lives in a session not open here. | Open the launching session and retry. |
| `child-unrestorable` | Saved session or agent definition is missing or invalid. | Fix the reported cause and `resume`, or launch a new child. |
| `record-append-failed` | Could not persist child state to session storage (retryable). | Check session storage before relying on restart recovery. |
| `hold-failed` | Intercom broker could not reserve the released child (retryable; verified against restored reservations on reconnect, up to 5 seconds delay). | Confirm Intercom connectivity; until held, sends fail as not found. |
| `completion-not-held` | A child's shell finished after the child resumed or ended. | None. The notice waits for the child's next run. |
| `wake-failed` | Wake failed for another reason (retryable). | Results are preserved; call `resume` to retry. |

## Task inspection

Use `/tasks` (or `/tasks <id>`) or the agent panel below the prompt (`↓` on an empty prompt) to inspect running, waiting, and finished subagents and their nested shells.

- **Switch to a subagent.** Select a subagent row and press `Enter` (or click it) to view its live transcript and message it on the same chat screen. Press `←` on an empty prompt or select `main` in the panel to return without interrupting the child.
- **Pause or stop.** While viewing a working subagent, press `Esc` (or `Ctrl+C` on an empty prompt) to pause its turn without affecting the main chat. In `/tasks` or the agent panel, press `x` twice within 3 seconds to stop a running task resumably (a red `◯` stopped mark), or `x` once to dismiss a finished row.
- **Subagent shells and hints.** A subagent's running shells nest underneath it in the agent panel. On a subagent's page in `/tasks`, backgrounded shell blocks show a clickable `· /tasks to manage` hint that opens that subagent's own task list; on the main screen viewing a released subagent waiting on a shell, the newest waited shell shows a clickable `· alt+w opens it` hint.
- **Questions in subagents.** A subagent's `ask_user_question` or extension dialog waits inside that subagent's transcript (**Needs input**) without blocking the main chat. SDK hosts without a task inspector route `humanInput` by `sessionId` ([Human input without a terminal](/sdk#human-input-without-a-terminal)).

See [Background tasks](/background-tasks), [Viewing a subagent](/background-tasks#viewing-a-subagent), and [Shells started by subagents](/background-tasks#shells-started-by-subagents) for the full panel layout, key bindings, command-routing table, and `/tasks` controls.

## Orchestrator model and group policy

- Named agents use the model and fallbacks declared in their definition. Omit the per-call `model` argument unless the user requested a specific model or you have a recorded task-specific reason.
- When pinning a model, call `subagent({ action: "models" })` first and use only a returned `fullId` and supported thinking level. Never invent model IDs or inspect credentials.
- When the session has an active `enabledModels` / `--models` / `/scoped-models` scope, `subagent({ action: "models" })` returns only models matching that scope, and subagent launches and fallbacks enforce the same allowlist (skipping disallowed fallback candidates and rejecting disallowed explicit models). When unset or empty, all available models remain allowed.
- Children inherit the parent's Intercom group unless `group` is passed on the call or task (`contact_supervisor` still crosses group boundaries).

## Context and execution modes

### Fresh vs. forked context

- `context: "fresh"` starts an isolated in-process child session containing only the agent's prompt and task. Use `fresh` (the default unless an agent sets `defaultContext: fork`) for adversarial reviews and independent research.
- `context: "fork"` branches from the parent's settled entry and fails fast if the parent cannot be forked (it never downgrades to fresh). It inherits model, thinking level, tool changes, `atomic.appendEntry` data since the last clear, and referenced saved tool outputs without taking ownership of the parent's subagents or replaying parent Intercom cards.

Use `fork` when the child needs the parent's conversation. A forked child sends the exact conversation the parent last sent (system prompt, project context, skills, tools, and messages), followed by its own role, a short note, and its task. On the parent's model and thinking level, the first request reads from the parent's prompt cache and pays only for the new suffix; on another model or provider it reads nothing from that cache, and on another thinking level it may read only part of it.

In a fork, `inheritProjectContext` and `inheritSkills` do not hide what the parent already sent; those settings apply to fresh children. The child's own tool policy still applies: calling a tool outside the child's allowed list fails with an error naming the allowed tools. Where the provider supports mid-conversation tool changes, removed or child-only tools are declared after the parent conversation; otherwise child-only tools run through `codemode` restricted strictly to the child's own tools.

Fresh children inherit the parent's SDK config, discovery inputs, model and auth runtime, and host callbacks. Child tool lists can narrow permissions but cannot re-enable excluded tools or disabled packages. See [SDK child configuration](/sdk).

### Temporary worktrees (`worktree: true`)

Pass `worktree: true` to isolate parallel edits in temporary Git worktrees:

- Worktrees and branches are cleaned up once every child in the batch finishes, after saving each child's changes as a patch under `worktree-diffs/<run-id>`.
- Paused, quit, or session-closed children keep their worktree only if it has uncommitted or untracked changes or new commits. Clean worktrees are removed; `resume` recreates them from base plus the saved patch and writes later patches as `task-<n>-<agent>.<execution>.patch`. Permanently cancelled children release their worktrees, and unresumed stopped worktrees with changes remain under `.atomic/worktrees/`.
- `pause`, `quit`, completion, and failed resume wait for Git cleanup. Pressing `Esc` stops waiting without cancelling cleanup; cleanup taking over 10 seconds warns and continues in the background. Never delete a worktree while `worktreeNote` reports pending cleanup or a sibling hold, or after a crash without checking for orphaned Git processes.
- **Integration hook.** Subscribe to `atomic.events.on("subagent:finishing", ({ runId, index, taskId, cwd, status }) => ...)` before launch, or check `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` in Git filters, so external helpers do not block cleanup while waiting for the terminal report.

### Named worktrees

Run a child on an explicit branch and path with `worktree: { branch, base?, path? }` (cannot be combined with `worktree: true`):

```typescript
subagent({ agent: "worker", task: "Fix the parser", worktree: { branch: "fix/parser" } })
subagent({
  tasks: [
    { agent: "worker", task: "Add the API", worktree: { branch: "feat/api", base: "origin/main" } },
    { agent: "worker", task: "Add the UI", worktree: { branch: "feat/ui", path: "../ui-worktree" } },
  ],
})
```

- **Checkout rules.** `path` defaults to `.atomic/worktrees/<branch>` (`/` replaced with `+`). New branches start at `base` (resolved in the caller's worktree), then upstream, then `HEAD`. Unused existing branches check out as-is, and a branch already checked out at `path` is reused. Launch fails fast if the branch is checked out elsewhere or `path` holds something else.
- **Ownership.** Atomic never deletes a named worktree or its branch, saves no patch, and does not copy or link `node_modules`. Resuming reuses the worktree or checks the branch back out there if removed. Prefer `worktree: { ... }` over running `git worktree add` in the same turn, which races with sibling tool calls.
- **Concurrency and locks.** Different branches and paths run concurrently. Duplicate `(branch, path)` launches wait and reuse; the same branch at a different path fails after the first finishes. External `index.lock` files or initializing worktrees time out after 30 seconds (`another git process seems to be running at <path>`). Interrupted previous checkouts fail immediately (`an interrupted named-worktree checkout left an incomplete worktree at <path>`); on Git 2.30 to 2.32, they report busy after the 30-second wait instead.
- **Recovery.** Confirm no Git process is running, save needed files, run `git worktree unlock <path>`, remove the directory, run `git worktree prune`, and clear any stale `HEAD.lock` or branch `.lock` files (or run `git worktree remove --force --force <path>`). Never fix a partial checkout by deleting only `index.lock`, and never have Git checkout hooks synchronously spawn another named worktree for the same branch and path.

### Parallel config, bursts, `reads`, and `progress`

Configure parallel limits and restart recovery in `~/.atomic/agent/extensions/subagent/config.json`:

```json
{
  "parallel": {
    "maxTasks": 2000,
    "concurrency": 2000,
    "runningCapacity": 2000
  },
  "resumeInFlight": "ask"
}
```

- **`parallel.maxTasks`, `concurrency`, and `runningCapacity`.** All default to `1000` with no hard cap. Per-call `concurrency` overrides `parallel.concurrency`. `runningCapacity` takes effect when the first child starts, so restart Atomic after changing it.
- **`resumeInFlight`.** Controls paused or quit children awaiting resume on startup or `/resume` (not `/reload`, `/new`, or `/fork`): `"never"` (default, stay in **Awaiting resume**), `"ask"` (one confirmation prompt; falls back to `"never"` without a UI), or `"auto"` (resumes them automatically).
- **Sibling burst collection.** Multiple synchronous execution-mode `subagent` tool calls in one assistant message combine into one parallel run while projecting each caller's results and errors back to its original call. Shared options (`concurrency`, `worktree: true`, `context`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, `agentScope`) must match across sibling calls; `cwd` (must match for `worktree: true`), `group`, and named `worktree: { ... }` stay per call. Prefer one explicit `{ tasks: [...] }` call when planning parallel work.
- **`group`.** A named string joins that Intercom group; `true` creates a shared UUID group for a parallel set. Precedence is `explicit group`, then parent session group, then config, then `"default"`. Pending asks are per session.
- **`cwd` validation.** A missing or non-directory `cwd` fails before starting the child.
- **`reads: string[] | false` (single-agent).** Prepends file contents into child context, resolving relative paths against the child's effective `cwd`.
- **`progress: boolean`.** Creates a run-scoped `progress.md` in isolated subagent artifact storage (never inside child `cwd` or the repository; cleaned up on exit when `artifacts: false`; shared across parallel tasks). Omitting it inherits the agent's `defaultProgress` (suppressed for read-only tasks unless `progress: true`). This is separate from `includeProgress: true`, which adds runtime progress telemetry to the tool result.

```ts
subagent({ agent: "worker", task: "Implement the approved fix.", progress: true })
```

### Subagent start timeouts

Children have a 5-minute startup budget covering session open, resource load, agent session creation (including admission wait), and task dispatch. Queue wait under `parallel.runningCapacity` does not count. Override the budget in `~/.atomic/agent/extensions/subagent/config.json` (milliseconds, `1` to `2147483647`):

```json
{ "sessionStartTimeoutMs": 600000 }
```

Exceeding the budget fails with `SessionStartTimeoutError` (shown in `status` and serialized as `startError` for SDK callers):

| `phase` | Blocked on | Action |
| --- | --- | --- |
| `admission` | Waiting for a resource-admission session permit. | Free admission capacity and retry. |
| `setup` | Opening session, loading resources, or extension startup. | Check session storage or extensions, or raise `sessionStartTimeoutMs`, then retry. |
| `dispatch` | Session started, but `input` or `before_agent_start` blocked dispatch. | Inspect extension handlers and retry. |
| `event-loop` | The main thread was saturated during startup. | Reduce in-process load and retry. |

Rehydrate `startError` in SDK hosts (see [Session start errors](/sdk/reference#session-start-errors)):

```typescript
import { isSessionStartTimeoutError, rehydrateSessionStartError } from "@bastani/atomic";

if (result.startError) {
  const error = rehydrateSessionStartError(result.startError);
  if (isSessionStartTimeoutError(error) && error.phase === "admission") {
    // Free admission capacity, then relaunch.
  }
}
```

## Delegation and child boundaries

Delegation is fixed at one level: children cannot launch, `pause`, `resume`, or `quit` other children, and management-restricted children cannot `create`, `update`, or `delete` agent definitions. Children can still run background shells (nested under the subagent in the agent panel) and inspect status with `list`, `get`, `status`, and `wait`. Child prompts omit parent orchestration artifacts and prior control traffic.

<a id="custom-agents" />
<a id="fallback-models" />
<a id="reasoning-levels" />
<a id="owner-bound-task-projection" />

## Related docs

- [Custom subagents](/subagents/authoring#custom-agents) explains how to define and scope custom agents.
- [Subagent reference](/subagents/reference) covers [agent discovery](/subagents/reference#agent-discovery), [fallback models](/subagents/reference#fallback-models), [reasoning levels](/subagents/reference#reasoning-levels), and [owner-bound task projection](/subagents/reference#owner-bound-task-projection).
- [Orchestration](/orchestration) shows multi-step work with codemode and subagents.
- [Intercom](/intercom) covers cross-session messaging and supervisor escalation.
- [Skills](/skills) covers reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) covers user and project configuration.
