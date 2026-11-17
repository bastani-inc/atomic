---
title: "Model Selection"
description: "General model-selection guidance for Atomic, including automatic routing, effort levels, and catalog safety."
---

# Model Selection

Choose for the actual task, not a model's name or aggregate rank. Prefer the least expensive model that can do the work well enough, and validate important results with tools, tests, and review. For dated benchmark records, read [Evals](/models/evals).

## Automatic subagent and workflow-stage routing

Subagent and workflow-stage `model: "auto"` routes before execution starts in at most two short requests:

1. **Task questions, answered by a chat model.** Kind of work, difficulty, mistake cost, image input, very large context, and speed sensitivity, read by `decisionModel` when that is a chat model or else your current model (or the cheapest eligible model that fits an oversized task); classifiers never read the task. Stated `taskNeeds` fields are skipped, and stating all six skips this request. Computer-use tasks default to needing images.
2. **Shortlist choice, made by the router without the task.** Atomic drops models that cannot read required images, prefers 400k-token windows for long-context tasks, and ranks the rest on the [Evals](/models/evals) results for that work by proven quality versus price (quality minus uncertainty for estimated rows) and recency. Hard coding and review weight DeepSWE and FrontierCode; terminal work weights Terminal-Bench 4.0. The top six distinct models form the shortlist (a model's fast route and the same model across providers share one slot), or the eligible `modelConstraints.allowedModels` entries when set. Single-option shortlists skip this request.

Effort follows task difficulty (one level lower when speed matters), clamped to supported levels; the next two ranked models become fallbacks. The router cannot add candidates, bypass constraints, alter prompts, or change the selected chat model. [`decisionModel`](/settings#decisionmodel) selects the router (unset or `auto` uses the current chat model). Only chat language models are execution candidates, though workflows can call classifier and image models in [`ctx.tool`](/workflows/authoring#classifier-and-image-models-in-ctx-tool). Set [`modelRouting`](/settings#modelrouting) to filter providers or models.

Routing locally excludes models whose providers lack usable credentials, even when `allowedModels` names them. Excluded models cannot read the task or become fallbacks; if no allowed model has credentials, routing fails without widening the list. A chat `decisionModel` without credentials fails naming its model and provider, and falls back to the current chat model only when it has credentials and meets every constraint.

## Fallbacks and credentials

A model chain is a pinned model followed by `fallbackModels` in a session, subagent, or workflow stage:

- Candidates whose providers lack usable credentials are skipped before any request (`fallback.skipped` on session `model_change` entries; `modelAttempts` on subagents and stages).
- A provider that rejects credentials (HTTP 401, an invalid, expired, leaked, disabled, or service-blocked API key, an expired or invalid security token, an invalidated token, or a suspended API consumer) is skipped for the rest of that walk. A model-scoped HTTP 403 (such as missing model access or moderation) blocks only that model, leaving other models on that provider eligible.
- A chain with no usable model fails at once naming each model and missing provider, or blocks for resume in a workflow stage. A single pinned model with no fallbacks is never replaced.

Applicable `modelConstraints` gate workflow-stage model chains and execution fallbacks; `modelRouting` gates `auto` selection and its fallbacks; skipping uncredentialed models never widens any allowed list. Image-requiring tasks keep that requirement on every execution fallback and restored routing choice and never degrade to a text-only model.

## Benchmarks are evidence, not policy

Benchmark results are measurements under named harnesses, dates, models, efforts, tools, and scoring rules. Treat a bracketed effort level as the measurement configuration for that row, not a command to run every task at that effort. Compare only records whose measured setup resembles the decision at hand, and keep unmeasured work under ordinary validation rather than inheriting a score.

Missing evidence is unknown, not zero. A rounded lead is not proof of significance. A result for one provider, model version, effort, or harness does not transfer to another.

Prefer recency. Each row in [Evals](/models/evals) has a release date. When candidates fit the same role tier and price range, choose the most recently released model over an older one from the same provider or family; a newer release usually supersedes it. Do not let an older model win only because it has no published results. Recency does not override the role's cost tier or explicit constraints.

## Role-based thinking effort

Use these starting defaults unless the user requests a level. Higher effort can improve hard reasoning, but it also costs more and can be slower. `max` is an exception, not a default.

Price is per task (USD per million tokens times token volume). High-volume, tool-checked roles default to cheaper, faster models; roles where a missed defect is expensive justify frontier models at high effort. Pick the cost tier first, then the effort within it; do not compensate for a cheap model with `max` or for an expensive one with `minimal`.

| Stage role | Default thinking level | Model cost tier | Why |
| --- | --- | --- | --- |
| Codebase exploration: locating files, reading code, tracing call sites | `minimal` or `low` | Cheap, fast | Tool lookups need speed; escalate when the question becomes a design judgment. |
| Coding, implementation, routine fixes | `low` or `medium` | Cheap or mid-priced | Runs often per task and is validated by tools and review afterwards. |
| Code review, test design, failure analysis, security, identity, adversarial challenge, final approval | `high` or `xhigh` | Frontier | Missed defects are expensive; spend the strongest model and reasoning here. |
| Codebase mapping, lifecycle analysis, compatibility, planning, synthesis, triage | `high` | Frontier or mid-priced | Resolve ambiguity before downstream work depends on it. |
| Orchestration, delegation, and multi-stage coordination | `medium` or `high` | Mid-priced | Judge scope, sequence work, and integrate verified stage results. |
| User-impact review and final reporting | `medium` | Mid-priced | Preserve evidence and communicate clearly without extra reasoning. |
| Deterministic checks | No model call | — | Run tests, typechecks, probes, and scripts directly. |

An explicit user request wins over these defaults, but the requested level must exist for the selected catalog entry. Do not invent unsupported suffixes. If `xhigh` is unavailable, use `high` rather than automatically promoting to `max`; choose another catalog model or leave the stage unpinned if neither fits.

## Pin model identity from the catalog

Choose only eligible provider/model and effort pairs from the supplied catalog. A guide or leaderboard cannot prove local credentials, quota, region access, or entitlement. Use `workflow({ action: "models" })` or `--list-models` to pin a returned `fullId`, `modelConstraints.allowedModels` for hard restrictions, and the task text for softer preferences.

## Answering model-choice questions

For interactive advice, read [Evals](/models/evals), then consult the live source when current scores, prices, latency, or methodology matter. Cite the benchmark, access date, exact model/effort, units, and cost or latency tradeoffs, or state that you are using the dated docs snapshot.
