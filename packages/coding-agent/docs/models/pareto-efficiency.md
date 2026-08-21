---
title: "Pareto Efficiency"
description: "Cost-vs-accuracy frontier for model selection: which models dominate, which are dominated, and when diversity overrides efficiency."
---

# Pareto Efficiency

A model is **Pareto-efficient** (on the frontier) if no other model is both cheaper and more accurate. Everything not on the frontier is **dominated** — some other option matches or beats it on accuracy for less money — and should be avoided unless it earns a slot through a specific role fit or provider diversity.

The axes here are `pass@1` (accuracy) and `average dollars per task` (cost), taken from the [DeepSWE](https://deepswe.datacurve.ai/) coding-agent leaderboard. For the full table and role guidance, see [Model Selection](/models/model-selection).

<Note>
Figures are a snapshot of DeepSWE v1.1 using the highest published thinking level per model and reporting corrections through August 20, 2026. The frontier moves whenever a model, run, or price changes — DeepSWE publishes a live cost-vs-score scatter, so **read the frontier off the live chart** rather than trusting a static list. **Last compiled: 2026-08-21.**
</Note>

## The frontier

Six highest-effort model configurations currently sit on the frontier, from the cheapest measured task cost to the accuracy ceiling:

- **deepseek-v4-flash [max]** — 53% for $0.10. The cheapest point, with lower accuracy and 153 average steps.
- **deepseek-v4-pro [max]** — 63% for $0.24. A large accuracy gain for another $0.14 per task, with 155 average steps.
- **gpt-5.6-luna [max]** — 67% for $0.61. The best broad value on the board.
- **glm-5.3 [max]** — 69% for $3.99. The open-weights mid-tier point; matches Kimi K3's rounded score for less.
- **gpt-5.6-sol [max]** — 73% for $8.39. The lower-cost near-peer to the accuracy leader.
- **claude-opus-5 [max]** — 74% for $11.84. The current accuracy ceiling.

## What changed — the frontier moved

The August 20 refresh reshuffled the middle of the frontier:

- **GLM-5.3 [max]** is now measured — 69% for $3.99 with 124 average steps — and takes the mid-tier frontier slot.
- **GPT-5.6 Terra [max]** no longer appears on the live board; its July measurement (70% for $3.96) is retained in [Model Selection](/models/model-selection) as history, not a current frontier point.
- **Kimi K3 [max]** is now strictly dominated: GLM-5.3 matches its rounded score for $0.66 less per task.

## Dominated models — and why

- **claude-fable-5 [max]** — Sol is more accurate and much cheaper; GLM-5.3 comes within a point for less than one fifth of the task cost.
- **kimi-k3 [max]** — GLM-5.3 matches its rounded score and is $0.66 cheaper; Kimi remains useful for Moonshot-family diversity.
- **gpt-5.5 [xhigh]** and **grok-4.6 [xhigh]** — Luna matches their rounded 67% for $0.61.
- **gemini-3.7-flash [high]** — Luna is two points more accurate and less than one third of its task cost.
- **grok-4.5 [high]**, **muse-spark-1.1 [xhigh]**, **muse-spark-1.2 [xhigh]**, and **gpt-5.4 [xhigh]** — the new DeepSeek and GPT-5.6 points dominate these former budget choices.
- **claude-opus-4.8 [max]** and **claude-sonnet-5 [max]** — dominated on both cost and accuracy.
- **qwen3.8-max [xhigh]**, **gemini-3.6-flash [high]**, **gemini-3.5-flash [high]**, **glm-5.2 [max]**, **kimi-k2.7-code [low]**, **claude-sonnet-4.6 [high]**, and **gemini-3.1-pro [high]** — each has a cheaper, more accurate measured alternative.

## Diversity and role-fit exceptions

Efficiency is not the only axis. A dominated model can still earn a slot when it decorrelates errors or fills a niche:

- **grok-4.6** — retained as the operational xAI and OpenRouter provider-diversity fallback.
- **glm-5.2 [max]** — kept only as a measured predecessor; its results are never relabeled as GLM-5.3, which is now measured directly on the frontier.
- **kimi-k3** — retained as a Moonshot-family provider-diversity option despite GLM-5.3's strict DeepSWE dominance.
- **claude-opus-4.8 [max]** — retained where Anthropic diversity or its long-context behavior has separate value.
- **claude-fable-5** — kept where Anthropic-family behavior is specifically wanted, such as the quality-first, unbenchmarked design chain.
- **Unmeasured models** — a family without current DeepSWE or Artificial Analysis coverage may remain an operational default, but should not inherit a predecessor's score.

## How to use this

1. Default to a frontier model for the role's accuracy needs (see [Model Selection](/models/model-selection)).
2. Only reach for a dominated model when you have an explicit reason — provider diversity, a long-context or token-price niche, or an unbenchmarked domain like design.
3. Re-read the frontier off the [DeepSWE live chart](https://deepswe.datacurve.ai/) when prices or benchmarks change, and update the timestamp on these pages.

## Related

- [Model Selection](/models/model-selection)
- [Benchmark sources & when to reference each](/models/artificial-analysis-index)
