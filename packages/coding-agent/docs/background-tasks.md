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

It summarizes only active background agents and shells, including queued work, stopping tasks, and tasks needing attention. Completed, failed, and stopped tasks leave the footer immediately; when no background work is active, the indicator disappears. Results and failure details remain in completion cards and `/tasks`, so an old failure cannot keep the live indicator red. Running tasks do not expire merely because they are quiet.

Run `/tasks` to open a compact inline picker in the editor slot, like `/workflow connect`, with the conversation still visible above it. Detail, transcript, input, and cancellation-confirmation pages use the full screen. Escape returns to the picker with the selected task preserved, then to chat. The command also appears in workflow-stage slash suggestions, including when skill commands are disabled. Foreground-only commands do not appear. Work that ran in the background stays available after completion or a later foreground wait. Updates never open the list automatically. Closing the inspector does not stop the tasks.

Main and workflow-stage pickers use the same layout for empty and populated lists. Below the picker, the footer keeps that chat's resolved model and reasoning level, current folder and Git branch, and MCP status, including while its foreground turn streams. Each picker lists only its owner's tasks.

Opening `/tasks` is navigation, not an approval request. It does not mark the agent blocked in Herdr or produce a "Main chat needs input" notice. A genuine main-chat question waiting behind the workflow graph still shows that notice until answered or the graph is hidden or closed. The inspector stays open until you close it, even when its tasks finish; task history is not deleted when the compact indicator disappears.

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

Native observation timers run independently of JavaScript. A zero-budget wait can already be backgrounded by the time a caller reads the next task snapshot, even before JavaScript awaits the result. Synchronous wait registration does not guarantee a visible foreground interval. The elapsed result still identifies the same wait and task; execution continues.

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

Do not launch a duplicate just to retrieve its result. Use the task ID returned at launch. IDs are scoped to the session or workflow stage that owns them.

Foreground subagent launches and explicit `action: "wait"` calls also yield when user steering or an Intercom ask/send is admitted to the waiting parent, in main chat or a live workflow stage. The message stays in the normal delivery queue so the parent can handle it and reply. This releases only observation: children keep running under the same task IDs, and other owners' waits are unaffected.

### Completion messages

Completion creates a shaded notification card in the owning chat without depending on a model reply. It uses the chat theme's card background and padding, with a colored outcome, the agent or shell name, and an available result preview:

```text
✓ Subagent codebase-analyzer completed: Trace the authentication flow.
  Authentication starts in …
/tasks to inspect
```

The parent model also receives the result context. The internal receipt stays in structured message details, rather than becoming raw JSON in chat. The same persisted completion identity handles delivery retries without relaunching the child. Workflow completions remain in their owning stage chat, not the main conversation.

Supervisor progress messages are labelled **Historical supervisor update** with their original `Sent:` timestamp. They describe the child's state when sent, not its current status, and can arrive after completion. Prefer a later correction or final result over an earlier progress hypothesis; use `/tasks` for the current task state.

Stopping a subagent through `/tasks` (`x`, then `y`) also delivers a **stopped** card and stop context to the parent model. The notice arrives after termination is confirmed, not while the task is merely **Stopping**, and does not require a final response from the child. Cancelling queued work notifies without starting it. Repeated stop requests or late child results do not duplicate the notice or overwrite the recorded outcome; a task that finished before cancellation keeps its actual result. Closing the owning session or workflow stage still suppresses late notices.

Restored completions may have only an outcome and task identity if the original live task or transcript is unavailable. Atomic does not invent missing output. Excerpts are bounded; inspect retained history for more detail.

Long titles and previews are truncated or wrapped within the card width. Its background covers the ellipsis, expand hint, and trailing padding on every row.

## Inspect tasks

| View | Controls |
| --- | --- |
| Task list | Up/Down selects; Enter opens detail; Escape returns to chat. |
| Task detail | Up/Down selects an action; Enter activates it; PageUp/PageDown scrolls the body. |
| Transcript | Up/Down scrolls; PageUp/PageDown moves one viewport; PageUp at the top loads earlier history; Home/End jumps within loaded history. |
| Go back | Left or Escape returns from transcript to detail, then from detail to the list. |
| Stop | `x` requests cancellation; confirm with `y`, or keep running with `n` or Escape. |
| Shell input | Select Input when offered; Enter sends the text plus a newline; Escape leaves input mode. |

Configured task bindings take precedence over the default Left, page, and `x` shortcuts. Input mode receives ordinary typing, including `x`, without stopping the task. The footer shows the applicable controls.

The list groups **Agents** and **Shells**, with counts and status symbols. Detail views pin identity, state, available metrics, and the selected action while their body scrolls. Missing metrics are omitted rather than displayed as zero. Recorded zero values remain visible.

Agent rows and completion cards show the resolved model and reasoning setting, for example `openai-codex/gpt-6-astra · thinking medium`. These settings update on fallback and remain after completion. Foreground results retain the same metadata. Missing settings are not inferred from token counts; early launch receipts may not yet have a resolved model.

Agent details include recent retained tool activity, the prompt, a latest-response preview, and error or attention information. Transcript inspection uses a dedicated scrolling view with a pinned title, line position, and controls, rather than nesting full chat components inside a detail box. It renders retained messages and tool results without hidden reasoning or inline images. Earlier pages do not jump back to the latest page when background activity arrives.

An open live transcript updates directly from the child's session events, including streaming assistant text and partial/final tool results. Shell output refreshes on task state updates, including updates received during an earlier output read. You do not need to leave and reopen the transcript. Reading earlier retained pages keeps your position while the live tail continues updating.

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

