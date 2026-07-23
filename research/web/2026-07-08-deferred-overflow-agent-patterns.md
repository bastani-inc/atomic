---
title: "Deferred overflow recovery patterns for agentic workflow systems"
date: 2026-07-08
researcher: "atomic research subagent"
tags:
  - llm
  - context-window
  - overflow
  - agent-workflows
  - deferred-retry
  - cancellation
  - pause-resume
  - deterministic-reduction
breaking_changes_allowed: false
sources_checked:
  - research/web/2026-07-08-context-overflow-upstream-practices.md
  - Temporal Continue-As-New, cancellation, failure detection, and message passing docs
  - LangGraph persistence, checkpoints, interrupts, and short-term memory docs
---

## Summary

When compaction/summarization is delayed, unavailable, or itself overflows, robust agent systems should treat context overflow as a **recoverable workflow-control event** until bounded deterministic reduction fails. The practical pattern is:

1. Normalize provider overflow errors.
2. Persist an overflow recovery record and pause/cancel active model work.
3. Run deterministic, non-model context reduction asynchronously under a controller/workflow lock.
4. Resume from the same workflow/thread/checkpoint only if the rendered request changed and now fits budget.
5. Mark a terminal, non-retryable error when protected context would have to be dropped, reductions are exhausted, or provider 400/413 shape remains unchanged.

This supplements the existing cache file [`2026-07-08-context-overflow-upstream-practices.md`](./2026-07-08-context-overflow-upstream-practices.md), which already covers provider error shapes, compaction constraints, and deterministic reduction order.

## Detailed Findings

### 1. Model overflow should be coordinated by the workflow controller, not the model-call retry loop

