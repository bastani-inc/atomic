# Builtin prompt composition graph

Line numbers refer to the baseline source. “Constant” means a pure string/array join. “Renderer” means a function that interleaves inputs/artifact references and instructions. Runner imports and call sites are listed together. `taggedPrompt` helpers are formatting combinators, not semantic prompts.

## Exported prompt surfaces and consumers

### `shared-prompts.ts`

Pure constants: `WORKER_PREFLIGHT_CONTRACT` 1–11; `E2E_VERIFICATION_GUIDANCE` 13–20; `LITERAL_OBJECTIVE_CONTRACT` 39–52; `REVIEWER_SPEC_VS_OBJECTIVE_GUARD` 54–55; `REVIEWER_OVERIMPLEMENTATION_GUARD` 57–58; `ACCEPTANCE_MATRIX_CONTRACT` 60–71; `CONTRACT_FIDELITY_AUDIT` 73–78; `REVIEWER_INTERCOM_COORDINATION_PROTOCOL` 80–86; `REVIEWER_INDEPENDENT_VERIFICATION_CONTRACT` 88–108; `REGRESSION_EVIDENCE_CONTRACT` 110–115; `FINDINGS_CONSOLIDATION_CONTRACT` 117–122; `EVIDENCE_CLOSURE_POLICY` 124–130; `WORKTREE_DISCIPLINE_CONTRACT` 132–137; `REVIEW_CODE_DELTA_CONTRACT` 139–146. Renderer: `renderE2eQaVideoReviewGuidance` 22–36.

Composition edges:
- `goal-prompts.ts:1–17` imports the complete Goal contract set; uses occur at 176–185, 220–230, 241, and 293–294.
- `goal-orchestrator-prompts.ts:8` imports preflight; use 86.
- `ralph-reviewer-prompt.ts:1–12` imports reviewer/E2E contracts; uses 37–42, 70–71, 103–104.
- `ralph-core.ts:6` imports `LITERAL_OBJECTIVE_CONTRACT`; uses 342 and 376.
- `ralph-runner.ts:8–15` imports implementation contracts; first-turn orchestrator composition uses them around 132–158.

### `goal-prompts.ts`

Pure constants: `GOAL_CONTINUATION_REFERENCE` 22–63; `GOAL_METHOD_REFERENCE` 65–71; `RECEIPT_EXPECTATIONS` 73–77; `INTERMEDIATE_PR_HANDOFF_GUARDRAIL` 79–82. Non-prompt utilities: `taggedPrompt` 86–93, `goalRunnerTools` 95–107, continuation/normalization helpers 114–150. Renderers: `renderGoalContinuationPrompt` 152–187; `renderReviewerPrompt` 189–386.

Consumers: `goal-orchestrator-prompts.ts:2–7` imports continuation/history/tagging and uses them at 64, 79, 85, 117, 127, 129; `goal-runner.ts:29` imports reviewer/tagger, calls `renderReviewerPrompt` while building reviewer steps (roughly 180–220), and uses `taggedPrompt` at 330 for the PR stage. `WORKER_PREFLIGHT_CONTRACT` is re-exported at line 20.

### `goal-orchestrator-prompts.ts`

Pure constants: `GOAL_ORCHESTRATOR_RECEIPT_CONTRACT` 10–23; `GOAL_ORCHESTRATION_GUIDANCE` 25–35; `GOAL_ORCHESTRATOR_BEST_PRACTICES` 37–42; `GOAL_SUBAGENT_TRACKING_GUIDANCE` 44–50. Renderers: `renderGoalOrchestratorPrompt` 60–110; `renderForkedGoalOrchestratorPrompt` 112–133.

Consumer: `goal-runner.ts:25–29` imports both renderers and calls the initial renderer at 127–134 and the forked renderer in the alternate branch immediately following it.

### `goal-review.ts` and `review-convergence.ts`

