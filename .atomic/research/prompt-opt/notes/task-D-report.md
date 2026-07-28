# Task D report

## Outcome and size

Optimized the Ralph prompt surface, composed canonical shared contracts, moved long context before final instructions, and preserved stage-specific behavior.

| File | `wc -lc` before → after |
| --- | --- |
| `ralph-reviewer-prompt.ts` | 182 / 14,967 → 97 / 7,238 |
| `ralph-forked-prompts.ts` | 103 / 4,805 → 96 / 4,425 |
| `ralph-core.ts` | 432 / 16,648 → 435 / 15,882 |
| `ralph-runner.ts` | 434 / 25,049 → 383 / 19,610 |
| `builtin-workflows-ralph-01.test.ts` | 500 / 20,747 → 496 / 20,610 |
| `builtin-workflows-ralph-02.test.ts` | 493 / 18,434 → 493 / 18,437 |

Test assertions changed only for rubric-required wording and query-last ordering; behavioral checks remain.

## Rubric coverage

- Reviewer: §2.1, §2.3, §2.4, §2.6–§2.8, §2.11, §2.12, §2.16, §3.3.
- Fork continuations: §2.1, §2.7, §2.8, §2.10, §2.11.
- Core research/video helpers: §2.1, §2.7, §2.8, §2.11, §3.3.
- Orchestrator/final handoff: §2.1, §2.4, §2.6–§2.11, §2.16.

## Collapsed duplicated clusters

1 → `LITERAL_OBJECTIVE_CONTRACT`; 2 → `ACCEPTANCE_MATRIX_CONTRACT`; 3 → `CONTRACT_FIDELITY_AUDIT` (nested in `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT` for review, direct for implementation); 4 → `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`; 5 → `E2E_VERIFICATION_GUIDANCE`; 6 → `renderE2eQaVideoReviewGuidance`; 7 → `EVIDENCE_CLOSURE_POLICY`; 9 → one Ralph `finding_contract`/`structured_decision_assurance` plus shared closure semantics; 10 → one delegation decision rule plus one distinct `todo` ledger; 12 → shared closure plus one reviewer final-action policy and the separate authorized handoff stage; 13 → `REVIEW_CODE_DELTA_CONTRACT`; 14 → reviewer recovery in `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT` plus distinct repository installation guidance; 15 → `FINDINGS_CONSOLIDATION_CONTRACT` with fork inheritance.

Ralph-specific statements retained because shared contracts do not cover them: cluster 8 finding selection/tone/changed-location rules; cluster 11 parameterized cwd propagation; run-specific video recording/path/notes and final attachment; reviewer schema conjunction/error handling; PR provider, identity, credential, detached-HEAD, comment-ordering, and failed-handoff behavior.

The full rule-inventory audit found no eliminated distinct semantic rule. Structured field names and P0–P3 / numeric 0–3 values remain. `workflowCwdContextSection` is unchanged.

## Export diff

Filtered against `.atomic/research/prompt-opt/baseline/exports.txt`: empty.

```diff
```

## Gates

- `bun run typecheck`: pass.
- `bun run lint`: pass.
- `bun run check:file-length`: pass (2,450 files).
- Ralph tests: 16 pass, 0 fail.
- `bun run test:unit`: 4,217 pass, 2 skip, 0 fail; 4,219 tests across 553 files.
- Structured-field preservation: pass.
- Hazard grep: no output (`NO MATCHES`).

Detailed preservation and edit notes are in `.atomic/research/prompt-opt/notes/task-D.md`.
