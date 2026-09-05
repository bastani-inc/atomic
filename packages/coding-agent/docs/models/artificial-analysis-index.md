---
title: "Benchmark Sources"
description: "The external benchmarks that inform Atomic model selection — Artificial Analysis and DeepSWE — broken down per benchmark: what each measures and when to reference it."
---

# Benchmark Sources

Atomic's model-selection docs are keyed to two live external benchmark sources rather than a hand-maintained table of scores. This page lists each benchmark, what it measures, and **when to reference it** for a given workflow role — so the docs stay useful as new models ship without a manual rewrite every time.

<Warning>
No single benchmark is the source of truth. Validate these inputs against Atomic's own workflow evals, whose task distribution is closer to the work you intend to run. Artificial Analysis was re-fetched on **2026-09-05**, including its September 4 Intelligence Index revision. The linked DeepSWE tables retain their **2026-09-03** compilation date. A separate DeepSWE browser check on **2026-09-05** confirmed the September 3 source update and Gemini 3.8 Flash's measured row; this AA refresh does not claim to revalidate every DeepSWE configuration.
</Warning>

## The two sources at a glance

| Source | URL | What it is | Reference it for |
| --- | --- | --- | --- |
| DeepSWE | [deepswe.datacurve.ai](https://deepswe.datacurve.ai/) | Long-horizon, contamination-free software-engineering tasks (113 tasks, 91 repos, 5 languages), all run on `mini-swe-agent` for consistency | The primary signal for coding-agent routing: real `pass@1`, cost, output tokens, and agent steps on engineering-loop work |
| Artificial Analysis | [artificialanalysis.ai](https://artificialanalysis.ai/) | Model intelligence and professional capability indices, individual evaluations, and a separate coding-agent leaderboard | Cross-domain intelligence, tool use, knowledge reliability, long context, and agent/model comparisons |

## DeepSWE — coding-agent performance

DeepSWE is the closest public proxy for what Atomic actually does. Tasks are written from scratch (not scraped from PRs), so no model has seen the solutions; solutions require substantially more code than SWE-bench-style suites; and verifiers test behavior rather than implementation.

- **Current snapshot:** DeepSWE v1.1, 113 tasks across 91 repositories and 5 languages, updated September 3, 2026. The site reports 28 measured models and displays 21 leaderboard rows by default, out of 70 published model/effort configurations.
- **Metric:** `pass@1`, plus average cost per task, output tokens, and agent steps.
- **When to reference:** default weighting for debugger, worker, and any code-writing role. This is the table that drives [Model Selection](/models/model-selection) and [Pareto Efficiency](/models/pareto-efficiency).
- **Watch:** cost and step count, not just score — a model that passes but takes 268 steps (e.g. sonnet-5) is a poor worker even at a good pass rate, and the two accuracy leaders sit at opposite ends of that axis: Gemini 3.8 Flash leads the highest-published-effort reading the linked pages use at 166 average steps, while the live default Best view's leader, GPT-6 Astra [xhigh], averages 29.

## Artificial Analysis: current measures

### Intelligence Index v4.2

The [September 4, 2026 announcement](https://artificialanalysis.ai/articles/artificial-analysis-intelligence-index-v4-2) and [current methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking), retrieved 2026-09-05, identify **Artificial Analysis Intelligence Index v4.2**. It adds AA-Briefcase and GDP.pdf, removes GPQA Diamond from this index, upgrades AA-LCR to v1.1, improves SciCode grading, and rebalances the weights. It also revises GDPval-AA v2 and AA-Briefcase Elo sampling and anchoring. Do not compare scores across index revisions as though only the models changed. The announcement describes v5 as upcoming, not current.

The ten evaluations and their contributions are:

| Category and total weight | Evaluation | Index weight | Use it for |
| --- | --- | --- | --- |
| Agents, 30% | AA-Briefcase | 15% | Multi-week knowledge-work projects and file deliverables |
| Agents | GDPval-AA v2 | 10% | Economically realistic professional work |
| Agents | 𝜏³-Banking | 5% | Tool use and customer interaction |
| Coding, 20% | Terminal-Bench v2.1 | 10% | Terminal execution and debugging |
| Coding | SciCode | 10% | Scientific programming |
| Scientific Reasoning, 20% | Humanity's Last Exam | 10% | Hard reasoning and knowledge |
| Scientific Reasoning | CritPt | 10% | Physics reasoning |
| General, 30% | AA-Omniscience | 15% | Knowledge accuracy, 10%, and non-hallucination, 5%, as separate components |
| General | GDP.pdf | 10% | Professional document reasoning; headline All-pass requires every criterion to pass |
| General | AA-LCR v1.1 | 5% | Long-context reasoning |

This is primarily a text-based, English-language suite, not a universal measure of multimodal or multilingual quality. The [additional evaluations](https://artificialanalysis.ai/methodology/intelligence-benchmarking#additional-evaluations), such as AutomationBench-AA, AA-AnalystAgent and ITBench-AA, can be better matches for SaaS workflows, spreadsheet analysis or incident diagnosis. Their presence on the site does not make them Intelligence Index components. GPQA Diamond also remains visible separately and in the Engineering capability index.

### Coding Agent Index v1.4 is a different comparison

The [Artificial Analysis Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents) evaluates named **agent + model + settings** combinations, not interchangeable base-model rows. Its [methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking), retrieved 2026-09-05, identifies **v1.4**, current since August 2026. It equally weights DeepSWE, Terminal-Bench v2.1 and SWE-Atlas-QnA. Those components contain 113, 89 and 124 tasks respectively, each with three attempts per task. Per-evaluation pass@1 averages attempts within a task, then tasks within an evaluation. Reward-hacked Terminal-Bench attempts receive zero.

Cost and execution time instead pool task attempts across the suite. Cost uses pay-per-token API pricing, including supported cache charges, not subscription-plan prices. Execution time is measured wall time; missing telemetry is excluded from the relevant average, not treated as zero. Agent defaults apply unless the row specifies other settings.

AA's DeepSWE component uses the DeepSWE dataset with the named agent. It is not the same experiment as Datacurve's `mini-swe-agent` leaderboard. Neither its component score nor its composite belongs in the [DeepSWE frontier](/models/pareto-efficiency).

Earlier versions of these docs referred to a base-model **Coding Index** and **Agentic Index**. Neither is listed in the current [capability directory](https://artificialanalysis.ai/models/capabilities) or [capability methodology](https://artificialanalysis.ai/methodology/capability-indices) inspected on 2026-09-05. We therefore do not assign them a current version or silently rename either to Coding Agent Index. Use the named coding and agentic evaluations above instead.

### Professional capability indices

The current directory lists Finance & Accounting, Strategy & Ops, Legal, Healthcare & Medical, Engineering, and Economics. The [capability methodology](https://artificialanalysis.ai/methodology/capability-indices) specifies domain-dependent components and weights, rather than a single shared formula. It displays no version identifier. Use the matching domain index when its task mix fits your work.

### Price, task cost and latency

Read the [definitions](https://artificialanalysis.ai/methodology#definitions) and [API performance methodology](https://artificialanalysis.ai/methodology/performance-benchmarking), retrieved 2026-09-05, before comparing efficiency charts:

- Token prices are USD per million native tokens. AA's blended price assumes cache-hit, input and output tokens in a **7:2:1** ratio. That synthetic mix is not your workflow's bill.
- Intelligence Index cost per task uses actual token consumption, provider prices and typical measured cache hit rates, weighted by the index's evaluation weights. It is neither the total cost of running the suite nor DeepSWE dollars per task.
- Output speed uses standardized `o200k_base` tokens after the first chunk. The default workload is **10k input tokens**; the usual displayed result is the median over **72 hours**. The **100k** workload instead uses a **14-day** median. These are API measurements, not coding-agent completion times.
- Time to first token can mean the first reasoning token. Time to first answer token includes thinking time. Compare these separately from output speed when interactive latency matters.
- The homepage's Intelligence Index **Time per Task** estimates weighted decode time from output tokens and speed; it excludes TTFT and overhead. Do not call it measured end-to-end wall time. The Coding Agent Index execution-time metric does measure wall time.

## Role to benchmark map

| Role | Primary evidence | Cross-check |
| --- | --- | --- |
| Debugger / coding worker | Datacurve DeepSWE pass@1, cost and steps | AA Terminal-Bench; Coding Agent Index with the actual agent identified |
| Reviewer / judgment gate | Task-specific Atomic evals and DeepSWE for code judgments | AA-Briefcase and knowledge reliability for broader judgments |
| Planner / orchestrator | AA-Briefcase, GDPval-AA v2 | 𝜏³-Banking for tool interaction |
| Research | AA-LCR v1.1, GDP.pdf | AA-Omniscience accuracy and non-hallucination |
| Domain-specific work | Matching AA capability index | Its component evaluations |

See [Model Selection](/models/model-selection) for a small dated shortlist and production effort guidance. Benchmark settings are measurement configurations, not instructions to raise every role's effort.

## Keeping the docs fresh

1. Record each source's retrieval date separately from its publication or snapshot date. Follow the rendered charts and methodology, not just an old article's score.
2. Preserve exact model, reasoning configuration, agent, benchmark version and units. A changed index or agent can change the ranking without a new model release.
3. Say **unmeasured on the named benchmark and date**. Missing text extraction is not evidence of absence; inspect the rendered page. Never transfer a predecessor's score.
4. Check the configured catalog and live provider access separately. These docs do not change runtime routing or model defaults.

## Related

- [Model Selection](/models/model-selection)
- [Pareto Efficiency](/models/pareto-efficiency)
