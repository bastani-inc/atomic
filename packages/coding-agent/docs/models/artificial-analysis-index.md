---
title: "Artificial Analysis Index"
description: "How the Artificial Analysis index informs Atomic's static model-selection docs, which benchmark dimensions matter, and how to keep the data fresh."
---

# Artificial Analysis Index

The [Artificial Analysis](https://artificialanalysis.ai/) index is one external benchmark source that can inform Atomic's static model-selection docs. This page summarizes how to read it for Atomic's purposes and, importantly, how **not** to over-rely on it.

<Warning>
The Artificial Analysis index is **one static input**, not the source of truth. Atomic's routing decisions should be validated against workflow-specific evals, because public benchmarks rarely match the distribution of real engineering-loop tasks. **Last reviewed: 2026-07-17.**
</Warning>

## Why it is useful

- It provides cross-provider, cross-model comparisons on a consistent set of public benchmarks, which is a reasonable first filter when a new model appears.
- It tracks both quality and cost/latency dimensions, which maps loosely onto the `pass@1 / $ per task` framing used in [Model Selection](/models/model-selection) and [Pareto Efficiency](/models/pareto-efficiency).
- It updates as providers ship, so it is a useful signal for when a static page has gone stale.

## Relevant benchmark dimensions

When mapping the index onto Atomic model selection, the dimensions that matter most are:

- **Quality / accuracy** — the closest public proxy for Atomic's `pass@1`, though public suites test different task distributions than engineering loops.
- **Price** — input/output token pricing, which feeds the `$ per task` axis once combined with Atomic's typical token and step counts.
- **Throughput / latency** — secondary for batch workflows, but relevant for interactive coding sessions.
- **Context window** — matters for long-context niches (e.g., the opus 1M-context role).

## Caveats

- **Benchmark drift** — public suites are periodically saturated or revised; a score's meaning changes over time.
- **Pricing drift** — provider prices change without notice, which can move a model on or off the Pareto frontier independently of any accuracy change.
- **Distribution mismatch** — a high public score does not guarantee good behavior on Atomic's workflow tasks (step efficiency, tool use, gate discipline). Atomic's own numbers can disagree with the index, and when they do, Atomic's workflow evals win.
- **Harness differences** — `pass@1` and `$ per task` here come from Atomic's harness; public indices use their own. Do not compare the two as if they were the same measurement.
- **Unmeasured models** — families in use on `main` without comparable data (e.g., gpt-5.6 Sol, gpt-5.6 Terra) should be marked unmeasured rather than assigned an index-derived score, since the index number would not be harness-comparable.

## Keeping the docs fresh

1. Treat the model-selection pages as timestamped snapshots. Each carries a "Last compiled / Last reviewed" date.
2. When the index shows a materially new model or a large price/quality move, re-run Atomic's own evals before editing the frontier.
3. Prefer generating the docs and any future routing policy from the **same underlying data file**, so documentation and routing cannot drift apart.
4. Record the benchmark source and collection date whenever numbers are updated.

## Related

- [Model Selection](/models/model-selection)
- [Pareto Efficiency](/models/pareto-efficiency)
