## 1. Must-read paths

- `packages/subagents/src/runs/foreground/subagent-executor.ts`  
  Core orchestration for foreground subagent runs; this is where task dispatch, nesting, depth limits, async fallback, and workflow-stage guards are wired.

- `packages/subagents/src/runs/foreground/execution.ts`  
  Executes a single subagent attempt: builds spawn args/env, launches the child process, collects output, applies acceptance checks, and finalizes results.

- `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Defines how foreground execution finds and launches the Atomic/Pi CLI process; critical for any Rust replacement of process orchestration.

- `packages/subagents/src/runs/shared/acceptance.ts`  
  Acceptance gating for foreground runs; important because it determines when a run is considered successful, rejected, or needs verification/review.

- `packages/subagents/src/runs/shared/worktree.ts`  
  Worktree setup/cleanup/diff logic used by foreground orchestration when isolation is enabled.

- `packages/subagents/src/runs/shared/completion-guard.ts`  
  Guards completion behavior for mutating tasks; likely part of the safety model a Rust port must preserve.

- `test/unit/subagents-foreground-guard-propagation.test.ts`  
  Highest-signal test for this partition; verifies max-depth and workflow-stage guard propagation through foreground execution and async handoff.

## 2. Supporting paths

- `packages/subagents/src/shared/types.ts`  
  Shared run-mode, control, acceptance, and depth policy types used throughout orchestration.

- `packages/subagents/src/shared/fork-context.ts`  
  Fork/session isolation plumbing; relevant to nested foreground runs.

- `packages/subagents/src/runs/shared/nested-events.ts`  
  Nested event routing and projection for parent/child coordination.

- `packages/subagents/src/runs/shared/subagent-control.ts`  
  Control-event and notification behavior for foreground runs.

- `packages/subagents/src/runs/foreground/chain-execution.ts`  
  Sequential chain orchestration, useful if Rust needs parity for chained foreground tasks.

- `packages/subagents/src/runs/background/async-execution.ts`  
  Background fallback path that foreground execution delegates to when async is requested/allowed.

- `packages/subagents/src/agents/agent-management.ts`  
  Management actions invoked from foreground orchestration.

- `packages/subagents/src/agents/agent-scope.ts`  
  Agent discovery scope resolution used before foreground execution.

- `packages/subagents/src/shared/settings.ts`  
  Step behavior, max-depth resolution, and workflow/subagent policy helpers.

## 3. Entry points / symbols

- `createSubagentExecutor(...)` in `packages/subagents/src/runs/foreground/subagent-executor.ts`  
  Main entry for foreground orchestration.

- `runSync(...)` in `packages/subagents/src/runs/foreground/execution.ts`  
  Primary synchronous execution path for one subagent attempt.

- `getPiSpawnCommand(...)` in `packages/subagents/src/runs/shared/pi-spawn.ts`  
  Process-launch abstraction for the child CLI.

- `resolveEffectiveAcceptance(...)` and `evaluateAcceptance(...)` in `packages/subagents/src/runs/shared/acceptance.ts`  
  Acceptance policy resolution and evaluation.

- `resolveSubagentDepthPolicy(...)`, `checkSubagentDepth(...)`, `resolveChildMaxSubagentDepth(...)` in `packages/subagents/src/shared/types.ts` / related helpers  
  Depth/guard policy that constrains nested foreground execution.

- `workflowStageSubagentGuard` and `maxSubagentDepth` in `subagent-executor.ts` and `execution.ts`  
  The key flags to preserve when porting orchestration semantics.

- Test symbols in `test/unit/subagents-foreground-guard-propagation.test.ts`:
  - `makeExecutor(...)`
  - `makeWorkflowStageContext(...)`
  - `runSyncMock`
  - `executeAsyncChainMock`
  - `executeAsyncSingleMock`

## 4. Gaps or uncertainty

- I verified foreground orchestration paths, but not the full `packages/subagents/src/runs/foreground/*` directory beyond the main executor and execution files.
- I did not inspect `packages/subagents/src/runs/background/*` in detail, so the exact async fallback boundary is still partly inferred.
- `packages/subagents/src/runs/foreground/subagent-executor.ts` is very large; there may be additional orchestration branches not covered here.
- Rust migration impact here is still a compatibility question: whether to preserve child-process spawning or replace it with in-process execution is not yet resolved by the code alone.