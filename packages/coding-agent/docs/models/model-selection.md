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
The table below is a snapshot of the [DeepSWE](https://deepswe.datacurve.ai/) leaderboard (v1.1, best effort per model), a long-horizon coding-agent benchmark reporting `pass@1` and average dollars per task. Benchmarks and pricing drift and new models ship constantly, so **treat the live leaderboards as authoritative** and refresh this page from them rather than hand-maintaining scores. See [Benchmark sources & when to reference each](/models/artificial-analysis-index). **Last compiled: 2026-07-17.**
</Note>

## Recommendation chart

The Pareto frontier — models where nothing else is both cheaper and more accurate — is currently **gpt-5.6-sol** (accuracy ceiling), **gpt-5.6-terra**, **kimi-k3**, **gpt-5.6-luna**, **grok-4.5**, and **muse-spark-1.1**. Everything else is dominated and earns a place only through role fit or provider diversity. For the frontier reasoning, see [Pareto Efficiency](/models/pareto-efficiency).

| Model [level] | pass@1 | $/task | Verdict | Use it for |
| --- | --- | --- | --- | --- |
| gpt-5.6-sol [max] | 73% | $8.39 | Accuracy ceiling / frontier | Judgment gates where a wrong verdict wastes a whole loop, and the hardest debugging; current top scorer |
| gpt-5.6-terra [max] | 70% | $4.95 | Frontier — best top-tier value | High-accuracy default for reviewers and planners; matches fable-5's accuracy at ~4× lower cost |
| kimi-k3 [max] | 69% | $4.65 | Frontier | Near-top accuracy at the lowest top-tier cost; open weights, so also a provider-diversity pick |
| gpt-5.6-luna [max] | 67% | $3.03 | Frontier — best value on the board | The workhorse: research, orchestrator, worker + code-simplifier subagents |
| gpt-5.5 [xhigh] | 67% | $7.23 | Superseded | luna matches 67% for $3.03 — less than half the cost |
| claude-fable-5 [max] | 70% | $21.63 | Drop | terra matches 70% for $4.95; kept only where Anthropic-family behavior is specifically wanted |
| claude-opus-4.8 [max] | 59% | $13.22 | Fallback only | Dominated on cost/accuracy, but retained for Anthropic provider diversity and its long-context niche |
| grok-4.5 [high] | 54% | $2.42 | Frontier (budget) | Cheap, capable worker; adds xAI provider diversity |
| claude-sonnet-5 [max] | 54% | $26.40 | Drop everywhere | Worst value on the chart; 268 steps of meandering |
| muse-spark-1.1 [xhigh] | 53% | $2.36 | Frontier (cheapest defensible) | Cheapest model still on the frontier; open weights diversity |
| gpt-5.4 [xhigh] | 52% | $5.65 | Superseded | grok-4.5 and luna dominate it on cost and accuracy |
| glm-5.2 [max] | 44% | $3.92 | Diversity only | Reviewer-C primary (a third model family decorrelates review errors); budget fallback elsewhere |
| gemini-3.5-flash [medium] | 37% | $7.34 | Drop from reasoning | Token hose (276k output tokens); kept only at :low in retrieval chains where token price rules |
| kimi-k2.7-code | 31% | $2.82 | Drop | Dominated by muse-spark-1.1 (both cheaper reach); superseded by kimi-k3 |
| claude-sonnet-4.6 [high] | 30% | $5.52 | Drop everywhere | Removed from all chains |
| gemini-3.1-pro [high] | 12% | $9.48 | Drop everywhere | Value destruction; removed from all chains |

<Note>
Scores above are DeepSWE `pass@1` with ±CI omitted for readability; see the [live leaderboard](https://deepswe.datacurve.ai/) for confidence intervals, output-token, and step counts. A model absent from both DeepSWE and Artificial Analysis should be marked **unmeasured** rather than assigned a guessed score — unmeasured models may still remain operational defaults.
</Note>

## Scenario-based guidance

Pick by the cost of being wrong in each role, not by raw accuracy. Match the role to the benchmark that best measures it (see [Benchmark sources](/models/artificial-analysis-index)).

- **Reviewer / judgment gates** — a wrong verdict discards an entire loop, so pay for accuracy: `gpt-5.6-sol [max]` primary, `gpt-5.6-terra` as reviewer-B, and a different family (`kimi-k3` or `glm-5.2`) as reviewer-C for decorrelated errors. Benchmark to weight: DeepSWE pass@1 and the AA Agentic Index.
- **Planner** — `gpt-5.6-terra [max]` for high-accuracy planning at reasonable cost; `gpt-5.6-sol` when the plan gates an expensive loop.
- **Debugger** — `gpt-5.6-sol [max]` primary; deep reasoning pays off where root-causing is expensive. Benchmark to weight: DeepSWE pass@1, Terminal-Bench.
- **Research** — `gpt-5.6-luna [max]` as the workhorse, with `kimi-k3` in the fallback chain for provider diversity. Benchmark to weight: AA-LCR (long context), AA-Omniscience (factual reliability).
- **Orchestrator / worker / cheap loops** — `gpt-5.6-luna [max]` for the main worker and code-simplifier subagents; `grok-4.5 [high]` or `muse-spark-1.1 [xhigh]` for trivial mechanical one-shots.
- **Design** — a quality-first, unbenchmarked domain; keep a top-tier model (`gpt-5.6-sol` or `claude-fable-5`) here and rely on human judgment rather than a score.
- **Interactive coding sessions** — `gpt-5.6-terra [max]` as a balanced default.

## Related

- [Pareto Efficiency](/models/pareto-efficiency) — cost-vs-accuracy frontier, dominated models, and provider-diversity exceptions.
- [Benchmark sources & when to reference each](/models/artificial-analysis-index) — what Artificial Analysis and DeepSWE measure, per benchmark, and how to keep these docs fresh from the live source.
- [Custom models](/models) — how to add model entries for supported provider APIs.
