# Atomic Workflows Ralph `create_pr` Flag Technical Design Document / RFC

| Document Metadata      | Details                              |
| ---------------------- | ------------------------------------ |
| Author(s)              | Alex Lavaee                          |
| Status                 | Draft (WIP)                          |
| Team / Owner           | Atomic Workflows / Ralph maintainers |
| Created / Last Updated | 2026-06-05 / 2026-06-05              |

## 1. Executive Summary

Implement GitHub issue #1255 by making Ralph’s GitHub pull-request creation opt-in through a `create_pr` boolean workflow input. The option must default to `false`, and Ralph must only run the final `pull-request` stage when `create_pr === true`.

Iteration 1 already added the schema/type/docs/test surface and a final-stage gate in this worktree, but the latest review artifact (`/var/folders/cr/lt2lnmhd0g7c3g_62423frp80000gn/T/atomic-ralph-run-zpXEMH/review-round-1.json`) found one unresolved safety gap: earlier Ralph stages still receive the raw user prompt before the final PR gate. If a prompt says “implement X and create a pull request” while `create_pr` is omitted or false, the planner/orchestrator/simplifier/reviewer prompts do not currently tell workers that PR creation is out of scope.

This RFC therefore extends the design beyond final-stage gating: Ralph should thread an explicit pull-request execution policy through every pre-PR stage. When `create_pr` is omitted or false, planner, orchestrator, simplifier, reviewer, and delegated-worker instructions must state that PR creation/update/commenting, PR credential checks, and branch pushes solely for PR handoff are not allowed, even if the raw prompt asks for them. When `create_pr=true`, earlier stages should still reserve PR creation for the final `pull-request` stage so that PR side effects remain centralized and testable.

## 2. Context and Motivation

### 2.1 Current State

Repository investigation for this RFC inspected the current worktree at `/Users/tonystark/Documents/projects/atomic-issue-1255-create-pr-flag`, compared against `origin/main`, and reviewed Ralph implementation, declarations, docs, tests, changelogs, and prior Ralph design material.

Current worktree evidence:

- `packages/workflows/builtin/ralph.ts:388-393` defines `RalphInputs` with optional `create_pr`.
- `packages/workflows/builtin/ralph.ts:396-401` normalizes runtime options into `createPr`.
- `packages/workflows/builtin/ralph.ts:416-425` defines `SKIPPED_PULL_REQUEST_REPORT`.
- `packages/workflows/builtin/ralph.ts:1011-1083` gates the final `ctx.task("pull-request", ...)` with `if (createPr === true)`.
- `packages/workflows/builtin/ralph.ts:1116-1119` declares `.input("create_pr", Type.Boolean({ default: false, ... }))`.
- `packages/workflows/builtin/ralph.ts:1144` uses strict true semantics: `const createPr = inputs.create_pr === true`.
- `packages/workflows/builtin/ralph.d.ts` and `packages/workflows/builtin/index.d.ts` expose `create_pr` in `RalphWorkflowInputs` and `RalphWorkflowRunInputs`.
- `test/unit/builtin-workflows.test.ts:2045-2086` verifies the input schema/default.
- `test/unit/builtin-workflows.test.ts:2119-2186` verifies omitted/false/true final-stage gating.
- `test/integration/workflow-package-typing.test.ts:253-279` verifies public typing accepts boolean `create_pr` and rejects `"true"`.
- Docs currently mention the safe default in:
  - `packages/coding-agent/docs/workflows.md:245-277`
  - `packages/coding-agent/docs/quickstart.md:76-97`
  - `packages/workflows/README.md:588-605`
- Changelog entries exist in:
  - `packages/workflows/CHANGELOG.md:7-11`
  - `packages/coding-agent/CHANGELOG.md:3-7`

Generic workflow defaulting/validation already supports this input style:

- `packages/workflows/src/runs/foreground/executor.ts:207-226` applies TypeBox defaults via `Value.Default(...)`.
- `packages/workflows/src/runs/shared/validate-inputs.ts:56-75` rejects non-boolean values for boolean inputs.
- `packages/workflows/src/shared/schema-introspection.ts:91-99` treats defaulted inputs as optional to callers.
- `test/unit/executor-phase-c.test.ts:39-42` verifies explicit `false` is preserved and not overwritten by defaults.

