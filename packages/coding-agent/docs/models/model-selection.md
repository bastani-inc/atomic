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

## Benchmark levels are measurement settings

The thinking level in brackets in the chart is the **measurement configuration used for that benchmark result**, not a universal workflow default. A score measured at `max` does not mean every stage using that model should use `max`; benchmark model identity and production thinking effort are separate choices. When authoring a workflow, choose effort from the stage role and cost of being wrong, then verify that the configured model catalog supports the level.

## Pin model identity

When a workflow needs an exact model, call `workflow({ action: "models" })` and pin a returned `fullId`. Do not pin a
bare model ID: the same exact model ID can belong to more than one provider. For a bare exact `--model` ID, Atomic
uses the sole matching provider with configured authentication; if none or more than one match is authenticated, it
reports the ambiguity. Use `--provider <provider> --model <id>` or `--model <provider>/<id>` to choose explicitly.

## Recommendation chart

The Pareto frontier — models where nothing else is both cheaper and more accurate — is currently **gpt-5.6-sol** (accuracy ceiling), **gpt-5.6-terra**, **kimi-k3**, **gpt-5.6-luna**, **grok-4.5**, and **muse-spark-1.1**. Everything else is dominated and earns a place only through role fit or provider diversity. For the frontier reasoning, see [Pareto Efficiency](/models/pareto-efficiency).

| Model [benchmark measurement level] | pass@1 | $/task | Verdict | Use it for |
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

- **Reviewer / judgment gates** — use `max` when the reviewer makes a security, identity, adversarial, or final-approval decision whose wrong verdict discards an entire loop. `gpt-5.6-sol` remains the accuracy-first model recommendation; use a different family for reviewer-B/C when decorrelated errors matter. Benchmark to weight: DeepSWE pass@1 and the AA Agentic Index.
- **Codebase mapping / planner** — start at `high` for repository mapping, lifecycle analysis, compatibility, and plans. `gpt-5.6-terra` is a strong fit; raise to `max` only when the plan itself gates a high-cost loop or the user asks for it.
- **Debugger / triage / repair** — start at `high`; deep reasoning pays off when root-causing or repairing is costly, but `max` is not the blanket debugger setting. Benchmark to weight: DeepSWE pass@1 and Terminal-Bench.
- **Research / synthesis** — use `high` for demanding research and evidence reconciliation; use `medium` for routine synthesis when the evidence is already strong. `gpt-5.6-luna` is the workhorse model recommendation. Benchmark to weight: AA-LCR (long context) and AA-Omniscience (factual reliability).
- **Orchestrator / worker / cheap loops** — use `high` for demanding workers and `medium` or lower for routine or mechanical loops when their evidence remains sufficient. `gpt-5.6-luna`, `grok-4.5`, and `muse-spark-1.1` are role-fit choices; their bracketed chart levels are measurements, not defaults.
- **User-impact review / final reporting** — use `medium` for impact summaries and reports that preserve the evidence needed by the user. Do not spend `max` here unless the user explicitly requests it or the role has become a high-cost-of-error approval.
- **Design** — a quality-first, unbenchmarked domain; keep a top-tier model (`gpt-5.6-sol` or `claude-fable-5`) when the design decision has high failure cost, and choose effort by the review or approval role rather than by the benchmark row.
- **Interactive coding sessions** — use `high` for complex, multi-step coding and `medium` for routine edits; reserve `max` for a high-cost-of-error judgment or an explicit user request.
- **Deterministic checks** — make typechecks, tests, schema validation, runtime probes, and artifact inspection tool nodes with no model call. Model self-report is not verification evidence.

## Related

- [Pareto Efficiency](/models/pareto-efficiency) — cost-vs-accuracy frontier, dominated models, and provider-diversity exceptions.
- [Benchmark sources & when to reference each](/models/artificial-analysis-index) — what Artificial Analysis and DeepSWE measure, per benchmark, and how to keep these docs fresh from the live source.
- [Custom models](/models) — how to add model entries for supported provider APIs.
