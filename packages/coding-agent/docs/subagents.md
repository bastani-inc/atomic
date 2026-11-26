---
title: "Run subagents"
sidebarTitle: "Subagents guide"
description: "Launch bundled or custom subagents in the background, isolate edits in Git worktrees, and control running tasks."
---

Subagents let your main chat delegate bounded work to specialist agents running in separate sessions. No separate package installation is required.

When to delegate:

- Delegate independent research, analysis, debugging, or parallel implementation work that can overlap with other steps.
- Keep interactive, exploratory, or immediately blocking tasks in your main chat unless specialist focus or context isolation adds value.
- Every subagent runs in the background. Let completion notices report back instead of polling, and call `subagent({ action: "wait", id })` only when the next step depends on a subagent's result.

New to subagents? Start with [Subagents overview](/guides/subagents). See [Manage background tasks](/background-tasks) for the agent panel, `/tasks`, shell output, cancellation, and completion notices. For defining custom agents, see [Create custom subagents](/subagents/authoring). For discovery precedence, fallback chains, and configuration keys, see [Subagent reference](/subagents/reference). For embedding subagents in an app, see [Subagent children in the SDK](/sdk#subagent-children).

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

Atomic chooses the specialist and execution shape (single subagent, parallel batch, or forked context). For multi-step coordination, your main session can also launch subagents from [codemode scripts](#from-codemode-scripts).

## Bundled agents

| Agent | Purpose | Default context | Edits files? |
| --- | --- | --- | --- |
| `codebase-locator` | Find relevant files, directories, tests, configs, and docs. | `fresh` | No |
| `codebase-analyzer` | Explain code behavior and trace data flow with `file:line` references. | `fresh` | No |
| `codebase-pattern-finder` | Find similar implementations, conventions, and test patterns. | `fresh` | No |
| `codebase-research-locator` | Find related `research/` and `specs/` documents. | `fresh` | No |
| `codebase-research-analyzer` | Extract decisions and active constraints from local docs. | `fresh` | No |
| `codebase-online-researcher` | Research official docs, libraries, and open-source code online. | `fresh` | Research notes only (no `edit`/`write` tools) |
| `debugger` | Reproduce a failure, prove root cause, apply the minimal fix, and validate it. | `fresh` | Yes |
| `code-simplifier` | Simplify recent changes while preserving behavior. | `fresh` | Yes |
| `worker` | Implement an approved task, validate the change, and escalate scope decisions. | `fork` | Yes |

All bundled agents use `model: "auto"` with no pinned fallback chain. Pin a role via `subagents.agentOverrides.<name>.model` in `settings.json` or a per-call `model` argument. A concrete `model` runs only that model plus the agent's own `fallbackModels` (see [Fallback models](/subagents/reference#fallback-models)).

The `worker` agent also enables `defaultProgress: true` (isolated run-scoped `progress.md`), sets `inheritProjectContext: true`, sets `inheritSkills: false`, and loads the `tdd`, `agent-browser`, and `tmux` skills.

### Browse agents with `/agents`

Run `/agents` (or `/agents <query>`) in an interactive session to inspect available agents, grouped in precedence order: **Project**, **User**, **Built-in**, and **Package**. Outside interactive mode, run `subagent({ action: "list" })`.

- Type to filter by name, description, or source. Select an agent and press `Enter` to view its model, fallbacks, default context, tools, file path, and system prompt.
- Press `Esc` to return to the list, then back to chat.

`/agents` is read-only and never launches or edits agents. It applies the same discovery rules as execution, so shadowed or disabled definitions are hidden. Leaving `/agents` open never marks [Herdr](/herdr) as blocked.

### Review compositions

Compose specialists from distinct angles and synthesize their findings in your main session:

| Angle | Specialist |
| --- | --- |
| Current behavior and regressions | `codebase-analyzer` with `file:line` citations |
| Failure modes | `debugger` in inspect-only mode (no edits) |
| Project conventions | `codebase-pattern-finder` |
| Prior decisions | `codebase-research-locator` followed by `codebase-research-analyzer` |
| External API conformance | `codebase-online-researcher` |

```text
Review the current diff with fresh-context specialists: analyze correctness, inspect failure modes without editing, and compare the implementation to existing patterns. Synthesize only issues worth fixing now.
```

## Context and Git worktrees

### Fresh vs. forked context

- **`context: "fresh"`** starts an isolated child session containing only the agent's prompt and task. Use `fresh` for adversarial reviews and independent research.
- **`context: "fork"`** branches from your main session's latest settled turn and fails fast if the main session cannot be forked (it never downgrades silently to `fresh`). A forked subagent inherits the main session's model, thinking level, active tool changes, and saved tool outputs without taking ownership of the main session's other subagents or replaying Intercom cards.

<Warning>
When you omit `context` on a parallel `tasks` batch, adding **any** agent with `defaultContext: fork` (such as `worker`) causes the **entire batch** to run in forked context. Pass `context: "fresh"` explicitly if you want fresh-context siblings alongside `worker`, or launch `worker` in a separate call.
</Warning>

Use `fork` when a subagent needs the main conversation's decisions and context. A forked subagent sends the exact conversation prefix the main session last sent (system prompt, project context, skills, tools, and messages), followed by its own role, a short handoff note, and its task. When it runs on the main session's same model and thinking level, the first request reads from the main session's prompt cache and pays only for the new suffix. On another model or provider it does not share that cache, and on another thinking level it may share only part of it.

In a fork, `inheritProjectContext` and `inheritSkills` do not hide what the main session already sent; those frontmatter flags apply to fresh subagents. The subagent's own tool allowlist still applies: calling a tool outside its allowed list fails with an error naming the allowed tools. Where the provider supports mid-conversation tool changes, removed or child-only tools are declared after the main conversation; otherwise child-only tools run through `codemode` restricted strictly to the subagent's own tools.

Fresh subagents inherit the main session's model registry, authentication, and workspace discovery settings. A subagent's tool list can narrow permissions, but it cannot re-enable tools or packages excluded by the main session. See [Subagent children in the SDK](/sdk#subagent-children) for programmatic child configuration.

### Temporary worktrees

Pass `worktree: true` on a parallel `tasks` call to isolate each subagent's edits in its own temporary Git worktree:

```typescript
subagent({
  worktree: true,
  tasks: [
    { agent: "worker", task: "Implement the parser changes." },
    { agent: "worker", task: "Implement the CLI flag changes." },
  ],
})
```

Key rules for `worktree: true`:

- **Parallel mode only.** `worktree: true` creates temporary isolated worktrees only for parallel `tasks: [...]` runs (or multiple single-agent calls combined in one assistant message). On a standalone single-agent `{ agent, task }` call, `worktree: true` has no effect and the subagent runs in the main checkout; use `worktree: { branch }` for an isolated single-agent worktree.
- **Clean tracked working tree required.** Launch fails before starting any subagent if tracked files have staged or unstaged edits (`git status --porcelain --untracked-files=no`). Untracked files do not block launch.
- **Base branch.** Temporary worktrees branch from `origin/<default-branch>` (fetching if needed) and fall back to `HEAD` only if no origin default branch is found, rather than branching from your current local `HEAD`.
- **Automatic post-creation setup.** After creating each temporary worktree, Atomic automatically copies `.atomic/settings.local.json` and any untracked `.atomic/settings.json`, configures Git `core.hooksPath` to share `.husky` or `.git/hooks`, symlinks (or creates a junction on Windows for) `node_modules`, copies gitignored files listed in `.worktreeinclude`, and runs `worktreeSetupHook` if configured in [config.json](/subagents/reference#subagent-config-json-reference).
- **No per-task `cwd` overrides.** All tasks in a `worktree: true` batch must share the same `cwd`; per-task `cwd` overrides that differ from the shared `cwd` are rejected.
- **Patch capture and cleanup.** Once every subagent in the batch finishes, Atomic saves each subagent's changes as a patch under `worktree-diffs/<run-id>` and removes the temporary worktrees and branches. If capturing a worktree's patch fails, Atomic keeps that worktree on disk and reports it in the diff summary so changes are not lost.
- **Paused, quit, and cancelled subagents.** Paused, quit, or session-closed subagents keep their temporary worktree only if it has uncommitted changes, untracked files, or new commits. Clean worktrees are removed; `resume` recreates them from base plus the saved patch and writes later patches as `task-<n>-<agent>.<execution>.patch`. Permanently cancelled subagents release their worktrees, and unresumed stopped worktrees with changes remain under `.atomic/worktrees/`.
- **Waiting on cleanup.** `pause`, `quit`, completion, and failed resume wait for Git cleanup. Pressing `Esc` stops waiting without cancelling cleanup; cleanup taking over 10 seconds warns and continues in the background. Never delete a worktree directory while `worktreeNote` reports pending cleanup or a sibling hold, or after a crash without checking for orphaned Git processes.
- **Git hook integration.** Git filters and hooks can check `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` during teardown. Extension authors can also subscribe to `subagent:finishing`; see [Subagent reference](/subagents/reference#sdk-integration-and-errors).

### Named worktrees

Run a single subagent or specific parallel tasks on an explicit branch and directory with `worktree: { branch, base?, path? }`. Named worktrees cannot be combined with `worktree: true`. A top-level named `worktree` object applies to every task in `tasks` that does not set its own `worktree`.

```typescript
subagent({ agent: "worker", task: "Fix the parser", worktree: { branch: "fix/parser" } })
subagent({
  tasks: [
    { agent: "worker", task: "Add the API", worktree: { branch: "feat/api", base: "origin/main" } },
    { agent: "worker", task: "Add the UI", worktree: { branch: "feat/ui", path: "../ui-worktree" } },
  ],
})
```

How named worktrees differ from temporary worktrees:

- **No clean-tree requirement and no automatic post-setup.** Named worktrees work with dirty local checkouts and do not symlink `node_modules`, copy settings or `.worktreeinclude` files, set `core.hooksPath`, run `worktreeSetupHook`, or save diff patches.
- **Permanent ownership.** Atomic never deletes a named worktree or its branch. Resuming reuses the worktree or checks the branch back out there if removed.
- **Branch and path rules.** `path` defaults to `.atomic/worktrees/<branch>` (`/` replaced with `+`); relative paths resolve against the caller's `cwd`, and an existing empty directory at `path` is allowed. New branches use `--no-track` and start from `base` (resolved in the caller's worktree), then the current branch's upstream (`@{upstream}`), then `HEAD`. Branch names are validated with `git check-ref-format --branch` and cannot contain `@{`. Unused existing branches check out as-is, and a branch already checked out at `path` is reused. Launch fails fast if the branch is checked out elsewhere or `path` holds something else.
- **Subdirectory `cwd`.** If your session runs inside a repository subdirectory, the subagent starts in that same subdirectory inside the worktree (falling back to the worktree root if that subdirectory does not exist on the branch).
- **Concurrency, locks, and recovery.** Different branches and paths run concurrently. Duplicate `(branch, path)` launches wait and reuse; the same branch at a different path fails after the first finishes. Prefer `worktree: { ... }` over running `git worktree add` in the same turn, which can race with sibling tool calls. External `index.lock` files or initializing worktrees time out after 30 seconds (`another git process seems to be running at <path>`). Interrupted previous checkouts fail immediately (`an interrupted named-worktree checkout left an incomplete worktree at <path>`); on Git 2.30 to 2.32, they report busy after 30 seconds. To recover an incomplete checkout, confirm no Git process is running, save needed files, run `git worktree unlock <path>`, remove the directory, run `git worktree prune`, and clear stale `HEAD.lock` or branch `.lock` files (or run `git worktree remove --force --force <path>`). Never fix a partial checkout by deleting only `index.lock`.

## Background launches and waiting

Every `subagent` launch runs in the background without interactive preview prompts and returns immediately with each subagent's `taskId` and `intercomTarget` (for example `subagent-worker-1a2b3c4d-1`). Use `intercomTarget` verbatim when messaging a subagent. Legacy calls that pass `wait` still run in the background, and `wait: { kind: "foreground" }` adds a note pointing to `action: "wait"`.

Subagents return their results directly. Atomic does not infer acceptance gates or parse `acceptance-report` blocks, so write required tests, commands, or evidence checks directly in the task prompt.

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references." })
subagent({ action: "wait", id: "<taskId>", budgetMs: 120000 })
subagent({ action: "status", id: "<taskId>" })
```

- **Waiting.** `subagent({ action: "wait", id: taskId, budgetMs? })` observes an existing task launched by this session up to `budgetMs` (default `tasks.wait.agentBudgetMs`, `30000` ms). Ending a wait on budget or pressing `Esc` leaves the subagent running. Wait for completion before depending on its result. See [Choose how long to wait](/background-tasks#choose-how-long-to-wait).
- **Repeating tasks with `count`.** In parallel `tasks`, set `count` (integer `>= 1`) on a task item to repeat it N times with the same settings. Expanded items count toward `parallel.maxTasks`.
- **Concurrency.** Multiple single-agent launches in one turn share `concurrency` (or the configured parallel limit). Returning from launch or ending a wait does not free a running slot.
- **Heartbeats.** Running subagents send [task heartbeats](/background-tasks#task-heartbeats) every 15 minutes by default, reporting current tool, idle time, turns, tool calls, and tokens. Override with `heartbeatMs` on the call or task entry (`0` disables).
- **Files, progress, and output.** Pass `reads` (single-agent or per-task) to prepend file contents resolved relative to the child's `cwd`. Pass `output` (path or `false`) and `outputMode` (`"inline"` default, or `"file-only"`, which requires an `output` path; duplicate `output` paths in a parallel batch are rejected). Pass `progress: true` to enable an isolated run-scoped `progress.md` under artifact storage (never inside child `cwd` or the repository; omitted inherits the agent's `defaultProgress`, suppressed for read-only tasks unless `progress: true`). Separate `includeProgress: true` adds runtime progress telemetry to the tool result.
- **Settled output.** `wait` and `status` return up to 16 KB inline, plus `Full output: <path>` (Atomic keeps the 256 most recent copies in a private temp directory and cleans them on exit) and `Requested output:` when `output` was set. With `outputMode: "file-only"`, only the saved-file reference returns inline.
- **Yielding to user or Intercom.** User steering (`input-needed`) or an inbound Intercom message (`intercom-coordination`) yields active `wait` calls so the main session can respond without cancelling running or queued subagents. Wait again afterward if you still need the result.
- **Startup progress and retries.** Before a subagent's first turn, `status` reports its exact startup step (`opening its session`, `loading its resources`, `waiting for a resource-admission permit` while waiting for a session slot, `creating its agent session`, `registering on Intercom`, or `dispatching its task`) with elapsed time. If startup exceeds `sessionStartTimeoutMs` (default 5 minutes), Atomic marks the attempt stalled and retries once after releasing its session. If a stalled attempt still holds its session after half the budget (capped at 30 seconds), it fails without retrying. Two stalled attempts fail with `Subagent did not start: its start stalled <step> after <N>s and was retried once; the retry stalled <step> after <M>s`.
- **Session close and reopen.** Closing a session stops running subagents. Reopening it automatically restores running subagents from their saved sessions.

### Task inspection

Use `/tasks` (or `/tasks <id>`) or the agent panel below the prompt (`↓` on an empty prompt) to inspect running, waiting, and finished subagents and their nested shells.

- **Switch to a subagent.** Select a subagent row and press `Enter` (or click it) to view its live transcript and message it on the same chat screen. Press `←` on an empty prompt or select `main` in the panel to return without interrupting the subagent.
- **Pause or stop.** While viewing a working subagent, press `Esc` (or `Ctrl+C` on an empty prompt) to pause its active turn without affecting main chat. In `/tasks` or the agent panel, press `x` twice within 3 seconds to stop a running task resumably (red `◯` stopped mark), or `x` once to dismiss a finished row.
- **Subagent shells and hints.** A subagent's running shells nest underneath it in the agent panel. On a subagent's page in `/tasks`, backgrounded shell blocks show a clickable `· /tasks to manage` hint that opens that subagent's own task list. While viewing a released subagent waiting on a shell, the newest waited shell shows a clickable `· alt+w opens it` hint.
- **Questions in subagents.** A subagent's `ask_user_question` or extension dialog waits inside that subagent's transcript (**Needs input**) without blocking the main chat. SDK hosts without a task inspector route `humanInput` by `sessionId` ([Human input without a terminal](/sdk#human-input-without-a-terminal)).
- **Launch cards and status history.** Each subagent renders `Agent(<agent> · <short task title>)` with state, active elapsed time, and tokens (`Ctrl+O` expands prompt, tool calls, and result). Live progress, `/tasks`, and `status` show the resolved model and clamped reasoning effort. Atomic keeps live status for the 256 most recently finished runs plus all active runs; older subagents remain resumable via `subagent({ action: "resume", id })`.

See [Manage background tasks](/background-tasks), [Viewing a subagent](/background-tasks#viewing-a-subagent), and [Shells started by subagents](/background-tasks#shells-started-by-subagents) for the full panel layout, key bindings, command-routing table, and `/tasks` controls.

### Run control

Control subagents with `pause`, `quit`, and `resume`. The `id` parameter accepts a child ID (`<runId>:<index>`), task ID, Intercom name, or single-child run ID:

```ts
subagent({ action: "pause", id: "<child-id>" })   // Stop now; hold queued messages for resume
subagent({ action: "pause", all: true })          // Pause all running subagents of this session
subagent({ action: "quit", id: "<child-id>" })    // Graceful stop; stays resumable
subagent({ action: "quit", all: true })           // Covers running and already-paused subagents
subagent({ action: "resume", id: "<child-id>", message: "Focus on the failing test first." })
```

- **`pause`.** Stops the active turn and keeps queued steering or follow-up messages to deliver once in order before `resume`'s `message`. Intercom messages to a paused subagent do not resume it; they wait with no time limit and reach it after `resume`'s `message`.
- **`quit`.** Stops the subagent gracefully, including paused subagents, while keeping it resumable.
- **Awaiting resume.** Paused and quit subagents report `paused · awaiting resume` or `quit · awaiting resume` with `Stop reason: pause` or `quit` and the exact `subagent({ action: "resume", id: "<child-id>" })` call. `status` lists them under **Awaiting resume** across restarts without auto-relaunching. Completed and failed notices state that execution ended and also provide the `resume` call and Intercom name.
- **Queued parallel subagents.** You can `pause` or `quit` a subagent still waiting for a concurrency slot. `resume` starts it with its original task, optional `message`, model, thinking level, worktree, and fork copy, and re-enters the concurrency queue. If its original model or fork copy no longer exists, `resume` reports it as gone instead of substituting silently.
- **`resume`.** Continues the subagent's saved session under the same child ID, Intercom name, and group with fresh supervisor authorization (`all: true` is not supported). For paused, quit, or interrupted subagents, `message` runs before continuing. For completed or failed subagents, `message` starts a fresh turn. Omitting `message` prompts the subagent to continue or stop if done.
- **Resumable vs. terminal.** Paused, quit, interrupted, completed, failed, and session-closed subagents are resumable. **Killed** (explicit cancellation) and **Gone** (unrestorable after restart) subagents are terminal and reject `resume`. Running subagents also reject `resume` (`<agent> (<child-id>, <intercom-name>) is already running as task <task-id>; pause or quit it first.`); use Intercom to message a running subagent. Failed resumes preserve `worktree: true` checkouts.
- **Interrupting control calls.** Pressing `Esc` stops waiting on `pause`, `quit`, or `resume`. Stops already requested still complete, while unstarted resumes cancel cleanly.
- **Removed actions.** `kill` and `interrupt` were removed. Calls fail and direct you to `{ action: "quit", id }`:

```text
The subagent action "kill" was removed. Use { action: "quit", id } to stop a child gracefully; it stays resumable with { action: "resume", id, message? }.
```

#### Messages that resume a finished subagent

Any session allowed to message a subagent under ordinary Intercom group and reach rules can wake it. A single-target `intercom` `send` or `ask` to a completed or failed subagent returns immediately with `queued: true`, and the launching session resumes the subagent to handle the message (an `ask` receives its reply later as a message). Calling `subagent({ action: "resume", id: "<intercom-name>", message })` for a subagent launched by another session sends `message` through that same wake queue.

Messages to a paused or quit subagent wait in a durable queue without resuming it until the launching session continues it. The launching session always keeps ownership of the resumed subagent, its `/tasks` row, and its controls. Message-triggered resumes are bounded to 6 resumes in 10 minutes and chain depth 4. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent) and [Subagents with no live session](/intercom/reference#subagents-with-no-live-session) for full queue limits and refusal rules.

### Released subagents

A background subagent that waits more than 1 minute on a `detachable: true` tool call, a budgetless shell `wait`, an `intercom` `ask`, or a blocking `contact_supervisor` (`need_decision` or `interview_request`) is **released**. The waited operation keeps running while the subagent releases its session resources and wakes automatically when the result arrives.

- **What you see.** Your main chat shows a dim notice that does not trigger a model turn (`◌ <name> is waiting on <tool> (<call id>)`). `/tasks`, the agent panel, and the launch card list it under **Waiting** with `◌` and `waiting on <tool>`. `subagent({ action: "status" })` reports `released · waiting on <tool> (<call id>)`.
- **Late results and continuation notes.** If something else wakes the subagent first, the waited call returns as still running; when its result (or a subagent background shell) arrives later, a notice card delivers it once inside the subagent's chat. Whenever Atomic continues a subagent automatically, the subagent receives a short continuation note (`Continuing after Atomic restarted`, `Continuing where it left off`, or `Woken: what it waited for arrived`).
- **Inspecting, waking, or holding.** Viewing a released subagent displays its saved transcript without waking it; press `Alt+W` (`app.tasks.openWaited`) or click `· alt+w opens it` to open its newest waited shell in `/tasks`. Sending a message in its view, sending an Intercom `send`/`ask`, or calling `resume` wakes it immediately. Pressing `x` twice or calling `pause` or `quit` stops auto-wake and holds arriving results until you `resume`.
- **Active waits and crash recovery.** Any parent `action: "wait"` yields and reports the subagent released. Queued steering, follow-up, and Intercom messages persist before wake so nothing is lost on crash. Open Intercom asks stay open across local and [multi-node Intercom routing](/intercom/operations#running-intercom-across-machines). On reopen after restart, detachable tool calls restart with the same call IDs and arguments (mark only idempotent tools `detachable: true`); local Intercom asks time out while multi-node database asks stay alive. At most `parallel.runningCapacity` released subagents wake concurrently.

For the typed `ReleasedChildError` codes reported when tracking or waking a released subagent fails, see [SDK integration and errors](/subagents/reference#sdk-integration-and-errors).

### Automatic restore and session storage

If Atomic exits, crashes, or you switch sessions (`/new`, `/resume`, `/fork`), running subagents stay resumable and relaunch automatically when you reopen the launching session. They keep their Intercom name, group, model, thinking level, original agent definition, forked context instructions, and unread queued steering or follow-up messages (delivered once in order).

Inbound Intercom messages wait while a subagent restores (see [Connection states and recovery](/intercom/operations#connection-states-and-recovery)). Finished, paused, quit, and permanently cancelled subagents do not auto-relaunch, and session forks (`/fork`, `--fork`) never relaunch the original session's subagents. If a subagent cannot be restored (for example, its session or agent definition is missing), Atomic posts one recovery notice with its IDs, worktree or branch, `git` inspection commands, and relaunch call, then marks it gone.

A subagent always keeps its session in the launching session's own session store, the same [storage backend](/storage) instance: SQLite by default, your configured PostgreSQL database, a JSONL directory, or the in-memory store. Nothing about the launch picks another store. A different `cwd`, a project there with its own `.atomic/settings.json` storage settings, a named worktree, `worktree: true`, `context: "fork"`, a resume after a restart, and a launch from a code-mode script all keep the subagent in the launching session's store. Subagents resume, wake, and export wherever their launching session opens, including [another machine sharing the same database](/guides/resume-on-any-machine).

- **What this means for `/tasks` and `history://`.** `/tasks`, `status`, and resume read a subagent's session from the launching session's store, so they work wherever that session opens. A subagent's session is readable at `history://sessions/<id>` from any session using that store. The result names it, with `?project=<dir>` when the subagent ran in another directory or worktree.
- **JSONL stores.** With a JSONL-backed launching session, each subagent's session file sits in the same directory as the launching session's file. The launch's `sessionDir` and `defaultSessionDir` in [config.json](/subagents/reference#subagent-config-json-reference) are ignored, with a one-time deprecation warning. Sessions written as files by earlier releases (under `~/.atomic/agent/subagent-sessions/`, beside a JSONL parent's file, or in a `sessionDir`) stay readable in `/tasks` and restorable. A subagent that was queued but never started relaunches in the launching session's store.
- **Unsaved sessions.** A session started with `--no-session` or in-memory storage keeps subagent sessions in memory; a finished subagent's history moves to a temporary file that Atomic deletes on exit.
- **Session list visibility.** Every subagent session, fresh or `context: "fork"`, is marked internal, so `/resume`, `atomic -r`, `-c`, and the `history://sessions` list omit it. A forked subagent differs only in starting from a copy of its parent's conversation, and its session records the parent it forked from. Each result names its session file or `history://sessions/<id>`.
- **Worktree snapshots.** In a blob-capable store, subagents record [worktree snapshots](/worktree-snapshots) of checkouts they modify. Reopening the main session restores each shared checkout from the newest capture among the main session and its finished subagents, while named worktrees and restored active subagents continue from their own snapshots.

## Coordination and swarms

### Supervisor coordination

By default (`intercomBridge.mode: "always"` in [config.json](/subagents/reference#subagent-config-json-reference)), Atomic injects **both** `intercom` and `contact_supervisor` into **every** subagent whose launching session has Intercom active. Tool frontmatter declarations alone control Intercom tool availability only when `intercomBridge.mode` is `"off"` (or `"fork-only"` for fresh subagents). Main-session tool allowlists, exclusions, `noTools`, and disabled Intercom still apply. A subagent without `read` or `search` receives a read-only `session_history` tool after compaction so it can recover its own history (see [Agents without read or search](/compaction#agents-without-read-or-search)).

- **Supervisor decision waits vs. `intercom` `ask`.** `contact_supervisor({ reason: "need_decision", message })` and `interview_request` wait inside the requesting subagent and continue that same subagent when you reply via `intercom({ action: "reply", message: "..." })` (use `pending` and `replyTo` when multiple asks are open). Never relaunch the subagent to answer it. By contrast, `intercom` `ask` never blocks: it returns at delivery (after any `wait` budget) and delivers late replies as messages.
- **Non-blocking updates.** `intercom` `send` and `contact_supervisor({ reason: "progress_update", message })` return immediately without cancelling or disrupting siblings or worktrees.
- **Messaging a running subagent.** Subagents register on Intercom before their first turn, retrying while starting if the broker is briefly unreachable (supervisor authorization retries up to 30 seconds across broker restarts before starting without it). Address the subagent by its name or full ID from `intercom list`, and set `delivery` to `"steer"` (default), `"followUp"`, or `"interrupt"`. See [Intercom reference](/intercom/reference#the-intercom-tool).
- **Embedded SDK sessions without background task management.** When an embedded SDK session launches a single subagent directly without background task management, `subagent` waits for completion; a blocking `contact_supervisor` request ends that subagent and returns its question, attachments, identity, and `[TASK_CONTEXT]` so the caller can launch a fresh subagent (`subagent({ agent: "worker", task: "[TASK_CONTEXT] ... Continue with this supervisor answer: ..." })`). Cancelling that waiting call stops the subagent permanently and returns labelled partial findings (`progress.md`, last assistant text, or artifact paths).

### Peer coordination

Peer-to-peer coordination is the default. Siblings in a parallel batch, or sharing an explicit `group`, discover each other with `intercom({ action: "list" })` and communicate directly with `send` and `ask` instead of routing through the supervisor.

- Share findings, divide file ownership or expensive test runs, reuse verified reproductions, and challenge disagreements with evidence. Each subagent still returns its own complete result.
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
- **Nesting.** Delegation is strictly one level deep. Only the main session launches subagents.
- **Teams.** Intercom groups have no member cap. Assign each team its own `group` for internal messaging; members can still reach the supervisor via `contact_supervisor`.

### From codemode scripts

When both `codemode` and `subagent` are active, `tools.subagent()` launches the same background subagents and resolves at launch, not completion. Launched subagents belong to the main session and continue even if the script returns, throws, or times out. Separate `tools.subagent()` calls in a script are not merged into a burst; pass `tasks: [...]` for a parallel batch. Subagents cannot launch nested subagents from codemode.

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

Single `{ agent, task }` and parallel `{ tasks }` calls both return `{ action: "launch", tasks }`. Each slot has `agent`, `state` (`"admitted"`, `"queued"`, or `"refused"` with `reason`), `taskId`, `childId`, and `intercomTarget` when available. Do not retry already-started siblings if one slot is refused.

- **`list`, `get`, and `models`.** Inspect executable `agents`, matching `definitions`, or the model catalog (`fullId`, `isCurrent`, `availableThinkingLevels`). Creating, updating, or deleting agent definitions requires a direct tool call.
- **`status`.** Returns `children` launched by this session (pass `id` for one subagent) with state and any `resumeCall`. Use `status` after reopening a session to rediscover subagents instead of relaunching.
- **`wait`.** Takes a task `id` and optional `budgetMs` (default 30 seconds, even if the host waits indefinitely; `0` checks immediately). Script timeouts cancel `wait`, not the subagent. Returns `outcome: "settled"` (with `childId`, `result.status`, output excerpt, `outputPath`, and `resumeCall`), `"running"`, or `"stopped-waiting"` (when the script's signal aborts).
- **`pause`, `quit`, and `resume`.** `pause` and `quit` accept `id` or `all: true`. `resume` takes `id` and optional `message` and returns the new task ID in `children`. Always pass `id` rather than the legacy `runId` alias.
- **Temporary worktrees.** `status` can show `finishing` while `wait` still returns `running`. Check `worktreeNote` or `worktreeNotes` before removing any worktree directory.

## Models, scope, and configuration

### Model selection and `enabledModels` scope

All built-in subagents default to `model: "auto"`, which runs your default model (last chosen with `/model`) at its default thinking level, or the launching session's model when no default is set. Per-call `model` overrides the default, and custom agents without `model` or `fallbackModels` inherit the launching session's model and thinking level. See [Automatic model selection](/subagents/reference#automatic-model-selection).

- **Model catalog.** Call `subagent({ action: "models" })` before pinning a model and use only a returned `fullId` and supported thinking level. Omit per-call `model` unless the user requested a specific model or you have a clear task-specific reason.
- **Credentials.** Providers without configured credentials are skipped before launch and recorded in model attempts. A provider that rejects credentials mid-run is skipped for subsequent fallbacks. If no candidate has credentials, launch fails immediately and lists each missing provider (see [Fallbacks and credentials](/models#fallbacks-and-credentials)).
- **`enabledModels` / `--models` / `/scoped-models` scope.** Subagents enforce the main session's active model scope using the exact same matching rules (`minimatch` `*`/`?`/`[...]` globs, literal bracketed IDs, fuzzy substring matches, and case-insensitive `:thinking` suffixes). `subagent({ action: "models" })` returns only scoped models, fallbacks skip disallowed candidates, and explicit disallowed models fail before launch. If `enabledModels` is set to patterns matching zero available models, **all** subagent launches are refused; only an unset or empty `enabledModels` allows all models.

### Subagent `config.json` and call options

Configure subagent runtime defaults in `~/.atomic/agent/extensions/subagent/config.json` (Atomic falls back to `~/.pi/agent/extensions/subagent/config.json` when the Atomic file is absent):

```json
{
  "parallel": {
    "maxTasks": 2000,
    "concurrency": 2000,
    "runningCapacity": 2000
  },
  "resumeInFlight": "ask",
  "sessionStartTimeoutMs": 300000,
  "intercomBridge": {
    "mode": "always"
  }
}
```

- **`parallel.maxTasks`, `concurrency`, and `runningCapacity`.** All default to `1000` with no hard cap. Per-call `concurrency` overrides `parallel.concurrency`. `runningCapacity` takes effect when the first subagent starts, so restart Atomic after changing it.
- **`resumeInFlight`.** Controls paused or quit subagents awaiting resume on startup or `/resume` (not `/reload`, `/new`, or `/fork`): `"never"` (default, stay in **Awaiting resume**), `"ask"` (one confirmation prompt; falls back to `"never"` without a UI), or `"auto"` (resumes automatically).
- **Additional keys.** `config.json` also supports `defaultSessionDir`, `control` (attention and long-running notice thresholds), `worktreeSetupHook` and `worktreeSetupHookTimeoutMs` (default `30000` ms), and `intercomBridge` (`mode`: `"off" | "fork-only" | "always"`, `instructionFile`). Invalid `resumeInFlight` or `sessionStartTimeoutMs` values drop only that field and log an error while the rest of the file loads; invalid JSON falls back to `{}`. See [Subagent config.json reference](/subagents/reference#subagent-config-json-reference) for every key.
- **Multiple `subagent` calls in one assistant message.** Separate single-agent `subagent` calls emitted in one assistant message combine into one parallel run while returning each call's own results and errors. Shared options (`concurrency`, `worktree: true`, `context`, `control`, `sessionDir`, `maxOutput`, `artifacts`, `includeProgress`, `agentScope`) must match across those calls; `cwd` (must match for `worktree: true`), `group`, and named `worktree: { ... }` stay per call. Prefer one explicit `{ tasks: [...] }` call when planning parallel work.
- **`group`.** A named string joins that Intercom group; boolean `true` or the case-insensitive string `"true"` or `"auto"` creates one shared UUID group for a parallel set. Precedence is explicit `group`, then launching session group, then config, then `"default"`.
- **`cwd` validation.** A missing or non-directory `cwd` fails before starting the subagent.

### Subagent start timeouts

Subagents have a 5-minute startup budget covering session open, resource load, agent session creation (including slot wait), and task dispatch. Queue wait under `parallel.runningCapacity` does not count. Override the budget in `~/.atomic/agent/extensions/subagent/config.json` (milliseconds, `1` to `2147483647`):

```json
{ "sessionStartTimeoutMs": 600000 }
```

Exceeding the budget fails with `SessionStartTimeoutError` (shown in `status` and serialized as `startError` for SDK callers):

| `phase` | Blocked on | Action |
| --- | --- | --- |
| `admission` | Waiting for a session slot. | Free concurrent capacity and retry. |
| `setup` | Opening session, loading resources, or extension startup. | Check session storage or extensions, or raise `sessionStartTimeoutMs`, then retry. |
| `dispatch` | Session started, but `input` or `before_agent_start` blocked dispatch. | Inspect extension handlers and retry. |
| `event-loop` | The main thread was saturated during startup. | Reduce concurrent load and retry. |

For SDK error rehydration (`isSessionStartTimeoutError`, `rehydrateSessionStartError`), see [Session start errors](/sdk/reference#session-start-errors).

### Using subagents from the SDK

`createAgentSession()` enables the bundled subagents package by default. Control subagents and child host behavior directly from `@bastani/atomic`:

```typescript
import { createAgentSession } from "@bastani/atomic";

// Disable the bundled subagents package (also removes its 21 bundled skills)
const withoutPackage = await createAgentSession({
  builtins: { subagents: false },
});

// Hide only the subagent tool while keeping the 21 bundled skills available
const skillsOnly = await createAgentSession({
  excludedTools: ["subagent"],
});

// Route subagent ask_user_question and extension dialogs without a terminal
const headless = await createAgentSession({
  extensionBindings: {
    humanInput: myHostInput,
  },
});
```

- **Child inheritance.** Subagents inherit the parent session's `ModelRuntime`, settings, `agentDir`, `scopedModels`, `fallbackModels`, `customTools`, `resourceAdmission`, and `humanInput`. See [Subagent children in the SDK](/sdk#subagent-children).
- **Human input.** Implement `extensionBindings.humanInput` so dialogs triggered inside a child session route cleanly by `sessionId`. See [Human input without a terminal](/sdk#human-input-without-a-terminal).
- **Background task supervision.** Bind `AgentTaskHost` and `OwnerTaskStore` to observe and control background subagents in custom hosts. See [Owner-bound task supervisor](/sdk/reference#owner-bound-task-supervisor) and [Owner-bound task projection](/subagents/reference#owner-bound-task-projection).

## Delegation boundaries and migration

Delegation is fixed at one level: subagents cannot launch, `pause`, `resume`, or `quit` other subagents, and restricted subagents cannot `create`, `update`, or `delete` agent definitions. Subagents can still run background shells (nested under the subagent in the agent panel) and inspect status with `list`, `get`, `status`, and `wait`. Subagent prompts omit parent orchestration artifacts and prior control traffic.

If older calls or agent definitions still pass removed acceptance-gate fields:

- Remove `acceptance` from `subagent()` calls and task entries.
- Remove `completionGuard: false` from agent frontmatter (tool updates strip it automatically).
- Put required commands, tests, or evidence checks directly in the task prompt.

<div id="custom-agents" />

<div id="fallback-models" />

<div id="reasoning-levels" />

<div id="owner-bound-task-projection" />

## Related docs

- [Create custom subagents](/subagents/authoring#custom-agents) explains how to define, scope, and override agents.
- [Subagent reference](/subagents/reference) covers [agent discovery](/subagents/reference#agent-discovery), [fallback models](/subagents/reference#fallback-models), [reasoning levels](/subagents/reference#reasoning-levels), and [owner-bound task projection](/subagents/reference#owner-bound-task-projection).
- [Orchestrate with codemode and subagents](/orchestration) shows multi-step work with codemode and subagents.
- [Coordinate sessions with Intercom](/intercom) covers cross-session messaging and supervisor escalation.
- [Skills](/skills) covers reusable instructions invoked with `/skill:<name>`.
- [Settings](/settings) covers user and project configuration.
