---
title: "Pareto Efficiency"
description: "Cost-vs-accuracy frontier for model selection: which models dominate, which are dominated, and when diversity overrides efficiency."
---

# Pareto Efficiency

A model is **Pareto-efficient** (on the frontier) if no other model is both cheaper and more accurate. Everything not on the frontier is **dominated** — some other option matches or beats it on accuracy for less money — and should be avoided unless it earns a slot through a specific role fit or provider diversity.

The axes here are `pass@1` (accuracy) and `average dollars per task` (cost). For the full table and role guidance, see [Model Selection](/models/model-selection).

<Note>
Figures are compiled from the source material in issue #1659 and reflect a point-in-time snapshot. Benchmarks and pricing drift; re-validate before treating any single number as current. **Last compiled: 2026-07-17.**
</Note>

## The frontier

Only two models sit on the frontier:

- **claude-fable-5** — the accuracy axis. At `[xhigh]` it reaches the accuracy ceiling (70%); at `[high]` it offers the best top-tier value (69% for $9.18).
- **gpt-5.5** — the value axis. `[medium]` (54% for $2.75) is the best value on the entire board, and `[high]`/`[xhigh]` extend the frontier upward at lower cost than comparable Anthropic tiers.

Between them, these two families cover the practical span from "cheapest defensible worker" to "accuracy ceiling for judgment gates."

## Dominated models — and why

These are dominated on cost/accuracy and are removed from chains unless noted otherwise:

- **claude-fable-5 [max]** — +$8.22 over `[xhigh]` for +0 points.
- **claude-opus-4.8 [max]** — beaten by fable:high by 10 points for less money.
- **claude-sonnet-5 (all levels, incl. [max] at $26.40)** — dominated at every level by gpt-5.5 medium; the worst value on the chart.
- **gpt-5.4 [xhigh]** — superseded by gpt-5.5 high (+12 points for −$0.55).
- **glm-5.2 [high]** — gpt-5.5 medium is both cheaper and +18 points.
- **kimi-k2.7-code**, **claude-sonnet-4.6 [high]**, **gemini-3.1-pro [high]** — dominated; not in any chain.
- **gemini-3.5-flash [medium]** — dropped from reasoning roles (token hose at 276k output tokens); retained only at `[low]` in retrieval chains where token price dominates.

## Diversity and role-fit exceptions

Efficiency is not the only axis. A dominated model can still earn a slot when it decorrelates errors or fills a niche:

- **glm-5.2** — kept as reviewer-C because a third model family decorrelates review errors, even though it is dominated on raw efficiency.
- **claude-opus-4.8 [high]** — retained across reviewer/planner/debugger chains for Anthropic provider diversity and its 1M long-context niche.
- **claude-opus-4.8 [xhigh]** — kept only in the design chain, a quality-first, unbenchmarked domain where the cost premium is accepted deliberately.
- **claude-fable-5 [low]** — a "sleeper" pick that beats opus:medium and sonnet-5:high outright, so it stays in worker/research/orchestrator fallback chains.
- **Unmeasured families** (e.g., gpt-5.6 Sol, gpt-5.6 Terra) — in use on `main` without comparable benchmark data. They cannot be placed on the frontier yet, but being unmeasured is not the same as being dominated; they may remain operational defaults until measured.

## How to use this

1. Default to a frontier model for the role's accuracy needs (see [Model Selection](/models/model-selection)).
2. Only reach for a dominated model when you have an explicit reason — provider diversity, a long-context or token-price niche, or an unbenchmarked domain like design.
3. Re-run the comparison when prices or benchmarks change, and update the timestamp on these pages.

## Related

- [Model Selection](/models/model-selection)
- [Artificial Analysis Index](/models/artificial-analysis-index)
