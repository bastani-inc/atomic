# Changelog

## [Unreleased]

### Fixed

- A background subagent that finished while its question to you (`contact_supervisor` or an Intercom `ask`) was still open is no longer relaunched after a restart only to be told that the question was interrupted. The next time the subagent runs, it is told once ([#6168](https://github.com/bastani-inc/atomic/issues/6168)).
- A subagent's launch card shows `Queued` with the queued mark (`○`) while it waits for its turn to run, and `Stopping` with the stopping mark (`◼`) while it is being stopped, as the agent panel shows it, instead of `Running`.
- A subagent that finished without text output shows the done mark (`●`) in result rows and summaries instead of `!`. Its label still says `Done (no text output)`.
- On Windows, Ctrl+C, Ctrl+Break and closing the console stop `skill-creator`'s description scripts at once and exit with the console-interrupt status (`0xC000013A`). Ctrl+C no longer waits for a running query to reach its timeout, and closing the console no longer reports the running queries as failed and exits with another status. Each query's Atomic now runs in a hidden console of its own, so only the scripts receive these keys and the close, and they stop the queries. A credential command that asks for input cannot be answered in that console: give the model an API key, an environment variable or a credential command that reads a cached token. When a query fails for missing credentials, the script ends with a note pointing to "Credentials on Windows" in `SKILL.md`.
- `skill-creator`'s `run_loop.py --holdout 0` finishes and writes its report, instead of failing after its first iteration when a report is written (the default).
- `skill-creator`'s review viewer prints its URL as soon as it serves when its output goes to a pipe or a file, and on Windows no longer fails before serving when that output is not the console. `SKILL.md` now starts the viewer as a background shell that keeps serving after the call that started it, and reads the URL from its output.
- `skill-creator`'s scripts write `feedback.json`, `benchmark.json`, `benchmark.md` and the improvement transcripts as UTF-8, and read grading, timing and eval metadata files and `SKILL.md` as UTF-8, falling back to the system's encoding for files saved in it. On Windows, `aggregate_benchmark.py` no longer fails or garbles non-ASCII text.
- On Windows, `skill-creator`'s `package_skill.py`, `aggregate_benchmark.py`, `generate_report.py` and `quick_validate.py` no longer fail when their output goes to a pipe or a file, as it does when Atomic runs them: `package_skill.py` failed on its first line, and the others on a path, name or mark outside the system's code page. The scripts and the review viewer now write their output and errors as UTF-8, so the evaluation's progress lines also show non-ASCII descriptions and queries as written. Output that is already UTF-8, such as a console's, is unchanged.
- A background subagent woken by the result of a call that kept running in the background, or by a background shell it launched finishing, now gets it as a notice card in its chat (the tool, whether it finished or failed, and its output), as the main chat gets a finished background task. It no longer shows up as a queued `Follow-up: The bash call … that kept running in the background finished:` message you could edit with Alt+Up, or as a message from you in its transcript, and the subagent reads each result once. When the result is the only thing that woke it, the notice starts its turn.
- A subagent you paused with Esc, restored paused after a restart, no longer answers a notice it had not read yet before you continue it.
- `skill-creator`'s review viewer shows the feedback already saved for the iteration when its page is reopened or reloaded, or the viewer is started again, also from the second iteration on, where it showed empty boxes and the next keystroke's save dropped the saved feedback from `feedback.json`. Feedback from the previous iteration still shows only as previous feedback. A run's output or feedback that contains `</script>` no longer breaks the page.
- A subagent restored after Atomic stopped unexpectedly continues on the model and thinking level it was running on, also when it was launched on a model or level its own session did not record (a `context: "fork"` launch on another model than its parent's, a restored subagent that continued on another model because its own was gone, or a resumed one on another effort). Such a launch now records them in the subagent's own session before its first request, as `/model` does, so they show there as a model or thinking level change, for example in `/tree` and exports.
- A subagent launched again without knowing where its session ended, or on a model without a thinking level, is no longer restored with that position or level from its earlier launch.
- When Atomic itself continues a background subagent (after a restart, when you resume it without a message, or when something it waited for arrived), the subagent gets a short note in its chat saying why (`Continuing after Atomic restarted`, `Continuing where it left off`, `Woken: what it waited for arrived`) instead of a message from you. Resuming a paused subagent with a message no longer queues a `Follow-up: Continue where you left off…` row behind your message: the subagent reads your message and the note in one request.
- A background subagent resumed with a message while it waited for its run's turn, after a restart while it waited on a background call, keeps your message until that call finishes and reads it then, instead of losing it.
- The `git` that prepares and checks a subagent's worktree runs only from the absolute directories in your PATH; the working directory counts only when PATH names it.

## [0.10.3] - 2026-11-21

### Changed

- `skill-creator`'s description optimization runs Atomic: `run_eval.py`, `run_loop.py` and `improve_description.py` start `atomic -p` with your Atomic models and credentials, and never start `claude`. Each trigger query loads the candidate description as a temporary skill, with only the read tool and no extensions or MCP servers, so the model has no tool that runs commands or edits files, and nothing is written into your project. A query counts as triggered when the model's first tool call reads that skill's `SKILL.md`. `--model` takes an Atomic model pattern such as `provider/id` ([#5625](https://github.com/bastani-inc/atomic/issues/5625)).

### Fixed

- Stopping `skill-creator`'s description scripts with Ctrl+C, `kill` or by closing the terminal (on Windows Ctrl+C, Ctrl+Break or closing the console) stops every evaluation process (each `atomic` they started and whatever that started), removes their temporary files and exits with that signal's status; the report left open in your browser is not touched. Ctrl+Z, `fg` and `bg` pause and continue the evaluation together with the script. Importing the scripts leaves your signal handlers alone, and `scripts.atomic_cli.cancel()` stops an evaluation in progress. Queries now run on Windows, and the review viewer picks a free port instead of stopping the program that listens on port 3117 ([#5625](https://github.com/bastani-inc/atomic/issues/5625)).
- Subagent result rows, status lists, launch cards and `pause`, `quit` and `resume` results use the agent panel's marks: a running subagent shows a still grey `◯` instead of `∀` or a pulsing dot, a finished one a green `●`, and an interrupted, killed, paused or quit one a red `◯`. A subagent waiting for an answer shows `◆` and one paused with Esc `‖`. A foreground subagent that continued on its own reads `Continued` with the running mark instead of `Stopped` ([#6122](https://github.com/bastani-inc/atomic/issues/6122)).
- A subagent woken while it waited no longer gets "You were released while you waited…" queued behind the turn it continues, nor a request just to read it: the results that wake it continue its turn, and messages sent to it arrive as their own. It is prompted with that text only when nothing else starts its turn.
- A subagent woken while it waited keeps its original task as its label in heartbeats, completion notices, `/tasks` and the agent panel, instead of showing the wake prompt. A subagent you resume with a message still shows that message.

## [0.10.3-alpha.1] - 2026-11-21

### Changed

- `skill-creator`'s description optimization runs Atomic: `run_eval.py`, `run_loop.py` and `improve_description.py` start `atomic -p` with your Atomic models and credentials, and never start `claude`. Each trigger query loads the candidate description as a temporary skill, with only the read tool and no extensions or MCP servers, so the model has no tool that runs commands or edits files, and nothing is written into your project. A query counts as triggered when the model's first tool call reads that skill's `SKILL.md`. `--model` takes an Atomic model pattern such as `provider/id` ([#5625](https://github.com/bastani-inc/atomic/issues/5625)).

### Fixed

- Stopping `skill-creator`'s description scripts with Ctrl+C, `kill` or by closing the terminal (on Windows Ctrl+C, Ctrl+Break or closing the console) stops every evaluation process (each `atomic` they started and whatever that started), removes their temporary files and exits with that signal's status; the report left open in your browser is not touched. Ctrl+Z, `fg` and `bg` pause and continue the evaluation together with the script. Importing the scripts leaves your signal handlers alone, and `scripts.atomic_cli.cancel()` stops an evaluation in progress. Queries now run on Windows, and the review viewer picks a free port instead of stopping the program that listens on port 3117 ([#5625](https://github.com/bastani-inc/atomic/issues/5625)).
- Subagent result rows, status lists, launch cards and `pause`, `quit` and `resume` results use the agent panel's marks: a running subagent shows a still grey `◯` instead of `∀` or a pulsing dot, a finished one a green `●`, and an interrupted, killed, paused or quit one a red `◯`. A subagent waiting for an answer shows `◆` and one paused with Esc `‖`. A foreground subagent that continued on its own reads `Continued` with the running mark instead of `Stopped` ([#6122](https://github.com/bastani-inc/atomic/issues/6122)).
- A subagent woken while it waited no longer gets "You were released while you waited…" queued behind the turn it continues, nor a request just to read it: the results that wake it continue its turn, and messages sent to it arrive as their own. It is prompted with that text only when nothing else starts its turn.
- A subagent woken while it waited keeps its original task as its label in heartbeats, completion notices, `/tasks` and the agent panel, instead of showing the wake prompt. A subagent you resume with a message still shows that message.

## [0.10.2] - 2026-11-20

### Breaking Changes

- An agent's `inheritProjectContext` and `inheritSkills` no longer keep the parent's project context or skills out of a forked subagent: a fork continues the parent's conversation as the parent sent it, so these settings now shape fresh children only. To keep the project context and skills out, launch the agent with `context: "fresh"` ([#6093](https://github.com/bastani-inc/atomic/pull/6093)).

### Changed

- A forked subagent (`context: "fork"`) continues its parent's conversation exactly as the parent last sent it: the same system prompt, including the project context and skills the parent was sent, the same tools and the same messages, including the parent's earlier subagent calls. It adds a short note, its own role and its task after it, and keeps the parent's prompt-cache key, so on the parent's model and thinking level its first request is read from the parent's prompt cache. A fork can still call only its own tools: a call to another tool the parent declared fails with an error naming the tools it may call. When the parent has `codemode` and the agent does not, the fork can call that `codemode`, which reaches only the fork's own tools (no `models` API), so a tool only the fork has, such as `contact_supervisor`, is reached through it on providers that cannot add tools to the parent's tool list. The fork's task is sent as written, without the earlier fork preamble. The subagent tool, the `subagent` skill and the docs recommend `fork` when a child needs the parent's conversation and `fresh` for independent work ([#6093](https://github.com/bastani-inc/atomic/pull/6093), [#6099](https://github.com/bastani-inc/atomic/pull/6099)).
- Subagent result rows, progress stats and usage lines write token counts with one decimal and the word `tokens`, as in `12.3k tokens` instead of `12k tok`, like the rest of Atomic. Progress stats no longer say `token` for many tokens ([#6096](https://github.com/bastani-inc/atomic/pull/6096)).

### Fixed

- A subagent reopened on another day or after Atomic was updated keeps the prompt its provider has cached. It is sent the system prompt it started with, and what changed since, such as the date, the model it falls back to or its skills, as updates after it, so the provider no longer processes its whole conversation again. A subagent last run by an earlier version is processed in full once more, on its first run after updating. A subagent whose agent now inherits differently, for example no longer the project context, starts over with its current prompt, and a session forked from a subagent's session uses a prompt of its own ([#6093](https://github.com/bastani-inc/atomic/pull/6093)).
- A subagent whose context was cleared or compacted while it ran, and that then finished, is reported done with its answer. It was reported failed with "Child ended without completing an assistant turn of its own." and its answer was missing. When its last turn has no text, the answer it wrote before the clear is reported. Turns from its earlier runs, or from the parent conversation a forked subagent starts with, still never count as its own ([#6098](https://github.com/bastani-inc/atomic/pull/6098)).

## [0.10.2-alpha.1] - 2026-11-20

### Breaking Changes

- An agent's `inheritProjectContext` and `inheritSkills` no longer keep the parent's project context or skills out of a forked subagent: a fork continues the parent's conversation as the parent sent it, so these settings now shape fresh children only. To keep the project context and skills out, launch the agent with `context: "fresh"` ([#6093](https://github.com/bastani-inc/atomic/pull/6093)).

### Changed

- A forked subagent (`context: "fork"`) continues its parent's conversation exactly as the parent last sent it: the same system prompt, including the project context and skills the parent was sent, the same tools and the same messages, including the parent's earlier subagent calls. It adds a short note, its own role and its task after it, and keeps the parent's prompt-cache key, so on the parent's model and thinking level its first request is read from the parent's prompt cache. A fork can still call only its own tools: a call to another tool the parent declared fails with an error naming the tools it may call. When the parent has `codemode` and the agent does not, the fork can call that `codemode`, which reaches only the fork's own tools (no `models` API), so a tool only the fork has, such as `contact_supervisor`, is reached through it on providers that cannot add tools to the parent's tool list. The fork's task is sent as written, without the earlier fork preamble. The subagent tool, the `subagent` skill and the docs recommend `fork` when a child needs the parent's conversation and `fresh` for independent work ([#6093](https://github.com/bastani-inc/atomic/pull/6093), [#6099](https://github.com/bastani-inc/atomic/pull/6099)).
- Subagent result rows, progress stats and usage lines write token counts with one decimal and the word `tokens`, as in `12.3k tokens` instead of `12k tok`, like the rest of Atomic. Progress stats no longer say `token` for many tokens ([#6096](https://github.com/bastani-inc/atomic/pull/6096)).

### Fixed

- A subagent reopened on another day or after Atomic was updated keeps the prompt its provider has cached. It is sent the system prompt it started with, and what changed since, such as the date, the model it falls back to or its skills, as updates after it, so the provider no longer processes its whole conversation again. A subagent last run by an earlier version is processed in full once more, on its first run after updating. A subagent whose agent now inherits differently, for example no longer the project context, starts over with its current prompt, and a session forked from a subagent's session uses a prompt of its own ([#6093](https://github.com/bastani-inc/atomic/pull/6093)).
- A subagent whose context was cleared or compacted while it ran, and that then finished, is reported done with its answer. It was reported failed with "Child ended without completing an assistant turn of its own." and its answer was missing. When its last turn has no text, the answer it wrote before the clear is reported. Turns from its earlier runs, or from the parent conversation a forked subagent starts with, still never count as its own ([#6098](https://github.com/bastani-inc/atomic/pull/6098)).

## [0.10.1] - 2026-11-20

### Fixed

- An interrupted `wait-for-text.sh` (bundled tmux skill) no longer waits for a stalled pane capture to finish or for its timeout. With bash 5.2 or older, an interrupt that arrived just as the helper began waiting for its worker was only acted on once the worker wrote again; it now stops within a second ([#5566](https://github.com/bastani-inc/atomic/issues/5566)).

## [0.10.1-alpha.1] - 2026-11-20

### Fixed

- An interrupted `wait-for-text.sh` (bundled tmux skill) no longer waits for a stalled pane capture to finish or for its timeout. With bash 5.2 or older, an interrupt that arrived just as the helper began waiting for its worker was only acted on once the worker wrote again; it now stops within a second ([#5566](https://github.com/bastani-inc/atomic/issues/5566)).

## [0.10.0] - 2026-11-20

### Breaking Changes

- Workflow stages no longer launch, hold, or resume subagents. Instead of nesting delegation through stages, launch children side by side from the parent session, directly or with codemode. Wait for a child by its task id and resume it by its child id. Reopening the parent session still restores its unfinished children; records left by former workflow stages are not resumed ([#5932](https://github.com/bastani-inc/atomic/pull/5932)).
- A managed worktree child's terminal report now means Atomic has finished using its directory. Extensions that unblock Git filters or pause reservations must listen for `subagent:finishing` instead of waiting for the terminal report. Atomic's cleanup Git commands set `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing`. A filter that waits for terminal without switching can still stall; the tool reports pending cleanup, not a finished task ([#5600](https://github.com/bastani-inc/atomic/issues/5600)).

### Added

- Codemode scripts can launch single or parallel subagents with `tools.subagent` and get their task IDs immediately, then wait with a budget, check status, and pause, quit or resume the children their session launched, including from a child's saved session. Scripts can `list` and `get` agent definitions; `create`, `update` and `delete` still require direct calls. The new `models` action lists configured models and their supported thinking levels, both directly and from scripts ([#5927](https://github.com/bastani-inc/atomic/pull/5927)).
- `/skill:workflow-files` uses `skill-creator` to convert an earlier workflow into a reusable skill, with its checks in `scripts/` and its dependencies and approvals in `SKILL.md`. It leaves the old file unchanged and never overwrites an existing skill ([#5924](https://github.com/bastani-inc/atomic/pull/5924)).
- Agents shipped by installed packages run as `<namespace>.<name>`, where the namespace is the package name with an npm scope as a dotted prefix: `name: reviewer` in `@acme/review-kit` runs as `acme.review-kit.reviewer`. A user or project agent with the same full name overrides it. `subagent` list and get name the source package, `/agents` lists them under Package agents, and update and delete refuse to change them. `/skill:workflow-files` turns a stage's pinned model, fallback models, tools and MCP servers into a named agent, and adds it to a package's `agents` when you ask it to update a package you maintain ([#5991](https://github.com/bastani-inc/atomic/issues/5991)).
- Any session that can message a subagent can resume it once it has finished. An Intercom message to a completed or failed subagent resumes it in its own session, and `subagent({ action: "resume", id: "<intercom-name>", message })` of a subagent another session launched sends it that message. The session that launched it keeps it: its result, notices, `/tasks` row and pause or quit stay there, and that session's transcript and the resumed task show who woke it. Paused or quit subagents are not resumed by others' messages; the messages reach them after they are continued ([#5999](https://github.com/bastani-inc/atomic/issues/5999)).

### Changed

- A subagent launched with `context: "fork"` starts faster and copies less data after a clear or compaction. Its saved session keeps the conversation through its original fork point, without duplicating retired turns. It still keeps the entries extensions saved with `pi.appendEntry` and the records of which tools were added or removed before that point, so extensions and tool restores in the child see the same state as in the parent; for a session last indexed by an earlier Atomic version, finding them reads the branch before the fork point, which takes longer in a long session. Earlier history remains in the parent session ([#5500](https://github.com/bastani-inc/atomic/issues/5500)).
- The `wait` and `status` output of a subagent that completed or failed names the call that continues it, after its `Output of <task-id> (…):` header. A codemode script's settled `wait` also returns the child's `childId`, and a `resumeCall` when the child completed, failed, or was paused or quit, like the one `status` returns ([#5968](https://github.com/bastani-inc/atomic/pull/5968)).
- A subagent receives the messages you type for it through its own steering and follow-up queue, exactly as you typed them, instead of as Intercom messages with your chat's name and folder in front of the text. Messages from other agents still arrive through Intercom ([#6008](https://github.com/bastani-inc/atomic/pull/6008)).
- A subagent you pause with Esc keeps its session and task, stays paused when Atomic restarts and the session is continued or resumed, and continues with the next message you send it. Messages from other agents and its background work's notices wait until then and are delivered after your message. `x` in `/tasks` and `subagent({ action: "pause" })` or `quit` still stop it ([#6008](https://github.com/bastani-inc/atomic/pull/6008)).

### Fixed

- A delayed wake refusal no longer shows `hold-failed` when Intercom confirms that reconnect restored the same released subagent. A child whose hold was dropped still reports the failure, as do older brokers that cannot verify the hold ([#5641](https://github.com/bastani-inc/atomic/issues/5641)).
- Temporary worktree children now report completion, pause, or quit after cleanup rather than while Atomic still has the directory open. The reply explains when a sibling keeps the batch open or cleanup continues in the background; Esc still ends the wait immediately ([#5600](https://github.com/bastani-inc/atomic/issues/5600)).
- When an SDK session without a task host batches several subagent calls, each caller now receives only its own children’s answers, even if a child used a fallback model or its parent cancelled it. Previously each caller could receive the whole batch’s text ([#5600](https://github.com/bastani-inc/atomic/issues/5600)).
- A forked child that waits for a slot starts at the original launch entry. A retry reopens the same child without keeping its completed session in memory ([#5594](https://github.com/bastani-inc/atomic/issues/5594)).
- A subagent's task names the model it runs on after every switch of its session's model, also one no fallback announced, such as an extension's `setModel`, and reports a fallback's model together with its reasoning level, so its `/tasks` row, launch card and completion notice never pair the new model with the level the old one ran at ([#6017](https://github.com/bastani-inc/atomic/pull/6017)).

## [0.10.0-alpha.1] - 2026-11-20

### Breaking Changes

- Workflow stages no longer launch, hold, or resume subagents. Instead of nesting delegation through stages, launch children side by side from the parent session, directly or with codemode. Wait for a child by its task id and resume it by its child id. Reopening the parent session still restores its unfinished children; records left by former workflow stages are not resumed ([#5932](https://github.com/bastani-inc/atomic/pull/5932)).
- A managed worktree child's terminal report now means Atomic has finished using its directory. Extensions that unblock Git filters or pause reservations must listen for `subagent:finishing` instead of waiting for the terminal report. Atomic's cleanup Git commands set `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing`. A filter that waits for terminal without switching can still stall; the tool reports pending cleanup, not a finished task ([#5600](https://github.com/bastani-inc/atomic/issues/5600)).

### Added

- Codemode scripts can launch single or parallel subagents with `tools.subagent` and get their task IDs immediately, then wait with a budget, check status, and pause, quit or resume the children their session launched, including from a child's saved session. Scripts can `list` and `get` agent definitions; `create`, `update` and `delete` still require direct calls. The new `models` action lists configured models and their supported thinking levels, both directly and from scripts ([#5927](https://github.com/bastani-inc/atomic/pull/5927)).
- `/skill:workflow-files` uses `skill-creator` to convert an earlier workflow into a reusable skill, with its checks in `scripts/` and its dependencies and approvals in `SKILL.md`. It leaves the old file unchanged and never overwrites an existing skill ([#5924](https://github.com/bastani-inc/atomic/pull/5924)).
- Agents shipped by installed packages run as `<namespace>.<name>`, where the namespace is the package name with an npm scope as a dotted prefix: `name: reviewer` in `@acme/review-kit` runs as `acme.review-kit.reviewer`. A user or project agent with the same full name overrides it. `subagent` list and get name the source package, `/agents` lists them under Package agents, and update and delete refuse to change them. `/skill:workflow-files` turns a stage's pinned model, fallback models, tools and MCP servers into a named agent, and adds it to a package's `agents` when you ask it to update a package you maintain ([#5991](https://github.com/bastani-inc/atomic/issues/5991)).
- Any session that can message a subagent can resume it once it has finished. An Intercom message to a completed or failed subagent resumes it in its own session, and `subagent({ action: "resume", id: "<intercom-name>", message })` of a subagent another session launched sends it that message. The session that launched it keeps it: its result, notices, `/tasks` row and pause or quit stay there, and that session's transcript and the resumed task show who woke it. Paused or quit subagents are not resumed by others' messages; the messages reach them after they are continued ([#5999](https://github.com/bastani-inc/atomic/issues/5999)).

### Changed

- A subagent launched with `context: "fork"` starts faster and copies less data after a clear or compaction. Its saved session keeps the conversation through its original fork point, without duplicating retired turns. It still keeps the entries extensions saved with `pi.appendEntry` and the records of which tools were added or removed before that point, so extensions and tool restores in the child see the same state as in the parent; for a session last indexed by an earlier Atomic version, finding them reads the branch before the fork point, which takes longer in a long session. Earlier history remains in the parent session ([#5500](https://github.com/bastani-inc/atomic/issues/5500)).
- The `wait` and `status` output of a subagent that completed or failed names the call that continues it, after its `Output of <task-id> (…):` header. A codemode script's settled `wait` also returns the child's `childId`, and a `resumeCall` when the child completed, failed, or was paused or quit, like the one `status` returns ([#5968](https://github.com/bastani-inc/atomic/pull/5968)).
- A subagent receives the messages you type for it through its own steering and follow-up queue, exactly as you typed them, instead of as Intercom messages with your chat's name and folder in front of the text. Messages from other agents still arrive through Intercom ([#6008](https://github.com/bastani-inc/atomic/pull/6008)).
- A subagent you pause with Esc keeps its session and task, stays paused when Atomic restarts and the session is continued or resumed, and continues with the next message you send it. Messages from other agents and its background work's notices wait until then and are delivered after your message. `x` in `/tasks` and `subagent({ action: "pause" })` or `quit` still stop it ([#6008](https://github.com/bastani-inc/atomic/pull/6008)).

### Fixed

- A delayed wake refusal no longer shows `hold-failed` when Intercom confirms that reconnect restored the same released subagent. A child whose hold was dropped still reports the failure, as do older brokers that cannot verify the hold ([#5641](https://github.com/bastani-inc/atomic/issues/5641)).
- Temporary worktree children now report completion, pause, or quit after cleanup rather than while Atomic still has the directory open. The reply explains when a sibling keeps the batch open or cleanup continues in the background; Esc still ends the wait immediately ([#5600](https://github.com/bastani-inc/atomic/issues/5600)).
- When an SDK session without a task host batches several subagent calls, each caller now receives only its own children’s answers, even if a child used a fallback model or its parent cancelled it. Previously each caller could receive the whole batch’s text ([#5600](https://github.com/bastani-inc/atomic/issues/5600)).
- A forked child that waits for a slot starts at the original launch entry. A retry reopens the same child without keeping its completed session in memory ([#5594](https://github.com/bastani-inc/atomic/issues/5594)).
- A subagent's task names the model it runs on after every switch of its session's model, also one no fallback announced, such as an extension's `setModel`, and reports a fallback's model together with its reasoning level, so its `/tasks` row, launch card and completion notice never pair the new model with the level the old one ran at ([#6017](https://github.com/bastani-inc/atomic/pull/6017)).

## [0.9.90] - 2026-11-19

### Breaking Changes

- Every `subagent` launch now runs in the background. The call returns once each child is admitted, with its task id, and the child reports by its completion notice. A subagent the agent needs next is therefore listed below the prompt and in `/tasks` like any other, where you can open its chat, message it or stop it. The launch `wait` option is gone: a call that still passes `wait: { kind: "foreground" }`, as an older saved prompt, agent or workflow may, runs in the background, and the first line of its result says so. To use a child's result in the same turn, wait for it with `subagent({ action: "wait", id })`. A subagent's `contact_supervisor` decision or interview now always waits for the supervisor's reply in the same child, instead of ending a single child with a fresh-subagent handoff; only an SDK session without a task host, which still runs its subagents directly and waits for them as before, keeps that handoff.

### Changed

- The bundled `tdd` skill now names tautological tests, whose expected value is recomputed the way the code computes it, as an anti-pattern, with a checklist item and an example, from its upstream skill. Its frontmatter and a new `LICENSE.txt` credit the two MIT-licensed skills it is adapted from.
- The bundled `qlty` skill's references follow the current Qlty documentation (CLI v0.671.0): `--skip`, `plugin:rule` filters and `--trigger` for `check` and `fmt`, `--install-only` and `--skip-source-fetch`, `--sarif` for `smells`, and the integrity verification steps, which need `gh` 2.67.0 or later because older versions can report success when no matching attestation is found.

### Fixed

- The bundled tmux skill's helper scripts carry the upstream fixes since they were adopted. `find-sessions.sh` shows each session's attached state and start time (it printed a literal `\t`, an empty time and "detached" for every session), counts a session with several clients as attached, matches `-q` literally against session names, and scans hidden sockets with `-A`. `wait-for-text.sh` accepts a zero-padded timeout such as `-T 08`, no longer reports a match when the pane capture fails, rejects an invalid pattern at once instead of waiting out the timeout, and stops checking at the deadline. It now times out even if checking the timer, validating the pattern, or capturing the pane stalls, rejects late matches, reports the last complete pane capture, and stops its own worker when interrupted; `-T 0` does not inspect the pane. The skill also shows how to wait for a command's completion marker without matching the echoed command line, and its new `LICENSE.txt` credits OpenClaw's MIT-licensed tmux skill, which the scripts and parts of the skill come from ([#5566](https://github.com/bastani-inc/atomic/issues/5566))
- A subagent released while it waits on a tool call shows how long it ran up to its release on its completion notice and launch card, as the agent panel and `/tasks` do. It read the time of its last progress report, often `0s` for a child that spent its time in that call. Subagent task views, notices, heartbeats and results count the same time from dispatch through release, stop or completion, including session startup. Launch cards count silent waits and show the new run after a wake. SDK results and records include startup failures and time spent running after an Intercom handoff ([#5496](https://github.com/bastani-inc/atomic/issues/5496), [#5570](https://github.com/bastani-inc/atomic/issues/5570))
- Fixed `subagent({ action: "resume" })` never answering while a wake ran the child. A released or finished subagent that a result, shell completion or Intercom message woke runs again, but resume did not refuse it as already running: it queued behind that run and answered only when the run ended, so the parent's turn showed no result and could not end, and the child never got the message. Resume now refuses such a child at once with `<agent> (<child-id>, <intercom-name>) is already running as task <task-id>; pause or quit it first.`, without waiting for a sibling to save or for the child to register on Intercom, and a resume that arrives while a wake or another resume is still reopening the child waits only until it runs, then gives that error. A workflow-stage reload during a wake no longer lets a second resume launch the same child. Interrupting the turn (Esc) also ends a `pause`, `resume` or `quit` call that is still waiting: a stop that was already requested goes on, and a resume still queued to wake the child is withdrawn and never runs. If the child is not running yet, Esc ends a pending resume even during a sibling save, without reopening the child or sending its message ([#5485](https://github.com/bastani-inc/atomic/issues/5485), [#5560](https://github.com/bastani-inc/atomic/issues/5560))
- Pressing Esc while the agent waits for a subagent with `subagent({ action: "wait", id })` ends the wait and the turn at once, instead of holding the turn until the wait's budget runs out. The subagent keeps running, and its completion notice still arrives.
- When one of several `subagent` calls in the same message fails on its own before any child starts, for example because it names an unknown agent, gives an invalid task count, or asks for a file-only output without an output file, only that call fails, with its own task numbers. The other calls still launch, once; before, every call in the message failed with that error and nothing launched. Two tasks in one call writing the same file also fail only that call, even when it uses named worktrees. The combined task limit counts only calls left after checking for their own errors, including duplicate absolute output paths known before a worktree exists. A sibling call with both `agent` and `tasks` counts its top-level child as well as its listed tasks, and keeps all of them if it is the only call left to launch. An error only the remaining calls have together, such as too many tasks altogether, still fails them all, and so does a failure to make a required worktree. Sibling `subagent` calls in the same message that differ only in setting `worktree`, `share` or `includeProgress` to `false` or leaving it out launch together, instead of all failing with "incompatible top-level field". Sibling calls that cannot launch together because they differ in a top-level field, such as `concurrency` or `context`, launch as separate runs when they passed different `wait` values, as they did before every launch ran in the background, instead of all failing with "incompatible top-level field" with nothing launched. Calls that can launch together still do, as one run, whatever `wait` they pass ([#5686](https://github.com/bastani-inc/atomic/issues/5686))
- A parallel `subagent` call that fails before any child starts shows its error on its card, collapsed and expanded, instead of a `Stopped` row for each task.
- On Windows, a worktree setup hook stopped for its output size has its process tree terminated once, also when its timeout comes before the hook ends ([#5601](https://github.com/bastani-inc/atomic/issues/5601))
- A subagent that finished on its own and is woken to read the result of a call that kept running in the background no longer brings a "Released subagent reservation failed" (`hold-failed`) notice: the wake no longer asks Intercom to extend a reservation such a subagent never had. A reservation failure reported after its subagent runs again or has ended is not shown either. The notice names exactly the subagents whose reservation failed: when the broker refuses one of many, it names that one instead of the first, and retries only the others still on the same release. If a subagent finishes before that retry, sends still report that it completed instead of waking it again. It is shown once for each release of a subagent until a reservation of it succeeds, so another subagent's successful reservation no longer brings it again, and another subagent's failure is no longer kept quiet by it. A refusal that answers a subagent's earlier release is not shown once a later run released it or it was reserved again. That notice, the failure line of `status` and the reason of a failed wake state their code and hint once instead of twice, also for a failure passed on as JSON, and a failure that knows a subagent only by its Intercom name names it instead of `undefined`. The hint of `completion-not-held` now says the shell task's notice waits for the subagent's next run, as it does, instead of saying the session that launched it receives it ([#5551](https://github.com/bastani-inc/atomic/issues/5551))
- Fixed `subagent({ action: "resume" })` reporting that it could not restart a paused worktree subagent while Atomic was still running git inside that subagent's worktree to decide whether to keep it. On Windows a running process locks its directory, so removing the worktree right after the error failed with `EBUSY`, and a worktree with no unsaved work that resume had recreated was still on disk when the error arrived. Resume now waits for cleanup already underway. It tells you if a running sibling keeps the batch's worktrees, cleanup continues in the background, or a stalled git command had to be stopped ([#5589](https://github.com/bastani-inc/atomic/issues/5589))
- A child waking as its owner reloads now saves its running task once. It no longer appears finished or reports a stale-context error while the task is live ([#5609](https://github.com/bastani-inc/atomic/issues/5609)).
- After other sessions finish 256 subagents, `wait` and `status` can still show a retained child's short answer from its transcript. When the exact text is no longer available, they point to the earlier result or the child's transcript instead of reporting `OutputUnavailable` ([#5703](https://github.com/bastani-inc/atomic/issues/5703)).
- Fixed a forked subagent’s first request being rejected because the latest assistant turn’s signed thinking had changed. When removing a parent-only tool result or notice leaves a thinking-only message joined to Claude’s latest signed reply, the child omits that one message. Replies with text and reasoning sent to other models are unchanged ([#5481](https://github.com/bastani-inc/atomic/issues/5481)).

## [0.9.90-alpha.1] - 2026-11-19

### Breaking Changes

- Every `subagent` launch now runs in the background. The call returns once each child is admitted, with its task id, and the child reports by its completion notice. A subagent the agent needs next is therefore listed below the prompt and in `/tasks` like any other, where you can open its chat, message it or stop it. The launch `wait` option is gone: a call that still passes `wait: { kind: "foreground" }`, as an older saved prompt, agent or workflow may, runs in the background, and the first line of its result says so. To use a child's result in the same turn, wait for it with `subagent({ action: "wait", id })`. A subagent's `contact_supervisor` decision or interview now always waits for the supervisor's reply in the same child, instead of ending a single child with a fresh-subagent handoff; only an SDK session without a task host, which still runs its subagents directly and waits for them as before, keeps that handoff.

### Changed

- The bundled `tdd` skill now names tautological tests, whose expected value is recomputed the way the code computes it, as an anti-pattern, with a checklist item and an example, from its upstream skill. Its frontmatter and a new `LICENSE.txt` credit the two MIT-licensed skills it is adapted from.
- The bundled `qlty` skill's references follow the current Qlty documentation (CLI v0.671.0): `--skip`, `plugin:rule` filters and `--trigger` for `check` and `fmt`, `--install-only` and `--skip-source-fetch`, `--sarif` for `smells`, and the integrity verification steps, which need `gh` 2.67.0 or later because older versions can report success when no matching attestation is found.

### Fixed

- The bundled tmux skill's helper scripts carry the upstream fixes since they were adopted. `find-sessions.sh` shows each session's attached state and start time (it printed a literal `\t`, an empty time and "detached" for every session), counts a session with several clients as attached, matches `-q` literally against session names, and scans hidden sockets with `-A`. `wait-for-text.sh` accepts a zero-padded timeout such as `-T 08`, no longer reports a match when the pane capture fails, rejects an invalid pattern at once instead of waiting out the timeout, and stops checking at the deadline. It now times out even if checking the timer, validating the pattern, or capturing the pane stalls, rejects late matches, reports the last complete pane capture, and stops its own worker when interrupted; `-T 0` does not inspect the pane. The skill also shows how to wait for a command's completion marker without matching the echoed command line, and its new `LICENSE.txt` credits OpenClaw's MIT-licensed tmux skill, which the scripts and parts of the skill come from ([#5566](https://github.com/bastani-inc/atomic/issues/5566))
- A subagent released while it waits on a tool call shows how long it ran up to its release on its completion notice and launch card, as the agent panel and `/tasks` do. It read the time of its last progress report, often `0s` for a child that spent its time in that call. Subagent task views, notices, heartbeats and results count the same time from dispatch through release, stop or completion, including session startup. Launch cards count silent waits and show the new run after a wake. SDK results and records include startup failures and time spent running after an Intercom handoff ([#5496](https://github.com/bastani-inc/atomic/issues/5496), [#5570](https://github.com/bastani-inc/atomic/issues/5570))
- Fixed `subagent({ action: "resume" })` never answering while a wake ran the child. A released or finished subagent that a result, shell completion or Intercom message woke runs again, but resume did not refuse it as already running: it queued behind that run and answered only when the run ended, so the parent's turn showed no result and could not end, and the child never got the message. Resume now refuses such a child at once with `<agent> (<child-id>, <intercom-name>) is already running as task <task-id>; pause or quit it first.`, without waiting for a sibling to save or for the child to register on Intercom, and a resume that arrives while a wake or another resume is still reopening the child waits only until it runs, then gives that error. A workflow-stage reload during a wake no longer lets a second resume launch the same child. Interrupting the turn (Esc) also ends a `pause`, `resume` or `quit` call that is still waiting: a stop that was already requested goes on, and a resume still queued to wake the child is withdrawn and never runs. If the child is not running yet, Esc ends a pending resume even during a sibling save, without reopening the child or sending its message ([#5485](https://github.com/bastani-inc/atomic/issues/5485), [#5560](https://github.com/bastani-inc/atomic/issues/5560))
- Pressing Esc while the agent waits for a subagent with `subagent({ action: "wait", id })` ends the wait and the turn at once, instead of holding the turn until the wait's budget runs out. The subagent keeps running, and its completion notice still arrives.
- When one of several `subagent` calls in the same message fails on its own before any child starts, for example because it names an unknown agent, gives an invalid task count, or asks for a file-only output without an output file, only that call fails, with its own task numbers. The other calls still launch, once; before, every call in the message failed with that error and nothing launched. Two tasks in one call writing the same file also fail only that call, even when it uses named worktrees. The combined task limit counts only calls left after checking for their own errors, including duplicate absolute output paths known before a worktree exists. A sibling call with both `agent` and `tasks` counts its top-level child as well as its listed tasks, and keeps all of them if it is the only call left to launch. An error only the remaining calls have together, such as too many tasks altogether, still fails them all, and so does a failure to make a required worktree.
- Sibling `subagent` calls in the same message that differ only in setting `worktree`, `share` or `includeProgress` to `false` or leaving it out launch together, instead of all failing with "incompatible top-level field". Sibling calls that cannot launch together because they differ in a top-level field, such as `concurrency` or `context`, launch as separate runs when they passed different `wait` values, as they did before every launch ran in the background, instead of all failing with "incompatible top-level field" with nothing launched. Calls that can launch together still do, as one run, whatever `wait` they pass ([#5686](https://github.com/bastani-inc/atomic/issues/5686))
- A parallel `subagent` call that fails before any child starts shows its error on its card, collapsed and expanded, instead of a `Stopped` row for each task.
- On Windows, a worktree setup hook stopped for its output size has its process tree terminated once, also when its timeout comes before the hook ends ([#5601](https://github.com/bastani-inc/atomic/issues/5601))
- A subagent that finished on its own and is woken to read the result of a call that kept running in the background no longer brings a "Released subagent reservation failed" (`hold-failed`) notice: the wake no longer asks Intercom to extend a reservation such a subagent never had. A reservation failure reported after its subagent runs again or has ended is not shown either. The notice names exactly the subagents whose reservation failed: when the broker refuses one of many, it names that one instead of the first, and retries only the others still on the same release. If a subagent finishes before that retry, sends still report that it completed instead of waking it again. It is shown once for each release of a subagent until a reservation of it succeeds, so another subagent's successful reservation no longer brings it again, and another subagent's failure is no longer kept quiet by it. A refusal that answers a subagent's earlier release is not shown once a later run released it or it was reserved again. That notice, the failure line of `status` and the reason of a failed wake state their code and hint once instead of twice, also for a failure passed on as JSON, and a failure that knows a subagent only by its Intercom name names it instead of `undefined`. The hint of `completion-not-held` now says the shell task's notice waits for the subagent's next run, as it does, instead of saying the session that launched it receives it ([#5551](https://github.com/bastani-inc/atomic/issues/5551))
- Fixed `subagent({ action: "resume" })` reporting that it could not restart a paused worktree subagent while Atomic was still running git inside that subagent's worktree to decide whether to keep it. On Windows a running process locks its directory, so removing the worktree right after the error failed with `EBUSY`, and a worktree with no unsaved work that resume had recreated was still on disk when the error arrived. Resume now waits for cleanup already underway. It tells you if a running sibling keeps the batch's worktrees, cleanup continues in the background, or a stalled git command had to be stopped ([#5589](https://github.com/bastani-inc/atomic/issues/5589))
- A child waking as its owner reloads now saves its running task once. It no longer appears finished or reports a stale-context error while the task is live ([#5609](https://github.com/bastani-inc/atomic/issues/5609)).
- After other sessions finish 256 subagents, `wait` and `status` can still show a retained child's short answer from its transcript. When the exact text is no longer available, they point to the earlier result or the child's transcript instead of reporting `OutputUnavailable` ([#5703](https://github.com/bastani-inc/atomic/issues/5703)).
- Fixed a forked subagent’s first request being rejected because the latest assistant turn’s signed thinking had changed. When removing a parent-only tool result or notice leaves a thinking-only message joined to Claude’s latest signed reply, the child omits that one message. Replies with text and reasoning sent to other models are unchanged ([#5481](https://github.com/bastani-inc/atomic/issues/5481)).

## [0.9.89] - 2026-11-18

### Breaking Changes

- `model: "auto"`, which every builtin agent declares, now runs your default model at its default thinking level, or at the agent's own `thinking` when it sets one, and runs the launching session's model and thinking level when no default model is configured. No routing model is asked, so an `auto` launch starts without a routing request. An `auto` launch still falls back to the agent's `fallbackModels` and then to the session's model.
- Removed `taskNeeds` and `modelConstraints` from the `subagent` tool, agent frontmatter, agent configs and builtin agent overrides, and `routerSelection` from subagent results. Tool calls and agent files that still set them keep working with the fields ignored and a one-time warning, and an agent file that agent management rewrites drops them. When Atomic starts, it deletes them from the builtin agent overrides (`subagents.agentOverrides`) in your global settings file and in the settings file of a trusted project (or of a project when you trust it), keeps every other setting, and says once which agents' overrides it changed. When the file cannot be written, or Atomic does not write it (a parent directory's `.atomic/settings.json`, or the legacy `~/.pi/agent/settings.json`), they are ignored with a warning shown once, and again only after their values change. Provider and model restrictions set through `modelConstraints` no longer limit `auto` or any fallback model.

### Added

- A subagent whose tools leave out `read` or `search` gets one read-only tool, `session_history`, after compaction first clears its context, so it can recover what it needs from its own session's history. It reaches no other session, file or project
- A subagent of a session created with the SDK's `intercom` option gets its own Intercom policy: its group is its home and it reaches nothing else. It starts in the session's home group, and a requested `group` (including `true`) is placed under it, as `<home>/<group>` ([#5352](https://github.com/bastani-inc/atomic/issues/5352))

### Changed

- A subagent attempt whose session directory cannot be created now fails that attempt instead of rejecting the launch call
- Agent launches and control calls use shared state-marked blocks. Foreground and background launches show the short task title, elapsed time, token count and live management hint. Completion notices name the agent and show its first result line; expansion shows the prompt, tool calls and full retained result without inherited fork history ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- A background subagent released while it waits on a call shows `◌ Waiting on <tool>` on its launch card, the way `/tasks` and the agent panel show it, instead of `⏸ Released · waiting`, and its card follows it back to running or finished when it wakes or ends

### Fixed

- Interrupting a subagent from its attached chat updates its call block, panel row and task sheet to stopped, freezes its elapsed time and offers `Stopped · send to resume`. A later completed turn keeps its past-tense end row when the live session is released ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- Fixed Atomic exiting with `child-record-unreadable` ("which is not open in this process") when a workflow stage that had launched a background subagent finished, failed or had its run ended. Closing the stage reads each child's latest record to record it `stage-closed`. That record was read only through the copies of the stage's session registered for it, which are held weakly and which a later copy of the session can replace, and the error escaped from the stage's close listener and ended the process. The stage now also reads its children's records through its own session. When the copy that saved a newer record is gone, the stage ends the child from the record its own session holds, updated with where the child stands as Atomic last saw it. A child that is still running instead ends once its task settles, and a child that was already killed, gone or `stage-closed` is left as it is. A child it can read no record of is counted as a record that could not be saved, and the stage's other children still end. Nothing that goes wrong while a stage closes ends the process or fails the close.
- Fixed a workflow stage that gave up its session while it waited not recording its subagents `stage-closed` when it closed for good, whether it reopened that session first or its run was killed or ended while it was still released. The records were saved through the session it had given up, which refuses them. They are now saved through the stage's newest session, or through its session reopened from the store while the stage holds none.
- Fixed one subagent whose latest record is in a session not open in this process stopping its owner's other subagents from being handled: the session no longer fails to start, its other released subagents are still reserved and woken, `subagents:` sends still reach the rest, and a broker wake for it is reported instead of thrown. Restoring such a subagent reads it from its owner's own session, and neither a wake for results it received while it ran nor clearing results delivered to it leaves an unhandled rejection that would end the process when its owner's session fails to read its record: the failure is reported to the owner.
- The subagent tool, `/agents`, agent management, child restore and worktree subagents no longer pause the interface while they read agent definitions, skills, settings and child artifacts, write and clean up run artifacts, run git for worktrees, or record run history
- Long runs of whitespace in tool output, bash commands, subagent tasks, inherited prompts or npm package specs no longer stall the session for seconds while they are parsed
- Fixed a long-running Atomic session keeping every workflow stage, and every other session, that launched subagents in memory after it ended. Each subagent run kept the session that launched it reachable, with its whole history, extensions and tools, for as long as the process ran, so a workflow of about 60 stages that each delegated to subagents grew the session's process to several gigabytes over a few hours, and the larger the process grew, the slower every new shell and tool process started. A run now keeps only which session launched it, and subagent cards keep only the session store, never the last session that showed them. Atomic also keeps the in-process status of only the 256 most recently finished subagent runs; an older run's children still resume from their saved sessions.
- Fixed launching, inspecting, and restoring subagents failing with `sessionManager.getEntrySeq is not a function` when the host or an SDK `SessionManager` does not implement `getEntrySeq` or `findEntrySeq` ([#5316](https://github.com/bastani-inc/atomic/issues/5316))
- Fixed a background subagent that was slow to start showing only as `running` for many minutes, with no Intercom registration, metrics or output. A child that has not started its first turn now shows where its start is. `subagent status` gives the step and how long it and the start have run, `/tasks` and task heartbeats show the step as its current action, and the launch result and `status` name the child's Intercom target. A start that runs out of its start budget is shown as stalled with that step, retried once, and then fails with both stalls named. The launching session is told. The retry keeps the messages the stalled start had received before its first turn, and the task's cleanup covers the retry's session.
- Fixed a subagent that started while the Intercom broker was briefly unreachable running its turns unregistered, invisible to `intercom list` and unreachable until it next used Intercom itself. Its start now waits in its `registering on Intercom` step and retries until it registers, within its start budget.
- Fixed `contact_supervisor` reaching the wrong session. A background subagent named as its supervisor whichever session in the Atomic process had connected to Intercom last, such as another subagent or a workflow stage hosted in that process, instead of the session that launched it. Its updates and questions went to that session and never reached its parent. A child now names the Intercom id its launching session registered under, or that session's own name until it has one, and a child relaunched after a restart does the same.
- Subagent artifact storage for sessions without a session file is created only when a subagent needs it, not at every session start. On Windows, it waits for its private-directory check, using the native module with an asynchronous PowerShell fallback, without pausing the main thread. A subagent cancelled during that check creates no child storage or supervisor authorization, and a storage failure returns a tool error. Startup artifact cleanup stays single-flight until its asynchronous work finishes, even if the session that started it ends ([#5285](https://github.com/bastani-inc/atomic/issues/5285), [#5324](https://github.com/bastani-inc/atomic/issues/5324))
- A background subagent's final answer stays visible in `/tasks`, its transcript and completion card when saving it fails, even while its session is still shutting down ([#5210](https://github.com/bastani-inc/atomic/issues/5210))
- A subagent launch whose model chain has no credentials now names each skipped model and its provider in the error. A provider that rejects credentials is skipped for the rest of the child's fallback walk ([#5353](https://github.com/bastani-inc/atomic/pull/5353)).
- Fixed a message that reached a subagent as it finished being accepted and then left unanswered, including a steering, follow-up or user message and one an extension sends as the child's last turn settles. The child now answers accepted turn-starting input before it completes, and refuses one that arrives after that with its terminal-child error. A child being released also keeps turn-starting extension messages and background completion notices with steering or follow-up delivery. It saves each card once and delivers its context once on wake, including batches retried after a card write fails or the child's session reopens. Context-excluded extension messages keep their saved cards without reaching the model. Pressing Esc while a resumed subagent replays a message that arrived before it stopped also leaves it waiting for your next message, as Esc does on any other turn; it answers that message, then continues with the task it was resumed with. A resumed subagent no longer fails with `Agent is already processing` when an extension's interrupting message is still being answered as its task is sent; it answers both ([#5318](https://github.com/bastani-inc/atomic/issues/5318))
- A subagent's pending question marks its task as needing input and can be answered in its own task transcript. Leaving that view keeps its form state; Escape in the form cancels it. Questions no longer appear in, block, or take answers from the main chat or sibling sessions ([#5354](https://github.com/bastani-inc/atomic/pull/5354))
- Fixed long malformed progress or output instructions in a subagent task freezing its live or restored tool block while Atomic formats the prompt ([#5239](https://github.com/bastani-inc/atomic/pull/5239))
- An open subagent chat no longer reads every entry of the session that launched it on each frame to tell whether the subagent is stopped or read-only.

## [0.9.89-alpha.2] - 2026-11-18

### Changed

- A background subagent released while it waits on a call shows `◌ Waiting on <tool>` on its launch card, the way `/tasks` and the agent panel show it, instead of `⏸ Released · waiting`, and its card follows it back to running or finished when it wakes or ends

## [0.9.89-alpha.1] - 2026-11-18

### Breaking Changes

- `model: "auto"`, which every builtin agent declares, now runs your default model at its default thinking level, or at the agent's own `thinking` when it sets one, and runs the launching session's model and thinking level when no default model is configured. No routing model is asked, so an `auto` launch starts without a routing request. An `auto` launch still falls back to the agent's `fallbackModels` and then to the session's model.
- Removed `taskNeeds` and `modelConstraints` from the `subagent` tool, agent frontmatter, agent configs and builtin agent overrides, and `routerSelection` from subagent results. Tool calls and agent files that still set them keep working with the fields ignored and a one-time warning, and an agent file that agent management rewrites drops them. When Atomic starts, it deletes them from the builtin agent overrides (`subagents.agentOverrides`) in your global settings file and in the settings file of a trusted project (or of a project when you trust it), keeps every other setting, and says once which agents' overrides it changed. When the file cannot be written, or Atomic does not write it (a parent directory's `.atomic/settings.json`, or the legacy `~/.pi/agent/settings.json`), they are ignored with a warning shown once, and again only after their values change. Provider and model restrictions set through `modelConstraints` no longer limit `auto` or any fallback model.

### Added

- A subagent whose tools leave out `read` or `search` gets one read-only tool, `session_history`, after compaction first clears its context, so it can recover what it needs from its own session's history. It reaches no other session, file or project
- A subagent of a session created with the SDK's `intercom` option gets its own Intercom policy: its group is its home and it reaches nothing else. It starts in the session's home group, and a requested `group` (including `true`) is placed under it, as `<home>/<group>` ([#5352](https://github.com/bastani-inc/atomic/issues/5352))

### Changed

- A subagent attempt whose session directory cannot be created now fails that attempt instead of rejecting the launch call
- Agent launches and control calls use shared state-marked blocks. Foreground and background launches show the short task title, elapsed time, token count and live management hint. Completion notices name the agent and show its first result line; expansion shows the prompt, tool calls and full retained result without inherited fork history ([#5224](https://github.com/bastani-inc/atomic/issues/5224))

### Fixed

- Interrupting a subagent from its attached chat updates its call block, panel row and task sheet to stopped, freezes its elapsed time and offers `Stopped · send to resume`. A later completed turn keeps its past-tense end row when the live session is released ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- Fixed Atomic exiting with `child-record-unreadable` ("which is not open in this process") when a workflow stage that had launched a background subagent finished, failed or had its run ended. Closing the stage reads each child's latest record to record it `stage-closed`. That record was read only through the copies of the stage's session registered for it, which are held weakly and which a later copy of the session can replace, and the error escaped from the stage's close listener and ended the process. The stage now also reads its children's records through its own session. When the copy that saved a newer record is gone, the stage ends the child from the record its own session holds, updated with where the child stands as Atomic last saw it. A child that is still running instead ends once its task settles, and a child that was already killed, gone or `stage-closed` is left as it is. A child it can read no record of is counted as a record that could not be saved, and the stage's other children still end. Nothing that goes wrong while a stage closes ends the process or fails the close.
- Fixed a workflow stage that gave up its session while it waited not recording its subagents `stage-closed` when it closed for good, whether it reopened that session first or its run was killed or ended while it was still released. The records were saved through the session it had given up, which refuses them. They are now saved through the stage's newest session, or through its session reopened from the store while the stage holds none.
- Fixed one subagent whose latest record is in a session not open in this process stopping its owner's other subagents from being handled: the session no longer fails to start, its other released subagents are still reserved and woken, `subagents:` sends still reach the rest, and a broker wake for it is reported instead of thrown. Restoring such a subagent reads it from its owner's own session, and neither a wake for results it received while it ran nor clearing results delivered to it leaves an unhandled rejection that would end the process when its owner's session fails to read its record: the failure is reported to the owner.
- The subagent tool, `/agents`, agent management, child restore and worktree subagents no longer pause the interface while they read agent definitions, skills, settings and child artifacts, write and clean up run artifacts, run git for worktrees, or record run history
- Long runs of whitespace in tool output, bash commands, subagent tasks, inherited prompts or npm package specs no longer stall the session for seconds while they are parsed
- Fixed a long-running Atomic session keeping every workflow stage, and every other session, that launched subagents in memory after it ended. Each subagent run kept the session that launched it reachable, with its whole history, extensions and tools, for as long as the process ran, so a workflow of about 60 stages that each delegated to subagents grew the session's process to several gigabytes over a few hours, and the larger the process grew, the slower every new shell and tool process started. A run now keeps only which session launched it, and subagent cards keep only the session store, never the last session that showed them. Atomic also keeps the in-process status of only the 256 most recently finished subagent runs; an older run's children still resume from their saved sessions.
- Fixed launching, inspecting, and restoring subagents failing with `sessionManager.getEntrySeq is not a function` when the host or an SDK `SessionManager` does not implement `getEntrySeq` or `findEntrySeq` ([#5316](https://github.com/bastani-inc/atomic/issues/5316))
- Fixed a background subagent that was slow to start showing only as `running` for many minutes, with no Intercom registration, metrics or output. A child that has not started its first turn now shows where its start is. `subagent status` gives the step and how long it and the start have run, `/tasks` and task heartbeats show the step as its current action, and the launch result and `status` name the child's Intercom target. A start that runs out of its start budget is shown as stalled with that step, retried once, and then fails with both stalls named. The launching session is told. The retry keeps the messages the stalled start had received before its first turn, and the task's cleanup covers the retry's session.
- Fixed a subagent that started while the Intercom broker was briefly unreachable running its turns unregistered, invisible to `intercom list` and unreachable until it next used Intercom itself. Its start now waits in its `registering on Intercom` step and retries until it registers, within its start budget.
- Fixed `contact_supervisor` reaching the wrong session. A background subagent named as its supervisor whichever session in the Atomic process had connected to Intercom last, such as another subagent or a workflow stage hosted in that process, instead of the session that launched it. Its updates and questions went to that session and never reached its parent. A child now names the Intercom id its launching session registered under, or that session's own name until it has one, and a child relaunched after a restart does the same.
- Subagent artifact storage for sessions without a session file is created only when a subagent needs it, not at every session start. On Windows, it waits for its private-directory check, using the native module with an asynchronous PowerShell fallback, without pausing the main thread. A subagent cancelled during that check creates no child storage or supervisor authorization, and a storage failure returns a tool error. Startup artifact cleanup stays single-flight until its asynchronous work finishes, even if the session that started it ends ([#5285](https://github.com/bastani-inc/atomic/issues/5285), [#5324](https://github.com/bastani-inc/atomic/issues/5324))
- A background subagent's final answer stays visible in `/tasks`, its transcript and completion card when saving it fails, even while its session is still shutting down ([#5210](https://github.com/bastani-inc/atomic/issues/5210))
- A subagent launch whose model chain has no credentials now names each skipped model and its provider in the error. A provider that rejects credentials is skipped for the rest of the child's fallback walk ([#5353](https://github.com/bastani-inc/atomic/pull/5353)).
- Fixed a message that reached a subagent as it finished being accepted and then left unanswered, including a steering, follow-up or user message and one an extension sends as the child's last turn settles. The child now answers accepted turn-starting input before it completes, and refuses one that arrives after that with its terminal-child error. A child being released also keeps turn-starting extension messages and background completion notices with steering or follow-up delivery. It saves each card once and delivers its context once on wake, including batches retried after a card write fails or the child's session reopens. Context-excluded extension messages keep their saved cards without reaching the model. Pressing Esc while a resumed subagent replays a message that arrived before it stopped also leaves it waiting for your next message, as Esc does on any other turn; it answers that message, then continues with the task it was resumed with. A resumed subagent no longer fails with `Agent is already processing` when an extension's interrupting message is still being answered as its task is sent; it answers both ([#5318](https://github.com/bastani-inc/atomic/issues/5318))
- A subagent's pending question marks its task as needing input and can be answered in its own task transcript. Leaving that view keeps its form state; Escape in the form cancels it. Questions no longer appear in, block, or take answers from the main chat or sibling sessions ([#5354](https://github.com/bastani-inc/atomic/pull/5354))
- Fixed long malformed progress or output instructions in a subagent task freezing its live or restored tool block while Atomic formats the prompt ([#5239](https://github.com/bastani-inc/atomic/pull/5239))
- An open subagent chat no longer reads every entry of the session that launched it on each frame to tell whether the subagent is stopped or read-only.

## [0.9.88] - 2026-11-16

### Added

- Single and parallel `subagent` calls, and each parallel task, accept `worktree: { branch, base?, path? }`: before the child starts, the branch is checked out in a worktree at `path` (default `.atomic/worktrees/<branch>`), created from `base` (default the upstream, or `HEAD`) or reused when that branch is already checked out there. The call is refused before launch when the branch is checked out elsewhere or the path holds something else. Unlike `worktree: true`, a named worktree and its branch are never removed; it is recorded with the child, so the restore notice names it and resume continues in it ([#5202](https://github.com/bastani-inc/atomic/issues/5202))

### Changed

- Resuming a subagent whose session was compacted reads its session from the latest compaction instead of its whole history; its task transcript reads the earlier entries when opened ([#5249](https://github.com/bastani-inc/atomic/issues/5249))
- A subagent's call heading is one line, `Agent(<name> · <first line of its task>)`, and its block in the chat is shorter. While it runs: its last three tool calls, with older ones folded into `… +N tool uses`, and `Running · <time> · ↓ <tokens>`. Once settled: one line with its outcome and time, the result's first line, and the expand key for the prompt, tool calls and full result ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- The bundled `worker`, `debugger` and `code-simplifier` agents no longer stop partway through a task because their conversation grew long, reporting it as completed and suggesting a fresh run. Atomic compacts long conversations automatically, so they keep working until the task is done, and `worker` and `debugger` ask their supervisor when only its decision blocks them.
- A launch whose `cwd` does not exist is refused before any child starts, and the error says the directory may still be being created by a parallel tool call in the same turn: launch after that call returns, or use `worktree: { branch, base?, path? }` ([#5202](https://github.com/bastani-inc/atomic/issues/5202))
- Interrupting a background subagent's turn from its chat (Esc) leaves it running in the same session, waiting for your next message, instead of ending it ([#5224](https://github.com/bastani-inc/atomic/issues/5224))

### Fixed

- Fixed concurrent launches of one named worktree failing with a raw git error on Windows, refusing a worktree another launch is still creating, or deleting its checkout directory ([#5202](https://github.com/bastani-inc/atomic/issues/5202)). Creation locks apply per target path and branch, so slow checkouts do not block launches on other branches or paths, and reusing an existing or user-locked worktree does not wait on unrelated checkouts. Concurrent launches for the same target wait for the checkout to finish and reuse it without blocking the session's event loop. Waiting launches show progress and can be cancelled, cancellation or host exit stops the active checkout and its attached hooks, and incomplete checkouts or pending reference updates left by an interrupted add are refused immediately with unlock, removal, prune and stale-lock recovery guidance instead of being reused empty. Recovery never attributes an external checkout to Atomic's failed add, and external adds are waited for across Git's translated initialization markers. A checkout hook that synchronously creates another named worktree for the same branch or path is refused immediately with `WorktreeReentryError` while unrelated targets in the same repository succeed, and permanent Git and filesystem errors fail promptly across locales while preserving the caller's `LANG` and `LC_ALL` for hooks and filters. A background hook can launch the same target once the original checkout releases its locks. New branch start points, including `HEAD` and `:/message` searches, resolve in the caller's worktree, and checkout locks follow Git-created directory sharing permissions.
- Fixed a resumed subagent dropping its task without answering it when a turn ended before the task was sent, such as one an extension's interrupting message started while the resume was delivering held messages, or a chat message after Esc during its replay of an interrupted delivery. The child keeps accepting messages until it has its task, answers it, and completes once every message it accepted is answered. A finished subagent's chat that already resumed its child once also stays writable after a reload, and resumes the child again ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed an interrupted subagent staying running after its own background work wakes it and it replies, including a wake that finishes before the interrupted turn returns. Pressing Esc as a turn starts, including while a message is preparing it, also leaves the child waiting for its next message. The task waits for any messages accepted while a later turn settles to be answered, then completes and delivers its result. Finished subagent chats can also resume their child with the default isolated engine, and keep reaching it across later resumes and workflow-stage extension reloads ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed an interrupted subagent becoming unreachable, or aborting an unrelated later turn, when a message could not be saved before its turn started. Fixing the storage problem and sending another message now lets it continue, and a newer interrupting message is no longer aborted in place of the interrupted turn. Interrupting a resumed child's replay of an interrupted delivery also leaves it available for the next message. A failed JSONL artifact write no longer prevents the child from completing ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed an interrupted subagent ignoring Intercom interrupt messages and batches of messages from extensions. An extension's interrupting message now completes the task when answered, or leaves the child waiting if that turn is interrupted again ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed restoring a stage's background subagent after its workflow run resumed sometimes failing with `child-record-unreadable` ("which is not open in this process"), though the resumed stage had the subagent's session open ([#5252](https://github.com/bastani-inc/atomic/issues/5252)). The record was read only through the copy of the session that saved it. Once that copy was garbage-collected, a copy opened later was never used. Every open copy of the session can now read it.
- Fixed a subagent whose final answer its session could not save, for example on a full disk, being reported as completed with no result ([#5210](https://github.com/bastani-inc/atomic/issues/5210)). It now fails with a cause that names the storage error. Its completion card, `/tasks` output and transcript, and its parent's result still show the answer it gave. Resuming it continues after that answer, which its session then holds once.
- Fixed a long supervising session slowing down until new subagents failed to start with `session-start-timeout` in phase `setup` ([#5186](https://github.com/bastani-inc/atomic/issues/5186)). The cost of a session now follows the subagents running in it, not every one it ever launched:
  - A finished subagent no longer keeps its whole history in memory, or the text of every skill file it loaded. `/tasks`, its transcript, its completion card and `resume` read its history back from its session file when they need it. Reading it never writes: if the file was moved or deleted, `/tasks` and the completion card still show its prompt and answer, its transcript says the history is unavailable, and `resume` reports the missing file.
  - A finished subagent no longer leaves a 10-minute timer behind. The startup cleanup scans now run once per Atomic process, not once per subagent.
  - A finished subagent's output is no longer kept by its run after it has been delivered. Its result stays on disk with the run's artifacts.
  - Looking up a subagent by id no longer lists every run's children, and reading a task's record no longer copies the record of every task the session keeps.
  With 500 subagents launched in batches of 12 (a scripted model, each subagent reading a 64 KiB file twice), the session's heap grew 59 MB between 48 and 500 finished subagents before the fix and 9 MB after it. A new subagent took 2.6 s to start with 500 finished, against 0.44 s with 48, before the fix, and 0.62 s against 0.32 s after it.
- Subagent artifacts written outside a session now use a directory only the current user owns
- Fixed tool results a wake or a resume brings a released subagent being lost or delivered twice ([#5012](https://github.com/bastani-inc/atomic/issues/5012)). Pausing or quitting it before it saved them no longer deletes them: only the results it saved are cleared, and the rest are handed over once when it resumes, also when they came batched with a `resume`. Results it saved before Atomic closed, or before its run failed, are reported as saved as soon as they are written and are no longer given to it again, as "late" results, when it is restored or woken.
- Fixed a detached call that a wake answered "still running" being forgotten across an Atomic restart ([#5014](https://github.com/bastani-inc/atomic/issues/5014)). The subagent's record now keeps such calls, across later runs and releases, until the result arrives; after a restart the subagent is told once that the call was interrupted, whether the restart came before or after it saved the wake's results, and a subagent that had already finished is woken to hear it.
- Fixed a parallel `worktree: true` task whose change was larger than 1 MiB being reported as having no changes and its worktree, with all its work, being deleted. Git now writes each task's patch straight to its file, so a change of any size is saved in full and the summary lists every task. When a diff cannot be captured, the worktree is kept and the summary names it, and it is removed only once a later capture succeeds. A `.worktreeinclude` file such as `.env` is also copied into a new worktree again in a repository with an installed `node_modules`, where it was silently skipped; when git cannot list those files, the worktree is still created and the summary warns, naming the worktree and git's reason ([#4876](https://github.com/bastani-inc/atomic/issues/4876))
- Fixed pausing or quitting a released subagent racing with its wake: a wake that has not started the subagent again yet now keeps its results for resume instead of running it, and pause or quit stops a run the wake already started. Before, pause or quit reported success while the subagent ran again ([#4845](https://github.com/bastani-inc/atomic/issues/4845))
- Fixed `pause` and `quit` with `all: true` overwriting a subagent's record with an old copy, which showed a running subagent as paused or lost a tool result held for its resume ([#4845](https://github.com/bastani-inc/atomic/issues/4845))
- Fixed a subagent that was released, woken, and then paused while waiting on nothing still showing the calls it waited on before it was woken. Sends to it were held with no answer instead of being told it is stopped and how to resume it ([#4845](https://github.com/bastani-inc/atomic/issues/4845))
- Fixed worktree cleanup leaving a setup hook's synthetic link whose name starts with two dots (for example `..cache`) in place before removing the worktree. On older Git for Windows, removal could then delete the main checkout's copy through the link ([#4836](https://github.com/bastani-inc/atomic/issues/4836))
- Fixed a released subagent being told a detached tool call (such as a long `bash`) was "still running" after Atomic restarted, though the call died with the old process and its result never arrived: when a reply, deadline or resume wakes the subagent, that call is now reported interrupted so it can re-run it. An extension `/reload` in the same process is not a restart: a call still running then is neither reported interrupted nor started again ([#4848](https://github.com/bastani-inc/atomic/issues/4848))
- Fixed a subagent launched with `heartbeatMs` (including `0`, which disables heartbeats) falling back to the 15-minute default after a wake, resume or restore: the cadence is now recorded with the subagent and applied on every relaunch ([#4856](https://github.com/bastani-inc/atomic/issues/4856))
- Fixed truncated subagent output, partial findings after a cancellation, and the inline output preview splitting an emoji or other multibyte character at the cut, which showed up as `�` or a raw `\ud83d` escape; truncation now always ends on a whole character. The truncation note also reports the true number of lines shown instead of "1" when none are ([#4938](https://github.com/bastani-inc/atomic/issues/4938))
- Fixed a woken or resumed released subagent ignoring its run's concurrency limit: it now waits for a slot in its run, through a sibling's scheduler when one still runs or a limiter rebuilt from the run's recorded limit when none does, without keeping a scheduler per released subagent. While it waits for its run, it does not hold one of the `parallel.runningCapacity` wake slots, so released subagents of other runs still wake at once ([#4856](https://github.com/bastani-inc/atomic/issues/4856))
- Fixed parallel subagent tasks with `progress` enabled writing `progress.md` into the project directory, which overwrote a project's own `progress.md`: the run's shared progress file now lives in run-scoped artifact storage, like single-agent progress ([#4976](https://github.com/bastani-inc/atomic/issues/4976))
- Fixed a foreground subagent's result sometimes reaching the orchestrator twice, once as the tool result and again as an Intercom message, when Intercom took longer than 500 ms to deliver it or could not confirm delivery. Each result now arrives exactly once: if Intercom has not started delivering it in time, the tool result carries it and the Intercom delivery is cancelled; once Intercom is delivering it, the tool result is a short receipt, which says so when delivery could not be confirmed and points to the output artifacts and sessions ([#5018](https://github.com/bastani-inc/atomic/issues/5018))
- Fixed a background subagent released while it waited on a long tool call, such as a `bash` wait without `budgetMs`, being reported to its parent as paused and awaiting resume. Its notice now says it was released while waiting on that call and wakes by itself when the call finishes, with no resume instruction; `/tasks` and the subagent tool show it as released. A subagent you pause or quit is still reported as paused ([#5031](https://github.com/bastani-inc/atomic/issues/5031))
- Fixed a message addressed to a restored subagent by its Intercom id from before the restart going out unchecked when another subagent was still being restored: the id is now recognized as soon as that subagent's own session reopens, so the sender is told it is still being restored, has not reconnected, or is gone ([#5097](https://github.com/bastani-inc/atomic/issues/5097))
- Fixed subagent task summaries, tool-call and argument previews, error details and run history cutting an emoji or other character outside the Basic Multilingual Plane in half, which showed up as `�` or a raw `\ud83d` escape ([#5097](https://github.com/bastani-inc/atomic/issues/5097))
- Fixed a builtin agent with a `thinking` override (for example `agentOverrides.worker.thinking`) ignoring a call's `modelConstraints.allowedProviders` or `excludedProviders` in favour of your `modelRouting` provider settings. The launch could fail with "Auto routing has no eligible model/effort pairs", or model fallback could pick from the settings' providers instead of the call's. The call's provider lists now apply to builtin agents just as they do to your own agents ([#5046](https://github.com/bastani-inc/atomic/issues/5046))
- Fixed a subagent launch failing when it named its model in a different letter case, such as `Anthropic/claude-opus-4-8`, even though the same name works in `fallbackModels` and `--model`. Subagent model names now resolve the same way as those ([#5046](https://github.com/bastani-inc/atomic/issues/5046))
- Fixed pausing or quitting a `worktree: true` subagent at the moment it finished on its own leaving its worktree on disk as if it were paused. Its edits are now saved as a patch and its worktree removed, as for any finished subagent ([#5172](https://github.com/bastani-inc/atomic/issues/5172))

## [0.9.88-alpha.1] - 2026-11-16

### Added

- Single and parallel `subagent` calls, and each parallel task, accept `worktree: { branch, base?, path? }`: before the child starts, the branch is checked out in a worktree at `path` (default `.atomic/worktrees/<branch>`), created from `base` (default the upstream, or `HEAD`) or reused when that branch is already checked out there. The call is refused before launch when the branch is checked out elsewhere or the path holds something else. Unlike `worktree: true`, a named worktree and its branch are never removed; it is recorded with the child, so the restore notice names it and resume continues in it ([#5202](https://github.com/bastani-inc/atomic/issues/5202))

### Changed

- Resuming a subagent whose session was compacted reads its session from the latest compaction instead of its whole history; its task transcript reads the earlier entries when opened ([#5249](https://github.com/bastani-inc/atomic/issues/5249))
- A subagent's call heading is one line, `Agent(<name> · <first line of its task>)`, and its block in the chat is shorter. While it runs: its last three tool calls, with older ones folded into `… +N tool uses`, and `Running · <time> · ↓ <tokens>`. Once settled: one line with its outcome and time, the result's first line, and the expand key for the prompt, tool calls and full result ([#5224](https://github.com/bastani-inc/atomic/issues/5224))
- The bundled `worker`, `debugger` and `code-simplifier` agents no longer stop partway through a task because their conversation grew long, reporting it as completed and suggesting a fresh run. Atomic compacts long conversations automatically, so they keep working until the task is done, and `worker` and `debugger` ask their supervisor when only its decision blocks them.
- A launch whose `cwd` does not exist is refused before any child starts, and the error says the directory may still be being created by a parallel tool call in the same turn: launch after that call returns, or use `worktree: { branch, base?, path? }` ([#5202](https://github.com/bastani-inc/atomic/issues/5202))
- Interrupting a background subagent's turn from its chat (Esc) leaves it running in the same session, waiting for your next message, instead of ending it ([#5224](https://github.com/bastani-inc/atomic/issues/5224))

### Fixed

- Fixed concurrent launches of one named worktree failing with a raw git error on Windows, refusing a worktree another launch is still creating, or deleting its checkout directory ([#5202](https://github.com/bastani-inc/atomic/issues/5202)). Creation locks apply per target path and branch, so slow checkouts do not block launches on other branches or paths, and reusing an existing or user-locked worktree does not wait on unrelated checkouts. Concurrent launches for the same target wait for the checkout to finish and reuse it without blocking the session's event loop. Waiting launches show progress and can be cancelled, cancellation or host exit stops the active checkout and its attached hooks, and incomplete checkouts or pending reference updates left by an interrupted add are refused immediately with unlock, removal, prune and stale-lock recovery guidance instead of being reused empty. Recovery never attributes an external checkout to Atomic's failed add, and external adds are waited for across Git's translated initialization markers. A checkout hook that synchronously creates another named worktree for the same branch or path is refused immediately with `WorktreeReentryError` while unrelated targets in the same repository succeed, and permanent Git and filesystem errors fail promptly across locales while preserving the caller's `LANG` and `LC_ALL` for hooks and filters. A background hook can launch the same target once the original checkout releases its locks. New branch start points, including `HEAD` and `:/message` searches, resolve in the caller's worktree, and checkout locks follow Git-created directory sharing permissions.
- Fixed a resumed subagent dropping its task without answering it when a turn ended before the task was sent, such as one an extension's interrupting message started while the resume was delivering held messages, or a chat message after Esc during its replay of an interrupted delivery. The child keeps accepting messages until it has its task, answers it, and completes once every message it accepted is answered. A finished subagent's chat that already resumed its child once also stays writable after a reload, and resumes the child again ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed an interrupted subagent staying running after its own background work wakes it and it replies, including a wake that finishes before the interrupted turn returns. Pressing Esc as a turn starts, including while a message is preparing it, also leaves the child waiting for its next message. The task waits for any messages accepted while a later turn settles to be answered, then completes and delivers its result. Finished subagent chats can also resume their child with the default isolated engine, and keep reaching it across later resumes and workflow-stage extension reloads ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed an interrupted subagent becoming unreachable, or aborting an unrelated later turn, when a message could not be saved before its turn started. Fixing the storage problem and sending another message now lets it continue, and a newer interrupting message is no longer aborted in place of the interrupted turn. Interrupting a resumed child's replay of an interrupted delivery also leaves it available for the next message. A failed JSONL artifact write no longer prevents the child from completing ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed an interrupted subagent ignoring Intercom interrupt messages and batches of messages from extensions. An extension's interrupting message now completes the task when answered, or leaves the child waiting if that turn is interrupted again ([#5224](https://github.com/bastani-inc/atomic/issues/5224)).
- Fixed restoring a stage's background subagent after its workflow run resumed sometimes failing with `child-record-unreadable` ("which is not open in this process"), though the resumed stage had the subagent's session open ([#5252](https://github.com/bastani-inc/atomic/issues/5252)). The record was read only through the copy of the session that saved it. Once that copy was garbage-collected, a copy opened later was never used. Every open copy of the session can now read it.
- Fixed a subagent whose final answer its session could not save, for example on a full disk, being reported as completed with no result ([#5210](https://github.com/bastani-inc/atomic/issues/5210)). It now fails with a cause that names the storage error. Its completion card, `/tasks` output and transcript, and its parent's result still show the answer it gave. Resuming it continues after that answer, which its session then holds once.
- Fixed a long supervising session slowing down until new subagents failed to start with `session-start-timeout` in phase `setup` ([#5186](https://github.com/bastani-inc/atomic/issues/5186)). The cost of a session now follows the subagents running in it, not every one it ever launched:
  - A finished subagent no longer keeps its whole history in memory, or the text of every skill file it loaded. `/tasks`, its transcript, its completion card and `resume` read its history back from its session file when they need it. Reading it never writes: if the file was moved or deleted, `/tasks` and the completion card still show its prompt and answer, its transcript says the history is unavailable, and `resume` reports the missing file.
  - A finished subagent no longer leaves a 10-minute timer behind. The startup cleanup scans now run once per Atomic process, not once per subagent.
  - A finished subagent's output is no longer kept by its run after it has been delivered. Its result stays on disk with the run's artifacts.
  - Looking up a subagent by id no longer lists every run's children, and reading a task's record no longer copies the record of every task the session keeps.
  With 500 subagents launched in batches of 12 (a scripted model, each subagent reading a 64 KiB file twice), the session's heap grew 59 MB between 48 and 500 finished subagents before the fix and 9 MB after it. A new subagent took 2.6 s to start with 500 finished, against 0.44 s with 48, before the fix, and 0.62 s against 0.32 s after it.
- Subagent artifacts written outside a session now use a directory only the current user owns
- Fixed tool results a wake or a resume brings a released subagent being lost or delivered twice ([#5012](https://github.com/bastani-inc/atomic/issues/5012)). Pausing or quitting it before it saved them no longer deletes them: only the results it saved are cleared, and the rest are handed over once when it resumes, also when they came batched with a `resume`. Results it saved before Atomic closed, or before its run failed, are reported as saved as soon as they are written and are no longer given to it again, as "late" results, when it is restored or woken.
- Fixed a detached call that a wake answered "still running" being forgotten across an Atomic restart ([#5014](https://github.com/bastani-inc/atomic/issues/5014)). The subagent's record now keeps such calls, across later runs and releases, until the result arrives; after a restart the subagent is told once that the call was interrupted, whether the restart came before or after it saved the wake's results, and a subagent that had already finished is woken to hear it.
- Fixed a parallel `worktree: true` task whose change was larger than 1 MiB being reported as having no changes and its worktree, with all its work, being deleted. Git now writes each task's patch straight to its file, so a change of any size is saved in full and the summary lists every task. When a diff cannot be captured, the worktree is kept and the summary names it, and it is removed only once a later capture succeeds. A `.worktreeinclude` file such as `.env` is also copied into a new worktree again in a repository with an installed `node_modules`, where it was silently skipped; when git cannot list those files, the worktree is still created and the summary warns, naming the worktree and git's reason ([#4876](https://github.com/bastani-inc/atomic/issues/4876))
- Fixed pausing or quitting a released subagent racing with its wake: a wake that has not started the subagent again yet now keeps its results for resume instead of running it, and pause or quit stops a run the wake already started. Before, pause or quit reported success while the subagent ran again ([#4845](https://github.com/bastani-inc/atomic/issues/4845))
- Fixed `pause` and `quit` with `all: true` overwriting a subagent's record with an old copy, which showed a running subagent as paused or lost a tool result held for its resume ([#4845](https://github.com/bastani-inc/atomic/issues/4845))
- Fixed a subagent that was released, woken, and then paused while waiting on nothing still showing the calls it waited on before it was woken. Sends to it were held with no answer instead of being told it is stopped and how to resume it ([#4845](https://github.com/bastani-inc/atomic/issues/4845))
- Fixed worktree cleanup leaving a setup hook's synthetic link whose name starts with two dots (for example `..cache`) in place before removing the worktree. On older Git for Windows, removal could then delete the main checkout's copy through the link ([#4836](https://github.com/bastani-inc/atomic/issues/4836))
- Fixed a released subagent being told a detached tool call (such as a long `bash`) was "still running" after Atomic restarted, though the call died with the old process and its result never arrived: when a reply, deadline or resume wakes the subagent, that call is now reported interrupted so it can re-run it. An extension `/reload` in the same process is not a restart: a call still running then is neither reported interrupted nor started again ([#4848](https://github.com/bastani-inc/atomic/issues/4848))
- Fixed a subagent launched with `heartbeatMs` (including `0`, which disables heartbeats) falling back to the 15-minute default after a wake, resume or restore: the cadence is now recorded with the subagent and applied on every relaunch ([#4856](https://github.com/bastani-inc/atomic/issues/4856))
- Fixed truncated subagent output, partial findings after a cancellation, and the inline output preview splitting an emoji or other multibyte character at the cut, which showed up as `�` or a raw `\ud83d` escape; truncation now always ends on a whole character. The truncation note also reports the true number of lines shown instead of "1" when none are ([#4938](https://github.com/bastani-inc/atomic/issues/4938))
- Fixed a woken or resumed released subagent ignoring its run's concurrency limit: it now waits for a slot in its run, through a sibling's scheduler when one still runs or a limiter rebuilt from the run's recorded limit when none does, without keeping a scheduler per released subagent. While it waits for its run, it does not hold one of the `parallel.runningCapacity` wake slots, so released subagents of other runs still wake at once ([#4856](https://github.com/bastani-inc/atomic/issues/4856))
- Fixed parallel subagent tasks with `progress` enabled writing `progress.md` into the project directory, which overwrote a project's own `progress.md`: the run's shared progress file now lives in run-scoped artifact storage, like single-agent progress ([#4976](https://github.com/bastani-inc/atomic/issues/4976))
- Fixed a foreground subagent's result sometimes reaching the orchestrator twice, once as the tool result and again as an Intercom message, when Intercom took longer than 500 ms to deliver it or could not confirm delivery. Each result now arrives exactly once: if Intercom has not started delivering it in time, the tool result carries it and the Intercom delivery is cancelled; once Intercom is delivering it, the tool result is a short receipt, which says so when delivery could not be confirmed and points to the output artifacts and sessions ([#5018](https://github.com/bastani-inc/atomic/issues/5018))
- Fixed a background subagent released while it waited on a long tool call, such as a `bash` wait without `budgetMs`, being reported to its parent as paused and awaiting resume. Its notice now says it was released while waiting on that call and wakes by itself when the call finishes, with no resume instruction; `/tasks` and the subagent tool show it as released. A subagent you pause or quit is still reported as paused ([#5031](https://github.com/bastani-inc/atomic/issues/5031))
- Fixed a message addressed to a restored subagent by its Intercom id from before the restart going out unchecked when another subagent was still being restored: the id is now recognized as soon as that subagent's own session reopens, so the sender is told it is still being restored, has not reconnected, or is gone ([#5097](https://github.com/bastani-inc/atomic/issues/5097))
- Fixed subagent task summaries, tool-call and argument previews, error details and run history cutting an emoji or other character outside the Basic Multilingual Plane in half, which showed up as `�` or a raw `\ud83d` escape ([#5097](https://github.com/bastani-inc/atomic/issues/5097))
- Fixed a builtin agent with a `thinking` override (for example `agentOverrides.worker.thinking`) ignoring a call's `modelConstraints.allowedProviders` or `excludedProviders` in favour of your `modelRouting` provider settings. The launch could fail with "Auto routing has no eligible model/effort pairs", or model fallback could pick from the settings' providers instead of the call's. The call's provider lists now apply to builtin agents just as they do to your own agents ([#5046](https://github.com/bastani-inc/atomic/issues/5046))
- Fixed a subagent launch failing when it named its model in a different letter case, such as `Anthropic/claude-opus-4-8`, even though the same name works in `fallbackModels` and `--model`. Subagent model names now resolve the same way as those ([#5046](https://github.com/bastani-inc/atomic/issues/5046))
- Fixed pausing or quitting a `worktree: true` subagent at the moment it finished on its own leaving its worktree on disk as if it were paused. Its edits are now saved as a patch and its worktree removed, as for any finished subagent ([#5172](https://github.com/bastani-inc/atomic/issues/5172))

## [0.9.86] - 2026-11-14

Subagents are easier to reach and to talk to.

- **Message all your subagents at once.** The Intercom `subagents:*` and `subagents:<runId>/*` targets reach every running, released or paused subagent this session launched ([#4752](https://github.com/bastani-inc/atomic/issues/4752), [#4756](https://github.com/bastani-inc/atomic/pull/4756)).
- **Asks no longer block.** Subagents know an Intercom `ask` returns at delivery and its reply arrives later as a message ([#4751](https://github.com/bastani-inc/atomic/issues/4751), [#4758](https://github.com/bastani-inc/atomic/pull/4758)).
- **Autocomplete in subagent chats.** A subagent's chat completes `/tasks`, its own `/skill:` commands and `@` and Tab paths, even after it finished ([#4755](https://github.com/bastani-inc/atomic/issues/4755), [#4757](https://github.com/bastani-inc/atomic/pull/4757)).

### Added

- Added Intercom `subagents:*` and `subagents:<runId>/*` send targets, which message every running, released or paused subagent this session launched, or those of one run, in one call ([#4752](https://github.com/bastani-inc/atomic/issues/4752))

### Changed

- Subagents are told that an Intercom `ask` to a peer or the supervisor no longer blocks: its reply arrives later as a message ([#4751](https://github.com/bastani-inc/atomic/issues/4751))

### Fixed

- Fixed a subagent's chat having no autocomplete: it now completes `/tasks`, the subagent's own `/skill:` commands and `@` and Tab paths in the subagent's working directory, including after the subagent finished ([#4755](https://github.com/bastani-inc/atomic/issues/4755))

## [0.9.86-alpha.1] - 2026-11-14

Subagents are easier to reach and to talk to.

- **Message all your subagents at once.** The Intercom `subagents:*` and `subagents:<runId>/*` targets reach every running, released or paused subagent this session launched ([#4752](https://github.com/bastani-inc/atomic/issues/4752), [#4756](https://github.com/bastani-inc/atomic/pull/4756)).
- **Asks no longer block.** Subagents know an Intercom `ask` returns at delivery and its reply arrives later as a message ([#4751](https://github.com/bastani-inc/atomic/issues/4751), [#4758](https://github.com/bastani-inc/atomic/pull/4758)).
- **Autocomplete in subagent chats.** A subagent's chat completes `/tasks`, its own `/skill:` commands and `@` and Tab paths, even after it finished ([#4755](https://github.com/bastani-inc/atomic/issues/4755), [#4757](https://github.com/bastani-inc/atomic/pull/4757)).

### Added

- Added Intercom `subagents:*` and `subagents:<runId>/*` send targets, which message every running, released or paused subagent this session launched, or those of one run, in one call ([#4752](https://github.com/bastani-inc/atomic/issues/4752))

### Changed

- Subagents are told that an Intercom `ask` to a peer or the supervisor no longer blocks: its reply arrives later as a message ([#4751](https://github.com/bastani-inc/atomic/issues/4751))

### Fixed

- Fixed a subagent's chat having no autocomplete: it now completes `/tasks`, the subagent's own `/skill:` commands and `@` and Tab paths in the subagent's working directory, including after the subagent finished ([#4755](https://github.com/bastani-inc/atomic/issues/4755))

## [0.9.81] - 2026-11-13

Parallel subagent calls survive a single child's failure, and the desktop skill learns sandboxes.

- **Partial results from parallel calls.** A child that fails to start is reported on its own row while the others finish, and the card header counts each outcome ([#4697](https://github.com/bastani-inc/atomic/issues/4697), [#4698](https://github.com/bastani-inc/atomic/pull/4698)).
- **Desktop sandboxes on request.** The bundled agent-desktop skill can set up and drive macOS VM sandboxes on Apple Silicon, only when you ask for one ([#4699](https://github.com/bastani-inc/atomic/pull/4699)).

### Changed

- Updated the bundled agent-desktop skill to upstream `v1.3.0`. It adds a Sandboxes section for the new `agent-desktop sandbox` command: on an Apple Silicon Mac running macOS 13 or later it can install the macOS VM provider, create, start, stop and remove sandboxes, and run commands in the guest, and it explains each sandbox state and what to do next. It also notes that a sandbox isolates the desktop but not the network or the host. The agent installs the sandbox provider or creates a sandbox only when you ask for one, since that builds a local VM host and can download a multi-gigabyte macOS image. Install guidance, the readiness check and permission handling are unchanged.

### Fixed

- Fixed one child's setup failure, such as `Supervisor authorization timeout`, turning a whole parallel subagent call into a single error: that child is now reported as not started with its error, the other children run to completion and report their own results, and the call fails only when no child started. The parallel card keeps a row per child, shows each failed child's error on one line (in full when expanded), and its header counts the outcomes, for example `subagent parallel (5) · 4 done · 1 failed` ([#4697](https://github.com/bastani-inc/atomic/issues/4697))

## [0.9.81-alpha.1] - 2026-11-13

### Changed

- Updated the bundled agent-desktop skill to upstream `v1.3.0`. It adds a Sandboxes section for the new `agent-desktop sandbox` command: on an Apple Silicon Mac running macOS 13 or later it can install the macOS VM provider, create, start, stop and remove sandboxes, and run commands in the guest, and it explains each sandbox state and what to do next. It also notes that a sandbox isolates the desktop but not the network or the host. The agent installs the sandbox provider or creates a sandbox only when you ask for one, since that builds a local VM host and can download a multi-gigabyte macOS image. Install guidance, the readiness check and permission handling are unchanged.

### Fixed

- Fixed one child's setup failure, such as `Supervisor authorization timeout`, turning a whole parallel subagent call into a single error: that child is now reported as not started with its error, the other children run to completion and report their own results, and the call fails only when no child started. The parallel card keeps a row per child, shows each failed child's error on one line (in full when expanded), and its header counts the outcomes, for example `subagent parallel (5) · 4 done · 1 failed` ([#4697](https://github.com/bastani-inc/atomic/issues/4697))

## [0.9.79] - 2026-11-12

Background subagents survive a reboot, and one that cannot be restored comes with a ready relaunch call.

- **Reboot-safe background subagents.** Child sessions now live under the agent directory instead of the system temporary directory, and one failed restore no longer hides the notices for the others ([#4660](https://github.com/bastani-inc/atomic/issues/4660), [#4664](https://github.com/bastani-inc/atomic/pull/4664)).
- **Actionable restore notices.** A subagent that could not be restored is reported with its agent, task, ids, working directory, worktree, session and a ready `subagent` call to relaunch it ([#4660](https://github.com/bastani-inc/atomic/issues/4660), [#4664](https://github.com/bastani-inc/atomic/pull/4664)).

### Fixed

- Fixed background subagents being lost when a machine rebooted before their parent session was resumed: a parent on the default SQLite session store kept its children's sessions in the system temporary directory, which a reboot clears. They now live under the agent directory (`subagent-sessions/<parent session id>`), and a recorded session file that is gone is reported by its path instead of as a session-store loss ([#4660](https://github.com/bastani-inc/atomic/issues/4660))
- Fixed one background subagent whose restoration failed unexpectedly after a restart hiding the notices for every other subagent: each child is now reported on its own, and a child that failed this way is retried on the next resume instead of being recorded as gone ([#4660](https://github.com/bastani-inc/atomic/issues/4660))
- Fixed the notice for a subagent that could not be restored after a restart saying only to launch a fresh one: it now gives the agent, its task, run and child ids, working directory, worktree and branch, session, a ready `subagent` call to relaunch it in its worktree when its task was recorded (otherwise where to find the launching call), and how to inspect what it left behind ([#4660](https://github.com/bastani-inc/atomic/issues/4660))

## [0.9.79-alpha.1] - 2026-11-11

### Fixed

- Fixed background subagents being lost when a machine rebooted before their parent session was resumed: a parent on the default SQLite session store kept its children's sessions in the system temporary directory, which a reboot clears. They now live under the agent directory (`subagent-sessions/<parent session id>`), and a recorded session file that is gone is reported by its path instead of as a session-store loss ([#4660](https://github.com/bastani-inc/atomic/issues/4660))
- Fixed one background subagent whose restoration failed unexpectedly after a restart hiding the notices for every other subagent: each child is now reported on its own, and a child that failed this way is retried on the next resume instead of being recorded as gone ([#4660](https://github.com/bastani-inc/atomic/issues/4660))
- Fixed the notice for a subagent that could not be restored after a restart saying only to launch a fresh one: it now gives the agent, its task, run and child ids, working directory, worktree and branch, session, a ready `subagent` call to relaunch it in its worktree when its task was recorded (otherwise where to find the launching call), and how to inspect what it left behind ([#4660](https://github.com/bastani-inc/atomic/issues/4660))

## [0.9.77] - 2026-11-11

Delegation guidance uses session memory, and messages to ended subagents say how to continue them.

- **Memory-informed delegation.** Orchestration guidance weighs earlier sessions, workflow runs and your stated preferences when choosing between a workflow and inline work ([#4648](https://github.com/bastani-inc/atomic/issues/4648), [#4649](https://github.com/bastani-inc/atomic/pull/4649)).
- **Resumable ended subagents.** An Intercom send to a subagent that finished, failed or was stopped explains how it ended and which `subagent({ action: "resume" })` call continues it ([#4639](https://github.com/bastani-inc/atomic/issues/4639), [#4650](https://github.com/bastani-inc/atomic/pull/4650)).

### Changed

- The subagent orchestration guidance now refines the choice between a workflow and inline work with session memory (`history://` sessions and workflow runs) and your stated preferences ([#4648](https://github.com/bastani-inc/atomic/issues/4648))

### Fixed

- Fixed Intercom sends to a subagent that completed, failed, was stopped or was cancelled answering `Session not found`: the session that launched it now reports how it ended, so the sender is told why and which `subagent({ action: "resume", id, message })` call continues it ([#4639](https://github.com/bastani-inc/atomic/issues/4639))

## [0.9.77-alpha.1] - 2026-11-11

Delegation guidance uses session memory, and messages to ended subagents say how to continue them.

- **Memory-informed delegation.** Orchestration guidance weighs earlier sessions, workflow runs and your stated preferences when choosing between a workflow and inline work ([#4648](https://github.com/bastani-inc/atomic/issues/4648), [#4649](https://github.com/bastani-inc/atomic/pull/4649)).
- **Resumable ended subagents.** An Intercom send to a subagent that finished, failed or was stopped explains how it ended and which `subagent({ action: "resume" })` call continues it ([#4639](https://github.com/bastani-inc/atomic/issues/4639), [#4650](https://github.com/bastani-inc/atomic/pull/4650)).

### Changed

- The subagent orchestration guidance now refines the choice between a workflow and inline work with session memory (`history://` sessions and workflow runs) and your stated preferences ([#4648](https://github.com/bastani-inc/atomic/issues/4648))

### Fixed

- Fixed Intercom sends to a subagent that completed, failed, was stopped or was cancelled answering `Session not found`: the session that launched it now reports how it ended, so the sender is told why and which `subagent({ action: "resume", id, message })` call continues it ([#4639](https://github.com/bastani-inc/atomic/issues/4639))

## [0.9.75] - 2026-11-10

Woken subagents build blueprints, and the bundled computer-use skills are current.

- **Blueprints on wake.** A released subagent woken on another machine builds the blueprints of the worktrees it restores, and a missing or failing blueprint never stops the wake ([#4588](https://github.com/bastani-inc/atomic/issues/4588)).
- **Current browser and desktop skills.** agent-browser `v0.41.2` lists the new `webmcp-gen` skill and drops the unpinned `npx` grant; agent-desktop `v1.2.0` explains how to pick the right row among repeated elements and how stale or ambiguous refs are reported.

### Changed

- Updated the bundled agent-browser skill to upstream `v0.41.2`. Its discovery stub now explains that the core guide ends with a table of references and that `agent-browser skills get core --full` is only for when you need every reference at once, lists the new `webmcp-gen` specialized skill, and no longer grants the unpinned `npx agent-browser` command in `allowed-tools`.
- Updated the bundled agent-desktop skill to upstream `v1.2.0`. It explains how to tell which row a repeated button belongs to (drill the row with `--root` and leave out `-i`), says that a `--root` drill adds its refs to the same snapshot id and replaces the refs it covers, and describes how refs are re-identified before an action: on Windows and Linux a ref for an element with identical twins is refused, and only `--headed mouse-click --xy`, which still needs your permission, can choose one. It also lists the new `details.kind` values for `STALE_REF` and `AMBIGUOUS_TARGET` and the `TIMEOUT` `resolution_identity_unknown` case, with the retry advice for each. Install guidance, the readiness check and permission handling are unchanged.
- Waking a released subagent on another machine now builds the blueprints of the worktrees it restores instead of running the resume setup hook, and a blueprint that is missing or fails never stops the wake ([#4588](https://github.com/bastani-inc/atomic/issues/4588))

## [0.9.75-alpha.1] - 2026-11-10

### Changed

- Updated the bundled agent-browser skill to upstream `v0.41.2`. Its discovery stub now explains that the core guide ends with a table of references and that `agent-browser skills get core --full` is only for when you need every reference at once, lists the new `webmcp-gen` specialized skill, and no longer grants the unpinned `npx agent-browser` command in `allowed-tools`.
- Updated the bundled agent-desktop skill to upstream `v1.2.0`. It explains how to tell which row a repeated button belongs to (drill the row with `--root` and leave out `-i`), says that a `--root` drill adds its refs to the same snapshot id and replaces the refs it covers, and describes how refs are re-identified before an action: on Windows and Linux a ref for an element with identical twins is refused, and only `--headed mouse-click --xy`, which still needs your permission, can choose one. It also lists the new `details.kind` values for `STALE_REF` and `AMBIGUOUS_TARGET` and the `TIMEOUT` `resolution_identity_unknown` case, with the retry advice for each. Install guidance, the readiness check and permission handling are unchanged.
- Waking a released subagent on another machine now builds the blueprints of the worktrees it restores instead of running the resume setup hook, and a blueprint that is missing or fails never stops the wake ([#4588](https://github.com/bastani-inc/atomic/issues/4588))

## [0.9.72] - 2026-11-08

Background subagents that wait let go of their sessions.

- **Released while waiting.** A background subagent waiting on a long tool call, a question or a shell task releases its session and memory, and wakes with the result, also after a restart of its owner or on another machine ([#4326](https://github.com/bastani-inc/atomic/issues/4326), [#4329](https://github.com/bastani-inc/atomic/issues/4329), [#4502](https://github.com/bastani-inc/atomic/issues/4502)).
- **Clear start failures.** A child that does not start in time fails with a `SessionStartTimeoutError` naming what blocked it, and `sessionStartTimeoutMs` sets the budget ([#4319](https://github.com/bastani-inc/atomic/issues/4319)).
- **Message running children.** Type into a child's `/tasks` transcript to message it ([#4521](https://github.com/bastani-inc/atomic/issues/4521)).

### Added

- A released background subagent is woken in the restores of the session or run that launched it, and in those its owner recorded since. When it is woken on another machine, its recorded directory is mapped through them before anything checks that it exists, and its own session is prepared as a woken session is: each checkout it worked in on this machine stays, and the others are restored from its snapshots into worktrees there. A child that still cannot be restored stays the typed unrestorable outcome. See [Resume on any machine](../coding-agent/docs/guides/resume-on-any-machine.md) ([#4329](https://github.com/bastani-inc/atomic/issues/4329))
- `sessionStartTimeoutMs` in the subagent `config.json` sets how long a child may take to start (default 5 minutes). An invalid value is reported when the config loads and the default applies ([#4319](https://github.com/bastani-inc/atomic/issues/4319))
- A background subagent waiting on a long-running detachable tool call is released instead of holding a live session: after a minute its task stops as a resumable stop, its record says `released` and what it waits on, and it holds no session, task or connection. The call's result, an Intercom message or ask sent to it, or `subagent({ action: "resume" })` wakes it from its saved session; `pause` and `quit` keep it stopped and keep arriving results for its resume, and `status` lists it as released ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A released subagent stays addressable across Intercom reconnects and restarts of its owner: the owner reserves its released children again whenever Intercom connects and parks them while they are paused or quit. A wake that cannot find, restore or record a child fails with a typed `ReleasedChildError` (`child-record-missing`, `child-unrestorable`, `record-append-failed` or `hold-failed`) whose hint names the fix, and a result that arrives while a child is being released is recorded first, so the wake never finds the child still running ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- Only background subagents are released; a foreground subagent stays live while its parent's turn waits for it. A released subagent keeps the steering and follow-up messages it had queued and not read, and reads them once, in order, when it wakes; a result that arrives while a woken subagent runs is kept and wakes it again when that run ends; results held for a woken subagent stay saved until its session has them; and a wake reopens the subagent's session only after its previous run has closed it. While it waits, a released subagent keeps nothing in its owner's process but its latest record ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A shell task a released subagent started that finishes while it is released wakes it with the task's completion notice, which is kept for its `resume` while it is paused or quit, instead of going to the session that launched it ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A released subagent survives a failed wake and a restart of its owner. A wake that fails keeps every result it carried in the subagent's record with a typed failure (`ReleasedChildError` code, reason and hint, a new `wake-failed` code for untyped failures) that `status` shows; the launching session gets one notice, and `resume` delivers the kept results. When the launching session is reopened after Atomic restarts, each detachable call a released subagent still waited on starts again under its call id and the subagent is released again without a model turn, so the new result wakes it; one already holding its call's result is woken with it instead. Released subagents of one session are woken at most `parallel.runningCapacity` at a time ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A `resume` or a result that arrives while a released subagent is being restored is delivered after that wake, in order, instead of being lost, and a child record that could not be saved is reported once to the launching session in `status` ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A child with an Intercom target accepts messages typed into its `/tasks` transcript, delivered through the parent's Intercom relay, and its transcript shows when it is compacting ([#4521](https://github.com/bastani-inc/atomic/issues/4521))

### Changed

- A released subagent keeps one small entry of a fixed size in the session that launched it, instead of a copy of its whole latest record, so its task, held messages and held results no longer stay in memory while it waits; they are read from the session's history when it wakes. Each record a subagent saves is now complete, and a session saved by an older Atomic gets one complete record per subagent the first time it is opened. A released subagent launched in a parallel run no longer keeps that run's scheduler in memory; when it wakes, it is limited by `parallel.runningCapacity` like any other released subagent. A record that cannot be read fails with the new `ReleasedChildError` code `child-record-unreadable` ([#4395](https://github.com/bastani-inc/atomic/issues/4395))
- A released background subagent whose session is in an in-memory session store, such as a forked child's, no longer keeps its history in memory while it waits: its history moves to a file under the agent directory and its wake reads it back. A wake or resume whose read of that history fails in a way that passes (a retryable storage error, such as running out of file descriptors) no longer reports the subagent gone: the wake fails with the retryable `ReleasedChildError` code `wake-failed`, the subagent stays released with its results kept, and a later wake or resume restores it ([#4502](https://github.com/bastani-inc/atomic/issues/4502))
- A child that does not start within its start budget fails with a `SessionStartTimeoutError` whose `phase` names what blocked it (`admission`, `setup`, `dispatch` or `event-loop`), instead of a message that always blamed session creation and a resource-admission wait. The child's result carries it as `startError`, and the budget now also covers dispatching the child's task ([#4319](https://github.com/bastani-inc/atomic/issues/4319))

### Fixed

- SDK subagent launches return their start timeout even when an extension's `input` or `before_agent_start` handler never settles. Session cleanup continues separately instead of holding the timeout result ([#4319](https://github.com/bastani-inc/atomic/issues/4319))
- A background subagent that was woken when its owner's process died is released again when the reopened session restores it, instead of ending with an error at its next release. The message Intercom had saved for it just before the crash is read once, after the call it was waiting on gets its result, instead of starting a turn on top of that call ([#4488](https://github.com/bastani-inc/atomic/issues/4488))

## [0.9.72-alpha.1] - 2026-11-08

### Added

- A released background subagent is woken in the restores of the session or run that launched it, and in those its owner recorded since. When it is woken on another machine, its recorded directory is mapped through them before anything checks that it exists, and its own session is prepared as a woken session is: each checkout it worked in on this machine stays, and the others are restored from its snapshots into worktrees there. A child that still cannot be restored stays the typed unrestorable outcome. See [Resume on any machine](../coding-agent/docs/guides/resume-on-any-machine.md) ([#4329](https://github.com/bastani-inc/atomic/issues/4329))
- `sessionStartTimeoutMs` in the subagent `config.json` sets how long a child may take to start (default 5 minutes). An invalid value is reported when the config loads and the default applies ([#4319](https://github.com/bastani-inc/atomic/issues/4319))
- A background subagent waiting on a long-running detachable tool call is released instead of holding a live session: after a minute its task stops as a resumable stop, its record says `released` and what it waits on, and it holds no session, task or connection. The call's result, an Intercom message or ask sent to it, or `subagent({ action: "resume" })` wakes it from its saved session; `pause` and `quit` keep it stopped and keep arriving results for its resume, and `status` lists it as released ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A released subagent stays addressable across Intercom reconnects and restarts of its owner: the owner reserves its released children again whenever Intercom connects and parks them while they are paused or quit. A wake that cannot find, restore or record a child fails with a typed `ReleasedChildError` (`child-record-missing`, `child-unrestorable`, `record-append-failed` or `hold-failed`) whose hint names the fix, and a result that arrives while a child is being released is recorded first, so the wake never finds the child still running ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- Only background subagents are released; a foreground subagent stays live while its parent's turn waits for it. A released subagent keeps the steering and follow-up messages it had queued and not read, and reads them once, in order, when it wakes; a result that arrives while a woken subagent runs is kept and wakes it again when that run ends; results held for a woken subagent stay saved until its session has them; and a wake reopens the subagent's session only after its previous run has closed it. While it waits, a released subagent keeps nothing in its owner's process but its latest record ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A shell task a released subagent started that finishes while it is released wakes it with the task's completion notice, which is kept for its `resume` while it is paused or quit, instead of going to the session that launched it ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A released subagent survives a failed wake and a restart of its owner. A wake that fails keeps every result it carried in the subagent's record with a typed failure (`ReleasedChildError` code, reason and hint, a new `wake-failed` code for untyped failures) that `status` shows; the launching session gets one notice, and `resume` delivers the kept results. When the launching session is reopened after Atomic restarts, each detachable call a released subagent still waited on starts again under its call id and the subagent is released again without a model turn, so the new result wakes it; one already holding its call's result is woken with it instead. Released subagents of one session are woken at most `parallel.runningCapacity` at a time ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A `resume` or a result that arrives while a released subagent is being restored is delivered after that wake, in order, instead of being lost, and a child record that could not be saved is reported once to the launching session in `status` ([#4326](https://github.com/bastani-inc/atomic/issues/4326))
- A child with an Intercom target accepts messages typed into its `/tasks` transcript, delivered through the parent's Intercom relay, and its transcript shows when it is compacting ([#4521](https://github.com/bastani-inc/atomic/issues/4521))

### Changed

- A released subagent keeps one small entry of a fixed size in the session that launched it, instead of a copy of its whole latest record, so its task, held messages and held results no longer stay in memory while it waits; they are read from the session's history when it wakes. Each record a subagent saves is now complete, and a session saved by an older Atomic gets one complete record per subagent the first time it is opened. A released subagent launched in a parallel run no longer keeps that run's scheduler in memory; when it wakes, it is limited by `parallel.runningCapacity` like any other released subagent. A record that cannot be read fails with the new `ReleasedChildError` code `child-record-unreadable` ([#4395](https://github.com/bastani-inc/atomic/issues/4395))
- A released background subagent whose session is in an in-memory session store, such as a forked child's, no longer keeps its history in memory while it waits: its history moves to a file under the agent directory and its wake reads it back. A wake or resume whose read of that history fails in a way that passes (a retryable storage error, such as running out of file descriptors) no longer reports the subagent gone: the wake fails with the retryable `ReleasedChildError` code `wake-failed`, the subagent stays released with its results kept, and a later wake or resume restores it ([#4502](https://github.com/bastani-inc/atomic/issues/4502))
- A child that does not start within its start budget fails with a `SessionStartTimeoutError` whose `phase` names what blocked it (`admission`, `setup`, `dispatch` or `event-loop`), instead of a message that always blamed session creation and a resource-admission wait. The child's result carries it as `startError`, and the budget now also covers dispatching the child's task ([#4319](https://github.com/bastani-inc/atomic/issues/4319))

### Fixed

- SDK subagent launches return their start timeout even when an extension's `input` or `before_agent_start` handler never settles. Session cleanup continues separately instead of holding the timeout result ([#4319](https://github.com/bastani-inc/atomic/issues/4319))
- A background subagent that was woken when its owner's process died is released again when the reopened session restores it, instead of ending with an error at its next release. The message Intercom had saved for it just before the crash is read once, after the call it was waiting on gets its result, instead of starting a turn on top of that call ([#4488](https://github.com/bastani-inc/atomic/issues/4488))

## [0.9.71] - 2026-11-03

### Changed

- Subagent rows, status lines and `Model: ran on …, not the requested …` notices show each model as its raw `provider/id` followed by its reasoning level, `provider/id  high`, instead of `provider/id · thinking high` ([#4269](https://github.com/bastani-inc/atomic/issues/4269))

## [0.9.71-alpha.1] - 2026-11-03

### Changed

- Subagent rows, status lines and `Model: ran on …, not the requested …` notices show each model as its raw `provider/id` followed by its reasoning level, `provider/id  high`, instead of `provider/id · thinking high` ([#4269](https://github.com/bastani-inc/atomic/issues/4269))

## [0.9.61] - 2026-11-02

### Fixed

- A subagent whose model refuses the request under a provider content filter, such as OpenAI's HTTP 422 `cyber_policy`, Anthropic's refusal stop or a `content_filter` finish reason, now moves straight to its next `fallbackModels` entry instead of retrying that model and failing. Set `retry.fallbackOnContentFilter: false` to keep the refusal on that model ([#4163](https://github.com/bastani-inc/atomic/pull/4163))

## [0.9.61-alpha.2] - 2026-11-02

### Fixed

- A subagent whose model refuses the request under a provider content filter, such as OpenAI's HTTP 422 `cyber_policy`, Anthropic's refusal stop or a `content_filter` finish reason, now moves straight to its next `fallbackModels` entry instead of retrying that model and failing. Set `retry.fallbackOnContentFilter: false` to keep the refusal on that model ([#4163](https://github.com/bastani-inc/atomic/pull/4163))

## [0.9.60] - 2026-11-01

Subagents keep the model you asked for.

- **Unknown effort words no longer swap models:** a launch such as `openai/gpt-5.5:extreme` now runs the requested model at its default level instead of silently running on the default model, and fails with a clear error if the model is unavailable ([#4154](https://github.com/bastani-inc/atomic/pull/4154))

### Fixed

- A subagent launched with an effort word that is not a level, such as `model: "openai/gpt-5.5:extreme"`, now runs that model at its default level, as for an effort the model does not support, instead of silently running on the default model; a `fallbackModels` entry with such a word runs its model at that model's default level too. If the model itself is not available either, the launch fails with `Unknown model "<model>": "<word>" is not an effort level (...)` instead of running another model ([#4154](https://github.com/bastani-inc/atomic/pull/4154))

## [0.9.60-alpha.1] - 2026-11-01

Subagents keep the model you asked for.

- **Unknown effort words no longer swap models:** a launch such as `openai/gpt-5.5:extreme` now runs the requested model at its default level instead of silently running on the default model, and fails with a clear error if the model is unavailable ([#4154](https://github.com/bastani-inc/atomic/pull/4154))

### Fixed

- A subagent launched with an effort word that is not a level, such as `model: "openai/gpt-5.5:extreme"`, now runs that model at its default level, as for an effort the model does not support, instead of silently running on the default model; a `fallbackModels` entry with such a word runs its model at that model's default level too. If the model itself is not available either, the launch fails with `Unknown model "<model>": "<word>" is not an effort level (...)` instead of running another model ([#4154](https://github.com/bastani-inc/atomic/pull/4154))

## [0.9.58] - 2026-11-01

### Added

- Running subagents now send the parent periodic task heartbeats (every 15 minutes by default) with their current tool call, time since their last activity, and turn, tool-call and token counts. Set `heartbeatMs` on a `subagent` call, or on a `tasks` entry, to change a child's cadence; `0` turns it off.

### Fixed

- A subagent launched from a chat turn that a running workflow started no longer stays `running` for good with no session: its session no longer waits on that workflow's resource admission. A subagent whose session still does not start within 5 minutes fails with `Subagent session did not start within 5 min (still <step>)`, and `status` shows the cause in its text and its expanded card. ([#4148](https://github.com/bastani-inc/atomic/pull/4148), [#4150](https://github.com/bastani-inc/atomic/pull/4150))
- A subagent launched with an effort, such as `model: "openai/gpt-5.5:xhigh"`, runs at exactly that effort on a model that supports it, and at that model's default level on one that does not; each model in its fallback chain follows the same rule instead of falling back to the default level, including a fallback the child starts on in place of a requested model whose provider has no auth. ([#4148](https://github.com/bastani-inc/atomic/pull/4148), [#4150](https://github.com/bastani-inc/atomic/pull/4150))
- `status` lists only the children this session launched, with the child id `pause`, `resume` and `quit` take, and those actions also take the listed path; `status` with a child id finds the child. ([#4148](https://github.com/bastani-inc/atomic/pull/4148))

## [0.9.58-alpha.1] - 2026-11-01

### Added

- Running subagents now send the parent periodic task heartbeats (every 15 minutes by default) with their current tool call, time since their last activity, and turn, tool-call and token counts. Set `heartbeatMs` on a `subagent` call, or on a `tasks` entry, to change a child's cadence; `0` turns it off.

## [0.9.57] - 2026-10-31

Desktop computer use moves from Cua Driver to agent-desktop.

- **agent-desktop for native apps:** the bundled computer-use skill is now `agent-desktop`, which drives native desktop apps, menus and OS dialogs on macOS, Windows and Linux through their accessibility trees. Install it with `npm install -g agent-desktop`; the skill loads guides that match the installed version ([#4134](https://github.com/bastani-inc/atomic/pull/4134))
- **Workflow code:** a workflow that owns a desktop scenario calls the `agent-desktop` CLI from `ctx.tool`, checks readiness first, and ends the run as `blocked` when a permission or the Linux accessibility bus is missing ([#4134](https://github.com/bastani-inc/atomic/pull/4134))
- **Coverage that changed:** agent-desktop reads accessibility trees, not pixels, and has no native iOS or Android support; use `xcrun simctl`, Appium or `adb` for native mobile apps. `ATOMIC_CUA_AUTO_APPROVE` no longer has any effect ([#4134](https://github.com/bastani-inc/atomic/pull/4134))

### Changed

- The bundled computer-use skill is now `agent-desktop` (vercel-labs/agent-desktop v1.0.2) instead of `cua-driver`. It drives native desktop apps on macOS, Windows and Linux through their accessibility trees. Install the CLI with `npm install -g agent-desktop`; check readiness with `agent-desktop status`, and on macOS grant Accessibility with `agent-desktop permissions --guide`. The skill tells the agent to load `agent-desktop skills get desktop` and `agent-desktop skills get platform`, which always match the installed CLI. agent-desktop does not match pixels, so apps that expose no accessibility tree, native iOS apps in the Simulator and Android emulators no longer have a bundled route; use `xcrun simctl`, Appium or `adb` for native mobile apps. `ATOMIC_CUA_AUTO_APPROVE` no longer has any effect.

## [0.9.57-alpha.1] - 2026-10-31

Desktop computer use moves from Cua Driver to agent-desktop.

- **agent-desktop for native apps:** the bundled computer-use skill is now `agent-desktop`, which drives native desktop apps, menus and OS dialogs on macOS, Windows and Linux through their accessibility trees. Install it with `npm install -g agent-desktop`; the skill loads guides that match the installed version ([#4134](https://github.com/bastani-inc/atomic/pull/4134))
- **Workflow code:** a workflow that owns a desktop scenario calls the `agent-desktop` CLI from `ctx.tool`, checks readiness first, and ends the run as `blocked` when a permission or the Linux accessibility bus is missing ([#4134](https://github.com/bastani-inc/atomic/pull/4134))
- **Coverage that changed:** agent-desktop reads accessibility trees, not pixels, and has no native iOS or Android support; use `xcrun simctl`, Appium or `adb` for native mobile apps. `ATOMIC_CUA_AUTO_APPROVE` no longer has any effect ([#4134](https://github.com/bastani-inc/atomic/pull/4134))

### Changed

- The bundled computer-use skill is now `agent-desktop` (vercel-labs/agent-desktop v1.0.2) instead of `cua-driver`. It drives native desktop apps on macOS, Windows and Linux through their accessibility trees. Install the CLI with `npm install -g agent-desktop`; check readiness with `agent-desktop status`, and on macOS grant Accessibility with `agent-desktop permissions --guide`. The skill tells the agent to load `agent-desktop skills get desktop` and `agent-desktop skills get platform`, which always match the installed CLI. agent-desktop does not match pixels, so apps that expose no accessibility tree, native iOS apps in the Simulator and Android emulators no longer have a bundled route; use `xcrun simctl`, Appium or `adb` for native mobile apps. `ATOMIC_CUA_AUTO_APPROVE` no longer has any effect.

## [0.9.46] - 2026-10-27

### Fixed

- A subagent that waited for a free slot (`concurrency`, or a burst of launches) or was restored, and that starts after its parent workflow stage's session was replaced by model fallback, now launches instead of failing with `This extension ctx is stale after session replacement or reload`. It takes its settings from the replacement session, and starts in the directory it was launched for ([#3981](https://github.com/bastani-inc/atomic/issues/3981))
- A detached subagent that exits after its parent workflow stage's session was replaced by model fallback still sends its completion notice. Before, the notice was lost and the workflow run failed with `This extension ctx is stale after session replacement or reload` ([#3981](https://github.com/bastani-inc/atomic/issues/3981))
- A resumed subagent child now receives its resume message and the messages it had queued and not read exactly as written. They used to go through `prompt()` or `followUp()` depending on whether the child had held messages, so `/review …` was replaced by a prompt template's contents, a registered command such as `/workflow` either ran or failed the child with `Extension command "/workflow" cannot be queued`, and text the child had already received was expanded a second time. Only an original task the child never read is still prompted the way a fresh launch prompts it ([#4027](https://github.com/bastani-inc/atomic/pull/4027)).
- A subagent child paused, quit or stopped by its owner while it waited for its run's running capacity, before its session existed, can be resumed and restored again: it used to report `could not be resumed: no session was recorded for it`. A child admitted behind its run's concurrency limit and stopped that way no longer receives its task twice when it is restored. Resuming or restoring a child that had not started now says it started fresh with its task instead of claiming it resumed from its own session ([#4027](https://github.com/bastani-inc/atomic/pull/4027)).
- A subagent whose model is pinned with a thinking suffix (such as `provider/model:low`) no longer shows that suffix as part of its model on its launch and status cards once its session has started; the cards show `provider/model` and the thinking level beside it, as they do before the session starts ([#4009](https://github.com/bastani-inc/atomic/issues/4009))
- A paused subagent child resumed without a message, and a child restored after a restart, are now told to redo or continue a command or step the pause or restart interrupted, as a resumed workflow stage is ([#3996](https://github.com/bastani-inc/atomic/issues/3996))

## [0.9.46-alpha.1] - 2026-10-27

### Fixed

- A subagent that waited for a free slot (`concurrency`, or a burst of launches) or was restored, and that starts after its parent workflow stage's session was replaced by model fallback, now launches instead of failing with `This extension ctx is stale after session replacement or reload`. It takes its settings from the replacement session, and starts in the directory it was launched for ([#3981](https://github.com/bastani-inc/atomic/issues/3981))
- A detached subagent that exits after its parent workflow stage's session was replaced by model fallback still sends its completion notice. Before, the notice was lost and the workflow run failed with `This extension ctx is stale after session replacement or reload` ([#3981](https://github.com/bastani-inc/atomic/issues/3981))
- A resumed subagent child now receives its resume message and the messages it had queued and not read exactly as written. They used to go through `prompt()` or `followUp()` depending on whether the child had held messages, so `/review …` was replaced by a prompt template's contents, a registered command such as `/workflow` either ran or failed the child with `Extension command "/workflow" cannot be queued`, and text the child had already received was expanded a second time. Only an original task the child never read is still prompted the way a fresh launch prompts it ([#4027](https://github.com/bastani-inc/atomic/pull/4027)).
- A subagent child paused, quit or stopped by its owner while it waited for its run's running capacity, before its session existed, can be resumed and restored again: it used to report `could not be resumed: no session was recorded for it`. A child admitted behind its run's concurrency limit and stopped that way no longer receives its task twice when it is restored. Resuming or restoring a child that had not started now says it started fresh with its task instead of claiming it resumed from its own session ([#4027](https://github.com/bastani-inc/atomic/pull/4027)).
- A subagent whose model is pinned with a thinking suffix (such as `provider/model:low`) no longer shows that suffix as part of its model on its launch and status cards once its session has started; the cards show `provider/model` and the thinking level beside it, as they do before the session starts ([#4009](https://github.com/bastani-inc/atomic/issues/4009))

## [0.9.44] - 2026-10-25

### Changed

- **Security policy change:** on macOS, the agent now approves Cua Driver's own Accessibility and Screen Recording permission prompts itself by default, without asking, by clicking them through the host's VNC or Screen Sharing server when credentials for it are available (for example `CUA_VNC_SERVER` and `CUA_VNC_PASSWORD`). It reports each approval and when it happened, never approves any other permission or another app's dialog, and types a password only when you supplied one. Set `ATOMIC_CUA_AUTO_APPROVE=0` to turn this off and have the agent ask you to grant the permissions, as before.
- Updated the bundled Cua Driver skill to upstream `cua-driver-rs-v0.38.0`. Refusals, `unverifiable` actions and `suspected_noop` results now come with a `hint` and a safe `next_call` to try, and three single actions in a row suggest batching with `run_steps`. Steps inside `run_steps` and `run_script` skip most of the cursor glide and window watch on macOS. The macOS guide adds installing and updating the driver and granting its permissions with an MDM profile on managed Macs. It also covers `invoke_menu` refusing unless the requested window is key, background `<select>` menus in Chrome and Electron via `set_value`, Electron drags, and handing a URL to a specific Windows browser with `additional_arguments`.
- Updated the bundled Herdr skill to upstream `v0.9.5`. It can now control agents and panes on a saved SSH machine with `herdr --machine <label-or-id>`, and it explains that an agent suspended with Ctrl+Z keeps its identity, that Antigravity and Grok can look idle while background work continues, that `pane run` only acknowledges admission (and rejects over-long lines on macOS), and that CLI closes skip the TUI's last-pane confirmation. The explicit-request trigger and the `HERDR_ENV=1` requirement are unchanged.
- Subagents now default to peer-to-peer (swarm) coordination with no limits on communication between agents: children discover siblings with `intercom list` and broadcast, debate, claim, hand off, and ask each other directly instead of relaying through the supervisor. Explicit user approval and authorization gates still apply. Swarms scale with the task: for very complex work or requested heavy parallelism, hundreds or thousands of agents self-organize into teams, and the subagents guide documents the settings that bound swarm size. The `parallel.maxTasks`, `parallel.concurrency` and `parallel.runningCapacity` defaults rise from 50, 3 and 4 to 1000, so one parent can run up to 1000 children at once without configuration; set them lower in `~/.atomic/agent/extensions/subagent/config.json` to throttle, or higher for larger swarms.

## [0.9.44-alpha.1] - 2026-10-24

### Changed

- **Security policy change:** on macOS, the agent now approves Cua Driver's own Accessibility and Screen Recording permission prompts itself by default, without asking, by clicking them through the host's VNC or Screen Sharing server when credentials for it are available (for example `CUA_VNC_SERVER` and `CUA_VNC_PASSWORD`). It reports each approval and when it happened, never approves any other permission or another app's dialog, and types a password only when you supplied one. Set `ATOMIC_CUA_AUTO_APPROVE=0` to turn this off and have the agent ask you to grant the permissions, as before.
- Updated the bundled Cua Driver skill to upstream `cua-driver-rs-v0.38.0`. Refusals, `unverifiable` actions and `suspected_noop` results now come with a `hint` and a safe `next_call` to try, and three single actions in a row suggest batching with `run_steps`. Steps inside `run_steps` and `run_script` skip most of the cursor glide and window watch on macOS. The macOS guide adds installing and updating the driver and granting its permissions with an MDM profile on managed Macs. It also covers `invoke_menu` refusing unless the requested window is key, background `<select>` menus in Chrome and Electron via `set_value`, Electron drags, and handing a URL to a specific Windows browser with `additional_arguments`.
- Updated the bundled Herdr skill to upstream `v0.9.5`. It can now control agents and panes on a saved SSH machine with `herdr --machine <label-or-id>`, and it explains that an agent suspended with Ctrl+Z keeps its identity, that Antigravity and Grok can look idle while background work continues, that `pane run` only acknowledges admission (and rejects over-long lines on macOS), and that CLI closes skip the TUI's last-pane confirmation. The explicit-request trigger and the `HERDR_ENV=1` requirement are unchanged.
- Subagents now default to peer-to-peer (swarm) coordination with no limits on communication between agents: children discover siblings with `intercom list` and broadcast, debate, claim, hand off, and ask each other directly instead of relaying through the supervisor. Explicit user approval and authorization gates still apply. Swarms scale with the task: for very complex work or requested heavy parallelism, hundreds or thousands of agents self-organize into teams, and the subagents guide documents the settings that bound swarm size. The `parallel.maxTasks`, `parallel.concurrency` and `parallel.runningCapacity` defaults rise from 50, 3 and 4 to 1000, so one parent can run up to 1000 children at once without configuration; set them lower in `~/.atomic/agent/extensions/subagent/config.json` to throttle, or higher for larger swarms.

## [0.9.41] - 2026-10-22

### Added

- Added a `resumeInFlight` subagent setting (`"never"`, `"ask"`, or `"auto"`, default `"never"`) for recovery of paused and quit subagents that are awaiting resume. `ask` confirms once, listing each subagent, and `auto` resumes each from its own session, with its completion reaching the session that launched it; `never` leaves them for a manual `resume`. It applies when Atomic starts or a session is resumed, to that session's own subagents, never to workflow-stage children, and an invalid value is reported and treated as `never` ([#3827](https://github.com/bastani-inc/atomic/issues/3827)).

### Changed

- Quitting a subagent now behaves like quitting a workflow. The `quit` and `pause` results say the child is paused · awaiting resume and name `{ action: "resume", id: "<child-id>" }`; the parent's completion notice says the same, with the typed `quit` or `pause` stop reason instead of `parent-handoff` and without "This execution has ended". `{ action: "status", id }` reports a paused or quit child as paused · awaiting resume with its resume call, and `{ action: "status" }` lists every such child, including after Atomic restarts. Launch cards of such children show `‖ Paused · awaiting resume` (or `‖ Quit · paused · awaiting resume`) instead of `(resumable)`.

### Fixed

- A subagent with `model: "auto"` no longer waits indefinitely on a slow routing model. Each routing inference now stops after the `httpIdleTimeoutMs` deadline (10 minutes by default), and the subagent runs on the current chat model when it satisfies the routing constraints ([#3806](https://github.com/bastani-inc/atomic/issues/3806))

## [0.9.41-alpha.1] - 2026-10-21

### Added

- Added a `resumeInFlight` subagent setting (`"never"`, `"ask"`, or `"auto"`, default `"never"`) for recovery of paused and quit subagents that are awaiting resume. `ask` confirms once, listing each subagent, and `auto` resumes each from its own session, with its completion reaching the session that launched it; `never` leaves them for a manual `resume`. It applies when Atomic starts or a session is resumed, to that session's own subagents, never to workflow-stage children, and an invalid value is reported and treated as `never` ([#3827](https://github.com/bastani-inc/atomic/issues/3827)).

### Changed

- Quitting a subagent now behaves like quitting a workflow. The `quit` and `pause` results say the child is paused · awaiting resume and name `{ action: "resume", id: "<child-id>" }`; the parent's completion notice says the same, with the typed `quit` or `pause` stop reason instead of `parent-handoff` and without "This execution has ended". `{ action: "status", id }` reports a paused or quit child as paused · awaiting resume with its resume call, and `{ action: "status" }` lists every such child, including after Atomic restarts. Launch cards of such children show `‖ Paused · awaiting resume` (or `‖ Quit · paused · awaiting resume`) instead of `(resumable)`.

### Fixed

- A subagent with `model: "auto"` no longer waits indefinitely on a slow routing model. Each routing inference now stops after the `httpIdleTimeoutMs` deadline (10 minutes by default), and the subagent runs on the current chat model when it satisfies the routing constraints ([#3806](https://github.com/bastani-inc/atomic/issues/3806))

## [0.9.40] - 2026-10-20

### Breaking Changes

- Removed the `kill` action from the `subagent` tool. Replace `subagent({ action: "kill", id })` with `subagent({ action: "quit", id })`, which stops the child gracefully and keeps it resumable. Calls with `action: "kill"` or the earlier `action: "interrupt"` are rejected with an error that names `quit` as the replacement ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).

### Added

- Added workflow-style run control to the `subagent` tool: `pause` stops a child and holds its queued messages until resume, `quit` stops it gracefully, and `resume` continues it from its own saved session under the same child id, Intercom name, and group. `pause` and `quit` accept `all: true` and also reach parallel children still queued behind their concurrency limit, which then start only when resumed, and `resume` accepts an optional `message`: a paused, quit, or interrupted child receives it once as its next prompt and then continues where it left off, and a completed or failed child receives it as one fresh prompt. Without `message`, the child is asked to continue where it left off, including a completed or failed child. A resumed child of a parallel run waits for a slot under that run's concurrency limit, and keeps its `worktree: true` worktree until it finishes; a paused or quit child holds no slot, and its worktree is kept only while it has uncommitted or untracked changes or commits that are not in the run's base. Resume continues in a kept worktree, or recreates a removed one from the run's base; a resume that fails keeps the worktree, its changes, and its branch. Steering and follow-up messages a child had queued when it was paused or quit are delivered once, in order, when it resumes, before the resume `message`. An SDK session without a task host records its subagents the same way, so `pause`, `resume` and `quit` work there too, also after the session is reopened; a child it resumes runs in the background and reports through a completion notice. A child paused or quit before it read its task or the resume message keeps them, and resume delivers them. `id` accepts the child id, task id, Intercom name, or a single-child run id ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).
- Paused, quit, interrupted, completed, and failed children can be resumed, including children of a session you closed or switched away from (Atomic exit or crash, `/new`, `/resume` to another session, `/fork`). Children cancelled for good (owner or batch cancellation, a `/tasks` stop, the removed `kill` action) or reported gone after a restart are terminal, and `resume` on them returns an error that says why ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).
- Background subagent launch cards now show the child's latest state, also after you reopen the session (`/resume` or `atomic --session <id>`) or view a workflow stage's transcript: running, paused, paused with its workflow stage, quit, or interrupted (resumable), completed, failed, or terminal (killed, gone after a restart, or its workflow stage ended). Expanding a card shows the end of the child's saved transcript. A resumed child continues in its original card, marked resumed, and replayed `pause`, `resume`, and `quit` calls render as their results, or as errors when they were rejected ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).

### Changed

- Updated the bundled Cua Driver skill to upstream `cua-driver-rs-v0.36.0`. It now starts with an efficient loop: targeted `get_window_state` reads with `query`, acting by `element_token`, batching actions with `run_steps` or `run_script`, re-reading only changes with `since:"latest"`, and verifying at checkpoints instead of after every action. It also covers opening local files with `launch_app`, browser fallbacks when browser tools refuse in the background, and macOS editor recipes.
- When a workflow stage closes for good (the stage finished, or its run ended or was cancelled), every subagent it launched becomes terminal, whether running, paused, quit, completed, or failed, and `resume` on them returns an error that says their workflow stage ended. A quit child stays resumable only while the session or stage that launched it can still resume it. `quit` also accepts a child paused with its workflow stage, and `pause` reports such a child as already paused. Pausing or quitting a workflow run, Atomic exiting, switching sessions, and an interrupted stage leave the stage's children resumable: `resume` continues them, and resuming the run after Atomic restarts restores them with the stage ([#3760](https://github.com/bastani-inc/atomic/issues/3760)). A stage blocked by a recoverable failure, such as a rate limit or provider outage that leaves its run resumable, keeps its paused and quit subagents resumable until the run is killed, cancelled, or ends without staying resumable; then they end with the stage.

### Fixed

- Background subagents that were still running when Atomic exited are now relaunched from their own sessions when you resume the session (`atomic --session <id>` or `/resume`) or resume a workflow stage that launched them. They keep their original Intercom name and group and get fresh supervisor authorization, and Intercom messages sent to it by any session in its group wait for it from the moment the resumed session starts (or, for a stage's subagent, from the moment the interrupted run becomes addressable) until it has been restored. Only the session that launched a child restores it: a fork of that session (`/fork`, `atomic --fork`, or a branched session) copies the child's record but never relaunches, waits for, or reports the child. If a child cannot be restored, the resumed agent is told explicitly that it is gone, once: the child is then recorded as gone, so later resumes neither retry it nor repeat the notice ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).
- On Windows, removing a `worktree: true` worktree now removes its directory. Its `node_modules` junction is unlinked first, so Git for Windows no longer leaves the directory behind, and older Git versions no longer delete the main checkout's `node_modules` through the junction.
- A `worktree: true` child resumed after an Atomic restart saves its tracked and untracked edits as a patch in its run's `worktree-diffs` directory before its worktree is removed, as a child of a fresh run does.
- Resuming a `worktree: true` child whose worktree was already removed, such as a completed child, now restores the edits it saved as a patch before it continues, so its earlier work is not lost. Each run saves its patches in its own `worktree-diffs/<run id>` directory, and each execution of a resumed child writes its own patch (`task-<n>-<agent>.<execution>.patch`) instead of overwriting the earlier one. Patches now include binary changes.
- A subagent that an SDK session without a task host resumed now stops when that session closes, as the original launch does. Reopening the session relaunches it automatically, as it does a task-host child, and the steering and follow-up messages it had queued and not read are delivered once, in order. A task-host child whose session or workflow stage closes now keeps its unread steering and follow-up messages the same way, and restoring or resuming it delivers them once, in order, instead of losing them.
- Opening a fork no longer changes the original session's subagent launch cards back to an older state copied into the fork, such as showing a completed child as running.
- `pause` or `quit` of a subagent that completes just before the stop takes effect now reports that it completed instead of "Paused", and Intercom messages sent to it are no longer held until a resume ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- A parallel subagent paused or quit while it still waited for a free slot can now be resumed after Atomic restarts, and one still waiting when Atomic exited starts when its session reopens, instead of being reported unrestorable or gone. It starts as a new launch under the same child id, Intercom name, and group, with its original agent definition, task, working directory or worktree, model, and skills, and a `context: "fork"` child starts on the parent conversation its launch branched; if that branch can no longer be reopened, the child is reported gone rather than started without it. This holds in task-host and SDK sessions alike ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- Subagents of a workflow stage whose run is killed while it waits, after Atomic restarts, for `/workflow resume` now end with the run: `resume` returns "its workflow stage ended", their cards no longer show them as resumable, and reopening the stage's session no longer restores them ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- A subagent relaunched from its own session after Atomic restarts, or resumed with `resume`, now runs on the agent definition it was launched with: a user agent is no longer replaced by a project agent of the same name. A child launched with `context: "fork"` also keeps its Intercom bridge instructions under `intercomBridge.mode: "fork-only"`. Children recorded by an earlier version keep the previous lookup ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- A queued parallel subagent that inherited its parent's model and thinking level now keeps them when it starts after Atomic restarts, instead of taking whatever model and thinking level the parent switched to meanwhile. If that model is no longer available, resume reports the child as gone instead of starting it on the parent's current model. A child restored or resumed from its own session also falls back to the model it was launched with, not the parent's current one, and a child launched outside any Intercom group no longer joins a group the parent joined later ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).

## [0.9.40-alpha.1] - 2026-10-20

### Breaking Changes

- Removed the `kill` action from the `subagent` tool. Replace `subagent({ action: "kill", id })` with `subagent({ action: "quit", id })`, which stops the child gracefully and keeps it resumable. Calls with `action: "kill"` or the earlier `action: "interrupt"` are rejected with an error that names `quit` as the replacement ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).

### Added

- Added workflow-style run control to the `subagent` tool: `pause` stops a child and holds its queued messages until resume, `quit` stops it gracefully, and `resume` continues it from its own saved session under the same child id, Intercom name, and group. `pause` and `quit` accept `all: true` and also reach parallel children still queued behind their concurrency limit, which then start only when resumed, and `resume` accepts an optional `message`: a paused, quit, or interrupted child receives it once as its next prompt and then continues where it left off, and a completed or failed child receives it as one fresh prompt. Without `message`, the child is asked to continue where it left off, including a completed or failed child. A resumed child of a parallel run waits for a slot under that run's concurrency limit, and keeps its `worktree: true` worktree until it finishes; a paused or quit child holds no slot, and its worktree is kept only while it has uncommitted or untracked changes or commits that are not in the run's base. Resume continues in a kept worktree, or recreates a removed one from the run's base; a resume that fails keeps the worktree, its changes, and its branch. Steering and follow-up messages a child had queued when it was paused or quit are delivered once, in order, when it resumes, before the resume `message`. An SDK session without a task host records its subagents the same way, so `pause`, `resume` and `quit` work there too, also after the session is reopened; a child it resumes runs in the background and reports through a completion notice. A child paused or quit before it read its task or the resume message keeps them, and resume delivers them. `id` accepts the child id, task id, Intercom name, or a single-child run id ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).
- Paused, quit, interrupted, completed, and failed children can be resumed, including children of a session you closed or switched away from (Atomic exit or crash, `/new`, `/resume` to another session, `/fork`). Children cancelled for good (owner or batch cancellation, a `/tasks` stop, the removed `kill` action) or reported gone after a restart are terminal, and `resume` on them returns an error that says why ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).
- Background subagent launch cards now show the child's latest state, also after you reopen the session (`/resume` or `atomic --session <id>`) or view a workflow stage's transcript: running, paused, paused with its workflow stage, quit, or interrupted (resumable), completed, failed, or terminal (killed, gone after a restart, or its workflow stage ended). Expanding a card shows the end of the child's saved transcript. A resumed child continues in its original card, marked resumed, and replayed `pause`, `resume`, and `quit` calls render as their results, or as errors when they were rejected ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).

### Changed

- Updated the bundled Cua Driver skill to upstream `cua-driver-rs-v0.36.0`. It now starts with an efficient loop: targeted `get_window_state` reads with `query`, acting by `element_token`, batching actions with `run_steps` or `run_script`, re-reading only changes with `since:"latest"`, and verifying at checkpoints instead of after every action. It also covers opening local files with `launch_app`, browser fallbacks when browser tools refuse in the background, and macOS editor recipes.
- When a workflow stage closes for good (the stage finished, or its run ended or was cancelled), every subagent it launched becomes terminal, whether running, paused, quit, completed, or failed, and `resume` on them returns an error that says their workflow stage ended. A quit child stays resumable only while the session or stage that launched it can still resume it. `quit` also accepts a child paused with its workflow stage, and `pause` reports such a child as already paused. Pausing or quitting a workflow run, Atomic exiting, switching sessions, and an interrupted stage leave the stage's children resumable: `resume` continues them, and resuming the run after Atomic restarts restores them with the stage ([#3760](https://github.com/bastani-inc/atomic/issues/3760)). A stage blocked by a recoverable failure, such as a rate limit or provider outage that leaves its run resumable, keeps its paused and quit subagents resumable until the run is killed, cancelled, or ends without staying resumable; then they end with the stage.

### Fixed

- Background subagents that were still running when Atomic exited are now relaunched from their own sessions when you resume the session (`atomic --session <id>` or `/resume`) or resume a workflow stage that launched them. They keep their original Intercom name and group and get fresh supervisor authorization, and Intercom messages sent to it by any session in its group wait for it from the moment the resumed session starts (or, for a stage's subagent, from the moment the interrupted run becomes addressable) until it has been restored. Only the session that launched a child restores it: a fork of that session (`/fork`, `atomic --fork`, or a branched session) copies the child's record but never relaunches, waits for, or reports the child. If a child cannot be restored, the resumed agent is told explicitly that it is gone, once: the child is then recorded as gone, so later resumes neither retry it nor repeat the notice ([#3760](https://github.com/bastani-inc/atomic/issues/3760)).
- On Windows, removing a `worktree: true` worktree now removes its directory. Its `node_modules` junction is unlinked first, so Git for Windows no longer leaves the directory behind, and older Git versions no longer delete the main checkout's `node_modules` through the junction.
- A `worktree: true` child resumed after an Atomic restart saves its tracked and untracked edits as a patch in its run's `worktree-diffs` directory before its worktree is removed, as a child of a fresh run does.
- Resuming a `worktree: true` child whose worktree was already removed, such as a completed child, now restores the edits it saved as a patch before it continues, so its earlier work is not lost. Each run saves its patches in its own `worktree-diffs/<run id>` directory, and each execution of a resumed child writes its own patch (`task-<n>-<agent>.<execution>.patch`) instead of overwriting the earlier one. Patches now include binary changes.
- A subagent that an SDK session without a task host resumed now stops when that session closes, as the original launch does. Reopening the session relaunches it automatically, as it does a task-host child, and the steering and follow-up messages it had queued and not read are delivered once, in order. A task-host child whose session or workflow stage closes now keeps its unread steering and follow-up messages the same way, and restoring or resuming it delivers them once, in order, instead of losing them.
- Opening a fork no longer changes the original session's subagent launch cards back to an older state copied into the fork, such as showing a completed child as running.
- `pause` or `quit` of a subagent that completes just before the stop takes effect now reports that it completed instead of "Paused", and Intercom messages sent to it are no longer held until a resume ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- A parallel subagent paused or quit while it still waited for a free slot can now be resumed after Atomic restarts, and one still waiting when Atomic exited starts when its session reopens, instead of being reported unrestorable or gone. It starts as a new launch under the same child id, Intercom name, and group, with its original agent definition, task, working directory or worktree, model, and skills, and a `context: "fork"` child starts on the parent conversation its launch branched; if that branch can no longer be reopened, the child is reported gone rather than started without it. This holds in task-host and SDK sessions alike ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- Subagents of a workflow stage whose run is killed while it waits, after Atomic restarts, for `/workflow resume` now end with the run: `resume` returns "its workflow stage ended", their cards no longer show them as resumable, and reopening the stage's session no longer restores them ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- A subagent relaunched from its own session after Atomic restarts, or resumed with `resume`, now runs on the agent definition it was launched with: a user agent is no longer replaced by a project agent of the same name. A child launched with `context: "fork"` also keeps its Intercom bridge instructions under `intercomBridge.mode: "fork-only"`. Children recorded by an earlier version keep the previous lookup ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).
- A queued parallel subagent that inherited its parent's model and thinking level now keeps them when it starts after Atomic restarts, instead of taking whatever model and thinking level the parent switched to meanwhile. If that model is no longer available, resume reports the child as gone instead of starting it on the parent's current model. A child restored or resumed from its own session also falls back to the model it was launched with, not the parent's current one, and a child launched outside any Intercom group no longer joins a group the parent joined later ([#3784](https://github.com/bastani-inc/atomic/pull/3784)).

## [0.9.39] - 2026-10-19

### Fixed

- A finished in-process subagent child no longer keeps its disposed agent session reachable for as long as its task exists. The task keeps the child's transcript entries for inspection but releases the session itself, so a long-lived parent session that launches many children stops accumulating their memory ([#3622](https://github.com/bastani-inc/atomic/issues/3622) by [@vishnu363728](https://github.com/vishnu363728)).

## [0.9.39-alpha.1] - 2026-10-19

### Fixed

- A finished in-process subagent child no longer keeps its disposed agent session reachable for as long as its task exists. The task keeps the child's transcript entries for inspection but releases the session itself, so a long-lived parent session that launches many children stops accumulating their memory ([#3622](https://github.com/bastani-inc/atomic/issues/3622) by [@vishnu363728](https://github.com/vishnu363728)).

## [0.9.38] - 2026-10-18

### Breaking Changes

- Forked context now uses the parent's session ID and selected session store, including stored empty IDs. Embedded runners pass a `sessionManager` instead of a `sessionFile` input. Token readers take a store and session ID and return a promise; filesystem paths no longer select a transcript.

### Changed

- Subagent parallel task limits can now be raised above 50 with `parallel.maxTasks`. Configure `parallel.concurrency` and the new `parallel.runningCapacity` together to run more than four child turns per parent; defaults remain 50 tasks, concurrency 3, and running capacity 4.

## [0.9.38-alpha.8] - 2026-10-17

### Changed

- Subagent parallel task limits can now be raised above 50 with `parallel.maxTasks`. Configure `parallel.concurrency` and the new `parallel.runningCapacity` together to run more than four child turns per parent; defaults remain 50 tasks, concurrency 3, and running capacity 4.

## [0.9.38-alpha.7] - 2026-10-17

### Breaking Changes

- Forked context now uses the parent's session ID and selected session store, including stored empty IDs. Embedded runners pass a `sessionManager` instead of a `sessionFile` input. Token readers take a store and session ID and return a promise; filesystem paths no longer select a transcript.

## [0.9.29] - 2026-10-09

### Added

- Subagents with `model: "auto"` honor the new `modelRouting.allowedModels` and `modelRouting.excludedModels` settings for the routed model, its fallbacks, and the current chat model used when routing fails, and the launch fails with an error naming the setting when no allowed model remains. A subagent result's `routerSelection` now lists the `candidates` the router could choose from ([#3528](https://github.com/bastani-inc/atomic/issues/3528)).

## [0.9.29-alpha.1] - 2026-10-08

### Added

- Subagents with `model: "auto"` honor the new `modelRouting.allowedModels` and `modelRouting.excludedModels` settings for the routed model, its fallbacks, and the current chat model used when routing fails, and the launch fails with an error naming the setting when no allowed model remains. A subagent result's `routerSelection` now lists the `candidates` the router could choose from ([#3528](https://github.com/bastani-inc/atomic/issues/3528)).

## [0.9.28] - 2026-10-08

### Changed

- Updated the bundled Cua Driver skill to upstream `cua-driver-rs-v0.34.0`, with focused runtime, workflow, and visual guides covering authorization, exact targets, observation, and outcome verification.

## [0.9.28-alpha.4] - 2026-10-07

### Changed

- Updated the bundled Cua Driver skill to upstream `cua-driver-rs-v0.34.0`, with focused runtime, workflow, and visual guides covering authorization, exact targets, observation, and outcome verification.

## [0.9.27] - 2026-10-05

### Fixed

- Simultaneous subagent calls preserve each caller's wait policy and return only that caller's results instead of a shared parallel receipt ([#3427](https://github.com/bastani-inc/atomic/issues/3427)).
- Simultaneous subagent calls with mixed foreground and background waits now share the configured concurrency limit; returning a background receipt does not free a running child's slot ([#3427](https://github.com/bastani-inc/atomic/issues/3427)).
- Single-agent calls with mixed wait policies keep progress files isolated per run instead of overwriting an existing project `progress.md` ([#3427](https://github.com/bastani-inc/atomic/issues/3427)).

## [0.9.27-alpha.1] - 2026-10-04

### Fixed

- Simultaneous subagent calls preserve each caller's wait policy and return only that caller's results instead of a shared parallel receipt ([#3427](https://github.com/bastani-inc/atomic/issues/3427)).
- Simultaneous subagent calls with mixed foreground and background waits now share the configured concurrency limit; returning a background receipt does not free a running child's slot ([#3427](https://github.com/bastani-inc/atomic/issues/3427)).
- Single-agent calls with mixed wait policies keep progress files isolated per run instead of overwriting an existing project `progress.md` ([#3427](https://github.com/bastani-inc/atomic/issues/3427)).

## [0.9.23] - 2026-09-27

### Fixed

- `model: "auto"` routing no longer ignores benchmark results when fewer than four models are available. Each model's results are now ranked against every model in the evals catalog rather than only the models you can route to, so with just two or three models (for example Opus and Haiku) the stronger model is no longer outranked on price alone, and a model scores the same however many models are enabled.

## [0.9.23-alpha.1] - 2026-09-27

### Fixed

- `model: "auto"` routing no longer ignores benchmark results when fewer than four models are available. Each model's results are now ranked against every model in the evals catalog rather than only the models you can route to, so with just two or three models (for example Opus and Haiku) the stronger model is no longer outranked on price alone, and a model scores the same however many models are enabled.

## [0.9.21] - 2026-09-26

### Changed

- `model: "auto"` routing has a chat model answer fixed questions about the complete task, then the router chooses between a short, evidence-backed list of models without seeing the task, in at most two small requests. The new `modelRouting` setting's `allowedProviders` and `excludedProviders` lists limit which providers are candidates.
- `model: "auto"` accepts `taskNeeds` so the caller can state the task's kind of work, difficulty, mistake cost, need for images, need for a very large context and whether speed matters, and `modelConstraints.allowedModels` sets the shortlist the router chooses between. `modelConstraints.allowedProviders` and `excludedProviders` skip whole providers and replace the `modelRouting` provider settings for that call. Falling back to the current chat model is silent unless `ATOMIC_MODEL_ROUTING_DEBUG=1`.

### Fixed

- Settled subagent tasks no longer return only an opaque `output:<taskId>` reference. `action: "wait"`, `action: "status"`, and settled launch results now show up to 16 KB of the result and the path of a private copy of the full output. A child's `contact_supervisor` question is now readable from a workflow stage or a background launch. `output: "<path>"` is written again for every run, including background runs ([#3294](https://github.com/bastani-inc/atomic/issues/3294)).

## [0.9.21-alpha.2] - 2026-09-26

### Changed

- `model: "auto"` routing has a chat model answer fixed questions about the complete task, then the router chooses between a short, evidence-backed list of models without seeing the task, in at most two small requests. The new `modelRouting` setting's `allowedProviders` and `excludedProviders` lists limit which providers are candidates.
- `model: "auto"` accepts `taskNeeds` so the caller can state the task's kind of work, difficulty, mistake cost, need for images, need for a very large context and whether speed matters, and `modelConstraints.allowedModels` sets the shortlist the router chooses between. `modelConstraints.allowedProviders` and `excludedProviders` skip whole providers and replace the `modelRouting` provider settings for that call. Falling back to the current chat model is silent unless `ATOMIC_MODEL_ROUTING_DEBUG=1`.

### Fixed

- Settled subagent tasks no longer return only an opaque `output:<taskId>` reference. `action: "wait"`, `action: "status"`, and settled launch results now show up to 16 KB of the result and the path of a private copy of the full output. A child's `contact_supervisor` question is now readable from a workflow stage or a background launch. `output: "<path>"` is written again for every run, including background runs ([#3294](https://github.com/bastani-inc/atomic/issues/3294)).

## [0.9.20] - 2026-09-24

### Added

- Added the bundled `cua-driver` skill, vendored verbatim from [trycua/cua](https://github.com/trycua/cua) `libs/cua-driver/rust/Skills/cua-driver` at tag `cua-driver-rs-v0.28.2` (MIT, © 2025 Cua AI, Inc.), with all eight upstream files including the macOS, Windows, and Linux platform guides. Only the `SKILL.md` frontmatter is Atomic-owned. It teaches the `cua-driver` CLI's snapshot → act → fresh snapshot → verify loop for desktop, simulator, and emulator computer use, replacing the previous PyAutoGUI guidance ([#3181](https://github.com/bastani-inc/atomic/issues/3181)).
- Added opt-in `model: "auto"` for single tasks, parallel tasks and agent defaults. One bounded routing decision uses the current available model/effort pairs and shipped evaluation guidance, with the shared `routerModel` setting selecting routing inference. Invalid or stale decisions stop before child execution, and routing selection remains distinct from execution fallback metadata ([#3090](https://github.com/bastani-inc/atomic/issues/3090)).
- Added `/feedback` to draft privacy-scrubbed bug reports and enhancements, investigate bugs with one debugger run, and post reviewed drafts through your `gh` login ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).

### Changed

- Subagent orchestration guidance again makes workflows the default for non-trivial structured work with verifiable objectives, such as implementation, review, or retry pipelines, unless you ask for inline execution.
- The builtin `tdd` skill now checks every new test before it's written: it must name the behavior it protects, the regression that would break it, and why existing tests don't already catch that, and it can't need a production seam that exists only for the test. Bug regression tests must fail on the unfixed code first. The skill also covers reviewing and pruning existing tests: a list of low-value test patterns, a bar for which tests to keep, and a read-only, evidence-first audit workflow. It is adapted from OpenClaw's `test-audit` skill.
- Subagent orchestration guidance no longer lets an absence of workflow history, or history of only inline runs, push every task inline; the agent judges the task first and refines with execution history and your preferences.
- Replaced the bundled `playwright-cli` skill with the `agent-browser` skill ([vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) v0.38.1) for browser automation, end-to-end UI checks, screenshots, and reviewable video recording. The `worker`, `debugger`, `code-simplifier`, `codebase-analyzer`, and `codebase-online-researcher` subagents now load `agent-browser` and drive the `agent-browser` command instead of `playwright-cli`.
- Subagent guidance now states that children can coordinate with each other, not only with the supervisor. The runtime Intercom bridge instruction, the orchestrator prompt guidance, the `subagent` skill, and the `worker` and `debugger` agent definitions describe when same-group siblings should use ordinary `intercom` `list`/`send`/`ask` to debate findings with evidence, hand off paths and reproductions, claim shared files or expensive steps, and learn what a sibling already verified, while `contact_supervisor` stays reserved for supervisor decisions and each child still returns its own result.
- All builtin agents now default to `model: "auto"` instead of pinned models and fallback chains. Explicit model overrides and builtin effort settings remain effective, including empty legacy `thinking` values that clear an inherited effort and fallback suffixes that override legacy defaults. Hard model constraints still apply to every candidate; main-chat and custom-agent defaults are unchanged.
- Automatic model selection ranks up to three distinct eligible models and tries them in order before remaining configured fallbacks and the current chat model, retaining each selected effort and skipping duplicate model IDs.
- Automatic model routing now receives `evals.md` as markdown tables of dated benchmark records rather than packed one-line rows.
- Orchestrator model-pinning guidance now treats `evals.md` as factual per-evaluation records and leaves unmatching catalogs unpinned instead of describing benchmark rows as recommendations.

### Fixed

- A background subagent's intercom `ask` to its parent now reaches the parent as a normal intercom question, and the child waits for the reply. Previously it became a fresh-start handoff, which only a `subagent` call still waiting in the foreground can return, so the child stopped with `parent-handoff` and the question was lost. The handoff still applies while the parent waits in the foreground ([#3251](https://github.com/bastani-inc/atomic/issues/3251)).
- A subagent with `model: "auto"` no longer fails to launch when routing inference fails completely (Jev and the chat structured-output fallback both). The child now runs on the current chat model with a reported warning when that model is available and satisfies every routing constraint; validation and conflicting-constraint failures and cancellation still stop the launch ([#3206](https://github.com/bastani-inc/atomic/issues/3206)).
- Automatic model routing with Jev no longer rejects catalogs above 255 eligible model/effort pairs. Every pair participates in a bounded tournament before final selection; context remains unchanged and any routing failure still prevents child launch ([#3090](https://github.com/bastani-inc/atomic/issues/3090)).
- Automatic routing keeps eligible unsuffixed fallback models using the routed thinking level, while preserving explicit fallback efforts. Failed parallel routing cancels sibling routing requests before child admission ([#3103](https://github.com/bastani-inc/atomic/pull/3103)).
- Automatic model selection now works with strict Responses-schema providers while retaining exact model/effort pair validation.
- Automatic model routing allows up to three repairs after a malformed or schema-invalid answer, sharing the original decision deadline and never starting a child before a valid decision. Authentication/provider failures, cancellation and stale catalogs are not retried.
- In-process children inherit SDK model/auth configuration, settings, resource discovery and human-input callbacks without restoring parent-disabled packages or tools. Fallback keeps the same restrictions, startup runs once, and suppressed Intercom cannot mint supervisor grants ([#3105](https://github.com/bastani-inc/atomic/issues/3105)).
- All builtin specialists now include Intercom for live coordination, while preserving explicit parent tool and package restrictions.
- Automatic model routing uses dated benchmark records instead of full human guides. Jev bounds every comparison, including verbose catalogs below 255 options, without truncating tasks or weakening model constraints.

### Removed

- Removed the bundled `playwright-cli` skill and its reference guides in favor of the `agent-browser` skill.
- Removed the redundant `/feedback` prompt template. Use `/skill:feedback` to draft and submit feedback instead.

## [0.9.20-alpha.12] - 2026-09-24

### Changed

- Subagent orchestration guidance again makes workflows the default for non-trivial structured work with verifiable objectives, such as implementation, review, or retry pipelines, unless you ask for inline execution.
- The builtin `tdd` skill now checks every new test before it's written: it must name the behavior it protects, the regression that would break it, and why existing tests don't already catch that, and it can't need a production seam that exists only for the test. Bug regression tests must fail on the unfixed code first. The skill also covers reviewing and pruning existing tests: a list of low-value test patterns, a bar for which tests to keep, and a read-only, evidence-first audit workflow. It is adapted from OpenClaw's `test-audit` skill.

## [0.9.20-alpha.11] - 2026-09-24

### Changed

- Subagent orchestration guidance no longer lets an absence of workflow history, or history of only inline runs, push every task inline; the agent judges the task first and refines with execution history and your preferences.

## [0.9.20-alpha.9] - 2026-09-24

### Fixed

- A background subagent's intercom `ask` to its parent now reaches the parent as a normal intercom question, and the child waits for the reply. Previously it became a fresh-start handoff, which only a `subagent` call still waiting in the foreground can return, so the child stopped with `parent-handoff` and the question was lost. The handoff still applies while the parent waits in the foreground ([#3251](https://github.com/bastani-inc/atomic/issues/3251)).

## [0.9.20-alpha.7] - 2026-09-22

### Fixed

- A subagent with `model: "auto"` no longer fails to launch when routing inference fails completely (Jev and the chat structured-output fallback both). The child now runs on the current chat model with a reported warning when that model is available and satisfies every routing constraint; validation and conflicting-constraint failures and cancellation still stop the launch ([#3206](https://github.com/bastani-inc/atomic/issues/3206)).

## [0.9.20-alpha.6] - 2026-09-22

### Added

- Added the bundled `cua-driver` skill, vendored verbatim from [trycua/cua](https://github.com/trycua/cua) `libs/cua-driver/rust/Skills/cua-driver` at tag `cua-driver-rs-v0.28.2` (MIT, © 2025 Cua AI, Inc.), with all eight upstream files including the macOS, Windows, and Linux platform guides. Only the `SKILL.md` frontmatter is Atomic-owned. It teaches the `cua-driver` CLI's snapshot → act → fresh snapshot → verify loop for desktop, simulator, and emulator computer use, replacing the previous PyAutoGUI guidance ([#3181](https://github.com/bastani-inc/atomic/issues/3181)).

## [0.9.20-alpha.5] - 2026-09-20

### Changed

- Replaced the bundled `playwright-cli` skill with the `agent-browser` skill ([vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) v0.38.1) for browser automation, end-to-end UI checks, screenshots, and reviewable video recording. The `worker`, `debugger`, `code-simplifier`, `codebase-analyzer`, and `codebase-online-researcher` subagents now load `agent-browser` and drive the `agent-browser` command instead of `playwright-cli`.

- Subagent guidance now states that children can coordinate with each other, not only with the supervisor. The runtime Intercom bridge instruction, the orchestrator prompt guidance, the `subagent` skill, and the `worker` and `debugger` agent definitions describe when same-group siblings should use ordinary `intercom` `list`/`send`/`ask` to debate findings with evidence, hand off paths and reproductions, claim shared files or expensive steps, and learn what a sibling already verified, while `contact_supervisor` stays reserved for supervisor decisions and each child still returns its own result.

### Removed

- Removed the bundled `playwright-cli` skill and its reference guides in favor of the `agent-browser` skill.

## [0.9.20-alpha.4] - 2026-09-20

### Added

- Added opt-in `model: "auto"` for single tasks, parallel tasks and agent defaults. One bounded routing decision uses the current available model/effort pairs and shipped evaluation guidance, with the shared `routerModel` setting selecting routing inference. Invalid or stale decisions stop before child execution, and routing selection remains distinct from execution fallback metadata ([#3090](https://github.com/bastani-inc/atomic/issues/3090)).

### Changed

- All builtin agents now default to `model: "auto"` instead of pinned models and fallback chains. Explicit model overrides and builtin effort settings remain effective, including empty legacy `thinking` values that clear an inherited effort and fallback suffixes that override legacy defaults. Hard model constraints still apply to every candidate; main-chat and custom-agent defaults are unchanged.
- Automatic model selection ranks up to three distinct eligible models and tries them in order before remaining configured fallbacks and the current chat model, retaining each selected effort and skipping duplicate model IDs.
- Automatic model routing now receives `evals.md` as markdown tables of dated benchmark records rather than packed one-line rows.
- Orchestrator model-pinning guidance now treats `evals.md` as factual per-evaluation records and leaves unmatching catalogs unpinned instead of describing benchmark rows as recommendations.

### Fixed

- Automatic model routing with Jev no longer rejects catalogs above 255 eligible model/effort pairs. Every pair participates in a bounded tournament before final selection; context remains unchanged and any routing failure still prevents child launch ([#3090](https://github.com/bastani-inc/atomic/issues/3090)).
- Automatic routing keeps eligible unsuffixed fallback models using the routed thinking level, while preserving explicit fallback efforts. Failed parallel routing cancels sibling routing requests before child admission ([#3103](https://github.com/bastani-inc/atomic/pull/3103)).
- Automatic model selection now works with strict Responses-schema providers while retaining exact model/effort pair validation.
- Automatic model routing allows up to three repairs after a malformed or schema-invalid answer, sharing the original decision deadline and never starting a child before a valid decision. Authentication/provider failures, cancellation and stale catalogs are not retried.
- In-process children inherit SDK model/auth configuration, settings, resource discovery and human-input callbacks without restoring parent-disabled packages or tools. Fallback keeps the same restrictions, startup runs once, and suppressed Intercom cannot mint supervisor grants ([#3105](https://github.com/bastani-inc/atomic/issues/3105)).
- All builtin specialists now include Intercom for live coordination, while preserving explicit parent tool and package restrictions.
- Automatic model routing uses dated benchmark records instead of full human guides. Jev bounds every comparison, including verbose catalogs below 255 options, without truncating tasks or weakening model constraints.

### Removed

- Removed the redundant `/feedback` prompt template. Use `/skill:feedback` to draft and submit feedback instead.

## [0.9.20-alpha.2] - 2026-09-15

### Added

- Added `/feedback` to draft privacy-scrubbed bug reports and enhancements, investigate bugs with one debugger run, and post reviewed drafts through your `gh` login ([#2799](https://github.com/bastani-inc/atomic/issues/2799)).

## [0.9.19] - 2026-09-13

Cumulative release of the `0.9.19-alpha.2` through `0.9.19-alpha.6` prereleases. Per-change details remain in the unchanged prerelease sections below.

### Breaking Changes

- Renamed terminal control action `interrupt` to `kill`, including calls using `runId`. Replace `subagent({ action: "interrupt", id })` with `subagent({ action: "kill", id })`. The old action is rejected; killed children cannot resume and follow-up work requires a fresh launch.

### Added

- Added a searchable `/agents` catalog grouped by source with model, tool, description and prompt details.
- Added the builtin Herdr skill from upstream v0.9.0 with managed-pane safety checks and CLI guidance.

### Changed

- Session-bound launches return owner-bound task observations immediately by default. Explicit foreground observation and `action: "wait"` observe the same execution; yielding does not cancel children or consume additional execution slots ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Reduced default top-level parallel concurrency from 4 to 3. Explicit overrides remain honored; the per-parent native turn cap remains 4.
- Launch receipts, compact themed status cards and task details show readable outcomes, activity, elapsed time, tool/token counts and resolved model/reasoning settings, retaining identity through fallback and completion. Live transcripts subscribe to session events.
- Locator and pattern-finding agents use GPT-5.6 Luna at xhigh with Grok fallbacks at medium. Other agents explicitly select xhigh for OpenRouter Grok fallbacks. Debugger uses Astra and Fable at medium and Sol at high, preserving its fallback order.
- Delegation guidance keeps immediately blocking work local unless specialist expertise, isolation or an explicit request warrants a child. Parents overlap independent work and wait on dependencies rather than poll. Requests to work "quickly" select inline execution without hidden workflows or skipped validation.

### Fixed

- Intercom sends and asks interrupt working children and handle input in the same execution, including startup, preflight and settlement races, without relaunching or losing messages. Explicit abort and owner cancellation remain terminal.
- Parallel requests wait for correlated replies in the original requester without ending siblings or discarding queued work. Parent observation yielding does not change execution concurrency; exact group commits release foreground observations without replacing executions ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Published terminal state before child disposal so completed children reject asks they cannot answer. Bound transcripts retain exact Intercom targets, and same-child messages precede completion delivery.
- Fixed queued-child worktree and branch cleanup on cancellation or owner closure without removing live siblings' worktrees early.
- Preserved explicit kill during capacity waiting and parent-cancellation races, including grouped Intercom status. Status and kill accept returned owner-bound task IDs.
- Background cards display known model/reasoning settings at admission without guessing unresolved values. Browsing `/agents` is navigation and no longer reports a false approval or Herdr block.

## [0.9.19-alpha.6] - 2026-09-11

### Changed

- Delegation guidance now favors keeping immediately blocking work local unless specialist expertise, context isolation, or an explicit request warrants a child. Parents are guided to continue independent work and wait on dependencies rather than repeatedly polling. Background launch defaults and explicit foreground waits are unchanged.

## [0.9.19-alpha.5] - 2026-09-11

### Changed

- The bundled debugger now uses GPT-6 Astra at `medium`, with Astra/Fable 5.1/Fable 5 fallbacks at `medium` and Sol at `high`. Its complete fallback order, other model efforts, and all other bundled agent configurations remain unchanged.

## [0.9.19-alpha.4] - 2026-09-10

### Breaking Changes

- Renamed the terminal subagent control action from `interrupt` to `kill`. Replace `subagent({ action: "interrupt", id })` with `subagent({ action: "kill", id })`, including calls using `runId`. The old action is rejected, not aliased. Killed children cannot be resumed; launch a fresh child with explicit context for follow-up work. Command results and status report killed, while parent cancellation and lower-level host/native interruption retain their existing semantics.

### Fixed

- Preserved an explicit kill when parent cancellation arrives during execution-capacity waiting, without allowing a late kill to replace an earlier parent cancellation.
- Kept grouped Intercom cancellation status consistent when a killed child has parent-cancelled siblings, while retaining each child's outcome.
- Intercom `send` and `ask` interrupt a working foreground or background child immediately: its current model call or cancellable tool is cancelled and the message is handled in the same child execution without relaunch. Messages admitted during startup, consumed input preflight, overlapping SDK interrupt turns, or final settlement still join the original task rather than creating competing work or disappearing ahead of the result; explicit user abort and owner cancellation remain terminal.

## [0.9.19-alpha.3] - 2026-09-09

### Changed

- Reduced default top-level parallel subagent concurrency from 4 to 3. Explicit configuration and per-call overrides remain honored; the separate per-parent native turn cap remains 4.

## [0.9.19-alpha.2] - 2026-09-08

### Added

- Added `/agents` to browse and filter effective agent definitions by source, with model, tool, description, and prompt details.
- Added the builtin herdr skill from upstream v0.9.0 beside tmux, preserving its managed-pane safety checks and CLI guidance.

### Fixed

- Publish noninteractive execution termination before session disposal so completed, failed, interrupted, and cancelled children no longer accept Intercom asks they cannot answer. Follow-up work requires a fresh child; live asks and send behavior are preserved.
- Already-admitted in-process task callers now yield each active foreground sibling's observation on an exact Intercom group commit without ending or replacing the original executions ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Status and interrupt now accept owner-bound task IDs returned by launches, and wait results use readable observation summaries. Corrected foreground-only claims in orchestrator guidance, the bundled delegation and terminal skills, and the README. Agents can choose foreground-first or background observation; automatic yielding preserves the original execution.
- Bound task transcript sources now retain the trusted run and actual Intercom target so queued child messages are delivered before owner-bound completion notices, without guessing from task or SDK session IDs.
- Parallel Intercom asks and supervisor decisions/interviews now wait in the original requester without ending siblings. Foreground coordination releases observations, not execution slots; queued siblings survive and start once capacity is free. Targeted interruption and owner/batch cancellation remain separate.
- Fixed parallel worktree cleanup after a queued child is cancelled or its session/workflow-stage owner closes. Cleanup now includes never-started children without removing live siblings' worktrees early, for both foreground and background observations.
- Background launch cards now show the concrete model and known reasoning level already selected at admission, including inherited defaults, before child session startup. Unresolved settings are not guessed, and later session and fallback updates remain authoritative.
- Marked the read-only `/agents` catalog as navigation so browsing no longer creates a false approval wait or Herdr blocked status.

### Changed

- Locator and pattern-finding agents now use GPT-5.6 Luna at xhigh with Grok fallbacks at medium. Other bundled agents explicitly select xhigh for OpenRouter Grok fallbacks.
- Owner-bound task reports and foreground/background result receipts now retain resolved model and reasoning settings across fallback and completion. Live transcript viewers subscribe to session events without publishing high-frequency task-status updates.
- Session-bound launches now return task observations immediately by default. Independent parallel launches admit queued slots under their concurrency limit; explicit foreground groups retain Intercom yielding. Owner-scoped `action:"wait"` observes the same child; terminal completion uses a nonvisual persisted envelope ([#2884](https://github.com/bastani-inc/atomic/pull/2884)).
- Subagent tool results now summarize launch observations and agent discovery instead of displaying raw task receipts or full catalog dumps by default. Parallel receipts show numbered sibling rows and errors; expanded results retain task identities. Owner-task progress includes recorded elapsed time, tool/token counts, and concise current-tool arguments.
- In-process status cards now show compact, theme-aware agent rows with state symbols instead of repeated run IDs and raw residency text. Expanding reveals all children and diagnostic metadata; narrow terminals preserve readable status labels.
- Orchestration guidance honors requests to work "quickly" as inline execution, without spawning a hidden or nested workflow or dropping validation requirements.

## [0.9.18] - 2026-09-05

Cumulative release of the `0.9.18-alpha.6` prerelease. Per-change details remain in the unchanged prerelease section below.

### Breaking Changes

- Removed `fastMode` from result, progress, runtime, artifact, and run-history metadata. Select fast inference with a canonical `-fast` model ID in model or fallback fields, such as `openai-codex/gpt-5.6-sol-fast:medium`.

### Changed

- Labels show the complete selected model ID without a separate fast badge.
- Bundled agents use GPT-6 Astra at low, with debugger at xhigh. Added Astra and Claude Fable 5.1 fallbacks ahead of older models, and aligned locator fallback chains with ordinary agents, including Sol, GPT-5.5, and Opus 4.8 at medium.
- The qlty skill follows repository/user priorities, preserves authoritative checks and read-only boundaries, supports offline/manual setup, and distinguishes prepared configuration from executed checks.
- Default guidance honors task-scoped inline/no-workflow requests while retaining testing, review, safety, and reconciliation of active workflow effects. Model selection for unpinned agents consults task-specific measured evals alongside role guidance.

### Fixed

- Completing workflow stages cancel their still-running single, parallel, and detached subagents. Children retain interrupted/abort outcomes and cleanup, late findings no longer reach parent chat, and exact ownership preserves other stages' traffic. Already-submitted Intercom sends keep receipts/retry identities; detached children still notify while their owning stage is live ([#2840](https://github.com/bastani-inc/atomic/issues/2840)).

## [0.9.18-alpha.6] - 2026-09-04

### Breaking Changes

- Removed the redundant `fastMode` fields from subagent result, progress, runtime metadata, persisted artifact metadata, and run-history records. Agents now select fast inference by pinning a canonical `-fast` model ID in `model` or fallback model fields, for example `openai-codex/gpt-5.6-sol-fast:medium`.

### Changed

- Subagent labels now render the complete selected model ID, including `-fast`, without appending a separate `fast` badge.
- Updated bundled agents to GPT-6 Astra at `low`, with debugger at `xhigh`. Added Astra and Claude Fable 5.1 provider fallbacks ahead of older models. Locator roles now use the same ordered fallback chain as the other ordinary agents, including Sol, GPT-5.5, and Opus 4.8 at `medium`.

- The qlty skill now selects checks from repository/user priorities, preserves existing tools and read-only boundaries, and supports manual offline configuration when initialization or installation is unavailable. It separates prepared configuration from executed checks without weakening authoritative project validation.
- Subagent default guidance now honors task-scoped inline/no-workflow requests, including complex work, while preserving testing, review, safety and reconciliation of active workflow effects.
- Orchestrator guidance for agents without a declared model now cites the measured per-evaluation scores in `packages/coding-agent/docs/models/evals.md` by task type, in addition to the role guidance in `model-selection.md`.

### Fixed

- Workflow stages now cancel their still-running subagents at completion, including single and parallel children detached for Intercom coordination. Cancelled children keep the `interrupted` status, `cause: "abort"`, and normal cleanup. Late findings and completion notifications from those children no longer reach the parent/main chat. Exact run ownership preserves other stages' child traffic, and already-submitted Intercom sends retain their transport receipts and retry identities. Detached children still notify normally while their owning stage is live ([#2840](https://github.com/bastani-inc/atomic/issues/2840)).

## [0.9.16] - 2026-08-29

Cumulative release of the `0.9.16-alpha.1` – `0.9.16-alpha.11` prereleases. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease sections below.

### Breaking Changes

- Removed the public `subagent({ action: "resume" })` action and its `index`/`message` inputs. Completed, interrupted, and parent-question children are terminal; migrate follow-ups to a fresh `subagent({ agent, task })` launch with explicit `[TASK_CONTEXT]` and expect a new run identity ([#2604](https://github.com/bastani-inc/atomic/issues/2604)).
- Removed the `subagent({ action: "doctor" })` management action and the `/subagents-doctor` slash command. `doctor` is no longer a valid `action` value, and the observing management actions available to a child are now `list`, `get`, and `status`. Agent discovery still reports invalid-frontmatter files through its load diagnostics; use `intercom({ action: "status" })` to inspect intercom bridge state.
- Removed the `/run` and `/parallel` slash commands. Launch children with the `subagent` tool (`{ agent, task }` or `{ tasks: [...] }`).
- Removed `diagnoseIntercomBridge` and the `IntercomBridgeDiagnostic` type. Use `resolveIntercomBridge` when you need bridge availability.

### Added

- New bundled `qlty` skill for code-quality verification through the [qlty](https://qlty.sh) CLI: linting (`qlty check`), auto-formatting (`qlty fmt`), maintainability metrics (`qlty metrics`), and code smells such as duplication and deep nesting (`qlty smells`). The skill triggers on requests for verifiers or high code quality, directs the agent to `https://docs.qlty.sh/llms.txt` as the authoritative documentation index, instructs it to enable the qlty plugins and linter extensions that fit the codebase rather than invoking per-tool linters ad hoc, and ships source-attributed reference excerpts under `skills/qlty/references/`.

### Changed

- Explicit child extension allowlists and legacy `enabled: false` Intercom config no longer remove ordinary `intercom` or suppress authorized subagent supervisor bridging. `contact_supervisor` remains admitted only to delegated children.
- Added the full and Flash GLM-5.3 direct Z.AI, Z.AI Coding Plan, Baseten, and OpenRouter routes to every built-in subagent fallback chain.
- Foreground subagent completion, failure, and interruption notifications now render as status-colored tool blocks while preserving their result preview, expansion hint, duration, and session path.
- Parent-targeted `contact_supervisor` and Intercom asks now end the child and return the verbatim question, ordered attachments, agent identity, and a dynamic fresh-child handoff. Parallel asks no longer retain sibling sets for bare-run-ID continuation ([#2604](https://github.com/bastani-inc/atomic/issues/2604)).

### Fixed

- Entitled GitHub Copilot subagents now inherit the launching chat or workflow-stage fast-mode scope for both dispatch and model labels, including thinking-suffixed models, fallbacks, and parallel foreground runs. Copilot labels append `fast` exactly when the request uses the account-advertised fast sibling; disabled or ineligible attempts keep the base model without a stale marker.
- Subagent fast-mode metadata now keeps the resolved model API for provider aliases on the Codex Responses transport, so live and completed labels match dispatch for those aliases.
- Parent cancellation of a foreground in-process child now finishes as a terminal interrupted/abort outcome instead of `error` / failed. Parent receipts, Intercom summaries, and progress present the child as cancelled; persisted metadata keeps `status: "interrupted"` with `cause: "abort"` rather than a new public status. The run stays non-retryable, preserves any fallback metadata already recorded before abort, and recovers bounded partial findings from a modified run-scoped `progress.md`, then the last non-empty assistant text, then a cancellation notice with artifact references. Session, Progress, and Output paths are cited only when those files exist when the cancelled envelope or receipt is built. A queued child that never started does not claim "0 tool calls"; a mixed completed-and-cancelled set reports `Status: cancelled` rather than `interrupted`. A mixed parallel set that contains both a user interrupt and a parent cancellation presents the cancellation summary rather than interrupt-specific follow-up guidance ([#2635](https://github.com/bastani-inc/atomic/issues/2635)).
- In-process subagent children no longer load the workflows extension or expose its `workflow` tool. Child sessions still receive bundled workflow definitions as resources, but they cannot rebind the parent session's workflow store, strand active runs, or disconnect the parent's `BACKGROUND` panel and run controls.
- Coalesced same-turn sibling `subagent` execution calls into one indexed parallel run instead of rejecting every call after the first. Live result, progress, control, and artifact updates and final results stay route-local without sibling data, while the TUI redraws the shared run as one aggregate parallel widget. Solitary, sequential, management, and true-overlap behavior remains unchanged ([#2588](https://github.com/bastani-inc/atomic/issues/2588)).

### Removed

- Removed every packaged subagent prompt template, including `/parallel-review`, `/parallel-handoff-plan`, `/gather-context-and-clarify`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, and `/parallel-cleanup`. Compose those passes directly with `subagent(...)` or a workflow.

## [0.9.16-alpha.11] - 2026-08-28

### Changed

- Explicit child extension allowlists and legacy `enabled: false` Intercom config no longer remove ordinary `intercom` or suppress authorized subagent supervisor bridging. `contact_supervisor` remains admitted only to delegated children.

### Fixed

- Entitled GitHub Copilot subagents now inherit the launching chat or workflow-stage fast-mode scope for both dispatch and model labels, including thinking-suffixed models, fallbacks, and parallel foreground runs. Copilot labels append `fast` exactly when the request uses the account-advertised fast sibling; disabled or ineligible attempts keep the base model without a stale marker.
- Subagent fast-mode metadata now keeps the resolved model API for provider aliases on the Codex Responses transport, so live and completed labels match dispatch for those aliases.

## [0.9.16-alpha.10] - 2026-08-28

### Changed

- Added the full and Flash GLM-5.3 direct Z.AI, Z.AI Coding Plan, Baseten, and OpenRouter routes to every built-in subagent fallback chain.

## [0.9.16-alpha.7] - 2026-08-26

### Added

- New bundled `qlty` skill for code-quality verification through the [qlty](https://qlty.sh) CLI: linting (`qlty check`), auto-formatting (`qlty fmt`), maintainability metrics (`qlty metrics`), and code smells such as duplication and deep nesting (`qlty smells`). The skill triggers on requests for verifiers or high code quality, directs the agent to `https://docs.qlty.sh/llms.txt` as the authoritative documentation index, instructs it to enable the qlty plugins and linter extensions that fit the codebase rather than invoking per-tool linters ad hoc, and ships source-attributed reference excerpts under `skills/qlty/references/`.

## [0.9.16-alpha.5] - 2026-08-26

### Changed

- Foreground subagent completion, failure, and interruption notifications now render as status-colored tool blocks while preserving their result preview, expansion hint, duration, and session path.

### Fixed

- Parent cancellation of a foreground in-process child now finishes as a terminal interrupted/abort outcome instead of `error` / failed. Parent receipts, Intercom summaries, and progress present the child as cancelled; persisted metadata keeps `status: "interrupted"` with `cause: "abort"` rather than a new public status. The run stays non-retryable, preserves any fallback metadata already recorded before abort, and recovers bounded partial findings from a modified run-scoped `progress.md`, then the last non-empty assistant text, then a cancellation notice with artifact references. Session, Progress, and Output paths are cited only when those files exist when the cancelled envelope or receipt is built. A queued child that never started does not claim "0 tool calls"; a mixed completed-and-cancelled set reports `Status: cancelled` rather than `interrupted`. A mixed parallel set that contains both a user interrupt and a parent cancellation presents the cancellation summary rather than interrupt-specific follow-up guidance ([#2635](https://github.com/bastani-inc/atomic/issues/2635)).
- In-process subagent children no longer load the workflows extension or expose its `workflow` tool. Child sessions still receive bundled workflow definitions as resources, but they cannot rebind the parent session's workflow store, strand active runs, or disconnect the parent's `BACKGROUND` panel and run controls.

## [0.9.16-alpha.2] - 2026-08-23

### Breaking Changes

- Removed the `subagent({ action: "doctor" })` management action and the `/subagents-doctor` slash command. `doctor` is no longer a valid `action` value, and the observing management actions available to a child are now `list`, `get`, and `status`. Agent discovery still reports invalid-frontmatter files through its load diagnostics; use `intercom({ action: "status" })` to inspect intercom bridge state.
- Removed the `/run` and `/parallel` slash commands. Launch children with the `subagent` tool (`{ agent, task }` or `{ tasks: [...] }`).
- Removed `diagnoseIntercomBridge` and the `IntercomBridgeDiagnostic` type. Use `resolveIntercomBridge` when you need bridge availability.

### Removed

- Removed every packaged subagent prompt template, including `/parallel-review`, `/parallel-handoff-plan`, `/gather-context-and-clarify`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, and `/parallel-cleanup`. Compose those passes directly with `subagent(...)` or a workflow.


## [0.9.16-alpha.1] - 2026-08-23

### Breaking Changes

- Removed the public `subagent({ action: "resume" })` action and its `index`/`message` inputs. Completed, interrupted, and parent-question children are terminal; migrate follow-ups to a fresh `subagent({ agent, task })` launch with explicit `[TASK_CONTEXT]` and expect a new run identity ([#2604](https://github.com/bastani-inc/atomic/issues/2604)).

### Changed

- Parent-targeted `contact_supervisor` and Intercom asks now end the child and return the verbatim question, ordered attachments, agent identity, and a dynamic fresh-child handoff. Parallel asks no longer retain sibling sets for bare-run-ID continuation ([#2604](https://github.com/bastani-inc/atomic/issues/2604)).

### Fixed
- Coalesced same-turn sibling `subagent` execution calls into one indexed parallel run instead of rejecting every call after the first. Live result, progress, control, and artifact updates and final results stay route-local without sibling data, while the TUI redraws the shared run as one aggregate parallel widget. Solitary, sequential, management, and true-overlap behavior remains unchanged ([#2588](https://github.com/bastani-inc/atomic/issues/2588)).

## [0.9.15] - 2026-08-21

Cumulative release of the `0.9.15-alpha.1` prerelease. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease section below.

### Breaking Changes

- Subagent delegation is now fixed at one level. A top-level chat or workflow stage may launch subagents, but a subagent child may not launch, resume, or interrupt another child. Read-only management actions remain available, and the executor plus Rust admission boundary both enforce the rule.

### Removed

- Removed the extension config and agent frontmatter options for delegation depth. Stale keys remain parseable and are ignored; agent-management rewrites strip the old frontmatter field.
- Removed inherited per-child delegation limits and the unreachable multi-level nested-run transport, registry, recursive status, and result payload fields. Direct-child status and results remain unchanged, and startup still cleans route directories left by older versions.

### Changed

- Switched the optional peer from `@earendil-works/pi-ai` to `@bastani/pi-ai`.
- Updated the fanout-child boundary prompt to reflect that child delegation is unavailable.
- Replaced built-in `gpt-5.6-luna:max` primary and fallback pins with `gpt-5.6-sol`, using `:medium` for worker and analysis agents and `:low` for locator and pattern agents.

## [0.9.15-alpha.1] - 2026-08-21

### Breaking Changes

- Subagent delegation is now exactly one level deep and is no longer configurable. A top-level session — main chat or a workflow stage — may call the `subagent` tool; a session that was itself admitted as a subagent child may not. Every launch, `resume`, and `interrupt` attempted from inside a child is refused with a single fixed message; the observing actions `list`, `get`, `status`, and `doctor` remain available to a child. Workflow stages are unchanged and still delegate once. The Rust `SubagentControl` admission door now refuses any child deeper than the single permitted level, and the executor refuses a child before any run starts, so the rule holds at both doors.

### Removed

- Removed the extension config option that set the delegation ceiling. Existing `config.json` files that still declare it are ignored rather than rejected.
- Removed the per-agent nesting-depth frontmatter field. An agent `.md` file that still declares the key parses and loads normally rather than being rejected; the key is no longer read, no longer re-emitted, and no longer printed in `subagent({ action: "get" })` output, and `create`/`update` no longer validate or clamp it. An agent-management rewrite of such a file strips the stale key, matching how earlier removed frontmatter keys are handled.
- Removed the nesting-depth clause from the `subagent` tool's `config` parameter description.
- Removed the per-child delegation limit from the typed admission policy, the in-process child spec, retained foreground resume records, and the run options. Admitted depth alone now decides whether a session may delegate.
- Removed the multi-level nested-run pipeline: the temp-directory route, its event sink and control inbox, the run registry and its recursive projection, and the recursive status renderer. Its inherited-route resolvers had already been permanently disabled, so no event could reach any of it and `subagent({ action: "status" })` never printed a nested line; live and retained status output for a parent's own direct children is unchanged. Delegating no longer creates a per-run temp route directory. Startup still reaps route directories left by earlier versions.
- Removed the nested run summary, run address, step summary, and route types, along with their public projections, from the subagent result payload. `SubagentResultIntercomChild` no longer carries a `children` array and `ControlEvent` no longer carries a nested run id or nesting path; result receipts no longer contain a "Nested subagents:" section. A parent still receives one entry per direct child.

### Changed

- Switched the optional peer from `@earendil-works/pi-ai` to `@bastani/pi-ai`.
- The fanout-child boundary prompt no longer tells an authorized child that it may delegate, because no child can.
- Replaced built-in `gpt-5.6-luna:max` primary and fallback pins with `gpt-5.6-sol` at the same thinking level as each agent's `gpt-5.5` fallback: `:medium` for `worker`, `code-simplifier`, `codebase-analyzer`, `codebase-online-researcher`, and `codebase-research-analyzer`; `:low` for `codebase-locator`, `codebase-pattern-finder`, and `codebase-research-locator`.

## [0.9.14] - 2026-08-19

Cumulative release of the `0.9.14-alpha.2` – `0.9.14-alpha.5` prereleases. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease sections below.

### Added

- Added pure progress-trend evidence and injected control score-series support that can raise wall-clock attention priority without creating failure states, suppressing signals, or scheduling model calls ([#2489](https://github.com/bastani-inc/atomic/issues/2489)).
- Agent frontmatter accepts YAML array-form `tools` — flow sequences (`tools: [read, bash]`) and block sequences (`tools:` followed by `- read` lines) — as well as the comma-separated string form, and both spellings produce the same tool set.
- Extra frontmatter fields round-trip losslessly through the YAML emitter when agent files are rewritten. Sequences now serialize as block collections with hostile keys quoted, so a rewritten file can no longer fail YAML parsing and silently disappear from later scans.
- In-process children resolve `skills` through the live loader catalog, so source-qualified selectors such as `tdd@builtin` inject the shadowed candidate instead of the precedence winner. Missing or ambiguous selectors are reported on the child result. The parent-only `subagent` orchestration skill remains unavailable, including qualified aliases such as `subagent@builtin` ([#2328](https://github.com/bastani-inc/atomic/issues/2328)).

### Changed

- Raised every built-in subagent Grok 4.6 fallback from `xai/grok-4.6:high` to `xai/grok-4.6:xhigh` and added the matching `github-copilot/grok-4.6:xhigh` twin immediately after each xAI id.

### Fixed

- A subagent that pins no model of its own now inherits the dispatching session's thinking level alongside its model, matching the parent's tool configuration inheritance. The agent's declared `thinking` and any candidate `:level` suffix still take precedence.
- In-process JSONL event artifacts now honor `includeJsonl: false` and enforce the existing 50 MiB cap when enabled, preventing unbounded artifact growth ([#2445](https://github.com/bastani-inc/atomic/issues/2445)).
- Migrated all built-in subagent GLM fallbacks to direct Z.AI `glm-5.3:high` entries, omitting unavailable OpenRouter GLM-5.3 fallbacks ([#2459](https://github.com/bastani-inc/atomic/issues/2459)).

## [0.9.14-alpha.5] - 2026-08-19

### Added

- Added pure progress-trend evidence and injected control score-series support that can raise wall-clock attention priority without creating failure states, suppressing signals, or scheduling model calls ([#2489](https://github.com/bastani-inc/atomic/issues/2489)).

## [0.9.14-alpha.3] - 2026-08-17

### Changed

- Raised every built-in subagent Grok 4.6 fallback from `xai/grok-4.6:high` to `xai/grok-4.6:xhigh` and added the matching `github-copilot/grok-4.6:xhigh` twin immediately after each xAI id.

## [0.9.14-alpha.2] - 2026-08-17

### Added

- Agent frontmatter accepts YAML array-form `tools` — flow sequences (`tools: [read, bash]`) and block sequences (`tools:` followed by `- read` lines) — as well as the comma-separated string form, and both spellings produce the same tool set. Frontmatter parses through the same YAML-backed parser Atomic exports, so legal multi-line flow sequences and zero-indent block lists work, and sequence values where a scalar belongs are ignored rather than stringified.
- Extra frontmatter fields round-trip losslessly through the YAML emitter when agent files are rewritten. Hand-joined flow sequences previously corrupted items containing `#`, commas, brackets, colons, quotes, or boolean-like strings, and a rewritten file could fail YAML parsing so the agent silently disappeared from later scans; sequences now serialize as block collections with hostile keys quoted.
- In-process children resolve `skills` through the live loader catalog, so source-qualified selectors such as `tdd@builtin` inject the shadowed candidate instead of the precedence winner. Missing or ambiguous selectors are reported on the child result. The parent-only `subagent` orchestration skill remains unavailable, including qualified aliases such as `subagent@builtin` ([#2328](https://github.com/bastani-inc/atomic/issues/2328)).

### Fixed

- A subagent that pins no model of its own now inherits the dispatching session's thinking level alongside its model, matching the parent's tool configuration inheritance. The agent's declared `thinking` and any candidate `:level` suffix still take precedence.
- In-process JSONL event artifacts now honor `includeJsonl: false` and enforce the existing 50 MiB cap when enabled, preventing unbounded artifact growth ([#2445](https://github.com/bastani-inc/atomic/issues/2445)).
- Migrated all built-in subagent GLM fallbacks to direct Z.AI `glm-5.3:high` entries, omitting unavailable OpenRouter GLM-5.3 fallbacks. Baseten's separate GLM-5.2 exception is not part of these subagent chains ([#2459](https://github.com/bastani-inc/atomic/issues/2459)).

## [0.9.13] - 2026-08-13

Cumulative release of the `0.9.13-alpha.1` – `0.9.13-alpha.3` prereleases. The summary below covers the user-visible outcome of that work; the per-change detail remains in the prerelease sections below.

### Breaking Changes

- **Subagents no longer run in OS child processes, and no longer run in the background.** Every call executes in the foreground as an in-process child of the parent session. The `subagent` tool rejects `async: true`, `/run --bg` and the related background slash flags are gone, and the `asyncByDefault` and `forceTopLevelAsync` settings have been removed — delete those keys from user configuration. `/run` and `/parallel` return their results directly; foreground Intercom coordination and resumable interrupt/resume controls remain ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- **Removed CHAIN execution mode from the `subagent` tool.** Only SINGLE (`{agent, task?, progress?}`) and top-level PARALLEL (`{tasks: [...], concurrency?, worktree?}`) remain. The `chain` parameter is gone from the schema, so a call that still passes it is rejected by ordinary schema validation rather than by a migration shim. Also removed with no replacement: sequential chain steps, static parallel steps inside a chain, dynamic fan-out (`expand` / `collect` / `as` / `{outputs.name}`), the `{previous}` and `{chain_dir}` template variables and chain-scoped `{task}` substitution, the `chainName` and `chainDir` parameters, and saved chain definitions in `.chain.md` / `.chain.json`. Migrate a sequential chain to successive `subagent` calls that pass each step's result forward in the task text, and an in-chain parallel step to a top-level PARALLEL call.
- **Removed the `/chain` and `/run-chain` slash commands.** `/run` and `/parallel` are unchanged apart from the dropped `--bg` flag. Re-express a saved `.chain.md` workflow as `/run` and `/parallel` invocations, or as an `@bastani/workflows` workflow, which keeps first-class sequential composition through `ctx.chain(...)`.
- **Action required: delete leftover `.chain.md` files from your agents directories.** Saved-chain discovery is gone, so agent discovery no longer recognises — or skips — the `.chain.md` suffix. A leftover file carries `name` and `description` frontmatter, so it now loads as an ordinary agent and appears in `subagent list`, `/run` completions, and agent management.
- Removed the `ATOMIC_SUBAGENT_*` process-era environment bridge variables and the synthesized numeric child-result exit-code protocol (`0/1/-1/-2/143`). Child identity, policy, supervisor capability, and terminal outcomes now cross typed admission; results use a required `status` (`ok | error | skipped | interrupted | continued`) plus `cause` and `stats` ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Added

- Added the in-process subagent control plane and `InProcessChildRunner` foundation, backed by the Rust N-API registry, with typed statuses, session statistics, and bounded result envelopes ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Changed

- In-process admission resolves child management and fanout capabilities, MCP direct-tool selection, Intercom identity, prompt boundaries, project-context and inherited-skill filtering, and the nesting depth limit as one typed policy carried into the session and the tool executor. A restricted child cannot create, update, or delete agent definitions, fanout authorization cannot be widened by a descendant, and a supervisor grant is never inherited through environment ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Nested children route live `interrupt` and cold `resume` through the Rust control plane. Nested event and control records use an in-memory host route while keeping the validated file shape for cold-start compatibility, session JSONL is flushed before forced interruption, and the former 200 ms nested-control polling loop is replaced by event-driven delivery ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Children advance through their model-fallback ladder via the SDK session's `fallbackModels`, the exact classification, same-model retry, and candidate-advancement behavior main chat and workflow stages converged on. Pre-spawn auth filtering still builds the ladder, and results report the effective `model`, `attemptedModels`, and skipped pre-spawn attempts ([#2170](https://github.com/bastani-inc/atomic/issues/2170), [#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Unnamed subagent sessions expose runtime-only `subagent-chat-<full-id>` Intercom aliases, so supervisor targeting uses the full session ID.
- Subagent worktree Git and setup-hook commands and optional global npm probes now receive `AI_AGENT=atomic` for generic child-process attribution, without mutating caller-supplied environment objects.

### Fixed

- Fixed a fork-context subagent ignoring its agent's configured model. The selected candidate was only ever a `provider/model[:thinking]` string, so nothing reached the child session's `model` argument and the session fell back to the model in the session file — for a fork, the parent's. A child declaring `openai-codex/gpt-5.6-luna:max` therefore ran every turn on the parent's model, and an explicit `model:` override lost its first attempt the same way. The candidate is now resolved against the model registry and applied to the child session together with its thinking level, for fresh and fork contexts across single, parallel, and resume paths.
- Fixed every `subagent` action being refused with "Subagent fanout is not authorized for this child." for a child without fanout authorization. The fanout check ran before the management branch, so the observing actions — `list`, `get`, `status`, `doctor` — were rejected with a message about delegation they do not perform, and mutating management was refused by a gate the bug made unreachable. Those four now pass, while `resume` and `interrupt` correctly receive the fanout refusal ([#2220](https://github.com/bastani-inc/atomic/pull/2220), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Fixed the in-process depth guard and nested workflow-stage children. Admission-issued child depth travels in the typed policy into every path, an agent definition's narrower `maxSubagentDepth` is preserved across cold reload and resume, and in-process children load the bundled package resources needed to register `subagent` instead of starting with only the base built-in tools ([#2220](https://github.com/bastani-inc/atomic/pull/2220), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Reduced redundant live subagent repaints by publishing progress only for widget-visible milestones. The runner had published `AgentProgress` from a catch-all over every child session event, including streaming deltas, so a subagent expanded with Ctrl+O repainted for the whole run, and each repaint above the terminal fold costs a pi-tui full redraw that clears scrollback. Measured against a 20-second replay in tight geometry, scrollback clears drop from 23 to 3. A genuine above-fold milestone change can still require that redraw; that path is upstream (earendil-works/pi#4785, #7194) ([#2213](https://github.com/bastani-inc/atomic/pull/2213), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Fixed running widgets and result rows dropping the child's effective reasoning level and Codex fast-mode marker. Resolved model, thinking, and applied fast-mode metadata now travel from launch through fallback to completion, and workflow-stage children keep the real orchestration context so eligible requests get `service_tier: "priority"` ([#2335](https://github.com/bastani-inc/atomic/issues/2335), [#2336](https://github.com/bastani-inc/atomic/issues/2336)).
- Fixed progress and status lines stripping the provider prefix from the model name, so a child rendered as `claude-fable-5` where the main chat showed `anthropic/claude-fable-5`. The full model id is displayed, including every segment of a routed id; known thinking suffixes are still split into the `thinking <level>` label.
- Fixed `/run`, `/parallel`, and prompt-template requests waiting forever when an extension reload or session replacement made their response runtime stale after a long child run. Stale drops are classified through the host's exported predicate and reject the request's settlement path, bridge shutdown uses a distinct terminal error so ordinary deactivation renders a failure result, and completion, authorization, notification, and continuation paths all consume the host predicate instead of copying its marker.
- Fixed in-process parallel siblings colliding on the same canonical identity and terminal artifact path, and fixed repeated collapsed-tool-output requests from launch paths forcing an already-collapsed host transcript to update.
- Exposed `registerPromptTemplateBridgeRequestSettlement` from `@bastani/subagents` for the separately installed `pi-prompt-template-model` emitter, which owns a different extension runtime and cannot be registered by Atomic.

### Removed

- Removed every remaining OS child-process code path from subagent execution: the detached jiti async runner and its twelve `subagent-runner*` modules, the `async-execution-*` spawn layer, the async event journal, the idle/wall attempt watchdog, the stdout drain grace, the CLI spawn resolver, the environment-bridge builder, and the post-exit stdio guard ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Removed every chain-only implementation surface: the chain execution engine and its step runners, chain output bindings and named-output resolution, the chain serializer and saved-chain discovery, the saved-chain slash mapping, chain TUI graph rendering, chain reporting in `subagent doctor`, and the chain types, results, settings, and formatters. Agent discovery now treats every `.md` file in an agents directory uniformly.

## [0.9.13-alpha.3] - 2026-08-13

### Breaking Changes

- The `subagent` tool no longer accepts `async: true`, `/run --bg` and related background slash flags are gone, and the `asyncByDefault` and `forceTopLevelAsync` settings have been removed. Remove those settings keys from user configuration; subagent calls now run in the foreground.

### Changed

- Unnamed subagent sessions now expose runtime-only `subagent-chat-<full-id>` Intercom aliases so supervisor targeting uses the full session ID.

### Fixed

- Fixed a fork-context subagent ignoring its agent's configured model. The selected model candidate was only ever a `provider/model[:thinking]` string, so nothing was handed to the child session's `model` argument and the session fell back to the model persisted in the session file — which, for a fork, is the parent's. A child declaring `openai-codex/gpt-5.6-luna:max` therefore ran every turn on the parent's model, and an explicit `model:` override lost its first attempt the same way. The selected candidate is now resolved against the model registry and applied to the child session, together with the thinking level carried in the candidate's suffix, for both fresh and fork contexts and across single, parallel, and resume paths. A candidate that names no usable model still starts the run instead of failing it.
- Fixed subagent progress and status lines stripping the provider prefix from the model name, so a child rendered as `claude-fable-5` where the main chat shows `anthropic/claude-fable-5`. The full model id is now displayed, including every segment of a routed id such as `openrouter/anthropic/claude-fable-5`; known thinking suffixes are still split off into the `thinking <level>` label.

### Removed

- Removed subagent async/background execution and its process-era job, widget, schema, configuration, and slash-command surfaces. `subagent` calls and `/run` or `/parallel` now execute in the foreground and return their results directly; foreground Intercom coordination and resumable interrupt/resume controls remain available.

## [0.9.13-alpha.2] - 2026-08-12

### Breaking Changes

- **Removed CHAIN execution mode from the `subagent` tool.** The tool now supports only SINGLE (`{agent, task?, progress?}`) and top-level PARALLEL (`{tasks: [...], concurrency?, worktree?}`) execution. The `chain` parameter is gone from the tool schema, so a call that still passes it is rejected by ordinary schema validation rather than by a migration shim — there is no deprecation path. This also removes, with no replacement: sequential chain steps; static parallel steps inside a chain (`{parallel: [...]}` as a chain step); dynamic fan-out steps (`expand` / `collect` / `as` / `{outputs.name}`), which were **not** ported to top-level PARALLEL mode; the chain template variables `{previous}` and `{chain_dir}` and chain-scoped `{task}` substitution; the `chainName` and `chainDir` parameters; and saved chain definitions in `.chain.md` / `.chain.json` files under `~/.atomic/agent/chains/` and `.atomic/chains/`, along with their discovery, parsing, serialization, and management actions. Migrate a sequential chain to successive `subagent` calls, passing each step's result forward in the task text yourself; migrate an in-chain parallel step to a top-level PARALLEL call. Agent definitions, agent management, and every other mode are unaffected.
- **Removed the `/chain` and `/run-chain` slash commands.** `/run` (single) and `/parallel` (top-level parallel) are unchanged, including their `--bg` and `--fork` flags. `/run-chain`, which launched a saved `.chain.md` workflow directly, has no replacement; re-express the workflow as `/run` and `/parallel` invocations, or as an `@bastani/workflows` workflow, which keeps first-class sequential composition through `ctx.chain(...)`.
- **Action required: delete leftover `.chain.md` files from your agents directories.** Saved-chain discovery is gone, so agent discovery no longer recognises — or skips — the `.chain.md` suffix. A leftover `.chain.md` file carries `name` and `description` frontmatter, so it now loads as an ordinary agent and appears in `subagent list`, `/run` completions, and agent management. Delete or move those files. Restoring a `.chain.md` exclusion was considered and rejected: it would keep saved-chain knowledge alive in shipped code, which this removal is meant to end.

### Removed

- Removed every chain-only implementation surface: the chain execution engine and its sequential, parallel, and dynamic-fan-out step runners; chain output bindings and named-output resolution; the chain serializer and saved-chain discovery, including the `.chain.md` exclusion in agent discovery; the saved-chain slash mapping; chain TUI graph rendering and the chain workflow-graph model; chain async/background run handling; chain reporting in `subagent doctor`; and the chain types, results, settings, and formatters. Agent discovery now treats every `.md` file in an agents directory uniformly.

### Changed

- Subagent worktree Git/setup-hook commands and optional global npm probes now receive `AI_AGENT=atomic` for generic child-process attribution without mutating caller-supplied environment objects.

### Fixed

- Fixed repeated collapsed-tool-output requests from subagent launch paths forcing an already-collapsed host transcript to update.
- Fixed detached subagent completions and terminal notifications that finish after an extension reload. Stale event-bus emits are now best-effort, and notification ownership moves to the replacement API after invalidation while a rejected same-API registration leaves its existing subscription intact.
- Fixed stale-context checks in detached completion, authorization, notification, and in-process continuation paths by consuming the host's exported predicate instead of copying its error-message marker.
- Fixed failed replacement of a background completion subscription leaving a registry entry after activation abort; the new subscription is rolled back before the cleanup error escapes.
- Fixed `/run`, `/parallel`, and prompt-template subagent requests waiting forever when an extension reload or session replacement made their response runtime stale after a long child run. Bridge emits now classify stale drops through the host predicate and reject the request's direct settlement path; settlement-less prompt-template drops log an explicit diagnostic. Bridge shutdown cancellation uses a distinct terminal error, so ordinary deactivation renders a failure result instead of being misclassified as stale. Completion-notification stale drops still reject instead of masquerading as an ordinary `delivered: false` acknowledgement. A genuine stale-runtime reload is still rethrown before the old API can render, so the command's guarantee is termination and logged diagnosis, not a persistent pane notice after reload repaint.
- Exposed `registerPromptTemplateBridgeRequestSettlement` from `@bastani/subagents` for the separately installed `pi-prompt-template-model` emitter, which cannot be registered by Atomic because it owns a different extension runtime.

- Fixed every `subagent` action being refused with "Subagent fanout is not authorized for this child." for a child without fanout authorization. The fanout check ran before the management branch, so the observing actions — `list`, `get`, `status`, and `doctor` — were rejected with a message about delegation, which they do not perform. Those four now pass the gate. Fanout authorization gates delegation and every management action that can start or continue agent execution: `resume` revives a child and `interrupt` is privileged control over a running one, so both now receive the fanout refusal instead of reaching their handlers. Mutating management (`create`, `update`, `delete`) is still refused for a management-restricted child, by the narrower gate that this bug had made unreachable. Registration is not authority: a child loads bundled extensions through normal discovery and may therefore have the `subagent` tool registered, while typed admission policy decides which of its actions run. The bundled subagents skill stays parent-only and is stripped from every child prompt, including fanout-authorized children ([#2220](https://github.com/bastani-inc/atomic/pull/2220), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Fixed the in-process depth guard and nested workflow-stage children. Admission-issued child depth now travels in the typed policy into every single, parallel, async, and resume path, so the executor can reject delegation at the configured limit while Rust admission keeps the hard five-level ceiling; the orphaned process-environment depth bridge and its self-fulfilling tests are gone. In-process children now load the bundled package resources needed to register `subagent`, so a nested child no longer starts with only the base built-in tools and no way to delegate, while workflow-stage children suppress only the workflow extension lifecycle ([#2220](https://github.com/bastani-inc/atomic/pull/2220), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Fixed an agent's `maxSubagentDepth` being dropped at the in-process admission door. A child admitted from an agent whose definition tightened the limit received a policy carrying no maximum, so it could keep delegating as if only the global five-level ceiling applied. The effective limit — the stricter of the parent's limit and the child agent's own — now travels on the admitted child spec and policy, is reissued unchanged by a cold reload, and is applied by the executor's depth check alongside the local configuration. Admission also derives the limit from the agent definition when a caller supplies a child spec without one, so the admission door no longer issues an unbounded policy for an agent that declared a limit ([#2220](https://github.com/bastani-inc/atomic/pull/2220), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Fixed a resumed foreground child losing the delegation limit its agent definition had narrowed. Retained resume re-derived the limit from the current stage or process configuration, so a child that ran under an agent maximum of 1 resumed with the configured maximum instead. The effective limit is now recorded per retained child and reused on resume, so editing an agent definition between a run and its resume cannot widen that child's budget ([#2220](https://github.com/bastani-inc/atomic/pull/2220), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Reduced redundant live subagent repaints by publishing progress only for widget-visible milestones. The in-process runner published `AgentProgress` from a catch-all over every child session event, including the high-frequency `message_update` streaming deltas and `tool_execution_update`, and each publish rewrites the elapsed fields the widget renders. With a subagent expanded via Ctrl+O, that made the live widget repaint for the whole run rather than when its contents changed, and each repaint of a row above the terminal fold costs a destructive pi-tui full redraw that clears terminal scrollback. Progress is now published only on events that change what the widget shows — `agent_start`, `tool_execution_start`, `tool_execution_end`, and (throttled) `message_end` — which is the emission profile foreground subagents had before the in-process runner. Measured against a 20-second replay in the tight geometry, scrollback clears drop from 23 to 3; a live tmux run against the built CLI dropped from 8 clears (7 of them repaints that changed nothing visible) to 3 (none of them). **Genuine above-fold milestone changes can still require a pi-tui redraw**, so a short terminal whose editor/footer region plus the live widget exceed the terminal height will still lose scrollback at tool boundaries; that path is upstream (earendil-works/pi#4785, #7194) and outside this package. The 400 ms throttle, the forced-emit milestones, the depth guard, and the typed status contract are unchanged ([#2213](https://github.com/bastani-inc/atomic/pull/2213), regression from [#2205](https://github.com/bastani-inc/atomic/pull/2205)).
- Fixed in-process foreground and async subagent fast-mode propagation for workflow stages. The child session keeps the real workflow orchestration context, so the SDK applies `service_tier: "priority"` to eligible requests; nested `ctx.workflow(...)` stages inherit the same scope, and fallback attempts recompute the marker and tier for the effective model. Live, continued, detached, and terminal result surfaces now keep the effective model's marker while main-chat children keep using `codexFastMode.chat` ([#2336](https://github.com/bastani-inc/atomic/issues/2336)).
- Fixed running subagent widgets and result rows dropping the child's effective reasoning level. In-process single, parallel, async, and workflow-stage steps now carry resolved model, thinking, and applied Codex fast-mode metadata from launch through fallback and completion, so the live badge and final result render the same values; async registry hydration preserves fresh per-step metadata ([#2335](https://github.com/bastani-inc/atomic/issues/2335)).

## [0.9.13-alpha.1] - 2026-08-05

### Breaking Changes

- `async: true` no longer survives parent exit. Async subagents now run as in-process children of the parent session on the same foreground executor, so quitting Atomic ends any in-flight async run. The child's canonical identity and its session file persist on disk and can be reloaded on a later start, but the running work does not continue in the background across a restart. The detached runner process that previously provided parent-exit survival has been deleted ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Removed the `ATOMIC_SUBAGENT_*` process-era environment bridge variables consumed by the deleted spawn path and the synthesized numeric child-result exit-code protocol (`0/1/-1/-2/143`). Child identity, policy, supervisor capability, and terminal outcomes now cross typed admission; results use required `status` (`ok | error | skipped | interrupted | continued`) plus `cause` and `stats` ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Added

- Added the in-process subagent control-plane doors and `InProcessChildRunner` foundation backed by the Rust N-API registry, typed statuses, session statistics, and bounded result envelopes ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Changed

- Nested in-process children now route live `interrupt` and cold `resume` actions directly through the Rust control plane. Nested event and control records use an in-memory host route while retaining the validated file shape for cold-start compatibility; session JSONL is flushed before forced interruption, and the former 200 ms nested-control polling loop is replaced by event-driven delivery ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- In-process children now advance through their model-fallback ladder via the SDK session's `fallbackModels` — the exact classification, same-model retry, and candidate-advancement behavior main chat and workflow stages converged on ([#2170](https://github.com/bastani-inc/atomic/issues/2170)) — instead of a subagents-local walk. Pre-spawn auth filtering still builds the ladder, and results report the effective `model`, `attemptedModels`, and skipped pre-spawn attempts ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Foreground subagent attempts now enter through the in-process session runner, expose typed terminal status and `SessionStats`, and record typed run-history statuses; the foreground process-attempt implementation was removed ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- In-process admission now resolves child management and fanout capabilities as a typed policy carried into the session and tool executor; restricted children cannot create, update, or delete agent definitions, and fanout authorization cannot be widened by a descendant ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- `async: true` chain and parallel runs now execute on the same in-process foreground executor as their synchronous counterparts, un-awaited, instead of a separately serialized detached runner. Chain `{previous}` substitution, chain output bindings, dynamic fanout, worktree setup and cleanup, structured-output schemas, skills resolution, progress files, fail-fast, and per-step model-candidate ladders are now served by one implementation for both modes ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Child prompt behavior now enters in-process `AgentSession` construction through typed admission policy: boundary instructions, project-context and inherited-skill filtering, orchestration-skill removal, and parent-only message filtering no longer depend on the process-era extension injection path ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Child MCP direct-tool selection and Intercom identity/capability now cross the in-process admission boundary as typed policy; omitted MCP selection preserves defaults, empty selection disables direct tools, and supervisor grants are never inherited through environment ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

### Fixed

- Fixed in-process parallel siblings colliding on the same canonical identity and terminal artifact path, and fixed async completions omitting their persisted result envelope from the parent notification ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).
- Fixed model-failure classification sharing so subagent fallback decisions stay aligned with main chat and workflow candidates for auth, unavailable-model, request-incompatible, quota, and transport failures ([#2170](https://github.com/bastani-inc/atomic/issues/2170)).

### Removed

- Removed every remaining OS child-process code path from subagent execution, satisfying the spec's zero-process goal: the detached jiti async runner and its twelve `subagent-runner*` modules, the `async-execution-*` spawn layer, the async event journal, the idle/wall attempt watchdog, the stdout drain grace, the CLI spawn resolver, the environment-bridge builder, and the post-exit stdio guard ([#2188](https://github.com/bastani-inc/atomic/issues/2188)).

## [0.9.12] - 2026-08-04

### Fixed

- Fixed bundled subagent resources failing to load on Windows when shared modules used mixed `.ts` and `.js` import spellings.

## [0.9.12-alpha.1] - 2026-08-04

### Fixed

- Fixed bundled subagent resources failing to load on Windows when shared modules used mixed `.ts` and `.js` import spellings.

## [0.9.11] - 2026-08-03

### Changed

- Adopted Claude Opus 5 across every builtin subagent `fallbackModels` policy and normalized provider ordering: each Anthropic family lists its direct `anthropic/...` candidate ahead of the `github-copilot/...` mirror, Opus 5 leads the Anthropic group (`:high` for the debugger, `:low` elsewhere), and `claude-fable-5` gains its missing Copilot mirror.
- Reworked all nine bundled agent system prompts and all seven chain task templates for GPT-5.6, Claude Opus 5, and Claude Fable 5. Agent bodies are outcome-first with explicit success, evidence, output, escalation, and stop contracts, shrinking from 1,418 to 561 lines. Removing repeated self-verification and requests to reproduce internal reasoning also avoids Claude Fable 5 `reasoning_extraction` refusals that could force model fallback. Frontmatter and exported behaviour are unchanged.
- Made the builtin debugger write-capable with the same tool list as `worker`, so it applies the smallest in-scope fix after proving the root cause, and gave it the `tdd`, `playwright-cli`, and `tmux` skills plus Intercom coordination.
- Generalized orchestration guidance across parent chats and workflow stages: orchestrators preserve each agent's declared model and fallback policy by default, explicit overrides require a user request or documented need, and every invocation shares one invocation-specific Intercom group while retaining `contact_supervisor` escalation.

### Removed

- Removed Cursor MCP compatibility imports from delegated direct-tool resolution and Cursor model candidates from every builtin subagent fallback policy ([#1994](https://github.com/bastani-inc/atomic/issues/1994)).
- Removed the `(1m)` context-window token from every builtin fallback policy; candidates now use the model's catalog context window (`github-copilot/claude-opus-4.8:medium`).

### Fixed

- Fixed startup artifact cleanup escaping isolated agent directories, and made it far cheaper: the global scan now stays inside a host-provided sessions root, runs at most once per 24 hours per root behind a `.last-cleanup` marker and an exclusive `.cleanup.lock`, is deferred ten minutes after startup, and stops at the first entry newer than the cutoff instead of recursively stat-ing whole subtrees — eliminating tens of thousands of synchronous fs calls on long-lived machines ([#2070](https://github.com/bastani-inc/atomic/issues/2070)).
- Fixed worktree setup hooks being reported as failed when they never read their stdin. A hook that exited before the JSON input flushed made `spawnSync` report `EPIPE` and tore down the whole worktree even though the hook had completed; the child's exit status and output are now authoritative. Timeouts and other spawn errors stay fatal.
- Fixed foreground subagent runs that detached for intercom coordination completing silently. A detached single, chain, or parallel child now delivers a "Detached subagent task" completion, failure, or paused notice to the parent session through the same deduplicated, turn-triggering pipeline as background completions, including per-child `(n/m)` attribution.

## [0.9.11-alpha.9] - 2026-08-01

### Fixed

- Fixed startup artifact cleanup escaping isolated agent directories. When the host provides a non-default session directory (for example an isolated programmatic `agentDir` used by tests and embedders), the global artifact scan now stays inside that sessions root; the real global and legacy `~/.pi` sessions roots are only scanned when no host-provided root is available ([#2070](https://github.com/bastani-inc/atomic/issues/2070)).
- Fixed every extension activation rescanning all historical session directories for stale subagent artifacts. The global scan now runs at most once per 24 hours per sessions root via a root-level `.last-cleanup` marker, takes an exclusive `.cleanup.lock` so concurrent activations never race the same scan, and is deferred ten minutes after startup instead of running on the activation macrotask; the deferral stays unref'd and is cancelled by extension shutdown ([#2070](https://github.com/bastani-inc/atomic/issues/2070)).
- Fixed startup maintenance walking every file under the nested subagent runtime directories on each activation. The stale-directory scan now stops at the first entry newer than the cleanup cutoff instead of recursively stat-ing whole subtrees to compute the true newest mtime, eliminating tens of thousands of synchronous fs calls on long-lived machines ([#2070](https://github.com/bastani-inc/atomic/issues/2070)).
- Fixed subagent worktree setup hooks being reported as failed when they never read their stdin. The hook's JSON input is written to its stdin, but nothing requires a hook to consume it; a hook that exited before that write flushed made `spawnSync` report `EPIPE` and the whole worktree creation was torn down, even though the hook had run to completion and its stdout was captured in full. The child's exit status and output are now authoritative, so only a spawn that never produced a status is treated as a hook failure. Timeouts and every other spawn error stay fatal as before. This race was lost far more often on loaded machines, making it look intermittent.

## [0.9.11-alpha.6] - 2026-07-28

### Changed

- Adopted Claude Opus 5 across every builtin subagent `fallbackModels` policy and normalized provider ordering. Each Anthropic family now lists its direct `anthropic/...` candidate ahead of the `github-copilot/...` mirror, Opus 5 leads the Anthropic group (`:high` for the debugger, `:low` elsewhere), `claude-fable-5` gains its missing Copilot mirror, and the OpenRouter tail lists `openrouter/anthropic/claude-opus-5` before the older Anthropic mirrors.
- Reworked all nine bundled agent system prompts and all seven chain task templates for GPT-5.6, Claude Opus 5, and Claude Fable 5. Agent bodies are now outcome-first with explicit success, evidence, output, escalation, and stop contracts while shrinking from 1,418 to 561 lines; chain templates now carry grounded-reporting, selective-delegation, downstream-output, and completion contracts. Removed repeated self-verification and requests to reproduce internal reasoning, avoiding Claude Fable 5 `reasoning_extraction` refusals that could otherwise force model fallback, without changing agent frontmatter or exported behavior.

### Removed

- Removed Cursor MCP compatibility imports from delegated direct-tool resolution and removed Cursor model candidates from every builtin subagent fallback policy ([#1994](https://github.com/bastani-inc/atomic/issues/1994)).
- Removed the `(1m)` context-window token from every builtin subagent `fallbackModels` policy. Atomic no longer parses a parenthesized context-window token in model strings, so `github-copilot/claude-opus-4.8 (1m):medium` is now `github-copilot/claude-opus-4.8:medium` and the candidate uses the model's catalog context window.

## [0.9.11-alpha.5] - 2026-07-23

### Changed

- Generalized model-visible subagent orchestration guidance across parent chats and workflow stages. Orchestrators now preserve each agent's declared model and fallback policy by default; agents without a policy use only catalog-available, role-appropriate Pareto recommendations and otherwise remain unpinned. Explicit overrides require an exact user request or documented task need, and every workflow or orchestrator invocation shares one invocation-specific, non-default Intercom group across its delegated children while retaining `contact_supervisor` escalation.
- Made the builtin debugger write-capable with the same tool list as `worker`, updated its prompt to apply the smallest in-scope code or content fix after proving the root cause, and synchronized the bundled subagent skill with its GPT-5.6 xhigh model, `tdd`/`playwright-cli`/`tmux` skills, and Intercom coordination support.

## [0.9.11-alpha.3] - 2026-07-21

### Fixed

- Fixed foreground subagent runs that detached for intercom coordination completing silently. When a foreground single, chain, or parallel child detaches (for example after asking its supervisor a question) and later exits, the parent session now receives a "Detached subagent task" completion/failure/paused notice through the same deduplicated, turn-triggering delivery pipeline used for background completion notifications, including per-child `(n/m)` attribution for parallel groups. Previously the detached child's final result was only recorded in remembered run state, so the orchestrating session had to poll `subagent status` to discover that a detached run had finished.

## [0.9.11-alpha.1] - 2026-07-20

### Changed

- Published a synchronized Atomic 0.9.11-alpha.1 prerelease for the subagents extension; no functional subagent changes were made after 0.9.10.

## [0.9.10] - 2026-07-20

### Added

- Added a `group` option on subagent tasks, parallel/chain items, and the top-level call that sets the intercom home group for spawned children so same-group subagents can intercom each other while staying isolated from other groups. A named string joins that group; `true` auto-generates one shared UUID group per parallel set (shared across all items in the set). Precedence is `explicit subagent group > inherited current-session (stage) group > env ATOMIC_INTERCOM_GROUP > config > "default"`. When a subagent does not specify a group it inherits its launching session's group — read race-safely from the session's `orchestrationContext.intercomGroup` rather than global env — so subagents spawned by a grouped workflow stage join that stage's group by default. The child group env (`ATOMIC_INTERCOM_GROUP`) is written only when the child actually has intercom access (the peer `intercom` tool or the `contact_supervisor` tool); a child without intercom is never placed into a group. `contact_supervisor` retains cross-group supervisor access through a broker-issued child capability rather than a client-authored channel marker.

### Changed

- Reworked isolated parallel worktrees to use the canonical main repository's `.atomic/worktrees/` directory, `worktree-*` branches, remote-default/`HEAD` base resolution, local-settings/hooks/`.worktreeinclude` post-creation setup, and force-remove plus branch-delete cleanup, including setup-failure cleanup from linked-worktree invocations.

### Fixed

- Fixed async subagent completion notices racing workflow-stage finalization. Completion notifications now carry stable admission identities, join already-claimed terminal preludes as one stage batch when received before close, and route externally without terminal transcript mutation when close wins. Successful-notification deduplication, retry acknowledgement, terminal ordering, and detached non-blocking execution remain intact.
- Fixed asynchronous terminal dispatch to defer its acknowledgement and successful-notification dedupe until custom-message admission settles. Rejected batch routes now restore claimed Intercom preludes and return a failed acknowledgement so the durable result watcher can retry the same stable notification ID.
- Fixed foreground subagent supervisor coordination deadlocking when launched inside a busy workflow stage, including parallel foreground groups where a long-running sibling kept the aggregate tool call active after the asking child detached. The workflow parent now honors the exact-owner probe/commit handshake before stage AgentSession admission; one accepted parallel commit releases foreground supervision for all active siblings while retaining their process lifecycle and eventual result recovery, and tasks still queued behind the concurrency limit are skipped without launching unsupervised. Run-owned direct and chain-parallel worktrees remain alive until all detached children close, when diffs are captured before cleanup instead of deleting active execution roots. Blocking decisions and interviews can receive replies while direct single execution, background execution, cancellation, and status/result recovery remain intact.
- Secured foreground, background, parallel, chain, revived, and bounded dynamic-fanout supervisor communication by requesting broker-issued authorizations before child spawn and passing each grant through dedicated child environment metadata. Foreground/single-child paths use exact child scopes; asynchronous chains use bounded per-child slots so dynamic fanout index shifts cannot invalidate later children. Descendants without a fresh grant explicitly clear inherited capability metadata, parent-held grants are restored after reconnects, and the lightweight Intercom wrapper lazy-loads authorization on demand. Claimed provider failures abort launch; hosts without a provider suppress supervisor metadata instead of leaving `contact_supervisor` silently unusable.
- Fixed subagent live-detail and full-notification hints to use the effective `app.tools.expand` binding and omit the shortcut affordance when it is unbound.
- Fixed completion-notification header parsing to avoid polynomial regular-expression behavior on long malformed agent/task text while preserving accepted notification formats.
- Fixed session startup stalling on background-job hydration when the subagents run directory has accumulated many historical runs. Active-job hydration is now deferred off the `session_start` hot path and only eagerly reconciles runs touched within the last 7 days (older runs are skipped with two `stat` calls instead of a full per-run status read and reconciliation), so the jobs widget populates moments after startup without blocking first input.
- Fixed a host-process crash from the background-job tracker's timers using a stale extension context. Deferred hydration, poller ticks, and cleanup timers hold onto contexts that become invalid after `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `ctx.reload()`; every context read in those timer paths is now probed defensively and a stale retained UI context is dropped instead of throwing an unhandled "extension ctx is stale" error out of an unref'd timer.

## [0.9.10-alpha.1] - 2026-07-19

### Added

- Added a `group` option on subagent tasks, parallel/chain items, and the top-level call that sets the intercom home group for spawned children so same-group subagents can intercom each other while staying isolated from other groups. A named string joins that group; `true` auto-generates one shared UUID group per parallel set (shared across all items in the set). Precedence is `explicit subagent group > inherited current-session (stage) group > env ATOMIC_INTERCOM_GROUP > config > "default"`. When a subagent does not specify a group it inherits its launching session's group — read race-safely from the session's `orchestrationContext.intercomGroup` rather than global env — so subagents spawned by a grouped workflow stage join that stage's group by default. The child group env (`ATOMIC_INTERCOM_GROUP`) is written only when the child actually has intercom access (the peer `intercom` tool or the `contact_supervisor` tool); a child without intercom is never placed into a group. `contact_supervisor` retains cross-group supervisor access through a broker-issued child capability rather than a client-authored channel marker.

### Changed

- Reworked isolated parallel worktrees to use the canonical main repository's `.atomic/worktrees/` directory, `worktree-*` branches, remote-default/`HEAD` base resolution, local-settings/hooks/`.worktreeinclude` post-creation setup, and force-remove plus branch-delete cleanup, including setup-failure cleanup from linked-worktree invocations.

### Fixed

- Fixed async subagent completion notices racing workflow-stage finalization. Completion notifications now carry stable admission identities, join already-claimed terminal preludes as one stage batch when received before close, and route externally without terminal transcript mutation when close wins. Successful-notification deduplication, retry acknowledgement, terminal ordering, and detached non-blocking execution remain intact.
- Fixed asynchronous terminal dispatch to defer its acknowledgement and successful-notification dedupe until custom-message admission settles. Rejected batch routes now restore claimed Intercom preludes and return a failed acknowledgement so the durable result watcher can retry the same stable notification ID.
- Fixed foreground subagent supervisor coordination deadlocking when launched inside a busy workflow stage, including parallel foreground groups where a long-running sibling kept the aggregate tool call active after the asking child detached. The workflow parent now honors the exact-owner probe/commit handshake before stage AgentSession admission; one accepted parallel commit releases foreground supervision for all active siblings while retaining their process lifecycle and eventual result recovery, and tasks still queued behind the concurrency limit are skipped without launching unsupervised. Run-owned direct and chain-parallel worktrees remain alive until all detached children close, when diffs are captured before cleanup instead of deleting active execution roots. Blocking decisions and interviews can receive replies while direct single execution, background execution, cancellation, and status/result recovery remain intact.
- Secured foreground, background, parallel, chain, revived, and bounded dynamic-fanout supervisor communication by requesting broker-issued authorizations before child spawn and passing each grant through dedicated child environment metadata. Foreground/single-child paths use exact child scopes; asynchronous chains use bounded per-child slots so dynamic fanout index shifts cannot invalidate later children. Descendants without a fresh grant explicitly clear inherited capability metadata, parent-held grants are restored after reconnects, and the lightweight Intercom wrapper lazy-loads authorization on demand. Claimed provider failures abort launch; hosts without a provider suppress supervisor metadata instead of leaving `contact_supervisor` silently unusable.
- Fixed subagent live-detail and full-notification hints to use the effective `app.tools.expand` binding and omit the shortcut affordance when it is unbound.
- Fixed completion-notification header parsing to avoid polynomial regular-expression behavior on long malformed agent/task text while preserving accepted notification formats.
- Fixed session startup stalling on background-job hydration when the subagents run directory has accumulated many historical runs. Active-job hydration is now deferred off the `session_start` hot path and only eagerly reconciles runs touched within the last 7 days (older runs are skipped with two `stat` calls instead of a full per-run status read and reconciliation), so the jobs widget populates moments after startup without blocking first input.
- Fixed a host-process crash from the background-job tracker's timers using a stale extension context. Deferred hydration, poller ticks, and cleanup timers hold onto contexts that become invalid after `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `ctx.reload()`; every context read in those timer paths is now probed defensively and a stale retained UI context is dropped instead of throwing an unhandled "extension ctx is stale" error out of an unref'd timer.

## [0.9.9] - 2026-07-15

### Changed

- Aligned the subagents extension peer dependencies with the `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-tui` `^0.80.7` runtime set as part of the consolidated Pi v0.80.7 dependency update; no subagent source changes were needed.
- Updated the runtime `typebox` range to `^1.3.6`.

### Fixed

- Fixed first-party subagent transcripts launched inside workflow stages to inherit complete workflow ownership metadata in foreground and background execution, while fork-context children also inherit classification through the branched JSONL header.
- Preserved background async-child completion chronology with Intercom by emitting a terminal-ordering barrier and atomically batching claimed same-child messages before the completion notice, with a compatibility fallback for hosts without batched message admission.

## [0.9.9-alpha.4] - 2026-07-15

### Changed

- Published a synchronized Atomic 0.9.9-alpha.4 prerelease for the subagents extension; no functional subagent changes were made after 0.9.9-alpha.3.

## [0.9.9-alpha.3] - 2026-07-14

### Fixed

- Preserved background async-child completion chronology with Intercom by emitting a terminal-ordering barrier and atomically batching claimed same-child messages before the completion notice, with a compatibility fallback for hosts without batched message admission.

## [0.9.9-alpha.2] - 2026-07-14

### Changed

- Aligned the subagents extension peer dependencies with the `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-tui` `^0.80.7` runtime set as part of the consolidated Pi v0.80.7 dependency update; no subagent source changes were needed.
- Updated the runtime `typebox` range to `^1.3.6`.

## [0.9.9-alpha.1] - 2026-07-14

### Fixed

- Fixed first-party subagent transcripts launched inside workflow stages to inherit complete workflow ownership metadata in foreground and background execution, while fork-context children also inherit classification through the branched JSONL header.

## [0.9.8] - 2026-07-12

### Changed

- Synchronized the builtin `playwright-cli` skill with microsoft/playwright-cli at `793cfb32572733cbcb401e6f28d05a7a914ce408`, including current installation, snapshot search, mobile emulation, and test generation guidance.
- Renamed the builtin `effective-liteparse` skill to `liteparse` and synchronized it with run-llama/llamaparse-agent-skills at `2dcef7c62417bd2ec4671fce4621bb1e8cce48d0`; existing `/skill:effective-liteparse` references must migrate to `/skill:liteparse`.

## [0.9.8-alpha.1] - 2026-07-12

### Changed

- Synchronized the builtin `playwright-cli` skill with microsoft/playwright-cli at `793cfb32572733cbcb401e6f28d05a7a914ce408`, including current installation, snapshot search, mobile emulation, and test generation guidance.
- Renamed the builtin `effective-liteparse` skill to `liteparse` and synchronized it with run-llama/llamaparse-agent-skills at `2dcef7c62417bd2ec4671fce4621bb1e8cce48d0`; existing `/skill:effective-liteparse` references must migrate to `/skill:liteparse`.

## [0.9.7] - 2026-07-12

### Fixed

- Fixed subagent model fallback to classify provider usage-limit exhaustion (for example `Codex error: The usage limit has been reached`, plus `usage_limit`/`usage_limit_reached`/`usage_limit_exceeded`/`insufficient_quota` codes) as a retryable quota/rate-limit failure, so configured `fallbackModels` advance to the next candidate provider/model instead of failing the run. The message matcher tolerates the same space/underscore/hyphen/joined separators as the code path, so provider errors that flatten the token into free text (for example `usage_limit_reached` or `usage-limit`) also advance the chain. Nested cause/diagnostic and session-shaped errors classify the same way, while cancellations, safety refusals, task/tool failures, and unrelated errors remain non-retryable; the shared conformance corpus keeps this rule in lockstep with the workflows classifier.

## [0.9.7-alpha.1] - 2026-07-12

### Fixed

- Fixed subagent model fallback to classify provider usage-limit exhaustion (for example `Codex error: The usage limit has been reached`, plus `usage_limit`/`usage_limit_reached`/`usage_limit_exceeded`/`insufficient_quota` codes) as a retryable quota/rate-limit failure, so configured `fallbackModels` advance to the next candidate provider/model instead of failing the run. The message matcher tolerates the same space/underscore/hyphen/joined separators as the code path, so provider errors that flatten the token into free text (for example `usage_limit_reached` or `usage-limit`) also advance the chain. Nested cause/diagnostic and session-shaped errors classify the same way, while cancellations, safety refusals, task/tool failures, and unrelated errors remain non-retryable; the shared conformance corpus keeps this rule in lockstep with the workflows classifier.

## [0.9.6] - 2026-07-12

### Changed

- Aligned model-facing subagent guidance with workflow-first routing: subagents remain focused specialists inside workflow stages or bounded direct delegation, rather than becoming an ad hoc implementation/review/retry pipeline for workflow-fit work.
- Changed bundled Intercom coordination back to model-driven connection: launching foreground or background children no longer connects the parent or child session automatically; an Intercom tool or UI action must establish each session's broker connection.

## [0.9.6-alpha.1] - 2026-07-12

### Changed

- Aligned model-facing subagent guidance with workflow-first routing: subagents remain focused specialists inside workflow stages or bounded direct delegation, rather than becoming an ad hoc implementation/review/retry pipeline for workflow-fit work.
- Changed bundled Intercom coordination back to model-driven connection: launching foreground or background children no longer connects the parent or child session automatically; an Intercom tool or UI action must establish each session's broker connection.

## [0.9.5] - 2026-07-11

### Added

- Added model-capability-aware `max` reasoning suffix support to subagent model/fallback parsing and child CLI forwarding ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Added root single-agent `progress` calls so `progress: true` maintains a run-scoped `progress.md` under isolated artifact storage for foreground, background, and revived runs without overwriting a child-working-directory file; inherited defaults are suppressed for read-only tasks, and artifacts-disabled foreground storage is removed after the child exits.

### Changed

- Aligned the subagents extension peer dependencies with upstream Pi `^0.80.5` runtime packages as part of the consolidated dependency refresh.
- Aligned the subagents extension peer dependencies with upstream Pi `^0.80.6` runtime packages while preserving Atomic child-session and orchestration behavior ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Made subagent routing selective and complementary with workflows: bounded single/chain/parallel delegation remains parent-controlled, async is chosen only when useful, conceptual debugging may stay inline, and the debugger is reserved for actual failures needing reproduction and root-cause work.
- Increased the top-level parallel subagent task limit from 8 to 50, including repeated tasks expanded through `count`; `parallel.maxTasks` can still configure a lower limit while concurrency remains independently configurable.
- Improved subagent extension startup by deferring old-run cleanup scans, result watcher startup, and existing-result priming to macrotasks while preserving immediate `subagent` tool and slash-command registration.
- Changed the Claude Fable 5 reasoning level from `xhigh` to `high` in the builtin `debugger` agent, covering the `anthropic/claude-fable-5` primary and its OpenRouter mirror in the fallback chain.
- Changed the Claude Opus 4.8 reasoning level from `xhigh` to `high` in the builtin `debugger` agent's fallback chain (`github-copilot/claude-opus-4.8 (1m)`, `anthropic/claude-opus-4-8`, and the OpenRouter mirror); Opus 4.8 entries at other levels in other agents are unchanged.
- Refreshed the builtin debugger agent's July 2026 frontier model roster: it now leads with Claude Fable 5 `:xhigh`, keeps GPT-5.5 `:xhigh`, Opus 4.8 long-context `:xhigh`, and GLM-5.2 fallbacks, and retains only the valid OpenRouter Fugu Ultra mirror rather than unsupported direct Sakana model IDs.

### Fixed

- Fixed Bun source-checkout subagent launches to reuse the current TypeScript Atomic CLI entrypoint instead of falling back to an unrelated `atomic` executable on `PATH`, while preserving JavaScript, compiled-runtime, and cross-platform spawn behavior.
- Fixed direct async subagent completions disappearing after an in-process workflow stage loaded or shut down the extension. Runtime cleanup, watchers, event subscriptions, completion notification handlers and dedupe state, slash live snapshots, visible-control deduplication, fanout-child nested-control listeners/timers, and async widget animation state are now owned per `ExtensionAPI`, so concurrent parent/stage sessions cannot tear down, suppress, clear, or replace one another's parent-owned state even when they share a forwarded host UI and session identity. Native result watching also coalesces directory activity into a short rescan, so macOS/Bun atomic writes are consumed even when `fs.watch` reports only a hidden temporary rename rather than the final JSON filename. Same-API reloads remain deduplicated, partial registration failures clean up acquired resources, stale shutdown callbacks cannot stop a newer registration, and duplicate watcher activity still consumes a parent result file with exactly one `subagent-notify`.
- Fixed async event persistence so cumulative `message_update.message` and `assistantMessageEvent.partial` snapshots are not archived per delta. Compact incremental deltas plus raw child stdout/stderr share one buffered byte budget and truncation marker, while finalized messages and later lifecycle/control/terminal records remain available; asynchronous stream-open failures are non-fatal, concurrent closes await the same drain, and writer reacquisition uses a bounded identity/fingerprint cache to hydrate append-only suffixes while detecting same-inode rewrites, truncation/regrowth, replacement, and externally appended markers without rescanning unchanged journals.
- Added root single-agent `reads` contract support with local validation, shared foreground/background instruction behavior, and relative-path resolution against the effective child working directory.
- Fixed stale-run repair to stage the exact public result beside its destination, commit terminal status, and atomically consume the hidden stage when publishing; interrupted renames resume without leaving a replayable stage beside a delivered result. The result watcher defers modern `asyncDir` results until status is terminal, canonicalizes equivalent aliases by `runId`, quarantines aliases whose user-visible payload or target conflicts with that canonical identity, revalidates session ownership after delivery waits, and commits only after idempotent Intercom confirmation plus synchronous local compatibility acceptance. Nonterminal status checks use capped exponential rechecks without losing eventual late-terminal recovery; delivery retries preserve successful phases across watcher replacements and, after a finite no-progress budget, retain the result under a collision-resistant name in `.undelivered` instead of retrying forever, overwriting prior evidence, or deleting the payload.
- Clarified async launch acknowledgements and TUI rendering as `launched` with `completion pending`, while keeping the completed launch tool call distinct from the detached child's running state.
- Fixed foreground blocking Intercom asks and supervisor decisions to detach only the exact delivered child, tolerate broker/tool-start ordering, remain resumable, recover the child's eventual result without treating the detached placeholder as success or starting model fallback, and expose the retained detached-to-terminal result through public status lookup with consistent prefix disambiguation ([#1727](https://github.com/bastani-inc/atomic/issues/1727)).
- Automatically register enabled foreground and background child sessions with Intercom before agent work begins, while management-only list/status/interrupt actions remain broker-free and issue #1727 targeted detach/resume behavior is preserved.
- Fixed background async result watching on Windows to use Atomic's safe watcher path strategy and fall back to polling when native `fs.watch` would receive an unsafe or non-canonical watcher path.
- Fixed async/background subagent status visibility while the fullscreen workflow graph is active by publishing the live async summary through the shared status surface in addition to the below-editor widget.
- Fixed foreground and background subagent startup diagnostics so missing or invalid child `cwd` values are reported as working-directory problems before spawn, while runtime spawn failures include the attempted command and cwd instead of ambiguous `ENOENT` output.
- Updated async/background subagent status widgets so running job, parallel child-agent, chain-step, and nested child rows reuse the same foreground pulsing-dot glyph treatment instead of braille spinner glyphs, while preserving counts, metadata, live-detail hints, and output paths.

### Removed

- Removed the unreachable subagent launch preview/editor TUI and its internal execution plumbing; supported launches now dispatch directly without waiting for terminal input.

## [0.9.5-alpha.10] - 2026-07-11

### Added

- Added model-capability-aware `max` reasoning suffix support to subagent model/fallback parsing and child CLI forwarding ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Added root single-agent `progress` calls so `progress: true` maintains a run-scoped `progress.md` under isolated artifact storage for foreground, background, and revived runs without overwriting a child-working-directory file; inherited defaults are suppressed for read-only tasks, and artifacts-disabled foreground storage is removed after the child exits.

### Changed

- Aligned the subagents extension peer dependencies with upstream Pi `^0.80.5` runtime packages as part of the consolidated dependency refresh.
- Aligned the subagents extension peer dependencies with upstream Pi `^0.80.6` runtime packages while preserving Atomic child-session and orchestration behavior ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Made subagent routing selective and complementary with workflows: bounded single/chain/parallel delegation remains parent-controlled, async is chosen only when useful, conceptual debugging may stay inline, and the debugger is reserved for actual failures needing reproduction and root-cause work.
- Increased the top-level parallel subagent task limit from 8 to 50, including repeated tasks expanded through `count`; `parallel.maxTasks` can still configure a lower limit while concurrency remains independently configurable.

### Removed

- Removed the unreachable subagent launch preview/editor TUI and its internal execution plumbing; supported launches now dispatch directly without waiting for terminal input.

### Fixed

- Fixed Bun source-checkout subagent launches to reuse the current TypeScript Atomic CLI entrypoint instead of falling back to an unrelated `atomic` executable on `PATH`, while preserving JavaScript, compiled-runtime, and cross-platform spawn behavior.
- Fixed direct async subagent completions disappearing after an in-process workflow stage loaded or shut down the extension. Runtime cleanup, watchers, event subscriptions, completion notification handlers and dedupe state, slash live snapshots, visible-control deduplication, fanout-child nested-control listeners/timers, and async widget animation state are now owned per `ExtensionAPI`, so concurrent parent/stage sessions cannot tear down, suppress, clear, or replace one another's parent-owned state even when they share a forwarded host UI and session identity. Native result watching also coalesces directory activity into a short rescan, so macOS/Bun atomic writes are consumed even when `fs.watch` reports only a hidden temporary rename rather than the final JSON filename. Same-API reloads remain deduplicated, partial registration failures clean up acquired resources, stale shutdown callbacks cannot stop a newer registration, and duplicate watcher activity still consumes a parent result file with exactly one `subagent-notify`.
- Fixed async event persistence so cumulative `message_update.message` and `assistantMessageEvent.partial` snapshots are not archived per delta. Compact incremental deltas plus raw child stdout/stderr share one buffered byte budget and truncation marker, while finalized messages and later lifecycle/control/terminal records remain available; asynchronous stream-open failures are non-fatal, concurrent closes await the same drain, and writer reacquisition uses a bounded identity/fingerprint cache to hydrate append-only suffixes while detecting same-inode rewrites, truncation/regrowth, replacement, and externally appended markers without rescanning unchanged journals.
- Added root single-agent `reads` contract support with local validation, shared foreground/background instruction behavior, and relative-path resolution against the effective child working directory.
- Fixed stale-run repair to stage the exact public result beside its destination, commit terminal status, and atomically consume the hidden stage when publishing; interrupted renames resume without leaving a replayable stage beside a delivered result. The result watcher defers modern `asyncDir` results until status is terminal, canonicalizes equivalent aliases by `runId`, quarantines aliases whose user-visible payload or target conflicts with that canonical identity, revalidates session ownership after delivery waits, and commits only after idempotent Intercom confirmation plus synchronous local compatibility acceptance. Nonterminal status checks use capped exponential rechecks without losing eventual late-terminal recovery; delivery retries preserve successful phases across watcher replacements and, after a finite no-progress budget, retain the result under a collision-resistant name in `.undelivered` instead of retrying forever, overwriting prior evidence, or deleting the payload.
- Clarified async launch acknowledgements and TUI rendering as `launched` with `completion pending`, while keeping the completed launch tool call distinct from the detached child's running state.
- Fixed foreground blocking Intercom asks and supervisor decisions to detach only the exact delivered child, tolerate broker/tool-start ordering, remain resumable, recover the child's eventual result without treating the detached placeholder as success or starting model fallback, and expose the retained detached-to-terminal result through public status lookup with consistent prefix disambiguation ([#1727](https://github.com/bastani-inc/atomic/issues/1727)).
- Automatically register enabled foreground and background child sessions with Intercom before agent work begins, while management-only list/status/interrupt actions remain broker-free and issue #1727 targeted detach/resume behavior is preserved.

## [0.9.5-alpha.9] - 2026-07-09

### Changed

- Improved subagent extension startup by deferring old-run cleanup scans, result watcher startup, and existing-result priming to macrotasks while preserving immediate `subagent` tool and slash-command registration.

### Fixed

- Fixed background async result watching on Windows to use Atomic's safe watcher path strategy and fall back to polling when native `fs.watch` would receive an unsafe or non-canonical watcher path.
- Fixed async/background subagent status visibility while the fullscreen workflow graph is active by publishing the live async summary through the shared status surface in addition to the below-editor widget.
- Fixed foreground and background subagent startup diagnostics so missing or invalid child `cwd` values are reported as working-directory problems before spawn, while runtime spawn failures include the attempted command and cwd instead of ambiguous `ENOENT` output.

## [0.9.5-alpha.8] - 2026-07-08

### Fixed

- Updated async/background subagent status widgets so running job, parallel child-agent, chain-step, and nested child rows reuse the same foreground pulsing-dot glyph treatment instead of braille spinner glyphs, while preserving counts, metadata, live-detail hints, and output paths.

## [0.9.5-alpha.5] - 2026-07-06

### Changed

- Changed the Claude Fable 5 reasoning level from `xhigh` to `high` in the builtin `debugger` agent, covering the `anthropic/claude-fable-5` primary and its OpenRouter mirror in the fallback chain.
- Changed the Claude Opus 4.8 reasoning level from `xhigh` to `high` in the builtin `debugger` agent's fallback chain (`github-copilot/claude-opus-4.8 (1m)`, `anthropic/claude-opus-4-8`, and the OpenRouter mirror); Opus 4.8 entries at other levels in other agents are unchanged.

## [0.9.5-alpha.2] - 2026-07-04

### Changed

- Refreshed the builtin debugger agent's July 2026 frontier model roster: it now leads with Claude Fable 5 `:xhigh`, keeps GPT-5.5 `:xhigh`, Opus 4.8 long-context `:xhigh`, and GLM-5.2 fallbacks, and retains only the valid OpenRouter Fugu Ultra mirror rather than unsupported direct Sakana model IDs.

## [0.9.4] - 2026-07-03

### Added

- Added a watchdog escape hatch: setting `ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS` or `ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS` to `0` (or a negative value) disables the corresponding per-attempt timeout entirely; the `ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS` SIGTERM→SIGKILL grace period intentionally cannot be disabled so escalation always stays bounded ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).

### Changed

- Curated builtin agent model defaults against Atomic's agentic-coding benchmark (pass@1 / avg cost per task, 2026-07-02) under a role-based placement principle: all primaries are now `openai-codex/gpt-5.5` at the measured value point for each tier (`debugger` at `:xhigh`; `worker`, `code-simplifier`, and the analyzer/researcher agents at `:medium`; locator and pattern-finder agents at `:low`), fallback chains degrade through same-model provider mirrors first, then remaining families by descending benchmark value, with OpenRouter mirrors as the availability tail; strictly dominated models (`claude-sonnet-5`, `claude-sonnet-4.6`, `gemini-3.1-pro`, `gemini-3.5-flash`) and unbenchmarked entries (`gpt-5.4-mini`, `claude-haiku-4.5`) were removed so every chain entry corresponds to a benchmark datapoint.
- Normalized all GLM-5.2 entries to the model's two real reasoning tiers: native `zai`/`zai-coding-cn` entries now say `:high` explicitly (replacing misleading `:medium`/`:low` labels that silently ran at the "high" tier), the `debugger` chain keeps `:xhigh`, and the `openrouter/z-ai/glm-5.2` mirror is now always `:xhigh`.
- Aligned the subagents extension peer dependencies with upstream pi `^0.80.3` runtime packages.

### Fixed

- Fixed subagent live-detail hints to render the configured `app.tools.expand` keybinding instead of hardcoding Ctrl+O ([#1607](https://github.com/bastani-inc/atomic/issues/1607)), and fixed the running subagent widget to preserve its expanded/open state across workflow stage-node exit re-renders instead of transiently collapsing ([#1619](https://github.com/bastani-inc/atomic/issues/1619)).
- Fixed subagent model fallback so request/context incompatibility failures (HTTP 400/413/422, unsupported tool/parameter, context-window overflow, `invalid_request`/`bad_request`/`too_large` errors) advance the chain to the next candidate, falling back to the current user-selected model when no configured candidate can serve the request; refusals, content-filter/safety blocks, cancellations, and task failures still stop the chain ([#1580](https://github.com/bastani-inc/atomic/issues/1580)).
- Fixed foreground and background subagent model attempts that produced no child activity from hanging indefinitely: each candidate attempt now has a conservative idle watchdog (where in-flight tool executions count as activity) and an absolute wall-clock cap, records a retryable timeout failure, and advances to the next fallback candidate; known providers without configured auth are skipped before spawning ([#1580](https://github.com/bastani-inc/atomic/issues/1580), [#1581](https://github.com/bastani-inc/atomic/pull/1581)).
- Aligned the subagents model-failure classifier's direct-message precedence with the workflows classifier and added a cross-package conformance test suite so the two classifier copies cannot silently drift ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).
- Fixed the background subagent runner to spawn one default-model attempt when no model candidates were ever configured, mirroring the foreground path instead of silently exiting 1 with no error; an explicitly empty candidate list produced by pre-spawn auth filtering is still surfaced as an error ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).

## [0.9.4-alpha.11] - 2026-07-03

### Fixed

- Fixed subagent live-detail hints to render the configured `app.tools.expand` keybinding instead of hardcoding Ctrl+O, so remapped users see the same binding honored by attached workflow stage viewers ([#1607](https://github.com/bastani-inc/atomic/issues/1607)).
- Fixed the running subagent widget so it preserves the last known expanded/open state across workflow stage-node exit re-renders instead of transiently collapsing when the live widget context is stale until the next subagent status update ([#1619](https://github.com/bastani-inc/atomic/issues/1619)).

## [0.9.4-alpha.9] - 2026-07-02

### Changed

- Curated builtin agent model defaults against Atomic's agentic-coding benchmark (pass@1 / avg cost per task, 2026-07-02) under a role-based placement principle: only reviewer-style roles warrant best-in-class models; every builtin agent is a performance-per-dollar role and now leads with the measured value point for its tier. All primaries are now `openai-codex/gpt-5.5`: `debugger` at `:xhigh` (67% / $7.23, with `anthropic/claude-fable-5:xhigh` — the 70% / $13.41 accuracy ceiling — as first cross-family fallback); `worker`, `code-simplifier`, `codebase-online-researcher`, `codebase-analyzer`, and `codebase-research-analyzer` at `:medium` (54% / $2.75, strictly better than their previous GLM-5.2 primaries measured at 36% / $2.84, which move into the fallback chain); and `codebase-locator`, `codebase-research-locator`, and `codebase-pattern-finder` at `:low` ($1.20 / task, 28 steps, 9.4k output tokens — the measured cheap-tier value point), backed only by measured fallbacks (`claude-opus-4.8:low` at 41% / $2.29, then `glm-5.2:high`). All fallback chains degrade in a consistent order: same-model provider mirrors first (to preserve capability when a provider fails), then remaining families by descending benchmark value (`claude-fable-5:low` at 60% / $3.76 ahead of `claude-opus-4.8:medium` at 49% / $3.44, then GLM), with OpenRouter mirrors as the availability tail in the same order; `claude-opus-4.8` fallbacks ride at their `:high`/`:medium`/`:low` value points instead of `:xhigh`. Dropped strictly dominated models from all chains: `claude-sonnet-5`, `claude-sonnet-4.6`, and `gemini-3.1-pro` everywhere, and `gemini-3.5-flash` everywhere. Unbenchmarked models (`gpt-5.4-mini`, `claude-haiku-4.5`) and unmeasured levels (`gemini-3.5-flash:low`) are removed entirely — every chain entry in every builtin agent now corresponds to a benchmark datapoint.
- Normalized all GLM-5.2 entries to the model's two real reasoning tiers: GLM-5.2's thinking-level map collapses `minimal`/`low`/`medium`/`high` to its "high" effort and `xhigh` to "max", so the previous `zai/glm-5.2:medium` and `:low` labels (the `codebase-online-researcher` and analyzer primaries and various fallbacks) silently ran at the "high" tier under a misleading label. Native `zai`/`zai-coding-cn` entries now say `:high` explicitly, the `debugger` chain keeps `:xhigh` (→ "max"), and the `openrouter/z-ai/glm-5.2` mirror — which only maps `:xhigh` — is now always `:xhigh` instead of unsupported `:medium`/`:low`.

## [0.9.4-alpha.7] - 2026-07-02

### Fixed

- Fixed subagent model fallback so request/context incompatibility failures (HTTP 400/413/422 bad/unprocessable/payload-too-large request, unsupported tool/parameter, context-length/context-window overflow, `invalid_request`/`bad_request`/`too_large` errors) advance the chain to the next candidate instead of stopping. When none of the configured candidates can serve the request, the subagent now falls back to the current user-selected model. Refusals, content-filter/safety blocks, cancellations, and task failures still stop the chain ([#1580](https://github.com/bastani-inc/atomic/issues/1580)).
- Fixed foreground and background subagent model attempts that produced no child activity from hanging indefinitely. Each candidate attempt now has a conservative idle watchdog and absolute wall-clock cap, records a retryable timeout failure, and advances to the next fallback candidate; known providers without configured auth are skipped before spawning while unknown/custom providers and the current-model last resort are still attempted ([#1580](https://github.com/bastani-inc/atomic/issues/1580)).
- Fixed the per-attempt idle watchdog so an in-flight tool execution counts as activity: a slow, quiet tool call (long build or test run with no interim output) is no longer killed as a stalled attempt; the wall-clock cap still bounds such attempts ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).
- Aligned the subagents model-failure classifier's direct-message precedence with the workflows classifier (direct-message classification now runs after nested cause/diagnostic traversal and before outer status/code classification), and added a cross-package conformance test suite so the two classifier copies cannot silently drift ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).
- Fixed the background subagent runner to spawn one default-model attempt when no model candidates were ever configured (no primary model, no fallbacks, and no current model), mirroring the foreground path instead of silently exiting 1 with no error and no spawn. An explicitly empty candidate list produced by pre-spawn auth filtering is still respected and surfaced as an error ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).

### Added

- Added a watchdog escape hatch: setting `ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS` or `ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS` to `0` (or a negative value) now disables the corresponding per-attempt timeout entirely; non-numeric values are ignored and the defaults apply. The `ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS` SIGTERM→SIGKILL grace period intentionally cannot be disabled — `0`, negative, or non-numeric values fall back to its default so escalation always stays bounded ([#1581](https://github.com/bastani-inc/atomic/pull/1581)).

## [0.9.4-alpha.6] - 2026-07-01

### Changed

- Aligned the subagents extension peer dependencies with upstream pi `^0.80.3` runtime packages; no subagents extension source changes were needed for this metadata sync.

## [0.9.4-alpha.5] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.5 prerelease for the subagents extension; no subagents extension changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.4] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.4 prerelease for the subagents extension; no subagents extension changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.3] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.3 prerelease for the subagents extension; no subagents extension changes were made after 0.9.4-alpha.1.

## [0.9.4-alpha.1] - 2026-06-29

### Changed

- Published a synchronized Atomic 0.9.4-alpha.1 prerelease for the subagents extension; no subagents extension changes were made after 0.9.3.

## [0.9.3] - 2026-06-29

### Added

- Added OpenRouter fallback coverage to bundled subagent definitions so delegated codebase analysis, research, debugging, simplification, and worker sessions can recover through OpenRouter-hosted frontier, GLM, and Gemini providers when native providers are unavailable.

### Changed

- Aligned the subagents extension peer dependencies with upstream pi `^0.80.2` runtime packages and retargeted legacy provider/model imports to `@earendil-works/pi-ai/compat`.
- Raised the default and hard maximum subagent nesting budget to five delegated levels, extending nested-run observability to the same depth.

### Fixed

- Prevented async and foreground subagent status widgets from flickering or unmounting during host UI refreshes, tall-panel redraws, and reset-and-hydrate cycles with active background runs.
- Fixed live subagent result animation cleanup so terminal workflow rows evict animation registry entries instead of leaving stale intervals.
- Synced upstream subagent hardening for compact tool-call summaries, nested fanout call/result history, duplicate dispatch rejection, provider-safe chain schemas, failed foreground diagnostics, builtin `search` MCP allowlist filtering, and updated builtin `find`/`search` tool guidance.

## [0.9.3-alpha.6] - 2026-06-29

### Added

- Added OpenRouter fallback coverage to the bundled subagent definitions so delegated codebase analysis, research, debugging, simplification, and worker sessions can recover through OpenRouter-hosted frontier, GLM, and Gemini providers when native providers are unavailable.

## [0.9.3-alpha.5] - 2026-06-28

### Changed

- Aligned the subagents extension peer dependencies with upstream pi `^0.80.2` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`) and retargeted legacy provider/model imports to `@earendil-works/pi-ai/compat`, preserving delegated model resolution and streaming behavior under the updated pi-ai package layout.

## [0.9.3-alpha.4] - 2026-06-28

### Changed

- Published a synchronized Atomic 0.9.3-alpha.4 prerelease for the subagents extension; no subagents extension changes were made after 0.9.3-alpha.3.

## [0.9.3-alpha.3] - 2026-06-27

### Changed

- Published the Atomic 0.9.3-alpha.3 prerelease for the subagents extension from the same code as 0.9.3-alpha.2; no subagents extension changes were made after the previous prerelease.

## [0.9.3-alpha.2] - 2026-06-27

### Fixed

- Prevented the async subagent status widget from briefly unmounting during reset-and-hydrate cycles when active background runs are still present, including Atomic host updates that deliver fresh UI context wrappers for the same logical session ([#1517](https://github.com/bastani-inc/atomic/issues/1517)).
- Fixed live subagent result animation cleanup to register a host-row disposer, so terminal workflow cleanup evicts animation registry entries instead of only clearing intervals ([#1518](https://github.com/bastani-inc/atomic/issues/1518)).
- Synced recent upstream subagent hardening so compact delegated tool-call summaries are preserved, fanout children keep their live nested subagent call/result history, duplicate concurrent subagent dispatches are rejected, provider-hostile chain schema conditionals are removed, and failed foreground runs include captured child output for diagnostics ([#1527](https://github.com/bastani-inc/atomic/issues/1527)).
- Eliminated the foreground subagent widget flicker that appeared once a running subagent panel grew tall enough to reach or exceed the terminal viewport. The live compact result no longer animates its spinner on an 80ms wall-clock timer; instead it shows an activity "pulse" glyph that advances exactly once per real progress update. Because the panel renders into chat scrollback, a timer-driven spinner cell that scrolled above pi-tui's viewport fold forced a destructive full-screen + scrollback clear on every tick — driving the indicator off genuine updates keeps line diffs tied to content that actually changed, so the differential renderer repaints only when progress does and never strobes.

## [0.9.3-alpha.1] - 2026-06-25

### Changed

- Raised the default and hard maximum subagent nesting budget to five delegated levels, clamping environment, config, and frontmatter values above `5` and extending nested-run observability to the same depth.

### Fixed

- Filtered direct MCP child-agent allowlists against the builtin `search` tool name so unprefixed MCP tools named `search` do not collide with Atomic's builtin search tool ([#1483](https://github.com/bastani-inc/atomic/issues/1483)).
- Updated bundled subagent definitions and docs to use the builtin `search`/`find` tools instead of the legacy `grep` helper ([#1490](https://github.com/bastani-inc/atomic/pull/1490)).

## [0.9.2] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.2 release with subagents extension peer dependencies aligned to upstream pi `^0.79.10` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`); no subagents extension source changes were needed for this metadata sync.

## [0.9.2-alpha.1] - 2026-06-23

### Changed

- Aligned the subagents extension peer dependencies with upstream pi `^0.79.10` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`); no subagents extension source changes were needed for this metadata sync.

## [0.9.1] - 2026-06-23

### Changed

- Published the stable Atomic 0.9.1 release for the subagents extension; no functional subagents changes were made after 0.9.0.

## [0.9.1-alpha.1] - 2026-06-22

### Changed

- Published a synchronized Atomic 0.9.1-alpha.1 prerelease for the subagents extension; no functional subagents changes were made after 0.9.0.

## [0.9.0] - 2026-06-22

### Added

- Added the `playwright-cli` builtin skill for browser automation, end-to-end UI checks, screenshots, reviewable video recording, and Playwright test workflows.
- Added the `effective-liteparse` builtin skill for fast, local, model-free text/table/value extraction from PDF, DOCX, PPTX, XLSX, and image files via the `lit` CLI.

### Changed

- Changed the `debugger` and `codebase-online-researcher` subagents to load `playwright-cli` and drive the `playwright-cli` command for JS-heavy, auth-gated, or interactive web work instead of the removed `browser` skill / `browse` CLI.
- Published the stable Atomic 0.9.0 release with subagents peer dependencies aligned through upstream pi `^0.79.9` runtime packages, so child sessions inherit provider catalog, RPC id handling, model search, theme/color-scheme, Warp image capability, Markdown streaming stability, and shared agent/TUI fixes.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist.

### Removed

- Removed the bundled `browser` skill and remaining references to its `browse` CLI in favor of `playwright-cli`.

## [0.9.0-alpha.2] - 2026-06-21

### Changed

- Aligned the subagents extension peer dependencies with upstream pi `^0.79.9` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`) so child sessions inherit chat-template custom-provider thinking controls, GLM-5.2 provider metadata, GitHub Copilot model-availability filtering, Mistral prompt-cache accounting, Markdown streaming code-fence stability, and shared agent/TUI compatibility fixes; no subagents extension source changes were needed for this dependency-covered sync.

## [0.9.0-alpha.1] - 2026-06-20

### Added

- Added the `playwright-cli` builtin skill (browser automation, end-to-end UI checks, screenshots, reviewable video recording, and Playwright test workflows) and the `effective-liteparse` builtin skill (fast, local, model-free text/table/value extraction from PDF, DOCX, PPTX, XLSX, and image files via the `lit` CLI).

### Changed

- Changed the `debugger` and `codebase-online-researcher` subagents to load the `playwright-cli` skill and drive the `playwright-cli` command for JS-heavy, auth-gated, or interactive web work instead of the removed `browser` skill / `browse` CLI.
- Aligned the subagents extension peer dependencies with upstream pi `^0.79.7` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`) so child sessions can use the host's latest provider catalog, RPC id handling, model-search, theme/color-scheme, Warp image capability, and shared TUI compatibility fixes; no subagents extension code changes were made for this metadata sync ([#1413](https://github.com/bastani-inc/atomic/issues/1413)).
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist ([#1445](https://github.com/bastani-inc/atomic/issues/1445)).

### Removed

- Removed the bundled `browser` skill and all references to its `browse` CLI in favor of the `playwright-cli` skill and `playwright-cli` command.

## [0.8.30] - 2026-06-17

### Changed

- Aligned the subagents extension peer dependencies with upstream pi `^0.79.4` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`); no subagents extension code changes were made for this metadata sync.
- Removed subagent acceptance gates, deterministic task-text acceptance inference, the remaining no-mutation completion guard, acceptance-report prompt injection/parsing, acceptance/completion-guard status metadata, and related tool/schema/config fields; completed child output is now preserved without acceptance or mutation-intent evaluation. Migration guidance now directs users to remove stale acceptance fields from subagent calls/chains/parallel items and move validation requirements into task text; JSON chain rewrites drop legacy acceptance entries ([#1398](https://github.com/bastani-inc/atomic/issues/1398)).

### Fixed

- Fixed `outputSchema` child runs to retry the structured-output contract up to three times before failing, re-running with a corrective prompt that includes the exact missing-output or schema-validation error and validating captured `output.json` against the schema on readback.

## [0.8.29] - 2026-06-15

### Changed

- Aligned the subagents extension with upstream pi `^0.79.3` runtime packages (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui`) so child sessions inherit the latest shared agent, provider, and TUI compatibility fixes.
- Changed `outputSchema` child runs to use Atomic's shared `structured_output` factory with direct schema parameters, concise two-line prompt guidance, parent-side `structuredOutput` capture from `output.json`, and auto-allowing the required tool for explicit child tool allowlists ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Removed parent-side top-level-object restrictions from child `outputSchema`; any plain JSON Schema object can be passed directly to the `structured_output` tool ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).

### Fixed

- Fixed subagent `outputSchema` readback to use the captured `output.json` directly without sidecar metadata, transcript-finality parsing, duplicate-call checks, or parent-side schema revalidation ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed explicit empty child `tools: []` allowlists with `outputSchema` to pass only `--tools structured_output`, keeping the restricted child from regaining default tools while still enabling the required final-answer channel ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed workflow-stage subagent depth handling so bundled workflow stages inherit the main-chat two-hop subagent nesting budget while preserving stricter configured limits, and updated the nested-depth rejection message to describe the maximum-depth condition ([#1372](https://github.com/bastani-inc/atomic/pull/1372)).

## [0.8.28] - 2026-06-11

### Changed

- Published a synchronized Atomic 0.8.28 stable release; no functional changes were made in the subagents extension.

## [0.8.27] - 2026-06-08

### Changed

- Promoted the 0.8.27 prerelease package version to a stable release.

## [0.8.26] - 2026-06-08

### Added

- Replaced the bundled browser-use subagent integration with the first-party `browser` skill for web interaction workflows.

### Changed

- Restricted the bundled codebase locator, analyzer, pattern-finder, research locator, and research analyzer agent tool allowlists to read/search/directory tools only, preventing these read-only helpers from invoking `bash` while they locate or analyze code.

### Fixed

- Fixed the `no-staged-files` acceptance runtime check and subagent worktree Git commands to ignore ambient Git repository environment variables, so subagents inspect the intended working tree instead of a parent hook or unrelated worktree.
- Suppressed intermediate model fallback failure notes and live foreground failure updates from successful subagent runs while preserving final failures and raw per-attempt diagnostics ([#1226](https://github.com/bastani-inc/atomic/issues/1226)).

## [0.8.26-alpha.11] - 2026-06-08

### Changed

- Restricted the bundled codebase locator, analyzer, pattern-finder, research locator, and research analyzer agent tool allowlists to read/search/directory tools only, preventing these read-only helpers from invoking `bash` while they locate or analyze code.

## [0.8.26-alpha.10] - 2026-06-08

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.10 prerelease.

## [0.8.26-alpha.9] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.9 prerelease.

## [0.8.26-alpha.8] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.8 prerelease.

## [0.8.26-alpha.7] - 2026-06-07

### Added

- Replaced the bundled browser-use subagent integration with the first-party `browser` skill for web interaction workflows.

## [0.8.26-alpha.6] - 2026-06-06

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.6 prerelease.

## [0.8.26-alpha.5] - 2026-06-06

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.5 prerelease.

## [0.8.26-alpha.4] - 2026-06-05

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.4 prerelease.

## [0.8.26-alpha.3] - 2026-06-05

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.3 prerelease.

## [0.8.26-alpha.2] - 2026-06-05

### Fixed

- Fixed the `no-staged-files` acceptance runtime check and subagent worktree Git commands to ignore ambient Git repository environment variables, so subagents inspect the intended working tree instead of a parent hook or unrelated worktree.
- Suppressed intermediate model fallback failure notes and live foreground failure updates from successful subagent runs while preserving final failures and raw per-attempt diagnostics ([#1226](https://github.com/bastani-inc/atomic/issues/1226)).

## [0.8.26-alpha.1] - 2026-06-05

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.1 prerelease.

## [0.8.25] - 2026-06-04

### Changed

- Promoted the 0.8.25 prerelease package version to a stable release.

## [0.8.25-alpha.1] - 2026-06-04

### Changed

- Bumped package version for the Atomic 0.8.25-alpha.1 prerelease.

## [0.8.24] - 2026-06-04

### Changed

- Promoted the 0.8.24 prerelease package version to a stable release.

## [0.8.24-alpha.4] - 2026-06-04

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.4 prerelease.

## [0.8.24-alpha.3] - 2026-06-03

### Added

- Synced upstream dynamic fanout and acceptance-gate support for subagent chains, including `.chain.json` discovery, named chain outputs, structured subagent output capture, workflow graph status rendering, and explicit acceptance contracts.

### Fixed

- Synced the upstream final-output fix so multi-part assistant responses use the last non-empty text part as the subagent's final output.

## [0.8.24-alpha.2] - 2026-06-03

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.2 prerelease.

## [0.8.24-alpha.1] - 2026-06-02

### Added

- Added suffix-first reasoning levels for subagent `model` and `fallbackModels` values plus `fallbackThinkingLevels` compatibility metadata and per-attempt `reasoningLevel` reporting ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

### Changed

- Migrated packaged subagents to encode their reasoning level directly in model and fallback model entries ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Documented the `model_name:thinking_effort` suffix syntax and `thinking` migration guidance in the subagents docs, package README, and subagent skill ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Adopted the new `-alpha.N` prerelease version convention (revision starting at 1), replacing the legacy numeric `-N` prerelease suffix in the release tooling (bump script, CI publish validation, and changelog parsing).
- Dropped the leading `v` from release git tags and `release/`/`prerelease/` branch names; the Publish CI now triggers on and validates bare version tags such as `0.8.24` or `0.8.24-alpha.1`.

### Deprecated

- Deprecated separate subagent `thinking` configuration in favor of `model: <model>:<level>` and suffixed `fallbackModels` entries; removal is deferred to a later breaking release ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

### Fixed

- Fixed foreground subagent attempt metadata to report the per-candidate reasoning level derived from the model suffix even when the legacy `thinking` option is unset, matching the background run path ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Fixed the subagent chain clarification TUI to strip only canonical reasoning-level suffixes when editing a step's level, so colon-tagged model ids such as `ollama/llama3:latest` are no longer mis-split; consolidated the duplicate thinking-suffix split helpers onto the single `splitKnownThinkingSuffix` so the parsing rules cannot drift apart ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

## [0.8.23] - 2026-06-02

### Changed

- Promoted the 0.8.23 prerelease package version to a stable release.

## [0.8.23-0] - 2026-06-02

### Changed

- Bumped package version for the Atomic 0.8.23 prerelease.

## [0.8.22] - 2026-06-01

### Fixed
- Surfaced Codex fast-mode state in foreground result badges, async widgets, and async status output, while scoping child fast-mode launches to the parent chat or workflow surface.
- Stabilized async subagent widgets and foreground spinner animation so visible status updates no longer remount widgets or churn elapsed/activity text between semantic progress changes.
- Hydrated durable active async runs into the below-editor widget and hardened global npm skill discovery with quieter probing, conservative timeouts, and cached failures.

## [0.8.22-0] - 2026-06-01

### Fixed
- Show Codex fast-mode launch metadata in foreground subagent result badges, async subagent widgets, and async status output when eligible OpenAI/OpenAI Codex child runs start with `/fast` enabled ([#1153](https://github.com/bastani-inc/atomic/issues/1153)).
- Scope subagent Codex fast-mode launches to the parent chat surface, so main-chat subagents follow `codexFastMode.chat` while workflow-node subagents follow `codexFastMode.workflow` ([#1153](https://github.com/bastani-inc/atomic/issues/1153)).
- Keep the async subagent widget mounted across visible status updates, capture widget animation clocks outside arbitrary host re-renders, and animate foreground subagent chatbox spinners with spinner-only ticks that leave elapsed/activity text stable between semantic progress updates ([#1150](https://github.com/bastani-inc/atomic/issues/1150)).
- Harden global npm skill discovery by suppressing noisy probe output while keeping a conservative timeout and caching failures for constrained environments.
- Hydrate active async subagent runs from durable status files into the below-editor widget so background work visible via `subagent({ action: "status" })` also appears in the TUI after launch/session rebinding ([#1146](https://github.com/bastani-inc/atomic/issues/1146)).

## [0.8.20] - 2026-05-29

### Changed
- Promoted the 0.8.20 prerelease changes to a stable release.

## [0.8.20-0] - 2026-05-29

### Fixed

- Fixed the subagent running spinner freezing/stuttering and the surrounding TUI flickering while subagents run: the running glyph is now driven by wall-clock time with a steady re-render ticker (result cards, slash result cards, and the async-agents widget), so it animates smoothly and continuously instead of only advancing when progress data changes. Per-frame diffs stay limited to the spinner glyph cell, so the differential renderer keeps doing partial redraws (no full-screen clear / flicker), and the ticker is torn down on completion, reload, and session shutdown ([#1084](https://github.com/bastani-inc/atomic/issues/1084)).
- Moved the async-agents (background subagent) widget from above the editor to below it (`belowEditor`). The widget animates a running glyph and elapsed labels every tick; pi-tui full-clears the screen+scrollback whenever a changed line sits above the viewport fold, so an above-editor widget flickered once the bottom region grew tall and pushed it above the fold. Rendering below the editor keeps the live line within the bottom viewport (flicker-free) and matches the workflow companion widget's placement ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Hardened workflow-stage subagent guard propagation tests with an internal executor runtime DI seam ([#1088](https://github.com/bastani-inc/atomic/issues/1088)).
- Capped subagent fanout spawned from workflow stages to a single child level with a workflow-specific nested-subagent error.
- Fixed builtin subagent skill resolution from project cwd ([#1087](https://github.com/bastani-inc/atomic/issues/1087)).

## [0.24.3] - 2026-05-14

### Added
- Show provider-free model and thinking labels in async subagent widgets and status views.
- Added a packaged `/review-loop` prompt for parent-controlled worker, fresh-reviewer, and fix-worker cycles that can run as an initial async chain or as follow-up subagent runs after async worker completions, stopping when reviewers find no fixes worth doing now or the review-round cap is reached.

### Fixed
- Let `async: true` chain tool calls run in the background when `clarify` is omitted, and avoid showing the async badge for explicit foreground clarify runs.

## [0.8.18] - 2026-05-27

### Changed
- Promoted the 0.8.18 prerelease package version to a stable release.

## [0.8.17] - 2026-05-26

### Changed
- Promoted the 0.8.17 prerelease package version to a stable release.

## [0.8.16] - 2026-05-26

### Changed
- Promoted the 0.8.16 prerelease package version to a stable release.

## [0.8.15] - 2026-05-26

### Added
- Synced upstream nested subagent fanout support, including child-safe nested `subagent` registration for explicitly authorized agents, nested status/control metadata, and parent-visible nested summaries.

### Fixed
- Include selected direct MCP tool names in explicit child tool allowlists when metadata cache/config resolution is available.
- Bound nested fanout control inbox retry/dedupe state and clean stale nested event/run directories during extension startup.
- Serialize nested registry projection and expand the processed-event replay guard to avoid concurrent sidecar write races and active-session replay churn.
- Write async runner config files with owner-only permissions so nested route capability tokens are not exposed through permissive umasks.
- Treat provider-coerced single-run `output: "false"` the same as boolean `false`, preventing literal `false` output files.
- Respect read-only completion guard overrides and document `completionGuard: false` as a user-authored frontmatter escape hatch.
- Suppress flashing console windows when spawning child processes on Windows (`windowsHide: true`).
- Append the current user-selected model as the final subagent fallback candidate, so retryable provider/model failures still get one last attempt after configured `fallbackModels` are exhausted.
- Keep subagent running glyphs stable between live animation ticks by deriving their base frame from progress state.
- Treat intermediate child provider/tool errors as recovered when a later clean assistant response succeeds, for both foreground and async subagent runs.

## [0.24.2] - 2026-05-10

### Fixed
- Show the `Ctrl+O` live-detail affordance for running single async subagent widgets when step details are available, while keeping the generic activity fallback before step status arrives.

## [0.24.1] - 2026-05-10

### Changed
- Migrated Pi package imports and package metadata to the `@earendil-works/*` scope, switched async TypeScript execution discovery to upstream `jiti`, and hardened forked-session creation to use the public `SessionManager.open()` path.

## [0.24.0] - 2026-05-03

### Changed
- Consolidated async step activity and parallel-outcome formatting used by widgets and `subagent({ action: "status" })` output.
- Updated `/parallel-review` and `/parallel-cleanup` to end review synthesis with numbered follow-up choices, plus an `autofix` mode for automatically applying fixes worth doing now.
- Include async run output paths in `subagent({ action: "status" })` output so the remaining inspection path covers the logs previously surfaced by the removed overlay.

### Removed
- Removed the unnecessary `/agents` manager overlay, its `Ctrl+Shift+A` shortcut, and the `agentManager.newShortcut` setting to cut unnecessary UI surface area; agent and chain management remains available through tool actions, settings, and markdown files.
- Removed persistent save actions from the chain clarify UI: `S` no longer writes runtime overrides back to agent frontmatter, and `W` no longer saves `.chain.md` files. Clarify now only edits the imminent run.
- Removed the `/subagents-status` read-only overlay and its slash command; async runs remain inspectable through `subagent({ action: "status" })`, completion notifications, logs, and the async widget.
- Removed the standalone `src/tui/text-editor.ts`; chain clarify now keeps its small runtime editor logic local to the only remaining consumer.

## [0.23.1] - 2026-05-02

### Added
- Persist async per-child session metadata and remember recent foreground child session metadata so `resume` can revive multi-child async runs and foreground children by index.

### Fixed
- Keep foreground children alive when they call `contact_supervisor` for a blocking decision by treating it as intercom coordination during parent detach, matching the generic `intercom` handoff path.
- Pause foreground parallel and chain flows when a child detaches for intercom coordination instead of counting the child as a successful completed result and continuing the workflow, and suppress grouped completion receipts for detached chains.
- Tighten resume/revive safety by rejecting pending async children, detached foreground children that may still be live, ambiguous foreground/async id prefixes, and exact invalid resume matches that would otherwise be masked by a prefix match in the other namespace.
- Preserve child session metadata in stale-run repaired results and avoid advertising revive from top-level-only or missing child session files.
- Stop builtin `reviewer` runs from writing progress by default, clarify that review-only/no-edit instructions win over progress-writing or artifact-writing instructions, and suppress automatic progress injection for explicit no-edit tasks even when chain templates use `{task}`.
- Treat parsed provider errors as failed foreground and async subagent attempts even when the child process exits successfully, and baseline saved output files per fallback attempt.
- Preserve output-file read and inspect errors instead of silently overwriting or falling back when a changed saved-output path cannot be read.
- Show each active async widget row's lifecycle status (`running`, `complete`, `failed`, or `paused`) alongside activity and usage stats.
- Start new direct, slash, prompt-template, foreground, and async subagent launches in compact view while keeping `Ctrl+O` available for live detail.
- Label top-level async parallel completion notifications as parallel runs instead of leaking the internal chain-shaped runner plan.

## [0.23.0] - 2026-05-02

### Fixed
- Detect `pi-intercom` when installed through the documented `pi install npm:pi-intercom` package flow, instead of only checking the legacy local extension path.

### Changed
- Store and discover saved chain workflows from dedicated chain directories: user chains in `~/.pi/agent/chains/**/*.chain.md` and project chains in `.pi/chains/**/*.chain.md`.
- Retry foreground subagent fallback models when Pi reports a retryable provider error, such as 429/quota, even if the child process exits successfully.
- Align single-run async subagent widgets and `/subagents-status` rendering with foreground subagent result styling for parallel, chain, and grouped chain runs, including inline live detail when tool output expansion is enabled, while keeping multi-job async widgets compact.
- Render async subagent widgets through an adaptive component so active parallel agent rows fit without Pi's fixed string-widget truncation marker.
- Tell parent agents that async runs are detached and they should end the turn instead of running sleep/poll loops when no independent work remains.

## [0.22.0] - 2026-05-02

### Added
- Added child-only supervisor contact support for delegated subagents through `contact_supervisor`, with `need_decision` for blocking supervisor replies and `progress_update` for concise non-blocking updates.
- Pass supervisor intercom metadata into foreground, chain, parallel, and background child runs so the child-facing pi-intercom tool can resolve the delegating session automatically.

### Changed
- Builtin agents now inherit the user's configured default model instead of pinning `openai-codex/gpt-5.5`; use builtin overrides to pin a model for a role.
- Hide unsupported thinking levels in subagent clarify and agent-manager pickers when Pi exposes per-model thinking metadata.
- Updated builtin agent prompts, README, and bundled skill docs to prefer `contact_supervisor` for blocked decisions and avoid child-side routine completion handoffs.
- Teach reviewer agents that repo-local `progress.md` files are intentional scratch files that should remain untracked and covered by `.gitignore`.

### Fixed
- Added regression coverage for supervisor metadata propagation into child process environments.

## [0.21.5] - 2026-05-02

### Fixed
- Show top-level async parallel runs as `parallel` instead of `chain`, with foreground-style running/done wording in widgets and status output, and group running async chain detail by chain step.
- Scoped `/subagents-status` to async runs launched from the current pi session instead of showing prior or unrelated sessions.
- Declared the Pi TUI package as a direct dev dependency and added a manifest guard so CI installs do not rely on transitive optional peer dependencies for tests.
- Made prompt-runtime extension path assertions portable on Windows.

## [0.21.4] - 2026-05-01

### Added
- Added explicit frontmatter `package` identifiers for agents and saved chains, registering runtime names like `code-analysis.scout` while preserving separate `name` and `package` fields on save.
- Added recursive subdirectory discovery for user and project agent and chain definitions.
- Added `outputMode: "inline" | "file-only"` for saved subagent outputs. `inline` remains the default, while `file-only` returns a concise saved-file reference instead of injecting full saved output back into the parent context.

### Fixed
- Marked Pi runtime peer dependencies as optional so npm package installs do not auto-install duplicate Pi packages or emit unrelated transitive dependency warnings.

## [0.21.3] - 2026-04-30

### Fixed
- Debounce foreground `needs_attention` notices, make them non-triggering, and cancel them when the run finishes so stale chain-step alerts do not launch parent turns after completion.

## [0.21.2] - 2026-04-30

### Added
- Added a packaged `/parallel-context-build` prompt for parallel `context-builder` handoff passes.
- Added a packaged `/parallel-handoff-plan` prompt for external-reference research plus local `context-builder` passes that produce an implementation handoff meta-prompt.

### Changed
- Strengthened `context-builder` guidance so handoffs require reading all relevant files and doing needed tool-available research before summarizing.
- Expanded the bundled `pi-subagents` skill with tool-level recipes for the packaged prompt workflows, including context-build and handoff-plan patterns that parent agents can apply without slash commands.
- Updated `README.md` to explain the bundled `pi-subagents` skill, what it covers, and how it helps the orchestrating agent.

### Fixed
- Make active-long-running notices time-based by default, with turn and token thresholds available only as explicit opt-in budget guards.
- Stop async status listing from inventing `needs_attention` with default thresholds when the runner has not persisted a control state.
- Treat string `"false"` output settings as disabled output so parallel reviewers do not collide on a `/false` output path, including chain-parallel agent defaults.
- Wrap long `/subagents-status` detail output/event lines instead of truncating them with ellipses.
- Treat cleanup after a clean terminal assistant stop as success even when the final assistant text is empty, using a short grace period before terminating lingering child processes without surfacing scary final-drain warnings.
- Express flexible tool schema fields as `anyOf` unions without parent-level `type` arrays, avoiding schema shapes rejected by strict providers such as Moonshot/opencode-go.

## [0.21.1] - 2026-04-30

### Changed
- Changed the `/agents` new-agent shortcut from `Alt+N` to `Shift+Ctrl+N`, and added `agentManager.newShortcut` config for overriding it.

### Fixed
- Fall back to polling async result files when native result watching is unavailable due to `EMFILE` or `ENOSPC`.
- Treat forced final-drain termination after a valid final assistant output as cleanup success instead of failing the subagent run.
- Hide disabled builtin agents from `subagent({ action: "list" })` output so agent-facing choices match executable runtime discovery.
- Resolve intercom bridge default paths at runtime so tests and isolated environments that change `HOME` use the correct `pi-intercom` location.
- Made the tool-description source check tolerant of Windows line endings.

## [0.21.0] - 2026-04-29

### Changed
- Document the recommended parent-agent workflow as `clarify → planner → worker → fresh reviewers → worker` in the docs and bundled skill.
- Packaged `planner`, `worker`, and `oracle` now default to forked session context when the launch omits `context`; explicit `context: "fresh"` still overrides the agent default.
- Expanded builtin subagent guidance so agents with a safe pi-intercom target can hand results back with blocking `intercom ask`, documented the self-orchestrated clarify → plan → implement → review workflow, and added GPT-5.5-oriented subagent prompt guidance to the bundled skill and `context-builder`.

### Fixed
- Prevent child subagents from receiving parent orchestration tooling/history, and inject boundary instructions that forbid sub-delegation and pseudo tool calls.
- Added active-long-running and repeated mutating-tool failure notices so supervised/forked workers cannot burn turns silently while still appearing healthy.
- Fixed task editor wrapping so wide characters cannot push text past the right border.
- Mark implementation subagents as failed when they complete without any file mutation attempt.
- Applied the same no-mutation completion guard to async/background runner paths.
- Split terminal no-mutation guard notices from live idle notices so completed failures do not suggest status or interrupt commands.
- Clarified worker/intercom bridge instructions so blocked decisions use `intercom ask` and stay alive for the reply instead of completing with a question.
- Labeled the Agents widget as async/background work so running detached agents are easier to identify.
- Reworked parallel progress wording so parallel runs show running/done agent counts (and chain parallel groups show `step X/Y · parallel group` with agent fractions) instead of serial `step X/Y` counters.
- Expanded `/parallel-cleanup` guidance to flag redundant wrapper tests when one focused regression is enough.
- Fixed flexible schema validation for `reads` and `skill` overrides so `reads: false`, `skill: "review"`, and `skill: false` no longer trigger `element.reads.every is not a function` (issue #124).
- Hardened slash-result and async-widget animation timers so stale extension contexts after `/new` or reload stop their timers instead of crashing on `ctx.ui` access (issue #122).

## [0.20.1] - 2026-04-27

### Fixed
- Made the packaged `/parallel-cleanup` prompt self-contained instead of referencing local-only cleanup skills.

## [0.20.0] - 2026-04-27

### Added
- Added a packaged `/parallel-cleanup` prompt for focused cleanup review passes.

### Changed
- Consolidated the `oracle-executor` role into `worker`: `worker` now uses `openai-codex/gpt-5.3-codex` with high thinking and stricter approved-direction guardrails, while `researcher` and `context-builder` now use medium thinking.
- Updated the bundled `scout` agent model/thinking defaults.
- Hard-cut over grouped intercom bridge result delivery: with the bridge active, parent-side `pi-subagents` emits one grouped `subagent:result-intercom` message per foreground parent run (single, top-level parallel, or chain) and one per completed async result file. Acknowledged foreground delivery returns a compact receipt instead of duplicating full output in the normal tool result; unacknowledged delivery preserves the normal full output. Grouped messages include child intercom targets and full child summaries.

### Fixed
- Fixed status and manager row rendering so multiline or tabbed content cannot overflow table rows.

### Removed
- Removed the bundled `oracle-executor` agent and `/oracle-executor` prompt template in favor of using `worker` for approved oracle handoffs.

## [0.19.3] - 2026-04-27

### Changed
- Updated the packaged `/parallel-review` prompt so reviewer angles are generated dynamically from the user's intent, plan, implemented code, and current diff, with the listed angles framed as examples rather than fixed defaults.

## [0.19.2] - 2026-04-27

### Added
- Added packaged prompt templates for common subagent workflows: `/parallel-research`, `/gather-context-and-clarify`, and `/oracle-executor`.

### Changed
- Tightened the packaged `/parallel-review` prompt so fresh-context reviewers get distinct angles and return evidence-backed findings.
- Refreshed the packaged `pi-subagents` skill with doctor diagnostics, saved-chain launches, prompt shortcuts, builtin overrides, intercom bridge guidance, fresh-context review defaults, and parallel task behavior.
- Reworked the README around plain-language usage, good first prompts, packaged prompt shortcuts, builtin agent guidance, intercom setup, model overrides, and optional reference material.

## [0.19.1] - 2026-04-26

### Added
- Added `subagent({ action: "doctor" })` and `/subagents-doctor` for read-only subagent environment diagnostics.
- Added `/run-chain` to launch saved `.chain.md` workflows directly from slash commands with completion, shared task input, and `--bg`/`--fork` support.

## [0.19.0] - 2026-04-26

### Added
- Added top-level parallel task support for per-task `output`, `reads`, and `progress`, including `/parallel` inline forwarding and async preservation.
- Added `/agents` launch toggles for forked context, background execution, and worktree-isolated parallel runs.
- Added a read-only detail view to `/subagents-status` for inspecting selected async runs, including recent events, output tails, and useful run paths.
- Added a packaged `/parallel-review` prompt template for launching fresh-context adversarial review subagents.

### Fixed
- Parallel and chain child runs now detach cleanly when a child uses intercom, preventing incoming handoff messages from aborting the parent foreground run.

## [0.18.1] - 2026-04-25

### Changed
- Restyled live subagent rendering, async widgets, and background completion notifications with compact Claude-style visual grammar while preserving existing observability paths.
- Parallel subagent result rendering now labels parallel workers as `Agent N` instead of `Step N`, while chain rendering keeps step terminology.

### Fixed
- `/run` and single-agent tool calls now allow self-contained agents to run without a task string.
- The `subagent` tool description no longer advertises hardcoded builtin agent names and management list output now separates disabled builtins from executable agents.
- Flexible `subagent` tool schema fields now include explicit JSON Schema types so llama.cpp and local OpenAI-compatible providers accept them.
- Settings package sources now resolve explicit `git:` and `npm:` entries from project and user package caches.
- Slash-command subagent results are now export-friendly, including completed output and child session paths in visible export content.

## [0.18.0] - 2026-04-23

### Added
- Added subagent control notifications so `needs_attention` signals push structured parent events, persist async control events to `events.jsonl`, show visible transcript notices for the user and parent agent, include proactive `nudge`/`status`/`interrupt` commands when a child appears blocked, and show each visible notice at most once per child run and attention state.
- Added stable child intercom session names for controlled subagents so needs-attention pings can tell the orchestrator which agent needs attention and how to message it when intercom is available.

### Changed
- Replaced the unreleased `starting`/`active`/`quiet`/`stalled`/`paused` activity labels with factual activity reporting and a single `needs_attention` control signal, keeping `paused` as lifecycle state only.
- Added `subagent({ action: "status", id })` and `subagent({ action: "status" })` as the control-surface status checks, replacing the separate `subagent_status(...)` tool.
- Adjusted bundled agent defaults: most builtins now use `openai-codex/gpt-5.5`, while `scout` uses `openai-codex/gpt-5.4-mini`.
- Removed the incomplete e2e suite and stale `@marcfargas/pi-test-harness` dev dependency; `test:all` now runs the maintained unit and integration suites.

### Fixed
- Paused async runs now render `Background task paused` notifications instead of failed/completed copy, including after extension reloads with stale legacy listeners still present.
- Async status output no longer shows stale activity-age lines for paused or completed runs.

## [0.17.5] - 2026-04-23

### Added
- Added subagent control activity state for foreground and async runs, including `starting`/`active`/`quiet`/`stalled`/`paused` tracking, compact stalled/recovered/paused control events, and an in-tool `action: "interrupt"` soft interrupt that pauses the current child turn without adding another top-level tool.

### Changed
- Updated bundled agents to use `openai-codex/gpt-5.5` defaults, with `scout` on `openai-codex/gpt-5.5-mini` and `oracle-executor` on `openai-codex/gpt-5.5:xhigh`.

### Fixed
- Async/background status token reporting now falls back to in-memory model-attempt usage when detached runs do not produce session `.jsonl` files, which also preserves token totals across model fallback retries.
- Non-Windows subagent launches now use plain `pi` again instead of reusing the current CLI script path, avoiding runs that get confused by installed `dist/cli.js` entrypoints.

## [0.17.4] - 2026-04-22

### Added
- Bundled a `pi-subagents` skill that teaches agents how to use builtin subagents, slash-command vs tool workflows, management-mode agent creation/editing, fork/intercom coordination, clarify mode, worktrees, async status inspection, and chain templating.

### Changed
- Tightened the builtin `oracle` prompt so intercom-enabled forked reviews now prefer concise conversational handoffs during the review and send a short final recommendation via `pi-intercom` before returning the full structured result.
- Tightened `oracle-executor` so it explicitly frames itself as the single writer thread and escalates gaps in the approved direction instead of silently patching around them.

## [0.17.3] - 2026-04-22

### Added
- Added builtin `oracle` and `oracle-executor` agents for the `main -> oracle -> main decision -> oracle-executor` workflow, plus README guidance for invoking the oracle pair with forked context.

### Fixed
- Migrated extension tool schemas from `@sinclair/typebox` to `typebox` 1.x so packaged installs follow Pi's current extension runtime contract.

### Changed
- Moved TypeBox from `peerDependencies` to a real `dependencies` entry so `pi install` production installs keep the schema package available at runtime.

## [0.17.2] - 2026-04-21

### Added
- Added `forceTopLevelAsync` so depth-0 delegated runs can be forced into background mode with `clarify: false`, while nested runs keep their existing behavior.

### Fixed
- Background completion notifications now render `(no output)` instead of a blank body when a completion summary is empty or whitespace-only.
- Async status and token reporting now rerender more reliably when cleanup state changes, read token usage from `message.usage`, and prefer the newest session file when multiple async session files exist.
- Async/background startup now fails fast for invalid resolved `cwd` values and spawn failures instead of reporting false launch success.
- Sync and async runner paths now drain stuck child processes in bounded time, covering both post-exit stdio holders and children that emit a final message but never exit.

## [0.17.1] - 2026-04-20

### Added
- Foreground subagent runs now make deeper live detail easier to discover. Running cards show an explicit `Ctrl+O` hint, lightweight live-state signals like recent activity, current-tool durations, and artifact output paths when available. Common array-heavy tool previews such as `web_search.queries` and `fetch_content.urls` are now summarized more clearly instead of collapsing into opaque fallback text.

### Changed
- Forked delegated runs now use stronger prompt-side guidance for `pi-intercom` coordination instead of runtime policing. The default fork preamble and intercom bridge instructions now explicitly treat inherited fork history as reference-only context, tell children not to continue the parent conversation in normal assistant text, and steer upstream questions or handoffs through `intercom` when needed.
- Documented an opt-in custom agent pattern for forked chat-back workflows so users can make that coordination contract explicit without changing builtin agents.
- Slash-run status text and `/subagents-status` summary output now use the same more explicit observability language, including clearer live-detail hints and surfaced output/session paths in the async status overlay.
- Builtin agent defaults now prefer `openai-codex` models for `planner`, `scout`, `researcher`, `context-builder`, and `worker`.

### Fixed
- Removed the short-lived foreground intercom enforcement/retry layer from delegated fork runs. Coordination behavior is now shaped by prompt and agent design only, avoiding hidden retries, heuristic output inspection, and failure paths based on guessed intent.

## [0.17.0] - 2026-04-16

### Added
- Builtin agents can now be disabled through `subagents.agentOverrides.<name>.disabled` or the bulk `subagents.disableBuiltins` setting, with `/agents` keeping disabled builtins visible so they can be re-enabled from the manager. This builds on PR `#81`. Thanks @danielcherubini.

### Fixed
- Builtin disable precedence is now coherent across user and project settings: project overrides beat user overrides, project bulk disable beats user re-enable attempts, and same-scope per-agent overrides can opt an agent out of bulk disable.
- `/agents` now blocks launching disabled builtins, shows their disabled state in list/detail views and management output, and avoids exposing the builtin-only `disabled` field when editing normal user/project agents.
- Multi-agent chain launches from `/agents` now collect a task before dispatching instead of emitting an empty task, and settings read failures now surface as read errors instead of being mislabeled as parse failures.

## [0.16.1] - 2026-04-16

### Changed
- Parallel subagent startup no longer applies any worker-start stagger in `mapConcurrent()`. `pi-subagents` now relies on Pi core's settings/auth lock retry behavior instead of carrying its own startup-delay workaround.

## [0.16.0] - 2026-04-16

### Added
- Top-level parallel `tasks` mode now supports a per-call `concurrency` override, matching the existing chain parallel-step concurrency control. This ships part of issue `#91`. Thanks @Gabrielgvl.

### Changed
- Top-level parallel defaults and limits can now be configured through `~/.pi/agent/extensions/subagent/config.json` under `parallel.maxTasks` and `parallel.concurrency`, while keeping the existing defaults of 8 tasks and concurrency 4 when unset. This completes issue `#91`. Thanks @Gabrielgvl.

### Fixed
- `context: "fork"` sync runs now create child sessions from a throwaway session-manager instance opened on the persisted parent session file, instead of mutating the live parent session manager. This keeps the parent session writing to its own file so the matching `toolResult(subagent)` no longer lands in a descendant session by accident. This fixes issue `#87`. Thanks @asmisha.
- Project agent and chain discovery now reads both `.agents/` and `.pi/agents/`, while preferring `.pi/agents/` when both locations define the same parsed name and keeping manager writes on the `.pi/agents/` path. This fixes issue `#88`. Thanks @desek.
- Ctrl+O expanded subagent results now actually show expanded content. Previously the `expanded` flag was received but ignored, so task text and tool-call args were identically truncated in both views. Now expanded mode shows the full task and longer (but still bounded) tool-call previews. Additionally, tool calls are no longer lost after foreground compaction: compact display summaries are preserved and shown in expanded view even after `messages` are stripped. This addresses issue `#90`. Thanks @asagajda.

## [0.15.0] - 2026-04-16

### Added
- Added `systemPromptMode` so subagents can replace Pi's base prompt with `--system-prompt` instead of always appending with `--append-system-prompt`, shipping the core of issue `#85` from @isvlasov.
- Added `inheritProjectContext` and `inheritSkills` so child runs can keep or strip inherited project instruction files (`AGENTS.md`, `CLAUDE.md`, etc.) and Pi's discovered skills block.

### Changed
- Builtin subagents now default to `systemPromptMode: replace`, with builtin `delegate` staying on `append`.
- Builtin agents now inherit project-level instruction files by default unless the user overrides them.
- Builtin agent prompts were rewritten for the new prompt-assembly model, and builtin `reviewer` / `context-builder` tool lists now match their documented behaviors. This rounds out the prompt-assembly work merged in PR `#92`, which closed issue `#85`. Thanks @isvlasov.

### Fixed
- Cross-platform tests now avoid machine-specific Pi install paths, align homedir-sensitive settings discovery on Windows CI, and use deterministic async config-write failure fixtures.
- Request-level `cwd` handling is now consistent across management and execution paths. `subagent` requests that target a worktree or nested checkout now resolve project agents, project settings, and builtin agent overrides from the requested `cwd` instead of accidentally inheriting the parent session's repo. This fixes issue `#83`. Thanks @hakin19 for the report.
- Relative child `cwd` values now resolve from the already-selected request/shared `cwd` across sync runs, async/background runs, chain steps, and top-level parallel tasks. This fixes cases where values like `packages/app` were interpreted from the wrong base directory, which could break skill lookup, output paths, and child process spawning.
- Worktree parallel-mode validation now compares task-level `cwd` overrides after relative-path resolution, so equivalent paths like `.` no longer trigger false conflict errors against the shared worktree base.
- Internal TypeScript source imports in the touched runtime paths now consistently use `.ts` local specifiers, matching the repo's direct TypeScript runtime loading conventions and reducing drift between adjacent modules.

## [0.14.1] - 2026-04-14

### Fixed
- Completed foreground subagent results now return compact payloads instead of inlining full raw message histories and per-result progress objects, preventing long tool-heavy sync runs from overwhelming the parent agent return path.
- Prompt-template delegation now rebuilds minimal assistant messages from compact foreground results when raw message arrays are intentionally omitted.
- UI/status wording now uses plain text labels instead of glyph-heavy markers across foreground rendering, parallel summaries, save-result receipts, installer output, agent manager views, clarify screens, and the corresponding README/CHANGELOG examples.
- Added a realistic foreground integration repro for issue `#80` and cleaned up the touched tests to remove the remaining blunt `as any` fixture casts.

## [0.14.0] - 2026-04-14

### Added
- Builtin agents can now be customized through settings-backed field overrides in `~/.pi/agent/settings.json` and `.pi/settings.json` under `subagents.agentOverrides`, with `/agents` exposing a create/edit override flow instead of forcing full-file copies for model/thinking/tool/prompt tweaks.

### Fixed
- Shared temp paths are now scoped under a user-specific temp root across async result storage, async run state, chain directories, artifact fallback storage, and detached async config files, avoiding cross-user collisions on shared machines while still handling arbitrary-UID/container environments where `os.userInfo()` can throw.
- Async/background runs now launch child `pi` processes in JSON mode, stream child events into `events.jsonl` with step metadata while the run is active, keep `output-<n>.log` live with human-readable child output, and document that `subagent-log-<id>.md` is a completion artifact.
- Bare model IDs now prefer the active parent-session provider when that provider actually exposes the model, across sync, chain, parallel, async, and clarify flows. Ambiguous bare IDs still fall back to conservative resolution.
- Skill resolution now includes local package roots declared in project/user `settings.json -> packages`, checks the effective task `cwd` before the runtime cwd, and still falls back to the runtime cwd when a nested task inherits package-provided skills from the repo root.

## [0.13.4] - 2026-04-13

### Fixed
- Intercom orchestration now uses a runtime-only `subagent-chat-<id>` fallback target for unnamed sessions instead of persisting a generic session title, so `pi --resume` keeps showing transcript snippets while delegated intercom routing still works.
- GitHub Actions test workflow now uses `actions/checkout@v5` and `actions/setup-node@v5`, removing Node 20 action-runtime deprecation warnings ahead of the enforced Node 24 transition.
- Worktree cwd mapping now derives repo-relative prefixes from `git rev-parse --show-prefix` instead of `path.relative(realpath, realpath)`, fixing Windows 8.3/canonical-path mismatches that could map `agentCwd` back to the source repo instead of the created worktree.
- Async background runs now pass the parent process `argv[1]` through to the detached runner, so Windows child spawning keeps targeting the intended `pi` CLI entry point instead of accidentally treating the runner's `jiti` bootstrap script as `pi`.
- Intercom detach listeners now guard optional event-bus subscriptions with optional-call semantics, so delegated runs no longer fail when host event buses expose `emit` without `on`.
- Skill discovery no longer depends on runtime imports from `@bastani/atomic`; it now resolves skills directly from configured filesystem paths, preventing `ERR_MODULE_NOT_FOUND` crashes in local/integration test environments.

## [0.13.3] - 2026-04-13

### Added
- Added `intercomBridge.instructionFile` so subagent intercom guidance can be overridden from a Markdown template with `{orchestratorTarget}` interpolation.

### Fixed
- Intercom-enabled delegated runs now detach only after the child actually starts the `intercom` tool, preserving clean sync behavior until coordination is needed.
- Graceful intercom coordination no longer leaves detached child runs vulnerable to later parent abort listeners, and reply confirmation follow-ups avoid unnecessary orchestrator aborts.
- Child process spawn failures now preserve the original error message instead of collapsing to a generic failure.

## [0.13.2] - 2026-04-13

### Changed
- `intercomBridge` now defaults to `always` so intercom coordination instructions are injected for both `fresh` and `fork` delegated runs when `pi-intercom` is available.

## [0.13.1] - 2026-04-13

### Added
- Added optional intercom orchestration bridge for delegated runs. When enabled via `intercomBridge` (default `fork-only`) and `pi-intercom` is available, child subagents get runtime coordination instructions for contacting the orchestrator session via `intercom`, and `intercom` is auto-added to the child tool allowlist when needed.
- Added unit coverage for intercom bridge activation, config handling, and extension allowlist behavior.

### Changed
- Normalized `subagent-executor.ts` relative imports to `.ts` specifiers to match direct TypeScript runtime loading.
- Documented `pi-intercom` installation and activation requirements in README.

### Fixed
- Tightened intercom extension allowlist matching to avoid false positives from similarly named extension paths.

## [0.13.0] - 2026-04-11

### Added
- Added native agent `fallbackModels` support. Agents can now declare ordered backup models, and single, chain, parallel, and async/background runs retry on provider/model-style failures such as quota, auth, timeout, or provider/model unavailability.

### Fixed
- Fallback attempts now preserve observability across sync and async execution: results, artifact metadata, async status, and run logs record attempted models and per-attempt outcomes instead of only the final pass.
- Child subagent runs now pass model selections through `--model` instead of `--models`, so live execution pins the intended model correctly and end-to-end fallback behavior matches the validated test path.

## [0.12.5] - 2026-04-09

### Fixed
- Slash-command result cards now finalize through the extension's own snapshot timing instead of relying on core to treat hidden custom messages as in-place updates. The final slash snapshot and hidden persisted message are written before the last status-clear redraw, so live `/run`, `/chain`, and `/parallel` cards update to their final state more reliably.
- Added focused slash-command regression coverage for the success/error ordering around visible placeholder messages, hidden final messages, and the final status-clear redraw.

## [0.12.4] - 2026-04-04

### Added
- Added configurable subagent recursion depth controls with global `maxSubagentDepth` config and per-agent `maxSubagentDepth` frontmatter overrides. Child delegation now honors stricter inherited limits while still allowing per-agent tightening.
- Added optional worktree setup hooks via extension config (`worktreeSetupHook`, `worktreeSetupHookTimeoutMs`). Hooks run once per created worktree, receive JSON over stdin, return JSON on stdout, and can declare synthetic helper paths (e.g. `.venv`, copied local config files) to exclude from patch capture.

### Fixed
- Added support for loading agents and skills from `.agents/` and `~/.agents/` directories.
- Switched internal source imports from `.js` to `.ts` so the extension can be loaded directly from TypeScript sources under the strip-types/transform-types runtime path.
- Declared pi runtime packages and `@sinclair/typebox` as peer dependencies so direct source-loading environments fail less often from missing package resolution.
- Single-output runs now preserve agent-written file contents instead of overwriting them with the final assistant receipt, and artifacts/truncation now follow the authoritative saved file content.
- Async/background runs now reuse the current Node executable and prefer the resolved current pi CLI path on all platforms, avoiding PATH drift from wrapped or version-pinned parent launches.

### Changed
- Added release documentation for TypeScript direct-runtime loading support and related package requirements.

## [0.12.2] - 2026-04-04

### Changed
- Bumped pi package devDependencies to `^0.65.0` (`@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@bastani/atomic`) to stay aligned with current pi SDK/runtime.

## [0.12.1] - 2026-04-03

### Changed
- Updated session lifecycle handling for pi 0.65.0 by removing legacy post-transition resets and relying on `session_start` reinitialization, matching pi's removal of `session_switch` and `session_fork` extension events.

## [0.12.0] - 2026-03-31

### Added
- Added git worktree isolation for parallel execution via `worktree: true`. Applies to top-level parallel `tasks`, chain steps with `{ parallel: [...] }`, and async/background chain execution. Each parallel task gets its own temporary git worktree, and the aggregated output now includes per-task diff stats plus the directory path containing full patch files.
- Added `worktree.ts` to manage worktree lifecycle, diff capture, patch generation, and cleanup for isolated parallel runs.
- Added `count: N` shorthand for top-level parallel `tasks` and chain `parallel` entries so one authored task can expand into repeated identical runs without manual duplication.
- Added `subagent_status({ action: "list" })` to list active async runs with flattened step/member status summaries.
- Added `/subagents-status`, a read-only overlay for active async runs plus recent completed/failed runs with per-run step details. The overlay auto-refreshes while open and preserves the selected run when possible.
- Documented worktree isolation, async status surfaces, and the reorganized test layout in the README.

### Changed
- Consolidated tests under `test/unit`, `test/integration`, `test/e2e`, and `test/support`, replacing the old mixed root-level and `test/` layout. Test scripts now target those directories explicitly.
- Integration tests now use a tiny local file-based mock `pi` harness instead of relying on the external subprocess harness for normal subagent execution.
- Removed legacy extra session lifecycle resets and now rely on immutable-session `session_start` reinitialization, matching pi's removal of post-transition `session_switch`/`session_fork` events.

### Fixed
- Loader-based tests now resolve `.js` → `.ts` imports correctly when the repository path contains spaces or other URL-escaped characters. Added a focused regression test for the custom test loader.
- Worktree-isolated parallel runs now reject task-level `cwd` overrides that differ from the shared batch/step `cwd`, instead of silently ignoring them. Applies to foreground parallel runs, chain parallel steps, and async/background execution.
- Worktree diff capture now includes committed, modified, and newly created files without accidentally including the synthetic `node_modules` symlink used inside temporary worktrees.
- Worktree setup now cleans up already-created worktrees if a later worktree in the same batch fails to initialize.
- Prompt-template delegated parallel responses now preserve the aggregate worktree summary text instead of dropping it when rebuilding the final delegated output.
- Async status and result JSON files are now written atomically so readers do not observe partial JSON during background updates.
- `readStatus()` now returns `null` only for genuinely missing files and preserves real inspect/read/parse failures with context.
- Async status polling and result watching now log status/result/watcher failures instead of silently swallowing them, making background completion/debugging failures visible.
- Slash-command tests now match the current live snapshot contract instead of asserting the stale pre-finalized inline state.

## [0.11.12] - 2026-03-28

### Changed
- Tool history (`recentTools`) in execution progress is now chronological (oldest first) and uncapped, replacing the old newest-first order with a 5-entry cap. Affects all execution paths (tool, slash commands, chains, parallel, async, delegation). Both single-task and chain-step render paths in `render.ts` now consistently use `slice(-3)` for most-recent display.
- Removed 50ms throttle on execution progress updates. `onUpdate` now fires immediately on every tool start, tool end, message end, and tool result. Affects all execution paths.
- Delegation bridge now passes through full `recentOutputLines` arrays, `recentTools` history, and resolved `model` to prompt-template consumers, replacing the old stripped-down single-line updates.

## [0.11.11] - 2026-03-23

### Changed
- Updated for pi 0.62.0 compatibility. `Skill.source` replaced with `Skill.sourceInfo` for skill provenance, `Widget` type replaced with `Component`. Bumped devDependencies to `^0.62.0`.

## [0.11.10] - 2026-03-21

### Changed
- Trimmed tool schema and description to reduce per-turn token cost by ~166 tokens (13%). Removed `maxOutput` from the LLM-facing schema (still accepted internally), shortened `context` and `output` descriptions, removed redundant CHAIN DATA FLOW section from tool description, condensed MANAGEMENT bullet points.

## [0.11.9] - 2026-03-21

### Fixed
- `/agents` overlay launches (single, chain, parallel) and slash commands (`/run`, `/chain`, `/parallel`) now render an inline result card in chat instead of relaying through `sendUserMessage`.
- `/agents` overlay chain launches no longer bypass the executor for async fallback, fixing a path where async chain errors were silently swallowed.

### Changed
- All slash and overlay subagent execution now routes through an event bus request/response protocol (`slash-bridge.ts`), matching the pattern used by pi-prompt-template-model. This replaces both the old `sendUserMessage` relay and the direct `executeChain` call in the overlay handler.
- Slash launches show a live inline card immediately on start that streams current tool, recent tools, and output in real time, rather than appearing only after completion.
- `/parallel` now uses the native `tasks` parameter directly instead of wrapping through `{ chain: [{ parallel: tasks }] }`.

### Added
- `slash-bridge.ts` — event bus bridge for slash command execution. Manages AbortController lifecycle, cancel-before-start races, and progress streaming via `subagent:slash:*` events.
- `slash-live-state.ts` — request-id keyed snapshot store that drives live inline card rendering during execution and restores finalized results from session entries on reload.
- Clarified README Usage section to distinguish LLM tool parameters from user-facing slash commands.

## [0.11.8] - 2026-03-21

### Added
- Prompt-template delegation bridge now supports parallel task execution: accepts `tasks` array payloads, emits per-task `parallelResults` with individual error/success states, and streams per-task progress updates with `taskProgress` entries.

## [0.11.7] - 2026-03-20

### Changed
- Removed the cwd mismatch guard from the prompt-template delegation bridge, allowing delegated requests to specify a working directory different from the active session's cwd.

## [0.11.6] - 2026-03-20

### Added
- Added `delegate` builtin agent — a lightweight subagent with no model, output, or default reads. Inherits the parent session's model, making it the natural target for prompt-template delegated execution.

## [0.11.5] - 2026-03-20

### Added
- Added fork context preamble: tasks run with `context: "fork"` are now wrapped with a default preamble that anchors the subagent to its task, preventing it from continuing the parent conversation. The default is `DEFAULT_FORK_PREAMBLE` in `types.ts`. Internal/programmatic callers can use `wrapForkTask(task, false)` to disable it or pass a custom string (this is not exposed as a tool parameter).
- Added a prompt-template delegation bridge (`prompt-template-bridge.ts`) on the shared extension event bus. The subagent extension now listens for `prompt-template:subagent:request` and emits correlated `started`/`response`/`update` events, with cwd safety checks and race-safe cancellation handling.
- Added delegated progress streaming via `prompt-template:subagent:update`, mapped from subagent executor `onUpdate` progress payloads.

### Changed
- Session lifecycle reset now preserves the latest extension context for event-bus delegated runs.
- `[fork]` badge is now shown only on the result row, not duplicated on both the tool-call and result rows.

## [0.11.4] - 2026-03-19

### Added
- Added explicit execution context mode for tool calls: `context: "fresh" | "fork"` (default: `fresh`).
- Added true forked-context execution for single, parallel, and chain runs. In `fork` mode each child run now starts from a real branched session file created from the parent session's current leaf.
- Added `--fork` slash-command flag for `/run`, `/chain`, and `/parallel` to forward `context: "fork"`.
- Added regression coverage for fork execution/session wiring and fork badge rendering, including slash command forwarding tests.

### Changed
- Session argument wiring now supports `--session <file>` in addition to `--session-dir`, enabling exact leaf-preserving forks without summary injection.
- Async runner step payloads now carry per-step session files so background single/chain/parallel executions can also honor `context: "fork"`.
- Clarified docs for foreground vs background semantics so `--bg` behavior is explicit.

### Fixed
- `context: "fork"` now fails fast with explicit errors when parent session state is unavailable (missing persisted session, missing current leaf, or failed branch extraction), with no silent fallback to `fresh`.
- Fork-session creation errors are now surfaced as tool errors instead of bubbling as uncaught exceptions during execution.
- Session directory preparation now fails loudly with actionable errors (instead of silently swallowing mkdir failures).
- Async launch now fails with explicit errors when the async run directory cannot be created.
- Share logs now correctly include forked session files even when no session directory exists.
- Tool-call and result rendering now explicitly show `[fork]` when `context: "fork"` is used, including empty-result responses.
- `subagent_status` now surfaces async result-file read failures instead of returning a misleading missing-status message.

## [0.11.3] - 2026-03-17

### Changed
- Decomposed `index.ts` (1,450 → ~350 lines) into focused modules: `subagent-executor.ts`, `async-job-tracker.ts`, `result-watcher.ts`, `slash-commands.ts`. Shared mutable state centralized in `SubagentState` interface. Three identical session handlers collapsed into one.
- Extracted shared pi CLI arg-builder (`pi-args.ts`) from duplicated logic in `execution.ts` and `subagent-runner.ts`.
- Consolidated `mapConcurrent` (canonical in `parallel-utils.ts`, re-exported from `utils.ts`), `aggregateParallelOutputs` (canonical in `parallel-utils.ts` with optional header formatter, re-exported from `settings.ts`), and `parseFrontmatter` (extracted to `frontmatter.ts`).

## [0.11.2] - 2026-03-11

### Fixed
- `--no-skills` was missing from the async runner (`subagent-runner.ts`). PR #41 added skill scoping to the sync path but the async runner spawns pi through its own code path, so background subagents with explicit skills still got the full `<available_skills>` catalog injected.
- `defaultSessionDir` and `sessionDir` with `~` paths (e.g. `"~/.pi/agent/sessions/subagent/"`) were not expanded — `path.resolve("~/...")` treats `~` as a literal directory name. Added tilde expansion matching the existing pattern in `skills.ts`.
- Multiple subagent calls within a session would collide when `defaultSessionDir` was configured, since it wasn't appending a unique `runId`. Both `defaultSessionDir` and parent-session-derived paths now get `runId` appended.

### Removed
- Removed exported `resolveSessionRoot()` function and `SessionRootInput` interface. These were introduced by PR #46 but never called in production — the inline resolution logic diverged (always-on sessions, `runId` appended) making the function's contract misleading. Associated tests and dead code from PR #47 scaffolding also removed from `path-handling.test.ts`.

## [0.11.1] - 2026-03-08

### Changed
- **Session persistence**: Subagent sessions are now stored alongside the parent session file instead of in `/tmp`. If the parent session is `~/.pi/agent/sessions/abc123.jsonl`, subagent sessions go to `~/.pi/agent/sessions/abc123/{runId}/run-{N}/`. This enables tracking subagent performance over time, analyzing token usage patterns, and debugging past delegations. Falls back to a unique temp directory when no parent session exists (API/headless mode).

## [0.11.0] - 2026-02-23

### Added
- **Background mode toggle in clarify TUI**: Press `b` to toggle background/async execution for any mode (single, parallel, chain). Shows `[b]g:ON` in footer when enabled. Previously async execution required programmatic `clarify: false, async: true` — now users can interactively choose background mode after previewing/editing parameters.
- **`--bg` flag for slash commands**: `/run scout "task" --bg`, `/chain scout "task" -> planner --bg`, `/parallel scout "a" -> scout "b" --bg` now run in background without needing the TUI.

### Fixed
- Task edits in clarify TUI were lost when launching in background mode if no other behavior (model, output, reads) was modified. The async handoff now always applies the edited template.

## [0.10.0] - 2026-02-23

### Added
- **Async parallel chain support**: Chains with `{ parallel: [...] }` steps now work in async mode. Previously they were rejected with "Async mode doesn't support chains with parallel steps." The async runner now spawns concurrent pi processes for parallel step groups with configurable `concurrency` and `failFast` options. Inspired by PR #31 from @marcfargas.
- **Comprehensive test suite**: 85 integration tests and 12 E2E tests covering all execution modes (single, parallel, chain, async), error handling, template resolution, and tool validation. Uses `@marcfargas/pi-test-harness` for subprocess mocking and in-process session testing. Thanks @marcfargas for PR #32.
- GitHub Actions CI workflow running tests on both Ubuntu and Windows with Node.js 24.

### Changed
- **BREAKING:** `share` parameter now defaults to `false`. Previously, sessions were silently uploaded to GitHub Gists without user consent. Users who want session sharing must now explicitly pass `share: true`. Added documentation explaining what the feature does and its privacy implications.

### Fixed
- `mapConcurrent` with `limit=0` returned array of undefined values instead of processing items sequentially. Now clamps limit to at least 1.
- ANSI background color bleed in truncated text. The `truncLine` function now properly tracks and re-applies all active ANSI styles (bold, colors, etc.) before the ellipsis, preventing style leakage. Also uses `Intl.Segmenter` for correct Unicode/emoji handling. Thanks @monotykamary for identifying the issue.
- `detectSubagentError` no longer produces false positives when the agent recovers from tool errors. Previously, any error in the last tool result would override exitCode 0→1, even if the agent had already produced complete output. Now only errors AFTER the agent's final text response are flagged. Thanks @marcfargas for the fix and comprehensive test coverage.
- Parallel mode (`tasks: [...]`) now returns aggregated output from all tasks instead of just a success count. Previously only returned "3/3 succeeded" with actual task outputs lost.
- Session sharing fallback no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The fallback now resolves the main entry point and walks up to find the package root instead of trying to resolve `package.json` directly.
- Skills from globally-installed npm packages (via `pi install npm:...`) are now discoverable by subagents. Previously only scanned local `.pi/npm/node_modules/` paths, missing the global npm root where pi actually installs packages.
- **Windows compatibility**: Fixed `ENAMETOOLONG` errors when tasks exceed command-line length limits by writing long tasks to temp files using pi's `@file` syntax. Thanks @marcfargas.
- **Windows compatibility**: Suppressed flashing console windows when spawning async runner processes (`windowsHide: true`).
- **Windows compatibility**: Fixed pi CLI resolution in async runner by passing `piPackageRoot` through to `getPiSpawnCommand`.
- **Cross-platform paths**: Replaced `startsWith("/")` checks with `path.isAbsolute()` for correct Windows absolute path detection. Replaced template string path concatenation with `path.join()` for consistent path separators.
- **Resilience**: Added error handling and auto-restart for the results directory watcher. Previously, if the directory was deleted or became inaccessible, the watcher would die silently.
- **Resilience**: Added `ensureAccessibleDir` helper that verifies directory accessibility after creation and attempts recovery if the directory has broken ACLs (can happen on Windows with Azure AD/Entra ID after wake-from-sleep).

## [0.9.2] - 2026-02-19

### Fixed
- TUI crash on async subagent completion: "Rendered line exceeds terminal width." `render.ts` never truncated output to fit the terminal — widget lines (`agents.join(" -> ")`), chain visualizations, skills lists, and task previews could all exceed the terminal width. Added `truncLine` helper using pi-tui's `truncateToWidth`/`visibleWidth` and applied it to every `Text` widget and widget string. Task preview lengths are now dynamic based on terminal width instead of hardcoded.
- Agent Manager scope badge showed `[built]` instead of `[builtin]` in list and detail views. Widened scope column to fit.

## [0.9.1] - 2026-02-17

### Fixed
- Builtin agents were silently excluded from management listings, chain validation, and agent resolution. Added `allAgents()` helper that includes all three tiers (builtin, user, project) and applied it to `handleList`, `findAgents`, `availableNames`, and `unknownChainAgents`.
- `resolveTarget` now blocks mutation of builtin agents with a clear error message suggesting the user create a same-named override, instead of allowing `fs.unlinkSync` or `fs.writeFileSync` on extension files.
- Agent Manager TUI guards: delete and edit actions on builtin agents are blocked with an error status. Detail screen hides `[e]dit` from the footer for builtins. Scope badge shows `[builtin]` instead of falling through to `[proj]`.
- Cloning a builtin agent set the scope to `"builtin"` at runtime (violating the `"user" | "project"` type), causing wrong badge display and the clone inheriting builtin protections until session reload. Now maps to `"user"`.
- Agent Manager `loadEntries` suppresses builtins overridden by user/project agents, preventing duplicate entries in the TUI list.
- `BUILTIN_AGENTS_DIR` resolved via `import.meta.url` instead of hardcoded `~/.pi/agent/extensions/subagent/agents` path. Works regardless of where the extension is installed.
- `handleCreate` now warns when creating an agent that shadows a builtin (informational, not an error).

### Changed
- Simplified Agent Manager header from per-scope breakdown to total count (per-row badges already show scope).
- Reviewer builtin model changed from `openai/gpt-5.2` to `openai-codex/gpt-5.3-codex`.
- Removed `code-reviewer` builtin agent (redundant with `reviewer`).

## [0.9.0] - 2026-02-17

### Added
- **Builtin agents** — the extension now ships with a default set of agent definitions in `agents/`. These are loaded with lowest priority so user and project agents always override them. New users get a useful set of agents out of the box without manual setup.
  - `scout` — fast codebase recon (claude-haiku-4-5)
  - `planner` — implementation plans from context (claude-opus-4-6, thinking: high)
  - `worker` — general-purpose execution (claude-sonnet-4-6)
  - `reviewer` — validates implementation against plans (gpt-5.3-codex, thinking: high)
  - `context-builder` — analyzes requirements and codebase (claude-sonnet-4-6)
  - `researcher` — autonomous web research with search, evaluation, and synthesis (claude-sonnet-4-6)
- **`"builtin"` agent source** — new third tier in agent discovery. Priority: builtin < user < project. Builtin agents appear in listings with a `[builtin]` badge and cannot be modified or deleted through management actions (create a same-named user agent to override instead).

### Fixed
- Async subagent session sharing no longer fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The runner tried `require.resolve("@bastani/atomic/package.json")` to find pi's HTML export module, but pi's `exports` map doesn't include that subpath. The fix resolves the package root in the main pi process by walking up from `process.argv[1]` and passes it to the spawned runner through the config, bypassing `require.resolve` entirely. The Windows CLI resolution fallback in `getPiSpawnCommand` benefits from the same walk-up function.

## [0.8.5] - 2026-02-16

### Fixed
- Async subagent execution no longer fails with "jiti not found" on machines without a global `jiti` install. The jiti resolution now tries three strategies: vanilla `jiti`, the `@mariozechner/jiti` fork, and finally resolves `@mariozechner/jiti` from pi's own installation via `process.argv[1]`. Since pi always ships the fork as a dependency, async mode now works out of the box.
- Improved the "jiti not found" error message to explain what's needed and how to fix it.

## [0.8.4] - 2026-02-13

### Fixed
- JSONL artifact files no longer written by default — they duplicated pi's own session files and were the sole cause of `subagent-artifacts` directories growing to 10+ GB. Changed `includeJsonl` default from `true` to `false`. `_output.md` and `_meta.json` still capture the useful data.
- Artifact cleanup now covers session-based directories, not just the temp dir. Previously `cleanupOldArtifacts` only ran on `os.tmpdir()/pi-subagent-artifacts` at startup, while sync runs (the common path) wrote to `<session-dir>/subagent-artifacts/` which was never cleaned. Now scans all `~/.pi/agent/sessions/*/subagent-artifacts/` dirs on startup and cleans the current session's artifacts dir on session lifecycle events.
- JSONL writer now enforces a 50 MB size cap (`maxBytes` on `JsonlWriterDeps`) as defense-in-depth for users who opt into JSONL. Silently stops writing at the cap without pausing the source stream, so the progress tracker keeps working.

## [0.8.3] - 2026-02-11

### Added
- Agent `extensions` frontmatter support for extension sandboxing: absent field keeps default extension discovery, empty value disables all extensions, and comma-separated values create an explicit extension allowlist.

### Fixed
- Parallel chain aggregation now surfaces step failures and warnings in `{previous}` instead of silently passing empty output.
- Empty-output warnings are now context-aware: runs that intentionally write to explicit output paths are not flagged as warning-only successes in the renderer.
- Async execution now respects agent `extensions` sandbox settings, matching sync behavior.
- Single-mode `output` now resolves explicit paths correctly: absolute paths are used directly, and relative paths resolve against `cwd`.
- Single-mode output persistence is now caller-side in both sync and async execution, so output files are still written when agents run with read-only tools.
- Pi process spawning now uses a shared cross-platform helper in sync and async paths; on Windows it prefers direct Node + CLI invocation to avoid `ENOENT` and argument fragmentation.
- Sync JSONL artifact capture now streams lines directly to disk with backpressure handling, preventing unbounded memory growth in long or parallel runs.
- Execution now defaults `agentScope` to `both`, aligning run behavior with management `list` so project agents shown in discovery execute without explicit scope overrides.
- Async completion notifications now dedupe at source and notify layers, eliminating duplicate/triple "Background task completed" messages.
- Async notifications now standardize on canonical `subagent:started` and `subagent:complete` events (legacy enhanced event emissions removed).

### Changed
- Reworked `skills.ts` to resolve skills through Pi core skill loading with explicit project-first precedence and support for project/user package and settings skill paths.
- Skill discovery now normalizes and prioritizes collisions by source so project-scoped skills consistently win over user-scoped skills.
- Documentation now references `<tmpdir>` instead of hardcoded `/tmp` paths for cross-platform clarity.

## [0.8.2] - 2026-02-11

### Added
- Recursion depth guard (`PI_SUBAGENT_MAX_DEPTH`) to prevent runaway nested subagent spawning. Default max depth is 2 (main -> subagent -> sub-subagent). Deeper calls are blocked with guidance to the calling agent.

## [0.8.1] - 2026-02-10

### Added
- **`chainDir` param** for persistent chain artifacts — specify a directory to keep artifacts beyond the default 24-hour temp-directory cleanup. Relative paths are resolved to absolute via `path.resolve()` for safe use in `{chain_dir}` template substitutions.

## [0.8.0] - 2026-02-09

### Added
- **Management mode for `subagent` tool** via `action` field — the LLM can now discover, create, modify, and delete agent/chain definitions at runtime without manual file editing or restarts. Five actions:
  - `list` — discover agents and chains with scope + description
  - `get` — full detail for agent or chain, including path and system prompt/steps
  - `create` — create agent (`.md`) or chain (`.chain.md`) definitions from `config`; immediately usable
  - `update` — merge-update agent or chain fields, including rename with chain reference warnings
  - `delete` — remove agent or chain definitions with dangling reference warnings
- **New `agent-management.ts` module** with all management handlers, validation, and serialization helpers
- **New management params** in tool schema: `action`, `chainName`, `config`
- **Agent/chain CRUD safeguards**
  - Name sanitization (lowercase-hyphenated) for create/rename
  - Scope-aware uniqueness checks across agents and chains
  - File-path collision checks to prevent overwriting non-agent markdown files
  - Scope disambiguation for update/delete when names exist in both user and project scope
  - Not-found errors include available names for fast self-correction
  - Per-step validation warnings for model registry and skill availability
  - Validate-then-mutate ordering — all validation completes before any filesystem mutations
- **Config field mapping**: `tools` (comma-separated with `mcp:` prefix support), `reads` -> `defaultReads`, `progress` -> `defaultProgress`
- **Uniform field clearing** — all optional string fields accept both `false` and `""` to clear
- **JSON string parsing for `config` param** — handles `Type.Any()` delivering objects as JSON strings through the tool framework

## [0.7.0] - 2026-02-09

### Added
- **Agents Manager overlay** — browse, view, edit, create, and delete agent definitions from a TUI opened via `Ctrl+Shift+A` or the `/agents` command
  - List screen with search/filter, scope badges (user/project), chain badges
  - Detail screen showing resolved prompt, recent runs, all frontmatter fields
  - Edit screen with field-by-field editing, model picker, skill picker, thinking picker, full-screen prompt editor
  - Create from templates (Blank, Scout, Planner, Implementer, Code Reviewer, Blank Chain)
  - Delete with confirmation
  - Launch directly from overlay with task input and skip-clarify toggle (`Tab`)
- **Chain files** — `.chain.md` files define reusable multi-step chains with YAML-style frontmatter per step, stored alongside agent `.md` files
  - Chain serializer with round-trip parse/serialize fidelity
  - Three-state config semantics: `undefined` (inherit), value (override), `false` (disable)
  - Chain detail screen with flow visualization and dependency map
  - Chain edit screen (raw file editing)
  - Create new chains from the template picker or save from the chain-clarify TUI (`W`)
- **Save overrides from clarify TUI** — press `S` to persist model/output/reads/skills/progress overrides back to the agent's frontmatter file, or `W` (chain mode) to save the full chain configuration as a `.chain.md` file
- **Multi-select and parallel from overlay** — select agents with `Tab`, then `Ctrl+R` for sequential chain or `Ctrl+P` to open the parallel builder
  - Parallel builder: add same agent multiple times, set per-slot task overrides, shared task input
  - Progressive footer: 0 selected (default hints), 1 selected (`[ctrl+r] run [ctrl+p] parallel`), 2+ selected (`[ctrl+r] chain [ctrl+p] parallel`)
  - Selection count indicator in footer
- **Slash commands with per-step tasks** — `/run`, `/chain`, and `/parallel` execute subagents with full live progress rendering and tab-completion. Results are sent to the conversation for the LLM to discuss.
  - Per-step tasks with quotes: `/chain scout "scan code" -> planner "analyze auth"`
  - Per-step tasks for parallel: `/parallel scanner "find bugs" -> reviewer "check style"`
  - `--` delimiter also supported: `/chain scout -- scan code -> planner -- analyze auth`
  - Shared task (no `->`): `/chain scout planner -- shared task`
  - Tab completion for agent names, aware of task sections (quotes and `--`)
  - Inline per-step config: `/chain scout[output=ctx.md] "scan code" -> planner[reads=ctx.md] "analyze auth"`
  - Supported keys: `output`, `reads` (`+` separates files), `model`, `skills`, `progress`
  - Works on all three commands: `/run agent[key=val]`, `/chain`, `/parallel`
- **Run history** — per-agent JSONL recording of task, exit code, duration, timestamp
  - Recent runs shown on agent detail screen (last 5)
  - Lazy JSONL rotation (keeps last 1000 entries)
- **Thinking level as first-class agent field** — `thinking` frontmatter field (off, minimal, low, medium, high, xhigh) editable in the Agents Manager
  - Picker with arrow key navigation and level descriptions
  - At runtime, appended as `:level` suffix to the model string
  - Existing suffix detection prevents double-application
  - Displayed on agent detail screen

### Fixed
- **Parallel live progress** — top-level parallel execution (`tasks: [...]`) now shows live progress for all concurrent tasks. Each task's `onUpdate` updates its slot in a shared array and emits a merged view, so the renderer can display per-task status, current tools, recent output, and timing in real time. Previously only showed results after all tasks completed.
- **Slash commands frozen with no progress** — `/run`, `/chain`, and `/parallel` called `runSync`/`executeChain` directly, bypassing the tool framework. No `onUpdate` meant zero live progress, and `await`-ing execution blocked the command handler, making inputs unresponsive. Now all three route through `sendToolCall` → LLM → tool handler, getting full live progress rendering and responsive input for free.
- **`/run` model override silently dropped** — `/run scout[model=gpt-4o] task` now correctly passes the model through to the tool handler. Added `model` field to the tool schema for single-agent runs.
- **Quoted tasks with `--` inside split incorrectly** — the segment parser now checks for quoted strings before the `--` delimiter, so tasks like `scout "analyze login -- flow"` parse correctly instead of splitting on the embedded ` -- `.
- **Chain first-step validation in per-step mode** — `/chain scout -> planner "task"` now correctly errors instead of silently assigning planner's task to scout. The first step must have its own task when using `->` syntax.
- **Thinking level ignored in async mode** — `async-execution.ts` now applies thinking suffix to the model string before serializing to the runner, matching sync behavior
- **Step-level model override ignored in async mode** — `executeAsyncChain` now uses `step.model ?? agent.model` as the base for thinking suffix, matching the sync path in `chain-execution.ts`
- **mcpDirectTools not set in async mode** — `subagent-runner.ts` now sets `MCP_DIRECT_TOOLS` env var per step, matching the sync path in `execution.ts`
- **`{task}` double-corruption in saved chain launches** — stopped pre-replacing `{task}` in the overlay launch path; raw user task passed as top-level param to `executeChain()`, which uses `params.task` for `originalTask`
- **Agent serializer `skill` normalization** — `normalizedField` now maps `"skill"` to `"skills"` on the write path
- **Clarify toggle determinism** — all four ManagerResult paths (single, chain, saved chain, parallel) now use deterministic JSON with `clarify: !result.skipClarify`, eliminating silent breakage from natural language variants

### Changed
- Agents Manager single-agent and saved-chain launches default to quick run (skip clarify TUI) — the user already reviewed config in the overlay. Multi-agent ad-hoc chains default to showing the clarify TUI so users can configure per-step tasks, models, output files, and skills before execution. Toggle with `Tab` in the task-input screen.
- Extracted `applyThinkingSuffix(model, thinking)` helper from inline logic in `execution.ts`, shared with `async-execution.ts`
- Text editor: added word navigation (Alt+Left/Right, Ctrl+Left/Right), word delete (Alt+Backspace), paste support
- Agent discovery (`agents.ts`): loads `.chain.md` files via `loadChainsFromDir`, exposes `discoverAgentsAll` for overlay

## [0.6.0] - 2026-02-02

### Added
- **MCP direct tools for subagents** - Agents can request specific MCP tools as first-class tools via `mcp:` prefix in frontmatter: `tools: read, bash, mcp:chrome-devtools` or `tools: read, bash, mcp:github/search_repositories`. Requires pi-mcp-adapter.
- **`MCP_DIRECT_TOOLS` env var** - Subagent processes receive their direct tool config via environment variable. Agents without `mcp:` items get a `__none__` sentinel to prevent config leaking from the parent process.

## [0.5.3] - 2026-02-01

### Fixed
- Adapt execute signatures to pi v0.51.0: reorder signal, onUpdate, ctx parameters for subagent tool; add missing parameters to subagent_status tool

## [0.5.2] - 2026-01-28

### Improved
- **README: Added agent file locations** - New "Agents" section near top of README clearly documents:
  - User agents: `~/.pi/agent/agents/{name}.md`
  - Project agents: `.pi/agents/{name}.md` (searches up directory tree)
  - `agentScope` parameter explanation (`"user"`, `"project"`, `"both"`)
  - Complete frontmatter example with all fields
  - Note about system prompt being the markdown body after frontmatter

## [0.5.1] - 2026-01-27

### Fixed
- Google API compatibility: Use `Type.Any()` for mixed-type unions (`SkillOverride`, `output`, `reads`, `ChainItem`) to avoid unsupported `anyOf`/`const` JSON Schema patterns

## [0.5.0] - 2026-01-27

### Added
- **Skill support** - Agents can declare skills in frontmatter that get injected into system prompts
  - Agent frontmatter: `skill: tmux, chrome-devtools` (comma-separated)
  - Runtime override: `skill: "name"` or `skill: false` to disable all skills
  - Chain-level skills additive to agent skills, step-level override supported
  - Skills injected as XML: `<skill name="...">content</skill>` after agent system prompt
  - Missing skills warn but continue execution (warning shown in result summary)
- **TUI skill selector** - Press `[s]` to browse and select skills for any step
  - Multi-select with space bar
  - Fuzzy search by name or description
  - Shows skill source (project/user) and description
  - Project skills (`.pi/skills/`) override user skills (`~/.pi/agent/skills/`)
- **Skill display** - Skills shown in TUI, progress tracking, summary, artifacts, and async status
- **Parallel task skills** - Each parallel task can specify its own skills via `skill` parameter

### Fixed
- **Chain summary formatting** - Fixed extra blank line when no skills are present
- **Duplicate skill deduplication** - `skill: "foo,foo"` now correctly deduplicates to `["foo"]`
- **Consistent skill tracking in async mode** - Both chain and single modes now track only resolved skills

## [0.4.1] - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## [0.4.0] - 2026-01-25

### Added
- **Clarify TUI for single and parallel modes** - Use `clarify: true` to preview/edit before execution
  - Single mode: Edit task, model, thinking level, output file
  - Parallel mode: Edit each task independently, model, thinking level
  - Navigate between parallel tasks with ↑↓
- **Mode-aware TUI headers** - Header shows "Agent: X" for single, "Parallel Tasks (N)" for parallel, "Chain: X → Y" for chains
- **Model override for single/parallel** - TUI model selection now works for all modes

### Fixed
- **MAX_PARALLEL error mode** - Now correctly returns `mode: 'parallel'` (was incorrectly `mode: 'single'`)
- **`output: true` handling** - Now correctly treats `true` as "use agent's default output" instead of creating a file literally named "true"

### Changed
- **Schema description** - `clarify` parameter now documents all modes: "default: true for chains, false for single/parallel"

## [0.3.3] - 2026-01-25

### Added
- **Thinking level selector in chain TUI** - Press `[t]` to set thinking level for any step
  - Options: off, minimal, low, medium, high, xhigh (ultrathink)
  - Appends to model as suffix (e.g., `anthropic/claude-sonnet-4-5:high`)
  - Pre-selects current thinking level if already set
- **Model selector in chain TUI** - Press `[m]` to select a different model for any step
  - Fuzzy search through all available models
  - Shows the current model with a `current` badge
  - Provider/model format (e.g., `anthropic/claude-haiku-4-5`)
  - Override indicator (✎) when model differs from agent default
- **Model visibility in chain execution** - Shows which model each step is using
  - Display format: `Step 1: scout (claude-haiku-4-5) | 3 tools, 16.8s`
  - Model shown in both running and completed steps
- **Auto-propagate output changes to reads** - When you change a step's output filename,
  downstream steps that read from it are automatically updated to use the new filename
  - Maintains chain dependencies without manual updates
  - Example: Change scout's output from `context.md` to `summary.md`, planner's reads updates automatically

### Changed
- **Progress is now chain-level** - `[p]` toggles progress for ALL steps at once
  - Progress setting shown at chain level (not per-step)
  - Chains share a single progress.md, so chain-wide toggle is more intuitive
- **Clearer output/writes labeling** - Renamed `output:` to `writes:` to clarify it's a file
  - Hotkey changed from `[o]` to `[w]` for consistency
- **{previous} data flow indicator** - Shows on the PRODUCING step (not receiving):
  - `↳ response → {previous}` appears after scout's reads line
  - Only shows when next step's template uses `{previous}`
  - Clearer mental model: output flows DOWN the chain
- Chain TUI footer updated: `[e]dit [m]odel [t]hinking [w]rites [r]eads [p]rogress`

### Fixed
- **Chain READ/WRITE instructions now prepended** - Instructions restructured:
  - `[Read from: /path/file.md]` and `[Write to: /path/file.md]` prepended BEFORE task
  - Overrides any hardcoded filenames in task text from parent agent
  - Previously: instructions were appended at end and could be overlooked
- **Output file validation** - After each step, validates expected file was created:
  - If missing, warns: "Agent wrote to different file(s): X instead of Y"
  - Helps diagnose when agents don't create expected outputs
- **Root cause: agents need `write` tool** - Agents without `write` in their tools list
  cannot create output files (they tried MCP workarounds which failed)
- **Thinking level suffixes now preserved** - Models with thinking levels (e.g., `claude-sonnet-4-5:high`)
  now correctly resolve to `anthropic/claude-sonnet-4-5:high` instead of losing the provider prefix

### Improved
- **Per-step progress indicators** - When progress is enabled, each step shows its role:
  - Step 1: `writes progress.md`
  - Step 2+: `reads progress.md`
  - Clear visualization of progress.md data flow through the chain
- **Comprehensive tool descriptions** - Better documentation of chain variables:
  - Tool description now explains `{task}`, `{previous}`, `{chain_dir}` in detail
  - Schema descriptions clarify what each variable means and when to use them
  - Helps agents construct proper chain queries for any use case

## [0.3.2] - 2026-01-25

### Performance
- **4x faster polling** - Reduced poll interval from 1000ms to 250ms (efficient with mtime caching)
- **Mtime-based caching** - status.json and output tail reads cached to avoid redundant I/O
- **Unified throttled updates** - All onUpdate calls consolidated under 50ms throttle
- **Widget change detection** - Hash-based change detection skips no-op re-renders
- **Array optimizations** - Use concat instead of spread for chain progress updates

### Fixed
- **Timer leaks** - Track and clear pendingTimer and cleanupTimers properly
- **Updates after close** - processClosed flag prevents updates after process terminates  
- **Session cleanup** - Clear cleanup timers on session_start/switch/branch/shutdown

## [0.3.1] - 2026-01-24

### Changed
- **Major code refactor** - Split monolithic index.ts into focused modules:
  - `execution.ts` - Core runSync function for single agent execution
  - `chain-execution.ts` - Chain orchestration (sequential + parallel steps)
  - `async-execution.ts` - Async/background execution support
  - `render.ts` - TUI rendering (widget, tool result display)
  - `schemas.ts` - TypeBox parameter schemas
  - `formatters.ts` - Output formatting utilities
  - `utils.ts` - Shared utility functions
  - `types.ts` - Shared type definitions and constants

### Fixed
- **Expanded view visibility** - Running chains now properly show:
  - Task preview (truncated to 80 chars) for each step
  - Recent tools fallback when between tool calls
  - Increased recent output from 2 to 3 lines
- **Progress matching** - Added agent name fallback when index doesn't match
- **Type safety** - Added defensive `?? []` for `recentOutput` access on union types

## [0.3.0] - 2026-01-24

### Added
- **Full edit mode for chain TUI** - Press `e`, `o`, or `r` to enter a full-screen editor with:
  - Word wrapping for long text that spans multiple display lines
  - Scrolling viewport (12 lines visible) with scroll indicators (↑↓)
  - Full cursor navigation: Up/Down move by display line, Page Up/Down by viewport
  - Home/End go to start/end of current display line, Ctrl+Home/End for start/end of text
  - Auto-scroll to keep cursor visible
  - Esc saves, Ctrl+C discards changes

### Improved
- **Tool description now explicitly shows the three modes** (SINGLE, CHAIN, PARALLEL) with syntax - helps agents pick the right mode when user says "scout → planner"
- **Chain execution observability** - Now shows:
  - Chain visualization with status labels: `done scout → running planner` (`done`, `running`, `pending`, `failed`) - sequential chains only
  - Accurate step counter: "step 1/2" instead of misleading "1/1"
  - Current tool and recent output for running step

## [0.2.0] - 2026-01-24

### Changed
- **Rebranded to `pi-subagents`** (was `pi-async-subagents`)
- Now installable via `npx pi-subagents`

### Added
- Chain TUI now supports editing output paths, reads lists, and toggling progress per step
- New keybindings: `o` (output), `r` (reads), `p` (progress toggle)
- Output and reads support full file paths, not just relative to chain_dir
- Each step shows all editable fields: task, output, reads, progress

### Fixed
- Chain clarification TUI edit mode now properly re-renders after state changes (was unresponsive)
- Changed edit shortcut from Tab to 'e' (Tab can be problematic in terminals)
- Edit mode cursor now starts at beginning of first line for better UX
- Footer shows context-sensitive keybinding hints for navigation vs edit mode
- Edit mode is now single-line only (Enter disabled) - UI only displays first line, so multi-line was confusing
- Added Ctrl+C in edit mode to discard changes (Esc saves, Ctrl+C discards)
- Footer now shows "Done" instead of "Save" for clarity
- Absolute paths for output/reads now work correctly (were incorrectly prepended with chainDir)

### Added
- Parallel-in-chain execution with `{ parallel: [...] }` step syntax for fan-out/fan-in patterns
- Configurable concurrency and fail-fast options for parallel steps
- Output aggregation with clear separators (`=== Parallel Task N (agent) ===`) for `{previous}`
- Namespaced artifact directories for parallel tasks (`parallel-{step}/{index}-{agent}/`)
- Pre-created progress.md for parallel steps to avoid race conditions

### Changed
- TUI clarification skipped for chains with parallel steps (runs directly in sync mode)
- Async mode rejects chains with parallel steps with clear error message
- Chain completion now returns summary blurb with progress.md and artifacts paths instead of raw output

### Added
- Live progress display for sync subagents (single and chain modes)
- Shows current tool, recent output lines, token count, and duration during execution
- Ctrl+O hint during sync execution to expand full streaming view
- Throttled updates (150ms) for smoother progress display
- Updates on tool_execution_start/end events for more responsive feedback

### Fixed
- Async widget elapsed time now freezes when job completes instead of continuing to count up
- Progress data now correctly linked to results during execution (was showing "ok" instead of "...")

### Added
- Extension API support (registerTool) with `subagent` tool name
- Session logs (JSONL + HTML export) and optional share links via GitHub Gist
- `share` and `sessionDir` parameters for session retention control
- Async events: `subagent:started`/`subagent:complete` (legacy events still emitted)
- Share info surfaced in TUI and async notifications
- Async observability folder with `status.json`, `events.jsonl`, and `subagent-log-*.md`
- `subagent_status` tool for inspecting async run state
- Async TUI widget for background runs

### Changed
- Parallel mode auto-downgrades to sync when async:true is passed (with note in output)
- TUI now shows "parallel (no live progress)" label to set expectations
- Tools passed via agent config can include extension paths (forwarded via `--extension`)

### Fixed
- Chain mode now sums step durations instead of taking max (was showing incorrect total time)
- Async notifications no longer leak across pi sessions in different directories

## [0.1.0] - 2026-01-03

Initial release forked from async-subagent example.

### Added
- Output truncation with configurable byte/line limits
- Real-time progress tracking (tools, tokens, duration)
- Debug artifacts (input, output, JSONL, metadata)
- Session-tied artifact storage for sync mode
- Per-step duration tracking for chains
