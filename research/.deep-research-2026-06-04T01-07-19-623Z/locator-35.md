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