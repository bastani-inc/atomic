---
title: "Model Selection"
description: "General model-selection guidance for Atomic, including automatic routing, effort levels, and catalog safety."
---

# Model Selection

Choose for the actual task, not a model's name or aggregate rank. Prefer the least expensive model that can do the work well enough, and validate important results with tools, tests, and review.

For specific benchmark records, read [Evals](/models/evals). That page is the dated factual source for external results. This guide explains how to use model evidence without turning benchmark settings into blanket defaults.

## Automatic subagent and workflow-stage routing

Subagent and workflow-stage `model: "auto"` routes before execution starts, in at most two short requests:

1. **Questions about the task, answered by a chat model.** Kind of work, difficulty, mistake cost, image input, very large context, and whether speed matters. The chat model is `routerModel` when that is a chat model, otherwise your current one; a classifier such as Jev never reads the task. Anything the caller states in `taskNeeds` is not asked, and when the caller states all six this request is skipped. Computer-use tasks always count as needing images.
2. **A choice between a shortlist, made by the router without the task.** Atomic narrows the eligible models in code: it drops models that cannot read images when the task needs them and prefers 400k-token windows for long-context tasks, then ranks the rest on the [Evals](/models/evals) results for that kind of work, weighing proven quality against price by how demanding the task is and preferring newer releases. The top six different models form the shortlist; a model's fast route and the same model on another provider share one place. When the caller lists models in `modelConstraints.allowedModels`, those eligible models are the shortlist instead (as many as fit one routing request). Each option carries its own evidence (release date, price tier, image input, and how it was measured on this kind of work and overall), ranked against every model you could route to. With a single option, this request is skipped.

Effort follows the task's difficulty, one level lower when speed matters, limited to the levels the chosen model supports. The two fallbacks are the next models in Atomic's ranking. The router cannot add candidates, bypass constraints, alter the execution prompt, or change the selected chat model. [`routerModel`](/settings#routermodel) chooses the decision model only: an explicit registered classifier or chat language model. Unset and `auto` use the current chat model, regardless of saved classifier credentials. An image-generation model cannot decide.

Only chat language models are eligible for execution `auto`, including models that accept image or PDF input. Image-generation and classifier models cannot be execution candidates, even when a classifier makes the routing decision.

In authored workflows, a classifier can make a structured triage decision without executing the stage; an image model can generate an asset inside a durable tool step. See [classifier and image models in `ctx.tool`](/workflows/authoring#classifier-and-image-models-in-ctx-tool).

To keep some providers out of routing entirely, set [`modelRouting`](/settings#modelrouting).

## Benchmarks are evidence, not policy

Benchmark results are measurements under named harnesses, dates, models, efforts, agents, tools, prompts, prices, and scoring rules. Treat a bracketed effort level as the measurement configuration for that row, not a command to run every task at that effort. Compare only records whose measured setup resembles the decision at hand, and keep unmeasured work under ordinary validation rather than inheriting a score.

Missing evidence is unknown, not zero. A rounded lead is not proof of significance. A result for one provider, model version, effort, agent, fallback setting, or benchmark harness does not transfer to another identity.

Prefer recency. Each row in [Evals](/models/evals) has a release date. When candidates fit the same role tier and price range, choose the most recently released model over an older one from the same provider or family; a newer release usually supersedes it. Do not let an older model win only because it has no published results: its missing evidence stays unknown, and a recent comparable model with evidence is the safer choice. Recency does not override the role's cost tier or explicit constraints.

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