No model-facing prompt renderer. `goal-review.ts` 10–139 parses structured reviewer results and enforces approval/error/blocker conversion. `review-convergence.ts` 1–229 defines final-action recognition, finding-blocking semantics, consolidation, parse diagnostics, and convergence summaries. Their field names are load-bearing consumers of prose contracts.

### `ralph-reviewer-prompt.ts`

Renderer: `renderRalphReviewerPrompt` 15–182. It composes shared constants imported at 1–12 and the Ralph `taggedPrompt` imported at 13. Consumer: `ralph-runner.ts:16` import and call at 237–247; the resulting prompt is supplied to both reviewer tasks at 254 and 264.

### `ralph-forked-prompts.ts`

Renderers: `renderForkedResearchPromptRefinementPrompt` 14–39; `renderForkedResearchPrompt` 44–74; `renderForkedOrchestratorPrompt` 79–103. Consumer: `ralph-runner.ts:17–21` imports them; calls occur in the fork branches at 84–89, 103–108, and 223–226.

### `ralph-core.ts`

Renderer/prompt helpers: `workflowCwdContextSection` 123–133; `renderQaE2eVideoGuidance` 199–208; `renderResearchPromptRefinementPrompt` 330–359; `renderResearchPrompt` 362–397. `createImplementationNotesFile` 170–187 also seeds model-readable instructions. Consumer: `ralph-runner.ts:23–38` imports these; uses at 79, 95, 158 and initial setup. `taggedPrompt` 114–121 is imported by `ralph-reviewer-prompt.ts:13`, `ralph-forked-prompts.ts:9`, and `ralph-runner.ts` for inline orchestrator/PR prompts.

### Pattern workflow prompt modules

- `adversarial-verification-prompts.ts`: renderers `renderWorkerPrompt` 1–3, `renderVerifierPrompt` 5–7, `renderReducerPrompt` 9–11, `renderRepairPrompt` 13–15. Imported by `adversarial-verification-runner.ts:5`; calls 51, 61, 73, 89.
- `classify-and-act-prompts.ts`: `classifierPrompt` 1–3, `actionPrompt` 5–11. Imported at `classify-and-act-runner.ts:5`; calls 69 and 102.
- `fan-out-and-synthesize-prompts.ts`: `partitionPrompt` 1–3, `branchPrompt` 5–7, `synthesisPrompt` 9–11. Imported by the runner near its header; calls `fan-out-and-synthesize-runner.ts:55`, branch step construction around 65–70, and synthesis at 82.
- `generate-and-filter-prompts.ts`: `renderGeneratorPrompt` 1–3, `renderFilterPrompt` 5–7, `renderJudgePrompt` 9–11, `renderFinalShortlistPrompt` 13–15. Imported at `generate-and-filter-runner.ts:5`; calls 42, 50, 62, 71.
- `loop-until-done-prompts.ts`: `renderIterationPrompt` 9–30, `renderEvaluationPrompt` 32–59, `renderCompletionPrompt` 61–79. Imported by its runner; calls `loop-until-done-runner.ts:111`, 123, 157.
- `tournament-prompts.ts`: `renderTournamentAttemptPrompt` 9–23, `renderPairwiseJudgePrompt` 25–54, `renderBracketReducerPrompt` 56–79. Imported at `tournament-runner.ts:10–14`; calls 86, 118, 167.

### Open Claude Design

