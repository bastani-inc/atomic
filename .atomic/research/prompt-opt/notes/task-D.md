# Task D implementation notes

## Changed files and size

`wc -lc` before → after:

| File | Lines | Characters |
| --- | ---: | ---: |
| `packages/workflows/builtin/ralph-reviewer-prompt.ts` | 182 → 97 | 14,967 → 7,238 |
| `packages/workflows/builtin/ralph-forked-prompts.ts` | 103 → 96 | 4,805 → 4,425 |
| `packages/workflows/builtin/ralph-core.ts` | 432 → 435 | 16,648 → 15,882 |
| `packages/workflows/builtin/ralph-runner.ts` | 434 → 383 | 25,049 → 19,610 |
| `test/unit/builtin-workflows-ralph-01.test.ts` | 500 → 496 | 20,747 → 20,610 |
| `test/unit/builtin-workflows-ralph-02.test.ts` | 493 → 493 | 18,434 → 18,437 |

The test edits update wording/order assertions required by query-last rendering and compressed prompt contracts. Assertions still enforce objective/criteria propagation, reviewer schema fields, fork inheritance, delegation damping, cwd propagation, E2E/video evidence, and PR safety; no behavioral invariant was weakened.

## Rubric trace

- `ralph-reviewer-prompt.ts`: §2.1/§2.3 removed repeated process and closure prose; §2.4/§2.6 outcome sections and descriptive tags; §2.7 artifacts first/query last; §2.8 grounded claims; §2.11 explicit review length/shape; §2.12 commands, observed output, and file:line evidence instead of internal reasoning; §2.16 compact scope; §3.3 shared reviewer-contract composition.
- `ralph-forked-prompts.ts`: §2.1 delta-only fork prompts; §2.7 artifacts first/query last; §2.8 grounding; §2.10 no-promise ending; §2.11 explicit downstream report shapes.
- `ralph-core.ts`: §2.1/§3.3 E2E deduplication; §2.7 research artifacts before the final skill query; §2.8 implementation-note/research grounding; §2.11 concise question/report contracts.
- `ralph-runner.ts`: §2.1 repetition deletion; §2.4/§2.6 outcome-first tagged sections; §2.7 context first and final action query last; §2.8 one grounding clause per reporting stage; §2.9 one delegation decision rule; §2.10 one autonomy boundary plus no-promise endings; §2.11 explicit completion/PR report shape; §2.16 one-clause scope.
- Test wording: §2.7, §2.9, §2.11, and §3.3.

## Deduplicated clusters and surviving locations

1. Literal objective/criteria precedence → `shared-prompts.ts` `LITERAL_OBJECTIVE_CONTRACT`, composed by Ralph review, research, and orchestration prompts.
2. Acceptance matrix/clause proof → `shared-prompts.ts` `ACCEPTANCE_MATRIX_CONTRACT`, composed by the reviewer and orchestrator.
3. Contract-fidelity probes → `shared-prompts.ts` `CONTRACT_FIDELITY_AUDIT`; the reviewer receives it through `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`, while the implementation orchestrator composes it directly.
4. Independent evidence before authored receipts/tests → `shared-prompts.ts` `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`.
5. E2E attempt/failure evidence → `shared-prompts.ts` `E2E_VERIFICATION_GUIDANCE`, composed once by `renderQaE2eVideoGuidance` and directly by the reviewer.
6. Current/inspected/non-fabricated video review → `shared-prompts.ts` `renderE2eQaVideoReviewGuidance`; Ralph core retains only run-specific recording/path/note rules, and the final handoff retains only attachment behavior.
7. `stop_review_loop` authority/derivation → `shared-prompts.ts` `EVIDENCE_CLOSURE_POLICY`; reviewer output retains the distinct schema conjunction and reviewer-error rule.
9. Priority/alignment/location/output → one Ralph `finding_contract` plus `structured_decision_assurance`; general closure blocking remains in `EVIDENCE_CLOSURE_POLICY`.
10. Delegation/todo tracking → one R4 decision rule in `ralph-runner.ts`; the distinct Ralph `todo` lifecycle ledger remains once.
12. PR post-approval/non-blocking → `EVIDENCE_CLOSURE_POLICY` plus one reviewer `final_action_policy`; the final PR stage retains its distinct authorized handoff behavior.
13. Inspect repository delta rather than summaries → `shared-prompts.ts` `REVIEW_CODE_DELTA_CONTRACT`.
14. Missing dependencies require recovery → reviewer recovery semantics in `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT`; project-manager-specific installation guidance remains once.
15. Consolidated repair batch → `shared-prompts.ts` `FINDINGS_CONSOLIDATION_CONTRACT`; forked orchestration refers to the inherited contract instead of repeating it.

Cluster 8's Ralph finding-selection bar remains as one compressed `finding_contract` because it contains stage-specific selection, tone, changed-line, and actionable-finding rules not supplied by a shared constant. Cluster 11 remains solely in `workflowCwdContextSection`, preserving cwd propagation to every Ralph stage.

## Preservation audit

Checked the four Ralph sections of `rule-inventory.md`. No distinct semantic rule was eliminated. Ralph-specific rules retained include run-specific QA video commands/path/notes, fork delta behavior, todo lifecycle, project setup recovery, finding selection and location requirements, exact reviewer schema obligations, PR provider/identity/credential routing, detached-HEAD branch handoff, implementation-notes comment ordering, and failed-handoff recovery.

All structured names remain present where required: `stop_review_loop`, `objective_alignment`, `required_by_objective`, `consistent_with_objective`, `beyond_objective`, `contradicts_objective`, `requirements_traceability`, `overall_correctness`, `reviewer_error`, `overall_explanation`, `code_location`, and `findings`; P0–P3 and numeric 0–3 remain. Artifact paths and command/tool literals were preserved. `workflowCwdContextSection` and its every-stage invariant remain unchanged.

## Export preservation

Filtered export-inventory diff for the four owned modules: **empty**.

```diff
```

No exported name, kind, or signature changed.

## Deliberately retained

- `taggedPrompt` behavior and workflow control flow/types: runtime behavior, not prompt prose.
- Ralph-specific video recording/install commands: not covered by the shared video-review renderer and required by the inventory.
- Local finding and PR/provider contracts: downstream schema and external-action behavior has no equivalent shared constant.
- Docs/changelog: outside this task's edit-only boundary; this is internal prompt wording rather than a user-facing API change.

## Validation

- `bun run typecheck`: pass.
- `bun run lint`: pass.
- `bun run check:file-length`: pass, 2,450 files checked.
- Ralph unit tests: 16 pass, 0 fail.
- Full `bun run test:unit`: 4,217 pass, 2 skip, 0 fail across 4,219 tests / 553 files.
- Export diff: empty.
- Structured-field preservation: confirmed.
- Required hazard grep: no output (`NO MATCHES`).
