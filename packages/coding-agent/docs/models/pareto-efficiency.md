---
title: "Pareto Efficiency"
description: "Cost-vs-accuracy frontier for model selection: which models dominate, which are dominated, and when diversity overrides efficiency."
---

# Pareto Efficiency

A model is **Pareto-efficient** (on the frontier) if no other model is both cheaper and more accurate. Everything not on the frontier is **dominated**: some other option matches or beats it on accuracy for less money. Avoid a dominated model unless it earns a slot through a specific role fit or provider diversity.

The axes here are `pass@1` (accuracy) and `average dollars per task` (cost), taken from the [DeepSWE](https://deepswe.datacurve.ai/) coding-agent leaderboard. For the full table and role guidance, see [Model Selection](/models/model-selection).

<Note>
Figures are a snapshot of DeepSWE v1.1 using the highest published thinking level for each of the 19 models displayed on the August 26, 2026 leaderboard. They include the August 21 pricing corrections for GPT-5.6 Sol and DeepSeek V4. DeepSWE publishes a live cost-vs-score scatter, so **read the frontier off the live chart** rather than trusting a static list. **Last compiled: 2026-09-01.**
</Note>

## The frontier

Five displayed highest-effort model configurations sit on the frontier, from the cheapest measured task cost to the accuracy ceiling:

- **glm-5.3-flash [max]**: 63% for $0.24 with 123 average steps. This is the cheapest point.
- **gpt-5.6-luna [max]**: 67% for $0.61. This is the best broad value on the board.
- **glm-5.3 [max]**: 69% for $3.99 with 124 average steps. This is the open-weights mid-tier point and matches Kimi K3's rounded score for less.
- **gpt-5.6-sol [max]**: 73% for $6.46 with 61 average steps. This is the lower-cost near-peer to the accuracy leader.
- **claude-opus-5 [max]**: 74% for $11.84 with 99 average steps. This is the current accuracy ceiling.

## What changed

The August 26 snapshot moves the budget end of the frontier and lowers the cost of its upper end:

- **GLM-5.3 Flash [max]** now appears at 63% for $0.24 with 123 average steps. It replaces both DeepSeek V4 configurations on the budget frontier.
- **DeepSeek V4 Pro [max]** now costs $1.67 per task after DeepSeek's August 16 price change. GLM-5.3 Flash has a higher unrounded score (63.4% versus 62.8%), costs about one seventh as much, and averages 32 fewer steps.
- **DeepSeek V4 Flash [max]** now costs $0.46 per task. GLM-5.3 Flash is ten rounded points more accurate and costs about half as much.
- **GPT-5.6 Sol [max]** now costs $6.46 per task after OpenAI's August 20 promotional price cut, down from $8.39 in the previous snapshot. The reduced input and output rates run through at least November 21, 2026.

DeepSWE's August 21, 2026 changelog says these DeepSeek costs use peak rates and off-peak rates are half as much. DeepSeek V4 Pro remains dominated at either rate. At the off-peak rate, DeepSeek V4 Flash costs about $0.23, marginally less than GLM-5.3 Flash's $0.24, but remains ten rounded points less accurate; these pages report the frontier from DeepSWE's published peak-rate costs.

## Dominated models and why

- **deepseek-v4-pro [max]**: GLM-5.3 Flash has a higher unrounded score, costs $1.43 less, and averages 123 steps instead of 155.
- **deepseek-v4-flash [max]**: GLM-5.3 Flash is ten rounded points more accurate and costs $0.22 less.
- **claude-fable-5 [max]**: Sol is more accurate and much cheaper; GLM-5.3 comes within a point for less than one fifth of the task cost. This row is Fable 5 only; `claude-fable-5-1` released after this snapshot and has no measured position on the frontier.
- **kimi-k3 [max]**: GLM-5.3 matches its rounded score and is $0.66 cheaper; Kimi remains useful for Moonshot-family diversity.
- **gpt-5.5 [xhigh]** and **grok-4.6 [xhigh]**: Luna matches their rounded 67% for $0.61.
- **gemini-3.7-flash [high]**: Luna is two points more accurate and costs less than one third as much.
- **muse-spark-1.2 [xhigh]**: GLM-5.3 Flash is eight points more accurate and costs $3.46 less.
- **claude-opus-4.8 [max]** and **claude-sonnet-5 [max]**: each is dominated on both cost and accuracy.
- **qwen3.8-max [xhigh]**, **gemini-3.6-flash [high]**, **gemini-3.5-flash [high]**, and **glm-5.2 [max]**: each has a cheaper, more accurate displayed alternative.

Seven measured configurations are no longer displayed on the live leaderboard and are excluded from this current frontier calculation. [Model Selection](/models/model-selection) keeps their last published values as clearly labeled history: GPT-5.6 Terra, Grok 4.5, Muse Spark 1.1, GPT-5.4, Kimi K2.7 Code, Claude Sonnet 4.6, and Gemini 3.1 Pro Preview.

## Diversity and role-fit exceptions

Efficiency is not the only axis. A dominated model can still earn a slot when it decorrelates errors or fills a niche:

- **deepseek-v4-pro** and **deepseek-v4-flash** remain DeepSeek provider-diversity options, not budget-frontier choices.
- **grok-4.6** remains the operational xAI and OpenRouter provider-diversity fallback.
- **glm-5.2 [max]** remains only as a measured predecessor; its results are never relabeled as GLM-5.3 or GLM-5.3 Flash.
- **kimi-k3** remains a Moonshot-family provider-diversity option despite GLM-5.3's strict DeepSWE dominance.
- **claude-opus-4.8 [max]** remains useful where Anthropic diversity or its long-context behavior has separate value.
- **claude-fable-5** remains useful where Anthropic-family behavior is specifically wanted, such as the quality-first, unbenchmarked design chain.
- **claude-fable-5-1** is available in Atomic's catalog but released September 1, 2026, after the August 26 snapshot, so it is unmeasured here and holds no frontier position. Its published cache-read price is $0.25 per million tokens against Fable 5's $1.00, which can change the economics of a long cached-prefix session, but that is a price fact and not an accuracy result. Evaluate it before substituting it for a measured configuration.
- **Unmeasured models** may remain operational defaults when a family lacks current DeepSWE or Artificial Analysis coverage, but they should not inherit a predecessor's score.

## How to use this

1. Default to a frontier model for the role's accuracy needs (see [Model Selection](/models/model-selection)).
2. Only reach for a dominated model when you have an explicit reason, such as provider diversity, a long-context or token-price niche, or an unbenchmarked domain like design.
3. Re-read the frontier off the [DeepSWE live chart](https://deepswe.datacurve.ai/) when prices or benchmarks change, and update the timestamp on these pages.

## Related

- [Model Selection](/models/model-selection)
- [Benchmark sources & when to reference each](/models/artificial-analysis-index)
