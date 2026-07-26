# Task C implementation notes

## Changed files and size

`wc -lc` before → after:

| File | Lines | Characters |
| --- | ---: | ---: |
| `packages/workflows/builtin/shared-prompts.ts` | 146 → 110 | 21,873 → 12,855 |
| `packages/workflows/builtin/goal-prompts.ts` | 386 → 204 | 29,259 → 14,691 |
| `packages/workflows/builtin/goal-orchestrator-prompts.ts` | 133 → 94 | 10,429 → 6,767 |
| `packages/workflows/builtin/goal-runner.ts` | 425 → 393 | 19,510 → 18,036 |
| `test/unit/builtin-workflows-goal-01.test.ts` | 500 → 496 | 20,865 → 20,717 |
| `test/unit/reviewer-intercom-prompt-assertions.ts` | 23 → 20 | 1,231 → 772 |

The two test files were updated only where assertions pinned wording that the rubric required to compress or restructure. Behavioral assertions for delegation damping, evidence grounding, E2E, PR safety, untrusted objective text, and reviewer coordination remain.

## Rubric trace

- `shared-prompts.ts`: §2.1/§2.3 deletion and absolutes discipline; §2.5 reasons; §2.8 compact evidence; §2.12 evidence instead of reasoning; §2.16 scope; §3.3 independent verification, matrix/fidelity, and E2E/video deduplication.
- `goal-prompts.ts`: §2.1 deletion; §2.4 outcome-first; §2.6 descriptive tags; §2.7 artifacts first/query last; §2.8 grounding; §2.11 explicit report shape/length; §2.12 command/output/file evidence; §2.13 wording; §2.16 scope; §3.3 reviewer restructuring and closure preservation.
- `goal-orchestrator-prompts.ts`: §2.4/§2.6/§2.7 ordering and shape; §2.8 grounding; §2.9 delegation damping; §2.10 autonomy/no-promise ending; §2.11 receipt length/shape; §2.16 one-clause scope.
- `goal-runner.ts`: §2.4/§2.6/§2.7 final report first and action query last; §2.8 grounding; §2.10 permission boundary; §2.11 PR report shape; §2.16 scope.
- Test wording updates: §2.1, §2.7, §2.9, and §3.3; no behavioral invariant was weakened.

## Deduplicated rules and canonical surviving locations

1. Literal objective/criteria outrank external assumptions → `shared-prompts.ts` / `LITERAL_OBJECTIVE_CONTRACT`.
2. Clause-by-clause acceptance proof, literal examples, interface decisions, and state matrices → `shared-prompts.ts` / `ACCEPTANCE_MATRIX_CONTRACT`.
3. Contract-fidelity divergence risk classes and selection rule → `shared-prompts.ts` / `CONTRACT_FIDELITY_AUDIT`; composed by `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`.
4. Independent evidence before implementation receipts/tests → `shared-prompts.ts` / `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`.
7. `stop_review_loop` authority and every derivation rule → `shared-prompts.ts` / `EVIDENCE_CLOSURE_POLICY`; the reviewer-specific correctness, oracle, traceability, remaining-verification, and reviewer-error conjunction remains once in `renderReviewerPrompt`'s `output` section.
8. Goal finding selection bar → one `finding_contract` section in `goal-prompts.ts` / `renderReviewerPrompt`; Ralph should use its reviewer finding section once rather than add a second Goal-side restatement.
9. Goal priority, alignment, location, and output rules → one `finding_contract` plus one `output` section in `goal-prompts.ts` / `renderReviewerPrompt`; general closure priority semantics remain canonical in `EVIDENCE_CLOSURE_POLICY`.
10. Goal delegation and todo tracking → `goal-orchestrator-prompts.ts` / `GOAL_ORCHESTRATION_GUIDANCE` and `GOAL_SUBAGENT_TRACKING_GUIDANCE`, each composed once per renderer. Ralph should compose the shared orchestration policy selected by its owning agent rather than restate it inline.
11. Goal cwd propagation → `goal-orchestrator-prompts.ts` / `renderGoalOrchestratorPrompt` `context`; PR-stage cwd context remains in `goal-runner.ts` because it is a separate stage. Ralph retains its own parameterized cwd helper.
12. PR is post-approval and non-blocking → `goal-prompts.ts` / `INTERMEDIATE_PR_HANDOFF_GUARDRAIL`, `renderReviewerPrompt` / `final_action_policy`, and `EVIDENCE_CLOSURE_POLICY` for convergence semantics. Each is a distinct stage/gate rule rather than repeated prose.
13. Inspect repository delta rather than summaries → `shared-prompts.ts` / `REVIEW_CODE_DELTA_CONTRACT`; Goal reviewer composes it once.
14. Missing dependencies require recovery rather than approval → setup side in `shared-prompts.ts` / `WORKER_PREFLIGHT_CONTRACT`; reviewer side once in `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT` plus the reviewer error output requirement.
15. Repair consolidated findings as a batch → `shared-prompts.ts` / `FINDINGS_CONSOLIDATION_CONTRACT`.

Clusters 5–6 (E2E and QA video) are canonical in `shared-prompts.ts`: `E2E_VERIFICATION_GUIDANCE` is the executable E2E attempt/failure-evidence contract, and `renderE2eQaVideoReviewGuidance` is the current/inspected/non-fabricated QA-video review contract. Ralph renderers should compose these rather than restate them.

## Preservation audit

Checked every rule in the relevant `rule-inventory.md` sections. No distinct semantic rule was eliminated; compressed statements retain setup recovery, literal-contract defaults, matrix/state coverage, risk selection, anti-circular evidence, reviewer coordination, durable regressions, consolidated repair, worktree/delta integrity, blocker thresholds, PR authorization, finding shape/alignment, and all convergence derivations.

All structured names remain present where they appeared: `stop_review_loop`, `objective_alignment`, `required_by_objective`, `consistent_with_objective`, `beyond_objective`, `contradicts_objective`, `requirements_traceability`, `overall_correctness`, `reviewer_error`, `overall_explanation`, and `code_location`. Priority values P0–P3 and numeric 0–3 remain. Template/tool/path literals in scope remain, including `playwright-cli`, `tmux`, `fetch_content`, `intercom`, and `git status --porcelain`.

## Export preservation

Regenerated with `.atomic/research/prompt-opt/baseline/export-inventory-rerun.ts`, filtered to the six owned modules, and diffed against the baseline: **empty diff**. No export name, kind, or signature changed.

## Deliberately unchanged

- `goal-review.ts` and `review-convergence.ts`: no model-facing prompt strings; parser, convergence logic, fields, and blocking semantics were intentionally untouched.
- Docs/changelog: excluded by the task's edit-only file boundary; this changes internal shipped prompt wording, not a user API.

## Validation

- `bun run typecheck`: pass.
- `bun run check:file-length`: pass (2,450 files checked).
- Goal prompt tests: 22 pass, 0 fail.
- Ralph tests exercising the shared contracts: 16 pass, 0 fail.
- Full `bun run test:unit`: 4,215 pass, 2 skip, 2 fail. The remaining failures are outside Task C (`removed provider active surfaces` and `workflow stage bundled resources`) and arise from concurrent edits to model policies/subagent definitions; no Task C/Goal/shared-contract test fails.
- Export diff: empty.
- Structured-field preservation check: every field present at baseline remains present.
- Hazard grep: `NO MATCHES`.
