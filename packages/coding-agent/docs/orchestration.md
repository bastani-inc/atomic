---
title: "Orchestrate with codemode and subagents"
sidebarTitle: "Orchestration"
description: "Coordinate parallel subagents from codemode, handle results as they finish, and recover after interruptions."
---

Describe the outcome you want and how to verify it. For example: "Review the installation guide for Linux and Windows in parallel. Report any commands that do not match the CLI. Do not edit files."

Your main session decides whether to answer directly, run checks in [codemode](/codemode), or split work across [subagents](/subagents).

## Launch now, use the result later

The snippet below is JavaScript that your main session runs inside `codemode`, not a file you install. Run `/tools` if your session uses a custom tool list to confirm `codemode` and `subagent` are active.

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

- **Launch, not completion.** `await` resolves as soon as subagents start or enter the queue. Started or queued slots return `{ taskId, childId, agent, state: "admitted" | "queued", intercomTarget? }` (`intercomTarget` is included when Intercom is enabled for the subagent). Refused slots return `{ agent, state: "refused", reason }` with no running subagent. Your main session can continue working or end its turn while completion notices return results automatically, and `/tasks` lets you inspect subagents directly.
- **Explicit parallel batches.** Separate `tools.subagent()` calls inside codemode are not merged into one burst. Pass `tasks: [...]` when you want a parallel batch.
- **Explicit wait.** When a later step needs a result immediately, wait briefly without launching a second subagent. The `// @options` comment sets per-script [codemode options](/codemode) such as `timeout_ms` (codemode scripts have a 256 MiB memory limit and no default timeout):

```js
// @options: {"timeout_ms": 10000}
const task = load("guide-review").find((t) => t.taskId);
if (!task) return "No review was started.";
return await tools.subagent({ action: "wait", id: task.taskId, budgetMs: 2000 });
```

  Inside codemode, `tools.subagent({ action: "wait" })` defaults to a 30-second budget even when a host configures unlimited foreground waits.
- **Cancellation and evidence.** Hitting `budgetMs`, returning early, or interrupting the script never stops an already-launched subagent (unawaited tool calls are cancelled when the script returns, while already-launched background subagents keep running). Use `tools.subagent({ action: "quit", id: childId })` to stop one. Treat actual subagent results and status, not launch receipts, as evidence, and account for every required subagent in joint reviews.
- **One-level delegation.** Only the main session launches subagents. If a subagent uncovers follow-up work, it reports back so the main session can launch the next batch.
- **Peer messaging.** Pass `group: true` to create a unique shared Intercom group for that batch, or pass a shared named `group`. Peer isolation keeps unrelated sessions out while `contact_supervisor` still reaches the main session across groups. Address subagents with the exact `intercomTarget` from the launch result ([Intercom from codemode](/intercom/reference#from-codemode-scripts)). A delivery acknowledgement is not a task result.

## What survives interruption

Subagents are persisted sessions; codemode scripts are not checkpointed programs.

- Reopening the original main session automatically restores running subagents. Paused or quit subagents resume from `/tasks` or `tools.subagent({ action: "resume", id: childId })`.
- Your main session resumes in chat from completion notices, saved results, and decisions instead of re-entering an old JavaScript loop.
- Save small handoff state, such as task IDs, round count, and next checks, with [the codemode store](/codemode#store-values), which persists per branch only when a script succeeds. If a script throws or times out, all `store()` writes from that script are discarded, even though any `tools.subagent()` launches already started. Inspect `/tasks`, chat, and changed files before retrying.
- On recovery, call `await tools.subagent({ action: "status" })` and reconcile `children` against stored `childId` values. Collect finished results, resume paused work that is still needed, and relaunch missing subagents only after checking what they left behind.

## Choose a pattern

- [Classify-and-act](/orchestration/patterns#classify-and-act) triages input first, then dispatches the matching specialist.
- [Fan-out-and-synthesize](/orchestration/patterns#fan-out-and-synthesize) splits an analysis across parallel subagents and reconciles their findings.
- [Adversarial verification](/orchestration/patterns#adversarial-verification) asks an independent subagent to break a candidate.
- [Generate-and-filter](/orchestration/patterns#generate-and-filter) collects candidates and keeps only those passing a deterministic check.
- [Tournament](/orchestration/patterns#tournament) compares competing implementations on shared fixtures.
- [Loop-until-done](/orchestration/patterns#loop-until-done) runs verification checks between bounded repair rounds.
- [Stacked slices](/orchestration/patterns#stacked-slices) branches each dependent slice from the verified prior commit.

To migrate an earlier workflow file or built-in name, see [Migrate an earlier workflow to a skill](/orchestration/migrating-workflows). To save new repeatable procedures, use a [skill](/skills#skills-as-workflows).
