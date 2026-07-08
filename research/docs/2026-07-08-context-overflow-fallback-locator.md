I’m unable to write to `/Users/tonystark/Documents/projects/atomic-context-overflow-fallback/research/docs/2026-07-08-context-overflow-fallback-locator.md` because no file write/edit tool is available in this session.

Below is the markdown content for that file:

```markdown
# Context Overflow / Fallback Locator

Research date: 2026-07-08  
Scope: `packages/coding-agent/src`, `packages/workflows`  
Node modules: no live `node_modules/@earendil-works/pi-ai` source was present in this checkout; upstream dependency locations were not locatable locally.

## packages/coding-agent/src

### Context overflow detection and auto-compaction

- `packages/coding-agent/src/core/agent-session-auto-compaction.ts`
  - Lines 1-5: imports `isContextOverflow`, compaction helpers.
  - Lines 43-46: consumes `isContextOverflow(...)` to trigger overflow compaction.
  - Lines 170-172: post-compaction continuation failure message.
  - Lines 211-214: uses backup label `overflow-auto-compact`.
  - Lines 232-245: auto-compaction / overflow recovery failure messages.

- `packages/coding-agent/src/core/agent-session-retry.ts`
  - Lines 1-3: imports `isContextOverflow`.
  - Lines 12-13: prevents retry when assistant message is context overflow.

- `packages/coding-agent/src/core/compaction/context-compaction-runner.ts`
  - Lines 2-3: imports `isContextOverflow`.
  - Lines 41-42: compaction max turn / planner nudge caps.
  - Lines 112-113: wraps compaction failure message for overflow classification.
  - Lines 164-166: abort failure path.
  - Lines 191-195: compaction turn cap stop stream.
  - Lines 213-214: planner nudge cap.
  - Lines 228-230: request failure wrapping.
  - Lines 237-247: terminal compaction failure handling.
  - Lines 249-251: failure when planner/tool calls were not made.
  - Lines 268-271: target failure message builder.

### `context_compaction` entry creation, persistence, replay, and events

- `packages/coding-agent/src/core/agent-session-compaction.ts`
  - Lines 171-176: documents persisted `context_compaction` observation hook.
  - Lines 246-247: compaction failure event message.
  - Lines 264-286: manual `context_compaction_start` / `context_compaction_end`.
  - Lines 296-302: manual context compaction failure event message.

- `packages/coding-agent/src/core/agent-session-types.ts`
  - Lines 36-37: `context_compaction_start` event type.
  - Lines 55-58: `context_compaction_end` event type.

- `packages/coding-agent/src/core/session-manager-entries.ts`
  - Lines 118-122: creates `context_compaction` session entry.

- `packages/coding-agent/src/core/session-manager-history.ts`
  - Lines 17-18: finds latest `context_compaction`.
  - Lines 26-40: builds deletion filters from persisted entries.
  - Lines 111-147: replay / safety repair paths for `context_compaction`.

- `packages/coding-agent/src/core/session-manager-types.ts`
  - Lines 92-96: `ContextCompactionEntry` interface.

- `packages/coding-agent/src/core/provider-context-usage.ts`
  - Lines 7-9: consumes latest `context_compaction`.

- `packages/coding-agent/src/modes/interactive/components/chat-session-host-events.ts`
  - Lines 89-90: handles `context_compaction_start`.
  - Lines 107-111: handles `context_compaction_end`.

- `packages/coding-agent/src/modes/interactive/interactive-agent-events.ts`
  - Lines 336-357: interactive UI handling for context compaction events.

### Compaction planner prompts, tools, and failure-related constants

- `packages/coding-agent/src/core/compaction/context-compaction-prompt.ts`
  - Lines 19-21: `CONTEXT_COMPACTION_SYSTEM_PROMPT`.
  - Lines 35-42: prompt references `context_compaction_budget` and completion gate.
  - Lines 50-51: stale image context guidance.

- `packages/coding-agent/src/core/compaction/context-compaction-critical.ts`
  - Lines 56-60: `CONTEXT_COMPACTION_CRITICAL_OVERFLOW_PROMPT`.

- `packages/coding-agent/src/core/compaction/context-deletion-tool-definitions.ts`
  - Lines 10-11: `context_read_entry`, `context_compaction_budget` tool names.
  - Lines 146-149: `CONTEXT_COMPACTION_BUDGET_TOOL`.

- `packages/coding-agent/src/core/compaction/context-deletion-tools.ts`
  - Lines 3-4: imports `CONTEXT_COMPACTION_AUTO_QUERY`.
  - Lines 76-79: compaction parameters and fallback query.
  - Lines 461-465: budget tool implementation entry.

- `packages/coding-agent/src/core/compaction/context-compaction-eviction.ts`
  - Lines 8-10: max eviction pass constant.
  - Lines 189-218: eviction pass cap terminal error.

- `packages/coding-agent/src/core/compaction/context-compaction-types.ts`
  - Lines 5-8: prompt version and parameters.
  - Lines 67-70: result shape.
  - Lines 80-83: default compression, target reduction, preserve recent, auto query.

- `packages/coding-agent/src/core/compaction/context-compaction-strategy.ts`
  - Lines 1-9: imports/default query max chars.
  - Lines 21-30: normalize query fallback.
  - Lines 41-42: transcript parameter fallback.

- `packages/coding-agent/src/core/compaction/context-compaction.ts`
  - Lines 1-7: barrel exports for context compaction constants/types.

- `packages/coding-agent/src/core/compaction/context-transcript-analysis.ts`
  - Lines 15-17: imports compaction types/default query.
  - Lines 188-195: skips `context_compaction` entries and derives query.
  - Lines 227-235: excludes `context_compaction` entries from protected/message set.

- `packages/coding-agent/src/core/compaction/branch-summarization.ts`
  - Lines 177-178: skips `context_compaction`.

### Copilot model fallback tiers / context-window tiers

- `packages/coding-agent/src/core/copilot-model-static-fallbacks.ts`
  - Lines 12-18: documents CAPI tier mismatch and overflow recovery relevance.
  - Lines 26-31: documents `contextWindowOptions` long-context tiers.
  - Lines 39-41: `StaticCopilotModelFallback` type.
  - Lines 44-58: long-tier fallback constants.
  - Lines 60-63: static fallback map begins.

- `packages/coding-agent/src/core/model-registry-builtins.ts`
  - Lines 9-12: imports context-window and static fallback helpers.
  - Lines 50-55: applies Copilot thinking level map.
  - Lines 58-73: applies Copilot context window options with static fallback tiers.
  - Lines 118-126: model override handling for thinking/context windows.

## packages/workflows

### Fallback model candidate parsing, `fallbackThinkingLevels`, and context-window tiers

- `packages/workflows/src/runs/shared/model-fallback-candidates.ts`
  - Lines 1-7: imports context-window helpers and workflow types.
  - Lines 10-25: `WorkflowResolvedModelCandidate` with reasoning/context window.
  - Lines 28-39: candidate construction.
  - Lines 43-72: context-window token extraction docs and function start.
  - Lines 61-66: accepted long-context token forms.

- `packages/workflows/src/runs/shared/model-fallback.ts`
  - Lines 1-2: exports fallback candidate/failure modules.

- `packages/workflows/src/runs/foreground/stage-runner-controller.ts`
  - Lines 1-3: imports model fallback builders/classifiers.
  - Lines 22-35: state for thinking level and fallback warnings.
  - Lines 45-46: detects explicit model/fallback config.
  - Lines 105-110: `promptWithFallback`.
  - Lines 129-130: records selected fallback model.
  - Lines 152-155: model fallback metadata.
  - Lines 225-227: passes `fallbackModels` and `fallbackThinkingLevels`.
  - Lines 242-246: applies resolved model, thinking level, context window; clears fallback options.

- `packages/workflows/src/runs/foreground/stage-runner-types.ts`
  - Lines 57-58: stage session create options include `fallbackModels` / `fallbackThinkingLevels`.

- `packages/workflows/src/runs/foreground/stage-runner-options.ts`
  - Lines 16-18: strips workflow-only fallback options.

- `packages/workflows/src/runs/foreground/executor-direct-helpers.ts`
  - Lines 37-55: validates direct task model/fallback requests.
  - Lines 429-440: checks explicit fallback candidates for fast mode.

- `packages/workflows/src/runs/foreground/executor-stage-call.ts`
  - Lines 114-120: eager session behavior with explicit model/fallback config.

- `packages/workflows/src/runs/foreground/stage-runner-context.ts`
  - Lines 83-87: complete options validation includes `fallbackModels`.

- `packages/workflows/src/extension/runtime-direct.ts`
  - Lines 65-70: collects direct model/fallback requests.

- `packages/workflows/src/extension/wiring.ts`
  - Lines 169-171: strips `fallbackModels` from session options.
  - Lines 297-298: agent session create signature includes `fallbackModels`.

- `packages/workflows/src/extension/workflow-schema.ts`
  - Lines 52-53: model/context-window schema docs.
  - Lines 66-67: `fallbackModels` and `fallbackThinkingLevels` schema fields.

### Model fallback failure classification, including context overflow/request incompatibility

- `packages/workflows/src/runs/shared/model-fallback-failures.ts`
  - Lines 47-69: failure kind/source/signal types.
  - Lines 76-79: fallbackable failure kinds set.
  - Lines 160-163: HTTP status mapping includes 400/413/422.
  - Lines 180-210: refusal/request-incompatible code classification.
  - Lines 296-309: transport/refusal/message classification.
  - Lines 325-352: signal construction/direct message fallback classification.

### Builtin workflow fallback model chains

- `packages/workflows/builtin/deep-research-codebase-utils.ts`
  - Lines 38-42: planner/reviewer fallback chain.
  - Lines 61-65: worker/research fallback chain.

- `packages/workflows/builtin/goal-runner.ts`
  - Lines 99-103: worker fallback chain.
  - Lines 117-121: reviewer fallback chain.

- `packages/workflows/builtin/open-claude-design-runner.ts`
  - Lines 81-85: fallback chain.

- `packages/workflows/builtin/ralph-models.ts`
  - Lines 19-23: prompt engineer/reviewer fallback chain.
  - Lines 38-42: orchestrator fallback chain.
  - Lines 56-60: reviewer-a fallback chain.
  - Lines 75-79: reviewer-b fallback chain.
  - Lines 95-99: reviewer-c fallback chain.
  - Lines 115-119: additional reviewer/fallback chain.

- `packages/workflows/builtin/goal-review.ts`
  - Lines 55-56: reviewer fallback recovery message.

- `packages/workflows/builtin/ralph-core.ts`
  - Lines 215-216: reviewer fallback recovery message.

### Documentation and changelog

- `packages/workflows/README.md`
  - Lines 327-375: model fallback documentation and examples.
  - Lines 585-586: direct workflow/session options list includes `fallbackModels`.
  - Lines 757-770: reasoning suffix docs and `fallbackThinkingLevels`.

- `packages/workflows/CHANGELOG.md`
  - Lines 68-71: request/context incompatibility fallback fix.
  - Lines 84-86: builtin fallback reasoning/tier changes.
  - Lines 96-102: missing fallback candidate and context-window overflow fallback fix.
  - Lines 125-126: transport fallback metadata.
  - Lines 163-164: OpenRouter fallback coverage.
  - Lines 294-306: model fallback runtime notes.
  - Lines 355-362: context-window authoring token and long-context workflow fallback tiers.
  - Lines 371-373: model fallback misreport/follow-up fixes.
  - Lines 408-409: structured-output fallback behavior.
  - Lines 499-511: upgraded fallback tiers and warning suppression.
  - Lines 567-586: fallback tier upgrades and warning suppression.
  - Lines 644-645: suffix-first reasoning levels and `fallbackThinkingLevels`.
```