The remaining unsafe behavior is in pre-PR prompt propagation:

- `packages/workflows/builtin/ralph.ts:510-512` passes the raw prompt into the planner task.
- `packages/workflows/builtin/ralph.ts:611-612` passes the raw prompt into the orchestrator objective.
- `packages/workflows/builtin/ralph.ts:637-645` tells the orchestrator to spawn subagents, but does not currently include a PR-disabled delegation policy.
- `packages/workflows/builtin/ralph.ts:713-714` passes the raw prompt into the simplifier objective.
- `packages/workflows/builtin/ralph.ts:818` passes the raw prompt into the reviewer objective.
- `packages/workflows/builtin/ralph.ts:953-978` passes `{ task: prompt, failFast: false }` to `ctx.parallel`.

Prior Ralph design material supports a prompt-chained, stage-based architecture where policy must be made explicit per stage:

- `specs/2026-03-23-ralph-workflow-redesign.md` describes Ralph as a `PLANNER → ORCHESTRATOR → REVIEWER` prompt-chained workflow.
- `research/docs/2026-03-20-ralph-workflow-redesign-analysis.md` records the historical shift toward stage prompts and native sub-agent delegation.
- `specs/2026-03-23-ralph-review-debug-loop-termination.md` and `research/docs/2026-03-22-ralph-review-debug-loop-termination.md` document review-loop safety as an explicit workflow contract.

### 2.2 The Problem

The final-stage gate is necessary but not sufficient. The latest review round raised the same unresolved issue twice:

- Reviewer A: `[P1] Thread the PR-disabled policy into worker stages`
- Reviewer B: `[P2] Block PR requests before worker stages run`

Both findings point to `packages/workflows/builtin/ralph.ts:1011` and explain that suppressing only the final `pull-request` task still allows earlier workers to interpret raw prompt text such as “create a PR” before the gate is reached.

This violates the safe-default requirement. With `create_pr` omitted or false:

- Ralph must not start the final `pull-request` stage.
- Ralph must not instruct planner/orchestrator/simplifier/reviewer stages to create or prepare a PR.
- Ralph must not let delegated workers infer that PR creation is still part of the task.
- Ralph’s `pr_report` must not claim no PR was attempted while earlier prompts made PR attempts possible.

## 3. Goals and Non-Goals

### 3.1 Functional Goals

1. Expose `create_pr` in Ralph workflow inputs.
   - Type: boolean.
   - Default: `false`.
   - Name: snake_case to match `max_loops`, `base_branch`, and `git_worktree_dir`.

2. Preserve strict true gating for the final PR stage.
   - `create_pr === true` runs `ctx.task("pull-request", ...)`.
   - Omitted, `false`, or invalid non-boolean values do not run that stage.

3. Thread pull-request policy into all pre-PR Ralph stages.
   - Planner.
   - Orchestrator.
   - Orchestrator delegation instructions.
   - Simplifier.
   - Reviewer parallel steps.
   - `ctx.parallel` shared `task` metadata/options.

4. Safe default policy when `create_pr !== true`.
   - Treat user prompt language about creating/opening/preparing a PR as out of scope.
   - Do not create, open, update, comment on, or otherwise mutate GitHub PRs.
   - Do not run GitHub credential checks for PR creation.
   - Do not push a branch solely for PR handoff.
   - Do not delegate PR creation to subagents.
   - Return deterministic skipped `pr_report`.

5. Enabled policy when `create_pr === true`.
   - Earlier stages still do not create/update/comment on PRs.
   - Earlier stages prepare code, tests, docs, validation, and implementation notes.
   - The final `pull-request` stage remains the only stage authorized to attempt PR creation.

6. Preserve public typing.
   - `packages/workflows/builtin/ralph.d.ts`
   - `packages/workflows/builtin/index.d.ts`

