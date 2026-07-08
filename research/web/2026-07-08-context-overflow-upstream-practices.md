---
title: "Context-window overflow upstream practices for agentic LLM systems"
date: 2026-07-08
researcher: "atomic research subagent"
tags:
  - llm
  - context-window
  - context-length-exceeded
  - codex
  - openai
  - agents
  - compaction
breaking_changes_allowed: false
sources_checked:
  - OpenAI API error docs
  - OpenAI Help token limits article
  - OpenAI Responses compaction guide
  - OpenAI Python SDK source
  - OpenAI Agents SDK source/docs/issues
  - OpenAI Codex issues
  - Microsoft Agent Framework compaction docs
  - Anthropic API error/context-window docs
  - Gemini API troubleshooting/forums/issues
---

## Summary

Upstream patterns treat context-window overflow as a **deterministic request-shaping failure**, not a transient provider outage. Reliable systems detect provider-specific overflow signals (`context_length_exceeded`, 400/`invalid_request_error`, Gemini 400/`INVALID_ARGUMENT`, Anthropic 400/`invalid_request_error` or 413 byte-size failures), then either retry once after **deterministic context reduction** or escalate with actionable recovery state. Blind retries of the same payload are not useful; model-tier fallback only helps when the selected fallback has a larger effective context window or when the payload has first been reduced to fit.

For long-running agents, the strongest upstream pattern is layered, budgeted compaction: pre-count or estimate tokens; trigger before the window is near full; keep system/developer instructions and recent turns; preserve tool-call/tool-result atomicity; collapse or drop old tool outputs; summarize only when a summarizer call can itself fit; and retain an emergency non-model fallback such as sliding window/truncation when compaction/summarization cannot run.

## Detailed Findings

### Provider error shapes and reliable overflow detection

#### OpenAI API / OpenAI Python SDK