**Sources**: [Temporal failure detection](https://docs.temporal.io/develop/typescript/failure-detection), [Temporal message passing](https://docs.temporal.io/develop/typescript/message-passing), existing provider-shape cache.

**Pattern**:

- Do **not** retry identical model calls on `context_length_exceeded` / provider 400 input-size failures.
- Convert the provider exception into a typed workflow event such as `ContextOverflowDetected` containing provider, model, structured error body, request id, estimated tokens/bytes, current checkpoint/session id, and a hash of the rendered prompt.
- Let the workflow controller decide whether to pause, cancel, reduce, resume, or terminally fail.

Temporal’s failure model is a useful analogue: `ApplicationFailure` can be marked `nonRetryable` for bad-input conditions, and workflows only fail deliberately. Context overflow is closer to “bad input shape” than transient capacity, so automatic retries should be gated by an actual prompt change.

### 2. Deferred recovery needs durable pause/resume state

**Sources**: [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts), [LangGraph checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers), [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence).

LangGraph documents the relevant control-plane pattern directly: interrupts pause graph execution, save graph state with a checkpointer, and resume later using the same `thread_id`. Checkpointers are explicitly used for human-in-the-loop, memory, time travel, and fault tolerance; they persist thread state snapshots and pending writes so failed steps can resume from the last successful boundary.

**Apply to overflow recovery**:

- On overflow, persist a `recovery_pending` checkpoint containing:
  - stable workflow/thread/session id;
  - overflowing prompt hash and token estimate;
  - provider normalized error;
  - current objective/user request;
  - protected context ranges;
  - reduction attempt count and strategy cursor.
- Pause scheduling of new model turns for that workflow until the recovery task completes.
- Resume with the same workflow/thread id after reduction, not a new implicit session, unless the terminal recovery path explicitly creates a fresh continuation.

### 3. Async/deferred retry should be idempotent and deduplicated

**Sources**: [Temporal message passing](https://docs.temporal.io/develop/typescript/message-passing), [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

Temporal Updates can be accepted now and completed later; `startUpdate` returns a handle, and Update IDs are useful for deduplication across Continue-As-New. LangGraph warns that resumed interrupts restart the node from the beginning, so side effects before an interrupt must be idempotent.

**Recommended controller contract**:

- Use a stable `overflow_recovery_id = hash(workflow_id, turn_id, rendered_prompt_hash, model)`.
- If the same overflow event is observed again with the same prompt hash and same recovery id, do not enqueue duplicate recovery work.
- Use a per-workflow mutex/lease so reduction, cancellation, and resume cannot race with user input or tool-result ingestion.
- Any side effects before a pause/resume boundary must be idempotent or recorded as completed in the checkpoint.

### 4. Cancellation and pause semantics: cancel in-flight work, but preserve resumability

**Sources**: [Temporal cancellation](https://docs.temporal.io/develop/typescript/cancellation), [Temporal message passing](https://docs.temporal.io/develop/typescript/message-passing).

Temporal notes that cancellable Activities need heartbeats and heartbeat timeouts; cancellation is observed at a later opportunity, and cleanup should happen in `finally`/cancel handling. Signals are asynchronous control messages, while Updates can return a result or error after async work completes.

**Apply to agent overflow**:

- If overflow is detected after a provider error, cancel/stop any sibling speculative model calls for the same turn.
- If a summarizer/compactor call is already running and a deterministic reducer supersedes it, mark the compactor result stale by generation id rather than letting it overwrite newer reduced state.
- Expose states such as `running`, `pause_requested`, `recovery_pending`, `reducing`, `resume_ready`, `terminal_overflow`.
- User cancellation during `recovery_pending` should produce a clean cancelled state, not an unhandled retry loop.

### 5. Deterministic reduction is the emergency path when summarization cannot fit

**Sources**: existing cache summary of [Microsoft Agent Framework compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction), [LangChain short-term memory](https://docs.langchain.com/oss/python/langchain/short-term-memory).

LangChain’s short-term memory guide lists trim, delete, and summarize as long-conversation strategies. The prior cache adds the stronger agentic requirement: preserve tool-call/tool-result atomicity, system/developer messages, current request, active objective, and recent tail; collapse or drop old tool outputs before invoking any model summarizer.

**Deferred-retry reduction order**:

1. Remove repeated diagnostics/progress/token-count events.
2. Replace large historical tool outputs with deterministic stubs: tool name, status, artifact path/handle, byte/token counts, and `TRUNCATED` marker.
3. Drop stale planner scratch and obsolete search/listing results.
4. Keep recent message/tool groups as atomic units.
5. If still over budget, oldest-first truncation of non-protected groups.
6. Only then optionally run summarization for readability; never depend on summarization as the only recovery path.

### 6. Continue/fresh-history patterns map well to overflow recovery after repeated reductions

**Sources**: [Temporal Continue-As-New overview](https://docs.temporal.io/workflow-execution/continue-as-new), [Temporal TypeScript Continue-As-New](https://docs.temporal.io/develop/typescript/continue-as-new).

Temporal Continue-As-New closes the current execution and starts a fresh execution with the same Workflow ID but new Run ID and fresh history, passing latest relevant state forward. It is recommended when workflows grow long or approach event-history limits; message handlers should finish before Continue-As-New.

**Apply to context overflow**:

- If the agent transcript/event history is too large even after reduction, create a fresh continuation session containing only protected state + deterministic summary/stubs + current objective.
- Do not Continue-As-New while async handlers/recovery tasks are still mutating state; wait for handlers to finish or cancel them first.
- Preserve the old session id and artifact links for audit/debug, but make the resumed model call use the fresh reduced context.

### 7. Terminal overflow criteria

A controller should stop automatic recovery and surface a terminal error when:

- The same rendered prompt hash overflows again after a retry attempt.
- Deterministic reducers cannot meet budget without dropping protected buckets.
- The summarizer/compactor call itself overflows and no non-model reduction can create a safe summarizer input.
- A larger-window model is unavailable or still cannot fit the protected minimum plus output reserve.
- Provider returns repeated non-transient input-size failures: OpenAI 400 `context_length_exceeded`, Anthropic 400 context/window invalid request or 413 request-too-large, Gemini 400 `INVALID_ARGUMENT` token-count maximum.
- User cancels during `recovery_pending` or `reducing`.

Terminal error payload should include enough data to resume manually in a new session: workflow id, checkpoint id, request id, provider/model/error body, protected context manifest, retained artifact handles, reduction attempts, and recommended next action.

## Implementation checklist for Atomic-style agent workflows

- Normalize provider errors into `context_overflow | rate_limit | transient | auth | terminal`.
- Treat context overflow as non-transient unless rendered prompt changes.
- Persist `OverflowRecoveryState` before kicking off async reduction.
- Gate recovery with a per-workflow lock and prompt hash dedupe.
- Pause new model planning for the workflow while recovery is pending.
- Cancel or generation-mark stale compaction/summarization jobs.
- Run deterministic reducers before model summarization.
- Verify final rendered token budget before retry.
- Retry once or bounded-N after actual prompt reduction; otherwise terminal.
- Support user cancel, pause, resume, and fresh-continuation states explicitly.

## Gaps / limitations

- The prior cache has stronger provider-shape evidence than this update; this file intentionally avoids duplicating all provider details.
- Temporal and LangGraph are workflow-control analogues, not LLM-overflow-specific implementations. The patterns map well but require adaptation to Atomic’s controller/session model.
