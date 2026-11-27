---
title: "Orchestrate multi-step work"
sidebarTitle: "Orchestrate multi-step work"
description: "Delegate multi-step work in plain language or codemode scripts, handle background results as they settle, and recover cleanly after interruptions."
---

Give Atomic a goal, how to verify completion, and any limits on edits, cost, or time. You do not need to write JavaScript to split work across agents — describe the work in plain language and your main session decides whether to answer directly, run checks in [codemode](/codemode), or split work across [subagents](/subagents):

```text
Review the installation guide for Linux and Windows. Give each platform to a separate read-only subagent. Check disputed commands against the CLI, then report discrepancies by platform. Do not edit files.
```

| What you want | Use this |
| --- | --- |
| One-off multi-step task or parallel review | Ask in plain language; Atomic coordinates the subagents for you |
| Monitor, steer, or answer running subagents | Open `/tasks` or focus the [agent panel](/background-tasks#the-agent-panel) (`↓` on an empty prompt) |
| Save a repeatable multi-step procedure | Write a [skill](/skills#skills-as-workflows) describing the steps (optionally with codemode snippets) |
| Pick a proven coordination structure | Start from the seven [orchestration patterns](/orchestration/patterns) |

<Note>
**Who writes codemode JavaScript?** During ordinary chat, Atomic writes and runs the [codemode](/codemode) JavaScript below automatically when coordinating parallel subagents. You only write `tools.subagent(...)` snippets yourself when authoring a custom [skill](/skills#skills-as-workflows) or prompt template that encodes a repeatable workflow.
</Note>

## Launch now, use the result later

When your main session coordinates subagents through [codemode](/codemode) (confirm both `codemode` and `subagent` are enabled with `/tools`), `tools.subagent()` launches background subagents and returns immediately:

```js
const launch = await tools.subagent({
  tasks: ["Linux", "Windows"].map((platform) => ({
    agent: "codebase-analyzer",
    task: `Check the ${platform} installation guide against the CLI. Return commands and file:line evidence; don't edit.`,
  })),
});
store("guide-review", launch.tasks);
return launch.tasks;
```

Example `launch.tasks` output:

```json
[
  { "taskId": "task-1-0-2", "childId": "a1b2c3d4:0", "agent": "codebase-analyzer", "state": "admitted", "intercomTarget": "subagent-codebase-analyzer-a1b2c3d4-0" },
  { "taskId": "task-1-0-3", "childId": "a1b2c3d4:1", "agent": "codebase-analyzer", "state": "admitted", "intercomTarget": "subagent-codebase-analyzer-a1b2c3d4-1" }
]
```

- **Launch, not completion.** `await` resolves as soon as subagents start (`"admitted"`), queue (`"queued"`), or fail validation (`"refused"` with `reason`). Your main session can keep working or end its turn while completion notices deliver results automatically. Inspect live progress anytime in `/tasks` or the agent panel ([Manage background tasks](/background-tasks)).
- **Explicit parallel batches.** Separate `tools.subagent()` calls inside one script are not merged automatically; pass `tasks: [...]` to launch a parallel batch.
- **Explicit wait.** When a later step depends on a result immediately, wait on the existing task ID instead of launching a duplicate. The `// @options` comment sets per-script [codemode options](/codemode) such as `timeout_ms`:

```js
// @options: {"timeout_ms": 10000}
const task = load("guide-review").find((t) => t.taskId);
if (!task) return "No review was started.";
return await tools.subagent({ action: "wait", id: task.taskId, budgetMs: 2000 });
```

  In codemode, always pass `id` (passing `runId` is rejected), pass a non-negative integer for `budgetMs` (defaults to `30000` ms even when a host configures unlimited foreground waits), and note that `pause` and `quit` stops both report `result.status: "paused"`.
- **Cancellation and evidence.** Hitting `budgetMs`, returning early, or timing out the script never stops already-launched subagents; call `tools.subagent({ action: "quit", id: childId })` to stop one. Treat settled results and real verification output — never launch receipts — as evidence.
- **One-level delegation.** Only the main session launches subagents. If a subagent discovers follow-up work, it reports back so the main session can launch the next batch.
- **Peer messaging.** Pass `group: true` to create a unique shared [Intercom](/intercom) group for a batch, or pass a shared named `group`. Address subagents using their exact `intercomTarget` ([Intercom from codemode](/intercom/reference#from-codemode-scripts)); `contact_supervisor` still reaches the main session across groups.

## What survives interruption

Subagents are persisted sessions; codemode scripts are not checkpointed programs.

- **Reopening a session.** Running subagents relaunch automatically when you reopen the original main session. Paused and quit subagents stay awaiting manual resume in `/tasks` or via `tools.subagent({ action: "resume", id: childId })` (unless configured otherwise via [run control settings](/subagents/reference#subagent-config-json-reference)).
- **Forks and unsaved sessions.** Forking a session (`/fork` or `--fork`) never restores the original session's subagents, and sessions started with `--no-session` are not saved so their subagents cannot be restored after Atomic closes.
- **Branch-scoped handoff state.** Save small handoff state — task IDs, round counts, and next checks — with [the codemode store](/codemode#store-values). `store()` writes persist per branch only when the script succeeds; if a script throws or times out, its `store()` writes are discarded even though launched subagents keep running.
- **Reconciling after a restart.** Call `await tools.subagent({ action: "status" })` and reconcile `children` against stored `childId` values before launching new subagents. Collect finished results, resume paused work that is still needed, and inspect `/tasks`, chat, and modified files before retrying.

## Choose a pattern

<Columns cols={2}>
  <Card title="Classify-and-act" href="/orchestration/patterns#classify-and-act">
    Triage input with a read-only subagent, validate the label, then dispatch the matching specialist.
  </Card>
  <Card title="Fan-out-and-synthesize" href="/orchestration/patterns#fan-out-and-synthesize">
    Split a broad review or investigation across parallel subagents and reconcile their evidence.
  </Card>
  <Card title="Adversarial verification" href="/orchestration/patterns#adversarial-verification">
    Ask a fresh read-only subagent to find a concrete failing input against a candidate fix.
  </Card>
  <Card title="Generate-and-filter" href="/orchestration/patterns#generate-and-filter">
    Gather candidate inputs or cases from fresh subagents and filter them with a deterministic check.
  </Card>
  <Card title="Tournament" href="/orchestration/patterns#tournament">
    Compare competing implementations in isolated named worktrees against shared fixtures.
  </Card>
  <Card title="Loop-until-done" href="/orchestration/patterns#loop-until-done">
    Run verification checks in the main session between bounded repair rounds.
  </Card>
  <Card title="Stacked slices" href="/orchestration/patterns#stacked-slices">
    Branch each dependent slice from the verified commit of the previous slice.
  </Card>
  <Card title="Skills as workflows" href="/skills#skills-as-workflows">
    Save repeatable multi-step instructions as a skill, or migrate legacy workflow files.
  </Card>
</Columns>

Have an earlier `.atomic/workflows/*.ts` file or removed built-in workflow name? Follow [Migrate an earlier workflow to a skill](/orchestration/migrating-workflows).
