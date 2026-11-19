---
title: "Orchestration with codemode and subagents"
description: "Run multi-step work in chat, keep track of background children, and convert an earlier workflow file into a reusable skill."
---

# Orchestration with codemode and subagents

Ask Atomic for the result you want and how to check it. For example: “Review the installation guide for Linux and Windows in parallel. Report any commands that don't match the CLI. Don't edit files.” The parent chat decides which work can run together, launches [subagents](/subagents) for it, and uses [codemode](/codemode) for checks and decisions. For a small task, it can just answer directly.

## Launch now, use the result later

The following is JavaScript the **parent model** runs inside codemode, not a file you need to install. If your session has a custom tool selection, use `/tools` to check that codemode and subagents are available:

```js
const launch = await tools.subagent({
  tasks: ["Linux", "Windows"].map(platform => ({
    agent: "codebase-analyzer",
    task: `Check the ${platform} installation guide against the CLI. Return commands and file:line evidence; don't edit.`
  }))
});
store("guide-review", launch.tasks);
return launch.tasks;
```

`await` waits for **admission**, not for the reviews. An admitted or queued entry has a `taskId` and a `childId`; a refused entry has a `reason` and no child to wait for. Check each entry. The parent can do other work or end its turn. Each completion notice brings the parent back to the result; `/tasks` lets you inspect the children yourself.

If the next step needs one result *now*, a later script can wait briefly without starting another child:

```js
// @options: {"timeout_ms": 10000}
const task = load("guide-review").find(t => t.taskId);
if (!task) return "No review was admitted.";
return await tools.subagent({ action: "wait", id: task.taskId, budgetMs: 2000 });
```

A wait ending at its budget does not stop the child; neither does interrupting the script after admission. To stop a child deliberately, use `tools.subagent({ action: "quit", id: childId })`. Use the actual result and its status, not the receipt, as evidence. For a joint review, account for each required child or say which part is missing.

**The parent launches all children.** If one review uncovers more work, have that child report the finding. The parent can then launch another batch; a child cannot start its own subagents.

If children need to coordinate, give the batch `group: true` or give several launches the same named `group`. Use the receipt's exact `intercomTarget` to [send a message](/intercom/reference#from-codemode-scripts). A delivery acknowledgement is not a task result.

## What survives interruption?

**Children are persisted sessions; the script is not a checkpointed program.** Reopen the original parent session to recover its unfinished children. A paused child stays resumable from `/tasks` or with `tools.subagent({ action: "resume", id: childId })`. The parent continues in chat from notices, saved results, and decisions, not by jumping back into a JavaScript loop.

Use [the codemode store](/codemode#store-values) for small handoffs such as task IDs, a round number, and the next check. Stored values survive in the session after a successful script. Tool side effects can happen even if that script fails. Inspect `/tasks`, the chat, and any changed files before retrying a launch or an external action. A recovery script can return `await tools.subagent({ action: "status" })` and match its `children` to saved `childId`s. Collect finished results, resume paused work that is still needed, and only relaunch a missing child after checking what it left behind.

## Choose a pattern

- [Classify-and-act](/orchestration/patterns#classify-and-act): route a report by category.
- [Fan-out-and-synthesize](/orchestration/patterns#fan-out-and-synthesize): split a review and reconcile the evidence.
- [Adversarial verification](/orchestration/patterns#adversarial-verification): ask an independent child to find a counterexample.
- [Generate-and-filter](/orchestration/patterns#generate-and-filter): collect candidates and discard those that fail an explicit check.
- [Tournament](/orchestration/patterns#tournament): compare alternatives against the same fixtures.
- [Loop-until-done](/orchestration/patterns#loop-until-done): check each repair and stop at success or the round limit.
- [Stacked slices](/orchestration/patterns#stacked-slices): launch each dependent task from its verified prerequisite.

Have an earlier workflow file or builtin name? See [Convert an earlier workflow into a skill](/orchestration/migrating-workflows). To save new procedures, use a [skill](/skills#skills-as-workflows).