Top-level model `bash` calls on POSIX and native Windows, and `powershell` calls on native Windows, use the session's task owner. A long command can outlive its foreground observation budget and return a task ID while continuing to run. Its status then appears below the prompt and under **Shells** in `/tasks`. An explicit execution timeout still ends the command; it is separate from observation yielding.

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

Use the original task ID from the same owning session or workflow stage. Omit `budgetMs` to use the owner's command observation policy, or pass `0` to poll. A wait returns retained output and a yielded or settled observation; settled results include available exit and failure details. While running, successive yielded waits advance through retained output in bounded pages, including after a session reload. A caught-up wait returns no output until more arrives. Settled waits return all retained output again, subject to labelled gaps and truncation, so they may repeat output you have already seen.

Do not combine `action: "wait"` with `command`, `timeout`, `wait`, `env`, `cwd`, or `pty`. Existing-task waits require a supported task owner, even with custom execution adapters. Unknown or foreign IDs are rejected. Cancelling a wait or admitting user/Intercom messages releases observation only, not the command. Waiting never extends the original execution timeout or the owner's lifetime.

### Stop a shell task from a tool call

Use the `kill` tool with the exact task ID returned by `bash` or `powershell`, whether it launched explicitly in the background or automatically yielded:

```ts
kill({ id: taskId })
```

The same command works in main and workflow-stage chat. It selects the existing owned shell task; do not supply a process ID, shell name, or another owner's task ID. Unknown, malformed, foreign-owner, and subagent IDs are rejected. `/tasks` stop controls remain available.

The response includes `taskId`, `decision`, `execution`, and `cleanup`. `cancellation-requested` means cancellation was requested, not that termination or cleanup has finished. A repeated call preserves that decision while reporting current state. `already-settled` means the task finished before cancellation and keeps its original outcome. Confirm `execution.kind: "settled"` and `cleanup.kind: "reaped"` before treating termination and cleanup as complete. Cleanup failures remain errors, not successful stops. Output and completion notifications remain available; killing a task does not erase its history.

Shell completions use the same shaded card as subagents, with a retained output preview and available exit code. Nonzero shell exits are shown as failures even though the process itself reached a terminal state. Cancellation shows Stopped. The card and below-prompt count update in the owning main or workflow-stage chat.

Native Windows owned shells use supervised pipes or ConPTY, with Job Object containment before execution resumes and confirmed cleanup. If containment cannot be established, launch is refused rather than falling back to unsupervised execution. The legacy Windows WSL `bash.exe` stdin transport remains unsupported for owned launch because Windows jobs cannot supervise Linux guest processes. Running Atomic inside WSL uses the normal POSIX/Bash path.

Bash calls inside subagent sessions retain their existing execution paths. Without a supported task owner, explicit background requests are refused before execution; foreground calls wait for completion rather than automatically yielding. Custom operations adapters receive `wait` but must implement it themselves. External-terminal processes are not adopted into `/tasks`. A child's own tool use appears in that subagent's activity and transcript.

## Lifetime and scope

Background means independent of the current observation, not independent of its owner. **Pausing main chat** aborts the foreground turn only; its background agents and shells keep running. Detaching a workflow pane, ending a model turn, or closing `/tasks` also leaves owned background work alone.

**Pausing a workflow stage** blocks new task launches immediately and cancels that stage generation's active and admitted queued agents and commands. Queued agents are cancelled before active cancellations free execution slots. Command setup already in flight may briefly start a shell during the pause transition; pause waits for those admissions, cancels the resulting shells, and confirms resource cleanup before completing. A successful pause leaves no owned active or queued executions. Cancellation or cleanup failures are reported instead of confirming pause. Main-chat tasks, sibling stages, and future stage generations are unaffected by a stage-scoped pause.

Pause does not close the stage's message generation: queued user and Intercom messages remain held for resume. Resume permits fresh launches but never resurrects cancelled executions; retained task results remain inspectable. Closing a session or stage generation still cancels its remaining owned work. Explicit `/tasks` stop and declared execution timeouts remain separate controls.

On native Windows, Suspend opens a PowerShell subshell rather than freezing Atomic. Exit the subshell to restore the same session; owned background tasks continue while it is open.

Task inspection is owner-scoped. It is not a machine-wide process list. Switching sessions does not copy the previous session's task rows into the new one. Missing retained history is reported explicitly.

Git branch watchers for alternate folders are shared by their chat footers and released when the last viewer closes or changes folders. Main chat and other open stage chats keep their live branch updates; closing `/tasks` alone leaves its chat footer active.

## Task state and completion delivery

Foreground and background describe observation, not different executions. Each admitted task keeps its identity and owning session as callers start or stop waiting. The native `wasBackground` field remains set after a designated wait yields, including after a later foreground wait or settlement.

Execution outcome and resource cleanup are separate states. A terminal result does not by itself prove that resources were reaped. Cleanup failures remain explicit. Supervised shells retain output while running, and finish output draining as part of cleanup.

Native integrations can use `TaskSupervisor.taskSettlement(task)` from `@bastani/atomic-natives` to retrieve an authentic terminal receipt without creating a new wait. This supports recovery when a bounded event journal no longer contains the completion event. Session-history completion intents and acknowledgements reuse the same identity when notification delivery is retried.

UI previews are bounded and are not a substitute for retained output. Gaps and truncation are labelled; unavailable history is reported rather than reconstructed from activity counters.

## Related documentation

- [Subagents](/subagents) covers definitions, models, context, and delegation boundaries.
- [Keybindings](/keybindings) covers task-action remapping.
- [Workflows](/workflows) covers durable stage lifecycles.