- `open-claude-design-setup.ts`: exported `renderDiscoveryContext` 43–51 (context renderer), `buildReferenceDiscoveryPrompt` 135–187, and `buildLivePreviewDisplayPrompt` 211–272; pure `NO_REFERENCES_BRIEF` 132–133. Private prompt `buildDiscoveryInitPrompt` 53–91 is called at 103. `open-claude-design-runner.ts:16–20` imports discovery/reference helpers and calls reference discovery at 239; `open-claude-design-phases.ts:16` imports live display and calls it at 105.
- `open-claude-design-phases.ts`: private model prompts `buildInitialGeneratePrompt` 136–183 and `buildGenerateRevisionPrompt` 185–233, called at 69 and 77; inline exporter prompt 254–294 and final-display prompt 301–326 inside exported `exportOpenClaudeDesign` 249–332.
- `open-claude-design-feedback.ts`: no task prompt. Prompt-fragment renderers are `buildUserAnnotationsSection` 196–220 and `userAnnotationsBlock` 227–239; `open-claude-design-phases.ts:9–15` imports them and uses the block at 195/207. Exact feedback labels are parser contracts.
- `open-claude-design-utils.ts`: pure prompt constants `HTML_PREVIEW_RULES` 178–185, `ANTI_SLOP_RULES` 187–191, `REFERENCE_PRECEDENCE` 194–195; renderer `buildPlaywrightCliBootstrapRules` 308–317. Imported/composed by setup, phases, and runner.
- `open-claude-design-runner.ts`: three inline design-system prompts (`ds-locator`, roughly 124–160; `ds-analyzer` 162–201; `ds-patterns` 203–229), then delegates reference prompt rendering.

### Other enumerated files

`adversarial-verification-prompts.ts`, `classify-and-act-prompts.ts`, `fan-out-and-synthesize-prompts.ts`, `generate-and-filter-prompts.ts`, `loop-until-done-prompts.ts`, and `tournament-prompts.ts` are direct render-only modules described above. `goal-review.ts` and `review-convergence.ts` are structured-output consumers, not prompt composers.

## Query-last / long-artifact reorder flags

The following **11** helpers/compositions put role/objective/instruction text before a potentially long rendered input. Paths-only artifact hints are not counted.

1. `ralph-reviewer-prompt.ts:15–182` — role/objective precede long `acceptanceCriteria` (line 36).
2. `ralph-core.ts:330–359` — skill/query text precedes acceptance criteria and other rendered context.
3. `ralph-core.ts:362–397` — skill/query text precedes acceptance criteria/review context.
4. `open-claude-design-setup.ts:135–187` — role/objective precede `designContextHint` (155).
5. `open-claude-design-phases.ts:136–183` — role/objective precede design system, imported reference context, and references brief (151–154).
6. `open-claude-design-phases.ts:185–233` — role/objective precede design system, reference blocks, user feedback, and current-design summary (202–208).
7. `open-claude-design-phases.ts:249–297` exporter composition — role/objective precede design system/final-design context (260–263).
8. `goal-runner.ts:329–410` inline PR prompt — role/objective/check instructions precede the long rendered `finalReport` at 361–366.
9. `open-claude-design-runner.ts:124–160` `ds-locator` — role/objective precede user-reference/context blocks.
10. `open-claude-design-runner.ts:162–201` `ds-analyzer` — role/objective precede user references, handling rules, and browser rules (174–176).
11. `open-claude-design-runner.ts:203–229` `ds-patterns` — role/objective precede the same long reference/context blocks (211–213).

## Duplicated semantic-rule clusters

