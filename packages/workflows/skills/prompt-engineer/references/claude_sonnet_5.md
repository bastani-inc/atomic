# Claude Sonnet 5 prompting

Use this reference for Sonnet 5 effort, thinking defaults, tools, and migration from Sonnet 4.6. Distilled from [Anthropic's Sonnet 5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5), checked September 5, 2026. Existing Sonnet 4.6 prompts are a starting point, but unchanged request parameters can behave differently.

## Review migration parameters first

| Area | Sonnet 5 rule |
| --- | --- |
| Effort | Default `high`; use `xhigh` for the hardest coding and agentic tasks. Evaluate `medium` for cost-sensitive work and `low` for short, scoped, latency-sensitive tasks. `max` prioritizes capability with greater token spending. |
| Thinking default | Adaptive thinking is on when `thinking` is omitted. Sonnet 4.6 ran without thinking for that same request. Explicit `thinking: {type: "disabled"}` turns it off. |
| Manual budgets | `thinking: {type: "enabled", budget_tokens: N}` is unsupported and returns a 400. Use adaptive thinking with effort. |
| Output budget | `max_tokens` covers thinking plus the response. Revisit limits inherited from thinking-disabled Sonnet 4.6 workloads. |
| Sampling | Non-default `temperature`, `top_p`, or `top_k` returns a 400. Remove these parameters during migration and guide style in the prompt. |

These are model/API rules. Confirm the provider, SDK, and host support before changing configuration. Do not assume a raw API field is an Atomic setting.

## Calibrate effort against behavior

Effort names are not equivalent across model versions. The guide offers rough Sonnet 4.6 comparisons, but recommends benchmarking observed thinking length rather than matching names alone. Try thinking enabled at lower effort before carrying forward a thinking-disabled setup.

At `low` and `medium`, the model follows the stated task narrowly; moderately complex work at `low` may be too shallow. Raise effort to `high` or `xhigh` before compensating with elaborate instructions. Where low effort is necessary, add a narrow instruction for the missed behavior and test it.

## State scope and tools explicitly

Sonnet 5 is more agentic than Sonnet 4.6 and uses tools and self-verification more readily. Thinking-disabled requests can trigger tools less often. If required retrieval is missed, say what evidence must be fetched and when, rather than demanding tool use on every task. Higher effort can also increase search and coding tool use.

Instructions are literal, particularly at lower effort. Name the full scope when a rule applies to every file or section. Provide task intent and constraints up front so routine work can continue without a sequence of avoidable user confirmations. Preserve actual approval gates and missing-decision escalation.

```text
Update each affected section using the supplied specification. Retrieve current API documentation only where the specification leaves compatibility unresolved. Keep changes within this request, run the required checks, and report any blocking mismatch with evidence. Deployment is not authorized.
```

## Calibrate writing and progress

Response length follows perceived task complexity. Set an explicit output length and structure when open-ended work runs long; use a positive example of the desired tone. Progress updates are generally regular without a fixed tool-count schedule. Remove redundant narration rules and specify useful update content where needed.

Control voice and design variety with concrete prompting, not rejected sampling parameters. Do not ask the model to reproduce private reasoning in its response; request evidence, conclusions, and observed results.

## Design and frontend work

For an open-ended brief, Sonnet 5 can settle into a consistent house style. Generic bans often produce another fixed style rather than useful variation. Specify an alternative palette, typography, density, and interactions, or ask for distinct design directions when the user wants to choose before implementation.

A short design instruction plus concrete references may replace lengthy legacy anti-generic guidance. Keep accessibility and existing product requirements explicit. Do not create a new approval gate when the user has already authorized selecting a direction.

## Keep review filters concrete

A review instruction such as "be conservative" or "don't nitpick" can hide supported bugs because the model follows it more literally. For a multi-stage review, make discovery responsible for coverage and perform confidence filtering, deduplication, and ranking separately.

For one pass, define the bar in terms of consequences: incorrect behavior, failing tests, or misleading results. Exclude pure naming and style preferences if they are out of scope. Do not expand a review beyond an explicit user severity constraint in pursuit of recall.

## Computer use and rollout checks

The source lists `computer_toolset_20260801` and `browser_toolset_20260801` on the Claude API and Google Cloud, and the older `computer_20251124` computer tool. Verify actual availability before authoring a tool-dependent prompt.

For screenshots, the guide describes 1080p as a useful balance and 720p or 1366×768 as cost-sensitive alternatives, with a maximum of 2576px / 3.75MP. Evaluate resolution and effort against the details the task needs.

Test a migrated request payload, a required-retrieval task, and a code-review case. Check budget exhaustion, structured tool calls, scope, and supported findings. Compare one prompt or effort change at a time; no static guide proves live quality improvements.