7. Update documentation to show:
   - PR creation is disabled by default.
   - Prompt text alone cannot opt into PR creation.
   - `create_pr=true` explicitly enables only the final PR stage.

8. Add tests that cover:
   - Input schema/default.
   - Disabled/default final-stage skip.
   - Enabled final-stage run.
   - Disabled policy appears in all pre-PR stage prompts.
   - Enabled policy reserves PR creation for the final stage.
   - Public typing rejects non-boolean `create_pr`.

### 3.2 Non-Goals (Out of Scope)

- Do not redesign Ralph’s planning/orchestration/simplification/review loop.
- Do not change GitHub credential selection, `gh` command strategy, branch creation, PR body, or PR comment behavior inside the existing final `pull-request` stage.
- Do not add global Atomic settings for PR creation.
- Do not add `create_pr` to unrelated workflows.
- Do not create real pull requests in tests.
- Do not implement a shell-command denylist or sandbox for every delegated subagent in this iteration.
- Do not block all read-only GitHub CLI usage; the scope is PR creation/update/commenting and PR handoff side effects.
- Do not change worktree creation/cleanup semantics.
- Do not introduce build artifacts, `dist/`, `outDir`, or a new build step for raw TypeScript companion packages.
- Do not replace GitHub PR creation with SCM-generic submission support.

## 4. Proposed Solution (High-Level Design)

Add a centralized pull-request execution policy derived from `createPr` and inject it into every Ralph stage prompt before any worker can act on the raw user prompt.

High-level flow:

1. Resolve inputs through existing TypeBox defaulting.
2. Normalize `createPr` with `inputs.create_pr === true`.
3. Build a stage policy string:
   - Disabled policy for omitted/false.
   - Enabled-but-final-stage-only policy for true.
4. Add that policy as a `pull_request_policy` tagged prompt section to:
   - Planner.
   - Orchestrator.
   - Simplifier.
   - Reviewer.
5. Pass policy-aware shared task text to `ctx.parallel`.
6. Keep the final `pull-request` stage strictly gated by `createPr === true`.
7. Keep deterministic skipped `pr_report` when disabled.

### 4.1 System Architecture Diagram

```mermaid
flowchart TD
  User["User / parent workflow<br/>/workflow ralph inputs"] --> Dispatch["Workflow dispatch<br/>packages/workflows/src/runs/foreground/executor.ts"]
  Dispatch --> Defaults["resolveInputs()<br/>TypeBox defaults<br/>create_pr default false"]
  Defaults --> Validate["validateInputs()<br/>boolean validation"]
  Validate --> Ralph["Ralph workflow<br/>packages/workflows/builtin/ralph.ts"]

  Ralph --> Normalize["createPr = inputs.create_pr === true"]
  Normalize --> Policy["buildPullRequestPolicy(createPr)"]

  Policy --> Planner["planner-N ctx.task<br/>RFC/spec prompt"]
  Policy --> Orchestrator["orchestrator-N ctx.task<br/>subagent delegation prompt"]
  Policy --> Simplifier["code-simplifier-N ctx.task<br/>behavior-preserving cleanup"]
  Policy --> Reviewers["ctx.parallel reviewers<br/>reviewer-a / reviewer-b"]

  Planner --> Loop["plan → orchestrate → simplify → review loop"]
  Orchestrator --> Loop
  Simplifier --> Loop
  Reviewers --> Loop

  Loop --> Gate{"createPr === true?"}
  Gate -- "false or omitted" --> Skip["SKIPPED_PULL_REQUEST_REPORT<br/>No final pull-request task"]
  Gate -- "true" --> PRStage["final ctx.task(\"pull-request\")<br/>only authorized PR stage"]
  PRStage --> GitHub["git / gh / GitHub<br/>PR attempt when possible"]

  Skip --> Outputs["Ralph outputs<br/>result, plan, pr_report, approved, review_report"]
  PRStage --> Outputs

  Tests["Bun tests<br/>test/unit/builtin-workflows.test.ts<br/>test/integration/workflow-package-typing.test.ts"] -. assert .-> Policy
  Tests -. assert .-> Gate

  Docs["Docs<br/>packages/coding-agent/docs<br/>packages/workflows/README.md"] -. describe .-> Ralph
```

