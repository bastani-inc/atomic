# Task E prompt optimization notes

## Size changes (`wc -lc`)

| File | Before | After |
| --- | ---: | ---: |
| `packages/workflows/builtin/loop-until-done-prompts.ts` | 79 lines / 3,822 chars | 87 lines / 4,806 chars |
| `packages/workflows/builtin/tournament-prompts.ts` | 79 / 3,727 | 88 / 4,707 |
| `packages/workflows/builtin/classify-and-act-prompts.ts` | 11 / 1,436 | 14 / 2,234 |
| `packages/workflows/builtin/fan-out-and-synthesize-prompts.ts` | 11 / 2,233 | 14 / 3,295 |
| `packages/workflows/builtin/generate-and-filter-prompts.ts` | 15 / 2,564 | 18 / 4,123 |
| `packages/workflows/builtin/adversarial-verification-prompts.ts` | 15 / 2,925 | 18 / 4,469 |
| `packages/workflows/builtin/adversarial-verification-runner.ts` | 93 / 6,598 | 93 / 6,697 |

The increase is deliberate: these short pattern prompts lacked completion bars, stop rules, and explicit output contracts, which are required content under rubric §§2.2, 2.4, and 2.11.

## Edit classes and rubric traceability

- **R1 / §§2.12–2.13:** Replaced ambiguous requests for “concrete reasoning” or explanation with observable evidence, executable checks, and criteria-based justification. Verifier and repair prompts now request commands run, observed output, and `file:line` evidence. The generated verification rubric requires the same evidence.
- **R2 / §2.8:** Added one compact grounded-reporting clause to stages that report work, evidence, progress, repairs, or completion. It lives in each prompt module's module-local `GROUNDED_REPORTING` constant and is rendered once per applicable stage.
- **R3 / §2.11:** Added explicit output shapes and selective length/readability contracts. Structured stages name their schema-facing shape; narrative stages lead with the outcome and preserve facts, decisions, caveats, and next steps without fragment compression.
- **R6 / §2.7:** Moved candidate paths, ledgers, manifests, classification evidence, and other rendered artifacts to the top; moved each task/objective/branch query to the final prompt section.
- **R7 / §§2.4, 2.6:** Added compact `success_criteria`, `stop_rules`/`stop_condition`, and `output_format` contracts while retaining descriptive tags.
- **R8 / §2.5:** Added short consumer reasons where useful: branch artifacts must be independently auditable, synthesis must be traceable rather than majority vote, and final outputs must be usable without unseen conversation context.
- **R5/R12 / §§2.1, 2.3:** Removed internal-deliberation-adjacent phrasing and used decision rules for ranking, stopping, repairing, rejecting, and handling uncertainty. True invariants remain explicit (`exactly one`, authoritative ordering, pass/repair bounds).

## Prompts that gained missing contracts

- `renderIterationPrompt`, `renderEvaluationPrompt`, `renderCompletionPrompt`: explicit stop and report/structured-decision contracts.
- `renderTournamentAttemptPrompt`, `renderPairwiseJudgePrompt`, `renderBracketReducerPrompt`: explicit stopping conditions; pairwise output names `winner`, `rationale`, and `evidence`.
- `classifierPrompt`, `actionPrompt`: explicit success and stop rules; classifier names `category`, `confidence`, and `rationale`.
- `partitionPrompt`, `branchPrompt`, `synthesisPrompt`: explicit completion bars and stop rules at partition, branch, and barrier levels.
- `renderGeneratorPrompt`, `renderFilterPrompt`, `renderJudgePrompt`, `renderFinalShortlistPrompt`: one-candidate/filter/ranking/presentation stop rules and complete output contracts.
- `renderWorkerPrompt`, `renderVerifierPrompt`, `renderReducerPrompt`, `renderRepairPrompt`: completion bars, bounded decisions, evidence requirements, and stop rules.

## Deduplication and preservation

- The grounded-progress and readable-report policies are each authored once per module in `GROUNDED_REPORTING` and `READABLE_REPORT`, then composed into applicable prompts. This avoids repeating their prose within a module while keeping each rendered stage self-contained.
- Existing rubric and decision criteria remain at their single authoritative stage: tournament comparison criteria in `renderPairwiseJudgePrompt`; deduplication/ranking criteria in filter/judge prompts; acceptance/repair/rejection derivation in `renderReducerPrompt`; `done=true`/`done=false` derivation in `renderEvaluationPrompt`.
- No pre-existing distinct semantic rule was eliminated. The baseline rule inventory was checked clause by clause; wording was reorganized or evidence-focused, and every role, scope, artifact, ranking, validation, uncertainty, bound, ordering, and output requirement survives.

## Export preservation

Command: rerun the baseline export inventory, filter baseline/current output to the seven assigned files, then `diff -u` the filtered files.

```text
(empty)
```

Exit status: `0`. No exported symbol or signature changed.

## Deliberately unchanged

- `adversarial-verification-runner.ts` control flow, schemas, task wiring, and types were left unchanged; only the model-read `rubric.md` text changed.
- No `stop_review_loop` or other protected structured-field prose occurs in these assigned prompts, so no gating derivation was introduced or altered.
- Module-local constants were used instead of changing forbidden `shared-prompts.ts` or adding exports.
- Tests outside the assigned edit list were not changed. The one Task E test-sensitive phrase, `Select at most ${shortlistSize} strongest candidates`, remains in the optimized query.
