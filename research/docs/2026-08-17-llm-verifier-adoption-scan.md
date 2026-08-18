# LLM-as-a-Verifier adoption — consolidated scan (issues, reference repo, code ground truth)

**Date:** 2026-08-17
**Sources:** GitHub issues bastani-inc/atomic #2487–#2491, #2493, #2494, #2212; reference repo [llm-as-a-verifier/llm-as-a-verifier](https://github.com/llm-as-a-verifier/llm-as-a-verifier) (arXiv:2607.05391, v0.2.0); local code inspection at commit `9d0a69da0e` (main).
**Supersedes:** the archived evidence sections of closed issues #2254–#2261 remain the paper-citation reference; this scan adds the 0.2.0 engineering layer and the code ground truth for spec-writing.

## 1. The issue set and its dependency DAG

| Issue | Title (short) | Depends on |
|---|---|---|
| #2487 | shared `criteria.md` rubric format, per-criterion scoring, mean+veto aggregation | — |
| #2493 | prefix-cache-aware verifier prompts + warm-first fan-out | #2487 (shapes its prompt builders) |
| #2488 | tournament → soft-scored selection (graded scores, K repeats w/ slot swap, Bradley–Terry, PPT) | #2487 |
| #2489 | trajectory progress-scoring primitive with skeptical calibration | #2487 |
| #2490 | goal/ralph graded review signals: targeted re-verification + convergence trends | #2487, #2489 |
| #2491 | docs: verification-scaling guidance for custom-workflow authors | phase 1 independent; phase 2 trails each ship |
| #2494 | verifier call/token usage + cache-hit rate in verification ledgers | none hard; annotates ledgers #2488 rewrites |
| #2212 | per-run time/token budgets with resumable `budget_exceeded` outcome | duration slice independent; token slice wants #2494's usage reducer |

The graph forks at #2487 (both #2488 and #2489 depend on it, not on each other) and rejoins at #2490.

## 2. Decisions already made (owner: flora131)