### 4.2 Architectural Pattern

Use a safe-by-default feature flag plus policy propagation.

The final PR side effect remains isolated behind an explicit boolean gate, while the policy propagation prevents earlier prompt-chained stages from interpreting raw user text as authorization. This matches Ralph’s current stage-prompt architecture in `packages/workflows/builtin/ralph.ts` and the earlier redesign direction documented in `specs/2026-03-23-ralph-workflow-redesign.md`.

The design intentionally avoids broad platform changes. The workflow SDK already provides input schema defaults, validation, `ctx.task`, and `ctx.parallel`; this change composes those existing primitives rather than introducing new execution infrastructure.

### 4.3 Key Components

| Component | Responsibility | Technology Stack | Justification |
| --------- | -------------- | ---------------- | ------------- |
| `packages/workflows/builtin/ralph.ts` | Declare/consume `create_pr`, build pull-request policy, inject policy into stage prompts, gate final PR stage | TypeScript, TypeBox, workflow SDK | Primary behavior lives here; current unsafe raw prompt propagation is in this file. |
| `buildPullRequestPolicy(createPr)` helper | Produce deterministic enabled/disabled policy text for pre-PR stages | TypeScript string helper | Centralizes wording so planner/orchestrator/simplifier/reviewer stay consistent. |
| `SKIPPED_PULL_REQUEST_REPORT` | Deterministic output when PR creation is disabled | TypeScript constant | Preserves output shape and makes skipped behavior observable. |
| `packages/workflows/builtin/ralph.d.ts` | Public Ralph workflow type declaration | TypeScript declarations | Consumers importing the builtin directly need typed `create_pr`. |
| `packages/workflows/builtin/index.d.ts` | Aggregated builtin type declaration | TypeScript declarations | Consumers importing from the builtin index need the same type surface. |
| `packages/workflows/src/runs/foreground/executor.ts` | Applies TypeBox defaults | TypeScript, TypeBox `Value.Default` | Existing defaulting makes omitted `create_pr` resolve to false in normal runs. |
| `packages/workflows/src/runs/shared/validate-inputs.ts` | Rejects malformed boolean inputs | TypeScript, TypeBox validation | Prevents string `"true"` from acting like opt-in. |
| `test/unit/builtin-workflows.test.ts` | Behavioral tests with mocked `ctx.task`/`ctx.parallel` calls and captured prompts | Bun test, `node:assert/strict` | Existing mock context can assert no real PR task and inspect policy text. |
| `test/integration/workflow-package-typing.test.ts` | Public package typing coverage | Bun test, TypeScript | Verifies `create_pr?: boolean` is exported correctly. |
| `packages/coding-agent/docs/workflows.md` | User-facing workflow docs | Markdown | Required docs surface for Atomic users. |
| `packages/coding-agent/docs/quickstart.md` | Quickstart examples | Markdown | Shows safe default and explicit opt-in. |
| `packages/workflows/README.md` | Workflow package docs | Markdown | Required workflow docs surface. |
| `packages/workflows/CHANGELOG.md`, `packages/coding-agent/CHANGELOG.md` | Release notes | Markdown | Records behavior change in both package/user-facing contexts. |

## 5. Detailed Design

### 5.1 API Interfaces

Ralph input schema:

```ts
.input("create_pr", Type.Boolean({
  default: false,
  description:
    "Whether to run the final pull-request creation stage. Defaults to false; set true to allow Ralph to attempt GitHub PR creation.",
}))
```

CLI/default usage:

```text
/workflow ralph prompt="Implement issue #1255" git_worktree_dir=../atomic-issue-1255-create-pr-flag base_branch=origin/main
```

Explicit PR opt-in:

```text
/workflow ralph prompt="Implement issue #1255" git_worktree_dir=../atomic-issue-1255-create-pr-flag base_branch=origin/main create_pr=true
```

Programmatic usage:

