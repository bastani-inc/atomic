I’m sorry, but I don’t have a file write/edit tool available in this session, so I could not create:

`/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-planner-overflow-degradation-analysis.md`

Findings content:

```md
## Analysis: Compaction Planner Overflow Degradation

### Overview
The current compaction runner degrades overflow-path planner failures to deterministic, non-model eviction when an overflow ladder budget is present. Both provider overflow reported through assistant state and provider overflow thrown during the planner call are normalized into `providerOverflow: true`, causing the critical planner pass to be skipped and deterministic eviction to run.

### Entry Points
- `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:312` - `contextCompact()` orchestrates standard planner, critical planner, and deterministic fallback.
- `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:154` - `runContextDeletionAssistant()` wraps the model-driven deletion planner and converts overflow failures into structured run results.
- `packages/coding-agent/src/core/compaction/context-compaction-eviction.ts:168` - `runDeterministicContextEviction()` performs non-model deterministic deletion.
- `packages/coding-agent/src/core/agent-session-compaction.ts:51` - overflow auto-compaction passes both `acceptanceTokenBudget` and `criticalEvictionTokenBudget`.
- `packages/coding-agent/src/core/agent-session-compaction.ts:69` - overflow with missing auth bypasses planner and directly runs deterministic eviction.

### Core Implementation

#### 1. Planner overflow detection
- `isContextCompactionOverflowError()` wraps an error string in an assistant message and delegates to `isContextOverflow()` (`context-compaction-runner.ts:112-114`).
- During `agent.prompt()`, thrown errors are caught at `context-compaction-runner.ts:229`.
- If the thrown error is context overflow, `runContextDeletionAssistant()` returns a `ContextDeletionRun` with current validated deletions, formatted provider error, and `providerOverflow: true` (`context-compaction-runner.ts:233-239`).
- If the agent finishes with `agent.state.errorMessage`, that assistant-state error is checked the same way (`context-compaction-runner.ts:249-258`).
- Non-overflow planner errors are thrown as `Context compaction failed: ...` (`context-compaction-runner.ts:241`, `context-compaction-runner.ts:259`).

#### 2. Standard planner result handling
- `contextCompact()` first runs the standard planner (`context-compaction-runner.ts:328-329`).
- If the standard run meets the strict compaction target and, when applicable, the overflow budget, it returns immediately (`context-compaction-runner.ts:330`).
- If the run’s validated deletions fit the ladder acceptance budget, it returns even below the strict target (`context-compaction-runner.ts:331`).
- Otherwise, `skipCriticalPlanner` is set from `standardRun.providerOverflow` (`context-compaction-runner.ts:332`) and the attempt is recorded (`context-compaction-runner.ts:333`).

#### 3. Critical planner is skipped after provider overflow
- Critical overflow planner only runs when `skipCriticalPlanner` is false (`context-compaction-runner.ts:344`).
- Because provider overflow sets `skipCriticalPlanner = true`, both assistant-state overflow and thrown provider overflow skip the critical planner and proceed to deterministic eviction.
- Deterministic eviction is invoked at `context-compaction-runner.ts:371-372`.
- If deterministic eviction also fails, the runner throws a combined target-failure message plus deterministic failure text (`context-compaction-runner.ts:373-375`).

#### 4. Non-overflow thrown errors with overflow ladder
- `shouldRethrowPlannerError()` rethrows aborted errors and errors when no `criticalEvictionTokenBudget` exists (`context-compaction-runner.ts:304-307`).
- When `criticalEvictionTokenBudget` exists, non-abort planner errors are recorded as failed attempts instead of rethrown (`context-compaction-runner.ts:334-338`).
- The runner can then try the critical planner and finally deterministic eviction (`context-compaction-runner.ts:344-372`).

### Deterministic Eviction Behavior
The original fallback was a flat oldest-first candidate loop with a fixed pass cap and a special case for the latest thinking assistant. That description is historical. The current fallback is turn-aware and finite by construction:

- `runDeterministicContextEviction()` first applies critical-overflow relaxation, then `initialEvictionGroups()` analyzes logical assistant tool-use turns. Signed-thinking assistant entries in each completed historical turn become an all-or-none eviction group; signed entries in the active final turn are excluded. Other eligible entries are singleton groups, and provider-visible user-like turn boundaries are marked separately (`packages/coding-agent/src/core/compaction/context-compaction-eviction.ts`).
- Phase 1 uses `adoptSmallestFittingPrefix()` to batch the smallest fitting prefix of non-boundary groups when possible, otherwise it sweeps those groups in transcript order. The prefix search and sweep each traverse a finite group list (`context-compaction-eviction.ts`).
- Phase 2 tries `repairedFittingBoundaryPrefix()`, then individual boundary groups in deterministic token-descending order with transcript order as the tie-breaker. `repairSignedTurnTargets()` reconciles tool dependencies and restores any active or partial signed turn before validation (`context-compaction-eviction.ts`; `packages/coding-agent/src/core/compaction/context-compaction-eviction-alternates.ts`).
- Phase 3 sweeps signed groups that became historical after boundary deletion. Phase 4 retries skipped boundaries first by shared restoration component, then retries only boundaries outside those components individually (`currentHistoricalSignedGroups()` and `skippedBoundaryRestorationGroups()` in `context-compaction-eviction-alternates.ts`; the ordered phase loops remain in `context-compaction-eviction.ts`).
- Phase 5 calls `alternateBoundaryPlan()`. For each boundary it explores both retaining the current plan and adopting a repaired plan, deduplicates by exact target signature, sorts deterministically by `tokensAfter` and signature, and retains at most 16 states per boundary (eight from each end when pruning). It then gives every retained state one finite newly-historical-signed-group sweep (`context-compaction-eviction-alternates.ts`).
- Every accepted candidate goes through `validateContextDeletionRequest()` via `validateTargets()`, so token accounting and replay/task/tool integrity use the production validator. Returned targets are sorted by transcript position and block index, and a plan succeeds only with at least one deletion and `stats.tokensAfter <= tokenBudget`.
- If all ordered candidate arrays and bounded alternate states are exhausted, the terminal error reports the best achieved stats, budget, and “nothing more was safely deletable” (`terminalDeterministicEvictionError()` in `context-compaction-eviction.ts`).

### Critical Relaxation Rules
- Critical overflow widens `preserve_recent` to at least 5 (`context-compaction-critical.ts:6-12`).
- Protected entries become deletable only if they are outside the last-5 floor, are not assistant/tool/bash errors, and are task-bearing (`context-compaction-critical.ts:15-28`).
- `relaxTranscriptForCriticalEviction()` clears protection only for entries passing that predicate and rebuilds `protectedEntryIds` from still-protected entries (`context-compaction-critical.ts:38-53`).

### Data Flow
1. Overflow auto-compaction creates ladder options with `acceptanceTokenBudget` and `criticalEvictionTokenBudget` set to the effective model budget (`agent-session-compaction.ts:51-54`).
2. `contextCompact()` runs the standard model planner (`context-compaction-runner.ts:328-329`).
3. Provider overflow from a thrown error is converted to `providerOverflow: true` (`context-compaction-runner.ts:229-239`).
4. Provider overflow from `agent.state.errorMessage` is also converted to `providerOverflow: true` (`context-compaction-runner.ts:249-258`).
5. `contextCompact()` copies `standardRun.providerOverflow` into `skipCriticalPlanner` (`context-compaction-runner.ts:332`).
6. If `skipCriticalPlanner` is true, the critical planner block is bypassed (`context-compaction-runner.ts:344`).
7. Deterministic eviction runs without another model call (`context-compaction-runner.ts:371-372`).

### Test Coverage

#### Planner overflow degradation
- `packages/coding-agent/test/context-compaction-deletion-tool-06.suite.ts:314-332` covers provider-overflow salvage when partial validated deletions fit the acceptance budget.
- `packages/coding-agent/test/context-compaction-deletion-tool-06.suite.ts:334-352` covers assistant-state planner overflow with no fitting planner deletion. It expects deterministic eviction to delete `old-equivalent`, fit the budget, and make only one provider call.
- `packages/coding-agent/test/context-compaction-deletion-tool-06.suite.ts:354-374` covers thrown provider overflow. The faux provider throws `context_length_exceeded`, the result is deterministic eviction, provider call count is one, and captured contexts do not contain `<critical-overflow-mode>`, proving no critical planner call occurred.

#### Deterministic fallback and exhaustion
- `packages/coding-agent/test/context-compaction-deletion-tool-06.suite.ts:286-312` covers fallback to deterministic tier-4 eviction and terminal exhaustion reporting.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:151-166` verifies deterministic eviction deletes oldest deletable entries first and stops when budget fits.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:168-180` verifies tool-call/tool-result reconciliation during deterministic eviction.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:182-189` verifies terminal exhaustion includes achieved stats.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:456-459` verifies repeated-input determinism, while `context-compaction-eviction-alternates.ts` bounds alternate boundary exploration to 16 retained states per boundary.

#### Critical overflow constraints
- `packages/coding-agent/test/context-compaction-eviction.test.ts:105-149` covers relaxation of stale protected task-bearing entries while preserving assistant/tool/bash errors and last-5 recent entries.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:191-202` verifies entries inside the critical last-5 floor and configured `preserve_recent` entries are not evicted.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:211-266` covers thinking-assistant deletion rules during deterministic eviction.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:268-300` covers task-bearing exchange behavior.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:346-422` compares deterministic eviction with a bounded brute-force oracle.

#### Session-level overflow/no-auth path
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:95-105` verifies overflow auto-compaction with missing auth commits deterministic eviction.
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:107-115` verifies threshold auto-compaction with missing auth remains a silent no-op.
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:73-83` verifies overflow with no compactable transcript surfaces a terminal error and commits no context-compaction entry.

### Conclusion
Yes. In the current implementation, planner overflow degrades to deterministic non-model reduction when an overflow ladder budget exists. Assistant-state overflow and thrown provider overflow both become `providerOverflow: true` inside `runContextDeletionAssistant()`, which causes `contextCompact()` to skip the critical planner and invoke `runDeterministicContextEviction()` directly.
```