1. **No logprobs.** #2260 closed: Atomic providers expose no token logprobs; the K-sample Monte-Carlo average is the accepted substitute for the paper's Eq. 3.1 expectation (~16× call cost for K=16 parity).
2. **In-place upgrade of `tournament`,** not a new select-best-of-n workflow (#2488 header).
3. **Progress score is never a kill switch** (#2489): monitoring + escalate-to-human only; measured VOC separation is +0.079.
4. **`stop_review_loop` stays authoritative** for goal/ralph (#2490): graded signals inform, never approve/terminate.
5. **Parse failures are indeterminate re-asks, never counted votes** (#2487/#2488) and **never durably checkpointed as scores** (#2488 comment; mirrors reference `on_error="tie"` being run-local, never cached).
6. **Budget exhaustion reports `budget_exceeded`** as a returned status on the `blocked` exit rail, joining `RETURNED_BLOCKED_STATUSES` beside `auth_blocked`, resumable by construction (#2212 amendment). `WorkflowExitStatus` union unchanged.
7. **Compatibility posture (spec-phase decision): breaking changes allowed freely.** The verification builtins are treated as pre-1.0 internals; the "output contract preserved or versioned deliberately" clauses in #2487/#2488 are relaxed by owner decision. Existing outputs are documented as current state, not constraints.
8. **Delivery shape (spec-phase decision):** one linear gh-stack per cluster in its own worktree; every PR < 500 changed lines; each PR body carries an Evidence section (acceptance-criteria checklist, exact commands, trimmed real output, diff stat).
9. **Budget shape (spec-phase decision, codex prior art):** `WorkflowBudget { maxDurationMs, maxTokens, maxCost, warnAtPercent }`, every field defaulting to `0` = unbudgeted; declared at config, definition (`workflow({ budget })`), and per-run via the workflow tool, resolved **later-wins per-field** (run > definition > config, overrides may widen/narrow/disable). `maxTokens` charges **uncached input + output** — openai/codex's goal-budget formula (`goal_token_delta_for_usage` in `codex-rs/ext/goal/src/accounting.rs`: `(input − cached_input) + output`; cache reads free, cache writes uncounted); cache-heavy spend is governed by `maxCost` (USD from `usage.cost`) instead of inflating the token meter. Exhaustion is a **soft landing**: one-time wrap-up injection to the frontier stage (codex `budget_limit.md` pattern; delivered once per run per budget), then stop with system-owned `budget_exceeded`. Accounting mechanics from codex: monotone saturating deltas, serialized single-accountant charging, baselines surviving durable resume. Codex's rollout budget (`core/src/rollout_budget.rs`, weighted units output×1.0 + uncached_input×0.1, escalating reminders) noted but not adopted — `maxCost` covers the price-shaped need.

## 3. Reference-repo technique inventory → adoption mapping

| Technique (reference location) | Paper/measured evidence | Adopting issue |
|---|---|---|
| `criteria.md` format: ground-truth note, `### Name {#id}` sections, comment stripping, id slugging (`llm_verifier/prompts.py`, `criteria/TEMPLATE.md`) | — | #2487 |
| Per-criterion scoring in separate calls | compound rubrics latch on salient factor; best single criterion 76.4% vs 3-ensemble 78.3% (§4.3) | #2487 |
| Mean aggregation + explicit veto, never unanimity AND | false-accept degrades `(1−p)^K` (#2255 derivation) | #2487 |
| Anchored 20-point scale (letters A–T; integers 1–20 in prompt-template form) | granularity scaling | #2487 (shared constants) |
| Graded pairwise scores → Bradley–Terry soft wins `σ(R_a−R_b)`; win mass `w`, count `c`, rank by `w/c` (`pivot_tournament.py`) | discrete judges tie 26.7% at K=1 | #2488 |
| K repeats with A/B slot swap within each pair | positional bias cancels within pair; variance O(1/K); 74.7%→77.5% K=1→16 | #2488, #2490 |
| PPT: random-Hamiltonian ring pass (slot bias cancels around ring), top-k pivots by ring mean, non-pivot×pivot + pivot×pivot rounds; `N + k(N−k) + C(k,2)` budget | O(Nk) vs O(N²); bo3 86.5%±1.1 vs pass@1 79.4 (oracle 92.1); bo5 88.0%±0.6 vs 78.7 (96.6) | #2488 |
| Directed-comparison cache keyed `(criterion, task, a, b, rep)`; failures scored tie run-locally, never cached | resume/replay identical comparisons | #2488 (ctx.tool durability + seeded PRNG) |
| Progress scoring over trajectory prefixes; skeptical calibration (trust output not narration; effort ≠ progress; declarations = zero evidence; scores may plateau/decrease) (`llm_verifier/progress.py`) | success/failure VOC separation +0.079 | #2489 |
| **Batched multi-checkpoint scoring**: one call scores ALL checkpoints → O(K) cost regardless of length; online `ProgressTracker` = one call/step/repeat, prefix-only | — | #2489 (scope comment) |
| Interior-checkpoint default `2..T-1` | — | #2489 (scope comment) |
| Prefix-cache prompt layout: shared head (task, trajectories, scale), criterion strictly at tail; docstring makes ordering an invariant (`build_prompt`) | hit rate 5.2%→78.4%, ~3.4× fewer uncached input tokens | #2493 |
| Warm-first scheduling: one request per distinct prefix to completion, then fan out (`score_directed_pairs` warm/rest phases) | same measurement | #2493 |
| Token accounting: per-call input/cached-input/output/reasoning, measured hit rate, phase deltas via snapshot subtraction; cached comparisons add nothing (`TokenUsage`) | "measured rather than assumed" | #2494 |
| Self-verification: same model judges its own rollouts, still +7.1/+9.3 over pass@1 | bo3/bo5 table above | #2491 (guidance) |
| Cheap operating points: bo3 = `pivots=1, K=2`; bo5 same shape (`scripts/run_bo3.py`) | — | #2488 defaults, #2491 |
| Multimodal image inputs on every entry point | — | deliberately deferred (no atomic verification builtin consumes screenshots) |
| TurboAgent provider proxy | — | rejected: atomic owns fan-out at the workflow layer |

## 4. Code ground truth (file:line, main @ `9d0a69da0e`)

### Tournament (rewritten by #2488, prompts reshaped by #2493)
- `packages/workflows/builtin/tournament-runner.ts` (194 lines): binary `winner: "first"|"second"` schema at 17–21; single-elimination bracket loop at 103–163 — one binary call eliminates a loser forever; orientation parity trick `(round+index)%2` at 111/137; judge fan-out via `ctx.parallel` at 130; `bracket.json` written at 166–167; outputs at 184–193 (`result`, `winner`, `winner_artifact_path`, `result_path`, `attempt_artifact_paths`, `judge_artifact_paths`, `bracket_path`, `artifact_dir`).
- `packages/workflows/builtin/tournament-prompts.ts`: `renderPairwiseJudgePrompt` leads with pair-specific `candidates` section (37–42), rubric mid-prompt (44–49) — no two judge calls share a usable prompt prefix (the #2493 anti-pattern). Candidate bodies arrive via `reads` (runner 126), i.e. after the prompt — invisible to prefix caching.
- `tournament.ts` (39 lines) + `tournament.d.ts` — definition wrapper + declared outputs.

### Adversarial verification (rewired by #2487)
- `packages/workflows/builtin/adversarial-verification-runner.ts`: hardcoded rubric written inline to `rubric.md`; `verifierSchema` = binary pass/fail verdict + `blocking_findings`; `INVALID_VERIFIER_REPORT` substitutes a fail verdict for an unparseable report — the #2255-inherited bug where a parse failure becomes a substantive objection under the unanimity gate.
- `adversarial-verification.ts` (29 lines) + prompts + `.d.ts`.

### Goal/ralph (consumed by #2490)
- `packages/workflows/builtin/goal-schemas.ts` (82 lines): `confidence_score` per finding and `overall_confidence_score` at 7/71 — collected, then ignored by the gate; compound boolean "patch is correct/incorrect" at 66–69.
- `packages/workflows/builtin/review-convergence.ts` (229 lines): `findingBlocksClosure` at 91–101 reads only `objective_alignment` + `priority`; a 0.51-confidence finding blocks with the authority of a 0.99 one.
- `packages/workflows/builtin/ralph-review-gate.ts` (102 lines): 3–26 documents why `stop_review_loop` stays authoritative (self-referential acceptance criteria deadlocked runs). Hard guards: parse failures and `reviewer_error` never approve.

### Progress-scoring consumers (#2489)
- `packages/workflows/builtin/loop-until-done*.ts` (~36-line definition + runner + prompts): iteration ledger, `done: boolean` stop bit.
- `packages/subagents/src/runs/shared/subagent-control.ts` (223 lines): wall-clock attention thresholds (`activeNoticeAfterMs`, `needsAttentionAfterMs`) — the proxies #2489 supplements (never replaces).

### Usage telemetry (consumed by #2494, #2212)
- `packages/workflows/src/shared/authoring-contract-stage.ts:84–98`: `WorkflowModelUsage { input?, output?, cacheRead?, cacheWrite?, cost?, turns? }`; `WorkflowModelAttempt.usage` carries it. Populated since #2197 closed. `WorkflowTaskResult.modelAttempts` (398–) exposes it per judge/verifier task.
- `packages/workflows/src/durable/dbos-envelope.ts` `isModelUsage` validates the six keys.
- #2197's measured run: 96.1% cache reads (457.8M of 476.4M tokens) — drives #2212 open question 3 (count all four counters).

### Budget substrate (#2212)
- `packages/workflows/src/shared/timing.ts` `elapsedRunMs(run, now)`: subtracts pause intervals, adds `accumulatedDurationMs` — the duration meter, already correct.
- `packages/workflows/src/shared/returned-run-status.ts:5`: `RETURNED_BLOCKED_STATUSES = {"blocked","needs_human","incomplete","auth_blocked","active"}`; `isReturnedResumableBlockedWorkflowStatus` excludes only plain `blocked`. `budget_exceeded` joins here.
- `packages/workflows/src/shared/authoring-contract-stage.ts:34`: `WorkflowExitStatus = "completed"|"skipped"|"cancelled"|"blocked"|"failed"` — unchanged by decision 6.
- `maxDepth` config precedent: `WORKFLOW_CONFIG_DEFAULTS` → validation in `extension/config-file-loader.ts` → `WorkflowEffectiveConfig`.

### Repo delivery constraints
- `packages/workflows` ships raw `.ts`, `.js` import specifiers, **no build step** (AGENTS.md, EXTREMELY_IMPORTANT block).
- Tests: root vitest projects (`npm run test:unit`), `node:assert/strict` style, 30 s shared per-test budget, no `--timeout` restating; load-sensitive tests must derive assertions from named constants.
- Checks: `npm run check` = biome + `tsc --noEmit` + coding-agent `tsgo` pass + shrinkwrap check.
- Existing unit suites touching this area: `test/unit/builtin-workflows-tournament-loop.test.ts`, `test/unit/builtin-workflows-adversarial-generate.test.ts`, `test/unit/review-convergence-closure.test.ts`.
- Worktree convention: sibling dirs `../atomic-<topic>` (34 active worktrees observed). `gh-stack` v0.1.0 installed; stacks are strictly linear (one parent, one child); repo has stacked PRs enabled (existing usage observed).

## 5. Estimates (session consensus)

#2487 ≈ 1.5–2.5 d · #2488 ≈ 3–4 d · #2489 ≈ 1.5–2 d · #2490 ≈ 2–3 d · #2491 ≈ 0.5 d up front + trailing · #2493 ≈ 1 d · #2494 ≈ 0.5–1 d · #2212 duration ≈ 1–1.5 d, token ≈ 1 d. Program total ≈ 11.5–16 focused days human-equivalent; compressed by per-slice autonomous workflows.
