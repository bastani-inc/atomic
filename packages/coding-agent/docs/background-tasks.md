---
title: "Manage background tasks"
sidebarTitle: "Manage background tasks"
description: "Monitor, steer, and stop background subagents, shell commands, and history searches while continuing your conversation."
---

Background subagents, shell commands, and history searches keep running after their tool call returns. You can keep chatting in your main session, inspect live output, steer subagents, or stop individual tasks without losing your place.

| What you want | Use this |
| --- | --- |
| See running subagents and switch views | Focus the [agent panel](#the-agent-panel) (`↓` on an empty prompt) |
| Inspect all subagents, shells, and full output | Run [`/tasks`](#open-the-task-inspector) (or `/tasks <id>`) |
| Wait for a task's result from a tool call | Pass `{ action: "wait", id, budgetMs? }` to `subagent`, `bash`, `powershell`, `read`, or `search` |
| Stop one shell or history task | Call `kill({ id })`, or press `x` twice in `/tasks` |
| Pause, quit, or resume a subagent | Call `subagent({ action: "pause" \| "quit" \| "resume", id })`, or press `x` twice in `/tasks` or the agent panel |
| Stop all background subagents and shells | Press `Ctrl+X` then `Ctrl+K` (twice within 3 seconds) |

For the full tool wait matrix, slash-command routing inside subagent views, heartbeat sampling rules, cgroup cleanup controls, and SDK error classes, see the [Background tasks reference](/background-tasks/reference).

## Background subagents

Every subagent runs in the background. Describe bounded work in plain language and keep working in your main chat while the subagent runs:

```text
Have a codebase-analyzer trace the authentication flow in the background.
Keep working with me here while it runs.
```

Each launch returns immediately with **Launched in background** and each subagent's task ID. Parallel launches get independent IDs, and tasks beyond the concurrency limit wait in the queue. Run `/agents` to browse available specialists.

### Waiting is not restarting

When your next step depends on a subagent's result, wait on its task ID instead of launching a second subagent:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the authentication flow." })
subagent({ action: "wait", id: taskId, budgetMs: 120000 })
subagent({ action: "status", id: taskId })
```

If the wait budget expires, you press `Esc`, or a user message or [Intercom](/intercom) message yields the wait, the subagent keeps running under the same task ID. Wait again or let its completion notice arrive. To hold, stop, or continue a subagent, use `pause`, `quit`, and `resume` ([Run control](/subagents#run-control)).

### Completion messages

When a background task finishes or stops, Atomic adds one notice line to the launching chat without waiting for a model reply. Press `Ctrl+O` to expand a shell's retained output lines or a subagent's full result:

```text
 ● Background command "npm run build" completed (exit code 0) · 3m 2s
 ◯ Task "Sleep 300 seconds in background" was stopped by the user
 ● debugger finished · 1h 31m
   ⎿  Authentication starts in …
      (ctrl+o for the full result)
 ◯ debugger quit · awaiting resume
 ◌ worker is waiting on bash (toolu_01) · 16m 16s
```

- **Delivery.** Notices go only to the session that launched the task. Multiple tasks that finish together arrive in one batch and start one turn in an idle chat. After an interrupt, notices wait for your next message.
- **Two kinds of pause and stop.** Pressing `Esc` while viewing a subagent pauses only its active turn (`‖ paused` in yellow under **Working**; sending a message continues it). Calling `subagent({ action: "pause" | "quit", id })`, pressing `x` twice in `/tasks` or the agent panel, or pressing `Ctrl+X Ctrl+K` stops the subagent resumably (red `◯` stopped, showing **paused · awaiting resume** or **quit · awaiting resume**). Both stay resumable by messaging the subagent or calling `resume`.
- **Resume IDs.** Expanding a completed, failed, paused, or quit subagent notice (`Ctrl+O`) shows `resume id <child-id>`. Permanently cancelled subagents, released subagents, and shells have no resume ID.

## Background shells

When Atomic runs a [`bash`](/tools#bash) or [`powershell`](/tools#powershell) command, it watches the command for up to 10 seconds by default. If the command is still running when that observation window ends, Atomic returns a task ID (such as `task-1-0-3`) and leaves the command running in the background until it exits, you stop it, it hits a `timeout` or the 5 GiB disk output cap, or the session closes.

```ts
// Watch for up to 10 seconds, then continue in the background if still running
bash({ command: "npm test" })

// Start in the background immediately
bash({ command: "npm run build", wait: { kind: "background" } })

// Watch for up to 30 seconds before backgrounding
bash({ command: "npm test", wait: { kind: "foreground", budgetMs: 30000 } })

// Check progress or wait on a running shell
bash({ action: "wait", id: "task-1-0-3", budgetMs: 5000 })

// Stop a running shell
kill({ id: "task-1-0-3" })
```

- **Optional deadline (`timeout`).** Commands have no time limit unless you pass a positive `timeout` in seconds (no upper limit). When the deadline passes, Atomic stops the command and reports a timeout failure.
- **Cancelling `wait` vs. cancelling a launch.** Pressing `Esc` during `action: "wait"` ends only the wait and leaves the command running. Pressing `Esc` during the initial foreground wait of a brand-new `bash` or `powershell` call stops the command.
- **Stopping with `kill`.** Pass only the shell's task ID (not a PID or subagent ID). `kill` starts teardown and reports whether cleanup finished; wait for settlement before assuming files or ports are free. See [Stopping tasks and CancelReceipt](/background-tasks/reference#stop-a-shell-task-from-a-tool-call).

### Long-running servers and watchers

Start dev servers, file watchers, or tunnels with `wait: { kind: "background" }`. They run without a time limit until stopped with `kill` or `/tasks`, they exit on their own, or the session ends. Pass `heartbeatMs: 0` if you do not want periodic heartbeat check-ins. When the session closes or Atomic exits, background servers stop with their child processes and do not restart automatically on resume.

### How many commands run at once

A session runs at most **64** shell commands concurrently, counting shells started by its subagents. Commands currently stopping do not count toward the cap. At the limit, new commands are refused until an existing command finishes or is stopped.

### Shells started by subagents

Subagents can run background `bash` and `powershell` commands. Your launching main session supervises their lifecycle so they can outlive the subagent until the main session closes, while their completion notices go only to the subagent that started them.

- Running subagent shells nest directly beneath their subagent in the agent panel (`⧗ shell <command>`). Press `Enter` on a nested shell to inspect its output in `/tasks` (`←` returns to the panel), or press `x` twice to stop only that shell.
- A subagent can wait on and `kill` only its own shells; your main session can wait on or stop them by task ID or stop everything together with `Ctrl+X Ctrl+K`.

## Background history searches

A `read` or `search` over `history://` follows the same 10-second default watch window and continues in the background as `history-N` with no time limit. Each session allows up to **4** concurrent `history://` searches or reads (separate from the 64 shell cap). Stop one with `kill({ id: "history-3" })` (`Ctrl+X Ctrl+K` stops subagents and shells only, not history tasks). History tasks do not appear in `/tasks` or the agent panel and emit no heartbeats. See [Slow history searches](/sessions#slow-history-searches).

## The agent panel

Below the prompt, the agent panel lists `main` followed by the session's active background subagents (and any running shells nested beneath them). The currently viewed chat has a filled `●` and bold label:

```text
  ● main
  ◯ worker    openai/gpt-5.4 high                    fix shipping batches           41m · ↓ 96.1k tokens
  ◯ debugger  anthropic/claude-opus-4-6 medium       fix spawn lock                 18m · ↓ 87.4k tokens
    ⧗ shell                                          npm test                                        12s
  ◯ worker    anthropic/claude-sonnet-4-6 high       picker clamp                           stopped · 6m
```

Status marks are shared across the agent panel, `/tasks`, and completion notices:

| Mark | Meaning |
| --- | --- |
| `◯` (grey) / `●` (bold) | Running (`●` marks the chat currently on screen) |
| `◆` | Needs input (displays the subagent's question) |
| `‖` (yellow) | Active turn paused with `Esc` |
| `○` | Queued for a concurrency slot |
| `◌` (dim) | [Released while waiting](/subagents#released-subagents) on a long-running call or shell |
| `●` (green) / `✗` | Completed / Failed |
| `◼` / `◯` (red) | Stopping / Stopped (user stop, timeout, or `pause`/`quit` awaiting resume) |
| `⧗` | Running shell nested under its subagent |

Press `↓` on an empty prompt to focus the agent panel. The selected row shows Atomic's selection cursor (`∀`) before its status mark:

- `↑` / `↓` move across `main`, subagents, and nested shells (wrapping from bottom to top).
- `Enter` or `→` switches the chat screen to that subagent (or opens a nested shell's output in `/tasks`).
- `x` pressed twice within 3 seconds stops a running subagent or shell; `x` once dismisses a finished row.
- `Esc`, `←`, or `↑` past the top row returns focus to the prompt without switching views. `?` shows panel keys.
- In fullscreen mode, click any row or footer hint (`↓ N agents`, `/tasks to manage`) to switch or open it directly.

## Viewing a subagent

Selecting a subagent swaps the shared chat screen to its live transcript and aims the prompt box at that subagent while your main session continues uninterrupted.

- **Switch back.** Press `←` on an empty prompt (or select `main` in the panel) to return to the main chat. Each agent preserves its own unsent draft and prompt history (`↑`, `↓`, `Ctrl+R`).
- **Steer, follow up, or pause.** Press `Enter` to send or steer, `Alt+Enter` to queue a follow-up, `Alt+Up` to pull queued messages back into the prompt, and `Esc` (or `Ctrl+C` on an empty prompt) to pause the subagent's active turn without affecting main chat. Sending a message to a finished, paused, or stopped subagent resumes it.
- **Questions and waited shells.** Questions (`ask_user_question` or approval forms) open at the bottom of the subagent's transcript. When viewing a released subagent waiting on a shell, press `Alt+W` (or click `· alt+w opens it`) to inspect that shell in `/tasks`.
- **Slash commands.** Built-in session commands run on `main` (asking confirmation before rewriting `main` and refusing `/model` or `/thinking`), `/copy` copies the viewed subagent's last answer, and `/skill:<name>`, prompt templates, and user or project extension commands run in the viewed subagent. See [Commands while viewing a subagent](/background-tasks/reference#commands-while-viewing-a-subagent) and [Slash commands](/slash-commands).

## Open the task inspector

Run `/tasks` (or `/tasks <id>`) to view all running and recent subagents and main-chat shells grouped under **Needs input**, **Working**, and **Done**. Opening or closing `/tasks` never interrupts running work.

| Action | Keys |
| --- | --- |
| Select row (marked with `∀`) | `↑` / `↓` |
| Peek card (and quick reply box for active subagents) | `Space` |
| Open subagent chat, answer question, or open shell output | `Enter` / `→` (or click) |
| Filter by name or task | `/` (`Enter` keeps filter, `Esc` clears) |
| Stop running task / dismiss finished row | `x` twice within 3s / `x` once |
| Stop all background subagents and shells | `Ctrl+X` then `Ctrl+K` (confirm twice) |
| Scroll transcript or shell output | `PageUp` / `PageDown`, mouse wheel, `Ctrl+Home` / `Ctrl+End` |
| Toggle tool output / thinking blocks | `Ctrl+O` / `Ctrl+T` |
| Go back or close `/tasks` | `Esc` / `←` (`?` shows all keys) |

## Task heartbeats

Running shells and subagents send a periodic heartbeat to the launching chat every 15 minutes by default. A heartbeat is a routine status check, never a failure signal or stop trigger: press `Ctrl+O` on a heartbeat card to expand recent shell lines or subagent metrics (elapsed time, current tool, turns, tokens, and model).

Override the interval per call with `heartbeatMs` (`0` disables; minimum `60000` ms / 1 minute):

```ts
bash({ command: "npm run e2e", wait: { kind: "background" }, heartbeatMs: 300000 })
subagent({ agent: "codebase-analyzer", task: "Map auth callers.", heartbeatMs: 0 })
```

Change the global default with [`tasks.heartbeatMs`](/settings#tasks) or stop heartbeats from waking an idle session with `tasks.heartbeatWakesIdleSession: false`. For sampling intervals, batching caps, and unread-heartbeat rules, see [Heartbeat sampling and batching](/background-tasks/reference#heartbeat-sampling-and-batching).

## Lifetime and cleanup

Background tasks belong to the session that launched them and do not cross between sessions.

- **Closing a session.** Background shells stop with their process trees when the session closes and do not auto-restart on resume. Running subagents stay resumable and relaunch automatically when you reopen the launching session.
- **Retention.** Each session keeps its **256** most recently finished tasks in `/tasks` alongside all active tasks. Older finished tasks are evicted from `/tasks` once their completion notices are delivered (conversation notices stay intact and subagent sessions remain resumable via `resume`, while evicted shell output files are deleted).
- **Cleanup details and SDK contracts.** For Linux cgroup v2 containment (`ATOMIC_TASK_CGROUP=0`), unconfirmed teardown timeouts, and SDK error types, see [Lifetime, retention, and process cleanup](/background-tasks/reference#lifetime-retention-and-cleanup).

## Next steps

<Columns cols={2}>
  <Card title="Background tasks reference" href="/background-tasks/reference">
    Tool wait matrix, subagent slash-command routing, heartbeat batching limits, cgroup cleanup, and SDK errors.
  </Card>
  <Card title="Run subagents" href="/subagents">
    Bundled specialists, fresh vs. forked context, Git worktrees, run control, and peer coordination.
  </Card>
  <Card title="Built-in tools" href="/tools#bash">
    Parameters and output limits for `bash`, `powershell`, `kill`, `read`, and `search`.
  </Card>
  <Card title="Keybindings" href="/keybindings">
    Remap task panel, stop, waited-shell, and transcript navigation shortcuts.
  </Card>
</Columns>
