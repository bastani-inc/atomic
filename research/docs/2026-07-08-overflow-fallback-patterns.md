I’m unable to write `/research/docs/2026-07-08-overflow-fallback-patterns.md` because this subagent only has read/search/find/ls tools and no file write/edit tool.

Key findings located for the requested research:

## Model fallback / stage retries

- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:222-295`
  - Builds model candidates and creates initial session.
  - Applies candidate model, reasoning level, context window.
  - Pins tiered models to default short context when no explicit long window is requested.

- `packages/workflows/src/runs/foreground/stage-runner-controller.ts:388-451`
  - Resume-current-session flow.
  - Retryable failure restarts fallback chain.
  - Records `modelAttempts`, warnings, success/failure metadata.

- `packages/workflows/src/runs/shared/model-fallback-candidates.ts:312-357`
  - Builds primary + fallback + current-model candidate list.
  - Handles `fallbackThinkingLevels`.
  - Deduplicates candidates.

- `packages/workflows/src/runs/shared/model-fallback-failures.ts:1-84`
  - Defines retryable/fallbackable model failure kinds:
    - auth
    - rate limit
    - provider unavailable
    - network timeout
    - transport error
    - model unavailable
    - request incompatible

- Tests:
  - `test/unit/stage-runner-model-fallback-1.test.ts:17-213`
  - `test/unit/stage-runner-model-fallback-2.test.ts:15-132`
  - `test/unit/stage-runner-fallback-resume.test.ts:1-278`
  - `test/unit/subagents-model-fallback.test.ts:18-223`

## Provider error handling / terminal errors

- `packages/coding-agent/src/core/agent-session-retry.ts:8-34`
  - `_isRetryableError` excludes context overflow.
  - Matches provider/rate-limit/network/server/transient stream failures.

- `packages/coding-agent/src/core/agent-session-retry.ts:74-153`
  - Detects empty completions and canned provider safety refusals.

- `packages/coding-agent/src/core/agent-session-retry.ts:160-233`
  - Exponential backoff retry.
  - Emits `auto_retry_start` / `auto_retry_end`.
  - Removes failed assistant from active context before retry.

- `packages/workflows/src/runs/foreground/stage-runner-messages.ts:45-77`
  - Terminal assistant failures are `stopReason:error` and `stopReason:aborted`.
  - Clean stop reasons are `stop`, `toolUse`, `length`.

- Tests:
  - `test/unit/workflow-failures-01.test.ts:21-98`
  - `test/unit/workflow-failures-01.test.ts:147-165`
  - `test/unit/workflow-failures-02.test.ts:28-69`
  - `test/unit/workflow-failures-02.test.ts:139-165`

## Context overflow / compaction

- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:9-72`
  - Checks compaction on assistant messages.
  - Skips stale pre-compaction messages.
  - Handles context overflow separately from retry.
  - Allows only one overflow recovery attempt.
  - Emits terminal overflow-recovery failure message after one failed compact-and-retry.

- `packages/coding-agent/src/core/agent-session-auto-compaction.ts:180-223`
  - Runs auto-compaction.
  - Auth is lazy.
  - Overflow without auth falls back to deterministic no-auth eviction.

- `packages/coding-agent/src/core/agent-session-compaction.ts:22-80`
  - Applies context verbatim compaction.
  - Overflow with no compactable transcript throws terminal error:
    - `Context compaction found no compactable transcript entries; nothing more was safely deletable`
  - Overflow missing auth uses deterministic eviction.

- `packages/coding-agent/src/core/agent-session-compaction.ts:83-170`
  - Extension `session_before_compact` hook.
  - Validates deletion requests.
  - Writes backup snapshot.
  - Appends context compaction entry.
  - Rebuilds active session context.

## Deterministic/non-model truncation or pruning

- `packages/coding-agent/src/core/compaction/context-compaction-eviction.ts:8-21`
  - Terminal deterministic eviction error includes budget, tokensAfter, reduction, deletion target count.

- `packages/coding-agent/src/core/compaction/context-compaction-eviction.ts:168-222`
  - Deterministic context eviction.
  - Relaxes transcript for critical eviction.
  - Protects latest assistant thinking block.
  - Bounded by `CONTEXT_COMPACTION_MAX_EVICTION_PASSES = 50`.
  - Throws terminal error when candidate sweep exhausted or pass cap reached.

- Other deterministic truncation/pruning references:
  - `crates/atomic-natives/src/glob.rs:324-365`
  - `crates/atomic-natives/src/glob.rs:412-415`
  - `crates/atomic-natives/src/grep/part_04.rs:186-188`

## Context-window / long-context fallback patterns

- `packages/workflows/src/extension/workflow-schema.ts:52-67`
  - Documents model string suffixes and context-window markers:
    - `(1m)`
    - `(long)`
    - rounded sizes like `(1.1m)`
  - `fallbackModels` schema.

- `test/unit/stage-runner-model-fallback-1.test.ts:18-45`
  - `(1m)` resolves Copilot Opus to long context window.

- `test/unit/stage-runner-model-fallback-1.test.ts:47-90`
  - Only fallback candidate receives long-context window.

- `test/unit/stage-runner-model-fallback-1.test.ts:120-147`
  - `(1m)` on single-window model keeps default short window.

- `test/unit/stage-runner-model-fallback-1.test.ts:149-210`
  - Tiered model without `(1m)` pins short window.
  - Explicit numeric `contextWindow` overrides short-tier pin.

## Docs / changelog locations

- Docs:
  - `docs/workflow-playbook.md`
  - `docs/ci.md`
  - `README.md`
  - `DESIGN.md`
  - `PRODUCT.md`

- Changelogs:
  - `packages/coding-agent/CHANGELOG.md`
  - `packages/workflows/CHANGELOG.md`
  - `packages/subagents/CHANGELOG.md`
  - `packages/mcp/CHANGELOG.md`
  - `packages/natives/CHANGELOG.md`
  - `packages/web-access/CHANGELOG.md`
  - `packages/intercom/CHANGELOG.md`