```ts
await ctx.workflow(ralph, {
  inputs: {
    prompt: "Implement issue #1255",
    base_branch: "origin/main",
    git_worktree_dir: "../atomic-issue-1255-create-pr-flag",
    create_pr: true,
  },
});
```

Public declaration shape:

```ts
export type RalphWorkflowInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_loops: number;
  readonly base_branch: string;
  readonly git_worktree_dir: string;
  readonly create_pr: boolean;
};

export type RalphWorkflowRunInputs = WorkflowInputValues & {
  readonly prompt: string;
  readonly max_loops?: number;
  readonly base_branch?: string;
  readonly git_worktree_dir?: string;
  readonly create_pr?: boolean;
};
```

No `WorkflowParametersSchema` change is required because named workflow inputs already flow through `inputs: Record<string, unknown>` and are validated against the selected workflow definition.

### 5.2 Data Model / Schema

New workflow input:

| Field | Type | Required to caller | Default | Runtime meaning |
| ----- | ---- | ------------------ | ------- | --------------- |
| `create_pr` | boolean | No | `false` | Enables only the final `pull-request` stage when exactly `true`. |

Internal values:

| Value | Type | Meaning |
| ----- | ---- | ------- |
| `RalphInputs.create_pr` | `boolean | undefined` | Direct workflow input; optional so tests and unusual callers that bypass defaulting stay safe. |
| `RalphWorkflowOptions.createPr` | `boolean` | Normalized strict opt-in used by runtime control flow. |
| `pullRequestPolicy` | `string` | Prompt policy injected into all pre-PR stages. |
| `pr_report` | `string` | Existing output field; final PR-stage report when enabled, deterministic skipped report when disabled. |

Disabled policy requirements:

```text
create_pr is not true. Pull request creation is out of scope for this Ralph run.
If the user prompt asks to create, open, prepare, update, comment on, or push a branch for a PR, treat that request as not authorized for this run.
Do not create, open, update, or comment on GitHub pull requests.
Do not check GitHub credentials for the purpose of PR creation.
Do not push branches solely for PR handoff.
Do not delegate PR creation or PR handoff to subagents.
The workflow will return a skipped pr_report instead of running the final pull-request stage.
```

Enabled pre-PR policy requirements:

```text
create_pr is true. The final pull-request stage is authorized to attempt PR creation after the plan/orchestrate/simplify/review loop.
Earlier stages must not create, open, update, or comment on GitHub pull requests.
Earlier stages must not push branches solely for PR handoff.
Prepare code, tests, docs, validation evidence, and implementation notes only; leave PR creation to the final pull-request stage.
```

### 5.3 Algorithms and State Management

Runtime algorithm:

```ts
const createPr = inputs.create_pr === true;
const pullRequestPolicy = buildPullRequestPolicy(createPr);

return await runRalphWorkflow(workflowCtx, {
  prompt,
  maxLoops,
  comparisonBaseBranch,
  workflowStartCwd,
  createPr,
  pullRequestPolicy,
});
```

Pre-PR prompt injection:

```ts
["pull_request_policy", pullRequestPolicy]
```

Add the section to:

- Planner prompt near the `task` section.
- Orchestrator prompt immediately after `objective` and before delegation instructions.
- Simplifier prompt immediately after `objective`.
- Reviewer prompt immediately after `objective`.
- Parallel reviewer shared task metadata, for example by using a policy-aware task string instead of raw `prompt` in `ctx.parallel(..., { task, failFast: false })`.

Final-stage gate remains:

```ts
if (createPr === true) {
  const prResult = await ctx.task("pull-request", {
    // existing release-engineer prompt and reads
  });
  finalPrReport = prResult.text;
} else {
  finalPrReport = SKIPPED_PULL_REQUEST_REPORT;
}
```

Review findings from iteration 1 are addressed as follows:

- Reviewer A’s P1 finding is addressed by adding the disabled policy before the planner/orchestrator/simplifier/reviewer stages execute, not just after the loop.
- Reviewer B’s P2 finding is addressed by explicitly telling worker/delegation prompts that PR creation is out of scope when `create_pr` is false.
- Tests must inspect captured prompts to prove the policy is present in earlier stages.

