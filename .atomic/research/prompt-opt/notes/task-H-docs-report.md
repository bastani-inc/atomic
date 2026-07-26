# Task H — docs and changelog report

## Documentation changed

- `packages/coding-agent/docs/subagents.md` — added the missing bundled `worker`, aligned all agent descriptions with the current definitions, documented the outcome-first/evidence-grounded agent and chain-template contracts, and updated custom-agent authoring guidance and example.
- `packages/coding-agent/docs/workflows.md` — documented the cross-model stage-prompt contract, query-last ordering, evidence and delegation rules, Goal/Ralph shared reviewer contracts, exact `stop_review_loop` derivation, and current workflow-authoring guidance.
- `packages/coding-agent/docs/skills.md` — documented the rewritten `prompt-engineer` skill, its delete-first and model-family guidance, the response-prefilling incompatibility, the Fable 5 `reasoning_extraction` hazard, and current skill-authoring practices.
- `packages/coding-agent/docs/quickstart.md` — expanded the `prompt-engineer` description from vague-prompt tightening to creation, optimization, evaluation, and troubleshooting for GPT-5.6, Claude Opus 5, and Claude Fable 5.

## Changelogs changed

- `packages/subagents/CHANGELOG.md` — under `## [Unreleased]` → `### Changed`, added that all nine bundled agent prompts and seven chain templates were rewritten for the three target model families; recorded the 1,418 → 561 line reduction, explicit evidence/output/escalation/stop contracts, and removal of reasoning-reproduction and repeated self-verification instructions that could trigger Fable 5 fallback.
- `packages/workflows/CHANGELOG.md` — under `## [Unreleased]` → `### Changed`, added:
  - the Goal, Ralph, Open Claude Design, and six pattern-workflow prompt rewrite, including artifacts-first/query-last ordering, grounded claims, delegation damping, canonical reviewer/E2E/convergence contracts, and removal of reasoning-echo requests;
  - the `prompt-engineer` skill rewrite, including its 864 → 396 line reduction, removal of unsupported response-prefilling and visible-chain-of-thought guidance, and new model-family, agentic structure, tool-routing, effort/verbosity, long-context, delegation, grounding, and `reasoning_extraction` guidance.
- `packages/coding-agent/CHANGELOG.md` — under `## [Unreleased]` → `### Changed`, added the user-visible documentation refresh for current subagent, workflow-stage, reviewer, and `prompt-engineer` contracts.

Every added changelog item describes shipped prompts, bundled skill behavior, or the documentation users receive; no research artifact or repository-only automation is presented as package behavior.

## Changelog diff verification

`git diff --unified=0 -- packages/subagents/CHANGELOG.md packages/workflows/CHANGELOG.md packages/coding-agent/CHANGELOG.md` produced only additions under the existing Unreleased `### Changed` headings:

```diff
diff --git a/packages/coding-agent/CHANGELOG.md b/packages/coding-agent/CHANGELOG.md
@@ -21,0 +22 @@ ### Changed
+- Updated the bundled user documentation for the current subagent, workflow-stage, reviewer, and `prompt-engineer` prompt contracts: outcome-first agent and stage structure, evidence-grounded reporting, query-last artifact ordering, selective delegation, deterministic `stop_review_loop` derivation, explicit output/stop rules, and the removal of response prefilling and private-reasoning requests for current GPT-5.6, Claude Opus 5, and Claude Fable 5 compatibility.
diff --git a/packages/subagents/CHANGELOG.md b/packages/subagents/CHANGELOG.md
@@ -7,0 +8 @@ ### Changed
+- Reworked all nine bundled agent system prompts and all seven chain task templates for GPT-5.6, Claude Opus 5, and Claude Fable 5. Agent bodies are now outcome-first with explicit success, evidence, output, escalation, and stop contracts while shrinking from 1,418 to 561 lines; chain templates now carry grounded-reporting, selective-delegation, downstream-output, and completion contracts. Removed repeated self-verification and requests to reproduce internal reasoning, avoiding Claude Fable 5 `reasoning_extraction` refusals that could otherwise force model fallback, without changing agent frontmatter or exported behavior.
diff --git a/packages/workflows/CHANGELOG.md b/packages/workflows/CHANGELOG.md
@@ -24,0 +25,2 @@ ### Changed
+- Reworked the shipped Goal, Ralph, Open Claude Design, and six pattern-workflow stage prompts for GPT-5.6, Claude Opus 5, and Claude Fable 5. Prompts now put artifacts before the final query, use explicit output and stop contracts, ground status claims in current tool evidence, damp unnecessary delegation, and request commands, observed results, and file:line evidence instead of internal reasoning; shared reviewer, acceptance, E2E/QA-video, and `stop_review_loop` derivation rules now have canonical definitions. This reduces repetition and avoids Claude Fable 5 `reasoning_extraction` refusals that could force model fallback while preserving schemas, convergence semantics, and exports.
+- Rewrote the bundled `prompt-engineer` skill and its three progressive-disclosure references for current GPT-5.6, Claude Opus 5, and Claude Fable 5 behavior, reducing them from 864 to 396 lines. Removed response-prefilling guidance that errors on Claude 4.6+, visible chain-of-thought as a primary technique, and generic self-check loops; added a delete-first optimization workflow, model-family guidance, agentic prompt structure, tool routing, adaptive-thinking effort and response-length controls, query-last long-context ordering, delegation damping, grounded reporting, and the Fable 5 `reasoning_extraction` hazard.
```

The first released headings begin after these hunks (`packages/subagents`: line 14, `packages/workflows`: line 42, `packages/coding-agent`: line 41 in the resulting files). No already-released section was modified.

## Examined and deliberately unchanged

- `packages/coding-agent/docs/prompt-templates.md` — documents discovery, frontmatter, argument expansion, and loading mechanics only; it does not describe the rewritten bundled chain-template prompt contracts, which are documented in `subagents.md`.
- `packages/coding-agent/docs/intercom.md` — documents transport, supervisor escalation, and delivery behavior; those runtime contracts did not change in this prompt-only pass.
- `packages/coding-agent/docs/packages.md` and `packages/coding-agent/docs/session-format.md` — mention resource loading and workflow/subagent linkage only, not model-facing prompt behavior.
- `packages/coding-agent/docs/models/model-selection.md` — documents model role recommendations; this pass changed prompt text, not the documented role-selection policy.
- `packages/coding-agent/docs/changelog.mdx` — historical release documentation; no current prompt guidance required correction.

## Validation

- `bun run check:file-length`: passed — 2,450 tracked files checked.
- `git diff --check -- packages/coding-agent/docs packages/*/CHANGELOG.md`: passed with no output.
- Changelog diff audit: all three changed hunks are inside `## [Unreleased]` → `### Changed`; no released version section changed.
