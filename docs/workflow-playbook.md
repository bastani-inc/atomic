# Workflow Playbook

This is the playbook I use to get consistently better results from coding agents and workflow systems.

The core idea is simple: do not treat an agent like a magic box. Treat it like a capable engineering partner that needs a clear objective, tight scope, explicit validation, and occasional steering.

Most weak agent runs fail for predictable reasons: the goal is vague, the scope is too broad, validation is missing, or the agent keeps following the wrong signal. This playbook is about avoiding those failure modes.

The examples below are synthetic and intentionally generic. Replace placeholders like `[component]`, `[test command]`, and `[workflow]` with your own project details.

---

## The core loop

The workflow pattern I rely on most often is:

```text
Objective -> Scope -> Done criteria -> Run -> Inspect -> Steer -> Validate -> Summarize
```

In practice, that means:

1. Define the end state.
2. Constrain the blast radius.
3. State what counts as done.
4. Let the agent or workflow work.
5. Inspect status before reading details.
6. Steer only when the run is off track, blocked, or missing criteria.
7. Require evidence before accepting the result.
8. Ask for a summary, handoff, or next-step plan.

A good workflow prompt does not just say what to try. It says what success looks like. Default to a workflow for non-trivial work or a request with inherent structure plus a verifiable objective: implementation, debugging, migrations, multi-file changes, validation, review gates, evidence requirements, and loop/stop-condition prompts all benefit from tracked execution. Use direct chat for tiny deterministic low-risk work. Do not force-fit a builtin—Atomic can author a custom TypeScript workflow inline and compose classify-and-act, fan-out-and-synthesize, adversarial verification, generate-and-filter, tournament, and loop-until-done patterns.

---

## Prompt anatomy

A strong workflow prompt usually has these parts:

### Objective

What should be true when the work is complete?

```text
Implement `[specific behavior]` in `[component]`.
```

### Context

What does the agent need to know before acting?

```text
This is needed because `[reason]`. The relevant code likely lives near `[area]`.
```

### Scope

What is the agent allowed to change?

```text
Only touch files directly required for `[behavior]`.
```

### Non-goals

What should the agent avoid?

```text
Do not redesign `[subsystem]`, refactor unrelated code, or change public behavior outside `[case]`.
```

### Done criteria

How will we know the work is complete?

```text
Done means:
- `[new behavior]` works.
- `[existing behavior]` is unchanged.
- `[test command]` passes.
- The final response includes changed files, validation results, and remaining risks.
```

### Stop conditions

When should the agent stop and ask instead of guessing?

```text
If this requires changing `[public API/security behavior/data migration]`, stop and ask first.
```

---

## Core principles

### 1. Start with the end state

I try to describe what should be true at the end, not just what the agent should investigate.

Bad:

```text
Look into the login issue.
```

Better:

```text
Fix the login redirect regression. Done means users who sign in from `[page]` return to `[expected destination]`, and `[test command]` passes.
```

### 2. Keep scope tight

Agents are often tempted to clean up nearby code. Sometimes that is useful, but most workflow runs should be bounded.

Use phrases like:

- `Only touch files required for this behavior.`
- `Do not refactor unrelated code.`
- `Preserve existing behavior for [case].`
- `Make the smallest correct change.`

### 3. Separate implementation from validation

A change is not done because the agent says it is done. It is done when the relevant evidence supports it.

That evidence can be:

- a targeted test,
- a broader regression test,
- a smoke command,
- a typecheck or lint command,
- a structured output contract check,
- or a clear manual verification step.

### 4. Prefer evidence over speculation

When something fails, I steer the agent back to the observable signal: the error, failing test, log line, user behavior, or broken contract.

```text
Treat the failing assertion as the source of truth. Do not guess from nearby code alone.
```

### 5. Use staged thinking

For ambiguous work, I usually separate the flow into stages:

```text
Investigate -> identify root cause -> propose fix -> implement -> validate -> summarize
```