State management remains otherwise unchanged:

- `approved`, `iterations_completed`, `review_report`, artifact paths, worktree handling, and implementation notes behavior remain intact.
- TypeBox defaults remain the source of normal omitted-input behavior.
- Strict equality remains the runtime guard for direct calls that bypass default resolution.

## 6. Alternatives Considered

| Option | Pros | Cons | Reason for Rejection |
| ------ | ---- | ---- | -------------------- |
| Gate only the final `pull-request` task with `createPr === true` | Smallest code change; easy to test final stage absence | Earlier stages still see raw prompt text and can attempt PR-related work before the final gate | Rejected by review round 1; unsafe default remains porous. |
| Gate final stage and thread explicit PR policy through all pre-PR prompts | Minimal architecture change; addresses review finding; keeps PR side effects centralized; testable with existing mock context | Still relies on prompt/tool-contract adherence rather than a shell-level sandbox | Selected; directly satisfies scope and latest review findings. |
| Sanitize/remove PR language from the user prompt before all stages | Reduces chance of prompt conflict | Mutates user intent, can remove useful context, and is brittle for natural language | Rejected in favor of preserving raw prompt plus explicit higher-priority policy. |
| Add global command denylist for `gh pr create`, PR comments, and branch pushes | Stronger defense-in-depth | Requires platform/tool sandboxing beyond Ralph, may block legitimate non-PR GitHub use, and exceeds tight scope | Deferred as possible future hardening. |
| Add global config such as `workflows.ralph.createPr` | Useful for persistent user preference | Less explicit per run and does not satisfy issue requirement to expose workflow input | Rejected for this issue. |
| Remove PR creation from Ralph entirely | Safest default | Breaks existing intentional PR-automation workflow | Rejected because issue asks for optional PR creation. |

## 7. Cross-Cutting Concerns

### 7.1 Security and Privacy

This change reduces default exposure to GitHub side effects.

When `create_pr` is omitted or false:

- The final `pull-request` task does not run.
- Pre-PR stages are explicitly told not to create, update, comment on, or prepare GitHub PRs.
- Pre-PR stages are explicitly told not to inspect GitHub credentials for PR creation.
- Pre-PR stages are explicitly told not to push branches solely for PR handoff.
- Delegated subagents must receive the same no-PR policy.

When `create_pr=true`:

- PR creation remains centralized in the final `pull-request` stage.
- Existing `gh`/GitHub behavior remains unchanged inside that stage.
- Docs must warn that enabling the flag allows the final stage to inspect GitHub credentials and attempt PR creation.

Residual security note: this RFC does not introduce a shell-level sandbox or command denylist. It hardens Ralph’s workflow contract and stage prompts, which is consistent with current workflow architecture, but platform-level command enforcement is an open future hardening question.

### 7.2 Observability Strategy

Observable signals:

- Workflow resolved inputs include `create_pr` through existing run input persistence.
- Unit tests can assert `ctx.calls.task.includes("pull-request") === false` for omitted/false.
- Unit tests can inspect `ctx.calls.prompts["planner-1"]`, `ctx.calls.prompts["orchestrator-1"]`, `ctx.calls.prompts["code-simplifier-1"]`, and reviewer prompts to verify policy propagation.
- Unit tests can inspect `ctx.calls.parallelOptions[0]?.task` to verify shared reviewer task metadata is policy-aware.
- `pr_report` states whether PR creation was skipped or attempted.
- Enabled runs still show a `pull-request` stage.

### 7.3 Scalability and Capacity Planning

The default disabled path reduces work by skipping one LLM stage and avoiding GitHub credential/PR checks. Adding a short policy section to pre-PR prompts has negligible token impact compared with Ralph’s existing planner/orchestrator/reviewer prompts.

The enabled path has the same external dependency profile as current Ralph PR behavior.

No capacity changes are required for workflow stores, stage snapshots, worktree management, or background execution.

