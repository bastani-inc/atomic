---
title: "Orchestration with codemode and subagents"
description: "Run multi-step work in chat, keep track of background children, and convert an earlier workflow file into a reusable skill."
---

# Orchestration with codemode and subagents

Describe the outcome you want and how to verify it—for example: *"Review the installation guide for Linux and Windows in parallel. Report any commands that don't match the CLI. Don't edit files."*

The parent chat decides whether to answer directly, run checks in [codemode](/codemode), or split work across [subagents](/subagents).

## Launch now, use the result later

The snippet below is JavaScript the **parent model** executes inside `codemode` (not a file you install). Run `/tools` if your session uses a custom tool list to confirm `codemode` and `subagent` are active:

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

- **Admission, not completion:** `await` resolves once children are admitted. Admitted or queued slots return `{ taskId, childId }`; refused slots return `{ reason }` with no running child. The parent can continue working or end its turn—completion notices return results automatically, and `/tasks` lets you inspect children directly.
- **Explicit wait:** When a later step needs a result immediately, wait briefly without launching a second child:

```js
// @options: {"timeout_ms": 10000}
const task = load("guide-review").find((t) => t.taskId);
if (!task) return "No review was admitted.";
return await tools.subagent({ action: "wait", id: task.taskId, budgetMs: 2000 });
```

- **Cancellation & evidence:** Hitting `budgetMs` or interrupting the script never stops an admitted child—use `tools.subagent({ action: "quit", id: childId })` to stop it. Treat actual child results and status (not launch receipts) as evidence, and account for every required child in joint reviews.
- **Flat delegation:** Only the parent launches subagents. If a child uncovers follow-up work, it reports back so the parent can launch the next batch.
- **Peer messaging:** Pass `group: true` or a shared named `group` so children can coordinate over Intercom. Address them with the exact `intercomTarget` from the launch receipt ([Intercom from codemode](/intercom/reference#from-codemode-scripts)); a delivery ack is not a task result.

## What survives interruption?

**Children are persisted sessions; codemode scripts are not checkpointed programs.**

- Reopening the original parent session automatically restores unfinished children. Paused or quit children resume from `/tasks` or `tools.subagent({ action: "resume", id: childId })`.
- The parent resumes in chat from notices, saved results, and decisions rather than re-entering an old JS loop.
- Save small handoff state (task IDs, round count, next check) with [the codemode store](/codemode#store-values), which persists per branch when a script succeeds. Tool side effects happen even if a script later fails, so inspect `/tasks`, chat, and changed files before retrying.
- On recovery, call `await tools.subagent({ action: "status" })` and reconcile `children` against stored `childId`s: collect finished results, resume paused work still needed, and relaunch missing children only after checking what they left behind.

## Choose a pattern

- [Classify-and-act](/orchestration/patterns#classify-and-act) — triage first, then dispatch.
- [Fan-out-and-synthesize](/orchestration/patterns#fan-out-and-synthesize) — split an analysis and reconcile findings.
- [Adversarial verification](/orchestration/patterns#adversarial-verification) — ask an independent child to break a candidate.
- [Generate-and-filter](/orchestration/patterns#generate-and-filter) — collect candidates and keep only those passing a check.
- [Tournament](/orchestration/patterns#tournament) — compare competing implementations on shared fixtures.
- [Loop-until-done](/orchestration/patterns#loop-until-done) — run checks between bounded repair rounds.
- [Stacked slices](/orchestration/patterns#stacked-slices) — branch each dependent slice from the verified prior commit.

Migrating an earlier workflow file or built-in name? See [Convert an earlier workflow into a skill](/orchestration/migrating-workflows). To save new repeatable procedures, use a [skill](/skills#skills-as-workflows).
