## Partition 35: Subagent git worktree isolation, acceptance gates, and completion guard behavior

### Locator
## 1. Must-read paths

- `packages/subagents/src/runs/shared/worktree.ts`
  - Core git worktree isolation implementation: `createWorktrees`, `cleanupWorktrees`, `findWorktreeTaskCwdConflict`, `formatWorktreeTaskCwdConflict`, `resolveExpectedWorktreeAgentCwd`.
  - Matters because Rust migration must preserve task isolation, branch naming, synthetic-path handling, node_modules linking, and cleanup semantics.

- `packages/subagents/src/runs/shared/acceptance.ts`
  - Acceptance policy engine: `resolveEffectiveAcceptance`, `validateAcceptanceInput`, `formatAcceptancePrompt`, `parseAcceptanceReport`, `evaluateAcceptance`, `acceptanceFailureMessage`.
  - Matters because this defines the gating contract for “done vs rejected” and is likely to move into Rust unchanged or with explicit compatibility.

- `packages/subagents/src/runs/shared/completion-guard.ts`
  - Completion guard detection: `expectsImplementationMutation`, `hasMutationToolCall`, `evaluateCompletionMutationGuard`.
  - Matters because this is the “did the agent actually edit anything?” safeguard.

- `packages/subagents/src/runs/foreground/subagent-executor.ts`
  - Foreground orchestration entrypoint where `worktree`, `acceptance`, and completion guard are threaded through execution.
  - Key flow: `buildParallelWorktreeTaskCwdError`, `createParallelWorktreeSetup`, `resolveParallelTaskCwd`, `appendParallelWorktreeSummary`, `cleanupWorktrees`.

- `packages/subagents/src/runs/background/subagent-runner.ts`
  - Background/async execution path with the same gates.
  - Key flow: `completionGuardTriggered`, `acceptanceFailureMessage`, `createWorktrees`, `cleanupWorktrees`, `prepareParallelTaskRun`.

- `packages/subagents/src/runs/foreground/execution.ts`
  - Single-run completion guard + acceptance enforcement.
  - Key symbols: `completionGuard`, `observedMutationAttempt`, `evaluateAcceptance`, `acceptanceFailureMessage`.

- `packages/subagents/src/agents/agents.ts`
  - Agent config shape and `completionGuard` option handling.
  - Important for migration because the guard is configurable per agent.

## 2. Supporting paths

