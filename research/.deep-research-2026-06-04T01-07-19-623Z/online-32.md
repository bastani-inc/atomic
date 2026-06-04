## 1. Relevant external facts

- No external research was necessary for this partition.
- The key behavior here is repo-local: foreground subagent execution currently relies on `node:child_process.spawn` via `runSync(...)`, plus env-based propagation for depth/guard state.

## 2. Local implications

For a Rust migration, this partition is mostly about preserving **orchestration semantics**, not just reimplementing a runner:

- `createSubagentExecutor(...)` is the main coordinator.
- Foreground runs can:
  - execute a single task,
  - execute sequential chains,
  - execute parallel task groups,
  - fall back to async execution when clarification asks for background mode.
- The workflow-stage guard must propagate everywhere:
  - direct foreground `runSync(...)`
  - sequential chain children
  - parallel children
  - async fallback paths
- Depth limits are enforced through env/state plumbing:
  - `maxSubagentDepth`
  - workflow-stage guard env (`WORKFLOW_STAGE_SUBAGENT_GUARD_ENV`)
- The runtime currently depends on child-process spawning of the Atomic/Pi CLI, so a Rust port must decide whether to:
  - keep process-based orchestration, or
  - replace it with in-process execution while preserving outputs, control events, and acceptance behavior.

The highest-signal test here proves the required invariant: **workflow-stage guard propagation must remain intact for both foreground and async handoff paths**.

## 3. Version/API assumptions

- Current implementation is TypeScript/Bun-based in `packages/subagents`.
- The relevant API surface to preserve is:
  - `createSubagentExecutor(...)`
  - `runSync(...)`
  - `executeAsyncChain(...)`
  - `executeAsyncSingle(...)`
  - depth/guard helpers in `packages/subagents/src/shared/types.ts`
- Assumption: a Rust migration should keep the same external behavior of these orchestration entry points, even if internal data structures change.

## 4. Unverified or unnecessary research

- I did not inspect the full `foreground/*` directory beyond the main executor/execution paths.
- I did not validate the exact async fallback boundary beyond the test-covered behavior.
- I did not research Rust ecosystem equivalents yet; that would be the next step if you want a concrete migration plan.