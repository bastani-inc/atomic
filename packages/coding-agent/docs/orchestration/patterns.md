---
title: "Orchestration patterns"
description: "Seven ways to split work, keep track of the children, and verify what they produced."
---

# Orchestration patterns

Give each subagent one concrete deliverable, explicit inputs, clear edit rules, and a verification check. Put conflicting edits in separate worktrees, and run final verification in the parent. A child claiming "done" is not proof.

Each snippet below is a short codemode call from the parent chat, not a long-lived script. After any restart, reconcile `status` with [saved receipts](/orchestration#what-survives-interruption) before launching more children.

## Prompt anatomy

Make every child assignment self-contained so it does not rely on the parent's full history:

- **Objective and why it matters.** Name the decision or change that depends on the output.
- **Inputs and permissions.** List the exact files or paths to read, what may be edited, and what is out of scope.
- **Deliverable.** Specify the expected verdict with `file:line` citations, output file path, or tested commit.

Example prompt:

> Check the Windows install instructions in `docs/install.md` against the CLI flags in this checkout. Report each discrepancy as a command, its documented behavior, and the behavior you observed. Return "no discrepancies" if all commands agree. Do not edit files or install software.

### Done criteria

Specify observable outcomes rather than effort:

- For fixes, name the changed behavior, adjacent behavior that must remain unchanged, and checks proving both.
- For reviews, distinguish "checked and found nothing" from "could not verify." Re-run key checks in the parent before acting on results. See [Verification and evidence](/verification).

### Stop conditions

Define upfront when to halt, such as an attempt cap, a missing prerequisite, contradictory inputs, or actions that need user approval like API breaks, data migrations, or publishing. On a failed check within scope, pass the exact observed failure to the next attempt rather than broadening the prompt.

## Design checklist

- **Fit.** Check whether one direct command answers the question faster than delegation.
- **Isolation.** Give each writer a distinct worktree or disjoint files, and launch dependent tasks only after prerequisites pass.
- **Handoffs.** Pass file paths and output schemas rather than raw transcripts.
- **Recovery.** Store child IDs, target commits, and next checks so restarts reconcile before re-running side effects.
- **Approval.** Keep permission to publish or merge separate from permission to implement.

## Classify-and-act

Triage input with a read-only child, validate the returned label in the parent, then dispatch the right specialist:

```js
const { label, report } = load("triage");
if (!["bug", "docs"].includes(label)) return "Clarify the report before dispatch.";
const r = await tools.subagent({ agent: label === "bug" ? "debugger" : "worker", task: report });
store("triage:action", r.tasks);
return r.tasks;
```

On recovery, check `status` for an existing action child before launching another, and verify the fix against the original report.

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

Synthesize only after every required child settles, and reconcile contradictions against source code. On restart, recover results by task ID instead of repeating the whole batch.

## Adversarial verification

Give a fresh read-only child the acceptance criteria and candidate, without the author's conclusion, and ask for a failing input:

```js
const r = await tools.subagent({
  agent: "codebase-analyzer",
  context: "fresh",
  task: "Find a failing input for the proposed date formatter in src/date.ts. Give the input and expected output; don't edit.",
});
store("date:review", r.tasks);
return r.tasks;
```

Verify reported failures in the parent by checking real exit codes before requesting repairs. With multiple reviewers, collect independent verdicts first, then allow one bounded Intercom debate. A reproducible failing case beats a majority vote. For user interfaces, [exercise the real interface](/computer-use).

## Generate-and-filter

Ask children for concrete candidates, then filter all of them with one deterministic check in codemode:

```js
const r = await tools.subagent({
  tasks: ["year boundary", "leap day"].map((topic) => ({
    agent: "worker",
    task: `Return three distinct dates around a ${topic} as a JSON string array. Don't edit files.`,
  })),
});
store("dates:generators", r.tasks);
return r.tasks;
```

Parse each result as data, drop malformed or duplicate entries, and keep only values passing the real check. Returning "none passed" is valid.

## Tournament

Compare competing approaches on identical fixtures with pre-agreed scoring and tie-breaking rules, and isolate edits in named worktrees:

```js
const r = await tools.subagent({
  tasks: ["lookup-table", "parser"].map((strategy) => ({
    agent: "worker",
    task: `Implement the ${strategy} approach on your own branch; return the commit and test command.`,
    worktree: { branch: `compare/${strategy}` },
  })),
});
store("candidates:round1", r.tasks);
return r.tasks;
```

Record scores, commit SHAs, and round numbers so restarts never double-advance a candidate. Never pick a winner that fails a required check.

## Loop-until-done

Run the project's verification command in the parent between bounded repair rounds:

```js
const check = await tools.bash({ command: "npm test" });
if (check.exit_code === 0) return "Passed";
const round = load("repair:round") ?? 0;
if (round >= 3) return "Still failing after three repair attempts.";
const r = await tools.subagent({
  agent: "debugger",
  task: `Repair the test failure; don't suppress the test.\n${check.output.slice(-2000)}`,
});
store("repair:round", round + 1);
store("repair:last", r.tasks);
return r.tasks;
```

Run only after the previous child settles, and stop on refusal, missing prerequisites, or approval gates. On restart, inspect the checkout and rerun the check before spending another round.

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

Verify each slice against its base and run full integration checks at the tip. Run independent slices in parallel instead.
