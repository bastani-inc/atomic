---
title: "Subagents"
description: "Run focused Atomic child agents"
---

# Subagents

Atomic bundles `@bastani/subagents` so the parent chat can delegate bounded work to specialist child agents with separate context. Nothing extra needs to be installed.

**When to delegate:**
- Delegate independent research, analysis, debugging, or parallel implementation work you can overlap with other steps.
- Keep interactive, exploratory, or immediately blocking tasks inline unless specialist focus or context isolation adds value.
- Every subagent runs in the background. Let completion notices notify the parent instead of polling, and call `subagent({ action: "wait", id })` only when the next step depends on a child's result.

See [Background tasks](/background-tasks) for the agent panel, `/tasks`, shell output, cancellation, and completion notices.

## Where to go next

- [Custom subagents](/subagents/authoring) — define, scope, and configure custom agents.
- [Subagent reference](/subagents/reference) — discovery order, `auto` model selection, fallbacks, reasoning levels, and task projection.

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

Atomic chooses the right specialist and execution shape (single child, parallel batch, or forked context). For multi-step work, the parent can also launch children from [codemode scripts](#from-codemode-scripts).

## Browse agents

Run `/agents` (or `/agents <query>`) to inspect project, user, package, and built-in agents:

- Type to filter by name, description, or source; select an agent and press `Enter` to view its model, fallbacks, tools, path, and system prompt.
- Press `Esc` to go back to the list, then back to chat.

`/agents` is read-only and never launches or edits agents. It uses the same discovery rules as execution, so shadowed or disabled definitions are hidden. Leaving it open does not mark [Herdr](/herdr) blocked.

## Let Atomic choose the child model

All built-in subagents default to `model: "auto"`, which runs your default model (last chosen with `/model`) at its default thinking level, or the launching session's model when no default is set. Per-call `model` overrides the default; custom agents without `model` inherit normally. See [Automatic model selection](/subagents/reference#automatic-model-selection).

- Providers without configured credentials are skipped before launch (recorded in model attempts).
- A provider that rejects credentials mid-run is skipped for subsequent fallbacks.
- If no candidate in the chain has credentials, launch fails immediately and lists each missing provider. See [Fallbacks and credentials](/models#fallbacks-and-credentials).

## Subagent execution is non-interactive

Subagent launches start immediately without preview prompts or terminal input (covering single, parallel, forked, fanout, and prompt-template runs). Ask any clarifying questions in the parent chat before delegating.

Subagents return their results directly—Atomic does not infer acceptance gates or inject/parse `acceptance-report` blocks. Put any required tests, commands, or evidence checks directly in the task prompt.

**Prompt-template bridge:** Out-of-tree `pi-prompt-template-model` callers emitting `prompt-template:subagent:request` that must survive extension reloads should register `registerPromptTemplateBridgeRequestSettlement` from `@bastani/subagents` before emitting and unregister on response, cancel, or abort.

## Background launches and waiting

Every `subagent` launch runs in the background and returns at admission (`reason: "default-background"`) with each child's `taskId` and `intercomTarget` (for example `subagent-worker-1a2b3c4d-1`). Use `intercomTarget` verbatim when messaging a child. Legacy calls that pass `wait` still run in the background; `wait: { kind: "foreground" }` adds a note explaining how to wait with `action: "wait"`.

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references." })
subagent({ action: "wait", id: "<taskId>", budgetMs: 120000 })
subagent({ action: "status", id: "<taskId>" })
```

- **Waiting:** `subagent({ action: "wait", id: taskId, budgetMs? })` observes an existing task in the same owner up to `budgetMs` (default `tasks.wait.agentBudgetMs`, `30000` ms). Ending a wait on budget or pressing `Esc` leaves the child running; wait for terminal completion before depending on its result. See [Choosing how long to wait](/background-tasks#choose-how-long-to-wait).
- **Concurrency:** Multiple single-agent launches in one turn share `concurrency` (or the configured parallel limit). Returning from launch or ending a wait does not free a running slot.
- **Heartbeats:** Running children send [task heartbeats](/background-tasks#task-heartbeats) every 15 minutes by default (current tool, idle time, turns, tool calls, tokens). Override with `heartbeatMs` on the call or task entry (`0` disables).
- **Startup progress & retries:** Before its first turn, `status` reports the exact startup step (`opening its session`, `loading its resources`, `waiting for a resource-admission permit`, `creating its agent session`, `registering on Intercom`, or `dispatching its task`) with elapsed times and a structured `start` field. If startup exceeds `sessionStartTimeoutMs` (default 5 minutes), it is marked `stalled` and retried once after releasing its session (if it still holds the session after half the budget, capped at 30 s, it fails without retrying). Two stalled attempts fail with `Subagent did not start: its start stalled <step> after <N>s and was retried once; the retry stalled <step> after <M>s`.
- **Settled output:** `wait` and `status` append up to 16 KB of output, `Full output: <path>` (a private copy; Atomic keeps the 256 most recent copies in a private temp directory and cleans them on exit), and `Requested output:` when an `output` file was specified. With `outputMode: "file-only"`, only the saved-file reference is returned inline.
- **Yielding to user or Intercom:** User steering (`input-needed`) or an inbound Intercom ask/send (`intercom-coordination`) yields active `wait` calls so the parent can respond without cancelling children or queued siblings. You can wait on the task again afterward.
- **Session close/reopen:** Closing a session stops running children; reopening it automatically restores unfinished children from their saved sessions.

## Supervisor coordination

All built-in specialists include `intercom`. `debugger` and `worker` also include `contact_supervisor` for escalating decisions to the parent. Parent tool allowlists, exclusions, `noTools`, and disabled Intercom still apply. A child without `read` or `search` receives a read-only `session_history` tool after compaction so it can recover its own history (see [Agents without read or search](/compaction#agents-without-read-or-search)).

- **Blocking requests:** `intercom.ask`, `contact_supervisor({ reason: "need_decision" })`, and `interview_request` block only the requesting child. The supervisor answers via `intercom({ action: "reply", message: "..." })` (use `pending` and `replyTo` when multiple asks are open). The reply resumes the same child execution—never relaunch the child to answer it.
- **Non-blocking updates:** `intercom.send` and `contact_supervisor` progress updates return immediately without cancelling or disrupting siblings or worktrees.
- **Messaging a running child:** Children register on Intercom before their first turn (retrying while starting if the broker is briefly unreachable; supervisor authorization retries for up to 30 seconds across broker restarts before starting without it). Use `intercom` `send` or `ask` with the child's name or full ID from `intercom list`. Choose `delivery` by urgency:

| `delivery` | When a busy recipient handles it | Best for |
| --- | --- | --- |
| `"steer"` (default) | After current tool calls finish (work is not cancelled) | Coordination, findings, updates |
| `"followUp"` | After the recipient finishes and stops | Low-priority follow-ups |
| `"interrupt"` | Immediately cancels the active model or cancellable tool call (non-cancellable tools finish; side effects stay) | Urgent corrections or stop orders |

- **Automatic restore on reopen:** If Atomic exits, crashes, or you switch sessions (`/new`, `/resume`, `/fork`), running children stay resumable and relaunch automatically when you reopen the launching session—keeping their Intercom name, group, model, thinking level, original agent definition, `context: "fork"` bridge instructions, and unread queued steering/follow-up messages (delivered once in order). Inbound Intercom messages wait while the child restores (see [Intercom operations](/intercom/operations#connection-states-and-recovery)). Finished, paused, quit, and permanently cancelled children are not auto-relaunched, and session forks (`/fork`, `--fork`) never relaunch the original session's children. If a child cannot be restored (for example its session or agent definition is missing), Atomic emits one recovery notice with its IDs, worktree/branch, `git` inspection commands, and relaunch call, then marks it gone.
- **Child session storage:** Saved alongside the parent's session file when file-backed, or under `~/.atomic/agent/subagent-sessions/<parent-session-id>/` for database-backed parents.
- **Terminal children:** Completed, failed, interrupted, and cancelled non-interactive children immediately reject new Intercom `ask` calls with a terminal-child error (pending asks also fail if the child terminates before replying). Use `resume` or launch a fresh child for follow-up work.

### Peer coordination

Peer-to-peer coordination is the default: siblings in a parallel set (or sharing an explicit `group`) discover each other via `intercom({ action: "list" })` and communicate directly with `send` and `ask`, rather than relaying through the supervisor.

- Share findings, divide file ownership or expensive test runs, reuse verified reproductions, and challenge disagreements with evidence; each child still returns its own complete result.
- `contact_supervisor` remains reserved for supervisor decisions, and ordinary Intercom group boundaries and user approval gates still apply. Peer asks and one blocking supervisor ask can wait concurrently. See `/skill:intercom` for ready-made peer patterns.

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

- **Parallel limits:** `parallel.maxTasks`, `parallel.concurrency`, and `parallel.runningCapacity` each default to `1000` (no hard upper cap; raise all three in `config.json` to exceed 1,000, or lower `parallel.concurrency` to throttle). Provider rate limits and host memory remain practical bounds.
- **Nesting:** Delegation is strictly one level deep—only the parent launches children.
- **Teams:** Intercom groups have no member cap. Assign each team its own `group` for internal messaging; members can still reach the parent via `contact_supervisor`.

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
| Current behavior & regressions | `codebase-analyzer` with file:line citations |
| Failure modes | `debugger` in inspect-only mode (no edits) |
| Project conventions | `codebase-pattern-finder` |
| Prior decisions | `codebase-research-locator` → `codebase-research-analyzer` |
| External API conformance | `codebase-online-researcher` |

```text
Review the current diff with fresh-context specialists: analyze correctness, inspect failure modes without editing, and compare the implementation to existing patterns. Synthesize only issues worth fixing now.
```

## From codemode scripts

When both `codemode` and `subagent` are active, `tools.subagent()` launches the same background children and resolves at admission (**not** completion). Admitted children belong to the parent session and continue even if the script returns, throws, or times out. Subagents cannot launch nested children from codemode.

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

- **`list` / `get` / `models`:** Inspect executable `agents`, matching `definitions`, or the model catalog (`fullId`, `isCurrent`, `availableThinkingLevels`). Creating, updating, or deleting agent definitions requires a direct tool call.
- **`status`:** Returns `children` launched by this session (pass `id` for one child) with state and any `resumeCall`. Use `status` after reopening a parent to rediscover children rather than relaunching.
- **`wait`:** Takes a **task** `id` and optional `budgetMs` (default 30 s, even if the owner waits indefinitely; `0` checks immediately). Script timeouts cancel `wait`, not the child. Returns `outcome: "settled"` (with `childId`, `result.status`, output excerpt, `outputPath`, and `resumeCall`) or `running`.
- **`pause` / `quit` / `resume`:** `pause` and `quit` accept `id` or `all: true`; `resume` takes `id` and optional `message` and returns the new task ID in `children`. Always pass `id` (not the legacy `runId` alias).
- **Temporary worktrees:** `status` can show `finishing` while `wait` still returns `running`. Check `worktreeNote` / `worktreeNotes` before removing any worktree directory.

## Waiting and control

- **Working line (`∀`):** Shows the `∀` status line with verb, elapsed time, and tokens (`↑` waiting for content, `↓` streaming; zero counts stay hidden) for whichever agent you are viewing. Retries and fallbacks continue the same count, and switching away and back preserves elapsed time.
- **Launch cards:** Each child renders `Agent(<agent> · <short task title>)` with state, elapsed time (dispatch to finish/stop/release, excluding queue/cleanup time), and tokens. Press `Ctrl+O` to expand prompt, tool calls, and result (only expanded cards load those fields from the saved session, and they release memory on collapse or session switch). Parallel launches show one card per child; the call fails only if zero children start.
- **Model metadata:** Live progress, `/tasks`, and run status show each step's resolved model and capability-clamped reasoning effort (including fast model IDs like `openai-codex/gpt-5.6-sol-fast · thinking medium`). Compact launch cards and completion notices omit the model line to save space while persisting metadata in saved details.
- **Status history:** Atomic retains in-process status for the 256 most recent finished runs (active runs are always kept). Older children remain resumable via `subagent({ action: "resume", id })`.
- **Cancelling parent turn:** Pressing `Esc` in the parent ends `action: "wait"`, not the child. In an SDK session without a task host, cancelling the waiting `subagent` call stops children permanently and returns labelled partial findings (`progress.md`, last assistant text, or artifact paths).

### Run control

Control children with `pause`, `quit`, and `resume`. `id` accepts a child ID (`<runId>:<index>`), task ID, Intercom name, or single-child run ID:

```ts
subagent({ action: "pause", id: "<child-id>" })   // Stop now; hold queued messages for resume
subagent({ action: "pause", all: true })          // Pause all running children of this session
subagent({ action: "quit", id: "<child-id>" })    // Graceful stop; stays resumable
subagent({ action: "quit", all: true })           // Covers running and already-paused children
subagent({ action: "resume", id: "<child-id>", message: "Focus on the failing test first." })
```

- **`pause`** stops the active turn and keeps queued steering/follow-up messages to deliver once in order before `resume`'s `message`. Intercom messages to a paused child do not resume it: they wait, with no time limit, and reach it after `resume`'s `message`.
- **`quit`** stops the child gracefully (including paused children) while keeping it resumable.
- **Awaiting resume:** Paused and quit children report `paused · awaiting resume` (`Subagent worker quit · paused, awaiting resume: …` with `Stop reason: quit`/`pause`) and include the exact `subagent({ action: "resume", id: "<child-id>" })` call. `status` lists them under **Awaiting resume** across restarts without auto-relaunching. Completed or failed notices state execution ended and also provide the `resume` call and Intercom name.
- **Queued parallel children:** You can `pause` or `quit` a child still waiting for a concurrency slot. `resume` starts it with its original task (plus optional `message`), original model/thinking/worktree/fork copy, and re-enters the concurrency queue. If its original model or fork copy no longer exists, `resume` reports it as gone rather than substituting silently.
- **`resume`** continues the child's saved session under the same child ID, Intercom name, and group with fresh supervisor auth (`all: true` is not supported). For paused/quit/interrupted children, `message` runs first before continuing; for completed/failed children, `message` runs as a fresh turn. Omitting `message` prompts it to continue or stop if done.
- **Resumable vs. terminal:** Paused, quit, interrupted, completed, failed, and session-closed children are resumable. **Killed** (explicit owner/batch cancellation) and **Gone** (unrestorable after restart) children are terminal and reject `resume`. An id that is neither a child this session launched nor a subagent it can message is rejected too. Running children also reject `resume` (`<agent> (<child-id>, <intercom-name>) is already running as task <task-id>; pause or quit it first.`)—use Intercom to message a running child. Failed resumes preserve `worktree: true` checkouts.
- **Messages resume a finished child:** Any session that can message a child under the usual Intercom group and reach rules can bring it back. A `send` or `ask` to one child that **completed or failed** returns at once with the message queued; the session that launched the child resumes it with its own model, tools and agent, and the child gets the message first, then a prompt naming who sent it. An `ask` gets its reply later, as a message. A **paused or quit** child is not resumed by someone else's message: the message waits until the session that launched it resumes it, and reaches it after that resume's `message`. Queued messages survive an Intercom broker restart, including a crash or a machine restart. While the session that launched the child is away (closed, or not reconnected yet), they wait for it and it resumes or continues the child when it is back. If the message can no longer reach the child, because the child is cancelled or gone, or the session that launched it ends, or stays away for 7 days in a row, the sender gets one delivery failure for that message instead; send it again if it is still needed. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent).
- **Resuming another session's child:** `subagent({ action: "resume", id: "<intercom-name>", message })` of a child this session did not launch sends it `message` as such a message. A running child is not resumed; the call says to message it instead.
- **Who keeps a resumed child:** The session that launched it, whoever resumed it: its result and completion notice come back there, it keeps its `/tasks` and agent panel row, and only that session can pause or quit it. That session's transcript shows whose message resumed it. Messages resume a child at most 6 times in 10 minutes, and agents waking each other in turn stop after 4 resumes in a row.
- **Intercom to inactive children:** A send or ask that does not resume a child (it was cancelled for good, it is a pattern send, the resume bounds refused it, or the sender runs an older Atomic) returns a descriptive error with its `resume` call while its parent is connected (waiting up to 20 s if closing in case it reconnects). See [Subagents with no live session](/intercom/reference#subagents-with-no-live-session).
- **Interrupting control calls:** Pressing `Esc` stops waiting on `pause`/`quit`/`resume`; stops already requested still complete, while unstarted resumes cancel cleanly.
- **SDK without task host:** `pause`, `quit`, and `resume` work identically; resumed children run in the background and deliver completion notices.
- **Removed actions:** `kill` and `interrupt` were removed; calls fail and direct you to `{ action: "quit", id }`:

```text
The subagent action "kill" was removed. Use { action: "quit", id } to stop a child gracefully; it stays resumable with { action: "resume", id, message? }.
```

#### Released subagents

A background subagent that waits more than one minute on a `detachable: true` tool call, a budgetless shell `wait`, an `intercom` `ask`, or a blocking `contact_supervisor` (`need_decision` / `interview_request`) is **released**: the waited call keeps running, while the child releases its session, task, and Intercom socket and wakes automatically when the result arrives.

- **What you see:** The parent chat shows a dim, non-turn-starting notice `` `◌ <name> is waiting on <tool> (<call id>)` `` (`Subagent <name> released while waiting on <tool> (<call id>)`). `/tasks`, the agent panel, and the launch card list it under **Waiting** with `◌` and `waiting on <tool>`. `subagent({ action: "status" })` reports `released · waiting on <tool> (<call id>)`.
- **Inspecting & waking:** Viewing the child on the chat screen shows its saved transcript without waking it; press `Alt+W` (`app.tasks.openWaited`) to view its newest running shell (`←` goes back). Sending a message while viewing it, sending an Intercom `send`/`ask`, or calling `resume` wakes it immediately. Pressing `x` twice (or calling `pause`/`quit`) stops auto-wake and holds arriving results until you `resume`.
- **Active waits & messages:** Any parent `action: "wait"` yields and reports the child released. Queued steering/follow-up messages, turn-starting Intercom/extension messages, and background notices accepted during release are persisted and delivered once on wake (`excludeFromContext: true` keeps cards only; `deliverAs: "nextTurn"` is not covered). Open Intercom asks to a released child remain open across local and [multi-node Intercom routing](/intercom/operations#running-intercom-across-machines) and can be answered once it wakes.
- **Results & restarts:** Incoming wake results are persisted before reopening the child, so a crash or failed wake keeps them for `resume`. If the launching session temporarily disconnects, Intercom holds messages for up to 20 seconds before returning retryable `recipient_owner_suspended`. On reopen after restart, detachable tool calls restart with the same call IDs and arguments (only mark idempotent tools `detachable: true`); open Intercom questions are not re-sent (local broker restarts time them out; multi-node DB questions stay alive). A child that had already finished is not relaunched only because a question it asked was interrupted by the restart; it is told once, the next time it runs. At most `parallel.runningCapacity` released children wake concurrently. A released child's background shells wake only that child, never the parent.

When tracking or waking a released child fails, `status` and notices report a typed `ReleasedChildError`:

| Code | Cause | Action |
| --- | --- | --- |
| `child-record-missing` | Current session has no record of this child. | Wake from the launching session. |
| `child-record-unreadable` | Child's latest record lives in a session not open here. | Open the launching session and retry. |
| `child-unrestorable` | Saved session or agent definition is missing/invalid. | Fix the reported cause and `resume`, or launch a new child. |
| `record-append-failed` | Could not persist child state to session storage (retryable). | Check session storage before relying on restart recovery. |
| `hold-failed` | Intercom broker could not reserve the released child (retryable; verified against restored reservations on reconnect, up to 5 s delay). | Confirm Intercom connectivity; until held, sends fail as not found. |
| `completion-not-held` | A child's shell finished after the child resumed or ended. | None—the notice waits for the child's next run. |
| `wake-failed` | Wake failed for another reason (retryable). | Results are preserved; call `resume` to retry. |

## Task inspection

Use `/tasks` (or `/tasks <id>`) to inspect background subagents and shells (excluding shells a tool call is actively waiting on). You can also press `↓` on an empty prompt to focus the agent panel below the prompt, select a subagent row, and press `Enter` to view it on the chat screen.

| Key | Action in `/tasks` |
| --- | --- |
| `Space` | Toggle inline peek card (model, reasoning, activity, usage, plus quick reply box for working subagents) |
| `Enter` / `→` | View the selected subagent on the chat screen, or open a shell's output tail |
| `x` twice (within 3 s) | Stop a running task (quits subagents resumably → **Stopped**, a red `◯`) |
| `x` once | Dismiss a finished row |
| `Esc` / `←` | Go back one view without stopping work |

- **Header counts:** **Needs input**, **Working**, **Waiting** (released subagents), and **Done**.
- **Model column:** Each subagent row names the model it runs on now and its reasoning level after its name, for example `debugger  github-copilot/claude-opus-5.5 medium  Read the template…`, as the agent panel does. It changes when the subagent falls back to one of its `fallbackModels`, is resumed on a different model, or changes its level, so a row never keeps naming a model the subagent left.
- **Questions in subagents:** A subagent's `ask_user_question` or extension dialog waits in that subagent's transcript (flagged as **Needs input** in the panel and `/tasks`); the main chat stays usable and never answers accidentally. Viewing that subagent shows the form at the bottom of its transcript and gives it focus until answered. Opening `/tasks` while main chat has a question preserves the main-chat question. In multi-question forms, `←` steps back through tabs without clearing typed drafts; `Esc` cancels without approving; `PageUp`/`PageDown` pages >10 options or scrolls the transcript. SDK hosts without a task inspector route `humanInput` by `sessionId` ([Human input without a terminal](/sdk#human-input-without-a-terminal)).
- **Single chat screen:** Selecting a subagent from the agent panel or `/tasks` swaps the transcript area to that subagent's live transcript and points the same prompt box at it (top rule `debugger · #5220 spawn lock · 18m`, empty prompt `Message @debugger…` or `Answer @debugger…`). The agent panel stays below the prompt, marks the viewed agent with `●`, keeps it listed while viewed (even after it finishes), and nests its running background shells underneath it. Press `←` on the empty prompt (the hint reads `← main chat`), or select `main` in the panel and press `Enter` (or click `main`), to switch back; the subagent keeps running. Sending a message to a finished or stopped subagent resumes its saved session in the same task. If a viewed subagent is dismissed or removed, the screen returns to `main` and places any unsent draft in front of main's prompt with a notice.
- **Messages, history, and commands:** What you type goes to the viewed subagent's own session, as in the main chat. While it works, `Enter` queues a steering message and `Alt+Enter` a follow-up (`Steering:` / `Follow-up:` rows above the prompt); `Alt+Up` brings queued messages back into the prompt. Each agent keeps its own draft and prompt history (`↑`/`↓` and `Ctrl+R`). Skills (`/skill:<name>`), prompt templates, and user or project extension commands go to the viewed subagent, using its own skills and working directory (`@` and `Tab` complete under its directory). Built-in commands run on `main` (asking first for conversation-rewriting commands such as `/compact`, `/tree`, `/fork`, `/clone`, `/new`, and `/import`, which then run while the subagent stays shown unless they replace the main session; switching to `main` first for transcript output such as `/session` and `/tools`; `/resume` opens its picker in place); `/model`, `/thinking`, and `!` shell commands are refused with a notice; `/copy` copies the viewed subagent's last message. See [Viewing a subagent](/background-tasks#viewing-a-subagent) for the full command table.
- **Esc pauses the subagent:** Pressing `Esc` while the viewed subagent works pauses it without affecting the main chat: its queued messages come back into the prompt, steering first, and its current turn ends. A message it has just received but not yet begun to answer stays in its transcript and is not sent again. `Ctrl+C` on an empty prompt pauses it the same way; neither `Esc` nor `Ctrl+C` switches back to `main`. It keeps its session and task: the prompt reads `Paused · send to continue`, the footer shows `esc to pause` while it works, and `/tasks` lists it under **Working** as `‖ paused`. Only a message you send continues it; messages from other agents, its background work's notices, and heartbeats wait until then. It stays paused if Atomic restarts and you continue or resume the session. `x` still stops it.
- **Transcript fidelity:** Live transcripts stream updates, support `Ctrl+T` (thinking), `Ctrl+O` (tool output), and click-to-expand, and load older history on scroll-up (`Transcript unavailable` if uncaptured). Stopping with `x` posts a **quit · awaiting resume** notice to the owning chat.

## Orchestrator model and group policy

- Named agents use the model and fallbacks declared in their definition—omit the per-call `model` argument unless the user requested a specific model or you have a recorded task-specific reason.
- When pinning a model, call `subagent({ action: "models" })` first and use only a returned `fullId` and supported thinking level. Never invent model IDs or inspect credentials.
- Children inherit the parent's Intercom group unless `group` is passed on the call/task (`contact_supervisor` still crosses group boundaries).

## Context and execution modes

### Fresh vs. forked context

- `context: "fresh"` — starts an isolated in-process child session with only the task and agent prompt (preferred for adversarial reviews and independent research). Its context is small: the agent's prompt and the task.
- `context: "fork"` — branches from the parent's settled entry (fails fast if the parent cannot be forked; never downgrades to fresh). Inherits model, thinking, tool changes, `pi.appendEntry` data since the last clear, and referenced saved tool outputs, without taking ownership of the parent's subagents or replaying parent Intercom cards.

Use `fork` when the child needs the parent's conversation. A forked child sends the parent's conversation exactly as the parent last sent it: the same system prompt, including the project context and skills the parent was sent, the same tools and the same messages, including the parent's earlier subagent calls. Its own role, a short note and its task come after it. When the child runs on the parent's model and thinking level, its first request is read from the parent's prompt cache, so it pays for the new part only. On another model or provider it reads nothing from it; on another thinking level it may read only part of it, depending on the model. The cache statistics name the cause. Every later request carries that conversation too, mostly read from the cache. Use `fresh` for independent work that needs none of it. The default stays `fresh` unless an agent sets `defaultContext: fork`.

In a fork, the agent's `inheritProjectContext` and `inheritSkills` settings do not hide what the parent already sent; they apply to fresh children. To keep the project context and skills out of a child, launch it with `context: "fresh"`. The child's tool policy does apply: it can call only its own tools, and a call to another tool the parent declared fails with an error naming the tools it may call. Where the provider takes tool changes mid-conversation, the removed tools are also declared after the conversation. A tool only the child has is declared after the conversation where the provider can add one; otherwise it is reached through the parent's `codemode`, and is added to the tool list only when the parent has no `codemode`, which the cache statistics show as a tool change. When the parent has `codemode` and the agent does not, the fork can call it, but only as a way to reach its own tools: its scripts cannot call `models` or any tool outside the child's tools, so the fork can do nothing a fresh child of the same agent could not. A forked child started by this version keeps sending the same start when it is reopened; one reopened under different inheritance or fan-out settings sends its own prompt instead. A forked child started by an earlier version is reopened as the child it was, under its own prompt and tools.

Fresh children inherit the parent's SDK config, discovery inputs, model/auth runtime, and host callbacks. Child tool lists can narrow permissions but cannot re-enable excluded tools or disabled packages. See [SDK child configuration](/sdk).

### Temporary worktrees (`worktree: true`)

Pass `worktree: true` to isolate parallel edits in temporary git worktrees:

- Worktrees and branches are cleaned up once every child in the batch finishes, after saving each child's changes as a patch under `worktree-diffs/<run-id>`.
- Paused, quit, or session-closed children keep their worktree only if it has uncommitted/untracked changes or new commits (clean worktrees are removed; `resume` recreates them from base + saved patch and saves subsequent patches as `task-<n>-<agent>.<execution>.patch`). Permanently cancelled children release their worktrees. Unresumed stopped worktrees with changes remain under `.atomic/worktrees/`.
- `pause`, `quit`, completion, and failed resume wait for Git cleanup (pressing `Esc` stops waiting without cancelling cleanup; cleanup >10 s warns and continues in background). Never delete a worktree while `worktreeNote` reports pending cleanup or a sibling hold, or after a crash without checking for orphaned Git processes.
- **Integration hook:** Subscribe to `pi.events.on("subagent:finishing", ({ runId, index, taskId, cwd, status }) => ...)` before launch—or inspect `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` in Git filters—so external helpers do not block cleanup waiting for the terminal report.

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

- **Checkout rules:** `path` defaults to `.atomic/worktrees/<branch>` (`/` replaced with `+`). New branches start at `base` (resolved in caller's worktree), else upstream, else `HEAD`. Unused existing branches check out as-is; a branch already checked out at `path` is reused. Fails fast if the branch is checked out elsewhere or `path` holds something else.
- **Ownership:** Atomic never deletes a named worktree or its branch, saves no patch, and does not copy/link `node_modules`. Resuming reuses it (or checks the branch back out there if removed). Prefer `worktree: { ... }` over running `git worktree add` in the same turn, which races with sibling tool calls.
- **Concurrency & locks:** Different branches/paths run concurrently; duplicate `(branch, path)` launches wait and reuse; same branch at a different path fails after the first finishes. External `index.lock` or initializing worktrees time out after 30 s (`another git process seems to be running at <path>`); interrupted previous checkouts fail immediately (`an interrupted named-worktree checkout left an incomplete worktree at <path>`). Recover by confirming no Git process is running, saving needed files, running `git worktree unlock <path>`, removing the directory, running `git worktree prune`, and clearing any stale `HEAD.lock` or branch `.lock` files (or `git worktree remove --force --force <path>`). Never fix a partial checkout by deleting only `index.lock`. Transient `commondir` read races from external `git worktree add` retry up to 5 times over 1 s while the target is empty. Git checkout hooks must not synchronously spawn another named worktree for the same branch/path.

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

- **`parallel.maxTasks` / `concurrency` / `runningCapacity`:** All default to `1000` (no hard cap). Per-call `concurrency` overrides `parallel.concurrency`. `runningCapacity` takes effect when the first child starts (restart Atomic after changing it).
- **`resumeInFlight`:** Controls paused/quit children awaiting resume on startup or `/resume` (not `/reload`, `/new`, or `/fork`): `"never"` (default, stay in **Awaiting resume**), `"ask"` (one confirmation prompt; falls back to `"never"` without a UI), or `"auto"` (resumes them automatically).
- **Sibling burst collection:** Multiple synchronous execution-mode `subagent` tool calls in one assistant message are collected into one parallel run while projecting each caller's own results and errors back to its original call. Shared options (`concurrency`, `worktree: true`, `context`, `share`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, `agentScope`) must match across sibling calls; `cwd` (must match for `worktree: true`), `group`, and named `worktree: { ... }` stay per call. Output-path conflicts inside one call fail only that call; cross-call conflicts fail the burst. Prefer one explicit `{ tasks: [...] }` call when planning parallel work.
- **`group`:** Named string joins that Intercom group; `true` creates a shared UUID group for a parallel set. Precedence: `explicit group > parent session group > config > "default"`. Pending asks are strictly per session.
- **`cwd` validation:** Missing or non-directory `cwd` fails before starting the child.
- **`reads: string[] | false` (single-agent):** Prepends file contents into child context (relative paths resolve against effective child `cwd`).
- **`progress: boolean`:** Creates a run-scoped `progress.md` in isolated subagent artifact storage (never in child `cwd` or repo; cleaned up on exit if `artifacts: false`; shared across parallel tasks). Omitted inherits the agent's `defaultProgress` (suppressed for read-only tasks unless `progress: true`). Distinct from `includeProgress: true`, which adds runtime progress telemetry to the tool result.

```ts
subagent({ agent: "worker", task: "Implement the approved fix.", progress: true })
```

### Subagent start timeouts

Children have a 5-minute startup budget covering session open, resource load, agent session creation (including admission wait), and task dispatch (queue wait under `parallel.runningCapacity` does not count). Override in `~/.atomic/agent/extensions/subagent/config.json` (milliseconds, `1`–`2147483647`):

```json
{ "sessionStartTimeoutMs": 600000 }
```

Exceeding the budget fails with `SessionStartTimeoutError` (shown in `status` and serialized as `startError` for SDK callers):

| `phase` | Blocked on | Action |
| --- | --- | --- |
| `admission` | Waiting for a resource-admission session permit. | Free admission capacity and retry. |
| `setup` | Opening session, loading resources, or extension startup. | Check session storage/extensions or raise `sessionStartTimeoutMs`, then retry. |
| `dispatch` | Session started but `input` / `before_agent_start` blocked dispatch. | Inspect extension handlers and retry. |
| `event-loop` | Main thread saturated (fewer than 100 loop turns at ≥200 ms/turn over the budget). | Reduce in-process load and retry. |

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

Delegation is fixed at one level: children cannot launch, `pause`, `resume`, or `quit` other children (and management-restricted children cannot `create`/`update`/`delete` agent definitions). Children can still run background shells (listed as nested rows under the subagent in the agent panel) and inspect status via `list`, `get`, `status`, and `wait`. Child prompts omit parent orchestration artifacts and prior control traffic.

<a id="custom-agents" />
<a id="fallback-models" />
<a id="reasoning-levels" />
<a id="owner-bound-task-projection" />

## Related docs

- [Custom subagents](/subagents/authoring#custom-agents) — define and scope custom agents.
- [Subagent reference](/subagents/reference) — [agent discovery](/subagents/reference#agent-discovery), [fallback models](/subagents/reference#fallback-models), [reasoning levels](/subagents/reference#reasoning-levels), and [owner-bound task projection](/subagents/reference#owner-bound-task-projection).
- [Orchestration](/orchestration) — multi-step work with codemode and subagents.
- [Intercom](/intercom) — cross-session messaging and supervisor escalation.
- [Skills](/skills) — reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) — user and project configuration.