1. **Literal objective/acceptance criteria outrank external/spec assumptions.** `shared-prompts.ts:41–52`; `goal-prompts.ts:35–40,214–216`; `ralph-reviewer-prompt.ts:35–38`; `ralph-core.ts:340–343,374–377`.
2. **Acceptance matrix / clause-by-clause proof.** `shared-prompts.ts:60–71`; `goal-prompts.ts:42–53,333–340,366–371`; `goal-orchestrator-prompts.ts:16–20`; `ralph-reviewer-prompt.ts:142–150,164–168`.
3. **Contract-fidelity divergence probes.** `shared-prompts.ts:73–78`; substantially restated by `shared-prompts.ts:88–107`; operational restatements in `goal-prompts.ts:333–340` and `ralph-reviewer-prompt.ts:142–150`.
4. **Independent evidence before implementation-authored receipts/tests.** `shared-prompts.ts:88–107`; `goal-prompts.ts:323–340,353–360,381`; `ralph-reviewer-prompt.ts:134–150,154–158,177`.
5. **E2E must be attempted, not assumed unavailable.** `shared-prompts.ts:13–20`; `ralph-core.ts:199–207`; `goal-orchestrator-prompts.ts:99–100`; `ralph-runner.ts:201–202`.
6. **QA video must be current, inspected, and never fabricated.** `shared-prompts.ts:22–35`; `ralph-core.ts:199–207`; `ralph-runner.ts:202,371–383`; `ralph-reviewer-prompt.ts:70–71,147–150`.
7. **`stop_review_loop` derivation and authoritative-gate semantics.** `shared-prompts.ts:124–130`; `goal-prompts.ts:367–382`; `ralph-reviewer-prompt.ts:164–178`; runtime mirrors in `goal-review.ts:44–45` and `review-convergence.ts:76–100`.
8. **Reviewer finding selection bar.** Near-verbatim blocks in `goal-prompts.ts:282–297` and `ralph-reviewer-prompt.ts:92–107`.
9. **Finding priority/alignment/location/output rules.** `goal-prompts.ts:300–318,353–360,376–383`; `ralph-reviewer-prompt.ts:110–129,154–178`.
10. **Orchestrator delegation plus todo tracking.** `goal-orchestrator-prompts.ts:25–50`; restated inline in `ralph-runner.ts:160–190` and action instructions 193–220.
11. **Current-working-directory propagation.** `goal-orchestrator-prompts.ts:70–76`; `ralph-core.ts:123–132`; Goal PR inline context `goal-runner.ts:340–346`.
12. **PR is post-approval; do not block convergence on it.** `goal-prompts.ts:79–82,231–240,371`; `ralph-reviewer-prompt.ts:73–81,168,176`; inline PR stages in `goal-runner.ts:329–410` and `ralph-runner.ts:345–433`.
13. **Do not trust summaries; inspect repository delta.** `shared-prompts.ts:139–146`; `goal-prompts.ts:245–250,274–279,323–327`; `ralph-reviewer-prompt.ts:53–59,83–89,132–137`.
14. **Missing dependencies require recovery, not approval.** `goal-prompts.ts:263–269,274–279`; `ralph-reviewer-prompt.ts:64–68,85–89`; `shared-prompts.ts:17–19`.
15. **Consolidate all findings and repair as a batch.** `shared-prompts.ts:117–122`; `goal-prompts.ts:147–149,179`; `ralph-forked-prompts.ts:87–96`; runtime consolidation in `review-convergence.ts:125–165`.

## Prompt-bearing builtin files omitted by the objective’s enumerated list

The explicit list missed these files that contain model-facing text:

- `packages/workflows/builtin/goal-runner.ts` — inline final PR/MR/review prompt (329–410).
- `packages/workflows/builtin/ralph-runner.ts` — large inline first-turn orchestrator prompt and final PR/MR/review prompt (roughly 115–222 and 345–433).
- `packages/workflows/builtin/open-claude-design-runner.ts` — three inline design-system discovery prompts (roughly 124–229).
- `packages/workflows/builtin/open-claude-design-utils.ts` — shared HTML/design/reference/bootstrap prompt constants (178–195, 308–317).
- `packages/workflows/builtin/adversarial-verification-runner.ts` — model-read verification rubric written at line 50.

Workflow definition descriptions in `adversarial-verification.ts`, `classify-and-act.ts`, `fan-out-and-synthesize.ts`, `generate-and-filter.ts`, `goal.ts`, `loop-until-done.ts`, `open-claude-design.ts`, `ralph.ts`, and `tournament.ts` are user-facing schema/registry descriptions, not stage prompt bodies; they remain represented in `rule-inventory.md` where applicable.
