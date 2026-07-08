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
- `runDeterministicContextEviction()` first relaxes the transcript for critical overflow (`context-compaction-eviction.ts:172`).
- It protects the latest assistant entry if that entry contains thinking content (`context-compaction-eviction.ts:173-174`).
- It builds candidates from relaxed entries excluding that protected latest thinking assistant, keeping only entries accepted by `canDeleteTarget()` (`context-compaction-eviction.ts:175-178`).
- It iterates candidates in transcript order, adding whole-entry deletion targets and validating after each addition (`context-compaction-eviction.ts:190-199`).
- If a direct deletion plan is invalid, it tries deterministic exchange plans for thinking/task-bearing constraints (`context-compaction-eviction.ts:202-209`).
- It stops once validated deletions fit the token budget (`context-compaction-eviction.ts:191`, `context-compaction-eviction.ts:194`).
- It has a hard 50-pass cap (`context-compaction-eviction.ts:8`, `context-compaction-eviction.ts:190`, `context-compaction-eviction.ts:217-221`).
- Terminal failure messages include achieved stats and “nothing more was safely deletable” (`context-compaction-eviction.ts:10-20`).

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
- `packages/coding-agent/test/context-compaction-eviction.test.ts:149-164` verifies deterministic eviction deletes oldest deletable entries first and stops when budget fits.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:166-178` verifies tool-call/tool-result reconciliation during deterministic eviction.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:180-187` verifies terminal exhaustion includes achieved stats.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:395-399` verifies the 50-pass cap and repeat-input determinism.

#### Critical overflow constraints
- `packages/coding-agent/test/context-compaction-eviction.test.ts:107-147` covers relaxation of stale protected task-bearing entries while preserving assistant/tool/bash errors and last-5 recent entries.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:189-200` verifies entries inside the critical last-5 floor and configured `preserve_recent` entries are not evicted.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:209-262` covers thinking-assistant deletion rules during deterministic eviction.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:264-296` covers task-bearing exchange behavior.
- `packages/coding-agent/test/context-compaction-eviction.test.ts:298-360` compares deterministic eviction with a bounded brute-force oracle.

#### Session-level overflow/no-auth path
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:95-105` verifies overflow auto-compaction with missing auth commits deterministic eviction.
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:107-115` verifies threshold auto-compaction with missing auth remains a silent no-op.
- `packages/coding-agent/test/agent-session-overflow-eviction.test.ts:73-83` verifies overflow with no compactable transcript surfaces a terminal error and commits no context-compaction entry.

### Conclusion
Yes. In the current implementation, planner overflow degrades to deterministic non-model reduction when an overflow ladder budget exists. Assistant-state overflow and thrown provider overflow both become `providerOverflow: true` inside `runContextDeletionAssistant()`, which causes `contextCompact()` to skip the critical planner and invoke `runDeterministicContextEviction()` directly.
```