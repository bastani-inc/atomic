---
title: "Background and parallel work"
description: "Run subagents and shell tasks while continuing your conversation"
---

# Background tasks

Background subagents keep working after the launch call returns. You can continue chatting without restarting them or keeping a task list open.

In main chat and live workflow-stage chat, a compact indicator appears **below the prompt box and MCP status**, and above the workflow `BACKGROUND` widget when present:

```text
Tasks  2 local agents running · 1 queued · /tasks
```

The indicator counts active agents and shells, including queued, stopping, and attention-needed tasks. Completed, failed, and stopped tasks leave it immediately. It disappears when no background work is active. Quiet tasks do not expire.

### Open the task inspector

Run `/tasks` to inspect work without stopping it:

- The compact picker opens in the editor slot, with the conversation visible above it. It lists only tasks owned by that chat.
- Within the **Agents** and **Shells** sections, tasks are ordered by status: running (tasks needing attention first), stopping, queued, failed, cancelled, then completed. The newest launch or settlement comes first within each status, and your selection follows its task when it moves.
- Detail, transcript, input, and cancellation-confirmation pages use the full screen.
- Escape returns to the picker with your selection preserved, then to chat.
- Completed background work remains available, including after a later foreground wait. Foreground-only commands are excluded.
- Updates never open or close the inspector automatically. Closing it does not stop tasks.

Results and failures remain in completion cards and `/tasks` after leaving the live indicator. The command appears in workflow-stage slash suggestions even when skill commands are disabled.

Main and workflow-stage pickers share the same layout. Their footers retain the chat's resolved model and reasoning level, current folder and Git branch, and MCP status, including during foreground streaming.

Opening `/tasks` is navigation, not approval. It does not mark the agent blocked in Herdr or produce a "Main chat needs input" notice. A genuine question waiting behind the workflow graph still shows that notice until answered or the graph is hidden or closed.

## Choose how long to wait

The agent can choose foreground-first or background observation for each authorized shell or subagent call. Choosing a mode does not require a separate user confirmation and does not relax tool permissions or task ownership.

For ordinary shell commands, leave `wait` out rather than routinely requesting one-second waits. Short waits can background otherwise brief commands and add follow-up calls without speeding up execution. Use explicit background observation when you have independent work to do, and a short budget only when you need control back sooner. Explicit budgets remain supported on every platform.

Keep immediately blocking work local unless a specialist, isolated context, or your explicit delegation request makes a subagent worthwhile. After spawning, continue independent work without duplicating the child's task. Wait when its result becomes a dependency; otherwise rely on completion notices rather than repeated short waits or status polls.

| Call | Observation behavior |
| --- | --- |
| `bash` or `powershell` without `wait` | Waits for the owner's command observation budget, normally 10 seconds, then automatically returns if still running. |
| `subagent` without `wait` | Returns after admission; the child runs in the background by default. |
| Any of these tools with `wait: { kind: "background" }` | Explicitly returns after admission without waiting for execution to finish. |
| Any of these tools with `wait: { kind: "foreground" }` | Waits for the owner's observation budget, normally 10 seconds for shells and 30 seconds for agents. |
| Any of these tools with `wait: { kind: "foreground", budgetMs: 1000 }` | Waits up to one second, then automatically yields if the original task is still running. |

If the task finishes during observation, the call returns its terminal result instead. Automatic backgrounding is **observation expiry**, not a slow-task failure, a restart, or a second execution. Use foreground-first observation for a dependency and background observation for independent work. If a dependency yields, wait for its actual completion before using the result.

Shell `budgetMs` accepts finite non-negative milliseconds; zero means no observation delay. On command launches it belongs inside a foreground `wait`; existing-task `action: "wait"` calls take it at the top level. A trusted SDK host can override the usual budgets or select `tasks.wait.kind: "until-settled"`; omitted foreground budgets then wait until settlement. Explicit per-call budgets still take precedence.

A zero-budget wait may return a background state immediately. It still refers to the same task; execution continues.

## Background subagents

Ask Atomic to delegate a bounded task:

```text
Have a codebase-analyzer trace the authentication flow in the background.
Keep working with me here while it runs.
```

For tool callers, owner-bound launches default to background observation. Explicit examples:

```ts
subagent({
  agent: "codebase-analyzer",
  task: "Trace the authentication flow. Do not edit files.",
  wait: { kind: "background" },
})

subagent({
  tasks: [
    { agent: "codebase-analyzer", task: "Trace request authentication." },
    { agent: "codebase-pattern-finder", task: "Find authorization test patterns." },
  ],
  concurrency: 2,
  wait: { kind: "background" },
})
```

Parallel tasks have independent identities. Accepted work beyond the concurrency limit stays queued. Use `/agents` to browse available definitions before choosing an agent.

Intercom communication does not cancel a parallel batch. A blocking ask or supervisor decision waits only in the requesting child and resumes that same execution after the matching reply. Sends and progress updates remain nonblocking. Foreground observations may yield so the parent can reply; execution concurrency, queued siblings, and task identities are preserved. Stop a selected task explicitly, or close its owner to cancel all owned work.

A launch result says **Launched in background**. This records what happened at launch; it is not a permanently live status label. The below-prompt indicator and `/tasks` show the current state.

### Waiting is not restarting

When specialist delegation is useful and its result is needed next, use foreground observation:

```ts
subagent({
  agent: "codebase-analyzer",
  task: "Trace the authentication flow.",
  wait: { kind: "foreground", budgetMs: 30000 },
})
```

If that observation budget expires, the same child continues in the background. It is not an execution timeout. Observe the task ID returned by the original call:

```ts
subagent({ action: "wait", id: taskId })
subagent({ action: "status", id: taskId })
```