If the cause is not clear, I do not want the agent making broad changes just to see what happens.

### 6. Steer, do not micromanage

The best steering messages are short and corrective. They add constraints, redirect attention, or provide a decision.

You usually do not need to rewrite the whole prompt. You need to say what changed.

### 7. Treat failed validation as the next task

A failed test is not a footnote. It becomes the next objective.

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

### 8. Interrupt stale or wrong work

If a run is solving the wrong problem, based on outdated assumptions, or duplicating another run, stop it. Letting it continue usually creates more cleanup later.

### 9. Inspect at the right level

For long-running workflows, I do not start by reading every log. I check:

1. overall status,
2. current stage,
3. blocker or failure reason,
4. relevant stage details only if needed.

### 10. Ask for synthesis before handoff

Before switching from investigation to implementation, or from implementation to review, I often ask for a concise synthesis:

```text
Summarize root cause, proposed fix, files involved, validation plan, and remaining risks.
```

---

## Common workflow patterns

### Scoped implementation sprint

**Use when:** You have a clear feature, bug fix, or issue to delegate.

**Prompt shape:**

```text
Implement `[feature]` in `[component]`. Only touch files directly needed for this behavior. Done means the new behavior works, existing behavior is unchanged, and `[test command]` passes.
```

**Why it works:** The agent gets autonomy, but the objective and blast radius are bounded.

**Validation:** Run the most relevant targeted check first, then a broader nearby check if the change is risky.

---

### Regression repair loop

**Use when:** CI, tests, typecheck, lint, or smoke validation fails.

**Prompt shape:**

```text
Fix the failing `[test suite]` regression. Treat the failure output as the source of truth. Do not refactor unrelated code. Done means the failing test passes and no nearby tests regress.
```

**Why it works:** It anchors the run to observable evidence instead of speculation.

**Validation:** Reproduce the failure, fix the root cause, rerun the failing check, then run a nearby or broader check.

---

### Workflow or tooling smoke test

**Use when:** You changed a workflow definition, prompt contract, structured output, CLI behavior, or developer tool.

**Prompt shape:**

```text
Validate `[workflow/tool]` after the change. Run a minimal smoke case, confirm required outputs are present, and report whether it can be invoked with expected inputs.
```

**Why it works:** Workflow and tooling changes often fail at integration boundaries. A small smoke case catches those failures early.

**Validation:** Reload or rerun the tool, check the output shape, and report contract mismatches.

---

### Human-in-the-loop checkpoint

**Use when:** The workflow might need a product decision, API decision, migration choice, or risky approval.

**Prompt shape:**

```text
If blocked, ask before changing public API behavior. Otherwise proceed with the smallest compatible fix.
```

**Why it works:** The agent keeps moving where it can, but does not guess on high-impact decisions.

**Validation:** Confirm the decision is reflected in the final behavior and summary.

---

### Release gate

**Use when:** Preparing a release, version bump, changelog, publish step, migration, or deployment-adjacent task.

**Prompt shape:**

```text
Prepare a `[release kind]` release for `[version]`. Do not publish unless validation passes. Report the exact checks performed and any unresolved blockers.
```

**Why it works:** Release work needs explicit gates and stop conditions.

**Validation:** Require changelog review, tests, build/package checks, and a clear publish/no-publish decision.

---

### Monitor-and-steer long run

**Use when:** A workflow runs asynchronously, has multiple stages, or may need supervision.

**Prompt shape:**

```text
Show the current stage and blocker. If implementation is complete, summarize validation status and remaining risks.
```

**Why it works:** It avoids both blind trust and excessive log-reading.

**Validation:** Inspect status first, then stages, then only the relevant details.

---

### Investigate before implementing

**Use when:** A bug or request is ambiguous.

**Prompt shape:**

```text
Investigate `[bug]`, identify root cause, and propose the smallest fix. Do not implement until the cause is clear.
```