## 8. Migration, Rollout, and Testing

### 8.1 Deployment Strategy

Continue implementation in the requested worktree:

```text
/Users/tonystark/Documents/projects/atomic-issue-1255-create-pr-flag
```

Base comparisons should use:

```text
origin/main
```

Rollout sequence:

1. Keep the existing `create_pr` schema/type/final-gate work already present in this worktree.
2. Add centralized pull-request policy construction in `packages/workflows/builtin/ralph.ts`.
3. Inject the policy into planner, orchestrator, simplifier, reviewer, and reviewer parallel options.
4. Update docs to clarify that prompt text alone does not opt into PR creation.
5. Add prompt-policy tests for disabled and enabled paths.
6. Run targeted Bun tests and typecheck.
7. Leave the worktree with only issue #1255 changes.

Behavioral migration note: users who previously expected Ralph to create a PR must now pass `create_pr=true`.

### 8.2 Data Migration Plan

No persistent data migration is required.

Historical workflow runs without `create_pr` remain unchanged. New runs resolve the default to `false` through existing TypeBox defaulting.

### 8.3 Test Plan

Targeted unit tests in `test/unit/builtin-workflows.test.ts`:

1. Existing input declaration test:
   - `create_pr` exists.
   - Kind is boolean.
   - Default is `false`.
   - Required is `false`.

2. Disabled/default final-stage tests:
   - Omitted `create_pr` skips `pull-request`.
   - Explicit `create_pr: false` skips `pull-request`.
   - `pr_report` equals or matches deterministic skipped report.

3. Enabled final-stage test:
   - `create_pr: true` runs `pull-request`.
   - `pr_report` comes from mocked `pull-request` task.

4. New disabled policy propagation test:
   - Use a prompt such as `"Implement X and create a pull request"`.
   - Run with omitted or false `create_pr`.
   - Assert no `pull-request` task.
   - Assert planner prompt includes disabled PR policy.
   - Assert orchestrator prompt includes disabled PR policy and delegation prohibition.
   - Assert simplifier prompt includes disabled PR policy.
   - Assert reviewer prompts include disabled PR policy.
   - Assert `ctx.calls.parallelOptions[0]?.task` includes disabled PR policy.

5. New enabled pre-PR policy test:
   - Run with `create_pr: true`.
   - Assert planner/orchestrator/simplifier/reviewer prompts say PR creation is reserved for the final `pull-request` stage.
   - Assert final `pull-request` stage still runs.

Integration typing test in `test/integration/workflow-package-typing.test.ts`:

- `run(ralph, { prompt: "x", create_pr: true })` type-checks.
- `run(ralphDefault, { prompt: "x", create_pr: false })` type-checks.
- `run(ralph, { prompt: "x", create_pr: "true" })` remains `@ts-expect-error`.

Validation commands to run after implementation:

```sh
bun test test/unit/builtin-workflows.test.ts
bun test test/integration/workflow-package-typing.test.ts
bun run typecheck
git diff --check origin/main
```

If `bun run typecheck` or broader validation fails for unrelated existing reasons, record the exact command, failure excerpt, and residual risk in the implementation notes/PR.

## 9. Open Questions / Unresolved Issues

1. Should Atomic add a future platform-level command denylist/sandbox for PR side effects when workflow policy disables PR creation, or is Ralph prompt-policy enforcement sufficient for issue #1255? `[OWNER: workflow platform maintainers]`

2. Should docs retire “spec-to-PR” shorthand for Ralph unless the example includes `create_pr=true`, replacing it with “spec-to-reviewed-change” for default runs? `[OWNER: docs maintainer]`

3. Should `pr_report` continue to state “no GitHub PR was created or attempted” after prompt-policy propagation, or should wording be narrowed to “Ralph’s PR stage was skipped” until command-level enforcement exists? `[OWNER: Ralph maintainers]`

4. Should changelog attribution remain in both `packages/workflows/CHANGELOG.md` and `packages/coding-agent/CHANGELOG.md`, or only the workflows package changelog? `[OWNER: release maintainer]`
