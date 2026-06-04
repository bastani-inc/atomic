## 1. Established patterns

- **Shared orchestration helpers live under `runs/shared/` and are reused by both foreground and background flows.**  
  Examples: `packages/subagents/src/runs/shared/worktree.ts`, `acceptance.ts`, `completion-guard.ts`, `parallel-utils.ts`, `subagent-control.ts`.

- **A consistent “normalize → resolve → evaluate → format” pipeline is used for policy gates.**  
  In `acceptance.ts`:  
  `normalizeAcceptanceInput()` → `resolveEffectiveAcceptance()` → `evaluateAcceptance()` → `formatAcceptancePrompt()` → `acceptanceFailureMessage()`.

- **Gates are modeled as structured configs, not ad hoc booleans.**  
  Acceptance uses levels (`none`, `attested`, `checked`, `verified`, `reviewed`) plus criteria/evidence/verify/review/stopRules.  
  Worktree gating uses explicit task-level `worktree: true` plus setup hooks.  
  Completion guard is the exception: it’s still heuristic, but it’s exposed as agent config (`completionGuard?: boolean`).

- **Foreground/background runners share the same gate semantics.**  
  Both `foreground/execution.ts` and `background/subagent-runner.ts` call into the same acceptance logic and completion-guard logic, so behavior stays aligned across execution modes.

- **Naming follows “effective/resolved/expected” conventions.**  
  Examples: `resolveEffectiveAcceptance`, `resolveExpectedWorktreeAgentCwd`, `evaluateCompletionMutationGuard`, `formatWorktreeTaskCwdConflict`.

- **Worktree isolation is designed as a transactional wrapper around parallel subagent work.**  
  Pattern: validate repo state → create git worktrees → optionally symlink `node_modules` → run tasks in isolated cwd → diff each worktree → cleanup/prune.

## 2. Variations / exceptions

- **Worktree isolation has explicit escape hatches.**  
  `resolveWorktreeSetupHook()` allows repo-relative or absolute setup hooks, and the hook can return `syntheticPaths` that are removed before diffing.

- **Acceptance has two modes of authority: inferred vs explicit.**  
  `resolveEffectiveAcceptance()` can infer a stronger policy from agent/task context, but explicit config can strengthen or disable it (`level: "none"` with reason).

- **Reviewed acceptance is special.**  
  It can become required for “risky” async/dynamic runs, but explicit checked acceptance is not always treated as a hard reviewed blocker; the tests show the reviewed requirement can be downgraded to optional in some cases.

- **Completion guard is intentionally heuristic, not schema-driven.**  
  It inspects task wording, agent name, and tool calls rather than a formal capability declaration.  
  It also excludes read-only builtins (`read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, etc.).

- **Task-level `cwd` overrides are forbidden only when they conflict with worktree isolation.**  
  The helper `findWorktreeTaskCwdConflict()` allows matching CWDs but rejects overrides that would escape the shared worktree model.

## 3. Anti-patterns or risks

- **Completion guard false positives/negatives are likely.**  
  It relies on regexes over task text (`Implement`, `fix`, `review only`, etc.) plus tool-call detection, so phrasing changes can flip behavior.

- **Two different “completion” concepts can overlap.**  
  `completionGuard` (did the agent attempt mutations?) and `acceptance` (did the output satisfy a contract?) are separate, but both can reject a run. That makes failure attribution harder.

- **Worktree isolation assumes a clean git tree.**  
  `resolveRepoState()` throws if the repo has uncommitted changes, so the feature is brittle in dirty dev environments.

- **Worktree setup hooks add a powerful but risky extension point.**  
  They can inject synthetic paths and modify setup behavior before diffing, which increases flexibility but complicates trust and reproducibility.

- **There is little direct test evidence for worktree and completion-guard behavior in the visible unit suite.**  
  The acceptance gate has strong test coverage (`test/unit/subagents-acceptance.test.ts`), but I didn’t find equivalent focused tests for `worktree.ts` or `completion-guard.ts`.

## 4. Evidence index

- `packages/subagents/src/runs/shared/worktree.ts`
  - `resolveRepoState()`, `findWorktreeTaskCwdConflict()`, `resolveExpectedWorktreeAgentCwd()`, `createWorktrees()`, `diffWorktrees()`, cleanup/prune flow.

- `packages/subagents/src/runs/shared/acceptance.ts`
  - `normalizeAcceptanceInput()`, `resolveEffectiveAcceptance()`, `validateAcceptanceInput()`, `formatAcceptancePrompt()`, `parseAcceptanceReport()`, `evaluateAcceptance()`.

- `packages/subagents/src/runs/shared/completion-guard.ts`
  - `expectsImplementationMutation()`, `hasMutationToolCall()`, `evaluateCompletionMutationGuard()`.

- `packages/subagents/src/runs/foreground/execution.ts`
  - Uses `formatAcceptancePrompt()`, `evaluateAcceptance()`, and emits `reason: "completion_guard"`.

- `packages/subagents/src/runs/background/subagent-runner.ts`
  - Same gate logic in async mode; worktree setup and completion-guard enforcement in background runs.

- `packages/subagents/src/extension/schemas.ts`
  - `acceptance` and `worktree` schema descriptions; shows these are first-class extension contracts.

- `packages/subagents/src/agents/agents.ts`
  - `completionGuard` parsing from frontmatter (`true`/`false`), confirming it’s an opt-out agent setting.

- `test/unit/subagents-acceptance.test.ts`
  - Strong coverage for acceptance levels, verification, reviewer mode, and invalid shapes.