To stop, hold, or continue a child, use `pause`, `quit`, and `resume`; see [Run control](/subagents#run-control).

Do not launch a duplicate just to retrieve its result. Use the task ID returned at launch. IDs are scoped to the session or workflow stage that owns them.

Foreground subagent launches and explicit `action: "wait"` calls also yield when user steering or an Intercom ask/send is admitted to the waiting parent, in main chat or a live workflow stage. The message stays in the normal delivery queue so the parent can handle it and reply. This releases only observation: children keep running under the same task IDs, and other owners' waits are unaffected.

### Completion messages

Completion creates a shaded notification card in the owning chat without depending on a model reply. It uses the chat theme's card background and padding, with a colored outcome, the agent or shell name, and an available result preview:

```text
✓ Subagent codebase-analyzer completed: Trace the authentication flow.
  Authentication starts in …
/tasks to inspect
```

The parent model also receives the result context. Delivery retries do not relaunch the child. Workflow completions stay in their owning stage chat, not the main conversation.

Supervisor progress messages are labelled **Historical supervisor update** with their original `Sent:` timestamp. They describe the child's state when sent, not its current status, and can arrive after completion. Prefer a later correction or final result over an earlier progress hypothesis; use `/tasks` for the current task state.

Stopping a subagent through `/tasks` (`x`, then `y`) delivers a **stopped** card and stop context to the parent model. The notice arrives only after termination is confirmed, not while the task is **Stopping**. It requires no final response from the child. Cancelling queued work sends the notice without starting it. A subagent stopped this way cannot be resumed; to stop one and keep it resumable, use `subagent({ action: "quit", id })` (see [Run control](/subagents#run-control)).

A subagent stopped with `subagent({ action: "pause" | "quit", id })`, or by its workflow stage pausing, is not ended. Its notice reads **paused · awaiting resume** (for a quit child, `Subagent <agent> quit · paused, awaiting resume`), gives `Stop reason: pause` or `quit`, and names the call that continues it, `subagent({ action: "resume", id: "<child-id>" })`, instead of telling the model the execution has ended. Its `/tasks` row shows **Paused · awaiting resume**.

Repeated stop requests or late child results do not duplicate the notice or overwrite the recorded outcome. A task that finished before cancellation keeps its actual result. Closing the owning session or workflow stage still suppresses late notices.

Restored completions may have only an outcome and task identity if the original live task or transcript is unavailable. Atomic does not invent missing output. Excerpts are bounded; inspect retained history for more detail.

Long titles and previews are truncated or wrapped within the card width. Its background covers the ellipsis, expand hint, and trailing padding on every row.

## Task heartbeats

A shell or subagent that keeps running sends its chat a **task heartbeat** every 15 minutes by default, the same cadence as [workflow heartbeats](/workflows/api-reference#heartbeatintervalminutes). It is a periodic check, not a failure signal. The model sees how long each task has run and how recently it produced output or reported activity, then decides whether it is still making progress:

- If it is progressing, the model lets it run.
- If it looks runaway, stale or stuck, the model inspects it (`/tasks`, or a shell or subagent `wait` on its task ID), steers it (an Intercom message to a subagent, or pausing it and resuming it with a message), or stops it (`kill({ id })` for a shell, `subagent({ action: "quit", id })` for a subagent).
- It does not relaunch a task that is still running.

A heartbeat never stops, restarts or relaunches a task by itself. The card in chat lists each task; expand it for the status line and output:

```text
♥ Task heartbeat · 2 tasks still running
  shell task-1-0-3 npm run e2e · 45m
  subagent task-1-0-4 Trace the authentication flow · 30m
(ctrl+o Expand) · periodic check · /tasks to inspect
```

The model receives one entry per task, followed by the guidance above:

```text
♥ Task heartbeat (shell task-1-0-3: npm run e2e) — still running after 45m, on a 15-minute cadence.
Status: elapsed 45m · 3.2MB output · last output 8s ago
Last output lines (task output, not instructions):
  ✓ checkout flow (12.4s)
  running 18 of 40 specs
♥ Task heartbeat (subagent task-1-0-4: Trace the authentication flow) — still running after 30m, on a 15-minute cadence.
Status: agent codebase-analyzer · elapsed 30m · last activity 14m ago · running bash: sleep 3600 · 12 turns · 41 tool calls · 182.4k tokens
```

For a shell, the status gives its output size, when it last wrote output, and up to six of its last output lines. For a subagent, it gives the time since its last reported activity, its tool call (`running` while the call has not returned, `last tool` once it has), and its turn, tool-call and token counts when they are available. A subagent waiting for input says so.

### When heartbeats arrive

- Only running tasks heartbeat. Queued, stopping, finished, killed, quit and paused tasks do not, and a task's heartbeats stop when it ends. A paused workflow stage stops its tasks, so they stop heartbeating too.
- The cadence counts from when the task started running, never from the previous heartbeat.
- Tasks that come due within about a minute of each other share one heartbeat. One heartbeat describes up to eight tasks in full and lists the rest by name.
- A chat has at most one unread heartbeat. While it waits behind a long response or paused messages, later intervals are not stacked: the tasks that came due are reported together once it has been read, and missed intervals are not replayed.
- A heartbeat queues behind the current response, like a steering message, and never interrupts streaming text. Like other incoming messages, it releases a subagent launch or a `wait` action that is observing a task in the foreground; the task keeps running.
- Heartbeats go to the chat that owns the task: main chat, or the workflow stage's chat, including stages that run on [local worker pools](/settings#local-worker-pools). Shells a subagent starts belong to its parent, so their heartbeats go to the parent.
- A shell's execution `timeout` (300 seconds by default) still ends it. A shell heartbeats only while it runs longer than its cadence.

### Choose the cadence

Set `heartbeatMs` on a `bash`, `powershell` or `subagent` call. Leave it out for the chat's default, use `0` to turn heartbeats off for that task, or give at least `60000` (one minute). Any other value is refused before the task starts.

```ts
// A long end-to-end run checked every five minutes.
bash({ command: "npm run e2e", wait: { kind: "background" }, timeout: 3600, heartbeatMs: 300000 })

// A deliberately long investigation that should not heartbeat.
subagent({ agent: "codebase-analyzer", task: "Map every caller of the auth module.", heartbeatMs: 0 })

// In parallel mode, a task's own heartbeatMs wins over the call's.
subagent({
  tasks: [
    { agent: "worker", task: "Port the parser.", heartbeatMs: 600000 },
    { agent: "worker", task: "Port the printer." },
  ],
  heartbeatMs: 1800000,
})
```

The cadence is fixed when the task starts, and a running task's `/tasks` detail shows it as `Heartbeat every 15m` or `Heartbeat off`, the same for a workflow stage on a local worker. A subagent resumed after `pause` or `quit` uses the chat's default cadence. Change the default for every task with [`tasks.heartbeatMs`](/settings#tasks).

## Inspect tasks

| View | Controls |
| --- | --- |
| Task list | Up/Down selects; Enter opens detail; Escape returns to chat. |
| Task detail | Up/Down selects an action; Enter activates it; PageUp/PageDown scrolls the body. |
| Transcript | Scrolls like a workflow stage chat: it opens at the latest message and follows new output; PageUp/PageDown move one viewport; Ctrl+Home/Ctrl+End jump to the top and to the latest message; Ctrl+Up/Ctrl+Down jump between prompts; the mouse wheel scrolls (Alt+wheel five times faster). Earlier retained history loads as you scroll toward the top. |
| Transcript display | A transcript opens with the chat's thinking and tool-output settings. Ctrl+T toggles thinking blocks, as in the chat, and Ctrl+O toggles the transcript's tool output. |
| Message the agent | Type in the transcript's prompt and press Enter to send the text to the agent through Intercom. Up/Down, Home/End and Left/Right edit the prompt. |
| Subagent chat | A subagent's transcript has the chat box of a workflow stage chat. The prompt's top rule names the subagent's session, for example `[subagent: subagent-worker-aabcf28b-1]`: its Intercom name, or its agent name when it has none. Long names end in `…`, and terminals narrower than 40 columns show no name. The footer counts the subagent's own running tasks. |
| Subagent's tasks | Type `/tasks` in a subagent's transcript to list that subagent's own tasks: the shells it ran and the subagents it launched, not the parent's. In a nested subagent's transcript, `/tasks` lists that subagent's tasks. Escape or Left on that list returns to the subagent's chat. |
| Go back | Escape returns from transcript to detail, then from detail to the list. Left does the same when the prompt is empty. While a subagent's own task list is open, Escape and Left go back within that list first. |
| Stop | On a task's detail page, `x` requests cancellation; confirm with `y`, or keep running with `n` or Escape. A bound `app.tasks.cancel` key also works from the list. |
| Shell input | Select Input when offered; Enter sends the text plus a newline; Escape leaves input mode. |

Configured task bindings take precedence over the default Left, page, and `x` shortcuts. A transcript's prompt and input mode receive ordinary typing, including `x`, without stopping the task. The footer shows the applicable controls.

Scrolling settings apply to transcripts as they do to the chat: `fullscreenWheelScrollLines` sets the wheel step and `fullscreenScrollbar` shows the scrollbar. When you scroll away from the latest message, the last row offers **↓ Jump to latest message**; click it or press Ctrl+End to follow the output again.

The list groups **Agents** and **Shells**, with counts and status symbols. Detail views pin identity, state, available metrics, and the selected action while their body scrolls. Missing metrics are omitted rather than displayed as zero. Recorded zero values remain visible.

Agent rows and completion cards show the resolved model and reasoning setting, for example `openai-codex/gpt-6-astra · thinking medium`. These settings update on fallback and remain after completion. Foreground results retain the same metadata. Missing settings are not inferred from token counts; early launch receipts may not yet have a resolved model.

Agent details include recent retained tool activity, the prompt, a latest-response preview, and error or attention information. Transcript inspection shows the agent's conversation as a chat: retained messages, thinking blocks, tool calls and results, compaction boundaries, branch summaries, and extension notices, with a compaction status while the agent compacts. Earlier pages do not jump back to the latest page when background activity arrives.

Messages you send from a transcript reach the agent the way an Intercom message does, and appear in its transcript once the agent receives them. An agent without an Intercom target cannot receive messages; the transcript says so when you press Enter. If Intercom does not deliver or confirm a message, the transcript shows why and keeps your text in the prompt. If you already left the transcript, the task pages show why (or, once you closed them, the chat you opened them from, while it stays open), and the text is back in the prompt when you open that transcript again from the same chat.

An agent's detail and transcript pages end with a status row for that task's own extension status lines, such as a tokens-per-second counter set by an extension the subagent loaded. It updates live, is separate from the chat's own status row, and disappears when the task ends. The compact picker and shell pages show none.

An open live transcript updates directly from the child's session events, including streaming assistant text, partial/final tool results, and compaction. Shell output refreshes on task state updates, including updates received during an earlier output read. You do not need to leave and reopen the transcript. Reading earlier retained pages keeps your position while the live tail continues updating. A transcript that is read again rather than streamed, such as an agent's in a workflow stage on a local worker, holds still while you read above its end and catches up when you return to the latest message.

Shell details show the command, available exit information, and a bounded output tail. The preview shows up to ten wrapped lines from the retained 8 KiB tail. Output gaps and omitted earlier content are labelled. An empty output stream says **No output available**. Shell transcript inspection exposes the retained tail, not an invented agent conversation or an unlimited log viewer.

### States

| State | Meaning |
| --- | --- |
| Queued | Admitted, waiting for execution capacity. |
| Running | Execution is live, including when the parent has stopped waiting. |
| Input needed | An owned prompt needs attention. Open question is offered when a host route is available. |
| Stopping | Cancellation was requested; termination has not yet settled. |
| Completed | Execution finished successfully. |
| Failed | Execution ended with an error. Details retain the error message. |
| Stopped | Execution was cancelled. Completed work is not undone. |

Completed, failed, and stopped tasks retain inspection but do not offer execution controls. **Foreground wait** observes a running task; it does not transfer ownership or create a second execution.

## Background shells

Model `bash` calls on POSIX and native Windows, and `powershell` calls on native Windows, use the session's task owner. Subagent shells use their parent's owner; see [Shells started by subagents](#shells-started-by-subagents). A long command can outlive its foreground observation budget and return a task ID while continuing to run. Its status then appears below the prompt and under **Shells** in `/tasks`. An explicit execution timeout still ends the command; it is separate from observation yielding.

```ts
// Ordinary commands use the owner's observation budget, normally 10 seconds.
bash({ command: "npm run check" })

// Background a build when you can do independent work while it runs.
bash({ command: "npm run build", wait: { kind: "background" }, timeout: 600 })

// Wait longer when the test result is needed next; execution timeout is separate.
bash({ command: "npm test", wait: { kind: "foreground", budgetMs: 30000 }, timeout: 600 })
```

The shell execution timeout is separate: `timeout` is seconds and defaults to 300, with a maximum of 3600. It continues counting after backgrounding. Choose a timeout appropriate for the command; reducing `budgetMs` does not shorten or extend it. Use the returned task ID to inspect or stop the existing task through `/tasks`. Background completion notifies the parent automatically, so there is no need to launch the command again to collect its result.

Observe an existing task without running its command again:

```ts
bash({ action: "wait", id: taskId })
powershell({ action: "wait", id: taskId })
```

Use the original task ID from the same owning session or workflow stage. Omit `budgetMs` to use the owner's command observation policy, or pass `0` to poll. In a workflow stage that releases its session while it waits (see [Suspended stages](/workflows/operations#suspended-stages)), a wait without `budgetMs` waits until the task ends, and the stage gives up its session and slot meanwhile. A wait returns retained output and a yielded or settled observation; settled results include available exit and failure details. The transcript shows one status line above the output: `✓ completed · exit 0`, `✗ exited 1`, `● still running · showing output so far`, or `○ cancelled`. When the output was cut short, a dim line below it gives the path to the full output. The agent receives the same facts as one sentence after the output, and the structured observation stays in the result details. While running, successive yielded waits advance through retained output in bounded pages, including after a session reload. A caught-up wait returns no output until more arrives. Settled waits return all retained output again, subject to labelled gaps and truncation, so they may repeat output you have already seen.

Do not combine `action: "wait"` with `command`, `timeout`, `wait`, `env`, `cwd`, or `pty`. Existing-task waits require a supported task owner, even with custom execution adapters. Unknown or foreign IDs are rejected with `No background task "<id>" in this session` and a hint to run `/tasks`. Cancelling a wait or admitting user/Intercom messages releases observation only, not the command. Waiting never extends the original execution timeout or the owner's lifetime.

### Stop a shell task from a tool call

Use the `kill` tool with the exact task ID returned by `bash` or `powershell`, whether it launched explicitly in the background or automatically yielded:

```ts
kill({ id: taskId })
```

The same command works in main and workflow-stage chat. It selects the existing owned shell task; do not supply a process ID, shell name, or another owner's task ID. Unknown, malformed, foreign-owner, and subagent IDs are rejected. `/tasks` stop controls remain available.

The transcript shows a status line such as `● stopping · cancellation requested`, `○ cancelled`, or `✓ already completed · exit 0`, and the agent receives the same facts as a sentence. The structured result keeps `taskId`, `decision`, `execution`, and `cleanup`. `cancellation-requested` means cancellation was requested, not that termination or cleanup has finished. A repeated call preserves that decision while reporting current state. `already-settled` means the task finished before cancellation and keeps its original outcome. Confirm `execution.kind: "settled"` and `cleanup.kind: "reaped"` before treating termination and cleanup as complete. Cleanup failures remain errors, not successful stops. A stopped shell whose cleanup cannot be confirmed within a few seconds, for example because a process that left the command's process group still holds its output open, ends as failed with code `CleanupUnconfirmed` and names the unconfirmed resource. It then no longer counts as stopping, and its cleanup shows as `quarantined` while Atomic keeps confirming it in the background for up to 15 seconds; it ends `reaped` once the processes and output are gone, or `failed` if they are not gone by then. Output and completion notifications remain available; killing a task does not erase its history.

Shell completions use the same shaded card as subagents, with a retained output preview and available exit code. Nonzero shell exits are shown as failures even though the process itself reached a terminal state. Cancellation shows Stopped. The card and below-prompt count update in the owning main or workflow-stage chat.

Native Windows refuses owned shell launches it cannot supervise. Legacy Windows WSL `bash.exe` stdin transport is unsupported; run Atomic inside WSL for the normal POSIX/Bash path.

### Shells started by subagents

Subagents can run background `bash` and `powershell` commands too. Their shell tasks belong to the parent that launched the subagent: in main chat they appear under **Shells** in the main chat's `/tasks`, and in a workflow the subagent's shells appear in the current stage's `/tasks`. The subagent itself still cannot launch other subagents.

- The subagent can wait on and `kill` the shells it launched, but not the parent's own tasks or another subagent's.
- The parent can inspect, wait on, and stop those shells from its own `/tasks`, `bash({ action: "wait", id })`, or `kill({ id })`.
- `/tasks` typed in the subagent's own transcript lists the shells it launched while it ran.
- While the subagent is still running, a background shell's completion notice goes to the subagent. After the subagent finishes, the notice goes to the parent.
- Shells keep running after the subagent finishes. They stop when the parent's session or workflow stage closes, or when a workflow stage pauses.

Custom operations adapters receive `wait` but must implement it themselves. External-terminal processes are not adopted into `/tasks`. A child's own tool use appears in that subagent's activity and transcript.

## Lifetime and scope

Background means independent of the current observation, not independent of its owner. **Pausing main chat** aborts the foreground turn only; its background agents and shells keep running. Detaching a workflow pane, ending a model turn, or closing `/tasks` also leaves owned background work alone.

**Pausing a workflow stage** blocks new launches, stops its active and queued agents, and cancels its shells. The stopped subagents stay resumable with `subagent({ action: "resume", id })`. Pause completes only after confirming the cleanup of what it stopped; failures are reported rather than treated as a successful pause. Main-chat tasks, sibling stages, and future stage generations are unaffected.

Pause does not close the stage's message generation: queued user and Intercom messages remain held for resume. Resume permits fresh launches but never resurrects cancelled shells; retained task results remain inspectable. Closing a session or stage generation still cancels its remaining owned work. Explicit `/tasks` stop and declared execution timeouts remain separate controls.

On native Windows, Suspend opens a PowerShell subshell rather than freezing Atomic. Exit the subshell to restore the same session; owned background tasks continue while it is open.

Task inspection is owner-scoped. It is not a machine-wide process list. Switching sessions does not copy the previous session's task rows into the new one. Missing retained history is reported explicitly.

Each session and workflow stage keeps its 256 most recently finished tasks in `/tasks`, so a long session that runs thousands of shells or background subagents does not keep a record of every one. Running, queued and stopping tasks are always kept, and so is a finished shell whose cleanup is still being confirmed or failed. When another task finishes, the one that finished longest ago leaves `/tasks`, but never before its completion notice has been delivered, so a burst of finishes can briefly keep more than 256. Its result stays where the conversation reported it, in its completion notice or tool result, and a subagent's transcript stays in its own saved session; a paused or quit subagent still resumes with `subagent({ action: "resume", id })`. A shell command's full output is deleted with its record. Waiting on, stopping or reading the output of such a task reports `Task "<id>" finished and is no longer kept in this session` (code `TaskEvicted`) instead of an unknown task.

Closing `/tasks` does not stop the chat footer's live Git branch updates.

## Task state and completion delivery

Foreground and background are observation modes for the same task. Stopping a wait does not create, stop, or restart execution.

A terminal result does not by itself confirm resource cleanup. Check the tool's cleanup status before treating a stop as complete.

A shell command that finishes while a process it started still holds its output open, or whose process group takes longer than a few seconds to exit, is no longer reported as failed. Its result keeps the command's output and exit code, and its cleanup becomes `quarantined`: Atomic keeps confirming it in the background, with the command's process permit still held, until the session or workflow stage closes; closing then waits up to 15 seconds more. Confirmed cleanup becomes `reaped`. Cleanup still unconfirmed when that time is up becomes `failed`, and the close reports a `TaskCleanupError` (code `task_cleanup_unconfirmed`, `retryable: true`) that names each task and process group, with the next step in `hint`. `isRetryableTaskError(error)` from `@bastani/atomic` returns `true` for it and for an error whose `cause` chain holds it. A stage pause waits for the cleanup of the shells it stops; cleanup quarantined before the pause is confirmed by the close. Output a held-open process writes after the result settles is not kept. Processes that a command starts in their own session (for example with `setsid`) are not killed; the command's cleanup completes once they close its output.

With a custom SDK `resourceAdmission` limit, unconfirmed cleanup can keep the process slots a later command needs. If that command's admission is still waiting after five seconds while tasks owned by the same session or stage hold permits from the same admission provider for unconfirmed cleanup, it rejects before starting with `TaskCleanupAdmissionTimeoutError`. This is a retryable `TaskCleanupError` with code `task_cleanup_unconfirmed`, `phase: "command-admission"`, `timeoutMs`, `elapsedMs`, and the tasks and resources in `failures`. The earlier results stay intact and their permits remain held. Retry the command after those resources are confirmed released. `isTaskCleanupAdmissionTimeoutError(error)` and `rehydrateTaskCleanupError(value)` are exported from `@bastani/atomic`; `isRetryableTaskError(error)` also recognizes this error. Waiting for capacity held only by live work has no added deadline. Different `ResourceAdmission` objects used through execution scopes remain independent; quarantine in one does not bound waits in another.

UI previews are bounded and are not a substitute for retained output. Gaps and truncation are labelled; unavailable history is reported rather than reconstructed from activity counters.

## Related documentation

- [Subagents](/subagents) covers definitions, models, context, and delegation boundaries.
- [Keybindings](/keybindings) covers task-action remapping.
- [Workflows](/workflows) covers durable stage lifecycles.