- `packages/subagents/src/shared/types.ts`
  - Canonical types for `AcceptanceInput`, `AcceptanceLedger`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`.

- `packages/subagents/src/extension/schemas.ts`
  - Public schema surface for `acceptance` and `worktree` options.
  - Matters for ABI compatibility if Rust replaces the extension runtime.

- `packages/subagents/src/extension/index.ts`
  - Extension entrypoint that exposes `worktree` and `acceptance` to the host.

- `packages/subagents/src/agents/chain-serializer.ts`
  - Validates serialized chains, including acceptance on parallel steps.

- `packages/subagents/src/runs/foreground/chain-execution.ts`
  - Chain-level worktree setup and acceptance aggregation.
  - Key symbols: `worktreeSetup`, `aggregateAcceptanceReport`, `evaluateAcceptance`.

- `packages/subagents/src/runs/shared/parallel-utils.ts`
  - Shared parallel-step plumbing for `worktree` / `completionGuard`.

- `packages/subagents/src/runs/shared/workflow-graph.ts`
  - UI/status graph surfaces acceptance state (`acceptanceStatus`).

- `packages/subagents/src/tui/render.ts`
  - User-visible completion state rendering: `Done · acceptance: ...`.

- `packages/coding-agent/docs/subagents.md`
  - Explains the intended behavior of subagent isolation, background work, and `completionGuard: false`.

- `packages/subagents/package.json`
  - Confirms this is a bundled TS extension with `jiti` and no Rust boundary today.

- `test/unit/subagents-acceptance.test.ts`
  - Best direct test coverage for acceptance gates.

- `test/unit/subagents-foreground-guard-propagation.test.ts`
  - Likely important for completion-guard behavior propagation.

- `test/unit/subagents-pi-spawn.test.ts`
  - Relevant if Rust changes child-process orchestration.

## 3. Entry points / symbols

- `createWorktrees(...)`
- `cleanupWorktrees(...)`
- `findWorktreeTaskCwdConflict(...)`
- `formatWorktreeTaskCwdConflict(...)`
- `resolveExpectedWorktreeAgentCwd(...)`

- `resolveEffectiveAcceptance(...)`
- `validateAcceptanceInput(...)`
- `formatAcceptancePrompt(...)`
- `parseAcceptanceReport(...)`
- `evaluateAcceptance(...)`
- `acceptanceFailureMessage(...)`

- `expectsImplementationMutation(...)`
- `hasMutationToolCall(...)`
- `evaluateCompletionMutationGuard(...)`

- `subagent-executor.ts`
  - `createParallelWorktreeSetup(...)`
  - `buildParallelWorktreeTaskCwdError(...)`
  - `resolveParallelTaskCwd(...)`
  - `appendParallelWorktreeSummary(...)`

- `subagent-runner.ts`
  - `completionGuardTriggered`
  - `acceptanceCanFailRun`
  - `prepareParallelTaskRun(...)`

## 4. Gaps or uncertainty

- I could verify the core implementation paths, but I did **not** confirm a dedicated `worktree`-specific unit test file; worktree behavior may be covered indirectly through executor and acceptance tests.
- The exact Rust migration seam is not defined here; these files show the contracts, but not whether you should replace them in-process, behind a subprocess boundary, or via a new plugin ABI.
- I did not verify whether CI explicitly runs all `packages/subagents`-focused root tests versus only selected integration/unit suites.

### Pattern Finder
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

### Analyzer
## 1. Behavioral model

This partition is the subagent “safety net” around parallel execution:

- **Git worktree isolation** creates one disposable worktree per parallel task, so each task edits an isolated checkout.
- **Acceptance gating** evaluates whether the child run produced enough structured evidence to count as done.
- **Completion guard** catches “implementation tasks” that finish successfully but never actually mutate files.

Together, they turn parallel subagent execution into a controlled, auditable workflow rather than plain subprocess fan-out.

## 2. Key flows and invariants

### Worktree isolation
- `createWorktrees()`:
  - requires the target cwd to be a git repo and the tree to be clean
  - captures `HEAD` as `baseCommit`
  - creates one branch/worktree per task using temp paths
  - links `node_modules` into each worktree when possible
  - optionally runs a user hook that can declare extra `syntheticPaths`
- `cleanupWorktrees()`:
  - removes worktrees in reverse order
  - deletes branches
  - prunes repo worktrees best-effort

### Important invariants
- Worktree isolation is **disabled if any task overrides `cwd` away from the shared cwd**.
- Hook output is tightly constrained:
  - JSON object only
  - `syntheticPaths` must be relative
  - cannot escape the worktree root
  - cannot target tracked files
- Diff capture happens **after synthetic paths are removed** so “virtual” paths don’t contaminate the patch.

### Acceptance gating
- `resolveEffectiveAcceptance()` merges:
  - explicit acceptance config
  - inferred policy from agent/task shape
- `formatAcceptancePrompt()` injects a structured report contract into the child task prompt.
- `evaluateAcceptance()`:
  - parses fenced `acceptance-report` JSON or `ACCEPTANCE_REPORT:{...}`
  - validates required criteria and evidence
  - optionally runs verification commands
  - optionally requires independent review for `reviewed`
- `acceptanceFailureMessage()` converts a rejected ledger into a single human-readable failure.

### Completion guard
- `evaluateCompletionMutationGuard()` decides whether the task **should have edited files**.
- It only triggers when:
  - the task looks like an implementation task, and
  - the toolset is not explicitly read-only, and
  - no mutating tool call was observed
- It detects mutations via:
  - `edit`
  - `write`
  - mutating `bash` commands

### Execution coupling
- Foreground, background, and chain runners all thread these same policies through parallel execution.
- If worktree setup fails, the whole parallel group fails early.
- If completion guard triggers, the run is flipped to failure even with exit code 0.
- If acceptance rejects, the run may be converted to failure even after successful execution.

## 3. Tests / validation

Strong coverage exists for acceptance behavior:
- `test/unit/subagents-acceptance.test.ts`
  - inference rules
  - prompt formatting
  - parsing
  - evidence checks
  - verification commands
  - review handling
  - zero-child aggregate behavior

There is also propagation coverage for workflow-stage guard behavior:
- `test/unit/subagents-foreground-guard-propagation.test.ts`

What I did **not** verify directly:
- dedicated unit tests for `worktree.ts` itself
- full integration tests for worktree cleanup/failure rollback
- whether CI runs every subagents-specific test path or only a subset

## 4. Risks, unknowns, and verification steps

### Migration risks for Rust
- **Worktree orchestration is shell/git-heavy**: easiest to port, but cleanup semantics must remain exact.
- **Acceptance parsing is prompt-contract dependent**: Rust must preserve the structured report format or intentionally replace it.
- **Completion guard is heuristic**: false positives/negatives will matter more after a rewrite.
- **The biggest coupling is not these gates themselves, but the runner stack around them**:
  - task spawning
  - stdout event parsing
  - session persistence
  - artifact generation

### Unknowns to verify
- Whether `syntheticPaths` are used only for `node_modules`-like shims or by broader hook ecosystems.
- Whether any downstream consumers depend on the exact error text from acceptance/completion guard failures.
- Whether background and foreground runners diverge in subtle cleanup timing.

### Recommended verification
1. Port worktree creation/cleanup first.
2. Preserve acceptance report schema exactly.
3. Re-run acceptance and guard-focused tests.
4. Add integration tests for:
   - setup-hook failure rollback
   - synthetic path stripping
   - completion-guard failure on no-edit implementations
   - acceptance rejection after a successful run

### Online Researcher
## 1. Relevant external facts

- No external research was necessary for this partition. The key behavior is defined by local TS code in:
  - `packages/subagents/src/runs/shared/worktree.ts`
  - `packages/subagents/src/runs/shared/acceptance.ts`
  - `packages/subagents/src/runs/shared/completion-guard.ts`

## 2. Local implications

For a TypeScript → Rust migration, these are the contracts you must preserve:

- **Git worktree isolation**
  - `createWorktrees`, `cleanupWorktrees`, and `resolveExpectedWorktreeAgentCwd` define how parallel agents get isolated filesystems.
  - Rust must keep:
    - branch/worktree naming semantics
    - synthetic path handling
    - `node_modules` linking behavior
    - cleanup on success/failure

- **Acceptance gating**
  - `resolveEffectiveAcceptance`, `validateAcceptanceInput`, `parseAcceptanceReport`, `evaluateAcceptance`, and `acceptanceFailureMessage` define “done vs rejected.”
  - Rust must preserve:
    - input validation rules
    - report parsing format
    - failure messaging
    - policy inheritance/override behavior

- **Completion guard**
  - `expectsImplementationMutation`, `hasMutationToolCall`, and `evaluateCompletionMutationGuard` enforce “did the agent actually edit anything?”
  - Rust should keep this as a first-class safeguard, not a UI-only check.

- **Execution wiring**
  - The foreground/background runners thread `worktree`, `acceptance`, and completion guard through execution.
  - Migration risk is highest at orchestration boundaries, not just the pure helpers.

- **Public API surface**
  - `packages/subagents/src/extension/schemas.ts` and `packages/subagents/src/extension/index.ts` mean these behaviors are externally visible.
  - A Rust rewrite must remain schema-compatible unless you plan a breaking change.

## 3. Version/API assumptions

- Assumes the current TS APIs are the source of truth.
- No Rust API exists yet for these features, so migration likely means:
  - reimplementing the same behavior in Rust, or
  - introducing a compatibility layer that preserves the current extension contract.
- The local repo currently treats `@bastani/subagents` as a bundled TS extension, not a Rust-backed boundary.

## 4. Unverified or unnecessary research

- I did not verify Git CLI/worktree upstream docs because the local implementation already defines the behavior that matters for migration.
- I did not inspect the exact Rust runtime architecture, so I can’t say whether these pieces should become:
  - in-process Rust modules,
  - a subprocess service,
  - or a plugin boundary.
- I also did not verify test coverage depth for worktree behavior beyond the files listed in the locator.