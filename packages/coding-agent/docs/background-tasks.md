---
title: "Background and parallel work"
description: "Run subagents and shell tasks while continuing your conversation"
---

# Background tasks

Background subagents keep working after the launch call returns. You can continue chatting without restarting them or keeping a task list open.

### The agent panel

Below the prompt, the **agent panel** lists the session's active background subagents, one row each. A `main` row comes first and stands for the main chat. Whichever agent the screen shows has a filled `●` and reads in bold:

```text
  ● main
  ◯ worker    openai/gpt-5.5 high                    fix shipping batches           41m · ↓ 96.1k tokens
  ◯ debugger  github-copilot/claude-opus-5.5 medium  #5220 spawn lock               18m · ↓ 87.4k tokens
    ⧗ shell                                          npm test                                        12s
  ◯ worker    anthropic/claude-sonnet-4-5 high       picker clamp                           stopped · 6m
```

- **Each row shows** the status, the agent's name, the model it runs on and its reasoning level, what it works on, how long it has run, and the tokens it has used. A waiting row shows its question.
- **Viewed marker (`●`):** While viewing the main chat, `● main` is bold. While viewing a subagent, its row is bold and its open circle is filled (`●`), and `main` shows a muted `◯`. A resumed subagent stays one row, and `●` follows its latest attempt.
- **The model column** names the model the subagent runs on now, as `provider/model-id`, then its reasoning level, as the footer shows the main chat's. A model without reasoning levels shows no level. The column follows the subagent: it changes as soon as the subagent falls back to another model, is resumed on a different one, or changes its reasoning level. A stopped or paused row shows the model its last turn ran on. A row whose model is not known yet leaves the column blank. When a subagent's model becomes known while you look at its row, the row shows it together with its reasoning level, or the model alone if no level arrives within a second, so the row's task moves only once. While the panel or `/tasks` stays open, the column keeps its width as long as it fits, even when the longest model leaves; it is measured again when the terminal is resized or the list is opened again.
- The task title in the panel and on the prompt's top rule stops at a whole character. A shortened title ends in `…`.
- **Status glyphs** (`/tasks`, a chat's task rows, completion notices, launch cards, subagent results and the `wait` and `kill` lines use the same marks):
  - `◯` running, in grey (`●` while you view it)
  - `◆` needs input, with its question when it waits on one
  - `‖` paused
  - `○` queued
  - `◌` waiting on a detached call or shell (released)
  - `●` done, in green
  - `✗` failed, showing the reason
  - `◼` stopping
  - `◯` stopped, in red (`●` while you view it)
  - `⧗` running shell (nested under the subagent that started it)
- **Finished subagents** leave the panel as soon as they finish, except the subagent you are currently viewing: it stays listed until you switch to another agent or dismiss it (`x`), which switches back to `main`. `/tasks` still lists finished subagents. A stopped, paused, or interrupted subagent stays while another subagent or background shell is still running, and leaves once nothing is running. Switching sessions or starting unrelated work does not bring it back. If it resumes and stops again while other work is running, it reappears as one row, even if the panel was closed during the resume. A stopped row reads dim after 30 seconds. As the terminal narrows, each task is shortened first; below 100 columns, or when a row would be left no room for its task or its time, the model column is dropped, and below 70 columns the token count.
- **Up to four rows** show while the prompt has focus, then `+N more`; the focused panel shows eight at a time. The `main` row does not count toward either. The viewed subagent and its running shells are always kept visible in the four rows (taking the last slots when they rank lower), and `+N more` counts every omitted row, nested shells included.

The main footer shows `↓ N agents` for the subagent rows the panel lists. `N needs input` counts every row that waits for an answer. These counts include rows folded into `+N more`. When the panel lists nothing but `/tasks` lists subagents of this session, the footer shows `/tasks to see subagents`; while the main chat's background shells run, `N shells · /tasks to manage` takes its place.

The main chat's background shells are not panel rows; the footer counts the running ones (for example `2 shells`), and [`/tasks`](#open-the-task-inspector) opens and stops them. **A subagent's own running background shells** appear as indented rows directly under that subagent (`⧗ shell <command>`), leaving as soon as they finish or when their parent subagent leaves.

Press **↓** on an empty prompt to focus the panel, whether you are viewing `main` or a subagent (while a viewed subagent's question form has focus, ↓ moves its selection instead):

- **↑↓** select rows, including `main` and nested shell rows. The selected row is marked with `∀` before its mark and reads in the default text colour.
- **Enter** or **→** on a subagent row switches the chat screen to that subagent and returns focus to the prompt.
- **Enter** or **→** on `main` switches back to the main chat and returns focus to the prompt.
- **Enter** or **→** on a nested shell row opens that shell's output in `/tasks` without changing which agent the chat screen shows (`←` returns to the focused panel).
- **x** stops the selected subagent or nested shell when pressed again within 3 seconds, and dismisses a finished subagent with one press.
- **Esc** or **←**, or ↑ past `main` (past the first row when there is no `main` row), returns focus to the prompt without switching agents. **?** shows the panel keys.

In fullscreen mode you can also click a row, focused or not, to act as Enter does. Clicking `main` switches back to `main` when viewing a subagent, or returns to the prompt when the panel is focused. The hints click too: `↓ N agents` focuses the panel, `/tasks to manage` and `/tasks to see subagents` open `/tasks`, and each key in a hint row does what pressing it does.

If the panel warns that an extension source failed, its invalid rows are hidden while the other rows and chat remain usable. A source that cannot list its rows is hidden entirely. The warning appears once per source, including during startup. Fix or update the extension, then use `/reload` to register it again; new rows continue updating without reopening the panel. If a reload closes the focused panel, press ↓ on the empty prompt to open it again. A failed stop or answer reports the source's error without closing the chat.

Extension authors can add rows with [`pi.registerAgentPanelSource()`](/extensions/api-reference#pi-registeragentpanelsource-source).

### Viewing a subagent

Atomic uses one chat screen for the main chat and every subagent. Selecting a subagent from the agent panel or `/tasks` swaps the transcript area to that subagent's live transcript and points the same prompt box at it:

- **Prompt and chrome:** The prompt's top rule shows `<agent> · <title> · <state>` (with live elapsed time while running). The empty prompt reads `Message @<agent>…`, `Answer @<agent>…`, `Message @<agent> to wake it…`, `Paused · send to continue`, `Stopped · send to resume`, or why the subagent is read-only. The usage meter, footer, and agent panel stay below the prompt; only the working line above the prompt and the footer's stop hint (`esc to pause` while the subagent works) follow the viewed subagent.
- **Switching back:** Press `←` on the subagent's empty prompt (the hint by the prompt reads `← main chat`), or focus the agent panel (`↓` on an empty prompt), select `main`, and press `Enter` (or click `main`). The subagent keeps running, its queued messages and unsent draft stay with it, and the main transcript returns at the exact scroll position and draft you left. With text in the prompt, `←` moves the cursor.
- **Per-agent drafts:** Each agent keeps its own unsent draft (text, cursor, pasted blocks, and undo history), including across resumes. Keys typed while a subagent is still opening wait and land in its prompt once shown; pressing `Esc` cancels the switch and keeps what you typed for that subagent (or warns with the typed text if it could not be shown).
- **Prompt history:** `↑` and `↓` walk the viewed agent's own history. For a subagent, that is its task, any messages it was resumed with, and messages it has received from you, followed by what you send while viewing it. `Ctrl+R` searches the same history. Returning to `main` restores main's history unchanged. A message still queued for a subagent returns with `Alt+Up` (or `Esc`), not `↑`.
- **Steering, queuing, and pausing:** While the viewed subagent works, `Enter` queues a steering message and `Alt+Enter` queues a follow-up (`Steering:` / `Follow-up:` rows above the prompt), and `Alt+Up` brings every queued message back into the prompt. Pressing `Esc` pauses the viewed subagent without affecting the main chat: its current turn or retry wait ends, its queued messages return to its prompt (steering first), and it waits until you send it a message. `Esc` never switches back to `main`, and pressing it there never counts toward main's double-`Esc`. `Ctrl+C` on an empty prompt pauses the subagent if it is working, as `Esc` does, and keeps it shown; from a subagent's view it never offers to exit Atomic. Sending a message to a finished or stopped subagent resumes it in the same task. A read-only subagent can still be scrolled, while typing is ignored.
- **Questions, scrolling, and notices:** When the viewed subagent waits on an `ask_user_question` or approval form, the form appears at the bottom of its transcript and takes keyboard input until answered. Scrolling keys, click-to-expand, `Ctrl+O`, `Ctrl+T`, and text selection act on the viewed transcript. Main chat notices still record in the main transcript and are also mirrored (up to three rows) under the subagent's transcript; notices specific to the viewed subagent appear only under its transcript.
- **When a viewed subagent is gone:** If the viewed subagent is dismissed, removed, or the engine restarts, the screen immediately returns to `main`. Any unsent draft typed for it is placed in front of main's prompt with the warning `<name> is gone; your message to it is in the prompt.` If you submit that moved text unedited and it is a command that modifies the main conversation or changes main's model or thinking level, Atomic asks to confirm before running it on `main`; editing the prompt or submitting anything else clears that guard.
- **Waited shell shortcut:** While viewing a released subagent waiting on a shell (`◌ waiting on bash`), press `Alt+W` (`app.tasks.openWaited`) to open its newest running shell output in `/tasks`; `←` returns to the subagent view.

#### Commands while viewing a subagent

| What you type or press | Behavior while viewing a subagent |
| --- | --- |
| `/settings`, `/scoped-models`, `/tasks`, `/resume`, `/export`, `/share`, `/trust`, `/login`, `/logout`, `/reload`, `/quit`, `/exit`, and the resume shortcut (`app.session.resume`) | Run on `main` in place; the subagent stays on screen. `/tasks` lists all tasks of the session; `/resume` opens its session picker, and picking a session is the confirmation. |
| Bundled extension commands (`/agents`, `/mcp`, `/intercom`, `/curator`, `/google-account`, `/search`, `/websearch`, `/llama`) | Run on `main` in place; the subagent stays on screen. |
| `/session`, `/tools`, `/changelog`, `/hotkeys`, `/name` | Switch to `main` first so their output prints in the main transcript. Main's own draft is preserved. |
| `/compact`, `/tree`, `/fork`, `/clone`, `/new`, `/import`, registered `/clear` or `/rewind`, and the session shortcuts (`app.session.new/tree/fork`) | Ask first: `/<command> acts on the main conversation, not <agent>`, with **Cancel** listed first and selected, then `Run /<command> on the main conversation`. Once you choose to run it, it runs on `main` while the subagent stays on screen; `/new` and `/import` show `main` first, and `/fork` and `/clone` show `main` once they replace the session. **Cancel** or `Esc` puts the command back in the subagent's prompt. |
| `/model`, `/thinking`, model selector/cycling (`Ctrl+L`, `Ctrl+P`, `Shift+Ctrl+P`), thinking cycling (`Shift+Tab`) | Refused with a notice under the subagent's transcript. Switch to `main` to change main's model or thinking level. |
| `!cmd`, `!!cmd` | Refused with `` `!` commands run in the main chat. Switch to main to run them. `` The text stays in the prompt. |
| `/copy` | Copies the viewed subagent's last assistant message to the clipboard. |
| `/skill:<name>`, prompt templates, user or project extension commands, and ordinary text | Sent to the viewed subagent's own session, which expands its own skills and templates using its own working directory. |

Typing `/` offers completion for every built-in (`/model` and `/thinking` included; sending them shows the refusal), bundled extension commands, and the viewed subagent's own skills, prompt templates, and user or project extension commands. `@` and `Tab` complete paths in the viewed subagent's working directory. A built-in name followed by arguments it does not take (such as `/copy that` or `/new idea`) goes to the subagent as ordinary text. See [Task inspection](/subagents#task-inspection).

### Open the task inspector

Run `/tasks` to inspect work without stopping it:

- The list opens in the editor slot, with the conversation visible above it. It lists the subagents and shells of the session, running and finished.
- Its header counts them, for example `Tasks  1 needs input · 3 working · 2 done`, and the rows are grouped **Needs input**, **Working** and **Done**. Each row is one line: its status mark (the agent panel's: a grey `◯` running, a green `●` done, a red `◯` stopped, `⧗` for a running shell), its name, a subagent's model and reasoning level in the agent panel's model column, its task (or the question, while it waits for an answer), and on the right how long it has waited, run or took, in the agent panel's format (`3m`, `1h 6m`), with its tokens. A finished subagent's row shows the model its last turn ran on; the model column follows the panel's width rules.
- The hint line lists the keys that work on the selected row: `↑↓ select · space peek · enter/→ open · x stop · / filter · esc/← close · ? keys`. On a finished row `x` reads `dismiss`.
- Space opens a peek card under the selected row, and the rest of the list stays in place:
  - A subagent or shell shows its model, current tool call and usage.
  - A running subagent that waits on nothing has a reply box: Enter sends the text to it as a message.
- A subagent waiting for input opens no card: its row shows the question, and Space, Enter or Right closes `/tasks` and shows that subagent on the chat screen to answer it (the hint reads `space/enter/→ answer`). Text typed in the list is never sent as an answer.
- A subagent you paused with Esc reads `‖ paused` under **Working**, with its time held; its detail page reads `‖ Paused · send to continue`, and sending it a message continues it.
- On a card without a reply box, Space, Escape or Left closes it, and the hint reads `space/esc/← close`. In a reply box, Space types a space; Escape, or Left at the start of the reply, closes the card. Up and Down close the card and move the selection. On a subagent's or shell's card, Enter or Right opens its detail page unless a reply is typed; a waiting subagent's detail page has an **Open question** action that shows the subagent on the chat screen.
- Escape closes the card and keeps an unsent draft. While a reply is sending, the card shows `Sending…`; Escape or Left closes `/tasks`, and other keys are ignored until it finishes. Your first typed character or numbered choice binds the draft to the question last shown, and typing before any question is shown cannot answer it. If the question changes before your reply is sent, the reply is cleared with a notice, so text typed for one question never reaches the next; type a new reply for the question now shown. When the question disappears, the card stops taking reply text and its list keys work again. A send failure keeps your reply while the inspector stays open. If you close it during a send or stop, a later failure appears in the chat.
- Enter or Right on a subagent row closes `/tasks` and shows that subagent on the chat screen. On a shell row, it opens the shell's output page (or its detail page when no output is available).
- `/` filters the list by name or task; Enter keeps the filter and Escape clears it. Up or Down selects a row and keeps the filter.
- A shell's completion notice and output page take the last 8 KiB of retained output. If that window starts partway through a UTF-8 character, the excerpt starts at the next character. If the completion notice must shorten the output further, it keeps whole graphemes and shows an omission label only if the entire label fits.
- Detail and shell output pages use the full screen. A shell output page shows the command, status, live runtime, and retained output in a scrollable rounded box with `pgup/pgdn` scroll, two-press `x` to stop a running shell, `?` for its keys, and `←` to go back. A shell's input stays in the sheet, under `Input to <command>`, with `enter send · ← back to list`.
- Escape returns to the picker with your selection preserved, then to chat.
- Completed background work remains available, including after a later wait for it. A shell command its tool call still waits on is excluded.
- Updates never open or close the inspector automatically. Closing it does not stop tasks.

Results and failures remain in completion notices and `/tasks` after a subagent leaves the agent panel.

The picker's footer shows the chat's resolved model and reasoning level, current folder and Git branch while the chat is idle, and MCP status throughout. While the chat's agent works, the model line is hidden and no status line takes its place, because Escape closes the picker rather than interrupting.

Opening `/tasks` is navigation, not approval. It does not mark the agent blocked in Herdr or produce a "Main chat needs input" notice.

## Choose how long to wait

The agent can choose foreground-first or background observation for each authorized shell call. Every subagent runs in the background; the agent waits for one with `subagent({ action: "wait", id })` when it needs the result next. Neither choice requires a separate user confirmation or relaxes tool permissions or task ownership.

For ordinary shell commands, leave `wait` out rather than routinely requesting one-second waits. Short waits can background otherwise brief commands and add follow-up calls without speeding up execution. Use explicit background observation when you have independent work to do, and a short budget only when you need control back sooner. Explicit budgets remain supported on every platform.

Keep immediately blocking work local unless a specialist, isolated context, or your explicit delegation request makes a subagent worthwhile. After spawning, continue independent work without duplicating the child's task. Wait when its result becomes a dependency; otherwise rely on completion notices rather than repeated short waits or status polls.

| Call | Observation behavior |
| --- | --- |
| `bash` or `powershell` without `wait` | Waits for the owner's command observation budget, normally 10 seconds, then automatically returns if still running. |
| `subagent` launch | Returns after admission; the child always runs in the background. A `wait` the call still passes is ignored, and a foreground one is noted in the result. |
| `subagent({ action: "wait", id })` | Waits for the owner's agent wait budget, normally 30 seconds, or for its `budgetMs`. Esc ends it at once. |
| `bash` or `powershell` with `wait: { kind: "background" }` | Explicitly returns after admission without waiting for execution to finish. |
| `bash` or `powershell` with `wait: { kind: "foreground" }` | Waits for the owner's command observation budget, normally 10 seconds. |
| `bash` or `powershell` with `wait: { kind: "foreground", budgetMs: 1000 }` | Waits up to one second, then automatically yields if the original task is still running. |

If the task finishes during observation, the call returns its terminal result instead. Automatic backgrounding is **observation expiry**, not a slow-task failure, a restart, or a second execution. Wait for a dependency and let independent work run in the background. If a wait for a dependency ends early, wait for its actual completion before using the result.

Shell `budgetMs` accepts finite non-negative milliseconds; zero means no observation delay. On command launches it belongs inside a foreground `wait`; existing-task `action: "wait"` calls take it at the top level. A trusted SDK host can override the usual budgets or select `tasks.wait.kind: "until-settled"`; omitted foreground budgets then wait until settlement. Explicit per-call budgets still take precedence.

A zero-budget wait may return a background state immediately. It still refers to the same task; execution continues.

## Background subagents

Ask Atomic to delegate a bounded task:

```text
Have a codebase-analyzer trace the authentication flow in the background.
Keep working with me here while it runs.
```

For tool callers, every launch runs in the background. Examples:

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

Parallel tasks have independent identities. Accepted work beyond the concurrency limit stays queued. Use `/agents` to browse available definitions before choosing an agent.

Intercom communication does not cancel a parallel batch. An `intercom` ask returns at delivery and its reply arrives as a message in the requesting child; a supervisor decision waits only in the requesting child and resumes that same execution after the matching reply. Sends and progress updates remain nonblocking. A parent's `action: "wait"` ends so the parent can reply; execution concurrency, queued siblings, and task identities are preserved. Stop a selected task explicitly, or close its owner to cancel all owned work.

A launch result says **Launched in background**. This records what happened at launch; it is not a permanently live status label. The agent panel and `/tasks` show the current state.

### Waiting is not restarting

When specialist delegation is useful and its result is needed next, launch the child and wait for the task ID the launch returned:

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the authentication flow." })
subagent({ action: "wait", id: taskId, budgetMs: 120000 })
subagent({ action: "status", id: taskId })
```

If the wait's budget runs out, or you press Esc while it waits, the same child continues in the background. Neither is an execution timeout or a stop: wait again, or let its completion notice arrive.

To stop, hold, or continue a child, use `pause`, `quit`, and `resume`; see [Run control](/subagents#run-control).

Do not launch a duplicate just to retrieve its result. Use the task ID returned at launch. IDs are scoped to the session that owns them.

An `action: "wait"` call also ends when user steering or an Intercom ask/send is admitted to the waiting parent. The message stays in the normal delivery queue so the parent can handle it and reply. This releases only observation: children keep running under the same task IDs, and other owners' waits are unaffected.

### Completion messages

Completion adds one notice line to the owning chat without depending on a model reply. Its marker and colour give the outcome, with the marks the agent panel and `/tasks` use: a green `●` completed, `✗` failed, a red `◯` stopped (also a subagent paused or quit until it is resumed), `!` timed out, and a dim `◌` for a subagent [released while it waits](/subagents#released-subagents). The line names the task, or an agent by its name, says how it ended and how long it ran. An agent's line is followed by the first line of its result:

```text
 ● Background command "npm run build" completed (exit code 0) · 3m 2s
 ◯ Task "Sleep 300 seconds in background" was stopped by the user
 ● debugger finished · 1h 31m
   ⎿  Authentication starts in …
      (ctrl+o for the full result)
 ◯ debugger quit · awaiting resume
 ◌ worker is waiting on bash (toolu_01) · 16m 16s
```

The main chat and a subagent's view show the same line. When you reopen an older session, a notice that recorded a release shows `◌`. Atomic 0.9.86 and 0.9.87 recorded releases as pauses, so those notices still read as paused, with the stopped `◯`. If the result and line are missing, Atomic can still show the stopped `◯` when a separately saved agent name identifies a stop in the title. For example, `worker killed (non-resumable): paused · awaiting resume: check the queue` identifies a stop if the saved name is `worker`, but not if it is `worker killed (non-resumable):`. This applies to notices with an empty preview and an empty or title-only string for content. Earlier notices that lack a separate name, and notices with a body or preview, keep their previous reading.

The parent model also receives the result context. Delivery retries do not relaunch the child.

A notice goes only to the session that launched the task: the main chat or a subagent. It never goes to another session. Tasks that finish together reach the model in one request, which starts one turn in an idle chat. A notice that arrives while the chat is working is read at that turn's next safe point and starts no turn of its own. A chat waiting for your next message after an interrupt keeps the notice until you send one. A notice restored after a restart joins the transcript without starting a turn.

Supervisor progress messages are labelled **Historical supervisor update** with their original `Sent:` timestamp. They describe the child's state when sent, not its current status, and can arrive after completion. Prefer a later correction or final result over an earlier progress hypothesis; use `/tasks` for the current task state.

Stopping a subagent through `/tasks` (`x`, then `x` again within 3 seconds) stops it resumably, as `subagent({ action: "quit", id })` does. It delivers a **paused** notice line and quit context to the parent model. The notice arrives only after termination is confirmed, not while the task is **Stopping**. It requires no final response from the child. Cancelling queued work sends the notice without starting it. Send it a message while viewing it, or use `subagent({ action: "resume", id })`, to resume it. Ctrl+X Ctrl+K stops subagents the same way.

A subagent stopped with `subagent({ action: "pause" | "quit", id })` is not ended. Its notice line reads **paused · awaiting resume** or **quit · awaiting resume**. The model context gives `Stop reason: pause` or `quit` and names the call that continues it, `subagent({ action: "resume", id: "<child-id>" })`, instead of telling the model the execution has ended. Its `/tasks` row shows it as stopped (a red `◯`); viewing it shows `Stopped · send to resume` in the prompt and accepts a message to continue it.

A subagent that completed or failed keeps its own session. Its notice tells the model the execution has ended and not to restart it merely to retrieve its result, and names the call that continues it with a follow-up, for example `Resume it with subagent({ action: "resume", id: "a760c0ec:0", message: "…" }) to continue it with a follow-up.` When the notice knows the child's Intercom name, it adds that the child takes Intercom messages under that name again once resumed. The id is the child id. A notice restored after a restart without its task record names the task id, which `resume` also accepts. Expanding the notice line (Ctrl+O) of a completed, failed, paused or quit subagent shows the same id as `resume id <child-id>` under the line; the collapsed line is unchanged. In `/tasks`, the expanded row and the detail page of such a subagent name it too, as `resume id <child-id>` and `Resume id <child-id>`, on its latest attempt only: once you resume it, the earlier attempt no longer shows the id. A subagent cancelled for good, one released while it waits, and background shells name no resume id.

Repeated stop requests or late child results do not duplicate the notice or overwrite the recorded outcome. A task that finished before cancellation keeps its actual result. Closing the owning session still suppresses late notices.

Restored completions may have only an outcome and task identity if the original live task or transcript is unavailable. Atomic does not invent missing output. Excerpts are bounded; inspect retained history for more detail.

A collapsed subagent notice shows the first wrapped line of its result; a shell notice shows only its line. Use the expand-tools key, normally Ctrl+O, for the shell's last output lines or the agent's full retained result, or `/tasks` to inspect.

Completion notices are unshaded. Long titles shorten to fit one terminal row, and expanded results wrap to the terminal width. A subagent's saved preview and its result excerpt for the parent stop before any character, such as an emoji, that would cross the 8,000 UTF-16 code unit limit. The child's full result is unchanged.

## Task heartbeats

A shell or subagent that keeps running sends its chat a **task heartbeat** every 15 minutes by default. It is a periodic check, not a failure signal. The model sees how long each task has run and how recently it produced output or reported activity, then decides whether it is still making progress:

- If it is progressing, the model lets it run.
- If it looks runaway, stale or stuck, the model inspects it (`/tasks`, or a shell or subagent `wait` on its task ID), steers it (an Intercom message to a subagent, or pausing it and resuming it with a message), or stops it (`kill({ id })` for a shell, `subagent({ action: "quit", id })` for a subagent).
- It does not relaunch a task that is still running.

A heartbeat never stops, restarts or relaunches a task by itself. In chat it is a notice that lists each task, up to five, and counts the rest; expand it (Ctrl+O) for each task's status line and output:

```text
♥ Task heartbeat · 2 tasks still running
  ⎿  shell task-1-0-3 npm run e2e · 45m
  ⎿  subagent task-1-0-4 Trace the authentication flow · 30m
     /tasks to inspect · ctrl+o to expand
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

- Only running tasks heartbeat. Queued, stopping, finished, killed, quit and paused tasks do not, and a task's heartbeats stop when it ends.
- The cadence counts from when the task started running, never from the previous heartbeat.
- Tasks that come due within about a minute of each other share one heartbeat. One heartbeat describes up to eight tasks in full and lists the rest by name.
- A chat has at most one unread heartbeat. While it waits behind a long response or paused messages, later intervals are not stacked: the tasks that came due are reported together once it has been read, and missed intervals are not replayed.
- A heartbeat queues behind the current response, like a steering message, and never interrupts streaming text. In an idle chat it starts a turn at once, including right after you interrupt with Esc. That turn sends only the heartbeat, along with any incoming messages the interrupt held; your interrupted response is not resumed. If you queued a message and interrupted with Ctrl+C, the heartbeat waits for you instead, so your text is never sent without you. Intercom messages and finished-task notices do not start a turn after an interrupt; they wait for your next message. Set [`tasks.heartbeatWakesIdleSession`](/settings#tasks) to `false` to keep heartbeats waiting too. Like other incoming messages, it ends a `wait` action the chat is in; the task keeps running.
- Heartbeats go to the chat that owns the task. Shells a subagent starts run in its parent's task owner, so their heartbeats go to the parent.
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

The cadence is fixed when the task starts, and a running task's `/tasks` detail shows it as `Heartbeat every 15m` or `Heartbeat off`. A subagent resumed after `pause` or `quit` uses the chat's default cadence. Change the default for every task with [`tasks.heartbeatMs`](/settings#tasks).

## Inspect tasks

| View | Controls |
| --- | --- |
| Task list | Up/Down selects; Enter or Right shows the selected subagent on the chat screen (or opens a shell's output); Space opens a peek card under the row; `/` filters; `?` lists the keys; Escape or Left closes the list and returns to chat. `x` stops the selected task when pressed twice within 3 seconds, and dismisses a finished one with one press. The second `x` only confirms the row the first one was pressed on. A task that finishes before the second `x` is not stopped or dismissed: the list shows `<name> finished · x to acknowledge`, the next `x` acknowledges that notice and switches it to `<name> finished · x to dismiss`, and the one after dismisses the row. |
| Task detail | Up/Down selects an action; Enter activates it (**Inspect transcript** and **Open question** close `/tasks` and show the subagent on the chat screen); PageUp/PageDown scrolls the body. |
| Transcript | Opens at the latest message and follows new output; PageUp/PageDown, half-page, and line keys move through the transcript; Ctrl+Home/Ctrl+End jump to the top and to the latest message; Ctrl+Up/Ctrl+Down jump between prompts; the mouse wheel scrolls (Alt+wheel five times faster). Earlier retained history loads as you scroll toward the top. |
| Transcript display | A viewed subagent transcript follows the session's thinking and tool-output settings. Ctrl+T toggles thinking blocks, Ctrl+O toggles tool output, and clicking a block expands or folds it. |
| Message the agent | While viewing a subagent, type in the prompt and press Enter to send or steer, or Alt+Enter to queue a follow-up. Queued messages appear as `Steering:` or `Follow-up:` rows above the prompt, and Alt+Up brings them back into the prompt. Esc pauses the subagent and returns its queued messages to the prompt. A finished or stopped subagent resumes in the same task when you send it a message; a read-only subagent ignores typing and explains why in the placeholder. See [Viewing a subagent](#viewing-a-subagent) for history, drafts, and command rules. |
| Go back | To return from a viewed subagent to the main chat, press Left on its empty prompt, or press `↓` on an empty prompt to focus the agent panel and press Enter on `main` (or click `main`). Inside `/tasks`, Escape or Left returns from detail or shell output to the list, and from the list to chat; from a nested shell opened from the agent panel, Left returns to the focused panel. |
| Stop | In the agent panel, `/tasks`, or a task's detail page, `x` asks for a second press; pressing `x` again within 3 seconds stops the task, and any other key keeps it running. A stopped subagent stays resumable: viewing it shows `Stopped · send to resume`, and sending a message resumes it in its own session. Ctrl+X Ctrl+K stops every background subagent and shell at once, after the same second press. Remap the key with `app.list.stop`. |
| Shell input | Select Input when offered; Enter sends the text plus a newline; Escape leaves input mode. |

Configured task bindings take precedence over the default Left, page, and `x` shortcuts. The prompt and shell input mode receive ordinary typing, including `x`, without stopping a task. The footer shows the applicable controls.

Scrolling settings apply to viewed subagent transcripts and shell output as they do to the main chat: `fullscreenWheelScrollLines` sets the wheel step and `fullscreenScrollbar` shows the scrollbar. When you scroll away from the latest message, the last row shows a pill: **↓ jump to bottom**, or **↓ N new messages** once new output arrives. Status updates and loading earlier history do not add to the count. Click it, press Ctrl+End or page down to the bottom to follow the output again; typing doesn't.

The list groups subagents and shells by **Needs input**, **Working** and **Done**, with counts and status symbols. Detail views pin identity, state, available metrics, and the selected action while their body scrolls. Missing metrics are omitted rather than displayed as zero. Recorded zero values remain visible.

Agent rows in `/tasks` show the resolved model and reasoning setting, for example `openai-codex/gpt-6-astra · thinking medium`. These settings update on fallback and remain after completion. A subagent's result, when a wait returns it, keeps the same metadata. Completion notices keep it in their saved details but do not display a model line. Missing settings are not inferred from token counts; early launch receipts may not yet have a resolved model.

Agent details include recent retained tool activity, the prompt, a latest-response preview, and error or attention information. Viewing a subagent shows its conversation in the transcript area: retained messages, thinking blocks, tool calls and results, compaction boundaries, branch summaries, and extension notices, with a compaction status while the agent compacts. Earlier pages do not jump back to the latest page when background activity arrives. A saved database-backed transcript reloads pages as you scroll in either direction. A single saved entry over 1 MiB is shown with its position and byte count instead of an incomplete preview; use the session's history reader or export to read its original contents.

Messages you send while viewing a subagent go into the subagent's own steering and follow-up queue, reach its model exactly as you typed them, and appear in its transcript as your messages once it reads them. If the subagent does not take a message, or does not confirm it, a notice explains why and keeps your text in that subagent's prompt (even if you already switched away), or moves it in front of main's prompt with a notice if the subagent is gone.

An agent's detail page in `/tasks` ends with a status row for that task's own extension status lines, such as a tokens-per-second counter set by an extension the subagent loaded. It updates live, is separate from the main footer's status row, and disappears when the task ends. The compact picker and shell pages show none.

An open live transcript updates directly from the child's session events, including streaming assistant text, partial/final tool results, and compaction. Shell output refreshes on task state updates, including updates received during an earlier output read. You do not need to leave and reopen the transcript. Reading earlier retained pages keeps your position while the live tail continues updating. A transcript that is read again rather than streamed holds still while you read above its end and catches up when you return to the latest message.

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

Completed, failed, and stopped tasks retain inspection but do not offer execution controls.

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

A launch that continues in the background names the timeout that will stop it:

```text
Command is still running (task task-1-0-3). Its execution timeout stops it after 300 seconds; launch it with a larger timeout (up to 3600 seconds) for a longer run.
```

When the timeout stops the command, a `wait` on it returns an error ending `Task <id> was cancelled (timed out after 300 seconds).`, and its completion notice reads `Background shell timed out after 300 seconds` with `Stop reason: execution-timeout (timed out after 300 seconds)`. A test suite that can run longer than five minutes needs an explicit `timeout`, for example `timeout: 3600`. 3600 seconds is the longest timeout: a launch or notice at that limit says to split a longer run into shorter commands instead of asking for a larger timeout.

Observe an existing task without running its command again:

```ts
bash({ action: "wait", id: taskId })
powershell({ action: "wait", id: taskId })
```

Use the original task ID from the same owning session. Omit `budgetMs` to use the owner's command observation policy, or pass `0` to poll. A wait returns retained output and a yielded or settled observation; settled results include available exit and failure details. The transcript shows one status line above the output, with the mark `/tasks` shows the shell with: `● completed · exit 0`, `✗ exited 1`, `⧗ still running · showing output so far`, or `◯ cancelled` (in red). When the output was cut short, a dim line below it gives the path to the full output. The agent receives the same facts as one sentence after the output, and the structured observation stays in the result details. While running, successive yielded waits advance through retained output in bounded pages, including after a session reload. A caught-up wait returns no output until more arrives. Settled waits return all retained output again, subject to labelled gaps and truncation, so they may repeat output you have already seen.

Do not combine `action: "wait"` with `command`, `timeout`, `wait`, `env`, `cwd`, or `pty`. Existing-task waits require a supported task owner, even with custom execution adapters. Unknown or foreign IDs are rejected with `No background task "<id>" in this session` and a hint to run `/tasks`. Cancelling a wait or admitting user/Intercom messages releases observation only, not the command. Waiting never extends the original execution timeout or the owner's lifetime.

### Stop a shell task from a tool call

Use the `kill` tool with the exact task ID returned by `bash` or `powershell`, whether it launched explicitly in the background or automatically yielded:

```ts
kill({ id: taskId })
```

The command selects the existing owned shell task; do not supply a process ID, shell name, or another owner's task ID. Unknown, malformed, foreign-owner, and subagent IDs are rejected. `/tasks` stop controls remain available.

The transcript shows a status line such as `◼ stopping · cancellation requested`, `◯ cancelled`, or `● already completed · exit 0`, and the agent receives the same facts as a sentence. The structured result keeps `taskId`, `decision`, `execution`, and `cleanup`. `cancellation-requested` means cancellation was requested, not that termination or cleanup has finished. A repeated call preserves that decision while reporting current state. `already-settled` means the task finished before cancellation and keeps its original outcome. Confirm `execution.kind: "settled"` and `cleanup.kind: "reaped"` before treating termination and cleanup as complete. Cleanup failures remain errors, not successful stops. A stopped shell whose cleanup cannot be confirmed within a few seconds, for example because a process that left the command's process group still holds its output open, ends as failed with code `CleanupUnconfirmed` and names the unconfirmed resource. It then no longer counts as stopping, and its cleanup shows as `quarantined` while Atomic keeps confirming it in the background for up to 15 seconds; it ends `reaped` once the processes and output are gone, or `failed` if they are not gone by then. Output and completion notifications remain available; killing a task does not erase its history.

Shell completions show one unshaded notice line with the available exit code. Ctrl+O expands the last retained output lines. Nonzero shell exits are shown as failures even though the process itself reached a terminal state. A user stop reads `was stopped by the user`. The notice and the agent panel row update in the session that launched the shell.

Native Windows refuses owned shell launches it cannot supervise. Legacy Windows WSL `bash.exe` stdin transport is unsupported; run Atomic inside WSL for the normal POSIX/Bash path.

### Shells started by subagents

Subagents can run background `bash` and `powershell` commands too. A subagent's shells run in the task owner of the session that launched it, so they outlive the subagent. They belong to the subagent, though: only the subagent receives their notices, and they are not listed as top-level parent rows in `/tasks`. The subagent itself still cannot launch other subagents.

- Running shells started by a subagent appear as nested rows indented directly under that subagent in the agent panel (`⧗ shell <command>`), leaving as soon as they finish.
- Press `Enter` on a nested shell row to inspect its output in `/tasks` without switching the viewed agent (`←` returns to the focused panel), or press `x` twice within 3 seconds to stop only that shell.
- While viewing a released subagent waiting on its shells (`◌ waiting on bash`), press `Alt+W` (`app.tasks.openWaited`) to open its newest running shell output (`←` returns to the subagent view).
- The subagent can wait on and `kill` the shells it launched, but not the parent's own tasks or another subagent's.
- The parent can still wait on or stop one of those shells by its task ID, with `bash({ action: "wait", id })` or `kill({ id })`, and Ctrl+X Ctrl+K stops them along with everything else.
- A shell's completion notice goes only to the subagent that started it. While the subagent runs, it reads the notice in its current turn, including when a shell from an earlier run finishes after the subagent resumes. A released subagent is woken by it. A subagent that has finished, or was paused, quit or stopped, keeps the notice until it next runs, for example when you resume it or send it a message. The notice is never sent to the parent's chat instead.
- Shells keep running after the subagent finishes. They stop when the parent's session closes.
- A shell that ends early says why. Its wait result and completion notice name the stop: `timed out after <n> seconds`, `stopped by a pause`, `session closed`, or `Atomic shut down`.
- A shell that its session's close stops gets its completion notice the next time that session is opened, once.

Custom operations adapters receive `wait` but must implement it themselves. External-terminal processes are not adopted into `/tasks`. A child's own tool use appears in that subagent's activity and transcript.

## Lifetime and scope

Background means independent of the current observation, not independent of its owner. **Pausing main chat** aborts the foreground turn only; its background agents and shells keep running. Ending a model turn or closing `/tasks` also leaves owned background work alone.

Closing a session cancels its remaining owned work. Explicit `/tasks` stop and declared execution timeouts remain separate controls.

On native Windows, Suspend opens a PowerShell subshell rather than freezing Atomic. Exit the subshell to restore the same session; owned background tasks continue while it is open.

Task inspection is owner-scoped. It is not a machine-wide process list. Switching sessions does not copy the previous session's task rows into the new one. Missing retained history is reported explicitly.

Each session keeps its 256 most recently finished tasks in `/tasks`, so a long session that runs thousands of shells or background subagents does not keep a record of every one. Running, queued and stopping tasks are always kept, and so is a finished shell whose cleanup is still being confirmed or failed. When another task finishes, the one that finished longest ago leaves `/tasks`, but never before its completion notice has been delivered, so a burst of finishes can briefly keep more than 256. Its result stays where the conversation reported it, in its completion notice or tool result, and a subagent's transcript stays in its own saved session; a paused or quit subagent still resumes with `subagent({ action: "resume", id })`. A shell command's full output is deleted with its record. Waiting on, stopping or reading the output of such a task reports `Task "<id>" finished and is no longer kept in this session` (code `TaskEvicted`) instead of an unknown task.

Closing `/tasks` does not stop the chat footer's live Git branch updates.

## Task state and completion delivery

Foreground and background are observation modes for the same task. Stopping a wait does not create, stop, or restart execution.

A terminal result does not by itself confirm resource cleanup. Check the tool's cleanup status before treating a stop as complete.

A temporary-worktree subagent can finish its own session while Atomic is still saving or releasing the directory. Switching sessions or closing the owner waits for the child's execution, output and recovery notice, but not for the batch's remaining Git work. This applies both to a child that had already finished running and to a live or queued child the close itself stopped. A close receipt can show `already-finishing`, not a terminal result or proof that the directory is free. The child's completion follows the directory work; see [temporary worktrees](/subagents) before removing one.

A shell command that finishes while a process it started still holds its output open, or whose process group takes longer than a few seconds to exit, is no longer reported as failed. Its result keeps the command's output and exit code, and its cleanup becomes `quarantined`: Atomic keeps confirming it in the background, with the command's process permit still held, until the session closes; closing then waits up to 15 seconds more. Confirmed cleanup becomes `reaped`. Cleanup still unconfirmed when that time is up becomes `failed`, and the close reports a `TaskCleanupError` (code `task_cleanup_unconfirmed`, `retryable: true`) that names each task and process group, with the next step in `hint`. `isRetryableTaskError(error)` from `@bastani/atomic` returns `true` for it and for an error whose `cause` chain holds it. Output a held-open process writes after the result settles is not kept. On Linux and macOS each shell runs in a session of its own, so cleanup ends every process the command started that is still in that session, including ones that moved to another process group, as GNU `timeout` and `set -m` job control do; it reports `reaped` only once all of them are gone. Processes that a command starts in their own session (for example with `setsid`) are not killed; the command's cleanup completes once they close its output. If Atomic itself dies without closing its sessions (killed with SIGKILL or by the OOM killer, or ended by a crash or `process.exit`), a small guardian process it starts with its first shell ends every shell still running and their sessions; Atomic replaces the guardian at once if something kills it first. On Windows, Job objects end them.

On Linux, when Atomic's own cgroup (v2) belongs to your user and enables no controllers, as under a systemd user service or most desktop terminals, each shell also runs in a cgroup of its own named `atomic-task-<pid>-<n>`. Atomic freezes that cgroup while it lists the session's processes, so none can fork out of sight. Set `ATOMIC_TASK_CGROUP=0` to turn this off. Elsewhere, for example in a login session owned by root, in most containers, and on macOS, Atomic finds the session's processes by scanning every process, which has one limit: a process that keeps forking a replacement and exiting can outrun the scan. A stop then repeats the kill for each member a later scan finds, and reports cleanup `reaped` only after several scans in a row find none. If Atomic dies, the guardian may miss such a process.

With a custom SDK `resourceAdmission` limit, unconfirmed cleanup can keep the process slots a later command needs. If that command's admission is still waiting after five seconds while tasks owned by the same session hold permits from the same admission provider for unconfirmed cleanup, it rejects before starting with `TaskCleanupAdmissionTimeoutError`. This is a retryable `TaskCleanupError` with code `task_cleanup_unconfirmed`, `phase: "command-admission"`, `timeoutMs`, `elapsedMs`, and the tasks and resources in `failures`. The earlier results stay intact and their permits remain held. Retry the command after those resources are confirmed released. `isTaskCleanupAdmissionTimeoutError(error)` and `rehydrateTaskCleanupError(value)` are exported from `@bastani/atomic`; `isRetryableTaskError(error)` also recognizes this error. Waiting for capacity held only by live work has no added deadline. Different `ResourceAdmission` objects used through execution scopes remain independent; quarantine in one does not bound waits in another.

UI previews are bounded and are not a substitute for retained output. Gaps and truncation are labelled; unavailable history is reported rather than reconstructed from activity counters.

## Related documentation

- [Subagents](/subagents) covers definitions, models, context, and delegation boundaries.
- [Keybindings](/keybindings) covers task-action remapping.
- [Orchestration](/orchestration) explains how the parent continues from child results.