**Sources**: [OpenAI error-code guide](https://developers.openai.com/api/docs/guides/error-codes), [OpenAI token limits help article](https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them), [OpenAI Python SDK source](https://github.com/openai/openai-python)

OpenAI documents `BadRequestError` as the Python SDK class for malformed requests or invalid input, and recommends programmatic handling via SDK exception classes. The OpenAI help article states that each model has a maximum combined token limit `(input + output)` and recommends shortening prompts, chunking, summarizing, or preprocessing when exceeded.

Code-level shape in the current Python SDK:

- The SDK unwraps a response body of `{"error": {...}}` to the inner error mapping before constructing status exceptions, so callers should inspect `e.code`, `e.param`, `e.type`, `e.status_code`, and `e.body` rather than only parsing the string. [`_client.py`](https://github.com/openai/openai-python/blob/6d9262d5c666a1e4d47f63178db907ba3087ac5d/src/openai/_client.py#L666-L676):

```python
data = body.get("error", body) if is_mapping(body) else body
if response.status_code == 400:
    return _exceptions.BadRequestError(err_msg, response=response, body=data)
```

- `APIError` exposes `code`, `param`, and `type` from a JSON body; `APIStatusError` adds `status_code` and `request_id`; `BadRequestError` is status 400. [`_exceptions.py`](https://github.com/openai/openai-python/blob/6d9262d5c666a1e4d47f63178db907ba3087ac5d/src/openai/_exceptions.py#L48-L118):

```python
class APIError(OpenAIError):
    code: Optional[str] = None
    param: Optional[str] = None
    type: Optional[str]
    ...
    if is_dict(body):
        self.code = ... body.get("code")
        self.param = ... body.get("param")
        self.type = ... body.get("type")
...
class BadRequestError(APIStatusError):
    status_code: Literal[400] = 400
```

Practical OpenAI detector:

- `isinstance(error, openai.BadRequestError)` or status code `400`; and
- `error.code == "context_length_exceeded"`; or
- fallback string checks for known messages such as “maximum context length”, “input exceeds the context window”, or “requested N tokens” only when structured fields are unavailable.

#### OpenAI Responses truncation and compaction behaviors

**Sources**: [OpenAI Responses compaction guide](https://developers.openai.com/api/docs/guides/compaction), [OpenAI Python response create types](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response_create_params.py), [OpenAI Agents SDK model settings](https://github.com/openai/openai-agents-python/blob/main/src/agents/model_settings.py)

OpenAI’s typed request parameters document two server behaviors for Responses API `truncation`:

- `auto`: drop items from the beginning of the conversation to fit the model context.
- `disabled` (default): fail with a 400 when input would exceed the context window.

Source permalink: [`response_create_params.py`](https://github.com/openai/openai-python/blob/6d9262d5c666a1e4d47f63178db907ba3087ac5d/src/openai/types/responses/response_create_params.py#L280-L288):

```python
truncation: Optional[Literal["auto", "disabled"]]
"""The truncation strategy to use for the model response.

- `auto`: If the input to this Response exceeds the model's context window size,
  the model will truncate the response to fit the context window by dropping
  items from the beginning of the conversation.
- `disabled` (default): If the input size will exceed the context window size
  for a model, the request will fail with a 400 error.
"""
```

OpenAI’s current Responses API also supports `context_management` entries with compaction thresholds. The Python types expose a `ContextManagement` typed dict with `type` and `compact_threshold`. [`response_create_params.py`](https://github.com/openai/openai-python/blob/6d9262d5c666a1e4d47f63178db907ba3087ac5d/src/openai/types/responses/response_create_params.py#L300-L305):

```python
class ContextManagement(TypedDict, total=False):
    type: Required[str]
    """The context management entry type. Currently only 'compaction' is supported."""

    compact_threshold: Optional[int]
    """Token threshold at which compaction should be triggered for this entry."""
```

The Agents SDK passes both `truncation` and `context_management` through to Responses create calls. [`openai_responses.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/models/openai_responses.py#L838-L862):

```python
create_kwargs: dict[str, Any] = {
    ...
    "truncation": self._non_null_or_omit(model_settings.truncation),
    "max_output_tokens": self._non_null_or_omit(model_settings.max_tokens),
    ...
    "context_management": self._non_null_or_omit(model_settings.context_management),
}
```

The OpenAI compaction guide adds two important operational constraints:

- Server-side compaction can be enabled with `context_management=[{"type": "compaction", "compact_threshold": ...}]`; when token count crosses the threshold, the server emits an encrypted compaction item.
- The standalone `/responses/compact` endpoint itself requires that the window sent to compaction **still fits within the model’s context window**. This directly explains failure modes where compaction is attempted too late.

#### Anthropic Claude API

**Sources**: [Anthropic API errors](https://docs.anthropic.com/en/api/errors), [Claude context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)

Anthropic’s API error shape is JSON with top-level `type: "error"`, an `error` object containing `type` and `message`, and a top-level `request_id`. Its error guide maps `400` to `invalid_request_error`, `413` to `request_too_large`, `429` to `rate_limit_error`, `500` to `api_error`, `504` to `timeout_error`, and `529` to `overloaded_error`. It also states that official SDKs retry transient failures with exponential backoff twice by default.

Reliable Claude overflow detection should combine:

- HTTP 400 + `error.type == "invalid_request_error"` with messages mentioning model context/window/token maximums; and
- HTTP 413 + `error.type == "request_too_large"` for byte-size request limits, which is distinct from token context length but has the same “must reduce input” implication.

Claude docs emphasize that system prompt, messages, tool results, images/documents, tool definitions, output, and extended thinking all count toward the window.

#### Google Gemini API

**Sources**: [Gemini troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting), [Gemini CLI issue #9775](https://github.com/google-gemini/gemini-cli/issues/9775), [Google AI forum example](https://discuss.ai.google.dev/t/sorry-i-hit-a-snag-please-try-again-shortly-or-modify-your-prompt/93120/1)

Gemini’s official troubleshooting maps `400` to `INVALID_ARGUMENT` for malformed or invalid requests and `429` to `RESOURCE_EXHAUSTED` for rate limits. Real-world Gemini context overflow examples use a JSON body like:

```json
{
  "error": {
    "code": 400,
    "message": "The input token count (...) exceeds the maximum number of tokens allowed (...).",
    "errors": [{ "domain": "global", "reason": "badRequest" }],
    "status": "INVALID_ARGUMENT"
  }
}
```

Reliable Gemini detection therefore should check `error.status == "INVALID_ARGUMENT"`, HTTP 400, and message substrings such as “input token count exceeds”, “too many tokens”, or “maximum number of tokens allowed”.

### Retry and fallback strategy across model tiers

**Primary pattern**: treat context overflow as non-transient. Retry only after changing one of: input, output reserve, truncation/compaction setting, model context capacity, or request shape.

Useful fallback order:

1. **Preflight budget** before the provider call.
   - Estimate or count input tokens for the target model.
   - Reserve output/reasoning/tool schema headroom.
   - Use tier-specific model metadata rather than one global limit because context windows differ across models and account tiers.

2. **If preflight detects overflow**, avoid the doomed call.
   - Reduce deterministically first.
   - If policy allows, route to a larger-window model only if the same payload plus reserve fits that model.
   - If routing to a smaller/cheaper model, reduce first; smaller-tier fallback without reduction increases overflow likelihood.

3. **If provider returns overflow**, perform at most bounded recovery attempts.
   - Attempt 1: deterministic non-model reduction (drop/collapse bounded old context) and retry same model.
   - Attempt 2: if available and allowed, route to larger-window model or reduce to stricter budget.
   - Stop after the payload is unchanged, after a known larger model still cannot fit, or after N bounded reduction attempts.

4. **Do not apply generic exponential backoff to identical context-overflow payloads.** Backoff is appropriate for rate limits, 5xx, overloaded, network, and timeout errors, not for deterministic 400 context failures.

The OpenAI Agents SDK’s retry primitives model this separation: retry settings are opt-in; retry policies can consult normalized status/error facts; `retry_policies.never()` returns false; provider advice can hard-veto retry; network/timeouts are their own policy. [`retry.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/retry.py#L49-L100), [`retry.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/retry.py#L231-L290):

```python
class ModelRetryNormalizedError:
    status_code: int | None = None
    error_code: str | None = None
    message: str | None = None
    request_id: str | None = None
    retry_after: float | None = None
    is_network_error: bool = False
    is_timeout: bool = False
...
def never(self) -> RetryPolicy:
    def policy(_context: RetryPolicyContext) -> bool:
        return False
...
def network_error(self) -> RetryPolicy:
    def policy(context: RetryPolicyContext) -> bool:
        return context.normalized.is_network_error or context.normalized.is_timeout
```

### When to stop retrying versus escalate

Stop automatic retry and escalate when any of these are true:

- The structured error confirms deterministic overflow and the next attempt would use the same rendered prompt/window.
- The compaction/summarization request itself overflows; this means model-based recovery cannot fit without first dropping context.
- The recovery loop has already applied the configured deterministic reductions and still cannot satisfy a safe budget.
- Retrying would require dropping policy-protected content such as system/developer instructions, the current user request, safety instructions, active tool schemas, or the minimum recent-turn floor.
- The planner call overflows before an actionable plan exists and no safe reduction can preserve the current objective.
- A provider reports persistent 400/413 input-size failures; unlike 429/5xx/529, these are not transient capacity signals.

Escalation state should include provider, model, status/error code, request id, estimated rendered tokens/bytes, context-window limit used, reduction attempts already taken, largest retained sections/tool outputs, and a pointer to the transcript/session artifact needed to resume in a fresh context.

### Deterministic non-model context reduction when LLM summarization cannot run

**Sources**: [Microsoft Agent Framework compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction), [OpenAI Responses compaction guide](https://developers.openai.com/api/docs/guides/compaction)

Microsoft’s Agent Framework compaction docs are the clearest upstream pattern for non-model fallback. They separate compaction into triggers and strategies, preserve message-group atomicity, and provide non-LLM strategies:

- `ToolResultCompactionStrategy`: collapse older tool-call groups into compact readable messages without summarizing arbitrary conversation.
- `SelectiveToolCallCompactionStrategy`: exclude older tool-call groups.
- `SlidingWindowStrategy`: keep the most recent groups/turns and preserve system messages.
- `TruncationStrategy`: emergency oldest-first removal.
- `TokenBudgetComposedStrategy`: run strategies in order and includes a fallback that excludes oldest groups if the configured strategies cannot hit the token target.

Important upstream details:

- System messages are always preserved.
- Tool calls and tool results are grouped as atomic units so APIs do not receive invalid partial tool traces.
- Pipelines should put gentler strategies first and aggressive strategies last.
- A hard non-model backstop is explicitly recommended for budget satisfaction.

Recommended deterministic reduction sequence for agentic sessions:

1. Remove or externalize already-consumed large tool outputs; replace with handles, filenames, byte/token counts, and short deterministic labels.
2. Collapse old tool-call groups to fixed-format stubs, preserving tool name, success/failure, artifact path, and whether output was partial/truncated.
3. Drop obsolete planner scratch/diagnostic events and repeated token-count/progress events.
4. Keep a bounded tail of recent user/assistant/tool groups.
5. Preserve current user request, active plan/objective, system/developer instructions, safety constraints, and pending tool-call protocol pairs.
6. If still over budget, truncate oldest non-protected groups until target plus headroom is satisfied.
7. Only after this succeeds, optionally ask an LLM summarizer to improve human-readable continuity.

### Planner call overflow and automatic compaction failure patterns in Codex

**Sources**: [Codex issue #24732](https://github.com/openai/codex/issues/24732), [Codex issue #24078](https://github.com/openai/codex/issues/24078), [Codex issue #23589](https://github.com/openai/codex/issues/23589), [Codex issue #10823](https://github.com/openai/codex/issues/10823), [Codex issue #9800](https://github.com/openai/codex/issues/9800)

Codex issue reports show repeated upstream failure modes relevant to Atomic-style agent orchestration:

- **Pre-sampling compact loop**: a long Codex session entered repeated `Failed to run pre-sampling compact`; the TUI stayed alive but no usable new turn landed. The reporter’s metrics included ~224k input tokens, ~43.5 MB session JSONL, thousands of tool-call/tool-output events, and hundreds of large tool outputs. The requested behavior included emergency aggressive compaction, dropping/summarizing large historical tool outputs, actionable TUI state, and clearer telemetry.
- **Remote compact `context_length_exceeded`**: several issues show `/compact` or remote compact tasks failing with OpenAI-shaped errors: `{"type":"invalid_request_error","param":"input","code":"context_length_exceeded"}`.
- **Too-late compaction**: issue discussion notes that attempting compaction at ~95%+ context can leave no safe compression budget. This aligns with OpenAI’s standalone compaction guide constraint that the compact input must still fit the model window.

Actionable upstream pattern from these issues: compaction needs an early trigger and a non-model emergency path. If the compact call itself overflows, retrying the same compact call can strand the session; systems should switch to deterministic reduction or escalate to a recoverable fresh-session workflow.

### OpenAI Agents SDK context and session patterns

**Sources**: [OpenAI Agents SDK runner docs/source](https://openai.github.io/openai-agents-python/ref/run/), [OpenAI Agents SDK session settings source](https://github.com/openai/openai-agents-python/blob/main/src/agents/memory/session_settings.py), [OpenAI Agents SDK issue #1093](https://github.com/openai/openai-agents-python/issues/1093), [OpenAI Agents SDK issue #1494](https://github.com/openai/openai-agents-python/issues/1494)

The Agents SDK has multiple context-management hooks but no universal long-context abstraction that automatically prevents every overflow:

- `Runner.run`/`run_sync` include `max_turns`; exceeding it raises `MaxTurnsExceeded`, which is a loop-safety boundary rather than a token budget. [`run.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/run.py#L314-L330):

```python
In two cases, the agent may raise an exception:

  1. If the max_turns is exceeded, a MaxTurnsExceeded exception is raised unless handled.
...
max_turns: The maximum number of turns to run the agent for. A turn is
    defined as one AI invocation (including any tool calls that might occur).
```

- Sessions are for automatic conversation history management, and `SessionSettings.limit` can cap retrieved items. This is a deterministic item-count limiter, not token-aware by itself. [`session_settings.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/memory/session_settings.py#L12-L33):

```python
def resolve_session_limit(explicit_limit: int | None, settings: SessionSettings | None) -> int | None:
    if explicit_limit is not None:
        return explicit_limit
    if settings is not None:
        return settings.limit
    return None
...
limit: int | None = None
"""Maximum number of items to retrieve. If None, retrieves all items."""
```

- `ModelSettings` exposes `truncation`, `max_tokens`, `retry`, and `context_management`. [`model_settings.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/model_settings.py#L120-L127), [`model_settings.py`](https://github.com/openai/openai-agents-python/blob/163caa3aa833235ba9ec35799cf63cd890b0c05d/src/agents/model_settings.py#L184-L192):

```python
truncation: Literal["auto", "disabled"] | None = None
"""The truncation strategy to use when calling the model."""
...
context_management: list[ContextManagement] | None = None
"""Context management entries for OpenAI Responses API requests.

For example, use ``[{"type": "compaction", "compact_threshold": 200000}]``
to enable server-side compaction when the rendered context crosses a token threshold.
"""
```

Open issue #1093 requests better handling for long contexts in the Agents SDK and shows an OpenAI-shaped overflow payload:

```json
{
  "error": "Error code: 400 - {'error': {'message': 'Your input exceeds the context window of this model. Please adjust your input and try again.', 'type': 'invalid_request_error', 'param': 'input', 'code': 'context_length_exceeded'}}"
}
```

Open issue #1494 highlights production ambiguity between `truncation="auto"` and `truncation="disabled"`, including the risk that `disabled` fails with `context_length_exceeded` while `auto` silently drops earlier context.

## Best-practice synthesis

### Detection checklist

- Normalize provider exceptions into: provider, HTTP status, provider error type/status, provider error code, param, message, request id, retry-after, streaming/non-streaming.
- Classify as `context_overflow` when:
  - OpenAI: 400 + `code == "context_length_exceeded"` or known context-window message.
  - Anthropic: 400 + `invalid_request_error` with context/token message, or 413 `request_too_large` for byte-size overflow.
  - Gemini: 400 + `INVALID_ARGUMENT` with token-count/maximum-token message.
- Preserve original structured body for support/debugging.
- Do not rely on message-only matching when structured fields exist; use message matching as a fallback for SDKs/proxies that wrap errors.

### Retry/fallback checklist

- Never retry an identical context-overflow request blindly.
- Retry only after deterministic reduction, a larger-window model switch, reduced output budget, or server truncation/compaction setting change.
- Keep retry count low and record whether rendered input actually changed.
- Prefer early compaction thresholds (well below the window) to preserve compaction budget.
- Treat compact/planner overflow as a recovery-path failure: perform emergency non-model reduction or escalate.

### Deterministic reduction checklist

- Preserve protected buckets: system/developer instructions, current user request, active objective/plan, safety constraints, tool schemas required for the next turn, pending tool-call pairs, and recent tail.
- Reduce expendable buckets first: old verbose tool outputs, progress/token-count events, old planner scratch, repeated diagnostics, stale search/listing results.
- Preserve tool-call atomicity; never send an assistant tool call without its corresponding tool result or vice versa unless converted to a plain summary/stub.
- Use explicit PARTIAL/TRUNCATED markers and continuation handles for tool output so the agent can fetch more later.
- Maintain token/byte telemetry for each bucket and the final rendered request.

## Additional Resources

- [OpenAI API error codes](https://developers.openai.com/api/docs/guides/error-codes) — official API/SDK error classes and retry guidance for transient errors.
- [OpenAI Responses compaction](https://developers.openai.com/api/docs/guides/compaction) — server-side and standalone compaction patterns and constraints.
- [OpenAI Help: tokens and token limits](https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them) — combined input/output limits and counting guidance.
- [Microsoft Agent Framework compaction](https://learn.microsoft.com/en-us/agent-framework/agents/conversations/compaction) — upstream layered compaction strategies with non-model backstops.
- [Anthropic API errors](https://docs.anthropic.com/en/api/errors) — official error shape, retry behavior, request IDs, and 413 request size limits.
- [Gemini API troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting) — official HTTP/status mapping for Gemini API errors.
- [Codex #24732](https://github.com/openai/codex/issues/24732) — concrete pre-sampling compact failure loop with large tool-output history.
- [OpenAI Agents SDK #1093](https://github.com/openai/openai-agents-python/issues/1093) — request for better long-context error handling abstraction.
- [OpenAI Agents SDK #1494](https://github.com/openai/openai-agents-python/issues/1494) — truncation documentation ambiguity in production.

## Gaps or Limitations

- Some provider pages are JS-heavy; Anthropic content was retrieved via Markdown `Accept` fallback, while Gemini official troubleshooting was corroborated through search result snippets and public issue examples.
- Codex issues document observed behavior and requested fixes, not necessarily accepted/implemented upstream design.
- Exact model context windows change frequently and can vary by model version and usage tier; production systems should query/maintain current model metadata rather than hardcoding values from this report.
