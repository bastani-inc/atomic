---
title: "Run subagents"
sidebarTitle: "Run subagents"
description: "Delegate bounded work to bundled or custom subagents in the background, isolate edits in Git worktrees, and control running tasks."
---

A subagent is a separate agent session that your main session launches for a focused task. It runs in its own context window in the background, so long code searches, debugging traces, or parallel edits do not crowd out your main conversation. No separate package installation is required.

| What you want | Use this |
| --- | --- |
| Quick, interactive, or immediately blocking work | Keep it in your main chat |
| Focused research, diff review, or debugging in isolation | Delegate to a `fresh`-context subagent |
| Implementation that builds on decisions from the current chat | Delegate to `worker` (uses `fork` context by default) |
| Parallel edits without file conflicts | Launch a parallel `tasks` batch with `worktree: true` or named `worktree: { branch }` |
| Multi-step coordination or custom skills | Launch subagents from [codemode scripts](#from-codemode-scripts) ([Orchestration](/orchestration)) |

Every subagent runs in the background. Let completion notices report back instead of polling, and call `subagent({ action: "wait", id })` only when your next step depends on a subagent's result.

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

Atomic chooses the specialist and execution shape (single subagent, parallel batch, or forked context).

## Bundled agents

| Agent | Purpose | Default context | Edits files? |
| --- | --- | --- | --- |
| `codebase-locator` | Find relevant files, directories, tests, configs, and docs. | `fresh` | No |
| `codebase-analyzer` | Explain code behavior and trace data flow with `file:line` references. | `fresh` | No |
| `codebase-pattern-finder` | Find similar implementations, conventions, and test patterns. | `fresh` | No |
| `codebase-research-locator` | Find related `research/` and `specs/` documents. | `fresh` | No |
| `codebase-research-analyzer` | Extract decisions and active constraints from local docs. | `fresh` | No |
| `codebase-online-researcher` | Research official docs, libraries, and open-source code online (includes `bash` for CLI/cached research notes; no `edit`/`write` tools). | `fresh` | Research notes only |
| `debugger` | Reproduce a failure, prove root cause, apply the minimal fix, and validate it. | `fresh` | Yes |
| `code-simplifier` | Simplify recent changes while preserving behavior. | `fresh` | Yes |
| `worker` | Implement an approved task, validate the change, and escalate scope decisions. | `fork` | Yes |

All bundled agents use `model: "auto"` with no pinned fallback chain. Pin a role persistently via `subagents.agentOverrides.<name>.model` in `settings.json` or per call with `model`. A concrete `model` runs only that model plus the agent's own `fallbackModels` (see [Fallback models](/subagents/reference#fallback-models)).

Bundled skills are preloaded by role: `worker`, `debugger`, `code-simplifier`, and `codebase-analyzer` load `tdd`, `agent-browser`, and `tmux`, while `codebase-online-researcher` loads `agent-browser`. `worker` also enables `defaultProgress: true` (isolated run-scoped `progress.md`), `inheritProjectContext: true`, and `inheritSkills: false`.

### Browse agents with `/agents`

Run `/agents` (or `/agents <query>`) in an interactive session to inspect active agents grouped in precedence order: **Project**, **User**, **Built-in**, and **Package**.

- Type to filter by name, description, or source. Select an agent and press `Enter` to inspect its model, fallbacks, default context, tools, file path, and system prompt.
- Press `Esc` to return to the list, then back to chat.

`/agents` is read-only, never launches or edits agents, and hides shadowed or disabled definitions so it matches execution precedence. Outside interactive mode, call `subagent({ action: "list" })` (note that `action: "list"` hides overridden package agents but still lists shadowed user or built-in definitions alongside project overrides). Leaving `/agents` open never marks [Herdr](/herdr) as blocked.

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
- **`context: "fork"`** branches from your main session's latest settled turn and fails fast if the main session cannot be forked (for example, an empty session with no settled entry before the current turn — it never downgrades silently to `fresh`). A forked subagent inherits the main session's model, thinking level, active tool changes, and saved tool outputs without taking ownership of the main session's other subagents or replaying Intercom cards.

<Warning>
When you omit `context` on a parallel `tasks` batch, adding **any** agent with `defaultContext: fork` (such as `worker`) causes the **entire batch** to run in forked context. Pass `context: "fresh"` explicitly if you want fresh-context siblings alongside `worker`, or launch `worker` in a separate call.
</Warning>

Use `fork` when a subagent needs the main conversation's decisions and context. A forked subagent sends the exact conversation prefix the main session last sent (system prompt, project context, skills, tools, and messages), followed by its own role, a short handoff note, and its task. When it runs on the same model and thinking level, the first request reads from the main session's prompt cache and pays only for the new suffix. On another model or provider it does not share that cache, and on another thinking level it may share only part of it.

In a fork, `inheritProjectContext` and `inheritSkills` do not hide what the main session already sent; those flags apply to `fresh` subagents. The subagent's own tool allowlist still applies: calling a tool outside its allowed list fails with an error naming the allowed tools, and child-only tools not available directly run through `codemode` restricted strictly to the subagent's own tools.

Fresh subagents inherit the main session's model registry, authentication, and workspace discovery settings. A subagent's tool list can narrow permissions, never widen them beyond the main session.

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

- **Parallel mode only.** Creates isolated worktrees only for parallel `tasks: [...]` runs (or multiple single-agent calls emitted in one assistant message). On a standalone single-agent `{ agent, task }` call, `worktree: true` has no effect; use `worktree: { branch }` for an isolated single-agent worktree.
- **Clean tracked working tree required.** Launch fails before starting any subagent if tracked files have staged or unstaged edits (`git status --porcelain --untracked-files=no`). Untracked files do not block launch.
- **Base branch.** Temporary worktrees branch from `origin/<default-branch>` (fetching if needed), falling back to `HEAD` only if no origin default branch exists.
- **Automatic post-creation setup.** After creating each temporary worktree, Atomic copies `.atomic/settings.local.json` and any untracked `.atomic/settings.json`, shares `.husky` or `.git/hooks` via `core.hooksPath`, symlinks (or creates a junction on Windows for) `node_modules`, copies gitignored files listed in `.worktreeinclude`, and runs `worktreeSetupHook` if configured in [config.json](/subagents/reference#subagent-config-json-reference).
- **Shared `cwd`.** All tasks in a `worktree: true` batch must share the same `cwd`; differing per-task `cwd` overrides are rejected.
- **Patch capture and cleanup.** Once every subagent in the batch finishes, Atomic saves each subagent's changes as a patch under `worktree-diffs/<run-id>` and removes the temporary worktrees and branches. If patch capture fails for a worktree, Atomic keeps that worktree on disk and reports it in the diff summary.
- **Paused, quit, and cancelled subagents.** Paused, quit, or session-closed subagents keep their temporary worktree only if it has uncommitted changes, untracked files, or new commits. Clean worktrees are removed; `resume` recreates them from base plus the saved patch (`task-<n>-<agent>.<execution>.patch`). Permanently cancelled subagents release their worktrees, while unresumed stopped worktrees with changes remain under `.atomic/worktrees/`.
- **Waiting on cleanup.** `pause`, `quit`, completion, and failed resume wait for Git cleanup (`Esc` stops waiting without cancelling cleanup; cleanup over 10 seconds warns and continues in the background). Never delete a worktree directory while cleanup is still finishing, a sibling holds the batch, or an orphaned Git process is still running.
- **Git hook integration.** Git hooks can check `ATOMIC_SUBAGENT_WORKTREE_PHASE=finishing` during teardown, and extensions can subscribe to `subagent:finishing` ([Subagent reference](/subagents/reference#sdk-integration-and-errors)).

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

- **No clean-tree requirement and no automatic post-setup.** Named worktrees work with dirty local checkouts and do not symlink `node_modules`, copy settings or `.worktreeinclude` files, configure `core.hooksPath`, run `worktreeSetupHook`, or save diff patches.
- **Permanent ownership.** Atomic never deletes a named worktree or its branch. Resuming reuses the worktree or checks the branch back out there if removed.
- **Branch and path rules.** `path` defaults to `.atomic/worktrees/<branch>` (`/` replaced with `+`); relative paths resolve against the caller's `cwd`, and an existing empty directory at `path` is allowed. New branches use `--no-track` and start from `base`, then `@{upstream}`, then `HEAD`. Unused existing branches check out as-is, and a branch already checked out at `path` is reused. Launch fails fast if the branch is checked out elsewhere or `path` holds something else.
- **Subdirectory `cwd`.** If your session runs inside a repository subdirectory, the subagent starts in that same subdirectory inside the worktree (falling back to the worktree root if absent on the branch).
- **Concurrency and hooks.** Different branches and paths run concurrently; duplicate `(branch, path)` launches wait and reuse, while the same branch at a different path fails after the first finishes. A checkout hook cannot synchronously create another named worktree for the same branch or path (`WorktreeReentryError`). Prefer `worktree: { ... }` over running `git worktree add` alongside subagents in the same turn.

<Note>
**Recovering an interrupted named-worktree checkout.** External Git locks time out after 30 seconds (`another git process seems to be running at <path>`), and an interrupted prior checkout fails immediately (`an interrupted named-worktree checkout left an incomplete worktree at <path>`). To recover, confirm no Git process is running, back up any needed files, run `git worktree unlock <path>`, remove the directory, run `git worktree prune`, and clear stale `HEAD.lock` or branch `.lock` files (or run `git worktree remove --force --force <path>`). Never fix a partial checkout by deleting only `index.lock`.
</Note>

## Background launches and waiting

Every `subagent` launch runs in the background and returns immediately with each subagent's `taskId` and `intercomTarget` (for example `subagent-worker-1a2b3c4d-1`). Use `intercomTarget` verbatim when messaging a subagent.

Subagents return their results directly. Atomic does not infer acceptance gates, so put required tests, commands, or evidence checks directly in the task prompt.

```ts
subagent({ agent: "codebase-analyzer", task: "Trace the auth flow with file references." })
subagent({ action: "wait", id: "<taskId>", budgetMs: 120000 })
subagent({ action: "status", id: "<taskId>" })
```

- **Waiting.** `subagent({ action: "wait", id: taskId, budgetMs? })` observes an existing task launched by this session up to `budgetMs` (default `30000` ms). Ending a wait on budget, pressing `Esc`, user steering (`input-needed`), or an inbound Intercom message (`intercom-coordination`) leaves the subagent running. Wait again when you need its result. See [Observation and wait matrix](/background-tasks/reference#choose-how-long-to-wait).
- **Repeating tasks (`count`).** In parallel `tasks`, set `count` (integer `>= 1`) on an item to repeat it N times. Expanded items count toward `parallel.maxTasks`.
- **Concurrency.** Multiple single-agent launches emitted in one assistant message combine into one parallel run sharing `concurrency` (shared options must match across those calls; prefer one explicit `{ tasks: [...] }` call). Returning from launch or ending a wait does not free a running slot.
- **Heartbeats.** Running subagents send [task heartbeats](/background-tasks#task-heartbeats) every 15 minutes by default. Override with `heartbeatMs` (`0` disables; minimum `60000` ms).
- **Read directives (`reads`).** `reads` does **not** inline file contents; it prepends `[Read from: <abs-path>, ...]` (resolved relative to child `cwd`) to the prompt so the subagent reads those files with its own tools. In single-agent mode, pass an array of paths or `false` (`reads: true` is rejected, and frontmatter `defaultReads` is not applied). In parallel `tasks[]`, omitting `reads` or passing `reads: true` uses the agent's `defaultReads`, and `reads: false` disables it.
- **Output files (`output` / `outputMode`).** When `output` is set, Atomic injects `**Output:** Write your findings to: <path>`. If the subagent creates or modifies that file, Atomic reads it back; otherwise Atomic writes the subagent's final assistant text to that path (creating parent directories). Pass `output: true` to use the agent's frontmatter `output` default, or `output: false` (or `"false"`) to disable it. `outputMode: "file-only"` requires an `output` path and returns only the saved-file reference inline on success (failed runs or save errors still return inline details). Duplicate `output` paths in a parallel batch are rejected.
- **Progress tracking (`progress` / `includeProgress`).** `progress: true` enables an isolated run-scoped `progress.md` under artifact storage (never inside child `cwd` or the repository). When omitted, Atomic inherits the agent's `defaultProgress`, suppressing it automatically if the prompt text uses read-only phrasing (such as `review-only`, `no edits`, `do not edit`, or `leave files unchanged`). `includeProgress: true` only adds progress telemetry on direct blocking runs without a background task host; standard background launches return at admission.
- **Settled output.** `wait` and `status` return up to 16 KB inline, plus `Full output: <path>` (Atomic keeps the 256 most recent copies in a private temp directory and cleans them on exit) and `Requested output:` when `output` was set.
- **Startup progress and retries.** Before a subagent's first turn, `status` reports its exact startup step (`opening its session`, `loading its resources`, waiting for a concurrent session-startup slot, `creating its agent session`, `registering on Intercom`, or `dispatching its task`) with elapsed time. If startup exceeds `sessionStartTimeoutMs` (default 5 minutes), Atomic marks the attempt stalled and retries once after releasing its session (failing without retry if the stalled attempt still holds its session after half the budget, capped at 30 seconds).
- **Session close and reopen.** Closing a session stops running subagents; reopening the same session automatically restores them.

### Task inspection

Use `/tasks` (or `/tasks <id>`) or the agent panel below the prompt (`↓` on an empty prompt) to inspect running, waiting, and finished subagents and their nested shells:

- **Switch to a subagent.** Select a subagent row and press `Enter` (or click it) to view its live transcript and message it on the shared chat screen. Press `←` on an empty prompt or select `main` in the panel to return without interrupting the subagent.
- **Pause or stop.** While viewing a working subagent, press `Esc` (or `Ctrl+C` on an empty prompt) to pause its active turn without affecting main chat. In `/tasks` or the agent panel, press `x` twice within 3 seconds to stop a running task resumably, or `x` once to dismiss a finished row.
- **Subagent shells and questions.** A subagent's running shells nest beneath it in the agent panel, and a subagent's `ask_user_question` or extension dialogs wait inside its own transcript (**Needs input**) without blocking the main chat.
- **Launch cards and history.** Each subagent renders `Agent(<agent> · <short task title>)` (`Ctrl+O` expands prompt, tool calls, and result). Atomic keeps live status for the 256 most recently finished runs plus all active runs; older subagents remain resumable via `subagent({ action: "resume", id })`.

See [Manage background tasks](/background-tasks) and [Background tasks reference](/background-tasks/reference) for the full panel layout, key bindings, slash-command routing, and `/tasks` controls.

### Run control

Control subagents with `pause`, `quit`, and `resume`. The `id` parameter accepts a child ID (`<runId>:<index>`), task ID, Intercom name, or single-child run ID:

```ts
subagent({ action: "pause", id: "<child-id>" })   // Stop now; hold queued messages for resume
subagent({ action: "pause", all: true })          // Pause all running subagents of this session
subagent({ action: "quit", id: "<child-id>" })    // Graceful stop; stays resumable
subagent({ action: "quit", all: true })           // Covers running and already-paused subagents
subagent({ action: "resume", id: "<child-id>", message: "Focus on the failing test first." })
```

- **`pause`.** Stops the active turn and keeps queued steering or follow-up messages to deliver once in order before `resume`'s `message`. Intercom messages to a paused subagent do not resume it; they wait without expiry and arrive after `resume`'s `message`.
- **`quit`.** Stops the subagent gracefully, including already-paused subagents, while keeping it resumable.
- **Awaiting resume.** Completion notices report `paused · awaiting resume` or `quit · awaiting resume` with `Stop reason: pause` or `quit` and the exact `resume` call. `subagent({ action: "status" })` lists them under **Awaiting resume** across restarts as `paused · awaiting resume` or `quit · paused · awaiting resume` without auto-relaunching.
- **Queued parallel subagents.** You can `pause` or `quit` a subagent still waiting for a concurrency slot. `resume` starts it with its original task, optional `message`, model, thinking level, worktree, and fork copy, re-entering the concurrency queue (or reporting it gone if its model or fork copy no longer exists).
- **`resume`.** Continues the subagent's saved session under the same child ID, Intercom name, and group (`all: true` is not supported). For paused, quit, or interrupted subagents, `message` runs before continuing; for completed or failed subagents, `message` starts a fresh turn. Omitting `message` prompts the subagent to continue or stop if done.
- **Resumable vs. terminal.** Paused, quit, interrupted, completed, failed, and session-closed subagents are resumable. **Killed** (explicit cancellation) and **Gone** (unrestorable after restart) subagents are terminal and reject `resume`. Running subagents reject `resume` (`pause` or `quit` them first, or message them via Intercom). Failed resumes preserve `worktree: true` checkouts.
- **Interrupting control calls.** Pressing `Esc` stops waiting on `pause`, `quit`, or `resume` (already-requested stops finish; unstarted resumes cancel cleanly).
- **Removed actions.** `kill` and `interrupt` were removed; calls fail and point to `{ action: "quit", id }`.

#### Messages that resume a finished subagent

Any session allowed to message a subagent under Intercom group and reach rules can wake it. A single-target `intercom` `send` or `ask` to a completed or failed subagent returns immediately with `queued: true`, and the launching session resumes the subagent to handle the message. Calling `subagent({ action: "resume", id: "<intercom-name>", message })` for a subagent launched by another session sends `message` through that same wake queue.

Messages to a paused or quit subagent wait in a durable queue without resuming it until the launching session continues it. Message-triggered resumes are bounded to 6 resumes in 10 minutes and chain depth 4. See [Messages that resume a finished subagent](/intercom/reference#messages-that-resume-a-finished-subagent).

### Released subagents

A background subagent that waits more than 1 minute on a long-running detachable external tool call (for example, a CI run or deployment tool marked detachable), a budgetless shell `wait`, an `intercom` `ask`, or a blocking `contact_supervisor` (`need_decision` or `interview_request`) is **released**. The waited operation keeps running while the subagent frees its session resources and wakes automatically when the result arrives.

- **What you see.** Main chat shows a dim notice (`◌ <name> is waiting on <tool> (<call id>)`) without starting a model turn. `/tasks`, the agent panel, and the launch card list it under **Waiting** with `◌`. `subagent({ action: "status" })` reports `released · waiting on <tool> (<call id>)`.
- **Inspecting, waking, or holding.** Viewing a released subagent opens its saved transcript without waking it; press `Alt+W` (or click `· alt+w opens it`) to inspect its newest waited shell in `/tasks`. Sending a message in its view, sending an Intercom `send`/`ask`, or calling `resume` wakes it immediately. Pressing `x` twice or calling `pause` or `quit` stops auto-wake and holds arriving results until you `resume`.
- **Late results and crash recovery.** If something else wakes the subagent first, the waited call returns as still running and its late result arrives later as a notice card inside the subagent's chat. Queued messages persist before wake so nothing is lost on crash. On reopen after restart, detachable external calls re-run with the same call IDs and arguments; local Intercom asks time out while multi-node database asks stay open. At most `parallel.runningCapacity` released subagents wake concurrently.

For the troubleshooting codes reported when tracking or waking a released subagent fails, see [Released subagent error codes](/subagents/reference#sdk-integration-and-errors).

### Automatic restore and session storage

If Atomic exits, crashes, or you switch sessions (`/new`, `/resume`, `/fork`), running subagents stay resumable and relaunch automatically when you reopen the launching session — keeping their Intercom name, group, model, thinking level, original agent definition, forked context, and unread queued messages.

Finished, paused, quit, and permanently cancelled subagents do not auto-relaunch, and session forks (`/fork`, `--fork`) never relaunch the original session's subagents. If a subagent cannot be restored, Atomic posts one recovery notice with its IDs, worktree or branch, `git` inspection commands, and relaunch call, then marks it gone.

A subagent always stores its session in the launching session's own [session store](/storage) (local SQLite by default, shared PostgreSQL, JSONL directory, or in-memory), regardless of `cwd`, worktrees, forks, or codemode launches. Subagents resume, wake, and export wherever the launching session opens, including [another machine sharing the same database](/guides/resume-on-any-machine):

- **Visibility and `history://`.** Subagent sessions are marked internal, so `/resume`, `atomic -r`, `-c`, and `history://sessions` omit them, while `history://sessions/<id>` reads them directly (with `?project=<dir>` if the subagent ran in another directory or worktree). In SQLite and PostgreSQL stores, forked subagents share their parent's conversation history instead of copying it ([Shared-history forks](/storage#shared-history-forks)).
- **Unsaved sessions.** Sessions started with `--no-session` or in-memory storage keep subagent sessions in memory and move finished transcripts to a temp file cleaned on exit.
- **Worktree snapshots.** In blob-capable stores, subagents record [worktree snapshots](/worktree-snapshots) of checkouts they modify so reopening restores the newest state cleanly.

## Coordination and swarms

### Supervisor coordination

By default (`intercomBridge.mode: "always"` in `config.json`), Atomic injects **both** `intercom` and `contact_supervisor` into **every** subagent whose launching session has Intercom active. Tool frontmatter alone controls Intercom availability only when `intercomBridge.mode` is `"off"` (or `"fork-only"` for fresh subagents). A subagent without `read` or `search` also receives a read-only `session_history` tool after compaction to recover its own history (see [Agents without read or search](/compaction/memory-compaction#agents-without-read-or-search)).

- **Decision waits vs. `intercom` `ask`.** `contact_supervisor({ reason: "need_decision", message })` and `interview_request` wait inside the requesting subagent and continue that same subagent when you answer with `intercom({ action: "reply", message: "..." })` (use `pending` and `replyTo` when multiple asks are open). Never relaunch the subagent to answer it. By contrast, `intercom` `ask` returns at delivery and delivers late replies as messages.
- **Non-blocking updates.** `intercom` `send` and `contact_supervisor({ reason: "progress_update", message })` return immediately without interrupting siblings or worktrees.
- **Messaging a running subagent.** Subagents register on Intercom before their first turn. Address a subagent by its `intercomTarget` or ID from `intercom list`, and choose `delivery: "steer"` (default), `"followUp"`, or `"interrupt"`. See [Intercom reference](/intercom/reference#the-intercom-tool).
- **Embedded SDK sessions without background task management.** When an SDK host runs a single subagent directly without a background task host, `subagent` blocks until completion and a blocking `contact_supervisor` ends the subagent with `[TASK_CONTEXT]` so the caller can launch a fresh subagent with the supervisor's answer.

### Peer coordination

Peer-to-peer coordination is the default. Siblings in a parallel batch, or sharing an explicit `group`, discover each other with `intercom({ action: "list" })` and communicate directly with `send` and `ask` instead of routing through the supervisor.

- Share findings, divide file ownership or expensive test runs, pass along reproductions, and challenge disagreements with evidence. Each subagent still returns its own complete result.
- Reserve `contact_supervisor` for supervisor decisions. Peer asks and one blocking supervisor ask can wait concurrently. See `/skill:intercom` for peer patterns.

```typescript
const peerRules =
  "Your siblings review the same diff. Run intercom list to find them, share every confirmed finding, " +
  "ask them whatever you need, and debate disagreements with evidence. Then return your own structured verdict.";

subagent({
  tasks: [
    { agent: "codebase-analyzer", task: `Review correctness of the auth changes. ${peerRules}` },
    { agent: "codebase-analyzer", task: `Review security of the auth changes. ${peerRules}` },
    { agent: "codebase-analyzer", task: `Review test coverage of the auth changes. ${peerRules}` },
  ],
});
```

### Scaling a swarm

- **Parallel limits.** `parallel.maxTasks`, `parallel.concurrency`, and `parallel.runningCapacity` each default to `1000` with no hard upper cap. Adjust all three in `config.json` to raise limits, or lower `parallel.concurrency` to throttle. Provider rate limits and host memory remain the practical bounds.
- **Teams.** Intercom groups have no member cap. Give each team a named `group` (or `group: true` for a unique shared UUID group); members can still reach the supervisor via `contact_supervisor`.

### From codemode scripts

When both `codemode` and `subagent` are active, `tools.subagent()` launches the same background subagents and resolves at launch, not completion. Admitted subagents belong to the main session and keep running even if the script returns, throws, or times out. Separate `tools.subagent()` calls are not merged into one burst; pass `tasks: [...]` for a parallel batch.

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

Single and parallel launches both return `{ action: "launch", tasks }`. Each slot contains `agent`, `state` (`"admitted"`, `"queued"`, or `"refused"` with `reason`), `taskId`, `childId`, and `intercomTarget` when available. Do not retry already-started siblings if one slot is refused.

- **Strict script rules.** Always pass `id` — passing the legacy `runId` alias is **rejected** in codemode (`"Use id instead of runId in subagent scripts."`). In `wait`, `budgetMs` must be a non-negative safe **integer** (defaults to `30000` ms even when a host configures unlimited foreground waits; `0` checks immediately).
- **`wait` outcomes.** Returns `outcome: "settled"`, `"running"`, or `"stopped-waiting"` (when the script's signal aborts; script timeouts cancel `wait`, not the subagent). On settled results, both `pause` and `quit` stops (when not released) resolve to `result.status: "paused"` (with `result.reason: "pause"` or `"quit"`), while a released child resolves to `result.status: "cancelled"`.
- **`list`, `get`, `models`, `status`, and control.** Inspect agents or models, call `status` after reopening a session to reconcile `children`, and call `pause`, `quit`, or `resume` with `id` (or `all: true` for `pause`/`quit`). Creating, updating, or deleting agent definitions requires a direct tool call.
- **Temporary worktrees.** `status` can show `finishing` while `wait` still returns `running`. Check `worktreeNote` or `worktreeNotes` in script results before deleting any temporary worktree directory.

## Configuration and start timeouts

Configure subagent runtime defaults in `~/.atomic/agent/extensions/subagent/config.json` (or `~/.pi/agent/extensions/subagent/config.json` when the Atomic file is absent) and inspect available scoped models with `subagent({ action: "models" })`. Subagents enforce your active `enabledModels` / `--models` / `/scoped-models` scope and skip providers without configured credentials before launch. For every `config.json` key, model resolution rule, fallback chain, and tool parameter, see [Subagent reference](/subagents/reference).

### Subagent start timeouts

Subagents have a **5-minute** (`300000` ms) startup budget covering session open, resource load, agent session creation (including slot wait), and task dispatch. Queue wait under `parallel.runningCapacity` does not count. Override it in `~/.atomic/agent/extensions/subagent/config.json` (`1` to `2147483647` ms):

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

For SDK configuration (`createAgentSession`, `builtins: { subagents: false }`, `excludedTools: ["subagent"]`, `humanInput`) and error rehydration, see [Subagent children in the SDK](/sdk#subagent-children) and [Session start errors](/sdk/reference#session-start-errors).

## Delegation boundaries

Delegation is fixed at one level: only the main session can launch, `pause`, `resume`, or `quit` subagents, and restricted subagents cannot `create`, `update`, or `delete` agent definitions. Subagents can still run background shells (nested under the subagent in the agent panel) and inspect status with `list`, `get`, `status`, and `wait`. Subagent prompts omit parent orchestration artifacts and prior control traffic.

<Note>
**Removed acceptance-gate fields.** Older calls or agent files that passed `acceptance` or `completionGuard: false` should remove them (tool-based updates strip `completionGuard` automatically) and put required tests, commands, or evidence checks directly in the task prompt.
</Note>

## Next steps

<Columns cols={2}>
  <Card title="Create custom subagents" href="/subagents/authoring">
    Define custom Markdown agents, YAML frontmatter fields, and built-in overrides.
  </Card>
  <Card title="Subagent reference" href="/subagents/reference">
    Discovery precedence, automatic model selection, fallback models, `config.json`, and tool parameters.
  </Card>
  <Card title="Manage background tasks" href="/background-tasks">
    Agent panel, `/tasks`, steering, stopping work, and task heartbeats.
  </Card>
  <Card title="Orchestrate multi-step work" href="/orchestration">
    Coordinate parallel subagents from codemode and recover cleanly after interruptions.
  </Card>
</Columns>
