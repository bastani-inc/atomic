# Task X delivery report

**Verdict: 1 known dropped-input regression was confirmed fixed; this sweep found 0 additional regressions.** `renderReviewerPrompt.args.objective` is now emitted as `Run objective: …`, and a runtime sentinel check proved all 9 accepted fields appear. One baseline oddity matters: `git show HEAD:…/goal-prompts.ts` shows that field declared but not directly rendered at HEAD (the ledger was referenced indirectly), despite the run context describing it as rendered before the rewrite. I report that discrepancy rather than rewriting the evidence.

## Dropped-input sweep

“Now: yes” includes direct interpolation, value-bearing section insertion, or branching that changes the rendered prompt. The HEAD comparison used `git show HEAD:<file>`; changed interpolation counts were also compared mechanically. Optional `buildLivePreviewDisplayPrompt.maxRefinements` was already unused at HEAD and remains pre-existing/out of scope.

| Function(s) | Full parameters / fields | HEAD | Now | Verdict |
|---|---|---:|---:|---|
| adversarial `renderWorker/Verifier/Reducer/RepairPrompt` | task; candidatePath; rubricPath; verifierPaths; repairsCompleted; maxRepairs; reviewPath | yes | yes | preserved |
| classify `classifierPrompt`, `actionPrompt` | prompt; categories; input.prompt/category/classificationPath | yes | yes | preserved |
| fan-out `partition/branch/synthesisPrompt` | prompt; maxBranches; input.prompt/label/objective; manifestPath | yes | yes | preserved |
| generate/filter four renderers | task; ordinal; candidatePaths; shortlistSize; filterPath; decisionPath | yes | yes | preserved |
| goal orchestrator two renderers | args.ledger/ledgerPath/blockerThreshold/latestReviewArtifactPaths/workflowStartCwd; ledger/ledgerPath/latestReviewArtifactPaths | yes | yes | preserved |
| goal history/continuation helpers | ledger; paths; ledgerPath; blockerThreshold; latestReviewArtifactPaths | yes | yes | preserved |
| `renderReviewerPrompt` | reviewerRole; focus; objective; ledgerPath; orchestratorReceiptPath; comparisonBaseBranch; reviewQuorum; blockerThreshold; createPr | objective: no; others: yes | all yes | known defect restored; 9/9 sentinel pass |
| loop iteration/evaluation/completion | task; iteration; maxIterations; ledgerPath; iterationPath | yes | yes | preserved |
| tournament attempt/judge/reducer | task; attempt; labels; paths; bracketPath; winnerLabel/winnerPath | yes | yes | preserved |
| Ralph core/fork/reviewer helpers | workflowCwd; qaVideoPath; request; acceptanceCriteria; workflowCwdContext; latestReviewReportPath; transformedResearchQuestion; prompt; researchPath; implementationNotesPath; workflowPrompt; comparisonBaseBranch; orchestratorReportPath; createPr | yes | yes | preserved |
| design discovery/reference/generation/revision/export | discovery; prompt; outputType; designContextHint; artifactDir; browserBootstrapRules; preview paths/URLs; designSystem; referencesBrief; importContext; latestDesign; feedback; spec paths/URLs; model/context fields | yes | yes | preserved |
| `buildLivePreviewDisplayPrompt` | previewPath; previewFileUrl; browserBootstrapRules; iteration?; maxRefinements?; final? | maxRefinements unused; others value/control | same | pre-existing unused optional field; not fixed |
| runner inline compositions (Goal/Ralph PR, Ralph implementation, three design-system tasks, design export/display) | every captured objective, cwd, artifact/path, branch, status, review, QA, design, model, and output value | yes | yes | preserved |
| pattern runners | workflow inputs are passed to the renderers above; no independent inline template | yes | yes | preserved |

Runtime evidence: `renderReviewerPrompt: 9/9 unique sentinels rendered`. Export inventory diff was empty; agent frontmatter diff was empty.

## Gates and cleanup

- `bun run typecheck` → `$ tsc --noEmit` (exit 0).
- `bun run lint` → `$ tsc --noEmit` (exit 0).
- `bun run check:file-length` → `File length check passed: 2450 files checked …`.
- `AGENT=1 bun run test:unit` → `4217 pass`, `2 skip`, `0 fail`, 4,219 tests across 553 files in 108.52s. No assertions required further realignment during this sweep.
- `git diff --check` passed. Root `progress.md` was deleted. The only remaining status entry is the pre-existing untracked `.agents/skills/openai-docs/` directory. All ten files there have filesystem modification time `2026-07-26 13:48:47 PDT`, before this run's 13:57 PDT start.

## Delivery

Commit message: `refactor(prompts): optimize model-facing instruction surfaces` (this report is contained in that commit). The mandatory file-length hook rejected the requested separate skill commit because its pre-existing `fetch-codex-manual.mjs` is 598 lines. Per supervisor direction, the unrelated directory was neither edited nor committed; no file under it appears in this commit. The exact commit SHA and final status/worktree proofs are reported in the task response because a commit cannot contain its own final SHA.
