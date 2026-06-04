## Partition 32: Subagent foreground execution and orchestration behavior

### Locator
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

### Pattern Finder
## 1. Established patterns

- **Foreground execution is stateful and event-driven.**  
  `packages/subagents/src/runs/foreground/subagent-executor.ts` keeps a mutable `foregroundControl` per run in `state.foregroundControls`, and updates it repeatedly (`currentAgent`, `currentIndex`, `currentActivityState`, `lastActivityAt`, `currentTool`, `tokens`, `toolCount`, `updatedAt`). This is the core orchestration pattern for live status/interrupt support.

- **The foreground path is split into “single run” and “chain run” orchestration.**  
  `execution.ts` handles one agent/task at a time; `chain-execution.ts` coordinates sequential/parallel steps, worktrees, acceptance, and intercom detachment. The same progress-shaping fields are copied into foreground controls in both places.

- **Shared runtime deps are injected, not hard-coded.**  
  `subagent-executor.ts` defines `SubagentExecutorRuntimeDeps` and wraps `runSync`, `executeAsyncChain`, `executeAsyncSingle`, etc. This is a consistent seam for testability and future replacement.

- **Foreground status is derived from live progress snapshots.**  
  Both `subagent-executor.ts` and `chain-execution.ts` treat progress as the source of truth, then mirror it into the control object for UI/interrupt rendering.

- **Control/attention handling is standardized.**  
  `subagent-control.ts` centralizes `resolveControlConfig`, `deriveActivityState`, `buildControlEvent`, and notification formatting. Foreground execution code imports these helpers rather than re-implementing thresholds or messages.

- **Extension entrypoints wire orchestration together.**  
  `packages/subagents/src/extension/index.ts` creates `state` maps (`asyncJobs`, `foregroundRuns`, `foregroundControls`) and passes them into the executor. This is the top-level orchestration hub.

## 2. Variations / exceptions

- **Async and foreground share logic, but not the same control path.**  
  The extension supports both sync/foreground and background async modes; foreground uses live control objects, while async uses job tracker/result watcher paths.

- **Interrupt handling is local and ephemeral.**  
  `interrupt` is assigned as an inline closure in several spots, then cleared when the active index changes. That’s a pattern, but the exact lifecycle differs across single, chain, and nested runs.

- **Worktree handling is chain-specific.**  
  `chain-execution.ts` adds worktree setup/diff/cleanup only for parallel chain steps, not for every foreground subagent run.

- **Intercom detachment is a special-case escape hatch.**  
  `execution.ts` and `chain-execution.ts` both support detaching when intercom coordination starts, but only under explicit flags and runtime conditions.

- **The module boundaries are broad, not granular.**  
  `subagent-executor.ts` is very large and acts as both orchestration engine and status formatter, unlike the cleaner separation implied by the helper modules.

## 3. Anti-patterns or risks

- **Very large orchestration files.**  
  `subagent-executor.ts` and `chain-execution.ts` are sprawling and mix status tracking, progress formatting, nested routing, worktrees, acceptance, and execution flow. This makes Rust migration harder because the boundary is behavioral, not structural.

- **Mutable shared state everywhere.**  
  `foregroundControls` is mutated in-place from multiple flows. That’s simple in TS, but in Rust it implies careful ownership/locking or an actor-style redesign.

- **Behavior is duplicated across execution paths.**  
  The “copy current progress into foregroundControl” logic appears in multiple places (`execution.ts`, `chain-execution.ts`, `subagent-executor.ts`). That duplication is a migration risk because it hides the true canonical status contract.

- **No obvious test harness in this partition.**  
  I didn’t find `packages/subagents/test/` here, so orchestration behavior appears to rely mostly on implicit integration coverage rather than tight unit tests.

- **Tight coupling to surrounding Atomic/pi runtime types.**  
  `ExtensionAPI`, `ExtensionContext`, `AgentToolResult`, and `@bastani/atomic` helpers are embedded in the orchestration flow, which means a Rust rewrite would need a compatibility layer for extension/runtime semantics.

## 4. Evidence index

- `packages/subagents/src/extension/index.ts` — extension bootstrap, `state.foregroundControls`, executor wiring, sync/async mode selection.
- `packages/subagents/src/runs/foreground/subagent-executor.ts` — main foreground orchestration engine, `foregroundControl` mutation, status propagation, run lifecycle.
- `packages/subagents/src/runs/foreground/execution.ts` — single-agent foreground run lifecycle, progress tracking, detachment, acceptance checks.
- `packages/subagents/src/runs/foreground/chain-execution.ts` — sequential/parallel chain orchestration, worktrees, intercom detachment, foreground status syncing.
- `packages/subagents/src/runs/shared/subagent-control.ts` — shared control-event model, thresholds, and user-facing notice formatting.
- `packages/subagents/src/extension/control-notices.ts` — foreground control notice routing into the UI.
- `packages/subagents/src/shared/types.ts` — shared orchestration state shapes (`SubagentState`, `AgentProgress`, control/event types).
- `packages/subagents/src/runs/shared/worktree.ts` — parallel step isolation and diff summary behavior.
- `packages/subagents/src/runs/shared/nested-events.ts` — nested run projection/route handling.
- `packages/subagents/src/extension/fanout-child.ts` — nested child executor path, separate from normal foreground path.

