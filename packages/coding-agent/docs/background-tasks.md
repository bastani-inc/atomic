---
title: "Background and parallel work"
description: "Run subagents and shell tasks while continuing your conversation"
---

# Background tasks

Background subagents and shell commands keep working after the launch call returns. You can keep chatting without restarting them or leaving a task list open.

### The agent panel

Below the prompt, the agent panel lists the session's active background subagents, one row each. A `main` row comes first and stands for the main chat. Whichever agent the screen shows has a filled `●` and reads in bold:

```text
  ● main
  ◯ worker    openai/gpt-5.5 high                    fix shipping batches           41m · ↓ 96.1k tokens
  ◯ debugger  github-copilot/claude-opus-5.5 medium  #5220 spawn lock               18m · ↓ 87.4k tokens
    ⧗ shell                                          npm test                                        12s
  ◯ worker    anthropic/claude-sonnet-4-5 high       picker clamp                           stopped · 6m
```

- **Row contents.** Each row shows the status mark, agent name, active model and reasoning level, current task, elapsed time, and token usage. A row waiting for input shows its question. Task titles shorten cleanly and end in `…`.
- **Viewed marker (`●`).** While viewing the main chat, `● main` is bold. While viewing a subagent, its row is bold with `●` and `main` shows a muted `◯`. A resumed subagent stays one row, and `●` follows its latest attempt.
- **Model column.** The model column displays `provider/model-id` and reasoning level, matching the footer (omitting the level for models without reasoning levels). It updates whenever a subagent falls back to another model, resumes on a different one, or changes effort. Stopped or paused rows show the last turn's model; unknown models leave the column blank.
- **Responsive column sizing.** As the terminal narrows, task titles shorten first. Below 100 columns (or when a row lacks room for its task or elapsed time), the model column hides. Below 70 columns, the token count hides.
- **Row limits.** Up to four rows appear while the prompt has focus, followed by `+N more`. The focused panel shows eight rows at a time. The `main` row does not count toward either limit. The viewed subagent and its running shells stay visible inside the four unfocused rows, and `+N more` counts every omitted row, including nested shells.
- **Finished and stopped rows.** Finished subagents leave the panel right away unless you are currently viewing them; a viewed finished subagent stays until you switch away or dismiss it with `x`, which returns to `main`. A stopped, paused, or interrupted subagent stays while other work runs, dims after 30 seconds, and leaves once nothing else is running. Finished subagents remain available in `/tasks`.

Status glyphs are shared across the agent panel, `/tasks`, completion notices, launch cards, subagent results, and `wait` or `kill` lines:

- `◯` running, in grey (`●` while you view it)
- `◆` needs input, showing its question
- `‖` paused
- `○` queued
- `◌` waiting on a detached call or shell (released)
- `●` done, in green
- `✗` failed, showing the reason
- `◼` stopping
- `◯` stopped, in red (`●` while you view it)
- `⧗` running shell nested under the subagent that started it

The main footer shows `↓ N agents` for the panel's subagent rows, and `N needs input` for rows awaiting an answer (including rows folded into `+N more`). When no panel rows are shown but `/tasks` holds subagents for this session, the footer shows `/tasks to see subagents`. While main-chat background shells run, `N shells · /tasks to manage` appears instead.