**Why it works:** It prevents the agent from making changes before it understands the failure mode.

**Validation:** Ask for a reproduction, root-cause explanation, proposed fix, and test plan before implementation.

---

## Steering patterns

### Tighten scope

**Signal:** The agent starts expanding into adjacent cleanup, unrelated files, or broad refactors.

**Steer:**

```text
Narrow this to `[specific behavior]` in `[component]`. Do not refactor unrelated code or change `[adjacent area]`. Done means `[specific acceptance criteria]`.
```

**Why:** Prevents risky changes and keeps the run reviewable.

---

### Add missing done criteria

**Signal:** The agent has a plan, but no clear finish line.

**Steer:**

```text
Use these done criteria:
1. `[behavior]` works.
2. `[regression]` remains unchanged.
3. `[test command]` passes.
4. Report files changed and validation results.
```

**Why:** Makes completion verifiable.

---

### Redirect an off-track stage

**Signal:** The workflow is investigating the wrong area or solving the wrong problem.

**Steer:**

```text
Stop pursuing `[wrong direction]`. The relevant signal is `[error/test/user behavior]`. Re-focus on `[target area]` and continue from there.
```

**Why:** Saves time and prevents wrong assumptions from compounding.

---

### Respond to a blocked prompt

**Signal:** The workflow asks for approval, a choice, or clarification.

**Steer:**

```text
Choose `[option]`. Continue only if `[condition]`; otherwise stop and report the blocker.
```

**Why:** Keeps the workflow unblocked without adding ambiguity.

---

### Turn failed validation into the next task

**Signal:** Tests, typecheck, lint, build, or smoke checks fail.

**Steer:**

```text
Validation failed on `[command]`. Treat that as the source of truth. Fix the root cause only, rerun the failing check, then report the result.
```

**Why:** Prevents accepting partially working output.

---

### Ask for synthesis

**Signal:** The workflow has gathered information, but the next action is unclear.

**Steer:**

```text
Synthesize the current findings into: root cause, proposed fix, files likely involved, validation plan, and remaining risks.
```

**Why:** Converts exploration into a usable plan.

---

### Pause, kill, or rerun

**Signal:** A run is stale, duplicated, superseded, or based on outdated assumptions.

**Steer:**

```text
Pause this run; it has been superseded by `[new context]`. Resume only with `[updated objective]`, or stop and summarize current state.
```

**Why:** Avoids conflicting changes and wasted work.

---

## Copy-paste templates

### Start a workflow

```text
Objective:
Implement/fix `[specific behavior]` in `[component]`.

Context:
`[short context about why this matters or where to look]`

Scope:
- Only touch files required for `[behavior]`.
- Do not refactor unrelated code.
- Preserve existing behavior for `[existing case]`.

Done criteria:
- `[new behavior]` works.
- `[regression case]` still works.
- `[test command]` passes.
- Report changed files, validation results, and any risks.

Stop conditions:
- If this requires `[risky decision]`, stop and ask first.
```

### Tighten scope

```text
Tighten scope to `[specific target]`.

Do not work on:
- `[excluded area 1]`
- `[excluded area 2]`
- broad cleanup or unrelated refactors

Continue only on the path needed to satisfy:
`[acceptance criterion]`.
```

### Add acceptance criteria

```text
Add these acceptance criteria before continuing:

1. User can `[action]`.
2. System handles `[edge case]`.
3. Existing behavior `[existing behavior]` is unchanged.
4. `[test command]` passes.
5. Final response includes validation evidence.
```

### Redirect a stage

```text
This stage is off track.

Stop investigating `[wrong area]`.
The relevant signal is `[error/output/requirement]`.
Refocus on `[correct area]`.

Next:
1. Reproduce or inspect `[signal]`.
2. Identify root cause.
3. Make the smallest fix.
4. Run `[validation command]`.
```

### Handle failed validation

