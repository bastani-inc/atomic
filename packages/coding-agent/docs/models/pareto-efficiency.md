---
title: "Pareto Efficiency"
description: "Cost-vs-accuracy frontier for model selection: which models dominate, which are dominated, and when diversity overrides efficiency."
---

# Pareto Efficiency

A model is **Pareto-efficient** (on the frontier) if no other model is both cheaper and more accurate. Everything not on the frontier is **dominated**: some other option matches or beats it on accuracy for less money. Avoid a dominated model unless it earns a slot through a specific role fit or provider diversity.

The axes here are `pass@1` (accuracy) and `average dollars per task` (cost), taken from the [DeepSWE](https://deepswe.datacurve.ai/) coding-agent leaderboard. For the full table and role guidance, see [Model Selection](/models/model-selection).

<Note>
Figures are a snapshot of DeepSWE v1.1 using the highest published thinking level for each of the 21 models displayed on the September 3, 2026 leaderboard. They include the August 21 pricing corrections for GPT-5.6 Sol and DeepSeek V4, and GPT-6 Astra's costs are DeepSWE's expected launch pricing rather than billed rates. DeepSWE's own default table view is **Best** — the best-scoring configuration per model — which picks a different row for four models; the frontier under that reading is stated below. DeepSWE publishes a live cost-vs-score scatter, so **read the frontier off the live chart** rather than trusting a static list. **Last compiled: 2026-09-03.**
</Note>

The [AA review](/models/artificial-analysis-index) is separately dated **2026-09-05**. AA Intelligence Index v4.2 uses weighted intelligence and its own cost per task; AA Coding Agent Index v1.4 uses agent-specific runs across several benchmarks. Neither defines the Datacurve frontier on this page. A September 5 browser check confirmed the September 3 DeepSWE update and Gemini 3.8 Flash's measured row, without recomputing this entire snapshot.

## The frontier

Three displayed highest-effort model configurations sit on the frontier, from the cheapest measured task cost to the accuracy ceiling:

- **glm-5.3-flash [max]**: 63% for $0.24 with 123 average steps. This is the cheapest point.
- **gpt-5.6-luna [max]**: 67% for $0.61 with 102 average steps. This is the cheapest broadly-capable point.
- **gemini-3.8-flash [high]**: 74% for $2.36 with 166 average steps and 143k output tokens. This is the current accuracy ceiling, and also the step-heaviest point on the frontier — weigh that before making it a worker default.

Under DeepSWE's default **Best** view, which selects each model's best-scoring configuration instead of its highest effort, these three points still hold and `gpt-6-astra [xhigh]` joins as a fourth member and the accuracy ceiling, at 74.12% unrounded for $6.52 with 29 average steps. That is a frontier position under that reading only: at its highest published effort (`max`, 73.23% for $12.37) GPT-6 Astra is dominated by both Gemini 3.8 Flash and Claude Opus 5. The same view also shows `claude-fable-5 [xhigh]` at 70% for $13.41, `grok-4.6 [medium]` at 67% for $3.45, and `gemini-3.7-flash [medium]` at 65% for $2.03, none of which reach the frontier.

## What changed

The September 3 snapshot collapses the frontier from five members to three:

- **Gemini 3.8 Flash [high]**, added September 1, 2026, arrives at 74% for $2.36 and takes the accuracy ceiling. Rounded scores cannot settle the top of this board: Gemini 3.8 Flash and Claude Opus 5 both display 74%, and only the unrounded rates — 73.83% against 73.65% — order them. The dominance holds either way, because the cheaper model is also $9.48 less per task, about one fifth of Opus 5's cost.
- **claude-opus-5 [max]**, **gpt-5.6-sol [max]**, and **glm-5.3 [max]** leave the frontier. None of their numbers moved; a cheaper and more accurate point simply appeared above all three.
- **GPT-6 Astra**, added September 3, 2026 across low, medium, high, xhigh, and max effort, does not join at its highest published effort: `[max]` scores 73% for $12.37 and is dominated by both Gemini 3.8 Flash and Claude Opus 5. DeepSWE priced it at the expected launch rate card, so treat every Astra dollar figure as projected rather than billed.
- **glm-5.3-flash [max]** and **gpt-5.6-luna [max]** are unchanged and keep the budget end of the frontier.

The August pricing corrections still stand and still explain that budget end:

- **GLM-5.3 Flash [max]** appears at 63% for $0.24 with 123 average steps. It replaced both DeepSeek V4 configurations on the budget frontier.
- **DeepSeek V4 Pro [max]** costs $1.67 per task after DeepSeek's August 16 price change. GLM-5.3 Flash has a higher unrounded score (63.4% versus 62.8%), costs about one seventh as much, and averages 32 fewer steps.
- **DeepSeek V4 Flash [max]** costs $0.46 per task. GLM-5.3 Flash is ten rounded points more accurate and costs about half as much.
- **GPT-5.6 Sol [max]** costs $6.46 per task after OpenAI's August 20 promotional price cut, down from $8.39 in the earlier snapshot. The reduced input and output rates run through at least November 21, 2026.

DeepSWE's August 21, 2026 changelog says these DeepSeek costs use peak rates and off-peak rates are half as much. DeepSeek V4 Pro remains dominated at either rate. At the off-peak rate, DeepSeek V4 Flash costs about $0.23, marginally less than GLM-5.3 Flash's $0.24, but remains ten rounded points less accurate; these pages report the frontier from DeepSWE's published peak-rate costs.

## Dominated models and why

- **claude-opus-5 [max]**: Gemini 3.8 Flash is more accurate unrounded (73.83% versus 73.65%; both display 74%) and costs $9.48 less per task. Opus 5 keeps a role only as the Anthropic entry in the accuracy-ceiling class.
- **gpt-6-astra [max]**: dominated twice over — Claude Opus 5 scores higher for $0.53 less, and Gemini 3.8 Flash scores higher for $10.01 less. Its costs are expected launch pricing, not billed rates.
- **gpt-5.6-sol [max]**: Gemini 3.8 Flash is more accurate and costs just over a third as much. Sol remains the OpenAI-family near-peer at about half of Opus 5's task cost.
- **glm-5.3 [max]**: Gemini 3.8 Flash is five rounded points more accurate and costs $1.63 less. GLM-5.3 stays the best open-weights point on the board.
- **deepseek-v4-pro [max]**: GLM-5.3 Flash has a higher unrounded score, costs $1.43 less, and averages 123 steps instead of 155.
- **deepseek-v4-flash [max]**: GLM-5.3 Flash is ten rounded points more accurate and costs $0.22 less.
- **claude-fable-5 [max]**: Sol is more accurate and much cheaper; GLM-5.3 comes within a point for less than one fifth of the task cost. This row is Fable 5 only; `claude-fable-5-1` is still unmeasured in the September 3, 2026 snapshot and has no measured position on the frontier.
- **kimi-k3 [max]**: GLM-5.3 matches its rounded score and is $0.66 cheaper; Kimi remains useful for Moonshot-family diversity.
- **gpt-5.5 [xhigh]** and **grok-4.6 [xhigh]**: Luna matches their rounded 67% for $0.61.
- **gemini-3.7-flash [high]**: Luna is two points more accurate and costs less than one third as much. This row is Gemini 3.7 Flash only. Gemini 3.8 Flash has its own measured `[high]` row and frontier position above; it does not inherit its predecessor's result.
- **muse-spark-1.2 [xhigh]**: GLM-5.3 Flash is eight points more accurate and costs $3.46 less.
- **claude-opus-4.8 [max]** and **claude-sonnet-5 [max]**: each is dominated on both cost and accuracy.
- **qwen3.8-max [xhigh]**, **gemini-3.6-flash [high]**, **gemini-3.5-flash [high]**, and **glm-5.2 [max]**: each has a cheaper, more accurate displayed alternative.

Seven measured configurations are excluded from DeepSWE's default model selection and therefore from this frontier calculation. They are still in the current v1.1 artifact and can be re-enabled in the site's model picker, so this is a display default rather than a withdrawal. [Model Selection](/models/model-selection) keeps their last published values as clearly labeled history, each re-verified unchanged against the September 3, 2026 artifact: GPT-5.6 Terra, Grok 4.5, Muse Spark 1.1, GPT-5.4, Kimi K2.7 Code, Claude Sonnet 4.6, and Gemini 3.1 Pro Preview.

## Diversity and role-fit exceptions

Efficiency is not the only axis. A dominated model can still earn a slot when it decorrelates errors or fills a niche:

- **deepseek-v4-pro** and **deepseek-v4-flash** remain DeepSeek provider-diversity options, not budget-frontier choices.
- **grok-4.6** remains the operational xAI and OpenRouter provider-diversity fallback.
- **glm-5.2 [max]** remains only as a measured predecessor; its results are never relabeled as GLM-5.3 or GLM-5.3 Flash.
- **kimi-k3** remains a Moonshot-family provider-diversity option despite GLM-5.3's strict DeepSWE dominance.
- **claude-opus-4.8 [max]** remains useful where Anthropic diversity or its long-context behavior has separate value.
- **claude-opus-5 [max]** is dominated now but remains the Anthropic model in the accuracy-ceiling class, which matters when a judgment gate needs decorrelated errors from a different family than the frontier ceiling.
- **gpt-5.6-sol [max]** is the OpenAI-family near-peer to the ceiling and stays the top-tier choice when Google-family routing is unavailable or unwanted.
- **glm-5.3 [max]** remains the best open-weights point; the new frontier ceiling is closed-weights, so the open-weights niche survives the frontier change intact.
- **gemini-3.8-flash [high]** holds the frontier ceiling but is Google-family and step-heavy at 166 average steps; pair it with a model from another family for fallback diversity rather than routing every stage through one provider.
- **claude-fable-5** remains useful where Anthropic-family behavior is specifically wanted, such as the quality-first, unbenchmarked design chain.
- **claude-fable-5-1** is available in Atomic's catalog but is absent from the September 3, 2026 Datacurve snapshot, so it has no position on this frontier. It is measured by AA Intelligence Index and by AA with Claude Code, as detailed in the [September 5 AA cross-check](/models/model-selection#aa-cross-check-for-current-candidates). Those results justify evaluation for quality-first work, not importing an AA score or cost into this DeepSWE chart. Its cache pricing may matter for long sessions, but a token-price discount is not a measured cost-per-task saving or accuracy result.
- **Unmeasured models** may remain operational defaults when a family lacks current DeepSWE or Artificial Analysis coverage, but they should not inherit a predecessor's score.

## How to use this

1. Default to a frontier model for the role's accuracy needs (see [Model Selection](/models/model-selection)).
2. Only reach for a dominated model when you have an explicit reason, such as provider diversity, a long-context or token-price niche, or an unbenchmarked domain like design.
3. Re-read the frontier off the [DeepSWE live chart](https://deepswe.datacurve.ai/) when prices or benchmarks change, and update the timestamp on these pages.

## Related

- [Model Selection](/models/model-selection)
- [Benchmark sources & when to reference each](/models/artificial-analysis-index)