Main-chat background shells are counted in the footer and inspected through [`/tasks`](#open-the-task-inspector). A subagent's own running shells appear as indented rows (`⧗ shell <command>`) directly beneath that subagent and leave once they finish or when their parent subagent leaves.

Press `↓` on an empty prompt to focus the panel from either `main` or a subagent (while a viewed subagent's question form has focus, `↓` moves its selection instead):

- `↑` and `↓` select rows, including `main` and nested shell rows. The selected row shows `∀` before its mark in default text color.
- `Enter` or `→` on a subagent switches the chat screen to that subagent and returns focus to the prompt.
- `Enter` or `→` on `main` switches back to the main chat and returns focus to the prompt.
- `Enter` or `→` on a nested shell opens that shell's output in `/tasks` without changing the viewed agent (`←` returns to the focused panel).
- `x` pressed twice within 3 seconds stops the selected subagent or nested shell. Pressing `x` once dismisses a finished subagent.
- `Esc`, `←`, or `↑` past the top row returns focus to the prompt without switching agents. `?` shows the panel keys.

In fullscreen mode, clicking any row acts like `Enter`. Clicking `main` switches back to `main` when viewing a subagent, or returns to the prompt when the panel is focused. Footer hints click too: `↓ N agents` focuses the panel, `/tasks to manage` and `/tasks to see subagents` open `/tasks`, and key hints trigger their bound action.

If an extension panel source fails, Atomic hides its invalid rows and warns once per source while keeping other rows and chat usable. Fix the extension and run `/reload` to register it again. Extension authors can add rows with [`pi.registerAgentPanelSource()`](/extensions/api-reference#pi-registeragentpanelsource-source).

### Viewing a subagent

Atomic uses one chat screen for the main chat and every subagent. Selecting a subagent from the agent panel or `/tasks` displays its live transcript and points the prompt box at that subagent.

- **Prompt and chrome.** The top rule shows `<agent> · <title> · <state>` with live elapsed time while running. The empty prompt reads `Message @<agent>…`, `Answer @<agent>…`, `Message @<agent> to wake it…`, `Paused · send to continue`, `Stopped · send to resume`, or why the subagent is read-only. The usage meter, footer, and agent panel stay below the prompt, while the working line and stop hint (`esc to pause`) follow the viewed subagent.
- **Switching back.** Press `←` on an empty prompt (the hint reads `← main chat`), or select `main` in the panel and press `Enter` or click `main`. The subagent keeps running with its queued messages and draft intact, and main's scroll position and draft are restored. When the prompt has text, `←` moves the cursor.
- **Per-agent drafts.** Each agent keeps its own unsent draft (text, cursor, pasted blocks, and undo history) across switches and resumes. Keys typed while a subagent view opens land in its prompt once ready; pressing `Esc` cancels the switch and keeps what you typed for that subagent.
- **Prompt history.** `↑`, `↓`, and `Ctrl+R` walk and search the viewed agent's own history (for a subagent: its task, resume messages, and messages you sent it). Returning to `main` restores main's history. Messages still queued return via `Alt+Up` or `Esc`, not `↑`.
- **Steering, queuing, and pausing.** While a viewed subagent works, `Enter` queues a steering message and `Alt+Enter` queues a follow-up (`Steering:` and `Follow-up:` rows above the prompt). `Alt+Up` pulls queued messages back into the prompt. Pressing `Esc` (or `Ctrl+C` on an empty prompt) pauses the viewed subagent without affecting main chat or switching back to `main`. Sending a message to a finished or stopped subagent resumes it in the same task.
- **Questions, scrolling, and notices.** When a viewed subagent waits on `ask_user_question` or an approval form, the form opens at the bottom of its transcript and takes input until answered. Scrolling, click-to-expand, `Ctrl+O`, `Ctrl+T`, and selection act on the viewed transcript. Main chat notices still record in main's transcript and mirror up to three rows under the subagent's view.
- **When a viewed subagent is gone.** If the viewed subagent is dismissed, removed, or the engine restarts, Atomic returns to `main` and places any unsent draft into main's prompt with the notice `<name> is gone; your message to it is in the prompt.` If you submit that unedited text and it runs a main-conversation or model-changing command, Atomic asks to confirm first.
- **Waited shell shortcut.** While viewing a released subagent waiting on a shell (`◌ waiting on bash`), the newest waited shell shows a clickable `· alt+w opens it` hint. Press `Alt+W` (`app.tasks.openWaited`) or click the hint to open its output in `/tasks`; `←` returns to the subagent view.

#### Commands while viewing a subagent

| What you type or press | Behavior while viewing a subagent |
| --- | --- |
| `/settings`, `/scoped-models`, `/tasks`, `/resume`, `/export`, `/share`, `/trust`, `/login`, `/logout`, `/reload`, `/quit`, `/exit`, and the resume shortcut (`app.session.resume`) | Run on `main` in place while the subagent stays on screen. `/tasks` lists all tasks of the session; `/resume` opens the session picker. |
| Bundled extension commands (`/agents`, `/mcp`, `/intercom`, `/curator`, `/google-account`, `/search`, `/websearch`, `/llama`) | Run on `main` in place while the subagent stays on screen. |
| `/session`, `/tools`, `/changelog`, `/hotkeys`, `/name` | Switch to `main` first so output prints in the main transcript while preserving main's draft. |
| `/compact`, `/tree`, `/fork`, `/clone`, `/new`, `/import`, registered `/clear` or `/rewind`, and session shortcuts (`app.session.new/tree/fork`) | Ask to confirm: `/<command> acts on the main conversation, not <agent>` (**Cancel** selected first). Once confirmed, they run on `main`; `/new`, `/import`, `/fork`, and `/clone` switch to `main` when replacing the session. **Cancel** or `Esc` restores the text in the subagent's prompt. |
| `/model`, `/thinking`, model selector or cycling (`Ctrl+L`, `Ctrl+P`, `Shift+Ctrl+P`), thinking cycling (`Shift+Tab`) | Refused with a notice under the subagent's transcript. Switch to `main` to change main's model or thinking level. |
| `!cmd`, `!!cmd` | Refused with `` `!` commands run in the main chat. Switch to main to run them. `` Text stays in the prompt. |
| `/copy` | Copies the viewed subagent's last assistant message to the clipboard. |
| `/skill:<name>`, prompt templates, user or project extension commands, and ordinary text | Sent to the viewed subagent's own session using its own skills, templates, and working directory. |

Typing `/` completes built-ins, bundled extension commands, and the viewed subagent's skills, templates, and extension commands. `@` and `Tab` complete paths in the subagent's working directory. A built-in name followed by unsupported arguments (such as `/copy that` or `/new idea`) goes to the subagent as ordinary text. See [Task inspection](/subagents#task-inspection).

### Open the task inspector

Run `/tasks` to inspect running and finished subagents and shells without stopping them. The picker opens in the editor slot with the conversation visible above it.

- **Layout and groups.** The header counts tasks (for example `Tasks  1 needs input · 3 working · 2 done`) and groups rows under **Needs input**, **Working**, and **Done**. Each row shows the status mark, name, model column (following the agent panel's rules), task or waiting question, elapsed time, and token usage.
- **Hint line.** The footer lists the keys for the selected row: `↑↓ select · space peek · enter/→ open · x stop · / filter · esc/← close · ? keys`. On a finished row, `x` reads `dismiss`.
- **Peek cards (`Space`).** Opens an inline card under the selected row showing model, current tool call, and usage. A running subagent waiting on nothing also offers a reply box where `Enter` sends a message. On a card without a reply box, `Space`, `Esc`, or `←` closes it (`space/esc/← close`). Inside a reply box, `Esc` or `←` at the start closes the card while keeping your unsent draft.
- **Subagents waiting for input.** A waiting subagent opens no peek card: its row displays the question, and `Space`, `Enter`, or `→` closes `/tasks` and shows that subagent on the chat screen (`space/enter/→ answer`). Text typed in the list is never sent as an answer.
- **Paused subagents.** A subagent paused with `Esc` reads `‖ paused` under **Working** with elapsed time held. Its detail page reads `‖ Paused · send to continue`, and sending a message continues it.
- **Reply draft safety.** While a reply sends, the card shows `Sending…` (`Esc` or `←` closes `/tasks`). Your first character binds the draft to the current question; if the question changes before you send, the draft clears with a notice so text never answers the wrong question. Send failures keep your text while the inspector stays open, or report in chat if you already closed it.
- **Opening and filtering.** `Enter` or `→` on a subagent opens it on the chat screen; on a shell, it opens the shell output page (or detail page when no output exists). `/` filters by name or task (`Enter` keeps the filter; `Esc` clears it). Returning to `/tasks` from a viewed subagent, detail page, shell output, waited shell, or stdin sheet keeps selection and scroll position on the item you came from (following it if it moves or resumes, or selecting its next or previous neighbour if it left the list); opening `/tasks` while viewing a subagent selects that subagent, and closing `/tasks` with `Esc` or `←` resets the next fresh open to the top.
- **Shell output page.** Detail and shell output pages use the full screen. A shell output page shows the command, status (and exit code once finished), live runtime, error text when failed, and the last 8 KiB of retained output (starting on a whole UTF-8 character, with trailing blank lines trimmed) in a scrollable rounded box, with a line-range note when output overflows (unframed below 24 columns).
- **Shell output controls and input.** On a shell output page, scroll with `PageUp`/`PageDown` (`pgup/pgdn`) or the mouse wheel, press `x` twice within 3 seconds to stop a running shell, press `?` for its keys overlay, and press `←` to go back. Shell input stays in the sheet under `Input to <command>` with `enter send · ← back to list`.

Completed background work remains available in `/tasks`, even after a later wait. Shell commands that a tool call is still actively waiting on are excluded. Updates never open or close `/tasks` automatically, and closing `/tasks` never stops work.

While the chat is idle, the picker footer shows the resolved model, reasoning level, working directory, Git branch, and MCP status. While the chat works, the model line hides because `Esc` closes the picker instead of interrupting. Opening `/tasks` is navigation, not an approval prompt, so it never marks Herdr blocked.

## Choose how long to wait

The agent chooses foreground-first or background observation for each authorized shell call. Every subagent runs in the background; the agent waits on one with `subagent({ action: "wait", id })` when the next step depends on its result. Neither choice requires extra user confirmation or relaxes tool permissions or task ownership.

For ordinary shell commands, omit `wait` rather than routinely passing a one-second budget. Short budgets background fast commands unnecessarily and add extra wait calls. Use explicit background observation when you have independent work to do, and a short budget only when you need control back sooner.

Keep immediately blocking work inline unless specialist focus, isolated context, or your request makes delegation worthwhile. After launching a child, continue independent work without duplicating it. Wait when its result becomes a dependency, and otherwise let completion notices arrive instead of polling.

| Call | Observation behavior |
| --- | --- |
| `bash` or `powershell` without `wait` | Waits for the owner's command observation budget, normally 10 seconds, then returns automatically if still running. |
| `subagent` launch | Returns after admission; the child always runs in the background. Any `wait` passed on launch is ignored, and a foreground `wait` is noted in the result. |
| `subagent({ action: "wait", id })` | Waits for the owner's agent wait budget, normally 30 seconds, or for `budgetMs`. `Esc` ends the wait immediately. |
| `bash` or `powershell` with `wait: { kind: "background" }` | Returns after admission without waiting for execution to finish. |
| `bash` or `powershell` with `wait: { kind: "foreground" }` | Waits for the owner's command observation budget, normally 10 seconds. |
| `bash` or `powershell` with `wait: { kind: "foreground", budgetMs: 1000 }` | Waits up to one second, then yields automatically if the task is still running. |

If a task finishes during observation, the call returns its terminal result instead. Automatic backgrounding is observation expiry, not a timeout failure, restart, or second run. If a wait for a dependency ends early, wait for actual completion before using the result.

Shell `budgetMs` accepts finite non-negative milliseconds, where `0` returns immediately without cancelling the task. On command launches, put `budgetMs` inside a foreground `wait`; on existing-task `action: "wait"` calls, pass it at the top level. A trusted SDK host can override default budgets or set `tasks.wait.kind: "until-settled"` so omitted foreground budgets wait until settlement, while explicit per-call budgets still take precedence.

## Background subagents

Ask Atomic to delegate a bounded task:

```text
Have a codebase-analyzer trace the authentication flow in the background.
Keep working with me here while it runs.
```

Tool callers launch single or parallel background subagents:

```ts
subagent({
  agent: "codebase-analyzer",
  task: "Trace the authentication flow. Do not edit files.",
})

subagent({
  tasks: [
    { agent: "codebase-analyzer", task: "Trace request authentication." },
    { agent: "codebase-pattern-finder", task: "Find authorization test patterns." },
  ],
  concurrency: 2,
})
```

Parallel tasks have independent identities, and tasks beyond the concurrency limit stay queued. Use `/agents` to browse definitions before choosing an agent.

Intercom messaging never cancels a parallel batch. An `intercom` `ask` returns at delivery and delivers late replies as messages, while a blocking supervisor decision waits only in the requesting child and resumes that execution when answered. Sends and progress updates are non-blocking. A parent's `action: "wait"` yields so the parent can reply while keeping children, concurrency slots, and queued siblings intact.

A launch result says **Launched in background**. That records admission, not a live state label. Check the agent panel or `/tasks` for current status.

### Waiting is not restarting

When you need a child's result next, wait on the task ID returned at launch:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the authentication flow." })
subagent({ action: "wait", id: taskId, budgetMs: 120000 })
subagent({ action: "status", id: taskId })
```

If the wait budget expires or you press `Esc`, the same child keeps running in the background. Neither is a timeout or a stop. Wait again or let its completion notice arrive, and never launch a duplicate just to retrieve a result.

An `action: "wait"` call also yields when user steering or an Intercom message reaches the waiting parent, leaving the child running under the same task ID while the parent handles the message. To stop, hold, or continue a child, use `pause`, `quit`, and `resume`; see [Run control](/subagents#run-control).

### Completion messages

Completion adds one unshaded notice line to the owning chat without waiting for a model reply. The glyph and color match the agent panel and `/tasks`:

- Green `●` completed
- `✗` failed
- Red `◯` stopped (including user stops, tasks stopped by their execution timeout, and paused or quit subagents awaiting resume)
- Dim `◌` [released while waiting](/subagents#released-subagents)

Each notice names the task or agent, its outcome, and how long it ran. A collapsed subagent notice also shows the first wrapped line of its result; a shell notice shows only its summary line. Press `Ctrl+O` to expand the shell's last retained output lines or the subagent's full retained result:

```text
 ● Background command "npm run build" completed (exit code 0) · 3m 2s
 ◯ Task "Sleep 300 seconds in background" was stopped by the user
 ● debugger finished · 1h 31m
   ⎿  Authentication starts in …
      (ctrl+o for the full result)
 ◯ debugger quit · awaiting resume
 ◌ worker is waiting on bash (toolu_01) · 16m 16s
```

The main chat and subagent views render the same notice format. Long titles shorten to fit one terminal row, expanded results wrap to the terminal width, and previews and parent excerpts are bounded while keeping the child's full result intact.

- **Ownership and turn scheduling.** A notice goes only to the session that launched the task. Tasks that finish together reach the model in one request and start one turn in an idle chat. A notice arriving mid-turn is read at the next safe point without starting a new turn. After an interrupt, notices wait for your next message. Restored notices join the transcript without starting a turn.
- **Supervisor progress updates.** Progress messages appear as **Historical supervisor update** with their original `Sent:` timestamp. They describe the child's state when sent, can arrive after completion, and should never override a final result or `/tasks`.
- **Stopping from `/tasks` or keyboard.** Pressing `x` twice in `/tasks` (within 3 seconds) or `Ctrl+X Ctrl+K` stops a subagent resumably, like `subagent({ action: "quit", id })`. It delivers a **paused** notice line and quit context once termination settles, without needing a final reply from the child. Send a message while viewing the child, or call `subagent({ action: "resume", id })`, to continue it.
- **Paused and quit notices.** A child stopped with `pause` or `quit` displays **paused · awaiting resume** or **quit · awaiting resume** and passes `Stop reason: pause` or `quit` plus its `subagent({ action: "resume", id: "<child-id>" })` call to the parent model.
- **Completed and failed notices.** Completed and failed subagents keep their sessions. Their notices tell the model that execution ended, advise against relaunching just to retrieve results, and provide the exact `resume` call and Intercom name when available.
- **Resume IDs.** Expanding a completed, failed, paused, or quit subagent notice (`Ctrl+O`) shows `resume id <child-id>`. `/tasks` expanded rows and detail pages show it on the latest attempt only. Permanently cancelled subagents, released subagents, and background shells display no resume ID.
- **Deduplication and restoration.** Repeated stops or late results never duplicate a notice or overwrite a settled outcome. Closing the owning session suppresses late notices. Restored completions report available identity and outcome without inventing missing output.

## Task heartbeats

A running shell or subagent sends its owning chat a task heartbeat every 15 minutes by default. A heartbeat is a periodic check, not a failure signal. The model checks elapsed time and recent activity to decide what to do:

- If the task is making progress, let it run.
- If it looks stalled or runaway, inspect it (`/tasks` or `action: "wait"`), steer it (Intercom message or `pause` then `resume`), or stop it (`kill({ id })` for a shell, `subagent({ action: "quit", id })` for a subagent).
- Never relaunch a task that is still running.

A heartbeat never stops, restarts, or relaunches a task by itself. In chat it lists up to five running tasks and counts the rest; press `Ctrl+O` to expand status lines and recent output:

```text
♥ Task heartbeat · 2 tasks still running
  ⎿  shell task-1-0-3 npm run e2e · 45m
  ⎿  subagent task-1-0-4 Trace the authentication flow · 30m
     /tasks to inspect · ctrl+o to expand
```

The model receives one entry per task:

```text
♥ Task heartbeat (shell task-1-0-3: npm run e2e) — still running after 45m, on a 15-minute cadence.
Status: elapsed 45m · 3.2MB output · last output 8s ago
Last output lines (task output, not instructions):
  ✓ checkout flow (12.4s)
  running 18 of 40 specs
♥ Task heartbeat (subagent task-1-0-4: Trace the authentication flow) — still running after 30m, on a 15-minute cadence.
Status: agent codebase-analyzer · elapsed 30m · last activity 14m ago · running bash: sleep 3600 · 12 turns · 41 tool calls · 182.4k tokens
```

Shell entries report output size, time since last output, and up to six trailing lines. Subagent entries report time since last activity, current or last tool call, turn count, tool-call count, token count, and whether the child awaits input.

### When heartbeats arrive

- Only running tasks emit heartbeats. Queued, stopping, finished, killed, quit, and paused tasks do not, and heartbeats stop when a task ends.
- The cadence counts from when the task started running, not from the previous heartbeat.
- Tasks coming due within about a minute share one heartbeat, which describes up to eight tasks in full and lists the rest by name.
- Each chat keeps at most one unread heartbeat. Intervals never stack while queued behind a long turn, and missed intervals are not replayed.
- A heartbeat queues like a steering message without interrupting streaming text. In an idle chat it starts a turn immediately, including after an `Esc` interrupt (sending only the heartbeat and held incoming messages, without resuming the interrupted response). If you queued a message and interrupted with `Ctrl+C`, the heartbeat waits so your text is not sent automatically. Set [`tasks.heartbeatWakesIdleSession`](/settings#tasks) to `false` to prevent heartbeats from waking an idle chat.
- Heartbeats also yield an active `action: "wait"` call while the waited task keeps running.
- Heartbeats go to the task's owner. Shells started by a subagent run in its parent's task owner, so their heartbeats go to the parent.
- A shell's execution `timeout` (300 seconds by default) still ends it, so a shell emits heartbeats only when it runs past its cadence.

### Choose the cadence

Set `heartbeatMs` on `bash`, `powershell`, or `subagent`. Omit it for the chat default, pass `0` to disable heartbeats for that task, or pass at least `60000` (one minute). Any other value is refused before launch.

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

The cadence is fixed when the task starts and appears in `/tasks` detail as `Heartbeat every 15m` or `Heartbeat off`. A subagent resumed after `pause` or `quit` uses the chat's default cadence. Change the global default with [`tasks.heartbeatMs`](/settings#tasks).

## Inspect tasks

| View | Controls |
| --- | --- |
| Task list | `↑`/`↓` selects; `Enter`/`→` opens a subagent on the chat screen or opens shell output; `Space` opens a peek card; `/` filters; `?` lists keys; `Esc`/`←` closes. `x` twice within 3 seconds stops a running task (confirming only the same row); `x` once dismisses a finished row. If a task finishes before the second `x`, the list asks `x to acknowledge`, then `x to dismiss`. |
| Task detail | `↑`/`↓` selects an action; `Enter` activates it (**Inspect transcript** and **Open question** close `/tasks` and open the subagent on the chat screen); `PageUp`/`PageDown` scrolls. |
| Transcript | Opens at the latest message and follows new output. `PageUp`/`PageDown`, half-page, and line keys scroll; `Ctrl+Home`/`Ctrl+End` jump to top or bottom; `Ctrl+Up`/`Ctrl+Down` jump between prompts; mouse wheel scrolls (`Alt`+wheel scrolls five times faster). Earlier history loads as you scroll up. |
| Transcript display | Viewed transcripts follow the session's thinking and tool-output settings. `Ctrl+T` toggles thinking blocks, `Ctrl+O` toggles tool output, and clicking expands or folds blocks. |
| Message the agent | Type in the prompt and press `Enter` to send or steer, or `Alt+Enter` to queue a follow-up. `Alt+Up` pulls queued messages back into the prompt, and `Esc` pauses a running subagent. Messaging a finished or stopped subagent resumes it. See [Viewing a subagent](#viewing-a-subagent). |
| Go back | Press `←` on an empty subagent prompt, or select `main` in the agent panel (`↓` on an empty prompt). In `/tasks`, `Esc` or `←` steps back from detail or shell output to the list, and from the list to chat (or back to the focused panel for nested shells). |
| Stop | In the agent panel, `/tasks`, task detail, or a running shell's output page, press `x` twice within 3 seconds to stop a task (any other key cancels). `Ctrl+X Ctrl+K` stops every background subagent and shell after the same confirmation. Remap `x` with `app.list.stop`. |
| Shell input | Select **Input** when offered; `Enter` sends text plus a newline; `Esc` exits input mode. |

Custom task keybindings override the default `←`, page, and `x` shortcuts. Typing in the prompt or shell input mode sends characters normally, including `x`, without stopping tasks.

Scrolling settings (`fullscreenWheelScrollLines` and `fullscreenScrollbar`) apply to subagent transcripts and shell output just like main chat. When scrolled above the bottom, the last row shows **↓ jump to bottom** or **↓ N new messages** (status updates and loading older history do not increment the count). Click the pill, press `Ctrl+End`, or page down to resume following output.

Agent rows in `/tasks` show the resolved model and reasoning level (for example `openai-codex/gpt-6-astra · thinking medium`), updating on fallback and persisting after completion. Missing metrics are omitted rather than shown as zero, while recorded zero values stay visible.

Viewing a subagent streams live assistant text, tool calls, compaction boundaries, branch summaries, and extension notices without forcing you to reopen the view. Saved database-backed transcripts load pages in either direction as you scroll; any single saved entry over 1 MiB displays its position and byte count so you can read it through session history or export.

Messages sent while viewing a subagent enter its own steering and follow-up queue and appear in its transcript once read. If the subagent cannot accept or confirm a message, a notice explains why and preserves your text in that subagent's prompt (or in main's prompt if the subagent is gone).

An agent's detail page in `/tasks` ends with a live status row for that subagent's own extension status lines, separate from the main footer, disappearing when the task ends. Shell details show the command, exit status, and up to ten wrapped lines from the retained 8 KiB output tail, labelling gaps, truncation, or **No output available**.

### States

| State | Meaning |
| --- | --- |
| Queued | Admitted and waiting for execution capacity. |
| Running | Live execution, including after the parent stops waiting. |
| Input needed | Waiting on an owned prompt; **Open question** is offered when a host route exists. |
| Stopping | Cancellation was requested and termination has not settled yet. |
| Completed | Execution finished successfully. |
| Failed | Execution ended with an error; details keep the error message. |
| Stopped | Execution was cancelled; completed work is not undone. |

Completed, failed, and stopped tasks remain inspectable without active execution controls.

## Background shells

Model `bash` calls on POSIX and native Windows, and `powershell` calls on native Windows, run in the session's task owner. Subagent shells use their parent's owner; see [Shells started by subagents](#shells-started-by-subagents). A command that outlives its foreground observation budget returns a task ID and continues in the background while its execution timeout keeps counting.

```ts
// Ordinary commands use the owner's observation budget, normally 10 seconds.
bash({ command: "npm run check" })

// Background a build when you can do independent work while it runs.
bash({ command: "npm run build", wait: { kind: "background" }, timeout: 600 })

// Wait longer when the test result is needed next; execution timeout is separate.
bash({ command: "npm test", wait: { kind: "foreground", budgetMs: 30000 }, timeout: 600 })
```

Execution `timeout` is measured in seconds (default `300`, maximum `3600`) and is independent of observation `budgetMs`. A backgrounded launch names the timeout that will stop it:

```text
Command is still running (task task-1-0-3). Its execution timeout stops it after 300 seconds; launch it with a larger timeout (up to 3600 seconds) for a longer run.
```

When the timeout expires, `wait` returns an error ending `Task <id> was cancelled (timed out after 300 seconds).` The completion notice uses the red `◯` stopped mark and reads `Background shell timed out after 300 seconds` with `Stop reason: execution-timeout (timed out after 300 seconds)`. For runs longer than 5 minutes, pass an explicit `timeout` up to `3600`; longer work should be split into shorter commands.

Observe an existing shell task without running the command again:

```ts
bash({ action: "wait", id: taskId })
powershell({ action: "wait", id: taskId })
```

- Pass the exact task ID from the same owning session. Omit `budgetMs` for the default observation budget, or pass `0` to poll.
- The transcript shows one status line above the output matching `/tasks`: `● completed · exit 0`, `✗ exited 1`, `⧗ still running · showing output so far`, or red `◯ cancelled`. Truncated output includes a dim line with the path to the full output.
- While running, repeated yielded waits advance through retained output in bounded pages (returning no output once caught up). Settled waits return all retained output again, subject to labelled gaps and truncation.
- Do not combine `action: "wait"` with `command`, `timeout`, `wait`, `env`, `cwd`, or `pty`. Unknown or foreign IDs fail with `No background task "<id>" in this session`. Cancelling a wait releases observation only and never changes the command's execution timeout.

### Stop a shell task from a tool call

Call `kill` with the exact task ID returned by `bash` or `powershell`:

```ts
kill({ id: taskId })
```

Pass the task ID only, never a process ID, shell name, or subagent ID. `/tasks` stop controls remain available alongside `kill`.

The transcript shows `◼ stopping · cancellation requested`, `◯ cancelled`, or `● already completed · exit 0`. The structured result keeps `taskId`, `decision`, `execution`, and `cleanup`. `cancellation-requested` means cancellation started, not that termination or cleanup finished; wait for `execution.kind: "settled"` and `cleanup.kind: "reaped"` before treating cleanup as complete. `already-settled` preserves the original outcome if the task finished before cancellation.

If cleanup of a stopped shell cannot be confirmed within a few seconds (for example because a descendant outside the process group still holds output open), the kill reports `CleanupUnconfirmed` and cleanup enters `quarantined` while Atomic confirms it for up to 15 seconds in the background. It ends `reaped` once processes and output close, or `failed` if they remain open. Killing a task never erases its output or completion notice.

Nonzero shell exits display as failures (`✗`), while user stops read `was stopped by the user`. Native Windows refuses owned shell launches it cannot supervise, and legacy Windows WSL `bash.exe` stdin transport is unsupported (run Atomic inside WSL for POSIX Bash).

### Shells started by subagents

Subagents can run background `bash` and `powershell` commands. Those shells run in the launching parent's task owner so they can outlive the subagent, while still belonging to the subagent (only the subagent receives their notices, and they are not listed as top-level parent rows in `/tasks`). Subagents still cannot launch other subagents.

- **Agent panel nesting.** Running shells started by a subagent appear indented beneath that subagent (`⧗ shell <command>`) and leave once finished. Press `Enter` on a nested row to view output in `/tasks` without changing the viewed agent (`←` returns to the focused panel), or press `x` twice within 3 seconds to stop only that shell.
- **Navigation hints inside subagent chats.** On a subagent's page in `/tasks`, a backgrounded command block displays a clickable `· /tasks to manage` hint (while the chat accepts typing and color is enabled) that opens that subagent's own task list rather than the main chat's. On the main screen while viewing a released subagent waiting on a shell, the newest waited shell block displays a clickable `· alt+w opens it` hint bound to `app.tasks.openWaited`.
- **Control and ownership.** A subagent can wait on and `kill` only its own shells. The parent can also wait on or stop a subagent's shell by task ID (`bash({ action: "wait", id })` or `kill({ id })`), and `Ctrl+X Ctrl+K` stops them with all other tasks.
- **Completion delivery.** A shell's completion notice goes only to the subagent that started it, never to the parent chat. Running subagents read it in their current turn, released subagents wake automatically, and finished, paused, or quit subagents receive it when next resumed or messaged.
- **Lifetime and early stops.** Shells keep running after their subagent finishes and stop when the parent session closes. Early stops report their cause (`timed out after <n> seconds`, `stopped by a pause`, `session closed`, or `Atomic shut down`), and shells stopped by session close deliver their notice once when the session reopens.

Custom operations adapters receive `wait` and must implement it themselves. External-terminal processes are not adopted into `/tasks`.

## Lifetime and scope

Background means independent of the current observation, not independent of the owning session. Pausing main chat aborts only the foreground turn; background subagents and shells keep running. Ending a turn or closing `/tasks` leaves background tasks running, and closing `/tasks` keeps live Git branch updates active in the footer.

Closing a session cancels its remaining owned work. On native Windows, Suspend opens a PowerShell subshell while owned background tasks continue until you exit back to Atomic.

Task inspection is strictly owner-scoped. Switching sessions never carries old task rows into another session, and missing retained history is reported explicitly.

Each session retains its 256 most recently finished tasks in `/tasks`, along with all running, queued, stopping, and unconfirmed-cleanup tasks. When newer tasks finish, the oldest finished task leaves `/tasks` once its completion notice has been delivered.

Its result stays in its completion notice or tool result, and subagent transcripts stay in their saved sessions (`subagent({ action: "resume", id })` still works). Evicted shell full output is deleted, and waiting on, stopping, or reading an evicted task reports `Task "<id>" finished and is no longer kept in this session` (code `TaskEvicted`).

## Task state and completion delivery

Foreground and background are observation modes for the same task; ending a wait never creates, stops, or restarts execution. A terminal result does not by itself confirm resource cleanup, so check cleanup status before treating a stop as complete.

A temporary-worktree subagent can finish its session while Atomic is still saving or releasing its directory. Closing or switching sessions waits for execution, output, and recovery notices, not remaining batch Git work; a close receipt can report `already-finishing`. Check [temporary worktrees](/subagents) before removing any directory.

If a shell command finishes while a child process still holds its output open, Atomic keeps the command's exit code and output and marks cleanup `quarantined` while confirming process teardown in the background (waiting up to 15 seconds more on session close). If cleanup stays unconfirmed on close, Atomic reports a retryable `TaskCleanupError` (`code: "task_cleanup_unconfirmed"`) naming the affected tasks and process groups, and `isRetryableTaskError(error)` from `@bastani/atomic` returns `true`. Output written after the result settles is discarded.

On Linux and macOS, each shell runs in its own session so cleanup stops processes the command started (even across process groups), while leaving processes started in a separate session (such as `setsid`) alone once they close output. On Linux with a user-owned cgroup v2 hierarchy, Atomic also uses cgroups for tighter process-tree containment during cleanup; set `ATOMIC_TASK_CGROUP=0` to disable cgroup containment. On Windows, Job objects clean up process trees. If Atomic terminates unexpectedly, remaining shell process trees are cleaned up automatically.

UI previews are bounded and do not replace retained output. Gaps and truncation are labelled, and unavailable history is reported instead of reconstructed.

## Related documentation

- [Subagents](/subagents) covers definitions, models, context, and delegation boundaries.
- [Keybindings](/keybindings) covers task-action remapping.
- [Orchestration](/orchestration) explains how the parent continues from child results.
