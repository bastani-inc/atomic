# GPT-5.6 prompting and migration

Use this reference for the GPT-5.6 family. Guidance checked on September 5, 2026 against [OpenAI's GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6). Keep these defaults separate from [GPT-6 Astra](gpt_6_astra.md) and [GPT-5.5](gpt_5_5.md).

## Start with the workload and a lean contract

The `gpt-5.6` alias routes to `gpt-5.6-sol` for flagship capability. The guide positions `gpt-5.6-terra` for a balance of quality and price and `gpt-5.6-luna` for efficient, high-volume work. Evaluate the chosen variant on the actual workload; these API names do not establish availability in an agent's configured catalog.

State the outcome, success criteria, domain context, approval boundaries, and required evidence. Let the model choose routine steps. When simplifying a working prompt, remove one group of repeated instructions, examples, or tools at a time and rerun the same cases. Keep examples that encode product requirements or correct a measured gap. Check context growth across long sessions as well as initial prompt size.

OpenAI reports roughly 10–15% higher scores, 41–66% fewer total tokens, and 33–67% lower cost for leaner prompts in a sample of internal coding-agent evaluations. These are workload-dependent observations, not expected gains for every application.

## Define action boundaries once

Distinguish answering, reviewing, or diagnosing from implementing. Name authorized local work and the final action separately. Repeated "ask first" rules can block expected progress; missing approval for an external, destructive, costly, or scope-expanding action still matters.

```text
For review requests, inspect the relevant materials and report findings without editing. For requests to fix or build, make the requested local changes and run relevant non-destructive checks. Continue work already authorized in this conversation. Ask before actions outside that authority, including destructive operations or unapproved external writes. Stop when the requested result and required checks are complete, or name the blocking decision.
```

## Control brevity without losing content

GPT-5.6 tends to be more concise than GPT-5.5. Reevaluate inherited "keep it short" instructions if answers lose evidence, caveats, or next steps. Set `text.verbosity` to `low`, `medium`, or `high` for the request default, then specify task-specific length and required content.

```text
Lead with the conclusion. Retain required facts, decisions, evidence, material caveats, and the next action. Trim introductions, repetition, generic reassurance, and secondary detail first. Acknowledge a reported problem specifically; omit generic praise and sign-offs.
```

## Effort, pro mode, and state

Use Responses for reasoning, tool-calling, and multi-turn work. Verify provider and SDK support before adopting these controls.

| Control | Guidance |
| --- | --- |
| Reasoning effort | Supported values are `none`, `low`, `medium`, `high`, `xhigh`, and `max`; the default is `medium`. Preserve the current GPT-5.5/5.4 effort on migration, then compare one level lower. If starting at `none`, retain that latency baseline and test `low` for reasoning or tool work. |
| Higher effort | Use `high` or `xhigh` for measured quality gains. Reserve `max` for the hardest quality-first work; compare it against `xhigh` rather than assuming more effort is better. |
| Pro mode | Keep the selected model and set `reasoning.mode: "pro"`; do not invent a separate Pro model slug. Effort is independent and defaults to `medium` in standard and pro modes. Pro increases latency and bills the aggregated model work. Compare it with standard mode at the same model and effort. |
| Persisted reasoning | GPT-5.6 defaults to `all_turns`. Omit `reasoning.context` or use `auto`, and inspect the effective response value. Use `all_turns` for stable goals and `current_turn` when earlier reasoning is no longer relevant. |
| Continuations | With `all_turns`, use `previous_response_id`. For manual history, preserve prior user inputs and every response output item. With `store: false` or Zero Data Retention, replay the returned encrypted reasoning items. |
| Caching | Implicit caching remains available. Cache writes cost 1.25 times uncached input; track `cached_tokens` and `cache_write_tokens`. Use explicit breakpoints or `prompt_cache_options.mode: "explicit"` when useful, and replace `prompt_cache_retention` with `prompt_cache_options.ttl`. |

Pro mode is an API setting, not a request to narrate private reasoning or generate several visible answers. Keep the same outcome-focused prompt and compare completeness, evidence, cost, and latency.

## Choose programmatic tool calling by task shape

Use Programmatic Tool Calling for a bounded stage that filters, joins, ranks, deduplicates, aggregates, or validates large tool results into a smaller structured result. Multiple calls alone do not justify it. Prefer direct calls when one call is enough, outputs are small, each result changes the next decision, approval is needed, or citations/native artifacts must remain visible.

Name the eligible tools, documented input/output fields, output schema, evidence requirements, retry/concurrency limits, and stop condition. If return shapes are unknown, inspect them through direct calls first. When combining routes, define one handoff and prohibit duplicate completed actions.

The application must enable `programmatic_tool_calling`, opt tools in through `allowed_callers`, handle `program` and `program_output` items, and preserve `call_id` and `caller` linkage. Validate both the program's result and the final assistant answer; correct records are insufficient if the answer drops a required citation or caveat. Consult the [PTC guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling) before implementation.

The Responses multi-agent beta can coordinate independent workstreams and synthesize results. Treat it separately from an agent harness's own subagents. Prompt text does not enable hosted PTC, pro mode, persisted reasoning, or multi-agent support in Atomic.

## Images and streaming safeguards

With `original` or `auto` image detail, GPT-5.6 preserves dimensions unless a side exceeds 65,535 pixels, then scales to that limit. Images still over the 30,000-patch limit are rejected rather than resized to fit. Choose detail deliberately and validate image size, latency, and token cost; do not carry GPT-5.5's image limits forward.

The guide notes real-time cyber/biology safeguards can refuse requests or pause generation for several seconds. Handle refusals and streaming delays honestly; do not treat them as a reason to evade safeguards. For individual end users, send a stable, privacy-preserving `safety_identifier` as described in the [safety guide](https://developers.openai.com/api/docs/guides/safety-best-practices#implement-safety-identifiers).
