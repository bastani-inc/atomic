---
title: "Orchestration patterns"
description: "Seven ways to split work, keep track of the children, and verify what they produced."
---

# Orchestration patterns

Give each child one question or deliverable, its inputs, its edit permissions, and a check for success. Assign conflicting edits to separate worktrees. Let the parent make decisions and run checks; a child saying “done” isn't proof. Each example below is a **short codemode call in the parent chat**, not a script that stays alive until every phase finishes. On returning to the session, use `status` and the [saved receipts](/orchestration#what-survives-interruption) before starting more children.

## Prompt anatomy

A child should be able to act on its assignment without knowing the parent's whole plan. Give it the objective, the reason it matters, the inputs it can actually read, what it may change, and what is out of scope. Specify the deliverable: a verdict with file and line references, a named result file, or a tested commit. For example:

> Check the Windows install instructions in `docs/install.md` against the CLI flags in this checkout. Report each discrepancy as a command, its documented behavior, and the behavior you observed. Return “no discrepancies” if all the commands agree. Don't edit files or install software.

### Done criteria

State what must be true of the result, not just what the worker should attempt. For a fix, name the changed behavior, a nearby behavior that must stay unchanged, and the checks that demonstrate both. For a review, decide how to tell “checked and found nothing” from “couldn't check.” Have the parent inspect the output or rerun a check against the same candidate before using it. See [Verification and evidence](/verification) for repeatable scenarios and reporting a gap.

### Stop conditions

Agree when **not** to take the next step: an attempt limit, a missing prerequisite, contradictory inputs, or an action outside the user's authorization. If a repair would change a public API, migrate data, or publish something the user didn't request, stop and ask. If a check fails within the agreed scope, give the next attempt the observed failure rather than a broader assignment.

## Design checklist

Before launching a batch, check the few decisions that would change how you run it:

- **Fit:** Is the result clear? Would a single direct check answer the question more cheaply than delegation?
- **Assignments:** Which tasks are independent? Give each writer a distinct worktree or set of files; launch a dependent task only after its prerequisite is verified.
- **Handoffs:** What input or artifact does each child need? Name who produces it, where to find it, and how the parent will validate its format. Pass file paths instead of entire transcripts.
- **Recovery:** Record child IDs, the candidate revision, and the next check. On restart, reconcile them with current task state before repeating an external action.
- **Acceptance:** Which observable result means success? What bounds repairs or requires a human decision? Keep permission to publish separate from permission to implement.

## Classify-and-act

Use this when the next action depends on the kind of input. For example, have a read-only child classify a report as `bug`, `docs`, or `unclear`. Save its receipt. After its notice, validate the label before dispatching. In this example the parent has saved the reviewed label and report:

```js
const { label, report } = load("triage");
if (!["bug", "docs"].includes(label)) return "Clarify the report before dispatch.";
const r = await tools.subagent({ agent: label === "bug" ? "debugger" : "worker", task: report });
store("triage:action", r.tasks);
return r.tasks;
```

On recovery, check for an existing action child before launching another. Verify the fix against the original report, not just the classification.

## Fan-out-and-synthesize

Split a broad review into independent questions. Use one batch so the parent can track which results belong together:

```js
const r = await tools.subagent({ group: true, tasks: ["Linux", "Windows"].map(platform => ({
  agent: "codebase-analyzer", task: `Check ${platform} installation commands. Return evidence; don't edit.`
})) });
store("platforms", r.tasks);
return r.tasks;
```

Join the results in a later turn, when each required child has finished or failed. Reconcile contradictions against the source. After a restart, recover missing results by task ID, not by repeating all the reviews.

## Adversarial verification

Use a second perspective when a plausible answer could still be wrong. Give a fresh read-only reviewer the acceptance criteria and the candidate, not the author's verdict:

```js
const r = await tools.subagent({ agent: "codebase-analyzer", context: "fresh",
  task: "Find a counterexample to the proposed date formatter in src/date.ts. Give the input and expected output; don't edit." });
store("date:review", r.tasks);
return r.tasks;
```

Run the relevant test in the parent, check the tool's actual exit code, and send an observed failure back for repair. After interruption, check that the reviewed revision still matches. If using several reviewers, have each record an independent verdict before one bounded round of exchanging evidence via Intercom. A majority vote does not invalidate a reproducible counterexample. For an interface, [exercise the real UI](/computer-use) rather than accepting a screenshot of a different environment.

## Generate-and-filter

When several answers may work, ask children for concrete candidates and apply the same filter to all. For example, collect candidate date strings with the batch below:

```js
const r = await tools.subagent({ tasks: ["year boundary", "leap day"].map(topic => ({
  agent: "worker", task: `Return three distinct dates around a ${topic} as a JSON string array. Don't edit files.`
})) });
store("dates:generators", r.tasks);
return r.tasks;
```

Recover each generator's output from its notice or task. Parse it as data, reject invalid arrays, remove duplicates, and keep only dates that round-trip through the actual formatter. “None passed” is a valid outcome.

## Tournament

Use this to choose between working alternatives. Fix a scoring rule, fixtures, and tie-breaker first. Put competing edits in different worktrees:

```js
const r = await tools.subagent({ tasks: ["lookup-table", "parser"].map(strategy => ({
  agent: "worker", task: `Implement the ${strategy} approach on your own branch; return the commit and test command.`,
  worktree: { branch: `compare/${strategy}` }
})) });
store("candidates:round1", r.tasks);
return r.tasks;
```

Compare the exact commits on the same fixtures, advance winners, and repeat only as many rounds as agreed. Keep scores and commit IDs with the round number so resuming can't advance a candidate twice. Do not select or merge a winner that fails a required check.

## Loop-until-done

Use a bounded loop for “fix until green.” Have the parent run the project's agreed check between attempts. For a project whose check is `npm test`:

```js
const check = await tools.bash({ command: "npm test" });
if (check.exit_code === 0) return "Passed";
const round = load("repair:round") ?? 0;
if (round >= 3) return "Still failing after three repair attempts.";
const r = await tools.subagent({ agent: "debugger", task: `Repair the test failure; don't suppress the test.\n${check.output.slice(-2000)}` });
store("repair:round", round + 1);
store("repair:last", r.tasks);
return r.tasks;
```

Run this only after the preceding child finishes. Stop on refusal, a missing prerequisite, or a request for approval. On recovery, inspect the last receipt and the current checkout, then rerun the check before spending another round.

## Stacked slices

When work really is ordered, start the next slice from the verified result of the previous one. For example, approve an API change on `feature/api` before launching a CLI worker. Give it a named branch based on that exact commit:

```js
const apiCommit = load("verified-api-commit");
if (!apiCommit) return "Verify the API slice and record its commit first.";
const r = await tools.subagent({ agent: "worker", worktree: { branch: "feature/cli", base: apiCommit },
  task: `Wire the CLI to the API at ${apiCommit}. Add a CLI test, run it, and return the commit.` });
store("cli-slice", r.tasks);
return r.tasks;
```

Verify the dependent slice against its base and run the combined check on the final revision. On restart, inspect the named branch and the saved child's state before retrying. Independent slices can run together instead.
