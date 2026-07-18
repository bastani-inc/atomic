---
title: "Pareto Efficiency"
description: "Cost-vs-accuracy frontier for model selection: which models dominate, which are dominated, and when diversity overrides efficiency."
---

# Pareto Efficiency

A model is **Pareto-efficient** (on the frontier) if no other model is both cheaper and more accurate. Everything not on the frontier is **dominated** — some other option matches or beats it on accuracy for less money — and should be avoided unless it earns a slot through a specific role fit or provider diversity.

The axes here are `pass@1` (accuracy) and `average dollars per task` (cost), taken from the [DeepSWE](https://deepswe.datacurve.ai/) coding-agent leaderboard. For the full table and role guidance, see [Model Selection](/models/model-selection).

<Note>
Figures are a snapshot of DeepSWE v1.1 (best effort per model). The frontier moves whenever a new model ships or prices change — DeepSWE publishes a live cost-vs-score scatter, so **read the frontier off the live chart** rather than trusting a static list. **Last compiled: 2026-07-17.**
</Note>

## The frontier

Six models currently sit on the frontier, spanning "cheapest defensible worker" to "accuracy ceiling":

- **gpt-5.6-sol [max]** — the accuracy axis (73% pass@1, $8.39). Nothing scores higher.
- **gpt-5.6-terra [max]** — 70% for $4.95. Matches claude-fable-5's accuracy at roughly a quarter of the cost.
- **kimi-k3 [max]** — 69% for $4.65. Near-top accuracy at the lowest top-tier price; open weights.
- **gpt-5.6-luna [max]** — 67% for $3.03. The best value on the board for high-accuracy work.
- **grok-4.5 [high]** — 54% for $2.42. A cheap, capable mid-tier worker.
- **muse-spark-1.1 [xhigh]** — 53% for $2.36. The cheapest model still on the frontier.

## What changed — the frontier moved

The previous generation's frontier (gpt-5.5 and claude-fable-5) is now **dominated** by the gpt-5.6 family:

- **claude-fable-5 [max]** (70%, $21.63) — matched on accuracy by **gpt-5.6-terra** (70%, $4.95) at ~4× lower cost.
- **gpt-5.5 [xhigh]** (67%, $7.23) — matched on accuracy by **gpt-5.6-luna** (67%, $3.03) at less than half the cost.

This is the reason to key these docs to the live benchmarks: a single release cycle reshaped the entire recommendation.

## Dominated models — and why

- **claude-fable-5 [max]** — superseded by gpt-5.6-terra on cost for equal accuracy.
- **gpt-5.5 [xhigh]** and **gpt-5.4 [xhigh]** — superseded by gpt-5.6-luna / grok-4.5.
- **claude-opus-4.8 [max]**, **claude-sonnet-5 [max]** — dominated on cost/accuracy; sonnet-5 is the worst value on the chart.
- **kimi-k2.7-code** — superseded by kimi-k3 and undercut by muse-spark-1.1.
- **claude-sonnet-4.6 [high]**, **gemini-3.1-pro [high]** — dominated; not in any chain.
- **gemini-3.5-flash [medium]** — dropped from reasoning roles (token hose at 276k output tokens); retained only at `[low]` in retrieval chains where token price dominates.

## Diversity and role-fit exceptions

Efficiency is not the only axis. A dominated model can still earn a slot when it decorrelates errors or fills a niche:

- **glm-5.2** — kept as reviewer-C because a third model family decorrelates review errors, even though it is dominated on raw efficiency.
- **kimi-k3** — frontier on efficiency *and* an open-weights provider-diversity option; a strong reviewer-C or fallback.
- **claude-opus-4.8 [max]** — retained for Anthropic provider diversity and its long-context niche.
- **claude-fable-5** — kept where Anthropic-family behavior is specifically wanted, e.g. the quality-first, unbenchmarked design chain.
- **Unmeasured models** — any family in use on `main` without DeepSWE or Artificial Analysis coverage should be marked unmeasured. Being unmeasured is not the same as being dominated; such models may remain operational defaults until measured.

## How to use this

1. Default to a frontier model for the role's accuracy needs (see [Model Selection](/models/model-selection)).
2. Only reach for a dominated model when you have an explicit reason — provider diversity, a long-context or token-price niche, or an unbenchmarked domain like design.
3. Re-read the frontier off the [DeepSWE live chart](https://deepswe.datacurve.ai/) when prices or benchmarks change, and update the timestamp on these pages.

## Related

- [Model Selection](/models/model-selection)
- [Benchmark sources & when to reference each](/models/artificial-analysis-index)
