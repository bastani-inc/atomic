---
title: "Benchmark Sources"
description: "The external benchmarks that inform Atomic model selection — Artificial Analysis and DeepSWE — broken down per benchmark: what each measures and when to reference it."
---

# Benchmark Sources

Atomic's model-selection docs are keyed to two live external benchmark sources rather than a hand-maintained table of scores. This page lists each benchmark, what it measures, and **when to reference it** for a given workflow role — so the docs stay useful as new models ship without a manual rewrite every time.

<Warning>
No single benchmark is the source of truth. Use these as inputs and validate against Atomic's own workflow evals — public suites test different task distributions than real engineering loops. When Atomic's numbers disagree with a public index, Atomic's evals win. **Last reviewed: 2026-07-17.**
</Warning>

## The two sources at a glance

| Source | URL | What it is | Reference it for |
| --- | --- | --- | --- |
| DeepSWE | [deepswe.datacurve.ai](https://deepswe.datacurve.ai/) | Long-horizon, contamination-free software-engineering tasks (113 tasks, 91 repos, 5 languages), all run on `mini-swe-agent` for consistency | The primary signal for coding-agent routing: real `pass@1`, cost, output tokens, and agent steps on engineering-loop work |
| Artificial Analysis | [artificialanalysis.ai](https://artificialanalysis.ai/) | Cross-provider intelligence, coding, and agentic indices plus per-capability breakdowns | Cross-domain intelligence, tool use, knowledge reliability, long context, and non-coding capabilities |

## DeepSWE — coding-agent performance

DeepSWE is the closest public proxy for what Atomic actually does. Tasks are written from scratch (not scraped from PRs), so no model has seen the solutions; solutions require substantially more code than SWE-bench-style suites; and verifiers test behavior rather than implementation.

- **Metric:** `pass@1`, plus average cost per task, output tokens, and agent steps.
- **When to reference:** default weighting for debugger, worker, and any code-writing role. This is the table that drives [Model Selection](/models/model-selection) and [Pareto Efficiency](/models/pareto-efficiency).
- **Watch:** cost and step count, not just score — a model that passes but takes 268 steps (e.g. sonnet-5) is a poor worker even at a good pass rate.

## Artificial Analysis — intelligence and capability breakdown

Artificial Analysis separates performance by benchmark, which lets a workflow pick the model that is strong at the *specific* thing a role needs. Reference the individual evaluations, not just the composite index.

### Composite indices

- **Intelligence Index (v4.1)** — composite of the nine evaluations below. Use as a first-pass filter when a new model appears.
- **Coding Index** — coding-weighted sub-index. Cross-check against DeepSWE.
- **Agentic Index** — tool use, planning, autonomy, complex problem solving. The best AA signal for orchestrator and reviewer roles.

### Individual evaluations — what each measures and when to reference

| Benchmark | Measures | Reference it for |
| --- | --- | --- |
| GDPval-AA v2 | Agentic real-world work tasks | Orchestrator / planner roles doing economically realistic work |
| τ³-Banking | Agentic tool use | Tool-heavy workflows and function-calling reliability |
| Terminal-Bench v2.1 | Agentic coding & terminal use | Debugger and shell-driven workers |
| SciCode | Coding (scientific) | Code-writing roles in technical domains |
| Humanity's Last Exam | Reasoning & knowledge | Hard planning / judgment gates |
| GPQA Diamond | Scientific reasoning | Research roles in technical domains |
| CritPt | Physics reasoning | Physics/engineering-heavy tasks |
| AA-Omniscience | Knowledge accuracy & non-hallucination | Research and any role where a confident wrong answer is costly |
| AA-LCR | Long-context reasoning | Large-codebase research and long-session work |

### Capability indices

Artificial Analysis also publishes per-domain capability indices — **Agentic, Coding, Finance & Accounting, Strategy & Ops, Legal, Healthcare & Medical, Engineering, Economics**. When a workflow is domain-specific, pick by the matching capability index rather than the general Intelligence Index.

## Role → benchmark map

A quick lookup for which benchmark to weight per role:

| Role | Primary benchmark | Secondary |
| --- | --- | --- |
| Debugger | DeepSWE pass@1 | Terminal-Bench v2.1 |
| Worker / cheap loop | DeepSWE cost & steps | — |
| Reviewer / judgment gate | DeepSWE pass@1 | AA Agentic Index |
| Planner / orchestrator | AA Agentic Index, GDPval-AA v2 | τ³-Banking (tool use) |
| Research | AA-LCR (long context) | AA-Omniscience (reliability) |
| Domain-specific work | Matching AA capability index | — |

## Keeping the docs fresh

flora131's guidance on this issue: point the model at the live benchmark URLs and describe what each measures and when to reference it, rather than hardcoding scores that go stale on every release.

1. Treat the model-selection pages as timestamped snapshots that read *from* the live sources above.
2. When a new model appears on DeepSWE or Artificial Analysis, add it by pulling its numbers from the source — the frontier may move (as the gpt-5.6 family did).
3. Mark a model **unmeasured** only if it is absent from both sources; unmeasured models may still be operational defaults.
4. Prefer generating the docs and any future routing policy from the same underlying data, so documentation and routing cannot drift apart.

## Related

- [Model Selection](/models/model-selection)
- [Pareto Efficiency](/models/pareto-efficiency)