### Analyzer
## 1. Behavioral model

This partition is the **foreground orchestration layer** for subagents.

It decides, for a given `subagent` invocation, whether to:

- run a **single agent**
- run a **chain**
- run **parallel tasks**
- fall back to **async/background execution** when clarify/run-in-background is requested

Core behavior lives in `createSubagentExecutor(...)`, which:
- validates input
- resolves agent scope, cwd, session roots, intercom routing, and depth policy
- constructs execution context
- dispatches to `runSync(...)` for foreground single-agent work
- dispatches to `executeChain(...)` or async wrappers for multi-step work

`runSync(...)` is the actual **foreground child process runner**:
- resolves the target agent
- validates output mode and acceptance policy
- injects skills/system prompt
- builds spawn args/env
- launches the child CLI via `getPiSpawnCommand(...)`
- collects output, usage, artifacts, acceptance results, and progress metadata
- applies mutation/long-running safeguards and cleanup

## 2. Key flows and invariants

### Foreground dispatch rules
- **Single task** → `executeAsyncSingle(...)` only if async/clarify path is chosen; otherwise `runSync(...)` through orchestration.
- **Chain/parallel** → `executeAsyncChain(...)` for async mode, otherwise foreground chain execution.
- **Clarify + background requested** is a special path that still preserves depth/guard settings.

### Depth/guard propagation
A major invariant is that **subagent depth limits and workflow-stage guards are always propagated downward**:
- `resolveSubagentDepthPolicy(...)` computes the effective max depth and whether the current run is workflow-stage guarded.
- Child runs receive:
  - `maxSubagentDepth`
  - `workflowStageSubagentGuard`
- This applies to:
  - sequential chain children
  - parallel children
  - async handoff paths

If depth is exceeded, execution is blocked before dispatch with a structured error message.

### Child process boundary
`runSync(...)` does **not** execute the agent in-process. It:
- builds CLI args with `buildPiArgs(...)`
- resolves the CLI executable with `getPiSpawnCommand(...)`
- spawns a separate process
- passes env including depth/guard state via `getSubagentDepthEnv(...)`

So the orchestration layer is a process supervisor, not the agent runtime itself.

### Acceptance and mutation safety
Foreground execution also enforces:
- acceptance prompt injection/evaluation
- output-mode validation
- completion/mutation guards
- long-running/mutating failure escalation
- artifact/session writing

These are part of the safety contract and are not optional plumbing.

## 3. Tests / validation

The strongest test signal here is:

- `test/unit/subagents-foreground-guard-propagation.test.ts`

It verifies that workflow-stage guard state is preserved across:
- sequential chain children
- parallel children
- async clarify-to-background handoff for both chain and single runs

That test confirms the key migration invariant: **guard state must survive orchestration transitions**.

What is not fully validated here:
- child-process launch behavior itself
- acceptance evaluation edge cases
- mutation guard escalation under real tool output
- full chain execution branches beyond guard propagation

## 4. Risks, unknowns, and verification steps

### Migration risks for Rust
1. **Process model coupling**
   - This code assumes the child agent is another CLI process.
   - A Rust rewrite must decide whether to preserve subprocess isolation or replace it with in-process execution.

2. **Guard semantics are load-bearing**
   - Depth limits and workflow-stage protection are threaded through many branches.
   - Losing them would change safety behavior, not just ergonomics.

3. **Async fallback depends on current JS ecosystem**
   - Background execution is tied to existing TS/CLI runtime assumptions.
   - Rust needs either a compatibility layer or a new async orchestration model.

4. **Acceptance/mutation behavior is intertwined**
   - These are not standalone checks; they influence exit codes, output, and progress state.

### Unknowns to verify next
- Exact behavior of `executeChain(...)` for background handoff and nested children
- Whether child process spawning is required for all compatibility cases
- Whether any hidden tests assert specific stderr/stdout formatting or session-file side effects
- How much of `pi`/`jiti`/TS runtime behavior is expected to remain stable in a Rust port

### Verification steps
- Trace `executeChain(...)` and `executeAsync*` to confirm every place depth/guard is forwarded.
- Run or inspect tests around:
  - nested subagent limits
  - acceptance failures
  - background clarify mode
  - worktree/cleanup behavior
- Decide early whether Rust will:
  - keep the CLI as a child process boundary, or
  - replace it with a native execution engine.

### Online Researcher
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