---
title: "Model Selection"
description: "Practical guidance for choosing models by workflow role, based on Pareto efficiency across cost and accuracy."
---

# Model Selection

This page gives workflow authors and runtime policy code a practical way to answer:

- Which model should a workflow use by default?
- Which model should it use for judgment gates, debugging, planning, research, cheap worker loops, and fallback diversity?
- Which models are dominated on cost/accuracy and should be avoided unless they have a specific role fit?

It is a **static reference**. It does not change runtime model routing — routing is configured elsewhere. Treat these recommendations as a starting point and validate against your own workflow evals.

<Note>
Benchmark values below are compiled from the source material in issue #1659 and reflect a `pass@1 / average dollars per task` view. Benchmarks and pricing drift, so figures are timestamped and should be periodically refreshed. **Last compiled: 2026-07-17.**
</Note>

## Recommendation chart

The Pareto frontier is **gpt-5.5** (value axis) and **claude-fable-5** (accuracy axis). Everything else is dominated and earns a place only through role fit or provider diversity. For the frontier reasoning, see [Pareto Efficiency](/models/pareto-efficiency).

| Model [level] | pass@1 | $/task | Verdict | Use it for |
| --- | --- | --- | --- | --- |
| claude-fable-5 [xhigh] | 70% | $13.41 | Accuracy ceiling | Judgment gates where a wrong verdict wastes a whole loop: reviewers, prompt-engineer, deep-research planner, design |
| claude-fable-5 [max] | 70% | $21.63 | Drop | +$8.22 over xhigh for +0 pts — never |
| claude-fable-5 [high] | 69% | $9.18 | Best top-tier value | Manual pick when xhigh reviewer cost stings (−1 pt for −$4.23); fewest steps in the top tier (59) |
| gpt-5.5 [xhigh] | 67% | $7.23 | Frontier | Deep debugging (debugger primary), reviewer-B, first fallback for every fable slot |
| claude-fable-5 [medium] | 65% | $6.09 | Niche | Fast planner alternative (48 steps); mostly shadowed by gpt-5.5 high/xhigh |
| gpt-5.5 [high] | 64% | $5.10 | Frontier | Balanced default for interactive coding sessions |
| claude-fable-5 [low] | 60% | $3.76 | Sleeper pick | Anthropic candidate in medium-tier chains — beats opus:medium and sonnet-5:high outright; added to worker/research/orchestrator fallbacks |
| claude-opus-4.8 [max] | 59% | $13.22 | Drop | fable:high beats it by 10 pts for less money |
| claude-opus-4.8 [xhigh] | 54% | $8.01 | Demoted | 2× the cost of opus:high for +2 pts — kept only in the design chain (quality-first, unbenchmarked domain) |
| gpt-5.5 [medium] | 54% | $2.75 | Best value on the board | The workhorse: goal/ralph workers, research, orchestrator, worker + code-simplifier subagents |
| claude-sonnet-5 [max] | 54% | $26.40 | Drop everywhere | Worst value on the chart; 268 steps of meandering |
| claude-opus-4.8 [high] | 52% | $4.28 | Fallback only | Opus's value point — standard opus level in reviewer/planner/debugger chains (provider diversity + 1M long-context niche) |
| gpt-5.4 [xhigh] | 52% | $5.65 | Superseded | gpt-5.5 high is +12 pts for −$0.55 (gpt-5.4-mini:low stays in locator/explorer roles — unmeasured, token-price tier) |
| claude-sonnet-5 [xhigh/high/medium/low] | 31–50% | $2.19–11.89 | Drop everywhere | Dominated at every level by gpt-5.5 medium; removed from all chains |
| claude-opus-4.8 [medium] | 49% | $3.44 | Fallback tail | Kept in medium-tier chains as the cheap Anthropic backstop |
| glm-5.2 [max→xhigh] | 44% | $3.92 | Diversity only | Reviewer-C primary (third model family decorrelates review errors); budget fallback elsewhere |
| claude-opus-4.8 [low] | 41% | $2.29 | Skip | Cheapest opus tier, but dominated by fable:low (+19 pts for +$1.47) — not on the frontier |
| gemini-3.5-flash [medium] | 37% | $7.34 | Drop from reasoning | Token hose (276k output tokens); kept only at :low in retrieval chains where token price rules |
| glm-5.2 [high] | 36% | $2.84 | Drop | gpt-5.5 medium is cheaper AND +18 pts |
| kimi-k2.7-code | 31% | $2.82 | Drop | Dominated; not in any chain |
| claude-sonnet-4.6 [high] | 30% | $5.52 | Drop everywhere | Removed from all chains |
| gpt-5.5 [low] | 27% | $1.20 | Niche | Trivial/mechanical one-shots; 28 steps, 9.4k tokens — cheapest and fastest |
| gemini-3.1-pro [high] | 12% | $9.48 | Drop everywhere | Value destruction; removed from all chains |

### Newer model families on `main`

The following families are in active use on `main` but do not yet have comparable `pass@1 / $ per task` benchmark data collected under the same harness. They are marked **unmeasured**. Unmeasured models may still remain operational defaults; absence of a score here is not a recommendation to remove them from routing.

| Model | pass@1 | $/task | Status | Notes |
| --- | --- | --- | --- | --- |
| gpt-5.6 Sol | — | — | Unmeasured | In use on `main`; benchmark under the shared harness pending |
| gpt-5.6 Terra | — | — | Unmeasured | In use on `main`; benchmark under the shared harness pending |

Refresh these rows with measured values once comparable data is available, and re-timestamp the page.

## Scenario-based guidance

Pick by the cost of being wrong in each role, not by raw accuracy.

- **Reviewer / judgment gates** — a wrong verdict discards an entire loop, so pay for accuracy: `claude-fable-5 [xhigh]` primary, `gpt-5.5 [xhigh]` as reviewer-B, and `glm-5.2` as reviewer-C for provider-diverse, decorrelated errors.
- **Planner** — `claude-fable-5 [xhigh]` for deep-research planning; `claude-fable-5 [medium]` as the faster, cheaper alternative when step count matters.
- **Debugger** — `gpt-5.5 [xhigh]` primary; deep reasoning pays off where root-causing is expensive.
- **Research** — `gpt-5.5 [medium]` as the workhorse, with `claude-fable-5 [low]` in the fallback chain for Anthropic diversity.
- **Orchestrator** — `gpt-5.5 [medium]`, with opus/fable fallbacks for provider diversity.
- **Worker / cheap loops** — `gpt-5.5 [medium]` for the main worker and code-simplifier subagents; `gpt-5.5 [low]` for trivial mechanical one-shots.
- **Design** — `claude-opus-4.8 [xhigh]` is kept here specifically because design is a quality-first, unbenchmarked domain.
- **Interactive coding sessions** — `gpt-5.5 [high]` as a balanced default.

## Related

- [Pareto Efficiency](/models/pareto-efficiency) — cost-vs-accuracy frontier, dominated models, and provider-diversity exceptions.
- [Artificial Analysis Index](/models/artificial-analysis-index) — how external benchmark sources inform these static docs.
- [Custom models](/models) — how to add model entries for supported provider APIs.
