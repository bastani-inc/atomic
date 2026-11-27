---
title: "Orchestration patterns"
sidebarTitle: "Orchestration patterns"
description: "Seven reusable patterns for splitting work across subagents, isolating edits, and verifying results."
---

Give each subagent one concrete deliverable, explicit inputs, clear edit rules, and a verification check. Put conflicting edits in separate worktrees, and run final verification in your main session — a subagent claiming "done" is not proof.

## Choose a pattern

| Pattern | Use when | Isolation | Key check |
| --- | --- | --- | --- |
| [Classify-and-act](#classify-and-act) | Incoming work needs triage before choosing a specialist | Fresh read-only triage, then specialist | Validate the returned label in the main session before dispatch |
| [Fan-out-and-synthesize](#fan-out-and-synthesize) | Independent angles or platforms can be investigated in parallel | Parallel batch (`group: true` for peers) | Wait for every required subagent and reconcile contradictions against code |
| [Adversarial verification](#adversarial-verification) | You want an unbiased attempt to break a candidate fix | `context: "fresh"`, read-only | Reproduce reported failing inputs in the main session with real exit codes |
| [Generate-and-filter](#generate-and-filter) | Multiple candidate edge cases or options need objective filtering | `context: "fresh"`, read-only | Run every parsed candidate through one deterministic check in codemode |
| [Tournament](#tournament) | Two or more implementation strategies compete on shared fixtures | `context: "fresh"` + separate named worktrees | Compare scores on identical fixtures; never pick a candidate failing checks |
| [Loop-until-done](#loop-until-done) | A failing test suite needs bounded diagnose-and-repair rounds | Main-session test runs + `debugger` rounds | Cap rounds explicitly and re-run the real suite after each fix |
| [Stacked slices](#stacked-slices) | Dependent implementation stages build strictly on prior commits | Named worktree branching from prior commit SHA | Verify each slice against its base and run integration checks at the tip |

Each snippet below is a short [codemode](/codemode) call from the main chat, not a long-lived script. After any restart, reconcile `status` with [saved task IDs](/orchestration#what-survives-interruption) persisted via [the codemode store](/codemode#store-values) before launching more subagents.

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

Ask fresh read-only subagents to inspect the implementation and propose concrete candidate cases, then filter every candidate with one deterministic check in codemode:

```js
const r = await tools.subagent({
  context: "fresh",
  tasks: ["year-boundary", "leap-day"].map((category) => ({
    agent: "codebase-analyzer",
    task: `Inspect src/date.ts for ${category} edge cases. Return a JSON array of up to three { input, expected, line } test cases targeting risky branches. Don't edit files.`,
  })),
});
store("date:candidates", r.tasks);
return r.tasks;
```

Parse each returned result as data, drop malformed or duplicate entries, and run the real formatter or test harness in your main session to keep only candidates that reproduce a real discrepancy or gap. Returning "none passed" is valid.

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

<Tip>
`worker` defaults to `context: "fork"`, so pass `context: "fresh"` when you want independent attempts without the main chat's prior reasoning ([Fresh vs. forked context](/subagents#fresh-vs-forked-context)). Named worktrees (`worktree: { branch }`) are permanent and do not symlink `node_modules` — have competitors install dependencies if needed and remove unused branches/worktrees when the tournament ends.
</Tip>

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

When `bash` exceeds its foreground observation budget (10 seconds by default), it yields to the background and returns a plain status string instead of structured output. Passing a larger `budgetMs` and checking `typeof check === "string"` avoids crashing on slower suites.

Start a new repair round only after the previous subagent settles, and stop on refusal, missing prerequisites, or approval gates. On restart, inspect the checkout and re-run the check before spending another round.

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

Because `worker` defaults to `context: "fork"`, each slice sees the main chat's verified decisions unless you pass `context: "fresh"`. Verify each slice against its base and run full integration checks at the tip; run independent slices in parallel instead.

## Before you delegate

Keep every subagent prompt self-contained so it does not rely on unspoken context:

- **Objective and deliverable.** Name the decision or change that depends on the output, exact files to inspect, edit boundaries, and expected output shape (`file:line` citations, output file, or verified commit).
- **Done criteria.** Name observable outcomes and proof checks rather than effort. Distinguish "checked and found nothing" from "could not verify," and re-run key checks in your main session ([Verification and evidence](/verification)).
- **Stop conditions.** Set attempt caps, missing-prerequisite halts, and user-approval gates (API breaks, migrations, publishing) upfront. On a failed check, pass the exact observed failure to the next attempt rather than broadening scope.
- **Fit and isolation.** Confirm a single direct command wouldn't be faster; give writers distinct worktrees or disjoint files; pass file paths rather than raw transcripts; store task IDs and commit SHAs so restarts reconcile before repeating side effects.

Example self-contained prompt:

```text
Check the Windows install instructions in docs/install.md against the CLI flags in this checkout. Report each discrepancy as a command, its documented behavior, and the behavior you observed. Return "no discrepancies" if all commands agree. Do not edit files or install software.
```
