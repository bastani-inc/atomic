---
title: "Model Selection"
description: "General model-selection guidance for Atomic, including automatic routing, effort levels, and catalog safety."
---

# Model Selection

Choose for the actual task, not a model's name or aggregate rank. Prefer the least expensive model that can do the work well enough, and validate important results with tools, tests, and review.

For specific benchmark records, read [Evals](/models/evals). That page is the dated factual source for external results. This guide explains how to use model evidence without turning benchmark settings into blanket defaults.

## Automatic subagent and workflow-stage routing

Subagent and workflow-stage `model: "auto"` routes before execution starts. Atomic sends the router:

- the final task or stage prompt,
- the agent or stage name and description,
- the eligible provider/model and effort choices with catalog capabilities and prices,
- hard `modelConstraints`, and
- the factual markdown tables in [Evals](/models/evals).

The router returns one primary `{ model, effort }` pair and up to two ordered fallback pairs. It cannot add candidates, bypass constraints, alter the execution prompt, change the selected chat model, or use Jev as an execution model. [`routerModel`](/settings#routermodel) chooses the decision provider only.

Long tasks may be excerpted for routing so the decision fits the decision provider's input budget. Execution still receives the full task. Put essential selection requirements in `<keepContext>...</keepContext>` spans because the excerpt preserves those spans, plus the beginning and end of the task.

## Benchmarks are evidence, not policy

Benchmark results are measurements under named harnesses, dates, models, efforts, agents, tools, prompts, prices, and scoring rules. Treat a bracketed effort level as the measurement configuration for that row, not a command to run every task at that effort. Compare only records whose measured setup resembles the decision at hand, and keep unmeasured work under ordinary validation rather than inheriting a score.

Missing evidence is unknown, not zero. A rounded lead is not proof of significance. A result for one provider, model version, effort, agent, fallback setting, or benchmark harness does not transfer to another identity.

## Role-based thinking effort

Use these starting defaults unless the user requests a level. Higher effort can improve hard reasoning, but it also costs more and can be slower. `max` is an exception, not a default.

Price is per task. Candidate cost is USD per million tokens, and roles differ in token volume and in what a mistake costs. High-volume, tool-checked roles such as exploration and routine implementation default to cheaper, faster models; roles where a missed defect is expensive, such as review, verification, and final approval, justify frontier models at high effort. Pick the tier first, then the effort within it; do not compensate for a cheap model with `max` or for an expensive one with `minimal`.

| Stage role | Default thinking level | Model cost tier | Why |
| --- | --- | --- | --- |
| Codebase exploration: locating files, reading code, tracing call sites | `minimal` or `low` | Cheap, fast | Tool-driven lookups need speed, not deliberation; escalate to mapping or analysis only when the question becomes a design judgement. |
| Coding, implementation, routine fixes | `low` or `medium` | Cheap or mid-priced | Runs many times per task and is validated by tools and review afterwards. |
| Code review, test design, failure analysis, security, identity, adversarial challenge, final approval | `high` or `xhigh` | Frontier | A missed defect is the expensive outcome; spend the strongest model and reasoning here. |
| Codebase mapping, lifecycle analysis, compatibility, planning, synthesis, triage | `high` | Frontier or mid-priced | Resolve ambiguity before downstream work depends on it. |
| Orchestration, delegation, and multi-stage coordination | `medium` or `high` | Mid-priced | Judge scope, sequence work, and integrate results without re-deriving what delegated stages already verified. |
| User-impact review and final reporting | `medium` | Mid-priced | Preserve evidence and communicate clearly without unnecessary reasoning. |
| Deterministic checks | No model call | — | Run tests, typechecks, probes, and scripts directly. |

An explicit user request wins over these defaults, but the requested level must exist for the selected catalog entry. Do not invent unsupported suffixes. If `xhigh` is unavailable, use `high` rather than automatically promoting to `max`; choose another catalog model or leave the stage unpinned if neither fits.

## Pin model identity from the catalog

Choose only eligible provider/model and effort pairs from the supplied catalog. A guide, benchmark, or outside leaderboard cannot prove that the local account has credentials, quota, region access, tool support, or entitlement.

For manual selection, use `workflow({ action: "models" })` or `--list-models` and pin a returned `fullId`. Use `modelConstraints.allowedModels` for hard provider or privacy restrictions. Put softer preferences in the task text.

## Answering model-choice questions

For interactive advice, read [Evals](/models/evals), then consult the live source when the choice depends on current scores, prices, latency, or methodology. Cite the benchmark, source date or access date, exact model/effort/configuration, units, and any cost or latency tradeoff. If live evidence is unavailable, say that you are using the dated docs snapshot rather than claiming a refresh.
