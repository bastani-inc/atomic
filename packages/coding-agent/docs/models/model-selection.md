---
title: "Model Selection"
description: "Practical guidance for choosing models by workflow role, grounded in live coding-agent benchmarks (DeepSWE) and intelligence benchmarks (Artificial Analysis)."
---

# Model Selection

This page gives workflow authors and runtime policy code a practical way to answer:

- Which model should a workflow use by default?
- Which model should it use for judgment gates, debugging, planning, research, cheap worker loops, and fallback diversity?
- Which models are dominated on cost/accuracy and should be avoided unless they have a specific role fit?

It is a **static reference**. It does not change runtime model routing — routing is configured elsewhere. Treat these recommendations as a starting point and validate against your own workflow evals.

<Note>
The table below is a snapshot of the [DeepSWE](https://deepswe.datacurve.ai/) leaderboard (v1.1, highest published thinking level per model), a long-horizon coding-agent benchmark reporting `pass@1` and average dollars per task. The source reports 113 tasks and was updated August 26, 2026. Benchmarks and pricing drift and new models ship constantly, so **treat the live leaderboards as authoritative** and refresh this page from them rather than hand-maintaining scores. See [Benchmark sources & when to reference each](/models/artificial-analysis-index). **Last compiled: 2026-09-01.**
</Note>

## Benchmark levels are measurement settings

The thinking level in brackets in the chart is the **measurement configuration used for that benchmark result**, not a universal workflow default. A score measured at `max` does not mean every stage using that model should use `max`; benchmark model identity and production thinking effort are separate choices. When authoring a workflow, choose effort from the stage role and cost of being wrong, then verify that the configured model catalog supports the level.

## Pin model identity

When a workflow needs an exact model, call `workflow({ action: "models" })` and pin a returned `fullId`. Do not pin a
bare model ID: the same exact model ID can belong to more than one provider. For a bare exact `--model` ID, Atomic
uses the sole matching provider with configured authentication; if none or more than one match is authenticated, it
reports the ambiguity. Use `--provider <provider> --model <id>` or `--model <provider>/<id>` to choose explicitly.

## Recommendation chart

The current highest-effort-config Pareto frontier is **claude-opus-5** (accuracy ceiling), **gpt-5.6-sol**, **glm-5.3**, **gpt-5.6-luna**, and **glm-5.3-flash** (cheapest point). Everything else displayed on the live DeepSWE leaderboard is dominated on cost and accuracy and earns a place only through role fit or provider diversity. For the frontier reasoning, see [Pareto Efficiency](/models/pareto-efficiency).

| Model [benchmark measurement level] | pass@1 | $/task | Verdict | Use it for |
| --- | --- | --- | --- | --- |
| claude-opus-5 [max] | 74% | $11.84 | Accuracy ceiling / frontier | Final approval and the hardest debugging when one more point can justify the cost |
| gpt-5.6-sol [max] | 73% | $6.46 | Frontier | High-cost judgment gates; nearly the top score for about half the task cost of Opus 5 |
| gpt-5.6-terra [max] | 70% | $3.96 | Historical — off the live board | Last published measurement; not displayed on the August 26 leaderboard, so re-verify before relying on it |
| claude-fable-5 [max] | 70% | $21.63 | Drop | Sol matches or beats its score for much less |
| glm-5.3 [max] | 69% | $3.99 | Frontier — open-weights value | Best open-weights mid-tier cost/accuracy point; matches Kimi K3's rounded score for less |
| kimi-k3 [max] | 69% | $4.65 | Dominated | GLM-5.3 matches its rounded score for $0.66 less; Moonshot-family diversity only |
| gpt-5.6-luna [max] | 67% | $0.61 | Frontier — best general value | Research, orchestration, workers, and code simplification |
| gpt-5.5 [xhigh] | 67% | $7.23 | Superseded | Luna matches its score for less than one tenth of the task cost |
| grok-4.6 [xhigh] | 67% | $5.50 | Provider fallback | xAI diversity; Luna has the same rounded score at lower DeepSWE task cost |
| gemini-3.7-flash [high] | 65% | $2.18 | Provider fallback | Strong Google-family result, but Luna is cheaper and more accurate |
| glm-5.3-flash [max] | 63% | $0.24 | Frontier — cheapest | Budget worker loops that can accept lower accuracy and 123 average steps |
| deepseek-v4-pro [max] | 63% | $1.67 | Dominated / provider fallback | DeepSeek diversity only; GLM-5.3 Flash has a higher unrounded score, fewer steps, and about one seventh of the cost |
| claude-opus-4.8 [max] | 59% | $13.22 | Fallback only | Anthropic diversity and long-context behavior, not cost efficiency |
| qwen3.8-max [xhigh] | 57% | $3.73 | Provider fallback | Qwen diversity only; GLM-5.3 Flash and Luna dominate it |
| muse-spark-1.2 [xhigh] | 55% | $3.70 | Drop | GLM-5.3 Flash is cheaper and more accurate |
| claude-sonnet-5 [max] | 54% | $26.40 | Drop everywhere | Highest task cost and 268 average steps for a mid-table score |
| grok-4.5 [high] | 54% | $2.42 | Historical — off the live board | Last published measurement; superseded by Grok 4.6 and dominated by current frontier models |
| deepseek-v4-flash [max] | 53% | $0.46 | Dominated / provider fallback | DeepSeek diversity only; GLM-5.3 Flash is ten points more accurate for about half the cost |
| muse-spark-1.1 [xhigh] | 53% | $2.36 | Historical — off the live board | Last published measurement; replaced by Muse Spark 1.2 and dominated by current frontier models |
| gpt-5.4 [xhigh] | 52% | $5.65 | Historical — off the live board | Last published measurement; Luna is cheaper and 15 points more accurate |
| gemini-3.6-flash [high] | 47% | $2.21 | Drop from reasoning | Superseded by Gemini 3.7 Flash |
| glm-5.2 [max] | 44% | $3.92 | Superseded | Measured predecessor only; do not relabel this as GLM-5.3 |
| gemini-3.5-flash [high] | 36% | $3.45 | Drop from reasoning | Retain only where a low-effort retrieval role has separate evidence |
| kimi-k2.7-code | 31% | $2.82 | Historical — off the live board | Last published measurement had no effort level; Kimi K3 is the current family fallback |
| claude-sonnet-4.6 [high] | 30% | $5.52 | Historical — off the live board | Last published measurement; removed from all chains |
| gemini-3.1-pro-preview [high] | 12% | $2.14 | Historical — off the live board | Last published measurement; removed from all chains |

<Note>
DeepSWE values above use the v1.1 results displayed on the August 26, 2026 leaderboard, including the August 21 pricing corrections for GPT-5.6 Sol and DeepSeek V4. Sol's cost reflects OpenAI's promotional input and output price cut through at least November 21, 2026. DeepSWE uses DeepSeek's peak rates; its off-peak rates are half as much. `pass@1` is rounded as on the live leaderboard and confidence intervals are omitted here. The highest published thinking level is a measurement choice, not a production default. Seven historical configurations are retained with their last published values because they are no longer displayed: GPT-5.6 Terra, Grok 4.5, Muse Spark 1.1, GPT-5.4, Kimi K2.7 Code, Claude Sonnet 4.6, and Gemini 3.1 Pro Preview. See the live page for intervals, output tokens, steps, lower-effort configurations, and later corrections.
</Note>

<Note>
**Claude Fable 5.1 is in Atomic's catalog and is not in the table above.** It was released September 1, 2026, after the August 26, 2026 DeepSWE snapshot this page is compiled from, so it has no measured `pass@1` or `$/task` here. Do not read the `claude-fable-5` row as a Fable 5.1 result: the two models differ in price and behavior, and an unmeasured model must not inherit its predecessor's score. Benchmark it on your own workflow evals before promoting it into a stage.

What is source-backed for `claude-fable-5-1` today, from [Anthropic's model overview](https://platform.claude.com/docs/en/models/fable-5-1/overview): a 1M-token context window and 128K maximum output; adaptive thinking that is always on, with effort `low`, `medium`, `high`, `xhigh`, and `max` and an Anthropic default of `high`; a June 2026 knowledge cutoff; and $10 input, $50 output, $12.50 five-minute cache write, $20 one-hour cache write, and $0.25 cache read per million tokens. The cache read is a quarter of Fable 5's $1.00, which is the main pricing reason to prefer it for long agentic sessions that re-read a cached prefix. Non-default `temperature`, `top_p`, and `top_k` return a 400 on every request, so Atomic omits `temperature` for this model.

Atomic generates Fable 5.1 for the providers it has a matching runtime integration for. At the time of writing that is Anthropic, three Amazon Bedrock inference profiles (`anthropic.`, `global.`, and `us.`), OpenRouter, and the Vercel AI Gateway; a provider "latest" alias such as OpenRouter's `~anthropic/claude-fable-latest` may also route to it without naming it. That set genuinely moves — opencode zen published the model and then withdrew it while this page was being written — so run `workflow({ action: "models" })` or `--list-models` for the current list rather than trusting this one. Published catalogs also list the model on Google Vertex, Google Vertex (Anthropic), Azure, and Azure Cognitive Services; Atomic has no Claude runtime integration for those providers and generates no entries for them, which is a current limitation rather than a roadmap commitment. What does *not* vary is the invariant that matters: **Atomic's preserved-thinking handling is scoped to `provider: "anthropic"` on the `anthropic-messages` API and applies to none of the other mirrors** — including the Vercel AI Gateway, which rides `anthropic-messages` but is deliberately excluded. See [Preserved thinking and model switches](/models#preserved-thinking-and-model-switches).
</Note>

## Role-based thinking effort

Use this table when the user has not requested a thinking level. It is a production default by stage role, not a claim about the level used by any benchmark row:

| Stage role | Default thinking level | Why |
| --- | --- | --- |
| Security, identity, adversarial challenge, final approval | `max` | A wrong judgment can create a high-risk false approval or waste a full downstream loop. |
| Codebase mapping, lifecycle analysis, compatibility, planning, synthesis, triage, repair | `high` | These stages must resolve demanding uncertainty and preserve evidence across handoffs; routine synthesis may use `medium` when evidence quality holds. |
| User-impact review and final reporting | `medium` | Clear evidence-backed summaries usually do not need the deepest reasoning. |
| Deterministic checks | No model call | Run typechecks, tests, schema checks, runtime probes, and artifact checks as durable tool nodes. |

Reserve `max` for a high-cost-of-error role or an explicit user request. An explicit request wins over this role default, but the requested level still must appear in the configured catalog; do not invent an unsupported suffix. For each primary and fallback, choose a level for the same stage role independently. A fallback is not a reason to inherit `max` mechanically: use the role default at a supported level, choose another catalog model when needed, or leave the stage unpinned rather than guessing.

## Scenario-based guidance

Pick by the cost of being wrong in each role, not by raw accuracy. Match the role to the benchmark that best measures it (see [Benchmark sources](/models/artificial-analysis-index)).

- **Reviewer / judgment gates** — use `max` when the reviewer makes a security, identity, adversarial, or final-approval decision whose wrong verdict discards an entire loop. `claude-opus-5` is the DeepSWE accuracy ceiling; `gpt-5.6-sol` is the lower-cost near-peer. Use another family when decorrelated errors matter.
- **Codebase mapping / planner** — start at `high` for repository mapping, lifecycle analysis, compatibility, and plans. `gpt-5.6-sol` is the strongest top-tier value at its measured `max` configuration, and `glm-5.3` holds the open-weights mid tier; raise production effort to `max` only when the plan gates a high-cost loop or the user asks for it.
- **Debugger / triage / repair** — start at `high`; deep reasoning pays off when root-causing or repairing is costly. Weight DeepSWE and Terminal-Bench together rather than treating either as a complete measure.
- **Research / synthesis** — use `high` for demanding research and evidence reconciliation; use `medium` for routine synthesis when the evidence is already strong. `gpt-5.6-luna` remains the workhorse. Benchmark to weight: AA-LCR and AA-Omniscience.
- **Orchestrator / worker / cheap loops** — Luna offers the best broad cost/accuracy balance. GLM-5.3 Flash is the cheapest live frontier point at 63% for $0.24 with 123 average steps. DeepSeek V4 Pro and Flash are provider-diversity options, not budget-frontier choices.
- **User-impact review / final reporting** — use `medium` for impact summaries and reports that preserve the evidence needed by the user. Do not spend `max` here unless the user explicitly requests it or the role has become a high-cost-of-error approval.
- **Design** — a quality-first, unbenchmarked domain; keep a top-tier model (`gpt-5.6-sol` or `claude-fable-5`) when the design decision has high failure cost, and choose effort by the review or approval role rather than by the benchmark row. `claude-fable-5-1` is the newer Anthropic model in this family and is also unmeasured here; treat it as a candidate to evaluate rather than a drop-in replacement, and do not carry Fable 5's row over to it.
- **Interactive coding sessions** — use `high` for complex, multi-step coding and `medium` for routine edits; reserve `max` for a high-cost-of-error judgment or an explicit user request.
- **Deterministic checks** — make typechecks, tests, schema validation, runtime probes, and artifact inspection tool nodes with no model call. Model self-report is not verification evidence.

## Related

- [Pareto Efficiency](/models/pareto-efficiency) — cost-vs-accuracy frontier, dominated models, and provider-diversity exceptions.
- [Benchmark sources & when to reference each](/models/artificial-analysis-index) — what Artificial Analysis and DeepSWE measure, per benchmark, and how to keep these docs fresh from the live source.
- [Custom models](/models) — how to add model entries for supported provider APIs.
