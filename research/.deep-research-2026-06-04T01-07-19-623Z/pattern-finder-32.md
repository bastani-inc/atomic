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