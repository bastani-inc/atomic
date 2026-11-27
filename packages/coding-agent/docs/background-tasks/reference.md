---
title: "Background tasks reference"
sidebarTitle: "Background tasks"
description: "Tool observation and wait semantics, slash-command routing in subagent views, heartbeat sampling limits, process cleanup, and task SDK errors."
---

This page documents the exact tool contracts, UI layout rules, heartbeat sampling bounds, process-tree cleanup behavior, and `@bastani/atomic` SDK error classes for background tasks. For everyday interactive usage, see [Manage background tasks](/background-tasks).

## Observation and wait matrix {#choose-how-long-to-wait}

Tool calls choose foreground-first or immediate background observation through `wait` and `action: "wait"`. Observation budgets control only when a tool call returns; they never kill a running command or subagent.

| Call | Observation behavior |
| --- | --- |
| `bash`, `powershell`, or `history://` `read`/`search` without `wait` | Waits for the session's command observation budget (default `10000` ms), then returns a task ID (`task-...` or `history-...`) while the task continues in the background. |
| `bash`, `powershell`, or `history://` `read`/`search` with `wait: { kind: "background" }` | Returns a task ID immediately without waiting (`budgetMs` is disallowed with `kind: "background"`). |
| `bash`, `powershell`, or `history://` `read`/`search` with `wait: { kind: "foreground" }` | Waits for the session's command observation budget (default `10000` ms), then continues in the background if still running. |
| `bash`, `powershell`, or `history://` `read`/`search` with `wait: { kind: "foreground", budgetMs }` | Waits up to `budgetMs` milliseconds (finite non-negative number; `0` returns immediately), then continues in the background if still running. |
| `{ action: "wait", id, budgetMs? }` on `bash`, `powershell`, `read`, or `search` | Observes an existing task from this session up to `budgetMs` (default `10000` ms when omitted; `0` polls immediately). Cannot be combined with launch fields (`command`, `path`, `pattern`, `paths`, `wait`). |
| `subagent` launch | Always runs in the background and returns at admission. Any `wait` passed on launch is ignored (passing `wait: { kind: "foreground" }` adds a note pointing to `action: "wait"`). |
| `subagent({ action: "wait", id, budgetMs? })` | Waits up to `budgetMs` (default `tasks.wait.agentBudgetMs`, `30000` ms; `0` polls immediately). Yields on user steering (`input-needed`), inbound Intercom messages (`intercom-coordination`), heartbeats, or `Esc` without stopping the subagent. |

Key behavioral rules:

- **Cancelling a launch vs. cancelling `action: "wait"`.** Pressing `Esc` (or aborting the call's `AbortSignal`) during the **initial foreground wait** of `bash`, `powershell`, or `history://` `read`/`search` **cancels the underlying command or history scan**. By contrast, cancelling `{ action: "wait", id }` on an already-running task only ends the wait and leaves the task running with its original deadline.
- **Incremental output paging on running shells.** Calling `bash` or `powershell` with `{ action: "wait", id }` on a **running** shell returns at most **8 KiB** of newly produced output per call (trimmed to a complete UTF-8 character boundary and advancing the wait offset). When more output is buffered, Atomic appends `[Additional output not shown; wait again to retrieve retained output.]`. Waiting on a **settled** shell returns all retained output (subject to standard truncation with a full-output file path).
- **Timed-out shell waits.** Waiting on a shell stopped by its `timeout` returns `isError: true` and reports `Task <id> was cancelled (timed out after <N> seconds).`.
- **Unknown and evicted IDs.** Waiting on an unknown shell ID fails with `No background task "<id>" in this session`. Waiting on an evicted shell ID fails with `TaskEvicted: Task "<id>" finished and is no longer kept in this session`. Waiting on an unknown or expired history task fails with `Unknown history task <id>: it was never started here, or it ended long ago`.
- **SDK host default wait policy.** Custom SDK hosts can override automatic wait budgets or set `tasks.wait.kind: "until-settled"` so omitted foreground budgets wait until completion, while explicit per-call `budgetMs` values still take precedence. See [Supervised command SDK](/sdk/reference#supervised-command-sdk).

## Stopping tasks and `CancelReceipt` {#stop-a-shell-task-from-a-tool-call}

### `kill` tool contract

`kill({ id })` stops a background shell (`bash` or `powershell`) or a background `history://` scan started by the current session:

- **Shell tasks.** Returns a summary line (`◼ stopping · cancellation requested`, `◯ cancelled`, or `● already completed · exit 0`) and a structured `CancelReceipt` in `details`:
  - `taskId`: the task identifier.
  - `decision`: `"already-settled" | "already-finishing" | "cancellation-requested"`.
  - `execution`: `{ kind: "queued" | "running" | "cancelling" | "settled", ... }`.
  - `cleanup`: `{ kind: "active" | "draining" | "reaped" | "quarantined" | "failed", ... }`. When `cleanup.kind === "failed"`, the tool result sets `isError: true`.
  - If a command finished before `kill` ran, its original outcome is preserved. Stopping a task never erases its output or completion notice.
- **History tasks (`history-N`).** Stops the scan, sends no completion notice, and returns plain text with `details: undefined` (no `CancelReceipt`).
- **Subagent tasks.** Calling `kill` with a subagent task ID is rejected with `kill only supports shell tasks`. Use `subagent({ action: "quit", id })` or `subagent({ action: "pause", id })` instead.
- **Interactive stop-all (`Ctrl+X Ctrl+K`).** Stops every running or queued background subagent and shell owned by the session (including shells started by subagents). It does **not** stop background `history://` tasks.
- **Windows supervision.** Native Windows refuses background shell launches it cannot supervise, and legacy Windows WSL `bash.exe` stdin transport is unsupported (run Atomic inside WSL for POSIX Bash).

## Commands while viewing a subagent {#commands-while-viewing-a-subagent}

Slash commands behave differently depending on whether you are viewing a subagent on the **main chat screen** (selected from the agent panel or `/tasks`) or inside a **subagent's own chat surface** inside `/tasks`.

### Main-screen subagent view

| Input or shortcut | Behavior while viewing a subagent on the main screen |
| --- | --- |
| `/settings`, `/scoped-models`, `/tasks`, `/resume`, `/export`, `/share`, `/trust`, `/login`, `/logout`, `/reload`, `/quit`, `/exit`, `app.session.resume` | Run on `main` in place while the subagent remains visible. `/tasks` lists all tasks of the session; `/resume` opens the session picker. |
| Bundled extension commands (`/agents`, `/mcp`, `/intercom`, `/curator`, `/google-account`, `/search`, `/websearch`, `/llama`) | Run on `main` in place while the subagent remains visible. |
| `/session`, `/tools`, `/changelog`, `/hotkeys`, `/name`, `/debug` | Switch to `main` first so output prints in the main transcript while preserving main's draft. |
| `/compact`, `/tree`, `/fork`, `/clone`, `/new`, `/import`, registered `/clear` or `/rewind`, `app.session.new`, `app.session.tree`, `app.session.fork` | Prompt for confirmation (`/<command> acts on the main conversation, not <agent>`, defaulting to **Cancel**). Once confirmed, `/new` and `/import` switch to `main` immediately; `/fork` and `/clone` switch to `main` when complete. |
| `/model`, `/thinking`, `Ctrl+L`, `Ctrl+P`, `Shift+Ctrl+P`, `Shift+Tab` | Refused with a notice under the subagent transcript. Switch to `main` to change main's model or thinking level. |
| `!cmd`, `!!cmd` | Refused with `` `!` commands run in the main chat. Switch to main to run them. `` Text stays in the prompt. |
| `/copy` | Copies the viewed subagent's last assistant message to the clipboard. |
| `/skill:<name>`, prompt templates, user or project extension commands, ordinary text | Sent to the viewed subagent's own session using its skills, templates, and working directory. |

### Bare-only vs. argument-taking built-in commands

- **Take arguments (intercepted with or without arguments):** `/tasks`, `/model`, `/thinking`, `/export`, `/import`, `/name`, `/login`, `/logout`, `/compact`, `/resume`, plus `/session snapshot`.
- **Bare-only (intercepted only with no trailing text):** `/settings`, `/scoped-models`, `/share`, `/trust`, `/reload`, `/quit`, `/exit`, `/tools`, `/changelog`, `/hotkeys`, `/tree`, `/fork`, `/clone`, `/new`, `/copy`, `/debug`, and `/session` (other than `/session snapshot`). Appending extra text (such as `/copy that` or `/new idea`) sends the line to the subagent as normal text.

### Subagent chat inside `/tasks`

Inside a subagent's own chat surface in `/tasks`, only `/tasks` (listing that subagent's own tasks), `/copy`, and `/hotkeys` run locally. Every other built-in slash command is refused with `/<name> is not available in a subagent chat` and never sent as text. Skills, prompt templates, and user or project extension commands still run in the subagent's session.

See [Slash commands](/slash-commands) for the full command catalog.

## Agent panel and `/tasks` UI reference

### Responsive columns, row limits, and timers

- **Model column.** Displays `provider/model-id` and reasoning level, capped at **40 columns** (truncating the model ID while keeping the reasoning level). Updates on model fallback, resume, or effort change; blank when unknown.
- **Responsive breakpoints.** Task titles shorten first. Below **100 columns** (or when a row lacks space for task and elapsed time), the model column hides. Below **70 columns**, token counts hide. If fewer than **8 columns** remain for the task title, the title hides.
- **Row caps.** Up to **4** rows appear while the prompt has focus (`+N more` counts omitted rows, including nested shells, while keeping the viewed subagent and its running shells visible). Focusing the panel displays up to **8** rows at a time. The `main` row never counts toward either cap.
- **Stopped-row dimming.** Finished subagents leave the panel immediately unless currently viewed (a viewed finished row stays until you switch away or dismiss it with `x`). Stopped, paused, or interrupted subagents stay while other work runs, dim after **30 seconds**, and leave once nothing else is running.
- **Selection memory.** The panel remembers your last selected row (`main`, subagent, or a subagent opened from `/tasks` via `Enter` or click) and scroll position across visits. Leaving `/tasks` with `Esc` does not change the remembered row.
- **Shell output previews and large saved entries.** `/tasks` shell output pages display the last **8 KiB** of retained output starting on a valid UTF-8 character boundary (trailing blank lines trimmed; unframed below **24 columns**). Shell detail pages display up to 10 wrapped lines from that 8 KiB tail. Database-backed subagent transcripts page on scroll; any single saved entry exceeding **1 MiB** shows its position and byte count so you can read it via `history://` or export.
- **Keybinding IDs.** Customize task shortcuts in `keybindings.json` ([Keybindings](/keybindings)), including `app.list.stop` (`x`), `app.tasks.openWaited` (`Alt+W`), `app.session.resume`, and `app.session.new` / `tree` / `fork`.

### Extension panel sources

Extensions can contribute custom rows to the agent panel and `/tasks` via [`atomic.registerAgentPanelSource()`](/extensions/api-reference#atomic-registeragentpanelsource-source). If an extension source throws or returns invalid rows, Atomic hides that source's invalid rows and logs a warning once per source while keeping other rows and chat usable; fix the extension and run `/reload` to re-register.

## Heartbeat sampling and batching

- **Eligible states.** Only **running** shells and subagents emit heartbeats. Queued, stopping, completed, failed, killed, paused, quit, and `history://` tasks never emit heartbeats.
- **Cadence rules.** The interval (`heartbeatMs`, default `tasks.heartbeatMs` = `900000` ms / 15 minutes; `0` disables; minimum `60000` ms) counts from when the task started running. In parallel `subagent` calls, a per-task `heartbeatMs` overrides the top-level value. Resumed subagents keep their original launch's `heartbeatMs` (falling back to the chat default only if omitted originally).
- **Shell sampling.** Shell output is sampled every **30 seconds** from the trailing **2 KiB** of output, reporting total output size, time since last output, and up to **6** non-empty trailing lines (each capped at **160 characters**).
- **Subagent fields.** Subagent heartbeats report agent name, elapsed time, time since last activity, current or last tool call, turn count, tool-call count, token count, **active model** (and fallback mismatch `model <ran>, not the requested <requested>` when fallback occurred), and attention states (`input-needed` or `no recent activity`).
- **Batching and caps.** Tasks coming due within `min(1 minute, cadence / 4)` share one heartbeat (for example, 15 seconds on a 1-minute cadence). One heartbeat describes up to **8** tasks in full, lists up to **20** more by name, and summarizes any beyond 28 as `; and N more`. In chat, a collapsed heartbeat card lists up to 5 tasks and counts the rest.
- **Backpressure and idle wake.** Each chat holds at most **1** unread heartbeat. While an unread heartbeat waits, due tasks recheck every **30 seconds**; missed intervals never stack or replay. Heartbeats queue without interrupting streaming text and wake an idle chat (including after an `Esc` interrupt) unless `tasks.heartbeatWakesIdleSession` is `false` or you queued a draft and interrupted with `Ctrl+C`. Heartbeats also yield an active `action: "wait"` call while the task continues.
- **Routing.** Subagent-launched shells are managed by the launching main session, so their heartbeats go to the main session.

## Lifetime, retention, and process cleanup {#lifetime-retention-and-cleanup}

### Output and retention limits

| Resource | Limit | Behavior when reached |
| --- | --- | --- |
| Shell live preview buffer | `1 MiB` (`1,048,576` B) | Bounds live preview memory while full output spools to disk. |
| Shell foreground spill threshold | `8 MiB` (`8,388,608` B) | Spills large foreground output cleanly without unbounded memory growth. |
| Shell disk output cap | `5 GiB` (`5,368,709,120` B) | Cancels runaway-output shells automatically with cause `"output-limit"` (`"output limit reached"`). |
| Concurrent shell commands per session | `64` | Refuses new launches until a command finishes or stops (includes subagent shells; excludes stopping shells). |
| Concurrent `history://` tasks per session | `4` | Refuses new history scans until one finishes or stops; separate from the 64-shell limit. |
| Finished tasks retained per session | `256` (`FINISHED_TASK_RETENTION`) | Evicts the oldest finished task once its completion notice is delivered; deletes evicted shell output files while preserving conversation notices and saved subagent sessions. |
| Finished `history://` tasks retained | `16` | Kept in memory so late `action: "wait"` calls still return the result. |

### Process-tree containment and cleanup

- **Linux and macOS.** Each shell command runs in its own session so teardown stops child processes across process groups while leaving intentionally detached processes (such as `setsid` daemons) alone once they close stdout/stderr. On Linux with a user-owned **cgroup v2** hierarchy, Atomic additionally places background shells in cgroups for tighter process-tree containment. Set `ATOMIC_TASK_CGROUP=0` to disable cgroup v2 containment (for example in containers with restrictive cgroup policies).
- **Windows.** Atomic uses Windows Job objects to terminate process trees cleanly. On native Windows, Suspend opens a PowerShell subshell while background tasks keep running until you exit back to Atomic.
- **Unconfirmed teardown and admission waits.** If a shell exits while a descendant keeps stdout/stderr open, Atomic preserves the shell's exit code and output (discarding later writes) and waits up to **15 seconds** in the background — and up to **15 seconds** more on session close — to confirm process-tree teardown (`cleanup.kind: "quarantined"`). While waiting for confirmation, that shell holds its concurrency permit. New shell launches blocked only by pending-cleanup permits wait up to **5 seconds** before failing with `TaskCleanupAdmissionTimeoutError`.
- **Temporary worktrees on close.** Closing or switching sessions waits for subagent execution, output, and recovery notices while remaining batch Git worktree cleanup continues in the background. See [Temporary worktrees](/subagents#temporary-worktrees).

## Task SDK errors

All four task error families below are exported from `@bastani/atomic`. Branch on the class, guard, or `code`, not the message text.

### `TaskEvictedError`

Thrown (or wrapped as `cause` on `TaskToolError` with `code: "TaskEvicted"`) when a task finished and was evicted past the 256-task retention window (`FINISHED_TASK_RETENTION`).

- `code`: `"task_evicted"`
- `retryable`: `false`
- Fields: `taskId`, `retainedFinishedTasks`, `hint`
- Helpers: `isTaskEvictedError(error)`, `findTaskEvictedError(error)`, `rehydrateTaskEvictedError(serialized)`

### `TaskCleanupError` and `TaskCleanupAdmissionTimeoutError`

Thrown when shell process-tree teardown cannot be confirmed within the confirmation window, or when a new command waits 5 seconds behind unconfirmed-cleanup permits.

- `code`: `"task_cleanup_unconfirmed"` (both classes)
- `retryable`: `true` (`isRetryableTaskError(error)` returns `true`)
- `TaskCleanupError` fields: `phase` (`"session-close" | "app-shutdown" | "stage-pause" | "command-admission"`), `failures` (`readonly TaskCleanupFailure[]`), `hint`
- `TaskCleanupAdmissionTimeoutError` extends `TaskCleanupError` with `phase: "command-admission"`, `timeoutMs`, and `elapsedMs`
- Helpers: `isTaskCleanupError(error)`, `isTaskCleanupAdmissionTimeoutError(error)`, `isRetryableTaskError(error)`, `rehydrateTaskCleanupError(serialized)`

### `TaskToolError`

Thrown on shell `wait` and `kill` failures. Only `StaleGeneration` is `retryable: true`. On `TaskEvicted`, `error.cause` is a `TaskEvictedError`.

| `code` | Meaning | `retryable` |
| --- | --- | --- |
| `UnknownTask` | Task ID does not exist in this session. | `false` |
| `ScopeMismatch` | Task ID belongs to a different session. | `false` |
| `TaskEvicted` | Finished task left the 256-task retention window (`cause`: `TaskEvictedError`). | `false` |
| `OwnerClosed` | Session's task owner has closed. | `false` |
| `EnvironmentClosing` | Atomic runtime is shutting down. | `false` |
| `ObserverCancelled` | Wait call was cancelled by its caller signal. | `false` |
| `OutputUnavailable` | Retained task output is no longer readable. | `false` |
| `CleanupFailed` | Stopping or cleaning up the task failed. | `false` |
| `StaleGeneration` | Task list generation changed during read; retry the call. | `true` |

Helpers: `isTaskToolError(error)`, `rehydrateTaskToolError(serialized)`.

### `TaskMessageError` and `TaskMessageTimeoutError`

Thrown when sending a typed message into a task transcript fails.

| `code` | Meaning | `retryable` |
| --- | --- | --- |
| `task-unavailable` | Task is no longer available to receive messages. | `false` |
| `messages-unsupported` | Task kind does not accept transcript messages (for example, a shell task). | `false` |
| `delivery-refused` | Target agent refused delivery; check availability and retry. | `true` |
| `delivery-unconfirmed` | Delivery acknowledgement was not confirmed (`TaskMessageTimeoutError` sets `phase: "delivery-acknowledgement"`, `timeoutMs`, `elapsedMs`). Check transcript before retrying. | `false` |

Helpers: `isTaskMessageError(error)`, `isTaskMessageTimeoutError(error)`, `isRetryableTaskMessageError(error)`, `findTaskMessageError(error)`, `rehydrateTaskMessageError(serialized)`.

## Related SDK documentation

- [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor)
- [Finished task retention and eviction](/sdk/reference#finished-task-retention-and-eviction)
- [Supervised command SDK](/sdk/reference#supervised-command-sdk)
- [`atomic.registerAgentPanelSource()`](/extensions/api-reference#atomic-registeragentpanelsource-source)
