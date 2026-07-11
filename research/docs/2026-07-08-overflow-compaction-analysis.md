I’m unable to write the requested file because this session only exposes read/search/list/todo tools, not an edit/write tool. Below is the exact Markdown content intended for:

`/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-overflow-compaction-analysis.md`

```markdown
# Overflow Compaction Analysis — 2026-07-08

## Analysis: Context Overflow Handling and Compaction

### Overview

Atomic’s editable code detects provider context overflow through upstream `@earendil-works/pi-ai/compat`’s `isContextOverflow`, then routes matching assistant errors into auto-compaction with reason `"overflow"`. The editable Atomic compaction path prepares a deletion-only transcript, runs a planner with context deletion tools, optionally falls through critical/eviction recovery, writes a `.bak` snapshot, appends a `context_compaction` entry, and rebuilds active context from logical deletion filters.

### Editable vs Upstream-only Locations

- **Editable in this repo**
  - `packages/coding-agent/src/core/agent-session-auto-compaction.ts` — overflow detection dispatch and auto-compaction orchestration.
  - `packages/coding-agent/src/core/agent-session-compaction.ts` — compaction application, backup writing, persistence, rebuild.
  - `packages/coding-agent/src/core/compaction/*` — transcript preparation, planner loop, deletion validation, stats, deterministic eviction.
  - `packages/coding-agent/src/core/session-manager-*` — `context_compaction` entry shape, backup snapshot writing, active-context rebuild.
  - `packages/coding-agent/src/core/copilot-errors.ts` — editable Copilot prompt-limit parser/formatter.
  - `packages/workflows/src/runs/shared/model-fallback-failures.ts` — editable workflow model-fallback error classification.

- **Upstream-only / dependency surface**
  - `isContextOverflow`, `streamSimple`, `Agent`, `AssistantMessage`, `Model`, and provider streaming behavior come from `@earendil-works/pi-ai/compat` / `@earendil-works/pi-agent-core` imports (`packages/coding-agent/src/core/agent-session-auto-compaction.ts:1-2`, `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:1-3`).
  - These packages are declared as dependencies, not local source, at `packages/coding-agent/package.json:82-84`.

### Entry Points

- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:9-104` — `_checkCompaction()` decides overflow vs threshold compaction after assistant messages.
- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:180-250` — `_runAutoCompaction()` emits events, resolves planner auth, and calls compaction application.
- `packages/coding-agent/src/core/agent-session-compaction.ts:22-196` — `_applyContextVerbatimCompaction()` prepares, validates/runs planner, writes backup, appends `context_compaction`, rebuilds active messages.
- `packages/coding-agent/src/core/compaction/context-compaction-runner.ts:299-360` — `contextCompact()` planner ladder: standard planner, feasible acceptance, critical pass, deterministic eviction.
- `packages/coding-agent/src/core/compaction/context-compaction-eviction.ts:168-222` — deterministic overflow eviction fallback.

### Provider Error Parsing and `isContextOverflow`

- Atomic imports `isContextOverflow` from upstream `@earendil-works/pi-ai/compat` in both normal auto-compaction and planner-overflow handling (`agent-session-auto-compaction.ts:1-2`, `context-compaction-runner.ts:1-3`).
- `_checkCompaction()` only treats an assistant message as an overflow candidate when the assistant message provider/model matches the current selected model (`agent-session-auto-compaction.ts:16-24`) and `isContextOverflow(assistantMessage, contextWindow)` returns true (`agent-session-auto-compaction.ts:43`).
- Copilot server-cap parsing is implemented locally: `parseCopilotPromptLimitError()` matches `prompt token count of X exceeds the limit of Y`, strips commas, and returns numeric prompt/limit values (`copilot-errors.ts:1-23`).
- `_isCopilotServerCapBelowSelectedContextWindow()` uses that parser and compares the parsed server limit to `getEffectiveInputBudget(this.model)`; if the server cap is below the selected effective input budget, overflow auto-compaction is skipped and the friendly error remains visible (`agent-session-auto-compaction.ts:107-114`).
- Workflow/subagent fallback classification separately treats HTTP `400`, `413`, and `422` as `request_incompatible` (`packages/workflows/src/runs/shared/model-fallback-failures.ts:160-164`), includes codes such as `context_length_exceeded`, `too_large`, and `context_window_exceeded` (`model-fallback-failures.ts:201-208`), and matches message patterns for context length/window, max context/tokens, request too large, invalid request, and bad request (`model-fallback-failures.ts:267-278`).

### Overflow Auto-compaction Flow

1. `_checkCompaction()` skips disabled compaction, aborted assistant messages, stale pre-compaction messages, and mismatched model errors (`agent-session-auto-compaction.ts:9-34`).
2. For same-model overflow, it computes `willRetry = assistantMessage.stopReason !== "stop"` (`agent-session-auto-compaction.ts:43-48`).
3. If an overflow retry has already been attempted for the current user message, it emits `compaction_end` with a terminal recovery message and does not compact again (`agent-session-auto-compaction.ts:50-60`).
4. On first retryable overflow, it sets `_overflowRecoveryAttempted = true`, removes the trailing assistant error from live agent state, then calls `_runAutoCompaction("overflow", willRetry)` (`agent-session-auto-compaction.ts:63-70`).
5. `_runAutoCompaction()` emits `compaction_start`, creates an abort controller, resolves auth lazily, passes backup label `"overflow-auto-compact"`, and calls `_applyContextVerbatimCompaction()` (`agent-session-auto-compaction.ts:180-214`).
6. After successful compaction, retry paths drop trailing `"error"` or `"length"` assistant messages, emit `compaction_end`, and schedule continuation (`agent-session-auto-compaction.ts:226-231`; trailing assistant removal at `agent-session-auto-compaction.ts:125-132`).
7. Continuation calls `_runAgentContinue()` and surfaces failures as `agent_continue_error` with source `"post_compaction"` (`agent-session-auto-compaction.ts:165-173`).

### `context_compaction` Application and Backup Writing

- `_applyContextVerbatimCompaction()` reads the current branch and settings, then calls `prepareContextCompaction()` with configured or supplied parameters (`agent-session-compaction.ts:34-40`).
- If no preparation exists, overflow throws `"Context compaction found no compactable transcript entries; nothing more was safely deletable"` while non-overflow returns `undefined` (`agent-session-compaction.ts:41-48`).
- Overflow ladder options use `getEffectiveInputBudget(model)` as both `acceptanceTokenBudget` and `criticalEvictionTokenBudget`; threshold uses `effectiveBudget - settings.reserveTokens` (`agent-session-compaction.ts:49-61`).
- Missing planner auth during overflow bypasses model planning and calls deterministic eviction directly; missing auth during threshold returns `undefined` (`agent-session-compaction.ts:63-80`).
- Backup is written immediately before appending the `context_compaction` entry (`agent-session-compaction.ts:153-159`).
- `writeBackupSnapshot()` only writes when sessions are persisted, delegating to `createBackupSnapshot()` (`session-manager-core.ts:262-265`).
- `createBackupSnapshot()` sanitizes the label, builds a path of `${sessionFile}.${timestamp}.${safeLabel}.bak`, and writes all current file entries to that backup path (`session-manager-archive.ts:19-29`).
- `appendContextCompaction()` creates and appends a `context_compaction` entry with deleted targets, protected entry ids, stats, and backup path (`session-manager-core.ts:250-259`; entry shape at `session-manager-entries.ts:110-127`).
- After append, `_applyContextVerbatimCompaction()` rebuilds active context and replaces `agent.state.messages` (`agent-session-compaction.ts:160-162`).

### Token and Object Reduction Accounting

- Usage-based active context tokens are calculated by `calculateContextTokens()`: it clamps input/output/cache fields to non-negative values, handles cache mirroring, and returns prompt tokens plus output tokens (`compaction.ts:37-49`).
- Error/heuristic threshold estimates use `estimateContextTokens()`, anchored at the last valid assistant usage and adding estimated trailing tokens (`compaction.ts:98-125`).
- `shouldCompact()` triggers when `contextTokens > contextWindow - reserveTokens` (`compaction.ts:131-134`), with default reserve `16384` (`compaction.ts:20-25`).
- Transcript preparation estimates per-entry tokens with `estimateTokens(message)` and sums them into `transcript.tokensBefore` (`context-transcript-analysis.ts:250-275`).
- Image blocks use a shared estimate of `ESTIMATED_IMAGE_TOKENS = ceil(4800 / 4) = 1200` (`compaction.ts:137-147`), and transcript content-block estimation returns this value for image blocks (`context-transcript-analysis.ts:97-102`).
- `computeContextCompactionStats()` adds full entry token estimates for entry deletions and content-block estimates for block deletions, counts deleted objects as one entry plus its content blocks for entry deletions or one object for a block deletion, then computes:
  - `tokensAfter = max(0, tokensBefore - deletedTokens)`
  - `percentReduction = rounded one-decimal reduction`
  - `objectsBefore`, `objectsAfter`, `objectsDeleted`
  (`context-deletion-application.ts:176-214`).

### Post-compaction Below-window Checks

- The acceptance checks that gate automatic results compare `result.stats.tokensAfter` to an acceptance budget before commit:
  - `feasibleAccepted()` requires at least one deleted target and `stats.tokensAfter <= acceptanceTokenBudget` (`context-compaction-runner.ts:116-125`).
  - `acceptedWithinRun()` uses the acceptance budget when supplied, otherwise strict compression target (`context-compaction-runner.ts:128-135`).
  - `targetMetAcceptedForLadder()` additionally requires overflow ladder results to be `tokensAfter <= criticalEvictionTokenBudget` when that budget exists (`context-compaction-runner.ts:137-145`).
- Overflow passes `effectiveBudget` as the acceptance/critical budget (`agent-session-compaction.ts:49-54`), where `getEffectiveInputBudget()` uses `min(model.contextWindow, model.maxInputTokens)` when a smaller hard input cap exists (`context-window.ts:107-117`).
- After persistence, the code rebuilds active messages (`agent-session-compaction.ts:160-162`) but does not perform a second provider-tokenization or actual provider-window check before emitting success. The committed check is the validated transcript estimate (`stats.tokensAfter`) compared to the effective budget.

### Planner Failure Path When Planner Call Overflows

- The planner loop uses an internal `Agent` with context-deletion tools and calls upstream `streamSimple()` for each provider turn (`context-compaction-runner.ts:175-204`).
- Provider planner turns are capped at `CONTEXT_COMPACTION_MAX_TURNS = 50` (`context-compaction-runner.ts:41-42`, enforcement at `context-compaction-runner.ts:191-197`).
- Planner nudge follow-ups are capped at `CONTEXT_COMPACTION_MAX_PLANNER_NUDGES = 50` (`context-compaction-runner.ts:41-42`, enforcement at `context-compaction-runner.ts:207-222`).
- If the planner agent finishes with `agent.state.errorMessage`, the runner formats it and tests `isContextCompactionOverflowError()`, which wraps the error string into a synthetic assistant message and calls upstream `isContextOverflow()` (`context-compaction-runner.ts:112-114`, `context-compaction-runner.ts:237-248`).
- If the planner error is classified as context overflow, the runner returns the current validated deletion state, last tool error, and formatted provider error instead of throwing (`context-compaction-runner.ts:238-245`).
- In the outer ladder, the standard planner result is accepted if it meets strict/feasible budget; otherwise it is recorded as an attempt and overflow mode proceeds to critical compaction (`context-compaction-runner.ts:314-327`).
- Critical compaction relaxes eligible protected stale entries, appends critical prompt guidance, and runs the planner again with `acceptanceTokenBudget = ladder.criticalEvictionTokenBudget` (`context-compaction-runner.ts:329-347`).
- If critical planning does not return a feasible result, the ladder falls back to `runDeterministicContextEviction()` (`context-compaction-runner.ts:354-359`).
- Deterministic eviction traverses finite candidate phases and a deduplicated alternate-boundary search that retains at most 16 states per boundary. It returns only when a validated deletion result has at least one deletion and `stats.tokensAfter <= tokenBudget`; otherwise the finite phase/state search terminates with exhaustion.
- Terminal deterministic eviction errors include achieved `tokensAfter`, reduction percent, deletion target count, budget, and “nothing more was safely deletable” text (`context-compaction-eviction.ts:10-20`).
```
