---
title: "Orchestration patterns"
sidebarTitle: "Patterns"
description: "Seven reusable patterns for splitting work across subagents, isolating edits, and verifying results."
---

Give each subagent one concrete deliverable, explicit inputs, clear edit rules, and a verification check. Put conflicting edits in separate worktrees, and run final verification in your main session. A subagent claiming "done" is not proof.

Each snippet below is a short [codemode](/codemode) call from the main chat, not a long-lived script. After any restart, reconcile `status` with [saved task IDs](/orchestration#what-survives-interruption) persisted via [the codemode store](/codemode#store-values) before launching more subagents. For background and mechanics behind these patterns, see [Orchestrate with codemode and subagents](/orchestration), [Run subagents](/subagents), and [Manage background tasks](/background-tasks).

## Prompt anatomy

Make every subagent assignment self-contained so it does not rely on the main chat's full history:

- **Objective and why it matters.** Name the decision or change that depends on the output.
- **Inputs and permissions.** List the exact files or paths to read, what may be edited, and what is out of scope.
- **Deliverable.** Specify the expected verdict with `file:line` citations, output file path, or tested commit.

Example prompt:

> Check the Windows install instructions in `docs/install.md` against the CLI flags in this checkout. Report each discrepancy as a command, its documented behavior, and the behavior you observed. Return "no discrepancies" if all commands agree. Do not edit files or install software.

### Done criteria

Specify observable outcomes rather than effort:

- For fixes, name the changed behavior, adjacent behavior that must remain unchanged, and checks proving both.
- For reviews, distinguish "checked and found nothing" from "could not verify." Re-run key checks in your main session before acting on results. See [Verification and evidence](/verification).

### Stop conditions

Define upfront when to halt, such as an attempt cap, a missing prerequisite, contradictory inputs, or actions that need user approval like API breaks, data migrations, or publishing. On a failed check within scope, pass the exact observed failure to the next attempt rather than broadening the prompt.

## Design checklist

- **Fit.** Check whether one direct command answers the question faster than delegation.
- **Isolation.** Give each writer a distinct worktree or disjoint files, and launch dependent tasks only after prerequisites pass.
- **Handoffs.** Pass file paths and output schemas rather than raw transcripts.
- **Recovery.** Store subagent IDs, target commits, and next checks so restarts reconcile before re-running side effects.
- **Approval.** Keep permission to publish or merge separate from permission to implement.

## Classify-and-act

Triage input with a read-only subagent, validate the returned label in the main session, then dispatch the right specialist:

```js
const { label, report } = load("triage");
if (!["bug", "docs"].includes(label)) return "Clarify the report before dispatch.";
const r = await tools.subagent({ agent: label === "bug" ? "debugger" : "worker", task: report });
store("triage:action", r.tasks);
return r.tasks;
```

On recovery, check `status` for an existing action subagent before launching another, and verify the fix against the original report.

## Fan-out-and-synthesize

Split a broad review into one parallel batch so related results stay grouped:

```js
const r = await tools.subagent({
  group: true,
  tasks: ["Linux", "Windows"].map((platform) => ({
    agent: "codebase-analyzer",
    task: `Check ${platform} installation commands. Return evidence; don't edit.`,
  })),
});
store("platforms", r.tasks);
return r.tasks;
```

Synthesize only after every required subagent settles, and reconcile contradictions against source code. On restart, recover results by task ID instead of repeating the whole batch.

## Adversarial verification

Give a [fresh](/subagents#fresh-vs-forked-context) read-only subagent the acceptance criteria and candidate, without the author's conclusion, and ask for a failing input:

```js
const r = await tools.subagent({
  agent: "codebase-analyzer",
  context: "fresh",
  task: "Find a failing input for the proposed date formatter in src/date.ts. Give the input and expected output; don't edit.",
});
store("date:review", r.tasks);
return r.tasks;
```

Verify reported failures in the main session by checking real exit codes before requesting repairs. With multiple reviewers, collect independent verdicts first, then allow one bounded [Intercom](/intercom) debate. A reproducible failing case beats a majority vote. For user interfaces, [exercise the real interface](/computer-use).

## Generate-and-filter

Ask subagents for concrete candidates, then filter all of them with one deterministic check in codemode. Pass `context: "fresh"` (or use a read-only agent) so generators do not inherit the main chat's history (`worker` defaults to [forked context](/subagents#fresh-vs-forked-context) and edit tools):

```js
const r = await tools.subagent({
  context: "fresh",
  tasks: ["year boundary", "leap day"].map((topic) => ({
    agent: "codebase-analyzer",
    task: `Return three distinct dates around a ${topic} as a JSON string array. Don't edit files.`,
  })),
});
store("dates:generators", r.tasks);
return r.tasks;
```

Parse each result as data, drop malformed or duplicate entries, and keep only values passing the real check. Returning "none passed" is valid.

## Tournament

Compare competing approaches on identical fixtures with pre-agreed scoring and tie-breaking rules, and isolate edits in [named worktrees](/subagents#named-worktrees):

```js
const r = await tools.subagent({
  context: "fresh",
  tasks: ["lookup-table", "parser"].map((strategy) => ({
    agent: "worker",
    task: `Implement the ${strategy} approach on your own branch; return the commit and test command.`,
    worktree: { branch: `compare/${strategy}` },
  })),
});
store("candidates:round1", r.tasks);
return r.tasks;
```

Note two details when running `worker` in named worktrees:

- `worker` defaults to `context: "fork"`, so pass `context: "fresh"` when you want independent attempts without the main chat's prior reasoning ([Fresh vs. forked context](/subagents#fresh-vs-forked-context)).
- Named worktrees (`worktree: { branch }`) are never deleted automatically and do not symlink `node_modules`. Have each competitor install dependencies if its test command needs them, or remove finished branches and worktrees manually when the tournament ends.

Record scores, commit SHAs, and round numbers so restarts never double-advance a candidate. Never pick a winner that fails a required check.

## Loop-until-done

Run the project's verification command in the main session between bounded repair rounds. Pass a foreground `wait` budget suited to your test suite, and handle the string return value in case the command yields to a [background shell](/background-tasks#background-shells):

```js
const check = await tools.bash({
  command: "npm test",
  wait: { kind: "foreground", budgetMs: 60000 },
});
if (typeof check === "string") {
  return `Test suite is still running in the background. Wait for completion before repairing.\n${check}`;
}
if (check.exit_code === 0) return "Passed";
const round = load("repair:round") ?? 0;
if (round >= 3) return "Still failing after three repair attempts.";
const output = typeof check.output === "string" ? check.output.slice(-2000) : "";
const r = await tools.subagent({
  agent: "debugger",
  task: `Repair the test failure; don't suppress the test.\n${output}`,
});
store("repair:round", round + 1);
store("repair:last", r.tasks);
return r.tasks;
```

When `bash` exceeds its foreground observation budget (10 seconds by default), it yields to the background and returns a plain status string instead of structured output. Passing a larger `budgetMs` and checking `typeof check === "string"` avoids crashing on slower test suites.

Run a new repair round only after the previous subagent settles, and stop on refusal, missing prerequisites, or approval gates. On restart, inspect the checkout and rerun the check before spending another round.

## Stacked slices

Start each dependent slice from the exact verified commit of the previous slice:

```js
const apiCommit = load("verified-api-commit");
if (!apiCommit) return "Verify the API slice and record its commit first.";
const r = await tools.subagent({
  agent: "worker",
  worktree: { branch: "feature/cli", base: apiCommit },
  task: `Wire the CLI to the API at ${apiCommit}. Add a CLI test, run it, and return the commit.`,
});
store("cli-slice", r.tasks);
return r.tasks;
```

Because `worker` defaults to `context: "fork"`, each slice sees the main chat's verified decisions unless you pass `context: "fresh"` ([Fresh vs. forked context](/subagents#fresh-vs-forked-context)). [Named worktrees](/subagents#named-worktrees) keep their branches and do not symlink `node_modules`. Verify each slice against its base and run full integration checks at the tip. Run independent slices in parallel instead.