```text
Validation failed:

Command:
`[command]`

Failure:
`[short sanitized failure summary]`

Treat this as the source of truth.
Fix only the root cause.
Rerun the failing command.
If it still fails, summarize the blocker and stop.
```

### Ask for synthesis

```text
Synthesize current progress into:

- What was attempted
- What changed
- What evidence supports the result
- What remains uncertain
- Recommended next steps
- Exact validation commands run
```

### Turn findings into implementation steps

```text
Convert the findings into an implementation plan:

1. Files/components to change
2. Order of changes
3. Tests to add or update
4. Validation commands
5. Risks or edge cases
6. Stop conditions
```

### Prepare a release gate

```text
Prepare `[version]` as a `[release kind]` release.

Requirements:
- Verify changelog entries are complete.
- Run `[test command]`.
- Run `[build/package command]`.
- Do not publish unless all validation passes.
- If any gate fails, stop and report blockers.

Final response should include:
- Version
- Checks run
- Results
- Files changed
- Publish readiness
```

---

## Concrete examples

### Example 1: Fixing a failing test

**Scenario:** A package has one failing unit test after a recent change.

**Initial objective:**

```text
Fix the failing `[unit test]`. Do not rewrite the module. Done means the test passes and nearby tests still pass.
```

**Steering message:**

```text
Stop exploring unrelated failures. Focus only on the assertion mismatch in `[test file]`.
```

**Validation:** Run `[targeted test command]`, then `[nearby test command]`.

**Outcome:** Small fix applied, regression test passes, and the workflow reports exact commands and results.

---

### Example 2: Repairing a workflow definition

**Scenario:** A custom workflow no longer returns the expected structured output.

**Initial objective:**

```text
Validate `[workflow]` and fix its output contract. Done means the smoke run returns `[required fields]`.
```

**Steering message:**

```text
Treat the missing output field as the root issue. Do not change unrelated stage prompts.
```

**Validation:** Reload workflow, run minimal smoke input, inspect structured result.

**Outcome:** Contract fixed, smoke test passes, and the workflow can be reused safely.

---

### Example 3: Investigating before implementing

**Scenario:** A user-reported bug is ambiguous.

**Initial objective:**

```text
Investigate `[bug]`, identify root cause, and propose the smallest fix. Do not implement until the cause is clear.
```

**Steering message:**

```text
Synthesize findings first: root cause, affected path, proposed fix, and validation plan.
```

**Validation:** Add or run a reproduction test before changing code.

**Outcome:** Clear implementation plan produced, then delegated as a scoped fix.

---

## Anti-patterns

| Anti-pattern | Better approach |
| --- | --- |
| `Fix this.` | `Fix [specific failure]; done means [test command] passes.` |
| No validation step | Require tests, smoke checks, typecheck, or explicit manual verification. |
| Broad refactors | Constrain the run to the files needed for the objective. |
| Letting a wrong stage continue | Redirect or interrupt as soon as the agent follows the wrong signal. |
| Accepting unverified summaries | Ask for changed files, commands run, results, and remaining risks. |
| Mixing investigation and implementation too early | Ask for root cause and proposed fix before code changes. |
| Ignoring blocked stages | Answer directly with one decision and any constraints. |
| Continuing stale runs | Pause, kill, or rerun with updated context. |
| Reading every log | Inspect status, then stages, then only relevant details. |
| Publishing without gates | Require release validation and explicit stop conditions. |

---

## Quick reference

Before starting a workflow, include:

- [ ] Objective
- [ ] Context
- [ ] Scope
- [ ] Non-goals
- [ ] Done criteria
- [ ] Validation command
- [ ] Reporting requirements
- [ ] Stop conditions

Before accepting a workflow result, ask:

- [ ] What changed?
- [ ] Why was this the right fix?
- [ ] What evidence supports it?
- [ ] Which commands were run?
- [ ] What still might be risky?
- [ ] Is anything blocked or unresolved?

The better the prompt defines the game, the better the agent can play it.
