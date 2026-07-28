# Task C report

Optimized the Goal workflow prompt surface and shared contracts for query-last ordering, compact evidence grounding, explicit output shape, delegation damping, and cross-model safety.

## Changed files (`wc -lc` before → after)

- `packages/workflows/builtin/shared-prompts.ts`: 146/21,873 → 110/12,855
- `packages/workflows/builtin/goal-prompts.ts`: 386/29,259 → 204/14,691
- `packages/workflows/builtin/goal-orchestrator-prompts.ts`: 133/10,429 → 94/6,767
- `packages/workflows/builtin/goal-runner.ts`: 425/19,510 → 393/18,036
- `test/unit/builtin-workflows-goal-01.test.ts`: 500/20,865 → 496/20,717
- `test/unit/reviewer-intercom-prompt-assertions.ts`: 23/1,231 → 20/772

`goal-review.ts` and `review-convergence.ts` were inspected and left unchanged because they contain convergence/parser logic rather than model prompts.

## Canonical homes for collapsed clusters

1. Literal objective fidelity: `LITERAL_OBJECTIVE_CONTRACT`.
2. Clause-by-clause acceptance/state matrix: `ACCEPTANCE_MATRIX_CONTRACT`.
3. Divergence risk classes: `CONTRACT_FIDELITY_AUDIT`, composed by `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`.
4. Anti-circular independent proof: `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`.
7. Complete `stop_review_loop` derivation: `EVIDENCE_CLOSURE_POLICY` plus the single Goal schema conjunction in `renderReviewerPrompt`'s `output` section.
8–9. Goal finding selection/shape: single `finding_contract` and `output` sections in `renderReviewerPrompt`; closure priorities remain in `EVIDENCE_CLOSURE_POLICY`.
10. Delegation/todo: `GOAL_ORCHESTRATION_GUIDANCE` and `GOAL_SUBAGENT_TRACKING_GUIDANCE`.
11. Cwd propagation: each stage's single parameterized `context` section.
12. PR handoff: `INTERMEDIATE_PR_HANDOFF_GUARDRAIL`; non-blocking convergence in `EVIDENCE_CLOSURE_POLICY`.
13. Repository delta integrity: `REVIEW_CODE_DELTA_CONTRACT`.
14. Setup/recovery: `WORKER_PREFLIGHT_CONTRACT`; reviewer recovery/error handling in `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`.
15. Consolidated repairs: `FINDINGS_CONSOLIDATION_CONTRACT`.

The canonical E2E contract is `E2E_VERIFICATION_GUIDANCE`; the canonical current-video inspection contract is `renderE2eQaVideoReviewGuidance`. Ralph should compose these shared surfaces rather than restating them.

No distinct semantic rule was eliminated, checked against the relevant rule-inventory sections. Full details and rubric traces are in `.atomic/research/prompt-opt/notes/task-C.md`.

## Gates

- Typecheck: pass.
- File-length gate: pass.
- Goal prompt tests: 22 pass.
- Ralph/shared-contract tests: 16 pass.
- Full unit suite: 4,215 pass, 2 skip, 2 unrelated concurrent-edit failures (`removed provider active surfaces`, `workflow stage bundled resources`).
- Export inventory diff for owned modules: **empty**.
- Structured field preservation: pass; every baseline field remains.
- Hazard grep output: **NO MATCHES**.
