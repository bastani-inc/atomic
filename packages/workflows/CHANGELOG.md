# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Hardened the shared builtin `goal`/`ralph` prompt contracts against over-implementation drift (observed in eval traces where near-perfect patches lost binary reward to a single invented strictness: returning a read-only mapping proxy where the contract said "dict", marking an optional schema field required, and rejecting duplicate aliases the task's hidden tests expected to be tolerated). The literal objective contract now states that the loud-error preference applies only to error conditions the contract enumerates and that the default for unenumerated behavior is permissive acceptance (never invent a validation error, required field, uniqueness constraint, or rejection the contract does not name); that contract-named types/shapes/formats must be produced exactly, with no defensive substitutes such as read-only proxies, frozen collections, or tuples-for-lists, because consumers may check type identity literally; and that unspecified behavior defaults to preserving input verbatim over normalizing, deduplicating, reordering, or rewriting it.
- Extended the worker/orchestrator acceptance-matrix contract with rows for literal contract examples (checked character-for-character rather than paraphrased) and for each contract-constrained interface decision (types by identity, required-vs-optional per field, duplicate handling, ordering, raw-vs-normalized text), recording the permissive/preserving default whenever the contract leaves a decision open.
- Added a shared `CONTRACT_FIDELITY_AUDIT` adversarial divergence pass to the Goal worker and Ralph orchestrator prompts (`<divergence_audit>`): after checks are green and before claiming readiness, re-read each contract clause asking what plausible independent check would fail the implementation, probing the recurring divergence categories — type-identity assertions, optional fields omitted, duplicated/aliased inputs, ordering assumptions, verbatim-vs-normalized text, and any raised error the contract does not enumerate. Forked continuation prompts reference the audit in their established-guidance pointer.
- Made Goal and Ralph reviewers hunt over-implementation as seriously as gaps via a shared `REVIEWER_OVERIMPLEMENTATION_GUARD`: validation errors, required fields, uniqueness/format constraints, immutability wrappers, or normalization the contract does not require are `required_by_objective` defects, and reviewers must probe at least one contract-permitted input the worker's own tests do not exercise before approving. The independent-verification contract and reviewer action items now include contract-permitted-input and type/shape/text-identity probes alongside the existing boundary/edge/negative probes.

### Fixed

- Fixed the builtin `open-claude-design` artifact directory fallback to use a per-user OS tmpdir namespace (`open-claude-design-<username>`), preventing `EACCES` failures on shared hosts where another user already owns the plain `<tmpdir>/open-claude-design` directory. The legacy shared path remains a secondary fallback, and the last-resort synthesized path now also uses the per-user namespace so best-effort feedback persistence can actually create it.
- Prevented the synced Impeccable fixture's nested `git init` from inheriting hook-local Git repository variables and corrupting a linked repository's shared `core.worktree`. Runner-managed reusable worktrees now remap propagated invoking-repository `cwd` values and relative direct outputs into the selected worktree; reject blank, self, nested, foreign, lexical-escape, symlink-escape, and changed cached targets before opening a later session; key cached identity by canonical repository/target across equivalent path and ref spellings; revalidate newly created targets; and expose clearer workflow tool guidance/schema descriptions so natural-language worktree requests cannot be mistaken for runtime configuration. Temporary direct task and parallel worktrees also derive omitted/relative task cwd values from the runner invocation cwd and clean up when startup fails before their workflow callback, while relative outputs are persisted to stable runner-owned artifacts before cleanup and reject parent traversal, child symlink escapes, or a linked trusted artifact root across direct, parallel, and chain modes; blank `chainDir` values no longer bypass reusable-worktree output routing.
- Fixed the active Workflow Orchestrator graph pane to pan left and right for horizontal trackpad and terminal mouse-wheel events while preserving vertical wheel panning and pane-local input capture ([#1756](https://github.com/bastani-inc/atomic/issues/1756)).
- Fixed `/workflow resume` so its single globally newest-first, deduplicated picker includes current paused or recoverably failed and durable resumable entries alongside authoritative successful completed workflows. Completed rows use green `✓ completed` styling and open an immutable detail/chat snapshot with transcript follow-up conversation, without durable re-dispatch or workflow side-effect replay. Full IDs take precedence and prefixes resolve across the mixed namespace; completed rows require checkpoints and at least one strictly valid retained conversation, invalid per-stage paths cannot attach chat, repeated inspection refreshes changed authoritative chat handles, and selector mount failures close safely. Existing resumable workflow and ordinary internal-session history behavior remains on the original paths. ([#1532](https://github.com/bastani-inc/atomic/issues/1532))

## [0.9.8] - 2026-07-12

### Changed

- Changed builtin `goal` and `ralph` reviewer approval to be deterministic on the reviewer's self-reported `stop_review_loop` boolean: a reviewer approves exactly when it returns `stop_review_loop=true` with no `reviewer_error`, parse failures still count as non-approval, and Goal's reducer completes on quorum of those booleans without recomputing approval from findings arrays, priorities, or `requirements_traceability` statuses. Recomputing approval from those arrays could deadlock runs whose acceptance criteria referenced the review process itself (for example "three reviewers approve" or "an unmerged PR is created"): no individual reviewer can prove such clauses, so traceability never became fully `proven` even when every reviewer explicitly approved, and the loop burned worker/review turns until `needs_human`. Reviewer prompts now state that the boolean is the single authoritative convergence signal, spell out how to derive it (blocking P0/P1/P2 findings and `required_by_objective` findings at any priority mean `false`; in-scope P3 nice-to-haves, `beyond_objective`/`contradicts_objective` observations, the reviewer-quorum process itself, and the authorized post-approval PR/MR/review final action must never hold it at `false`), and keep findings/traceability as required audit evidence. `findingBlocksClosure`/`isBlockingFinding` still classify findings for prompts and consolidated repair batches.
- Synchronized the complete builtin `impeccable` skill tree with pbakaus/impeccable at `630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21`, including its latest references, detector libraries, live-review scripts, and provider integrations.

### Fixed

- Disabled terminal autowrap while the fullscreen workflow graph overlay is visible on Windows and restored the previous terminal mode when the overlay closes, preventing wrapped graph rows and stale terminal state ([#1760](https://github.com/bastani-inc/atomic/issues/1760)).
- Hardened synced Impeccable HTML filtering and preview selector escaping against nested sanitizer inputs, permissive script/style closing tags, HTML comment end-bang syntax, and backslash-containing session identifiers; also removed an ineffective CSS property replacement flagged by CodeQL.

## [0.9.8-alpha.1] - 2026-07-12

### Changed

- Changed builtin `goal` and `ralph` reviewer approval to be deterministic on the reviewer's self-reported `stop_review_loop` boolean: a reviewer approves exactly when it returns `stop_review_loop=true` with no `reviewer_error`, parse failures still count as non-approval, and Goal's reducer completes on quorum of those booleans without recomputing approval from findings arrays, priorities, or `requirements_traceability` statuses. Recomputing approval from those arrays could deadlock runs whose acceptance criteria referenced the review process itself (for example "three reviewers approve" or "an unmerged PR is created"): no individual reviewer can prove such clauses, so traceability never became fully `proven` even when every reviewer explicitly approved, and the loop burned worker/review turns until `needs_human`. Reviewer prompts now state that the boolean is the single authoritative convergence signal, spell out how to derive it (blocking P0/P1/P2 findings and `required_by_objective` findings at any priority mean `false`; in-scope P3 nice-to-haves, `beyond_objective`/`contradicts_objective` observations, the reviewer-quorum process itself, and the authorized post-approval PR/MR/review final action must never hold it at `false`), and keep findings/traceability as required audit evidence. `findingBlocksClosure`/`isBlockingFinding` still classify findings for prompts and consolidated repair batches.
- Synchronized the complete builtin `impeccable` skill tree with pbakaus/impeccable at `630fc2682a5bd39b25a8e61f74b6b3f14f2b1e21`, including its latest references, detector libraries, live-review scripts, and provider integrations.

### Fixed

- Disabled terminal autowrap while the fullscreen workflow graph overlay is visible on Windows and restored the previous terminal mode when the overlay closes, preventing wrapped graph rows and stale terminal state ([#1760](https://github.com/bastani-inc/atomic/issues/1760)).
- Hardened synced Impeccable HTML filtering and preview selector escaping against nested sanitizer inputs, permissive script/style closing tags, HTML comment end-bang syntax, and backslash-containing session identifiers; also removed an ineffective CSS property replacement flagged by CodeQL.

## [0.9.7] - 2026-07-12

### Added

- Added a shared convergence contract for the builtin `goal` and `ralph` workflows (`builtin/shared-prompts.ts` + deterministic gates in `builtin/review-convergence.ts`): workers/orchestrators must derive an observable acceptance/contract matrix from the literal objective/acceptance criteria before implementing (one row per clause mapped to the concrete check that proves it) and must model states, transitions, and invariants explicitly for stateful work; reviewers must independently derive adversarial checks (boundary/edge/negative and state/transition/invariant probes) from the literal contract before relying on the worker receipt, implementation notes, or worker-authored tests; reproduced findings require durable regression evidence (a persisted test or exact re-runnable check) before they count as resolved; and the evidence-closure policy is stated to both roles so approval semantics are visible in-prompt. All contracts inherit the literal-contract scope controls, so no behavior beyond the objective/acceptance criteria is required.
- Added deduplicated cross-reviewer `consolidated_findings` batches to the Goal and Ralph `review-round-latest.json` artifacts (`consolidateFindingsBatch` in `builtin/review-convergence.ts`), with blocking entries sorted first and reviewer attribution merged per finding. Goal's next worker turn reads the round artifact first and is instructed to plan and repair the whole batch — grouped by root cause, with regression evidence — instead of fixing one finding per turn; Ralph's research/orchestrator stages receive the same batch through the round artifact.

### Changed

- Changed the built-in `goal` and `ralph` reviewer model defaults for GPT-5.6 Sol from the `:max` reasoning suffix to `:xhigh` across every provider form (`openai-codex`, `github-copilot`, `openai`, `cursor`, and `openrouter/openai`), including Ralph's `reviewer-b` primary model (`openai-codex/gpt-5.6-sol:xhigh`).
- Aligned all built-in Goal reviewer stages with Ralph's clean, non-forked reviewer context behavior and exact `reviewer-a` model configuration, making Claude Fable 5 the shared primary reviewer while keeping one canonical fallback chain.
- Changed builtin `goal` completion to evidence closure rather than reviewer agreement alone: the deterministic reducer now completes only when reviewer quorum is met AND no objective-relevant blocking finding from any reviewer in the current round remains unresolved. A quorum-met round with unresolved findings continues with an inspectable decision reason listing the findings, and the bounded loop still stops at `max_turns` as `needs_human` (with the closure gap recorded) so vetoes cannot drift indefinitely.
- Changed the shared Goal/Ralph review gate so severity labels alone can no longer dismiss objective-relevant findings: `required_by_objective` findings now block at any priority (P3 included) via the shared `findingBlocksClosure` predicate, while `consistent_with_objective` P3 nice-to-haves remain non-blocking (preserving the dummy-finding anti-spin behavior) and `beyond_objective`/`contradicts_objective` findings remain non-blocking scope controls. Goal's `reviewApproved` and Ralph's `isBlockingFinding`/`reviewDecisionApproved` now share this single deterministic predicate.
- Slimmed the builtin `goal`, `ralph`, and `open-claude-design` stage prompts to remove context-mode bloat: prompts no longer describe the stage's own context window ("previous conversation context", "previous workflow reasoning", or sibling parallel passes that a fresh stage cannot see), and forked continuation prompts now send only the per-iteration delta. Goal's forked worker turns send just the ledger pointer, latest receipts, and latest review artifacts; Ralph's forked orchestrator sends the rewritten research path and notes reminder; and Ralph's forked research-prompt-refinement and research continuations reference the skill, request, and contracts already present in their forked histories instead of re-injecting them (new `renderForkedResearchPromptRefinementPrompt`/`renderForkedResearchPrompt`). Each forked prompt carries a one-line pointer that previously established guidance still applies unchanged.

### Fixed

- Fixed workflow stage model fallback to classify provider usage-limit exhaustion (for example `Codex error: The usage limit has been reached`, plus `usage_limit`/`usage_limit_reached`/`usage_limit_exceeded`/`insufficient_quota` codes) as a retryable quota/rate-limit failure, so configured `fallbackModels` advance to the next candidate provider/model instead of failing the stage. The message matcher tolerates the same space/underscore/hyphen/joined separators as the code path, so provider errors that flatten the token into free text (for example `usage_limit_reached` or `usage-limit`) also advance the chain. Nested cause/diagnostic and session-shaped errors classify the same way, while cancellations, safety refusals, task/tool failures, and unrelated errors remain non-retryable.
- Fixed model orchestration guidance so every workflow launch from interactive chat stays in the background: named runs remain automatically detached, direct `task`/`tasks`/`chain` launches require top-level `async: true`, inspection and control calls are excluded, and foreground launches require an explicit user request or technical necessity plus advance notice ([#1765](https://github.com/bastani-inc/atomic/issues/1765)).

## [0.9.7-alpha.1] - 2026-07-12

### Added

- Added a shared convergence contract for the builtin `goal` and `ralph` workflows (`builtin/shared-prompts.ts` + deterministic gates in `builtin/review-convergence.ts`): workers/orchestrators must derive an observable acceptance/contract matrix from the literal objective/acceptance criteria before implementing (one row per clause mapped to the concrete check that proves it) and must model states, transitions, and invariants explicitly for stateful work; reviewers must independently derive adversarial checks (boundary/edge/negative and state/transition/invariant probes) from the literal contract before relying on the worker receipt, implementation notes, or worker-authored tests; reproduced findings require durable regression evidence (a persisted test or exact re-runnable check) before they count as resolved; and the evidence-closure policy is stated to both roles so approval semantics are visible in-prompt. All contracts inherit the literal-contract scope controls, so no behavior beyond the objective/acceptance criteria is required.
- Added deduplicated cross-reviewer `consolidated_findings` batches to the Goal and Ralph `review-round-latest.json` artifacts (`consolidateFindingsBatch` in `builtin/review-convergence.ts`), with blocking entries sorted first and reviewer attribution merged per finding. Goal's next worker turn reads the round artifact first and is instructed to plan and repair the whole batch — grouped by root cause, with regression evidence — instead of fixing one finding per turn; Ralph's research/orchestrator stages receive the same batch through the round artifact.

### Changed

- Changed the built-in `goal` and `ralph` reviewer model defaults for GPT-5.6 Sol from the `:max` reasoning suffix to `:xhigh` across every provider form (`openai-codex`, `github-copilot`, `openai`, `cursor`, and `openrouter/openai`), including Ralph's `reviewer-b` primary model (`openai-codex/gpt-5.6-sol:xhigh`).
- Aligned all built-in Goal reviewer stages with Ralph's clean, non-forked reviewer context behavior and exact `reviewer-a` model configuration, making Claude Fable 5 the shared primary reviewer while keeping one canonical fallback chain.
- Changed builtin `goal` completion to evidence closure rather than reviewer agreement alone: the deterministic reducer now completes only when reviewer quorum is met AND no objective-relevant blocking finding from any reviewer in the current round remains unresolved. A quorum-met round with unresolved findings continues with an inspectable decision reason listing the findings, and the bounded loop still stops at `max_turns` as `needs_human` (with the closure gap recorded) so vetoes cannot drift indefinitely.
- Changed the shared Goal/Ralph review gate so severity labels alone can no longer dismiss objective-relevant findings: `required_by_objective` findings now block at any priority (P3 included) via the shared `findingBlocksClosure` predicate, while `consistent_with_objective` P3 nice-to-haves remain non-blocking (preserving the dummy-finding anti-spin behavior) and `beyond_objective`/`contradicts_objective` findings remain non-blocking scope controls. Goal's `reviewApproved` and Ralph's `isBlockingFinding`/`reviewDecisionApproved` now share this single deterministic predicate.
- Slimmed the builtin `goal`, `ralph`, and `open-claude-design` stage prompts to remove context-mode bloat: prompts no longer describe the stage's own context window ("previous conversation context", "previous workflow reasoning", or sibling parallel passes that a fresh stage cannot see), and forked continuation prompts now send only the per-iteration delta. Goal's forked worker turns send just the ledger pointer, latest receipts, and latest review artifacts; Ralph's forked orchestrator sends the rewritten research path and notes reminder; and Ralph's forked research-prompt-refinement and research continuations reference the skill, request, and contracts already present in their forked histories instead of re-injecting them (new `renderForkedResearchPromptRefinementPrompt`/`renderForkedResearchPrompt`). Each forked prompt carries a one-line pointer that previously established guidance still applies unchanged.

### Fixed

- Fixed workflow stage model fallback to classify provider usage-limit exhaustion (for example `Codex error: The usage limit has been reached`, plus `usage_limit`/`usage_limit_reached`/`usage_limit_exceeded`/`insufficient_quota` codes) as a retryable quota/rate-limit failure, so configured `fallbackModels` advance to the next candidate provider/model instead of failing the stage. The message matcher tolerates the same space/underscore/hyphen/joined separators as the code path, so provider errors that flatten the token into free text (for example `usage_limit_reached` or `usage-limit`) also advance the chain. Nested cause/diagnostic and session-shaped errors classify the same way, while cancellations, safety refusals, task/tool failures, and unrelated errors remain non-retryable.
- Fixed model orchestration guidance so every workflow launch from interactive chat stays in the background: named runs remain automatically detached, direct `task`/`tasks`/`chain` launches require top-level `async: true`, inspection and control calls are excluded, and foreground launches require an explicit user request or technical necessity plus advance notice ([#1765](https://github.com/bastani-inc/atomic/issues/1765)).

## [0.9.6] - 2026-07-12

### Changed

- Restored workflow-first model routing for non-trivial, structured, and verifiable work while retaining the newer ability to author task-specific TypeScript workflows inline. Prompt guidance now explicitly combines the documented classify/branch, fan-out/synthesis, adversarial verification, generate/filter, tournament, and bounded loop patterns instead of forcing every workflow-fit task into an installed workflow, direct shape, or builtin.
- Restored Ralph's builtin implementation-stage prompts to require subagent-led investigation, editing, and validation, reversing the selective direct-implementation wording introduced with intent-first routing.
- Expanded model-facing workflow guidance to treat composition as a first-class design option: custom parents can import reusable project/package workflows or bundled builtin definitions, invoke them through `ctx.workflow(...)`, and nest further child workflows within `maxDepth` while preserving expanded graph visibility, HIL, durability, controls, and declared output contracts.

## [0.9.6-alpha.1] - 2026-07-12

### Changed

- Restored workflow-first model routing for non-trivial, structured, and verifiable work while retaining the newer ability to author task-specific TypeScript workflows inline. Prompt guidance now explicitly combines the documented classify/branch, fan-out/synthesis, adversarial verification, generate/filter, tournament, and bounded loop patterns instead of forcing every workflow-fit task into an installed workflow, direct shape, or builtin.
- Restored Ralph's builtin implementation-stage prompts to require subagent-led investigation, editing, and validation, reversing the selective direct-implementation wording introduced with intent-first routing.
- Expanded model-facing workflow guidance to treat composition as a first-class design option: custom parents can import reusable project/package workflows or bundled builtin definitions, invoke them through `ctx.workflow(...)`, and nest further child workflows within `maxDepth` while preserving expanded graph visibility, HIL, durability, controls, and declared output contracts.

## [0.9.5] - 2026-07-11

### Breaking Changes

- Hardened the builtin `goal` and `ralph` review contracts against objective-drift failures: review findings now require `objective_alignment`, Goal and Ralph review decisions require `requirements_traceability`, and reviewer approval rejects empty or non-proven traceability. Consumers that parse or synthesize these structured reviewer outputs must emit the new required fields.

### Added

- Added model-capability-aware `max` reasoning suffix support throughout workflow stage schemas, fallback candidates, authoring contracts, and TUI status labels ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Added `git_worktree_dir` to the builtin `goal` workflow with Ralph-parity input binding so Goal runs can create or reuse a repository worktree from `base_branch` while preserving the invoking repo-relative cwd for worker, reviewer, and optional final PR stages.
- Added immutable `acceptance_criteria` to the builtin `goal` and `ralph` workflows. Goal persists it in the ledger/model-visible projection and final reports; Ralph threads it through research, orchestrator, and reviewer prompts next to the literal objective contract. Orchestrators should pass the original task text when launching follow-up Goal or Ralph runs from reviewer findings.
- Added literal-contract prompt language shared by `goal` and `ralph`, objective-alignment arbitration for reviewer findings, non-blocking treatment for `beyond_objective`/`contradicts_objective` findings, and clause-by-clause requirements traceability so reviewer evidence must map directly back to the objective/acceptance criteria.
- Added attempt-first E2E guidance for `goal` and `ralph`: workers/reviewers must not skip playwright-cli/tmux validation because credentials or auth are merely assumed missing, and skipped E2E must cite the exact attempted commands and observed failure output.

### Changed

- Aligned the workflows extension peer dependency with upstream `pi-tui` `^0.80.6` as part of the consolidated Pi sync ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Replaced workflow-default routing with intent-first least orchestration: interactive exploration stays inline, bounded specialist delegation uses subagents, and workflows are reserved for clearly delegated autonomous jobs that benefit from long-running/background execution or durable stages, artifacts, resumability, HIL, gates, retries, or loops. Explicit loop and stop-condition requests remain key workflow signals when the user delegates execution, so convergence and evidence are tracked. Guidance now documents builtin/project/user/package workflows, direct one-off shapes, and the option to author a custom TypeScript workflow inline whenever that shape best achieves a workflow-fit task.
- Changed the builtin `ralph` workflow review fan-out from three reviewers to two (`reviewer-a` and `reviewer-b`), removing `reviewer-c` and its GLM-led model chain while keeping unanimous approval across the remaining reviewers.
- Aligned durable mid-chat workflow resumes with the standard pause/resume continuation prompt so resumed stages continue only when their scoped work remains unfinished.
- Improved workflow extension startup by seeding only the bundled startup registry during extension registration/session start, then loading user, project, and package workflow modules in the background or when `/workflow` commands and workflow tool actions need the full registry.
- Tightened the workflow-stage resume continuation prompt so resumed agents continue interrupted work only when needed and stop when the original or user-redefined task is already complete.
- Updated the bundled `impeccable` skill from upstream 3.8.0 to 3.9.1, adding native platform guidance, hooks support, expanded detector rules, and the latest reference/script fixes ([#1696](https://github.com/bastani-inc/atomic/issues/1696)).
- Changed the Claude Fable 5 reasoning level from `xhigh` to `high` across all builtin workflow model chains (`ralph` prompt-engineer/orchestrator/reviewer-a/reviewer-b/reviewer-c, `goal` reviewer, `deep-research-codebase` planner, and `open-claude-design`), covering both the native `anthropic/claude-fable-5` entries and their OpenRouter mirrors.
- Changed the Claude Opus 4.8 reasoning level from `xhigh` to `high` across the same builtin workflow model chains, covering the `github-copilot/claude-opus-4.8 (1m)`, `anthropic/claude-opus-4-8`, and `openrouter/anthropic/claude-opus-4-8` entries; Opus 4.8 entries already at `medium`/`low` value points are unchanged.
- Hardened the builtin `goal` and `ralph` loops against spec-vs-objective drift on enumerated error behavior (observed in an eval trace where an adversarial reviewer flagged a task-mandated diagnostic as a spec-conformance defect and the fix cycle silently reinterpreted the ambiguous input as valid behavior, losing the required error): the shared literal objective contract now instructs workers and reviewers to prefer loud errors over silent reinterpretation — when the objective/acceptance criteria enumerate required error conditions, messages, or rejections, each enumerated error gets the widest plausible trigger surface, ambiguous or unspecified inputs near an enumerated error case default to raising that error even when external spec knowledge says the input is valid, and narrowing an enumerated error's trigger surface requires explicit contract or pre-existing required-test demand. Both loops' reviewer bug-selection guidelines now forbid using external spec/standard conformance alone to flag a wide trigger surface for a contract-enumerated error as a defect; such spec-vs-objective tension must be classified `beyond_objective` instead of becoming a blocking finding that steers the implementation away from the contract's errors.
- Extracted the Ralph reviewer prompt into `builtin/ralph-reviewer-prompt.ts` (`renderRalphReviewerPrompt`) and deduplicated the new reviewer guard into a shared `REVIEWER_SPEC_VS_OBJECTIVE_GUARD` constant consumed by both the Goal and Ralph reviewer prompts, keeping `ralph-runner.ts` under the repository's 500-line file gate. No behavioral change beyond the guard itself.
- Hardened the workflow-tool prompt guidance against inline analysis-paralysis drift (observed in eval transcripts where an agent spent ~2 hours of pure reconnaissance on a workflow-fit task without ever considering a workflow): the agent must now decide and state the inline-vs-workflow execution mode before its first tool call (reconnaissance explicitly counts as inline execution), budget pre-workflow scoping to a few quick reads that only sharpen the objective and validation criteria, course-correct after roughly ten deliverable-free exploration tool calls (or repeated "let me verify one more thing" loops) by writing findings to a context file and handing off to the best-fit workflow via `reads` (named or user-defined workflows discovered with `action: "list"` first, builtin `goal`/`ralph` as fallbacks when nothing more specific fits), and treat sunk inline research as transferable via files rather than a reason to stay inline. Mirrored the same "Decide before you explore" and "Course-correct instead of drifting" guidance in `docs/workflows.md` under "When to Use Workflows".
- Refreshed the July 2026 frontier model rosters for the builtin Ralph, Goal, deep-research-codebase, and open-claude-design workflows: critical prompt-engineering, orchestration, planning, and review chains now use high-capacity Fable 5 `:xhigh` primaries or fallbacks with GPT-5.5, Opus 4.8 long-context `:xhigh`, GLM-5.2, and OpenRouter Fugu Ultra coverage, while Ralph research stays on the measured GPT-5.5 `:medium` / Fable 5 `:low` performance-per-dollar path and reviewer-C remains GLM-led for diversity.
- Updated workflow model-option schema documentation to show `:xhigh` long-context examples and kept the fallback fixtures aligned so unsupported direct `sakana/` IDs stay out of workflow chains while the valid `openrouter/sakana/fugu-ultra:high` mirror remains available.

### Fixed

- Fixed archived/read-only workflow transcript views to use the standard responsive footer and Ctrl+T copy-mode toggle/status, enabling normal terminal or tmux text selection while preserving Escape and Ctrl+D navigation ([#1706](https://github.com/bastani-inc/atomic/issues/1706)).
- Fixed workflow tool validation coercing `output: false` into the literal file path `false`, so disabled output remains disabled across direct task, parallel task, and chain execution.
- Hardened the bundled `impeccable` skill's local detector/live scripts against CodeQL-reported sanitization and command-injection patterns by tightening HTML block stripping, avoiding shell interpolation for `git check-ignore`, escaping Svelte preview CSS selectors correctly, and fixing the `ms*` JSX style prefix conversion.
- Fixed lazy workflow startup follow-through so `session_start` loads only workflow config before restore/cleanup, discovery diagnostics are reported after deferred discovery settles, failed lazy discovery attempts are retryable, direct workflow-tool `task`/`tasks`/`chain` runs bypass full workflow discovery, named workflow-tool runs and failed-run resume re-resolve their runtime after discovery, paused/current live-run resume and live resume pickers avoid registry discovery, failed/durable resume still loads resources before registry-dependent lookups, and command autocomplete falls back to current/admin completions when lazy discovery fails without evaluating workflow modules on the startup path.
- Fixed workflow lazy-startup session generation so session restarts and shutdowns invalidate in-flight background discovery before it can publish stale workflow registries into later sessions.
- Fixed workflow failure finalization so structured recoverable auth, rate-limit, and provider-exhaustion metadata captured on the run or its blocking stage (`failedStageId`) no longer allows the top-level run, `/workflow status`, durable status, or lifecycle notice to appear as a successful `completed` state. Goal-like `needs_human`, incomplete, or auth-blocked reducer outputs are still treated as blocked, structured provider/auth fallback exhaustion now preserves an actionable blocked/failure message and resumable metadata, legacy completed snapshots with incomplete returned statuses or structured blocking-stage failures render as blocked, tolerated non-fail-fast branch failures no longer reclassify completed runs, and Goal reviewer-batch fallback exhaustion stops promptly as `needs_human` instead of launching another worker turn.
- Fixed the fullscreen workflow graph statusline to mirror non-workflow extension statuses, so async/background subagent progress and completion remain visible while the graph overlay is active.
- Fixed `/workflow resume` and fresh runs for workflows that use reusable `gitWorktreeDir`/`git_worktree_dir` worktrees by persisting the original invocation cwd and resolved reusable-worktree metadata, replaying durable resumes from that original repository context instead of the resumed interactive session cwd, caching repeated per-run reusable-worktree setup, retrying transient read-only Git `rev-parse` timeouts, hardening Git subprocesses against interactive prompts, and reporting exact Git command/cwd/timeout/elapsed/status/signal diagnostics when worktree preflight fails.
- Fixed builtin `goal` and `ralph` reviewer convergence reporting so review artifacts and reducer/controller decisions now persist explicit parse/convergence summaries (`parsed`, `approved`, `stopReviewLoop`, `nextAction`, `finalActionRemaining`, and diagnostics). Malformed or missing structured reviewer output is surfaced as a parse failure distinct from parsed reviewer rejection/findings; PR/MR/review creation is represented as a post-approval final action when it is the only remaining task; successful reviewer convergence records the final action (`pull-request` or `finish`) without consuming another implementation loop; and the workflow authoring docs, default workflow guidance, and create-spec prompt now tell custom reviewer-gated workflows to model authorized PR, release, deployment, or publication work as final actions rather than implementation blockers while writing local, action-oriented prompts that do not rely on workflow/stage names as hidden context.
- Fixed workflow stage model fallback for unrecoverable context-window overflow: when Atomic's same-model auto-compaction exhausts its recovery attempt, the stage now advances to the next configured `fallbackModels` tier and, once all tiers are exhausted, stops with the terminal context-overflow error instead of compacting and retrying the same model indefinitely.
- Fixed workflow controlled-pause ordering around unresolved context overflow: paused stages now honor the pause/resume handshake before surfacing the terminal overflow, and a resume message is not sent over an already-recorded unresolved-overflow signal.
- Fixed reattached workflow stage fallback after unresolved context overflow: if the restored/resumed model tier exhausts context recovery, fallback now continues with the next tier after that resumed model (or stops terminally when it was the final tier) instead of replaying the primary model.
- Fixed durable workflow resume hydration so replayed `ctx.parallel`/`ctx.task` fanout keeps its original branch parentage, completed stages restore persisted summaries, timing, session/model metadata, and DBOS/file checkpoints round-trip the richer stage metadata used by status and graph views.
- Fixed workflow stage chats so attach, exit, and re-attach cycles during an in-flight `subagent` call replay the latest live tool partial result immediately instead of collapsing single, parallel, or chain calls back to the bare `renderCall` title until the next update; stage chats also prefer renderers from the stage's own agent session before falling back to the host chat so nested workflow stages can render tools that the parent chat does not expose. ([#1643](https://github.com/bastani-inc/atomic/issues/1643))

## [0.9.5-alpha.10] - 2026-07-11

### Added

- Added model-capability-aware `max` reasoning suffix support throughout workflow stage schemas, fallback candidates, authoring contracts, and TUI status labels ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).

### Changed

- Aligned the workflows extension peer dependency with upstream `pi-tui` `^0.80.6` as part of the consolidated Pi sync ([#1703](https://github.com/bastani-inc/atomic/issues/1703)).
- Replaced workflow-default routing with intent-first least orchestration: interactive exploration stays inline, bounded specialist delegation uses subagents, and workflows are reserved for clearly delegated autonomous jobs that benefit from long-running/background execution or durable stages, artifacts, resumability, HIL, gates, retries, or loops. Explicit loop and stop-condition requests remain key workflow signals when the user delegates execution, so convergence and evidence are tracked. Guidance now documents builtin/project/user/package workflows, direct one-off shapes, and the option to author a custom TypeScript workflow inline whenever that shape best achieves a workflow-fit task.

- Changed the builtin `ralph` workflow review fan-out from three reviewers to two (`reviewer-a` and `reviewer-b`), removing `reviewer-c` and its GLM-led model chain while keeping unanimous approval across the remaining reviewers.

- Aligned durable mid-chat workflow resumes with the standard pause/resume continuation prompt so resumed stages continue only when their scoped work remains unfinished.

### Fixed

- Fixed archived/read-only workflow transcript views to use the standard responsive footer and Ctrl+T copy-mode toggle/status, enabling normal terminal or tmux text selection while preserving Escape and Ctrl+D navigation ([#1706](https://github.com/bastani-inc/atomic/issues/1706)).
- Fixed workflow tool validation coercing `output: false` into the literal file path `false`, so disabled output remains disabled across direct task, parallel task, and chain execution.

## [0.9.5-alpha.9] - 2026-07-09

### Changed

- Improved workflow extension startup by seeding only the bundled startup registry during extension registration/session start, then loading user, project, and package workflow modules in the background or when `/workflow` commands and workflow tool actions need the full registry.
- Tightened the workflow-stage resume continuation prompt so resumed agents continue interrupted work only when needed and stop when the original or user-redefined task is already complete.
- Updated the bundled `impeccable` skill from upstream 3.8.0 to 3.9.1, adding native platform guidance, hooks support, expanded detector rules, and the latest reference/script fixes ([#1696](https://github.com/bastani-inc/atomic/issues/1696)).

### Fixed

- Hardened the bundled `impeccable` skill's local detector/live scripts against CodeQL-reported sanitization and command-injection patterns by tightening HTML block stripping, avoiding shell interpolation for `git check-ignore`, escaping Svelte preview CSS selectors correctly, and fixing the `ms*` JSX style prefix conversion.
- Fixed lazy workflow startup follow-through so `session_start` loads only workflow config before restore/cleanup, discovery diagnostics are reported after deferred discovery settles, failed lazy discovery attempts are retryable, direct workflow-tool `task`/`tasks`/`chain` runs bypass full workflow discovery, named workflow-tool runs and failed-run resume re-resolve their runtime after discovery, paused/current live-run resume and live resume pickers avoid registry discovery, failed/durable resume still loads resources before registry-dependent lookups, and command autocomplete falls back to current/admin completions when lazy discovery fails without evaluating workflow modules on the startup path.
- Fixed workflow lazy-startup session generation so session restarts and shutdowns invalidate in-flight background discovery before it can publish stale workflow registries into later sessions.

- Fixed workflow failure finalization so structured recoverable auth, rate-limit, and provider-exhaustion metadata captured on the run or its blocking stage (`failedStageId`) no longer allows the top-level run, `/workflow status`, durable status, or lifecycle notice to appear as a successful `completed` state. Goal-like `needs_human`, incomplete, or auth-blocked reducer outputs are still treated as blocked, structured provider/auth fallback exhaustion now preserves an actionable blocked/failure message and resumable metadata, legacy completed snapshots with incomplete returned statuses or structured blocking-stage failures render as blocked, tolerated non-fail-fast branch failures no longer reclassify completed runs, and Goal reviewer-batch fallback exhaustion stops promptly as `needs_human` instead of launching another worker turn.
- Fixed the fullscreen workflow graph statusline to mirror non-workflow extension statuses, so async/background subagent progress and completion remain visible while the graph overlay is active.
- Fixed `/workflow resume` and fresh runs for workflows that use reusable `gitWorktreeDir`/`git_worktree_dir` worktrees by persisting the original invocation cwd and resolved reusable-worktree metadata, replaying durable resumes from that original repository context instead of the resumed interactive session cwd, caching repeated per-run reusable-worktree setup, retrying transient read-only Git `rev-parse` timeouts, hardening Git subprocesses against interactive prompts, and reporting exact Git command/cwd/timeout/elapsed/status/signal diagnostics when worktree preflight fails.

## [0.9.5-alpha.8] - 2026-07-08

### Fixed

- Fixed builtin `goal` and `ralph` reviewer convergence reporting so review artifacts and reducer/controller decisions now persist explicit parse/convergence summaries (`parsed`, `approved`, `stopReviewLoop`, `nextAction`, `finalActionRemaining`, and diagnostics). Malformed or missing structured reviewer output is surfaced as a parse failure distinct from parsed reviewer rejection/findings; PR/MR/review creation is represented as a post-approval final action when it is the only remaining task; successful reviewer convergence records the final action (`pull-request` or `finish`) without consuming another implementation loop; and the workflow authoring docs, default workflow guidance, and create-spec prompt now tell custom reviewer-gated workflows to model authorized PR, release, deployment, or publication work as final actions rather than implementation blockers while writing local, action-oriented prompts that do not rely on workflow/stage names as hidden context.

- Fixed workflow stage model fallback for unrecoverable context-window overflow: when Atomic's same-model auto-compaction exhausts its recovery attempt, the stage now advances to the next configured `fallbackModels` tier and, once all tiers are exhausted, stops with the terminal context-overflow error instead of compacting and retrying the same model indefinitely.
- Fixed workflow controlled-pause ordering around unresolved context overflow: paused stages now honor the pause/resume handshake before surfacing the terminal overflow, and a resume message is not sent over an already-recorded unresolved-overflow signal.
- Fixed reattached workflow stage fallback after unresolved context overflow: if the restored/resumed model tier exhausts context recovery, fallback now continues with the next tier after that resumed model (or stops terminally when it was the final tier) instead of replaying the primary model.
- Fixed durable workflow resume hydration so replayed `ctx.parallel`/`ctx.task` fanout keeps its original branch parentage, completed stages restore persisted summaries, timing, session/model metadata, and DBOS/file checkpoints round-trip the richer stage metadata used by status and graph views.

## [0.9.5-alpha.6] - 2026-07-06

### Fixed

- Fixed workflow stage chats so attach, exit, and re-attach cycles during an in-flight `subagent` call replay the latest live tool partial result immediately instead of collapsing single, parallel, or chain calls back to the bare `renderCall` title until the next update; stage chats also prefer renderers from the stage's own agent session before falling back to the host chat so nested workflow stages can render tools that the parent chat does not expose. ([#1643](https://github.com/bastani-inc/atomic/issues/1643))

## [0.9.5-alpha.5] - 2026-07-06

### Added

- Added `git_worktree_dir` to the builtin `goal` workflow with Ralph-parity input binding so Goal runs can create or reuse a repository worktree from `base_branch` while preserving the invoking repo-relative cwd for worker, reviewer, and optional final PR stages.

### Changed

- Changed the Claude Fable 5 reasoning level from `xhigh` to `high` across all builtin workflow model chains (`ralph` prompt-engineer/orchestrator/reviewer-a/reviewer-b/reviewer-c, `goal` reviewer, `deep-research-codebase` planner, and `open-claude-design`), covering both the native `anthropic/claude-fable-5` entries and their OpenRouter mirrors.
- Changed the Claude Opus 4.8 reasoning level from `xhigh` to `high` across the same builtin workflow model chains, covering the `github-copilot/claude-opus-4.8 (1m)`, `anthropic/claude-opus-4-8`, and `openrouter/anthropic/claude-opus-4-8` entries; Opus 4.8 entries already at `medium`/`low` value points are unchanged.

## [0.9.5-alpha.4] - 2026-07-05

### Changed

- Hardened the builtin `goal` and `ralph` loops against spec-vs-objective drift on enumerated error behavior (observed in an eval trace where an adversarial reviewer flagged a task-mandated diagnostic as a spec-conformance defect and the fix cycle silently reinterpreted the ambiguous input as valid behavior, losing the required error): the shared literal objective contract now instructs workers and reviewers to prefer loud errors over silent reinterpretation — when the objective/acceptance criteria enumerate required error conditions, messages, or rejections, each enumerated error gets the widest plausible trigger surface, ambiguous or unspecified inputs near an enumerated error case default to raising that error even when external spec knowledge says the input is valid, and narrowing an enumerated error's trigger surface requires explicit contract or pre-existing required-test demand. Both loops' reviewer bug-selection guidelines now forbid using external spec/standard conformance alone to flag a wide trigger surface for a contract-enumerated error as a defect; such spec-vs-objective tension must be classified `beyond_objective` instead of becoming a blocking finding that steers the implementation away from the contract's errors.
- Extracted the Ralph reviewer prompt into `builtin/ralph-reviewer-prompt.ts` (`renderRalphReviewerPrompt`) and deduplicated the new reviewer guard into a shared `REVIEWER_SPEC_VS_OBJECTIVE_GUARD` constant consumed by both the Goal and Ralph reviewer prompts, keeping `ralph-runner.ts` under the repository's 500-line file gate. No behavioral change beyond the guard itself.

## [0.9.5-alpha.3] - 2026-07-04

### Changed

- Hardened the workflow-tool prompt guidance against inline analysis-paralysis drift (observed in eval transcripts where an agent spent ~2 hours of pure reconnaissance on a workflow-fit task without ever considering a workflow): the agent must now decide and state the inline-vs-workflow execution mode before its first tool call (reconnaissance explicitly counts as inline execution), budget pre-workflow scoping to a few quick reads that only sharpen the objective and validation criteria, course-correct after roughly ten deliverable-free exploration tool calls (or repeated "let me verify one more thing" loops) by writing findings to a context file and handing off to the best-fit workflow via `reads` (named or user-defined workflows discovered with `action: "list"` first, builtin `goal`/`ralph` as fallbacks when nothing more specific fits), and treat sunk inline research as transferable via files rather than a reason to stay inline. Mirrored the same "Decide before you explore" and "Course-correct instead of drifting" guidance in `docs/workflows.md` under "When to Use Workflows".

## [0.9.5-alpha.2] - 2026-07-04

### Changed

- Refreshed the July 2026 frontier model rosters for the builtin Ralph, Goal, deep-research-codebase, and open-claude-design workflows: critical prompt-engineering, orchestration, planning, and review chains now use high-capacity Fable 5 `:xhigh` primaries or fallbacks with GPT-5.5, Opus 4.8 long-context `:xhigh`, GLM-5.2, and OpenRouter Fugu Ultra coverage, while Ralph research stays on the measured GPT-5.5 `:medium` / Fable 5 `:low` performance-per-dollar path and reviewer-C remains GLM-led for diversity.
- Updated workflow model-option schema documentation to show `:xhigh` long-context examples and kept the fallback fixtures aligned so unsupported direct `sakana/` IDs stay out of workflow chains while the valid `openrouter/sakana/fugu-ultra:high` mirror remains available.

## [0.9.5-alpha.1] - 2026-07-04

### Breaking Changes

- Hardened the builtin `goal` and `ralph` review contracts against objective-drift failures: review findings now require `objective_alignment`, Goal and Ralph review decisions require `requirements_traceability`, and reviewer approval rejects empty or non-proven traceability. Consumers that parse or synthesize these structured reviewer outputs must emit the new required fields.

### Added

- Added immutable `acceptance_criteria` to the builtin `goal` and `ralph` workflows. Goal persists it in the ledger/model-visible projection and final reports; Ralph threads it through research, orchestrator, and reviewer prompts next to the literal objective contract. Orchestrators should pass the original task text when launching follow-up Goal or Ralph runs from reviewer findings.
- Added literal-contract prompt language shared by `goal` and `ralph`, objective-alignment arbitration for reviewer findings, non-blocking treatment for `beyond_objective`/`contradicts_objective` findings, and clause-by-clause requirements traceability so reviewer evidence must map directly back to the objective/acceptance criteria.
- Added attempt-first E2E guidance for `goal` and `ralph`: workers/reviewers must not skip playwright-cli/tmux validation because credentials or auth are merely assumed missing, and skipped E2E must cite the exact attempted commands and observed failure output.

## [0.9.4] - 2026-07-03

### Changed

- Curated all builtin workflow model chains against Atomic's agentic-coding benchmark (pass@1 / avg cost per task, 2026-07-02) under a role-based placement principle: reviewer stages keep best-in-class verification models (`anthropic/claude-fable-5:xhigh`, `openai-codex/gpt-5.5:xhigh`, and `zai/glm-5.2:xhigh` for third-family diversity), every other stage leads with the best measured performance-per-dollar candidate (`ralph` prompt-engineer and the `deep-research-codebase` planner move to `openai-codex/gpt-5.5:xhigh`, the explorer to `openai-codex/gpt-5.5:low`), strictly dominated models (`claude-sonnet-5`, `claude-sonnet-4.6`, `gemini-3.1-pro`, `gemini-3.5-flash`) and unbenchmarked entries (`gpt-5.4-mini`, `claude-haiku-4.5`) were dropped, and every remaining chain entry corresponds to a benchmark datapoint. `open-claude-design` keeps its Anthropic-led chain with `claude-fable-5:xhigh` primary.
- Normalized all GLM-5.2 chain entries to the model's two real reasoning tiers: native `zai`/`zai-coding-cn` entries in medium-tier chains now say `:high` explicitly (replacing misleading `:medium` labels that silently billed at the "high" tier), judgment-tier chains keep `:xhigh`, and the `openrouter/z-ai/glm-5.2` mirror is now always `:xhigh`.
- Aligned the workflows extension peer dependency with upstream pi TUI `^0.80.3`.

### Fixed

- Fixed attached workflow stage viewers so the host `app.tools.expand` keybinding (Ctrl+O by default) toggles live-detail/tool-output expansion just like the main chat, including custom keybinding remaps ([#1607](https://github.com/bastani-inc/atomic/issues/1607)).
- Fixed workflow stage model fallback so request/context incompatibility failures (HTTP 400/413/422, unsupported tool/parameter, context-window overflow, `invalid_request`/`bad_request`/`too_large` errors) advance the chain to the next candidate, falling back to the current user-selected model when no configured candidate can serve the request; refusals, content-filter/safety blocks, cancellations, and task failures still stop the chain ([#1580](https://github.com/bastani-inc/atomic/issues/1580)).
- Fixed the builtin `goal` reviewer and `deep-research-codebase` planner model fallback chains missing the `openrouter/anthropic/claude-fable-5` mirror of their primary model, matching the ordering used by the other builtin chains.
- Classified generic provider `Connection error.` / `fetch failed` transport outages as explicit workflow transport errors so stage fallback metadata can distinguish them from ordinary provider/model outages while preserving the normal next-model fallback order.
- Fixed workflow lifecycle notices for structured workflow outputs whose returned `status` is `failed` or `blocked`: the runtime now records those runs as failed/blocked instead of successful completions, preserves their returned output, carries blocked summaries into lifecycle notice reasons, marks returned failures non-resumable with explicit terminal failure metadata, and emits failure/blocked lifecycle cards rather than success notices.

## [0.9.4-alpha.11] - 2026-07-03

### Fixed

- Fixed attached workflow stage viewers so the host `app.tools.expand` keybinding (Ctrl+O by default) toggles live-detail/tool-output expansion just like the main chat, including custom keybinding remaps ([#1607](https://github.com/bastani-inc/atomic/issues/1607)).

## [0.9.4-alpha.9] - 2026-07-02

### Changed

- Changed the Claude Fable 5 reasoning level back from `high` to `xhigh` across all builtin workflow model chains (`ralph` prompt-engineer/reviewer-a/reviewer-b/reviewer-c, `goal` reviewer, `deep-research-codebase` planner, and `open-claude-design`), covering both the native `anthropic/claude-fable-5` entries and their OpenRouter mirrors; this reverts the `xhigh` → `high` change shipped in 0.9.4-alpha.8.
- Curated all builtin workflow model chains against Atomic's agentic-coding benchmark (pass@1 / avg cost per task, 2026-07-02) under a role-based placement principle: **reviewers get best-in-class verification quality, every other stage gets the best measured performance-per-dollar**. Reviewer stages keep `anthropic/claude-fable-5:xhigh` (70% / $13.41, `ralph` reviewer-a and the `goal` reviewer), `openai-codex/gpt-5.5:xhigh` (67% / $7.23, reviewer-b), and `zai/glm-5.2:xhigh` (44% / $3.92, reviewer-c for third-family diversity). Non-reviewer stages moved to perf-per-dollar primaries: `ralph` prompt-engineer and the `deep-research-codebase` planner from `claude-fable-5:xhigh` to `openai-codex/gpt-5.5:xhigh` (−3pts for half the cost, with `fable-5:xhigh` as the first cross-family fallback), and the `deep-research-codebase` explorer from unbenchmarked `gpt-5.4-mini:low` to the measured cheap-tier value point `openai-codex/gpt-5.5:low` ($1.20 / task, 28 steps, 9.4k output tokens), backed only by measured fallbacks (`claude-opus-4.8:low` at 41% / $2.29, then `glm-5.2:high`). Unbenchmarked models (`gpt-5.4-mini`, `claude-haiku-4.5`) and unmeasured levels (`gemini-3.5-flash:low`) are removed entirely — every chain entry now corresponds to a benchmark datapoint. Dropped strictly dominated candidates from every chain: `claude-sonnet-5` (40–54% at $4.08–$26.40 per task with up to 268 steps), `claude-sonnet-4.6` (30% / $5.52), `gemini-3.1-pro` (12% / $9.48), and `gemini-3.5-flash` (37% / $7.34 with 276k output tokens). Moved `claude-opus-4.8` fallback entries from `:xhigh` to `:high` — its cost/value point (52% / $4.28 vs 54% / $8.01) — everywhere except `open-claude-design`, which keeps an Anthropic-led chain (`fable-5:xhigh` primary, Opus at `:xhigh`) since design quality, not $/task, is its objective. Added `anthropic/claude-fable-5:low` (60% / $3.76) as the Anthropic candidate in the medium-tier `ralph` research/orchestrator and `goal` worker chains.
- Normalized all GLM-5.2 chain entries to the model's two real reasoning tiers: GLM-5.2's thinking-level map collapses `minimal`/`low`/`medium`/`high` to its "high" effort and `xhigh` to "max", so the previous `zai/glm-5.2:medium` entries in the `ralph` research/orchestrator and `goal` worker chains silently ran (and billed) at the "high" tier under a misleading label. Native `zai`/`zai-coding-cn` entries in medium-tier chains now say `:high` explicitly, judgment-tier chains keep `:xhigh` (→ "max"), and the `openrouter/z-ai/glm-5.2` mirror — which only maps `:xhigh` — is now always `:xhigh` instead of unsupported `:medium`.

## [0.9.4-alpha.8] - 2026-07-02

### Changed

- Changed the Claude Fable 5 reasoning level from `xhigh` to `high` across all builtin workflow model chains (`ralph` prompt-engineer/reviewer-a/reviewer-b/reviewer-c, `goal` reviewer, `deep-research-codebase` planner, and `open-claude-design`), covering both the native `anthropic/claude-fable-5` entries and their OpenRouter mirrors.

### Fixed

- Fixed the builtin `goal` reviewer and `deep-research-codebase` planner model fallback chains missing the OpenRouter mirror of their primary model: `openrouter/anthropic/claude-fable-5` is now the first OpenRouter fallback candidate in both chains, matching the ordering already used by the `ralph` prompt-engineer/reviewer and `open-claude-design` chains.

## [0.9.4-alpha.7] - 2026-07-02

### Fixed

- Fixed workflow stage model fallback so request/context incompatibility failures (HTTP 400/413/422 bad/unprocessable/payload-too-large request, unsupported tool/parameter, context-length/context-window overflow, `invalid_request`/`bad_request`/`too_large` errors) advance the chain to the next candidate instead of stopping. When none of the configured candidates can serve the request, the stage now falls back to the current user-selected model. Refusals, content-filter/safety blocks, cancellations, and task failures still stop the chain ([#1580](https://github.com/bastani-inc/atomic/issues/1580)).

## [0.9.4-alpha.6] - 2026-07-01

### Changed

- Aligned the workflows extension peer dependency with upstream pi TUI `^0.80.3`; no workflows extension source changes were needed for this metadata sync.

## [0.9.4-alpha.5] - 2026-07-01

### Changed

- Published a synchronized Atomic 0.9.4-alpha.5 prerelease for the workflows extension; no workflow changes were made after 0.9.4-alpha.3.

## [0.9.4-alpha.4] - 2026-06-30

### Changed

- Published a synchronized Atomic 0.9.4-alpha.4 prerelease for the workflows extension; no workflow changes were made after 0.9.4-alpha.3.

## [0.9.4-alpha.3] - 2026-06-30

### Fixed

- Classified generic provider `Connection error.` / `fetch failed` transport outages as explicit workflow transport errors so stage fallback metadata can distinguish them from ordinary provider/model outages while preserving the normal next-model fallback order.

## [0.9.4-alpha.1] - 2026-06-29

### Fixed

- Fixed workflow lifecycle notices for structured workflow outputs whose returned `status` is `failed` or `blocked`: the runtime now records those runs as failed/blocked instead of successful completions, preserves their returned output, carries blocked summaries into lifecycle notice reasons, marks returned failures non-resumable with explicit terminal failure metadata, and emits failure/blocked lifecycle cards rather than success/checkmark notices.

## [0.9.3] - 2026-06-29

### Breaking Changes

- Enabled workflow durability by default with a zero-infrastructure per-workflow file backend under `~/.atomic/workflow-durable`, replacing the previous process-local in-memory default and removing the old `ATOMIC_WORKFLOW_DURABLE_DIR` opt-in path. Explicit in-memory durability remains available through custom/test backends or `ATOMIC_WORKFLOW_DURABLE=0`/`false`/`off`/`memory`.

### Added

- Added `StageContext.sendUserMessage(content, { deliverAs? })` so workflow authors can inject follow-on user turns into live stage sessions after `prompt()` resolves while preserving MCP scope, abort handling, and structured-output guards.
- Added cross-session durable workflow resumability with cached `ctx.tool`, `ctx.ui`, `ctx.stage`/`ctx.task`/`ctx.chain`/`ctx.parallel`, and child-workflow checkpoints, plus `/workflow resume` discovery of durable workflow history from session metadata and the durable backend.
- Added optional DBOS-backed durability through the lazily loaded `@dbos-inc/dbos-sdk`, including DBOS read-side hydration for resumable workflows when `DBOS_SYSTEM_DATABASE_URL` is set.
- Added OpenRouter fallback coverage to builtin `goal`, `ralph`, `deep-research-codebase`, and `open-claude-design` workflow model configs.

### Changed

- Marked workflow stage sessions as internal so they are excluded from normal Atomic resume history while remaining inspectable and resumable through workflow-specific commands and tools.
- Revised builtin `goal`, `ralph`, and `open-claude-design` prompts to emphasize full objective completion, stable non-ordinal artifacts, a shared five-level subagent nesting budget, and model-facing workflow guidance that routes non-trivial structured work to workflows by default.
- Aligned the workflows extension peer dependency with upstream pi TUI `^0.80.2`.

### Fixed

- Fixed workflow graph and attached-stage chat interactions, including direct mouse-click activation, mouse/trackpad wheel capture, copy-mode toggling, stale `Working...` spinners, terminal-row animation cleanup, and post-terminal subagent progress handling.
- Hardened durable resume, replay, checkpoint, and listing behavior across file and DBOS backends, including pending prompts, terminal/non-resumable states, stale cache entries, repeated quit/resume cycles, child workflow scope isolation, checkpoint identity hashing, retries, cancellation, and durable write failures.
- Fixed `/workflow resume` picker behavior for live, paused, failed, and cross-session durable workflows so it matches the standard Atomic resume selector and handles empty, headless, mixed live/durable, and cache-only states consistently.
- Fixed builtin workflow continuity and configuration edge cases, including `open-claude-design` generator/feedback forking, isolated workflow config discovery, durable schema-backed stage replay, parallel fail-fast finalization, and custom-backend propagation into child workflows.

## [0.9.3-alpha.6] - 2026-06-29

### Added

- Added OpenRouter fallback coverage to the builtin `goal`, `ralph`, `deep-research-codebase`, and `open-claude-design` workflow model configs so workflow stages have additional frontier, GLM, and Gemini provider redundancy.

## [0.9.3-alpha.5] - 2026-06-28

### Changed

- Aligned the workflows extension peer dependency with upstream pi TUI `^0.80.2`; no workflows extension source changes were needed for this metadata sync.

## [0.9.3-alpha.4] - 2026-06-28

### Changed

- Strengthened the model-facing workflow prompt guidance to treat workflows as the default path for non-trivial tasks and requests with inherent structure plus verifiable objectives, explicitly including implementation, build, debugging, bug-fix, migration, new-feature, scoped multi-file, and validation-heavy docs/code prompts alongside loop-shaped phrasing such as `do X until Y`, `repeat until`, `iterate until`, and review/fix/test-until-passing prompts.

## [0.9.3-alpha.3] - 2026-06-27

### Changed

- Published the Atomic 0.9.3-alpha.3 prerelease for the workflows extension from the same code as 0.9.3-alpha.2; no workflow changes were made after the previous prerelease.

## [0.9.3-alpha.2] - 2026-06-27

### Breaking Changes

- Workflow durability is now enabled by default with the zero-infrastructure per-workflow file backend rooted under `~/.atomic/workflow-durable`; the previous process-local in-memory default and `ATOMIC_WORKFLOW_DURABLE_DIR` opt-in path were removed. In-memory durability remains available for explicit test/custom backend overrides and for the privacy opt-out `ATOMIC_WORKFLOW_DURABLE=0`/`false`/`off`/`memory`. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))

### Added

- Added `StageContext.sendUserMessage(content, { deliverAs? })` so workflow authors can inject a normal follow-on user turn into a stage session after `prompt()` resolves. Idle sessions start immediately, streaming sessions queue as follow-up by default (or steering with `deliverAs: "steer"`), schema-backed stages can continue after their one allowed structured `prompt()` without tripping the one-shot prompt guard, follow-on turns preserve the stage MCP allow/deny scope, and native stage sessions accept the same string or text/image block content as `AgentSession.sendUserMessage()`. Durable replayed cached stages now reject this live-session operation instead of silently ignoring it. ([#1520](https://github.com/bastani-inc/atomic/issues/1520))
- Added cross-session workflow resumability via a durable workflow backend seam (`packages/workflows/src/durable/`). Workflows now persist `ctx.*` operation checkpoints (tool, ui, stage) to a durable backend so a new Atomic session can resume a workflow started in a prior session from the last completed checkpoint, without re-running completed work. Cross-session persistence is enabled by default through a lock-protected per-workflow file backend at `~/.atomic/workflow-durable`; no environment variable is required. When `DBOS_SYSTEM_DATABASE_URL` is set, Atomic lazily initializes DBOS with Postgres-backed workflow/control records and falls back to the file backend if DBOS is unavailable. Top-level workflow metadata is mirrored as `workflow.durable.checkpoint` session entries for `/workflow resume` discovery. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Introduced `ctx.tool(name, args, fn, options?)` — a durable cached tool execution primitive that runs arbitrary TypeScript code and caches the result so completed side effects are not repeated on resume. Supports optional retry with exponential backoff via `retriesAllowed`, `maxAttempts`, `intervalMs`, and `backoffRate` options. Only `ctx.*` blocks produce durable checkpoints. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Added durable `ctx.ui` checkpointing: completed `ctx.ui.input` / `confirm` / `select` / `editor` / `custom` responses are cached by prompt identity that includes method, label/message, options, and call order, so repeated prompts do not collide and a resumed workflow does not re-ask already-answered prompts. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Added durable `ctx.stage` / `ctx.task` / `ctx.chain` / `ctx.parallel` / child `ctx.workflow` checkpointing: completed stage-like outputs are recorded with stable ordinal replay keys and replayed on resume, skipping re-execution while avoiding checkpoint id collisions after redispatch. Chain and parallel items reuse durable task checkpoints, and child workflow calls checkpoint the completed child result at the parent boundary. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Wired `/workflow resume` into the TUI command surface to fall back to the cross-session durable resume catalog when a target id is not a live run, and to surface durable root workflow history in fresh sessions. It lists resumable workflows by top-level id and resumes via DBOS-style replay (re-dispatch with the original workflow id so completed checkpoints are skipped), mirroring `/resume` ergonomics. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Added `@dbos-inc/dbos-sdk` as an optional dependency of `@bastani/atomic` so DBOS-backed durable execution is available without a separate install when the SDK resolves. The workflows package remains dependency-free at runtime; the DBOS adapter is loaded lazily only when `DBOS_SYSTEM_DATABASE_URL` is set. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Added a cross-session resume catalog (`scanResumableWorkflows`) that scans session JSONL files for durable checkpoint entries to build the `/workflow resume` selector list, displaying root workflow name, status, completed checkpoint count, and pending prompts. The scanner understands Atomic's actual extension custom-entry JSONL shape (`type: "custom"`, `customType: "workflow.durable.checkpoint"`) as well as legacy direct checkpoint rows.
- Added cancellation, failure, and retry semantics for durable workflows: killed/cancelled workflows are marked `cancelled` and excluded from automatic resume; recoverable failures remain in the resumable list; non-recoverable failures are filtered out; `ctx.tool` retries with exponential backoff; pending `ctx.ui` prompts leave off on resume for the user to answer.
- Added DBOS read-side hydration: when `DBOS_SYSTEM_DATABASE_URL` is set, a fresh Atomic process now hydrates its in-memory checkpoint mirror from DBOS on `/workflow resume` so workflows persisted by a prior session can be discovered and replayed without prior in-process state. Checkpoint records are stored as structured envelopes (including kind, checkpoint id, args hash, prompt hash, and replay key) in DBOS so hydration fully reconstructs the original checkpoint metadata. Root workflow metadata is mirrored separately, so DBOS helper-workflow completion does not make Atomic roots appear completed; `ctx.tool`/`ctx.ui`/`ctx.task` await async DBOS checkpoint persistence before returning side-effect results. Legacy/simple DBOS step outputs without the envelope are handled gracefully as generic stage checkpoints. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))

### Fixed

- Added direct mouse-click activation for visible workflow graph nodes: clicking a node now focuses it and opens/attaches it through the same path as pressing Enter, with hit-testing based on the rendered node rectangles so overlay chrome/scroll geometry stays in sync while wheel scrolling and empty-space/chrome clicks remain safe no-ops. ([#1521](https://github.com/bastani-inc/atomic/issues/1521))
- Fixed attached workflow stage chats to capture mouse/trackpad wheel events by default and enable button-event SGR terminal reporting, keeping scroll gestures inside the active stage transcript or prompt instead of falling through to terminal/main-chat scrollback; `ctrl+t` now toggles true copy mode by disabling workflow-chat mouse reporting so terminal/tmux text selection works normally. ([#1519](https://github.com/bastani-inc/atomic/issues/1519))
- Routed idle `StageContext.sendUserMessage()` turns through the workflow stage guard so first-call injected turns record normal stage lifecycle and all idle injected turns observe abort/kill wiring, MCP scope, readiness handling, and the concurrency limiter. ([#1520](https://github.com/bastani-inc/atomic/issues/1520))
- Fixed attached workflow stage chats so stale terminal, paused, blocked, skipped, or otherwise no-longer-running live stage handles, terminal run/stage transitions before `agent_end`, reopened terminal chats, late post-terminal subagent tool updates, and partial subagent workflow-graph progress no longer keep the `Working...` spinner, animation tick, subagent renderer interval, renderer animation registry entry, or subagent progress spinner active, while genuine follow-up/prompt/resume `agent_start` work still shows progress on retained terminal stage chats. ([#1518](https://github.com/bastani-inc/atomic/issues/1518))
- Fixed `/workflow resume`'s interactive picker to reuse the same Atomic `/resume` session-selector tree chrome for live, paused, failed-resumable, and cross-session durable workflows, replacing the hand-rolled durable/combined picker so the selector is cosmetically consistent across resume flows. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Matched `/resume` empty-state behavior for interactive `/workflow resume` by opening the shared empty selector when no resumable workflow rows remain after filtering instead of printing an error. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Hid `/workflow resume` selector entries that only exist as stale session-cache metadata with no matching durable backend handle and hid durable `running`/`failed`/`blocked` rows whose workflow definition is no longer registered, filtering old pre-checkpoint-engine/test workflow runs instead of surfacing rows that can only fail as stale or missing-definition. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Persisted terminal non-resumable durable metadata during finalization so non-recoverable failed/blocked workflows do not remain visible in `/workflow resume` as resumable entries after they are completely finished. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Delayed durable `/workflow resume` discovery for `running`/`paused` workflows until the first durable checkpoint or pending checkpointable prompt exists, records resumable LM-stage session metadata as soon as a stage opens, and reopens that exact Atomic/Pi session file on durable resume so eligible stages continue mid-session while completed tool/UI/stage checkpoints still replay all-or-nothing. CLI/orchestrator quit now leaves durable-progress workflows resumable instead of treating panel close as an authoritative kill; `/workflow kill` remains the explicit non-resumable disposal path, and successful completion still marks the root workflow terminal and removes the row once the whole workflow terminates to the end. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed repeated quit/resume durable LM-stage cycles by keeping in-progress stage-session metadata separate from completed stage-output checkpoints, persisting DBOS checkpoint records by checkpoint id rather than replay key, removing stale quit snapshots before reusing the original durable workflow id, and sending a single `Continue` continuation message to the recorded LM session instead of replaying the original workflow prompt. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Made `/workflow resume` list only inactive workflows: actively-running durable runs are hidden from the selector and refused on resume (in-session or cross-session) with an intuitive error pointing at `/workflow connect`/`/workflow kill`, while quitting the CLI/panel flips the durable handle from `running` to `paused` so it re-enters the resumable set. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed DBOS durable metadata updates to use versioned metadata records with latest-timestamp hydration, removed invalid DBOS `duplicationPolicy` parameters, awaited completed stage checkpoint writes before returning to workflow code where practical, awaited DBOS initialization before first dispatch/list/resume in DBOS-configured runtimes, opened an interactive durable picker for no-arg `/workflow resume` when only durable entries exist (including sessions with only completed local runs), distinguished repeated same-name/same-args `ctx.tool` calls by stable ordinal identity, and made retry backoff observe cancellation before later attempts run. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed durable stage lifecycle persistence so workflow completion waits for pending backend checkpoint writes (including DBOS async writes) and reports a failed run when those writes fail instead of acknowledging success before checkpoints are durable. Terminal durable status metadata is flushed before completed/failed/cancelled root runs return. Cached `ctx.task`, `ctx.chain`/`ctx.parallel` items, and child `ctx.workflow` replay now record completed replay nodes in the workflow graph/store, matching cached `ctx.stage` visibility. DBOS `recordCheckpointAsync()` updates the replay mirror only after DBOS accepts the checkpoint, so failed durable writes do not make the current process believe a side effect is safely replayable. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed repeated `ctx.workflow(child)` calls to use a dedicated durable replay-key counter so cache-hit calls do not desync ordinal sequencing across resume; direct completed stages now checkpoint under the durable replay key used for lookup instead of the executor snapshot key; `ctx.exit` terminal states (`cancelled`, `blocked`, `skipped`) are now persisted to durable metadata and flushed; no-arg `/workflow resume` surfaces durable workflow history even when live local runs exist; and `durableBackend` is propagated into child workflow run options so custom backends are shared across parent and child instead of split-braining. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed durable resume edge cases where workflows discovered only from session JSONL could be dropped before actual resume, schema-backed stage replay returned raw JSON text instead of structured values, parallel fail-fast skipped stages before async finalizers completed, retry backoff left abort listeners behind after normal sleeps, and durable stage checkpointing could ignore an explicit stage replay key. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed durable replay robustness: child workflow internal `ctx.tool`/`ctx.ui`/`ctx.stage` side effects are now checkpointed under the parent/root durable workflow via a scoped backend keyed by the child boundary, so an interrupted child does not re-execute completed side effects on parent resume (previously child checkpoints were written under a fresh per-run UUID that was never recovered). `/workflow resume` now refuses cache-only entries as `stale` when a workflow has session-JSONL metadata but no durable checkpoint state in the backend, instead of silently re-running from scratch. Durable replay identities (`durableHash`) now use a SHA-256 digest instead of a 32-bit DJB2 hash that could collide across distinct tool/stage identities. `ctx.tool` re-checks cancellation after the tool function resolves and before recording/returning the side-effect result, so a side effect that completes concurrently with cancellation is not persisted as a replayable checkpoint. File-backed durability recovers from a stale lock directory left by a crashed process (backdated beyond a threshold) instead of wedging until the acquire timeout. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed terminal durable cache suppression so stale session-JSONL entries cannot resurrect workflows the backend knows are completed/cancelled/non-resumable: the backend terminal state now takes precedence over older JSONL cache entries during listing and resume. Successful durable `/workflow resume <id>` now connects/opens the overlay to the resumed run, matching live resume ergonomics. No-arg `/workflow resume` now shows a combined selector (live runs + cross-session durable workflows) so durable workflows are directly selectable even when live runs exist, instead of only being printed as hints. Fixed `ScopedDurableBackend.listCheckpoints` to exclude sibling child scopes that shared a common id prefix (previously re-prefixing caused sibling checkpoints to leak into the wrong scope). Cleaned up a cosmetic merged import line in `run.ts`. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed empty string stage outputs to be preserved durably as empty strings instead of being collapsed into status objects, so a stage completing with empty assistant text replays as empty rather than appearing to have no checkpoint. Schema-backed stage prompts with empty string results are now also checkpointed. Stage finalization failures (including durable checkpoint write errors) no longer leak the concurrency limiter/semaphore because each cleanup step is independently guarded. Mixed live+durable `/workflow resume` now uses async DBOS-hydrated durable listing (`prepareDurableResumable`) instead of a synchronous in-memory listing so cross-session entries discovered from Postgres are included in the combined selector. Replayed durable stages now register in the graph frontier tracker so parent/lineage topology is preserved for subsequent stages. Dismissing the combined resume picker returns to chat without opening a second live-only picker. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed Ralph review regressions in durable resume: durable and combined pickers now settle selections before synchronous custom-UI disposal can dismiss them; headless no-arg durable resume prints the catalog instead of awaiting unavailable/no-op picker UI; failed live runs selected from the combined picker resume through the continuation path; durable resume dispatch forwards the interactive/non-interactive command policy; `ctx.ui.custom` replays cached void/`undefined` responses instead of treating them as cache misses; stage finalization errors are rethrown after releasing handles/limiters; and resume integration tests isolate the durable singleton so full integration runs remain deterministic. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))
- Fixed default file-backed durability to write one JSON state file per root workflow instead of rewriting a shared `state.json` on every checkpoint, avoid all-files scans on point checkpoint lookups, prune completed/cancelled/non-resumable terminal workflow files while retaining running/paused/recoverable-failed files for crash recovery until resumed or killed, use restrictive `0700` durable directories and `0600` state/lock-owner files, fail closed to in-memory durability when no home directory is available, and reclaim stale locks only when their owner marker belongs to a dead process. Added `ATOMIC_WORKFLOW_DURABLE=0`/`false`/`off`/`memory` as a documented privacy opt-out for plaintext cross-session checkpoint persistence. ([#1498](https://github.com/bastani-inc/atomic/issues/1498))

## [0.9.3-alpha.1] - 2026-06-25

### Changed

- Workflow stage sessions are now marked as internal and excluded from the standard Atomic `/resume`, `atomic -r`, and `--continue` history, while remaining fully resumable/inspectable through `/workflow resume`, `/workflow attach`, and the `workflow` tool's `status`/`stages`/`stage`/`resume` actions via the run/stage store and its `sessionFile` links ([#1504](https://github.com/bastani-inc/atomic/issues/1504)).
- Revised the builtin `goal` worker/continuation prompts and the builtin `ralph` orchestrator prompts to emphasize implementing the requested task through full completion ("do not stop until the objective is complete") instead of preparing a partial implementation for incremental review.
- Removed model-visible current-iteration/turn/loop information from the builtin `goal`, `ralph`, and `open-claude-design` workflows so models are not biased by which iteration they are on. This drops the worker `Turn: N/M` banner, `Implement iteration N/M` / `Research iteration N/M` framing, "first iteration/worker turn" phrasing, and the live-preview `iteration N/M` label; switches model-relayed artifacts to stable non-ordinal names (`worker-receipt.md`, `review-<reviewer>.json`, `review-round-latest.json`, `orchestrator-report.md`); and strips turn fields from the model-facing goal ledger artifact. Internal UI stage names (e.g. `work-turn-2`, `orchestrator-2`) are unchanged, and the `max_turns`/`max_loops` inputs and `turns_completed`/`iterations_completed` outputs are retained.
- Raised workflow-stage subagent recursion to the shared five-level nesting budget so workflow stages match main-chat delegation depth.

### Fixed

- Fixed the builtin `open-claude-design` continuation loop so generator stages fork only from prior generator sessions and user-feedback stages fork only from prior feedback sessions; the first feedback stage now starts its own chain instead of inheriting generator context.
- Fixed workflow config loading and user-global discovery to honor `ATOMIC_CODING_AGENT_DIR` isolation instead of reading `~/.atomic/agent` when an isolated agent dir is configured.

## [0.9.2] - 2026-06-23

### Changed

- Removed the initial `prompt-refinement` stage and shared prompt-refinement helper from the builtin `goal` and `ralph` workflows so both now use the raw objective/prompt as the operative task text for their first downstream stages; the now-obsolete refined/original trace outputs were also removed.
- Updated builtin `goal` and `ralph` reviewer prompts to inspect referenced QA end-to-end video evidence before treating it as proof of user-visible behavior.
- Aligned the workflows package peer dependency with upstream pi TUI `^0.79.10`; no workflow source changes were needed for this metadata sync.

## [0.9.2-alpha.1] - 2026-06-23

### Changed

- Removed the initial `prompt-refinement` stage and shared prompt-refinement helper from the builtin `goal` and `ralph` workflows so both now use the raw objective/prompt as the operative task text for their first downstream stages; the now-obsolete refined/original trace outputs were also removed.
- Updated builtin `goal` and `ralph` reviewer prompts to inspect referenced QA end-to-end video evidence before treating it as proof of user-visible behavior.
- Aligned the workflows package peer dependency with upstream pi TUI `^0.79.10`; no workflow source changes were needed for this metadata sync.

## [0.9.1] - 2026-06-23

### Changed

- Changed the shared `goal`/`ralph` prompt-refinement stage to use a workflow-neutral, model-only rubric prompt that returns only the refined objective instead of invoking the `prompt-engineer` skill directly.

### Fixed

- Fixed the builtin `ralph` reviewer-c model configuration to use Gemini 3.1 Pro as the third reviewer with Gemini 3.1 provider fallbacks, removing Gemini 3.5 Flash from that slot's fallback chain ([#1484](https://github.com/bastani-inc/atomic/issues/1484)).

## [0.9.1-alpha.1] - 2026-06-22

### Changed

- Changed the shared `goal`/`ralph` prompt-refinement stage to use a workflow-neutral, model-only rubric prompt that returns only the refined objective instead of invoking the `prompt-engineer` skill directly.

### Fixed

- Fixed the builtin `ralph` reviewer-c model configuration to use Gemini 3.1 Pro as the third reviewer with Gemini 3.1 provider fallbacks, removing Gemini 3.5 Flash from that slot's fallback chain ([#1484](https://github.com/bastani-inc/atomic/issues/1484)).

## [0.9.0] - 2026-06-22

### Breaking Changes

- Replaced the removed `defineWorkflow(...).run(...).compile()` builder with the single `workflow({ name?, description, inputs, outputs, run })` authoring door; authored workflows now import and export the `workflow` definition directly.
- Removed the workflow stage/task/direct-mode `bashPolicy` option and schema so workflow-launched `bash` tools match upstream pi behavior; use `tools`/`noTools`, custom tools, or external sandboxing for command scoping.
- Changed the builtin `open-claude-design` workflow contract by renaming `browse_cli_status` to `playwright_cli_status` and removing the `reference`, `output_type`, and `design_system` inputs in favor of discovery-stage questioning.

### Added

- Added per-model context-window workflow authoring tokens such as `github-copilot/claude-opus-4.8 (1m):xhigh`, plus `contextWindow`/`contextWindowStrict` stage and direct-task options.
- Added deterministic workflow-stage resume handling that suppresses duplicate readiness prompts after interactive resumes and continues promptable stages exactly once.
- Added a `playwright-cli` QA proof-video path to the builtin `ralph` workflow and a safe final-stage attachment/link handoff when `create_pr=true`.
- Added shared initial prompt-refinement stages to the builtin `ralph` and `goal` workflows so raw requests are clarified with the `prompt-engineer` skill before research and orchestration.
- Added the builtin `goal` workflow's safe-by-default `create_pr` toggle and final `pull-request` stage for GitHub, Azure Repos, GitLab, Bitbucket, Sapling, or Phabricator handoff after reviewer/reducer approval.
- Restructured the builtin `open-claude-design` workflow around `impeccable` discovery/init, design-system/reference gathering, optional reference discovery, forked generate/user-feedback iterations, and a minimal exporter/final-display phase.

### Changed

- Decomposed the foreground workflow executor behind an internal `EngineRuntime.spawnStage(...)` chokepoint while preserving run, resume, kill, HIL, worktree, model-fallback, graph-frontier, and continuation behavior.
- Changed builtin `ralph`, `goal`, and `open-claude-design` browser automation guidance from the removed `browser` skill / `browse` CLI to the `playwright-cli` skill and command.
- Changed builtin `ralph` review fan-out to three independent model-family reviewers with severity-aware unanimous approval, stronger implementation-notes evidence requirements, and non-blocking P3 nit handling.
- Changed builtin workflows to use long-context GitHub Copilot fallback model tokens where available and to inherit upstream pi TUI `^0.79.9` compatibility fixes.
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist.

### Fixed

- Fixed workflow stage sessions to inherit the host's non-default session directory in headless/forked runs while preserving explicit per-stage overrides.
- Fixed manual workflow pause/resume state so attached-stage controls update the main run status the same way `/workflow pause` and `/workflow resume` do.
- Fixed the builtin `ralph` review loop to stop on deterministic severity-aware unanimous approval instead of treating non-blocking P3 findings or placeholder findings as blockers.
- Fixed workflow model fallback to reuse the initially loaded credential/model registry, report real credential-store load failures, and resume follow-ups on the settled fallback model instead of replaying from the unavailable primary.
- Fixed `open-claude-design` user-feedback threading, test artifact placement, browser-unavailable early exits, snapshot copy safety, placeholder filtering, and read-only final display behavior.

## [0.9.0-alpha.4] - 2026-06-22

### Breaking Changes

- Restructured the builtin `open-claude-design` workflow's input contract. Removed the `reference`, `output_type`, and `design_system` inputs; the workflow now gathers those through a new `discovery` interview stage instead. The remaining inputs are `prompt`, `discover_references`, and `max_refinements`. Existing invocations that passed `reference=…`, `output_type=…`, or `design_system=…` should drop those arguments and let the discovery stage ask for the output type and references (or describe them in `prompt`).

### Added

- Restructured the builtin `open-claude-design` workflow around the accessible `impeccable` skill (`/skill:impeccable …`). The current phase order is: (1) **combined discovery/init** — one `discovery` stage runs `/skill:impeccable shape` to confirm the brief, output type, and references, then runs `/skill:impeccable init` so impeccable detects/creates/reconciles `PRODUCT.md` / `DESIGN.md` without a separate init stage; (2) **context/reference phase** — `ds-locator` / `ds-analyzer` / `ds-patterns` first gather project design-system evidence and handle user-provided URL/file reference capture/parsing, then optional `reference-discovery` browses curated galleries using the ds-* evidence and asks the user which curated direction they prefer (or asks for a reference image/screenshot/URL/path if none fit); (3) **forked generate/user-feedback loop** — `generate-1` produces the first `preview.html`, each `user-feedback-*` stage drives `/skill:impeccable live`, and meaningful feedback threads into the next forked `generate-*` stage; (4) **export** — export is now deliberately only `exporter` followed by `final-display`, with no `pre-export-scan`, `forced-fix`, `web-capture-*`, `file-parser-*`, or `design-system-builder` stages. User-provided references take **precedence over `DESIGN.md`/`PRODUCT.md`** through the `REFERENCE_PRECEDENCE` prompt block. Added unit coverage for the trimmed input contract, combined discovery/init stage, direct `ds-*` reference handling, forked generate/user-feedback continuity, removed export/parse/builder/init stages, and feedback persistence/threading.
- Added a safe-by-default `create_pr` toggle to the builtin `goal` workflow, matching Ralph's final-stage PR handoff behavior. Goal now skips PR/MR/review creation unless `create_pr=true` **and** reviewer quorum plus the reducer mark the run `complete` within the turn budget, omits `pr_report` when disabled or not approved, and runs a provider-aware `pull-request` stage only at the end when explicitly authorized. The final stage reads the goal ledger, worker receipts, latest review artifact, final report, and sanitized `base_branch` before attempting GitHub, Azure Repos, GitLab, Bitbucket, Sapling, or Phabricator handoff tooling. Goal worker/reviewer prompts now include an intermediate-stage guardrail telling them to ignore PR-creation requests because only the final `pull-request` stage may attempt that handoff.

### Fixed

- Fixed the builtin `open-claude-design` workflow feedback threading so `user-feedback-*` live annotations (`user_notes`, `live_changes`, and `annotated_snapshot`) are parsed, persisted under `<artifact_dir>/feedback/iteration-<n>.*`, and required to appear in the next `generate-*` prompt before a revision runs. The old internal critique/screenshot/apply stages were removed, so user feedback is now the sole refinement signal.
- Fixed the builtin `open-claude-design` workflow polluting the project's `specs/design/` tree with per-run artifact folders during automated test runs; `prepareArtifactDir` now writes to the OS tmpdir when `NODE_ENV=test`.
- Hardened the builtin `open-claude-design` browser and artifact safety paths: when the `playwright-cli` browser is unavailable the run exits cleanly up front (skipped under the test harness), annotation snapshot copies are constrained to the project/artifact dir, one-character real notes survive placeholder filtering, and the final `final-display` stage is read-only so it only surfaces the exported spec and re-run instructions.

## [0.9.0-alpha.3] - 2026-06-21

### Added

- Added a shared `prompt-refinement` stage to the builtin `ralph` and `goal` workflows. Both now run one `prompt-refinement` stage at the start that invokes the `prompt-engineer` skill (`/skill:prompt-engineer`) to sharpen the raw user request into a clearer, more actionable objective using the Workflow Best Practices prompt anatomy documented in `packages/coding-agent/docs/workflows.md` (`## Workflow Best Practices`). The refined request replaces the original as the operative objective for all downstream stages (research, orchestration, worker/review loops); the original request is preserved for traceability. `ralph` exposes `original_prompt` and `refined_prompt` outputs, and `goal` exposes `original_objective` (omitted when refinement left it unchanged) and records the original objective in the ledger and final report. The stage uses the same model chain as ralph's prompt-engineering stage (`promptEngineerModelConfig`).
- Renamed the builtin `ralph` workflow's per-iteration `prompt-engineer-${iteration}` stage to `research-prompt-refinement-${iteration}` (`renderPromptEngineerPrompt` → `renderResearchPromptRefinementPrompt`). It now consumes the clarity-refined request as input and continues to transform it into a codebase/online research question for the research stage.

## [0.9.0-alpha.2] - 2026-06-21

### Breaking Changes

- Replaced the removed `defineWorkflow(...).run(...).compile()` builder with the single `workflow({ name?, description, inputs, outputs, run })` authoring door. Authored workflows must import `workflow` from `@bastani/workflows`, import `Type` from `typebox`, provide an `outputs` map, and export the returned definition directly; `.compile()` and the builder types are no longer exported.
- Removed the workflow stage/task/direct-mode `bashPolicy` option and schema so workflow-launched `bash` tools match upstream pi behavior. Use `tools`/`noTools` to expose or hide `bash`, custom tools for narrow operations, and an OS/container sandbox for command allowlisting.

### Changed

- Decomposed the foreground workflow executor behind an internal, host-injected `EngineRuntime.spawnStage(...)` chokepoint. Agent stages, task/chain/parallel primitives, nested workflow boundary stages, MCP stage scope setup/cleanup, continuation replay wiring, and graph-frontier tracking now live under the engine seams while preserving the existing run, resume, kill, HIL, worktree, and model-fallback behavior.
- Aligned the workflows extension peer dependency with upstream pi TUI `^0.79.9` so workflow graph, custom UI, prompt-broker, and streamed Markdown surfaces inherit the latest shared TUI compatibility fixes, including stabilized partial code-fence rendering during streaming; no workflows extension source changes were needed for this dependency-covered sync.

## [0.9.0-alpha.1] - 2026-06-20

### Breaking Changes

- Renamed the builtin `open-claude-design` workflow output `browse_cli_status` to `playwright_cli_status` as part of migrating the workflow's preview/review tooling from the removed `browse` CLI to the `playwright-cli` command. Update any workflow-composition consumers that read `browse_cli_status`.

### Added

- Added a deterministic workflow-stage resume stop hook: after an interactive interrupt/pause is resumed with a message, the executor suppresses the #1099/#1264 readiness prompt for that resume-answer turn (including `ask_user_question` turns) and, when the stage remains promptable, sends `Continue where you left off.` in the same stage session once per resume; schema-backed stages that already finalized with `structured_output` consume the token without a second prompt ([#1407](https://github.com/bastani-inc/atomic/issues/1407)).
- Added a QA end-to-end proof video to the builtin `ralph` workflow. For UI-applicable or full-stack changes, the orchestrator now runs a `playwright-cli` end-to-end QA pass that drives the running app like a user, records a reviewable video (`playwright-cli video-start`/`video-stop`) to a stable run path, references it in the implementation notes (`## QA E2E Video`), and exposes it as the new optional `qa_video_path` output so the proof is available when the orchestrator finishes. When `create_pr=true`, the final `pull-request` stage attaches or links that video to the created PR/MR/review (embedding/linking where the provider supports media uploads, otherwise surfacing the absolute path). When no user-visible UI scenario applies, no video is produced and the notes record why.
- Added a per-model context-window authoring token to workflow model strings: a parenthesized token in the model-name portion, e.g. `github-copilot/claude-opus-4.8 (1m):xhigh`. The token may precede *or* follow the optional `:reasoning` suffix (`(1m):xhigh` or `:xhigh (1m)`); adopting GitHub Copilot's `Claude Opus 4.8 (1M context)` naming convention keeps the window separate from the reasoning level so the two never collide. Accepted token forms, all selecting the model's long tier when one exists: a generic size-agnostic `(long)` marker, or a rounded size matching the model's long tier (e.g. `(1m)` for claude-opus-4.8's 1M tier or `(1.1m)` for gpt-5.5's 1.05M tier). A request at or below the model's default keeps the default; a request above it selects the long tier (exact match wins, otherwise the smallest advertised window at or above the request, rounding **up** so a rounded marker always reaches the long tier); it falls back to the model's default (short) window when no long tier exists. It applies only to the candidate that carries the token, leaving primary and other fallback models untouched. Without the token, a tiered model now **pins its natural default (short) context window** in workflow stages so a persisted interactive long-context preference does not leak in (a stage-level `contextWindow`/`(long)` token still opts into long context). Also surfaced `contextWindow`/`contextWindowStrict` on `StageOptions` and the workflow tool's direct-task schema for stage-level selection.

### Changed

- Changed the shared `goal`/`ralph` prompt-refinement stage to use a workflow-neutral, model-only rubric prompt that returns only the refined objective instead of invoking the `prompt-engineer` skill directly.
- Changed the builtin `ralph`, `goal`, and `open-claude-design` workflows and the shared end-to-end verification guidance to drive browsers through the `playwright-cli` skill and `playwright-cli` command instead of the removed `browser` skill / `browse` CLI. Ralph/goal subagents now verify web and full-stack flows with `skill: "playwright-cli"`, and `open-claude-design`'s deterministic setup step now ensures `playwright-cli` (`npm install -g @playwright/cli@latest`) instead of `browse`, with every preview/review stage prompt updated to `playwright-cli open`/`snapshot`/`screenshot --filename`/`resize`/`show --annotate`.
- Changed the builtin `ralph` workflow review fan-out from two reviewers to three independent reviewers, each running on a different primary model family (Claude Fable 5, GPT-5.5 Codex, and Gemini 3.1 Pro) with shared fallbacks, so the adversarial review gets cross-model coverage instead of repeated passes from one model. The review loop stops only when all three reviewers independently approve (find no issues), so a P0–P3 finding from any single reviewer keeps Ralph iterating instead of being out-voted by a majority quorum. Also strengthened the orchestrator's implementation-notes contract to require verifiable evidence for any claims recorded in the notes and reviewer artifacts.
- Changed the builtin `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows to run their GitHub Copilot `claude-opus-4.8` fallbacks at the model's largest advertised long-context (~1M/936K) window via the new `(1m)` token, automatically degrading to the 200K short window when Copilot's long-context tier is unavailable. Other models in each fallback chain are unaffected.
- Aligned the workflows extension peer dependency with upstream pi TUI `^0.79.7` so workflow graph, custom UI, and prompt-broker integrations consume the latest shared TUI color-scheme, Warp image capability, and compatibility fixes; no workflows extension code changes were made for this metadata sync ([#1413](https://github.com/bastani-inc/atomic/issues/1413)).
- Changed contributor validation to include the monorepo-wide file-length gate for tracked TS/JS/Rust files in local `prek` hooks and PR CI, with only documented generated/vendored exclusions and no grandfathered baseline allowlist ([#1445](https://github.com/bastani-inc/atomic/issues/1445)).

### Fixed

- Fixed the builtin `ralph` reviewer-c model configuration to use Gemini 3.1 Pro as the third reviewer and remove Gemini 3.5 Flash from that slot's fallback chain ([#1484](https://github.com/bastani-inc/atomic/issues/1484)).
- Fixed workflow stage transcripts ignoring the host's resolved non-default session directory in headless runs. Stages without an explicit `sessionDir` now inherit the active main-session directory when it comes from `--session-dir`, `ATOMIC_CODING_AGENT_SESSION_DIR`, or settings; explicit per-stage `sessionDir` still wins, default host sessions keep writing stages to the global store, and forked stages inherit the non-default directory too ([#1444](https://github.com/bastani-inc/atomic/issues/1444)).
- Fixed a manual workflow pause/resume not updating the main-chat run status the way the `workflow` tool and `/workflow pause`/`/workflow resume` do. Pausing a stage from the attached stage chat (Escape) or any direct live-handle path recorded only the **stage** as paused (`recordStagePaused`) and never the **run** (`recordRunPaused`), so the below-editor status widget and `/workflow status` kept showing the run as `running` (`●`) even though work was paused; resume had the symmetric gap. The executor stage-control handle now records run-level pause/resume itself — marking the run paused once no stage is still actively running (mirroring `pauseRun`'s all-active-stages-paused rule) and restoring it on resume — so manual and tool-driven pause/resume update the main chat identically. Both run-level transitions are idempotent, so the tool/slash path and cascade re-entry stay safe.
- Fixed the builtin `ralph` workflow review loop iterating until `max_loops` even when reviewers judged the patch correct. The unanimous-approval gate required a literally empty `findings` array, so a single low-priority **P3** nit — or a placeholder/dummy finding a reviewer appended because it wrongly believed an empty array would fail schema validation — kept the loop spinning despite every reviewer reporting `overall_correctness: "patch is correct"`. Approval is now **severity-aware and deterministic**: a reviewer approves when it judged the patch correct, reported no `reviewer_error`, and filed no *blocking* finding, where blocking = **P0/P1/P2** (priority 0/1/2) and **P3** (priority 3) is a non-blocking nice-to-have; a finding without a determinable priority (`null`/`undefined`) is treated as blocking so ambiguity never silently approves. The decision is computed from finding priorities rather than the reviewer's self-reported `stop_review_loop` flag. Extracted the gate into `builtin/ralph-review-gate.ts` (`reviewDecisionApproved`, `isBlockingFinding`) with unit coverage, and updated the reviewer prompt so an empty `findings` array is explicitly valid and placeholder findings are never fabricated ([#1407](https://github.com/bastani-inc/atomic/issues/1407)).
- Fixed workflow stage **model fallback misreporting configured providers as `No API key found`**. Each fallback candidate session was created with a fresh `AuthStorage`/`ModelRegistry`, so after a primary model failed (for example the Ralph `reviewer-a` chain hitting an unavailable `anthropic/claude-fable-5` and getting a real provider 404), every fallback candidate re-read `auth.json` from scratch. Under concurrent reviewer stages and OAuth token refreshes holding the `auth.json` lock, that fresh synchronous reload could fail and silently fall back to an empty credential set, reporting `No API key found` for `anthropic`/`openai-codex`/`github-copilot` even while sibling reviewer stages used those exact providers successfully. A stage now captures the `ModelRegistry` (and its already-loaded `AuthStorage`) from its first session and threads it into every subsequent fallback candidate, so a successfully-loaded credential store is reused across the whole fallback chain instead of being discarded and re-loaded per candidate. Combined with the coding-agent change that surfaces a real credential-store load failure instead of `No API key found`, a transient store-read failure remains a recoverable/retryable auth failure ([#1431](https://github.com/bastani-inc/atomic/issues/1431)).
- Fixed post-completion workflow follow-ups replaying the entire model-fallback chain from an unavailable primary instead of resuming on the model the stage settled on. After model fallback succeeded, the stage kept its working `session` but left `sessionPromise` undefined, and `ensureSession()` only checked `sessionPromise` — so a follow-up (`ctx.followUp`/`ctx.steer`/`ensureAttached`, and post-completion `workflow send`/TUI prompts) created a brand-new session from `candidates[0]` (the primary), discarding the working fallback session. For a chain whose primary 404s (e.g. `anthropic/claude-fable-5`), every follow-up re-ran `primary -> 404 -> ... -> working model` and could leave the stage stuck on the unavailable primary. `ensureSession()` now reuses an already-attached session, and `promptWithFallback()` retries the last-settled model first (for both live retained sessions and disk-reattached sessions), restarting the full chain from the primary only if that model fails again retryably ([#1431](https://github.com/bastani-inc/atomic/issues/1431)).

## [0.8.30] - 2026-06-17

### Changed

- Aligned the workflows extension peer dependency with upstream pi TUI `^0.79.4` so workflow graph, custom UI, and prompt-broker integrations consume the latest shared TUI fixes; no workflows extension code changes were made for this metadata sync.

### Fixed

- Fixed workflow stage sessions for workflows loaded through `atomic -e` to build fresh child resource loaders from the parent Atomic resource snapshot, preserving custom extensions/tools, subagents and agent definitions, skills, prompt templates, themes, packages, workflows, trusted borrowed project-local resources, explicit `resourceLoader` overrides, and recursive workflow-extension filtering.
- Fixed schema-backed workflow stages to send up to three corrective follow-up prompts when a turn finishes without the required `structured_output` call or with an invalid `structured_output` call, echoing the concrete contract/validation error before failing the stage.
- Fixed failed workflow stages to retain and persist SDK `sessionId`/`sessionFile` metadata, so post-error transcript inspection and follow-up messaging resume from the failed conversation instead of silently creating a fresh empty session.
- Fixed schema-backed workflow stages with `noTools: "all"` to keep the restrictive allowlist while still exposing the required `structured_output` final-answer tool.
- Fixed `ctx.parallel` graph inference so queued branches launched under a limited `concurrency` setting keep the same parent frontier as their sibling branches, even when an earlier sibling fails with `failFast: false`, instead of appearing as downstream children of failed siblings.

## [0.8.29] - 2026-06-15

### Added

- Added opt-in schema-backed workflow item results: `ctx.stage(..., { schema })`, `ctx.task(..., { schema })`, `ctx.chain` items, and `ctx.parallel` items now receive a schema-specific `structured_output` tool only for that item, return the captured value from `ctx.stage().prompt(...)`, and expose parsed task values as `result.structured` while preserving formatted JSON handoff text ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).

### Changed

- Changed the builtin `ralph` workflow to start each iteration with `/skill:prompt-engineer` prompt-engineering and `/skill:research-codebase` research instead of an RFC/planner stage, pass the resulting research artifact to the orchestrator as primary implementation context, fork follow-up research from prior research session data, and feed unresolved reviewer findings into subsequent research passes ([#1371](https://github.com/bastani-inc/atomic/issues/1371)).
- Changed builtin `goal`, `ralph`, and `open-claude-design` decision gates to use schema-backed workflow `structured_output` stages with TypeBox-native schema builders instead of registering bespoke terminating custom tools or wrapping plain JSON schemas with `Type.Unsafe`.
- Changed the builtin `ralph` prompt-engineering stage to disable all tools while relying on the `/skill:prompt-engineer` skill prompt, keeping that first-pass rewrite focused and tool-free.
- Changed builtin `goal` worker/reviewer prompts and `ralph` orchestrator/reviewer prompts to request end-to-end verification when practical, using browser-skilled subagents for web/frontend flows that may depend on backend/API behavior and tmux-skilled subagents for TUI or terminal-app scenarios.
- Aligned the workflows extension with upstream pi TUI `^0.79.3` so workflow graph, custom UI, and prompt-broker integrations inherit the latest shared TUI compatibility fixes.
- Documented the opt-in `structured_output` workflow path and clarified that ordinary workflow stages do not receive `structured_output` from the default tool registry; schema-enabled items auto-add the runtime tool to explicit `tools` allowlists without adding extra workflow prompt text about the tool ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Removed top-level-object restrictions from workflow `structured_output` gate schemas; Atomic now passes any plain JSON Schema object directly to the tool and documents the one-`prompt()` limit for schema-backed `StageContext` result contracts ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).

### Fixed

- Fixed direct workflow tool validation so schema-enabled `task`, `tasks`, `chain`, and `parallel` items accept plain JSON Schema objects without additional object-root constraints ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed schema-backed workflow stages to fail with a clear stage-level error when `prompt()` is called more than once on the same `StageContext`, rather than surfacing the lower-level structured-output single-use guard ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed schema-backed workflow model fallback so an attempt that already captured a valid terminating `structured_output` result is treated as successful instead of retrying against fallback models and tripping the single-use result guard ([#1350](https://github.com/bastani-inc/atomic/issues/1350)).
- Fixed the workflow graph overlay remaining interactive when the parent/main-chat agent opens `ask_user_question`: the graph keeps focus, the parent question stays pending behind it with a clear “Main chat needs input — exit graph to answer.” status hint, hiding/exiting the graph focuses the pending question, and host custom-UI state changes no longer hide, restore, remount, or repaint the overlay ([#1353](https://github.com/bastani-inc/atomic/issues/1353)).
- Fixed builtin `ralph` skill-prompt stages to invoke bundled skills through `/skill:<name>` expansion so prompt engineering and research stages receive the intended skill instructions.
- Fixed concurrent workflow stage resource reloads to serialize temporary subagent child environment isolation so parallel stage startup cannot leave parent process child flags accidentally cleared.
- Fixed workflow stage sessions to keep bundled workflow package skills (`create-spec`, `impeccable`, `prompt-engineer`, `research-codebase`, and `skill-creator`) available while still disabling only the recursive workflows extension inside child sessions.
- Fixed workflow stage resource discovery so bundled subagent definitions stay available, `subagent` is active by default with the same two-hop nesting budget as main chat, and explicitly allowlisted bundled extension tools such as `subagent`, `web_search`, `fetch_content`, and `intercom` remain visible even when a workflow is launched from a subagent child process.

## [0.8.28] - 2026-06-11

### Added

- Added workflow `ctx.ui.custom<T>(factory, options?)` for graph-visible custom TUI human-in-the-loop prompts. Custom prompts create `awaiting_input` prompt nodes, reuse the stage UI broker/attached stage chat component path, expose the same real TUI/theme/keybinding/component types as Atomic extension custom UI, participate in live-memory prompt replay through hashed custom identities, honor prompt/run abort signals, and reject clearly in headless/unavailable UI modes ([#1309](https://github.com/bastani-inc/atomic/issues/1309)).
- Added workflow authoring `ctx.exit(options?)` for intentional early terminal runs from any call depth, supporting `completed`, `skipped`, `cancelled`, and `blocked` terminal statuses, optional persisted/displayed reasons, and partial declared outputs with strict validation for provided output keys. Public run/detail/child status unions widen with `skipped`, `cancelled`, and `blocked`, and child workflow results are discriminated by `exited`.
- Added workflow stage/task `bashPolicy` wiring so individual workflow stages can constrain the built-in `bash` tool with command-level allow/deny rules, command-string glob matching, fail-closed invalid-policy validation, and default-allow no-rule compatibility.

### Changed

- Changed the builtin `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows to use `anthropic/claude-fable-5:xhigh` as the primary planner/reviewer/design model, demoting each previous primary to the head of the fallback chain ([#1345](https://github.com/bastani-inc/atomic/pull/1345)).
- Changed workflow transcript introspection to return `sessionFile`/`transcriptPath` metadata with a lazy-read prompt by default when a transcript path exists, keeping bounded inline previews behind explicit `tail`/`limit` requests ([#1314](https://github.com/bastani-inc/atomic/issues/1314)).

### Fixed

- Fixed a workflow kill/abort race that could crash the entire CLI with a process-level uncaught exception when a workflow was killed mid-prompt; `raceAbort` now always observes the in-flight promise in the already-aborted branch so a killed run can no longer orphan a rejecting prompt.
- Fixed `ctx.exit(...)` cleanup races across the executor: the selected exit is a level-triggered gate so delayed `ctx.stage`/`ctx.task`/`ctx.chain`/`ctx.parallel`/`ctx.workflow`/graph-backed `ctx.ui.*` calls and retained `StageContext` session-control methods no longer create artifacts after exit, queued `ctx.parallel` work stops after exit, parent exits cancel linked hidden child workflows with typed parent-exit abort reasons and exactly-once stage-end ordering, and prompt-node abort handling preserves `workflow-exit` skipped reasons.
- Fixed terminal run-end reconciliation after `ctx.exit(...)` so when an external kill or another terminal writer wins `Store.recordRunEnd(...)`, the returned `RunResult` and `onRunEnd` callback report the canonical store status and only the winning run-end write is persisted.
- Fixed workflow-boundary child-edge metadata cleanup for `ctx.exit(...)` and continuation replay: skipped/failed boundaries clear `workflowChild`/`workflowChildRun`, stage-end persistence only emits child replay metadata for completed boundary stages, and expanded graph views no longer flatten stale child stages.
- Fixed `ctx.exit({ outputs })` payload capture to snapshot outputs by value at the first selected exit call, and deep-froze the thrown exit signal so author code cannot rewrite the terminal status, reason, or outputs after the fact.
- Fixed continuation replay races where replayed stage `prompt`/`complete` or prompt-node finalizers could complete after a concurrent `ctx.exit(...)`; pending replay finalizers now re-check the exit gate so resumed runs skip those stages instead of writing misleading completed stage-end entries.
- Fixed control-signal probing for arbitrary workflow-thrown values and abort reasons to use non-throwing reads, so throwing or inaccessible author accessors no longer leak from the executor catch path.
- Fixed interactive `ctx.ui.*` handling so workflow runs degrade gracefully: every primitive is guarded against method-less UI adapters with a clear per-method error, and headless (non-interactive) runs without a UI adapter reject with an explicit actionable message ([#1339](https://github.com/bastani-inc/atomic/issues/1339)).
- Fixed the builtin `open-claude-design` workflow not installing the browser skill's `browse` CLI before it is needed: a deterministic best-effort setup step probes `PATH` and installs the CLI when missing, per-run bootstrap guidance is injected into every browser-using stage, the install outcome is exposed via a new `browse_cli_status` output, and read-only `read`/`grep`/`ls` tools are granted to the refinement and pre-export decision gates ([#1327](https://github.com/bastani-inc/atomic/issues/1327)).
- Fixed paused workflow runs being counted as running in `/workflow status` (now shown separately as `❚❚ paused`) and run detail cards to surface the natural `workflow resume` action hint ([#1283](https://github.com/bastani-inc/atomic/issues/1283)).

## [0.8.28-alpha.4] - 2026-06-11

### Changed

- Changed the builtin `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows to use `anthropic/claude-fable-5:xhigh` as the primary planner/reviewer/design model, demoting each previous primary (`openai-codex/gpt-5.5:xhigh` or `github-copilot/claude-opus-4.8:xhigh`) to the head of the fallback chain ([#1345](https://github.com/bastani-inc/atomic/pull/1345)).

## [0.8.28-alpha.3] - 2026-06-11

### Added

- Added workflow stage/task `bashPolicy` wiring so individual workflow stages can constrain the built-in `bash` tool with command-level allow/deny rules, command-string glob matching, escaped glob bracket-class literal preservation, reserved/compound-head rejection, leading-redirection and attached command-head redirection rejection, non-leading `>|` noclobber redirection handling, assignment-head rejection, invalid glob range handling through `invalid-policy`, unknown top-level policy key rejection, runtime invalid-policy validation, and default-allow no-rule compatibility.
- Added workflow authoring `ctx.exit(options?)` for intentional early terminal runs from any call depth. `ctx.exit` supports `completed`, `skipped`, `cancelled`, and `blocked` terminal statuses, optional persisted/displayed reasons (including in the default status list), and partial declared outputs while preserving strict validation for provided output keys. This widens public run/detail/child status unions with `skipped`, `cancelled`, and `blocked`; downstream exhaustive switches should add cases for those statuses, while `failed` remains for thrown errors and `killed` remains external run-control. Child workflow results are now discriminated by `exited`: `exited: false` has full declared outputs, while `exited: true` has partial outputs plus the child exit status/reason.

### Fixed

- Fixed `ctx.exit(...)` cleanup races so the selected exit is a level-triggered gate: delayed `ctx.stage`/`ctx.task`/`ctx.chain`/`ctx.parallel`/`ctx.workflow`/graph-backed `ctx.ui.*` calls and retained `StageContext` session-control methods no longer create graph, control, or `AgentSession` artifacts after exit; queued `ctx.parallel` work stops after exit even with `failFast: false`; parent exits cancel already-linked hidden child workflows with a typed parent-exit abort reason while the child executor owns skipped child stage/prompt cleanup, live handle/session disposal, and non-resumable `cancelled` child run finalization; parent finalization waits for that child cleanup so child `workflow.stage.end` entries are written exactly once before child and parent `workflow.run.end`; and prompt-node abort handling preserves `workflow-exit` skipped reasons instead of overwriting them with `run-aborted`.
- Fixed terminal run-end reconciliation after `ctx.exit(...)` cleanup races. If an external kill or another terminal writer wins `Store.recordRunEnd(...)` while exit cleanup or exit-output validation is pending, the returned `RunResult` and `onRunEnd` callback now report the canonical store status/result/error/reason (for example `killed`) and only the winning run-end write is persisted.
- Fixed workflow-boundary child-edge metadata cleanup for `ctx.exit(...)` and continuation replay. Boundaries that finalize as `skipped` or `failed` now clear `workflowChild`/`workflowChildRun`, stage-end persistence only emits child replay metadata for completed boundary stages, restore ignores stale child metadata on skipped/failed stage-end entries, and expanded graph views no longer flatten stale child stages from non-completed boundaries.
- Fixed `ctx.exit({ outputs })` payload capture to snapshot outputs by value at the first selected exit call. Later `finally` mutations can no longer remove undeclared keys or change valid/invalid values before post-cleanup validation, and option/output getter or enumeration failures now run workflow-exit cleanup before finalizing as non-resumable authoring failures when that terminal write wins.
- Fixed `ctx.exit(...)` exposing mutable finalization state to author code. The thrown exit signal and its captured output snapshot are now deep-frozen, so a workflow that catches the exit signal in a broad `try`/`catch` and mutates it before rethrowing can no longer rewrite the terminal status, reason, or outputs (finalization recovers the same frozen object via the run abort reason or the rethrow).
- Fixed continuation replay races where replayed stage `prompt`/`complete` or prompt-node finalizers could complete after a concurrent `ctx.exit(...)`. Pending replay finalizers now register with workflow-exit cleanup and re-check the exit gate after their replay microtask, so resumed runs skip/suppress those stages instead of writing misleading completed stage-end entries.
- Fixed control-signal probing for arbitrary workflow-thrown values and abort reasons. `ctx.exit(...)`/parent-exit detection now uses non-throwing reads for private markers, `scope`, aggregate `errors`, `cause`, and `reason`; throwing or inaccessible author accessors are ignored for that probe branch so runs finalize as ordinary failures or kills instead of leaking accessor errors from the executor catch path.
- Fixed interactive `ctx.ui.*` handling so workflow runs degrade gracefully instead of crashing or emitting a confusing error. Partial/method-less UI adapters could previously surface a raw `TypeError: <method> is not a function` for `input`/`confirm`/`select`/`editor` (only `custom` was already guarded); every primitive is now guarded and rejects with a clear, actionable per-method error. Separately, headless/background (non-interactive) runs without a UI adapter now reject with an explicit "interactive ctx.ui.<primitive> is unavailable in headless (non-interactive) mode…" error that points to running interactively or removing the prompt, replacing the generic "Atomic runtime did not provide a UI adapter" wording for that path. Earlier completed stages remain completed, and interactive background runs keep brokering `ctx.ui.custom` through awaiting-input prompt nodes ([#1339](https://github.com/bastani-inc/atomic/issues/1339)).

## [0.8.28-alpha.2] - 2026-06-10

### Fixed

- Fixed the builtin `open-claude-design` workflow not installing the browser skill's `browse` CLI before it is needed. The workflow now runs an initial deterministic, best-effort setup step that probes `PATH` (`which`/`where browse`) and installs the CLI with `npm install -g browse` when missing (skipped under automated tests); per-run bootstrap guidance is derived from the outcome and injected into every browser-using stage (assume-available when ensured, with concrete recovery steps surfaced when the install failed), the install outcome is exposed via a new `browse_cli_status` output, and the read-only `read`/`grep`/`ls` tools are granted to the refinement and pre-export decision gates so they can inspect `preview.html` without mutating it. The step never throws or blocks the run, so stages keep their graceful-degradation fallback ([#1327](https://github.com/bastani-inc/atomic/issues/1327)).
- Fixed paused workflow run detail cards to surface the natural `workflow resume` action hint while preserving the interrupt hint for non-paused active runs ([#1283](https://github.com/bastani-inc/atomic/issues/1283)).
- Fixed paused workflow runs being counted as running and displayed as pending/running in `/workflow status` and `/workflow status <id>`, with paused runs now shown separately as `❚❚ paused` ([#1283](https://github.com/bastani-inc/atomic/issues/1283)).

## [0.8.28-alpha.1] - 2026-06-09

### Added

- Added workflow `ctx.ui.custom<T>(factory, options?)` for graph-visible custom TUI human-in-the-loop prompts. Custom prompts create `awaiting_input` prompt nodes, reuse the stage UI broker/attached stage chat component path, expose the same real TUI/theme/keybinding/component types as Atomic extension custom UI, participate in live-memory prompt replay through hashed custom identities, keep labels display-only/outside replay identity, honor prompt/run abort signals, and reject clearly in headless/unavailable UI modes. Iteration 1 supports inline graph rendering; `overlay: true` and non-TUI `workflow send` answers for arbitrary custom widget results return clear unsupported errors rather than silently degrading ([#1309](https://github.com/bastani-inc/atomic/issues/1309)).

### Changed

- Changed workflow transcript introspection to return `sessionFile`/`transcriptPath` metadata with a lazy-read prompt by default when a transcript path exists, while keeping bounded inline previews behind explicit `tail`/`limit` requests and falling back to a small preview when no path is available ([#1314](https://github.com/bastani-inc/atomic/issues/1314)).

### Fixed

- Fixed a workflow kill/abort race that could crash the entire CLI with a process-level uncaught exception (for example `No API key found for ...`). When a workflow was killed mid-prompt, the executor's `raceAbort` left the already-in-flight stage prompt promise unobserved; its later rejection escaped every workflow error boundary and became an unhandled rejection. `raceAbort` now always observes the in-flight promise in the already-aborted branch so a killed run can no longer orphan a rejecting prompt.

## [0.8.27] - 2026-06-08

### Changed

- Promoted the 0.8.27 prerelease package version to a stable release.

## [0.8.26] - 2026-06-08

### Changed

- Updated workflow-stage chat so `/compact` is the no-argument compaction command and `/context-compact` is no longer handled locally.
- Refined bundled workflow prompts to keep natural instructions inside meaningful XML sections while removing redundant wrapper noise.
- Upgraded builtin workflow fallback model tiers so degraded runs land on stronger models across `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` ([#1259](https://github.com/bastani-inc/atomic/issues/1259)).
- Changed the builtin `ralph` workflow to include the workflow current working directory in every stage prompt and to skip pull-request creation by default unless `create_pr=true`, omitting `pr_report` when disabled while keeping provider-aware PR/MR/review creation instructions in the final stage ([#1255](https://github.com/bastani-inc/atomic/issues/1255)).
- Updated the `research-codebase` skill to capture and carry a `breaking_changes_allowed` compatibility posture through research fanout and downstream research documents ([#1225](https://github.com/bastani-inc/atomic/issues/1225)).

### Fixed

- Fixed workflow custom-message renderers for inline forms and workflow run banners so persisted workflow messages no longer crash the host TUI with `child.render is not a function` on `/resume` ([#1236](https://github.com/bastani-inc/atomic/issues/1236)).
- Fixed the workflow input form so transient `/workflow <name>` argument selectors do not leak into model context and rehydrated stale input-form cards render nothing after `/resume`.
- Made stage sessions emit `session_shutdown` before `dispose()`, giving bound extensions graceful shutdown and preventing leaked child MCP servers or stale-context MCP initialization noise.
- Fixed stage-local workflow HIL `input` and `editor` prompts losing draft text across Ctrl+D detach/reattach; drafts are kept live-only in memory and cleared when the prompt or run/stage exits ([#1179](https://github.com/bastani-inc/atomic/issues/1179)).
- Fixed workflow worktree Git commands to strip ambient repository-local Git environment variables before inspecting or creating targeted worktrees.
- Suppressed intermediate model fallback failure warnings from successful workflow stages while preserving final failures and raw per-attempt diagnostics ([#1226](https://github.com/bastani-inc/atomic/issues/1226)).
- Fixed the workflow global tool-event hook ignoring unscoped parent-session prompts instead of attributing them to running stages, preventing false `awaiting_input` / "needs attention" states from unrelated `ask_user_question` calls ([#1261](https://github.com/bastani-inc/atomic/issues/1261)).
- Fixed the builtin `goal` and `ralph` workflows to fork looped worker/orchestrator-stage sessions from their matching prior iteration, preserving accumulated context while keeping reviewer stages independent ([#1275](https://github.com/bastani-inc/atomic/issues/1275)).
- Fixed workflow completion gates to rely on structured decision fields instead of manual text/regex heuristics in `goal` and `open-claude-design`.

## [0.8.26-alpha.11] - 2026-06-08

### Changed

- Published a synchronized Atomic 0.8.26-alpha.11 prerelease alongside the subagent codebase-agent tool restriction changes; no functional changes were made in the workflows extension.

## [0.8.26-alpha.10] - 2026-06-08

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.10 prerelease.

## [0.8.26-alpha.9] - 2026-06-07

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.9 prerelease.

## [0.8.26-alpha.8] - 2026-06-07

### Changed

- Updated workflow-stage chat so `/compact` is the no-argument compaction command and `/context-compact` is no longer handled locally.

## [0.8.26-alpha.7] - 2026-06-07

### Changed

- Refined bundled workflow prompts to keep natural instructions inside meaningful XML sections while removing redundant wrapper noise.

### Fixed

- Fixed the builtin `goal` and `ralph` workflows to fork looped worker/orchestrator-stage sessions from their matching prior iteration, preserving accumulated context while keeping reviewer stages independent ([#1275](https://github.com/bastani-inc/atomic/issues/1275)).
- Fixed workflow completion gates to rely on structured decision fields instead of manual text/regex heuristics in `goal` and `open-claude-design`.

## [0.8.26-alpha.6] - 2026-06-06

### Changed

- Bumped package version for the Atomic 0.8.26-alpha.6 prerelease.

## [0.8.26-alpha.5] - 2026-06-06

### Fixed

- Fixed the workflow global tool-event hook ignoring unscoped parent-session prompts instead of attributing them to running stages, preventing false `awaiting_input` / "needs attention" states from unrelated `ask_user_question` calls ([#1261](https://github.com/bastani-inc/atomic/issues/1261)).

## [0.8.26-alpha.4] - 2026-06-05

### Changed

- Upgraded builtin workflow fallback model tiers so degraded runs land on stronger models: bumped `github-copilot/claude-opus-4.8` fallbacks from `:medium` to `:xhigh` in `deep-research-codebase` and `ralph`, replaced `claude-sonnet-4-8`/`4.8` fallbacks with `claude-opus-4-8`/`4.8` in the `goal` and `ralph` runner configs, and raised `claude-sonnet-4-6`/`4.6` fallbacks from `:medium` to `:high` in `open-claude-design` ([#1259](https://github.com/bastani-inc/atomic/issues/1259)).

## [0.8.26-alpha.3] - 2026-06-05

### Changed

- Changed the builtin `ralph` workflow to include the workflow current working directory in every stage prompt so planner, implementation, simplification, review, and PR handoff stages keep repository work anchored to the workflow checkout.
- Changed the builtin `ralph` workflow to skip pull-request creation by default unless `create_pr=true`, omit `pr_report` when disabled, and keep provider-aware PR/MR/review creation instructions in the final stage ([#1255](https://github.com/bastani-inc/atomic/issues/1255)).

## [0.8.26-alpha.2] - 2026-06-05

### Changed

- Updated the `research-codebase` skill to capture a `breaking_changes_allowed` compatibility posture before research fanout, carry it through sub-agent prompts, and record it in research documents so downstream specs and workflows do not preserve legacy APIs by default when breaking changes are allowed ([#1225](https://github.com/bastani-inc/atomic/issues/1225)).

### Fixed

- Fixed stage-local workflow HIL `input` and `editor` prompts losing draft text across Ctrl+D detach/reattach; drafts are kept live-only in memory and cleared when the prompt or run/stage exits ([#1179](https://github.com/bastani-inc/atomic/issues/1179)).
- Fixed workflow worktree Git commands to strip ambient repository-local Git environment variables before inspecting or creating targeted worktrees.
- Suppressed intermediate model fallback failure warnings from successful workflow stages while preserving final failures and raw per-attempt diagnostics ([#1226](https://github.com/bastani-inc/atomic/issues/1226)).

## [0.8.26-alpha.1] - 2026-06-05

### Fixed

- Fixed the inline-form "snapshot lost" renderer and the `workflow.run.start`/`workflow.run.end` banner renderers returning bare strings, which crashed the host TUI with `child.render is not a function` when resuming a session containing persisted workflow custom messages. These renderers now return proper render components ([#1236](https://github.com/bastani-inc/atomic/issues/1236)).
- Fixed the workflow input form (the `/workflow <name>` argument selector) leaking into model context: spawning the picker and exiting without running the workflow no longer sends the form to the LLM. The input-form card is now emitted with `excludeFromContext` since it is transient UI, not conversation.
- Fixed the workflow input widget re-rendering in chat after `/resume`. Inline-form state is now cleared on `session_start`, and a rehydrated `workflows:input-form` card whose backing state is gone now renders nothing (returns `null`) instead of a stale form or "snapshot lost" placeholder.
- Stage sessions now emit `session_shutdown` before `dispose()` (mirroring the host `AgentSessionRuntime` teardown) so bound extensions receive a graceful shutdown signal instead of being silently invalidated. This stops disposed stage sessions from leaking child MCP servers and from triggering spurious stale-context "MCP initialization failed" errors when an extension's deferred `session_start` work races with stage disposal.

## [0.8.25] - 2026-06-04

### Changed

- Promoted the 0.8.25 prerelease package version to a stable release.

## [0.8.25-alpha.1] - 2026-06-04

### Fixed

- Fixed the interactive workflow inputs selector so it hides the working loader while replacing the editor, keeping the picker pinned to the bottom like `ask_user_question` without wedged host chrome ([#1224](https://github.com/bastani-inc/atomic/issues/1224)).

## [0.8.24] - 2026-06-04

### Changed

- Promoted the 0.8.24 prerelease package version to a stable release.

## [0.8.24-alpha.4] - 2026-06-04

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.4 prerelease.

## [0.8.24-alpha.3] - 2026-06-03

### Changed

- Bumped package version for the Atomic 0.8.24-alpha.3 prerelease.

## [0.8.24-alpha.2] - 2026-06-03

### Added

- The `@bastani/workflows` authoring SDK types are now externally resolvable in installed packages through `@bastani/atomic`'s new `./workflows` exports and ambient bridge, so workflow files type-check `import { defineWorkflow, Type } from "@bastani/workflows"` (and `@bastani/workflows/builtin/*`) under `tsc` (NodeNext) without a hand-authored `.d.ts`, `declare module` shim, or `paths` alias. Workflow packages declare `@bastani/atomic` and `typebox` as peer dependencies; the package continues to distribute raw TypeScript with no build step, and the runtime virtual-module loader is unchanged ([#1208](https://github.com/bastani-inc/atomic/issues/1208)).

### Fixed

- Fixed builtin (and any) workflows falling back to the user's currently selected model instead of the stage's defined model. A fully-qualified `provider/model` id that the live model catalog did not list was treated as a hard "not available" failure; because candidate validation throws on any failure and the catalog resolver catches that throw and collapses the whole ordered candidate list down to the user's `currentModel`, a single absent cross-provider fallback discarded the defined primary plus every fallback. Provider-qualified ids are now trusted (passed through with the reasoning suffix split off the last colon), mirroring the subagent resolver, so the defined primary is used and only genuinely failing candidates fall through at runtime. Regressed when bundled workflow model lists were refreshed onto newer multi-provider ids alongside suffix-first reasoning levels ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

## [0.8.24-alpha.1] - 2026-06-02

### Breaking Changes

- Removed the imperative `runWorkflow` object-form API from `@bastani/workflows`; workflow authors must export definitions produced by `defineWorkflow(...).compile()`, and forged `__piWorkflow: true` objects are rejected by discovery and composition.

### Added

- Added suffix-first workflow reasoning levels for `model` and `fallbackModels` entries such as `openai/gpt-5:high`, plus `WorkflowModelAttempt.reasoningLevel` metadata and optional `fallbackThinkingLevels` compatibility mapping ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

### Changed

- Changed bundled workflows to encode their existing reasoning levels directly on model and fallback model strings ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Documented the `model_name:thinking_effort` suffix syntax and `thinkingLevel` migration guidance in the workflows docs and package README ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).
- Adopted the new `-alpha.N` prerelease version convention (revision starting at 1), replacing the legacy numeric `-N` prerelease suffix in the release tooling (bump script, CI publish validation, and changelog parsing).
- Dropped the leading `v` from release git tags and `release/`/`prerelease/` branch names; the Publish CI now triggers on and validates bare version tags such as `0.8.24` or `0.8.24-alpha.1`.

### Deprecated

- Deprecated workflow `thinkingLevel` stage options in favor of per-candidate `:off|minimal|low|medium|high|xhigh` model suffixes; removal is deferred ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

### Fixed

- Made workflow reasoning-suffix parsing lenient so it no longer rejects legitimate colon-tagged model ids (for example OpenRouter `:free`/`:exacto` variants and Ollama `llama3:latest`); only canonical `:off|minimal|low|medium|high|xhigh` suffixes are stripped as reasoning levels, and unknown ids still surface the generic catalog "not available" error ([#1199](https://github.com/bastani-inc/atomic/issues/1199)).

## [0.8.23] - 2026-06-02

### Changed

- Promoted the 0.8.23 prerelease package version to a stable release.

## [0.8.23-0] - 2026-06-02

### Added

- Added a workflow node chat Ctrl+D hint that shares the bottom footer line with model/cwd metadata and appears in the bottom-right corner of stage-local ctx.ui widgets.

### Changed

- Changed bundled Goal and Ralph workflows to save reviewer feedback as JSON artifacts and hand only latest review artifact paths to downstream agents instead of injecting full review histories or session tails.
- Removed Ralph's separate `infra-locate-*`, `infra-analyze-*`, and `infra-patterns-*` discovery stages; Ralph reviewers now inspect repository infrastructure directly as needed during review.
- Documented artifact-path handoffs, `outputMode: "file-only"`, `reads`, and explicit `Read the file at <path>...` downstream prompts as the preferred pattern for large workflow context.
- Updated the workflow tool description to tell agents to hand off large stage context through files/artifacts instead of injected previous text.

### Fixed

- Fixed paused workflow stage chats so Ctrl+D returns to the orchestrator graph instead of closing back to the main chat.

## [0.8.22] - 2026-06-01

### Breaking Changes

- Migrated workflow contracts to TypeBox schemas and fully explicit outputs, removing legacy descriptor schemas, `.import(...)`, string-alias child workflow calls, parent-side output remapping, implicit `result`/`rawOutput`, and declaration-time `.humanInTheLoop(...)` metadata.

### Added

- Added TypeBox re-exports, TypeScript module-style child workflow composition, schema-validated child outputs, reusable builtin workflow modules, and flattened nested child workflow stages.

### Changed

- Raised the bundled deep-research workflow's default parallelism, renamed workflow runtime errors to `atomic-workflows:`, rendered workflow notices as compact TUI cards, flattened imported workflow graph boundaries, and expanded registered workflow-tool metadata.

### Fixed

- Fixed defaulted input validation, slow workflow discovery through the jiti loader, headless workflow shutdown and print-mode automation, builtin workflow initialization cycles, package-manifest workflow reloads, nested workflow widgets/graph cards, portable deep-research line counting, Codex fast-mode workflow markers, human-in-the-loop focus/answer behavior, background widget rendering, and deterministic headless command output.

## [0.8.22-0] - 2026-06-01

### Breaking Changes

- Migrated workflow input/output declarations to a TypeBox-native schema system, replacing the legacy `{ type, required, default, choices }` descriptor. Authors now declare inputs/outputs with TypeBox schemas (`.input("prompt", Type.String({ description }))`, `.input("count", Type.Number({ default: 2 }))`, `.input("flavor", Type.Union([Type.Literal("a"), Type.Literal("b")]))`, `.output("packet", Type.Object({ topic: Type.String(), score: Type.Number() }))`). `ctx.inputs`, the `.run()` return, and `ctx.workflow(child).outputs` are precisely typed via `Static<>`, and the runtime validates inputs and outputs with TypeBox `Value`. `Type` is re-exported from `@bastani/workflows` (with types `Static` and `TSchema`) so workflow authors single-import. An optional field is declared with `Type.Optional(...)`; a `default` keeps the key required at the type level. This is a clean break with no legacy descriptor support.
- Removed the unshipped `.import(...)` workflow builder API and string-alias child workflow calls. Workflows now compose children by importing compiled workflow definitions with TypeScript imports and passing those definitions directly to `ctx.workflow(workflowDefinition, options)`.
- Removed parent-side child output selection/renaming from `ctx.workflow(...)`. Parent workflows now receive the child's declared `.output(...)` contract as `child.outputs`.
- Made workflow outputs fully explicit so a workflow's input/output contract is the stable, self-documenting surface other workflows compose against. A workflow now exposes exactly the outputs it declares with `.output(...)`, and a `.run()` return that contains a key the workflow did not declare fails the run with `atomic-workflows: ... returned undeclared output "<key>"`. The implicit string `result` output and the `child.rawOutput` escape hatch were removed: declare `.output("result", schema)` and return `{ result }` if you want a `result` output, and declare every other field a parent should read.
- Changed default transcript inspection from inlining about 50 recent entries to a reference-first 5-entry preview with `sessionFile`/`transcriptPath`; pass explicit `tail` or `limit` to override the preview size.
- Removed the obsolete `.humanInTheLoop(...)` workflow builder API and its declaration-time interaction metadata; workflows should use runtime `ctx.ui.*` calls directly when they need human input.

### Added

- Added TypeBox as the workflow schema engine and re-exported `Type` (plus the `Static` and `TSchema` types) from the `@bastani/workflows` public entry point so authors single-import the authoring surface.
- Added TypeScript module-style workflow composition: parent workflows can pass compiled child workflow definitions directly to `ctx.workflow(compiledWorkflow, options)`. The bundled `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows are reusable from `@bastani/workflows/builtin` or individual builtin module paths.
- Added first-class workflow composition: child workflows can declare `.output()` contracts, and `ctx.workflow()` runs compiled child workflow definitions as nested runs with input validation, schema-validated declared outputs, and the nested workflow's stages flattened inline into the parent graph ([#1071](https://github.com/bastani-inc/atomic/issues/1071)).

### Removed

- Removed the `zod` dependency from `@bastani/workflows`; JSON-serializable validation and input/output validation now run on TypeBox `Value`.

### Changed

- Raised the bundled `deep-research-codebase` default `max_concurrency` from 4 to 100 so partitioned research stages fan out in parallel by default; lower it via the `max_concurrency` input on rate-limited or cost-sensitive setups (with `max_partitions` up to 100 and one locator/pattern-finder/analyzer/online-researcher specialist per partition, a single run can otherwise spawn many concurrent stage sessions).
- Declared explicit output contracts for the bundled `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design` workflows so parent workflows receive schema-validated child outputs.
- Renamed workflow runtime error prefixes from `pi-workflows:` to `atomic-workflows:`.
- Render workflow stage notices, lifecycle notices, and HiL answer notices as compact emoji-free TUI cards instead of plain wrapped rows, matching the debugger warning card treatment.
- Flatten imported workflows in the expanded run graph so a `ctx.workflow()` import reads as a single flat layout: the child run's stages stand in for the import instead of rendering an extra boundary "information" node above them. The boundary's incoming dependencies become the child roots' dependencies and downstream stages rewire to the child's terminal stages, so a depth-1 composition of single-stage leaves now shows one node per import instead of two. A boundary whose child run produced no stages of its own is still kept as a single node so the import stays visible. Affects the graph overlay, session list, `status` stage counts/details, and attach resolution alike.
- Updated the registered `workflow` tool description so agent-facing metadata covers named and direct runs, discovery, inspection, prompt answering/steering, run control, and reload ([#1151](https://github.com/bastani-inc/atomic/issues/1151)).

### Fixed

- Fixed the programmatic named-workflow runner (`runWorkflow`) to resolve declared input defaults before validating, so an input declared with both `required: true` and a `default` is no longer rejected as missing when omitted, matching the resolve-then-validate order used by the other dispatch paths.
- Fixed slow workflow discovery outside the compiled binary by always resolving the `@bastani/workflows` SDK (and its builtin submodules) to in-memory virtual modules in the jiti loader instead of aliasing to the on-disk package. The alias path re-evaluated the entire SDK module graph once per workflow file (the loader keeps `moduleCache: false` so edits stay observable), so projects with many workflow files saw multi-second discovery and timing-sensitive workflow tests flaked at the default test timeout; workflow files are still evaluated fresh from disk, so `/workflow reload` keeps observing edits.
- Fixed headless workflow shutdown so completed stage chat handles are disposed on CLI quit, allowing successful non-interactive `/workflow` runs to return to the shell prompt ([#1167](https://github.com/bastani-inc/atomic/issues/1167)).
- Fixed bundled workflow modules so they import the leaf `defineWorkflow` authoring API instead of the public package entrypoint, avoiding an ESM initialization cycle during builtin workflow discovery.
- Fixed workflow HIL prompts so awaiting-input and answered-prompt notices no longer wake the main chat agent, answer notices stay out of LLM context and explicitly forbid auto-answering later HIL prompts, and stale Enter input from graph/connect focus transitions is quarantined when prompts appear after the attach pane is already open, covering input, confirm, select, and editor prompts ([#1163](https://github.com/bastani-inc/atomic/issues/1163)).
- Fixed workflow run widgets so store changes and elapsed-time ticks repaint through a long-lived reactive widget instead of waiting for unrelated chat input or remounting the widget ([#1150](https://github.com/bastani-inc/atomic/issues/1150)).
- Fixed `/workflow reload` and `workflow({ action: "reload" })` so newly added package-manifest workflow entries are rediscovered in-process without requiring top-level `/reload` or restart ([#1155](https://github.com/bastani-inc/atomic/issues/1155)).
- Fixed completed child workflow boundary stages rendering as empty graph nodes by showing the child workflow name, child run id prefix, and output count in the node card.
- Fixed the background workflow widget (`BACKGROUND` panel) listing nested `ctx.workflow()` child runs as separate top-level entries, so a two-level composition no longer shows the root, parent, and child runs as three separate items with an inflated `N runs` count. The widget now applies the same top-level visibility rule (`run.parentRunId === undefined`) already used by `statusRuns`, the `status` action, and the `/workflow connect` session picker. The "needs attention" (awaiting HiL input) badge still fires for a hidden nested descendant by attributing its awaiting state to the visible top-level ancestor via `rootRunId`, so a HiL prompt waiting inside an imported child workflow stays discoverable.
- Fixed the bundled deep-research workflow line-count heuristic hanging Windows CI by replacing its POSIX `wc` subprocess with portable in-process line counting.
- Kept workflow stage model metadata as the raw model id while surfacing Codex fast mode as a separate visible `fast` marker on workflow node cards, including stages that use the default Atomic SDK adapter settings manager.
- Show workflow Codex fast-mode metadata on running workflow nodes as soon as the stage session starts, including explicit-model stages, catalog-resolved bare model aliases, and custom resource-loader stages whose settings manager is created by the Atomic SDK.
- Kept workflow Codex fast-mode markers synchronized across fallback attempts: running nodes now update when fallback switches to a fast-eligible model, completed nodes clear stale `fast` markers when fallback finishes on a non-eligible model, and prompt-adapter stages no longer create SDK sessions only to compute fast metadata.
- Made successful headless `/workflow` informational commands emit displayable command output instead of dropping success messages through the no-op non-interactive UI reporter, made degraded terminal-detail fallback rendering avoid fabricating successful status for unknown run states, and preserved non-interactive execution policy when resuming failed workflow runs ([#1123](https://github.com/bastani-inc/atomic/issues/1123)).
- Suppressed workflow lifecycle steer notices while awaited non-interactive workflow dispatch is already waiting for terminal completion, and made workflow chat-surface custom-message content printable by default for headless list/status/detail/dispatch/killed output ([#1123](https://github.com/bastani-inc/atomic/issues/1123)).
- Re-enabled deterministic non-interactive workflow execution: headless sessions keep the `workflow` tool, `/workflow <name> key=value` skips interactive pickers, named workflow dispatch waits for the terminal run snapshot, declared human-in-the-loop workflows are rejected, top-level `ctx.ui.*` is unavailable, and non-interactive stage sessions exclude `ask_user_question` without binding broker-backed extension UI ([#1123](https://github.com/bastani-inc/atomic/issues/1123)).
- Added a concise display-only `User responded with: ...` workflow HiL answer notice so the main chat transcript records the answer for user-visible audit without triggering an autonomous model turn or adding the notice to LLM context ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Suppressed workflow HiL answer interrupt notices for prompts answered by the main-chat `workflow` tool, so tool-driven answers do not dismiss the current main-chat turn with workflow-chat wording ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Hardened workflow awaiting-input lifecycle notices and readiness-gate answers: awaiting-input lifecycle states now emit main-chat steer notices for dedupe-aware model visibility while preserving the existing `/workflow connect` and `workflow send` response hints, readiness gates use unique prompt ids per gate instance, and duplicate/raced `workflow send` answers for a just-resolved brokered input request now report the request as already answered instead of falling through to `No matching pending prompt` ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Prevented Enter used for `/workflow connect`, graph attach, direct stage attach, unrelated graph-node inspection, or transition key-repeat from immediately submitting workflow HIL prompts; prompt submission now requires the user to be past the attach transition and press Enter while the specific prompted node is attached, leaving sibling HIL prompts pending ([#1148](https://github.com/bastani-inc/atomic/issues/1148)).
- Fixed completed human-in-the-loop prompt archives so reattached read-only prompt nodes keep their prompt card scrollable with keyboard and mouse-wheel input ([#1140](https://github.com/bastani-inc/atomic/issues/1140)).
- Kept the workflow graph overlay navigable while a stage-local human-input prompt is awaiting a response: graph navigation, the stage switcher, Ctrl+D detach, and mouse-wheel scrolling now stay owned by graph mode until the user explicitly attaches to the prompted stage ([#1141](https://github.com/bastani-inc/atomic/issues/1141)).
- Preserved literal slash text entry in legacy run-level workflow prompt cards, so paths and URLs such as `/tmp/file` remain typable while the prompt owns input ([#1141](https://github.com/bastani-inc/atomic/issues/1141)).
- Cleared brokered stage HIL UI during terminal stage cleanup so a completed workflow does not leave an active `ask_user_question`/custom prompt card visible after detach ([#1141](https://github.com/bastani-inc/atomic/issues/1141)).
- Fixed workflow HIL select/editor prompts so navigation, scroll input, and ambiguous Escape-prefix input cannot advance prompts before an explicit configured confirm/Enter submit or Ctrl+C skip. Graph-mode prompt cards now honor custom select keybindings, and Enter submitted during connect/attach/detach transitions is time-boxed so key repeat cannot attach or answer the next prompt accidentally ([#1148](https://github.com/bastani-inc/atomic/issues/1148)).
- Preserved synthetic workflow HiL prompt nodes as `awaiting_input` when an unrelated main-chat `ask_user_question` result arrives, so choosing to leave a workflow prompt open no longer makes the orchestrator node look like it resumed while the prompt is still unanswered ([#1137](https://github.com/bastani-inc/atomic/issues/1137)).
- Fixed headless `/workflow <name>` print-mode automation so successful non-interactive runs wait for terminal snapshots and emit printable run-detail summaries, while terminal failures surface as command-visible errors instead of silent zero-output successes ([#1156](https://github.com/bastani-inc/atomic/issues/1156)).

## [0.8.21] - 2026-05-30

### Changed

- Promoted the 0.8.21 prerelease changes to a stable release.

## [0.8.21-0] - 2026-05-30

### Added

- Enabled the `/workflow send` action (with `delivery: "answer"`) to answer a stage's brokered structured prompts — an in-stage `ask_user_question` call or the deterministic readiness gate — without the interactive TUI/graph overlay. These prompts resolve through the `StageUiBroker` (`ctx.ui.custom`) rather than the simple `store.pendingPrompt` model, so `send` previously no-op'd ("No pending prompt to answer") and they could only be answered by attaching the graph viewer. The stage UI broker now carries an optional headless-answer adapter (`provideStagePrompt` / `peekStagePrompt` / `answerStagePrompt` / `clearStagePrompt`), keyed by `(runId, stageId)`, that maps a simple answer — a free-text reply, an option label, a 1-based option index, comma-separated labels for multi-select, or a pre-built `response` — into the `QuestionnaireResult` the tool expects. The executor's existing `ask_user_question` watcher captures the tool-call `args` to build the adapter, and the readiness gate registers one statically; both surface a serializable `inputRequest` descriptor on the stage snapshot (shown in `/workflow stage` / `stages` output) so an orchestrating agent can see the questions/options and answer them programmatically.
- Added a deterministic readiness gate after `ask_user_question` tool calls inside workflow stages. When a stage's model turn issues an `ask_user_question` call, the workflow re-uses the structured `ask_user_question` UI — rendered inline in the attached stage chat via the stage UI broker — to ask "Are you ready to move on to the next stage?" (Yes/No) before completing/advancing the stage. Answering **No** (or "Chat about this"/cancel) steers the stage with a continuation message so the conversation keeps going, then re-shows the gate after the next turn, repeating until **Yes**; **Yes** resumes normal sequential and dependent-parallel progression. Detection is independent of how the underlying UI is implemented, and the executor exposes a `confirmStageReadiness` seam so the gate is fully testable. `@bastani/atomic` now also exports `createAskUserQuestionToolDefinition` so first-party extensions can invoke the structured prompt deterministically ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).

### Fixed

- Fixed background workflow HIL prompt nodes becoming input-dead when they appeared while the orchestrator graph overlay was already open: the visible overlay now reclaims focus on awaiting-input store updates, and the graph auto-focuses newly awaiting prompt nodes so Enter attaches directly to the HIL response UI.
- Fixed the `/workflow status <id>` run-detail card still ticking (and flickering the whole screen) even after the chat-surface clock was frozen: a running stage's in-flight tool-activity label (e.g. `bash · 6s`) was computed inside `stageActivityString()` from a fresh `Date.now()`, bypassing the capture-once `now` that `renderRunDetail` threads everywhere else. While a background workflow ran, the below-editor companion widget drove a full re-render roughly once per second (and on every store mutation); each re-render advanced that label, and once the detail card had scrolled above the viewport fold pi-tui took the full-screen-clear path (CSI 2J + CSI H + CSI 3J), read as whole-page + chat-box flicker. `stageActivityString()` now uses the threaded `now`, so scrollback run-detail cards are byte-stable across re-renders (the companion widget still owns the live, ticking view).
- Fixed the `/workflow status` and `/workflow status <id>` chat-surface cards triggering a full-screen redraw (clear + scrollback wipe) every render tick once they scroll above the viewport fold. Their custom-message renderer's `render()` lambda re-runs on every TUI frame (pi-tui fans out to every child each `doRender`, and the live workflow/subagent widgets request a frame ~12×/sec while runs are active), and it called `renderStatusList` / `renderRunDetail` without a captured clock, so they fell through to `Date.now()` each frame and ticked the `elapsed` / `running` labels — and pi-tui full-clears the screen (CSI 2J + CSI H + CSI 3J) whenever a changed line sits above the fold, read as whole-screen flicker on terminals without synchronized output (e.g. mosh). The renderer now captures wall-clock once when the chat entry's component is created and threads it through to the status/detail renderers, so these point-in-time scrollback snapshots stay byte-stable across re-renders (the live widget still owns live state). Mirrors the earlier tool-result status-card fix.
- Fixed answering a stage's brokered structured prompt (an in-stage `ask_user_question` or the readiness gate) via `/workflow send` replying **"User declined to answer questions"** and leaving the stage stuck `running` with no pending input — even though a real answer was sent. A structured `response` was forwarded verbatim to the `ask_user_question` tool: a JSON-encoded string was captured as raw free text, and — most damagingly — any object with an `answers` array (e.g. the orchestrator-friendly `{ answers: [{ question, answer }] }`) was treated as a pre-built `QuestionnaireResult` despite lacking the numeric `questionIndex` the tool envelope requires, so it matched no question segment and declined. `coerceStageInputAnswer` now forwards `raw` ONLY for a fully-formed result (every answer carries a numeric `questionIndex`); every other shape — JSON strings, `answers[]`/`questions[]` entries, flat `{ answer | label | selected }`, string arrays — is normalized to a label/index/multi-select value that the stage prompt adapter resolves against the question's options (assigning the correct `questionIndex`). The readiness decision (`readinessResultMeansAdvance`) matches the advance option case/whitespace-insensitively and via `selected[]`. A new regression test drives the real `StageUiBroker` + `ask_user_question` tool resolution path (the seam the earlier unit tests missed) and reproduces the decline for the `answers[]`-without-`questionIndex` payload. The "keep exploring"/stay path is unchanged ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Hardened the `/workflow` tool-result renderer against missing or unshaped payloads. `renderResult` is passed `result.details`, which can be absent during streaming/partial renders or on error paths, and previously dereferenced a missing `action` and crashed the TUI render loop. It now degrades gracefully (renders nothing for partials, a generic notice otherwise) ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Made `terminate: true` tool results deterministic when deriving a stage/task's result text: when an agent turn ends on a terminating tool, the stage runner now returns that tool result's output instead of any prose the model emitted before the tool call. This fixes the `goal` and `ralph` review gates, whose terminating `review_decision` structured-output tool emits clean JSON — previously the preceding assistant narration was captured instead, so the strict `JSON.parse` failed and a valid verdict was misclassified as a reviewer failure ("returned invalid structured JSON"), blocking quorum and forcing extra turns ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Tightened terminating-tool result detection when deriving a stage/task's result text. The stage runner now treats a trailing tool result as the deterministic turn output ONLY when that tool call actually returned `terminate: true` — tracked at runtime from the session's `tool_execution_end` events, since the tool-result message itself does not carry the flag — instead of whenever the last conversational message merely happened to be a tool result. A turn that ends on a non-terminating tool result (e.g. aborted or interrupted right after a tool call) now correctly falls back to the last assistant message, and that fallback no longer surfaces non-terminating tool output. Verified end-to-end against real `terminate: true`, `terminate: false`, and no-tool stages ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).
- Fixed a mid-turn `ask_user_question` (or readiness gate) rendering but being input-dead in the attached stage chat. After a readiness-gate "stay" returns to the composer and the user submits another message, the agent's next question mounts while host keyboard focus has drifted off the overlay; the focus re-assertion was suppressed during streaming (a blunt guard added to avoid a prior continuation stall), so arrows/Enter were ignored and nothing could be answered or sent to the model. The overlay's `requestFocus` is now idempotent — it grabs focus only when the overlay does not already own it (`isFocused()`), so the redundant `focus()` that stalled the stream never runs. The stage chat now requests focus whenever a custom UI is shown (including mid-turn) and the focus-hold timer keeps a mounted question focused, trusting `requestFocus` to no-op when unnecessary ([#1120](https://github.com/bastani-inc/atomic/issues/1120)).
- Detaching or closing the attached stage chat (Ctrl+D / Ctrl+C) while a stage has a pending human-input request — an agent `ask_user_question` call or the readiness gate — no longer cancels that request. Previously, tearing down the chat view (or its stage UI broker host) rejected the pending prompt, so the stage silently dropped out of `awaiting_input` and the question disappeared. Detaching, closing, and disposing now only stop *displaying* the request: it stays pending (the stage remains `awaiting_input`) and is re-displayed when a host re-attaches. A pending request is settled only by the user answering (broker resolve) or the run aborting via its `AbortSignal` — the single chokepoints for ending a human-input request ([#1099](https://github.com/bastani-inc/atomic/issues/1099)).

## [0.8.20] - 2026-05-29

### Changed

- Promoted the 0.8.20 prerelease changes to a stable release.

## [0.8.20-0] - 2026-05-29

### Added

- Added main-chat lifecycle steer notices for workflow completion, failure, and awaiting-input pauses with global notification config controls ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).

### Fixed

- Fixed the background-workflow companion counter widget flickering every second while a run is active by updating a single long-lived above-editor widget in place instead of disposing and re-mounting a fresh widget factory on each elapsed-clock tick ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Fixed workflow lifecycle completion/failure/awaiting-input notices crashing the TUI on narrow or freshly-resized terminals: the notice component now wraps to the render width (hard-breaking long run ids) instead of emitting a single fixed line, which pi-tui rejects with a hard "Rendered line exceeds terminal width" throw ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Fixed the workflow companion counter widget triggering a full-screen redraw (clear + scrollback wipe) on every elapsed-clock tick after the terminal is resized while a run is active. The widget now mounts `belowEditor` instead of `aboveEditor`, keeping its live clock line within the bottom viewport; pi-tui full-clears the screen whenever a changed line sits above the viewport fold, and an above-editor widget was pushed above the fold once the editor/status region grew tall ([#1109](https://github.com/bastani-inc/atomic/issues/1109)).
- Disabled workflows in non-interactive (`-p` / `--print` / `--mode json`) sessions, which bind a no-op UI surface and cannot drive workflow prompts, pickers, or the graph overlay: the `workflow` tool is removed from the model's active tool set at session start, and the `/workflow` command (reachable via `atomic -p "/workflow …"`) is refused — preventing headless runs from stalling on work that can never complete ([#1096](https://github.com/bastani-inc/atomic/issues/1096)).
- Escaped workflow lifecycle notice text and structured response hints, isolated lifecycle send failures from store subscribers, and rejected empty lifecycle notification event lists ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).
- Fixed stage awaiting-input lifecycle notice dedupe so promptless pauses after resolved prompts are not suppressed by historical prompt metadata ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).
- Reset workflow lifecycle-notification dedupe state at chat session boundaries so reused workflow run IDs in later sessions still emit completion/failure/input notices ([#1085](https://github.com/bastani-inc/atomic/issues/1085)).
- Warn before starting or resuming another session when workflows are still in flight, allowing users to cancel before those runs are killed and current-session workflow history is cleared ([#1082](https://github.com/bastani-inc/atomic/issues/1082)).
- Prevented workflow stage sessions from exposing or executing the `workflow` tool while preserving stage-level subagent delegation.
- Retained completed, failed, and killed workflow runs in user-facing status/connect surfaces and changed workflow kill controls to mark runs killed without removing them from live inspection history ([#1083](https://github.com/bastani-inc/atomic/issues/1083)).

## [0.8.18] - 2026-05-27

### Changed

- Promoted the 0.8.18 prerelease changes to a stable release.

## [0.8.18-0] - 2026-05-27

### Added

- Added Ralph `git_worktree_dir` support for running stages from an optional Git worktree, reusing/sharing existing worktrees from the invoking repository as-is and leaving worktrees in place for retries.

### Changed

- Replaced regex-based workflow discovery stage validation with runtime empty-graph validation based on actual stage creation while keeping discovery side-effect-free.
- Threaded named workflow invocation cwd into workflow run contexts so workflow-owned artifacts can use the explicit runner cwd.
- Split worker project-initialization preflight guidance from Goal receipt/reporting instructions.

### Fixed

- Defaulted workflow `ctx.cwd` to the reusable worktree cwd when `worktreeFromInputs` resolves a `gitWorktreeDir`, so workflow-owned artifacts such as Ralph specs are written inside the worktree unless explicitly overridden.
- Avoided blank deep-research display paths when a displayed artifact path equals the workflow invocation directory.
- Distinguished Ralph same-repository worktree classification and canonicalization failures from definitely non-Git existing `git_worktree_dir` paths.
- Updated Ralph to revise a stable original spec file across planner iterations and clarified `git_worktree_dir` null-byte diagnostics.

## [0.8.17] - 2026-05-26

### Changed

- Promoted the 0.8.17 prerelease changes to a stable release.

## [0.8.17-0] - 2026-05-26

### Breaking Changes

- Removed Ralph's configurable `review_quorum` and `blocker_threshold` inputs; `max_turns` remains configurable while reviewer quorum and blocker threshold use fixed controller defaults ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

### Changed

- Aligned Ralph's goal-continuation prompt more closely with Codex `/goal` hidden continuation guidance, including current-state evidence, non-shrinking scope, fidelity, completion audit, and strict blocked audit language ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).
- Restored Ralph's stronger historical review gate prompt and `review_decision` schema with findings, oracle satisfaction, receipt assessment, verification remaining, and reviewer-error guard fields.

## [0.8.16] - 2026-05-26

### Changed

- Promoted the 0.8.16 prerelease changes to a stable release.

## [0.8.16-0] - 2026-05-26

### Breaking Changes

- Removed Ralph's `prompt` and `max_loops` compatibility inputs; use the canonical `objective` and `max_turns` inputs instead ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

### Changed

- Reworked Ralph into a Goal Runner workflow with a persisted goal ledger, bounded worker turns, parallel structured reviewers, reviewer-quorum completion, repeated-blocker gating, and final status reporting while excluding token-budget behavior ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

### Fixed

- Hardened Ralph's goal-runner edge cases around base-branch sanitization coverage, worker/reviewer failure handling, cross-turn review context, bounded blocker-threshold handling, and unused ledger state ([#1061](https://github.com/bastani-inc/atomic/issues/1061)).

## [0.8.15] - 2026-05-26

### Breaking Changes

- Changed workflow human-in-the-loop prompts (`ctx.ui.input`, `ctx.ui.confirm`, `ctx.ui.select`, and `ctx.ui.editor`) to render as synthetic graph stages with `awaiting_input` status; consumers should handle the new `StageSnapshot.promptAnswerState` metadata and avoid caching `StageSnapshot.parentIds` references across store updates ([#1046](https://github.com/bastani-inc/atomic/issues/1046)).
- Changed `ctx.ui.select(..., [])` to throw `pi-workflows: ctx.ui.select requires at least one option` before creating a prompt node instead of returning an empty string ([#1046](https://github.com/bastani-inc/atomic/issues/1046)).

### Added

- Added workflow tool stage introspection and control actions (`stages`, `stage`, `transcript`, `send`, `pause`, and `reload`) for inspecting stage state, reading transcripts, answering prompts, controlling live stages, pausing runs, and reloading workflow resources ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Added live-memory prompt answer replay for workflow continuations using snapshot-safe `promptAnswerState` markers and a private `PromptAnswerRecord` ledger that is excluded from snapshots and persistence ([#1046](https://github.com/bastani-inc/atomic/issues/1046)).

### Changed

- Updated Ralph around an autonomous goal contract so planner, implementation, and reviewer/auditor stages infer verifiable criteria, require receipts, and judge completion against the verification oracle instead of document completeness alone ([#1053](https://github.com/bastani-inc/atomic/issues/1053)).
- Updated Ralph's orchestrator prompt to discover project initialization needs from repository evidence before implementation work proceeds ([#1048](https://github.com/bastani-inc/atomic/issues/1048)).
- Added a final Ralph PR-preparation phase that reviews changes against the configured base branch, tries available GitHub credentials using local git identity as a hint, posts implementation notes as a PR comment, and creates a pull request when possible.
- Updated Ralph to persist planner goal contracts and implementation notes as OS-temp workflow artifacts, and pass file paths rather than full plan text to later stages ([#1037](https://github.com/bastani-inc/atomic/issues/1037)).
- Updated `deep-research-codebase` output layout to write public reports under `research/` and hidden per-run handoff artifacts under `research/.deep-research-<run-id>/`.

### Fixed

- Returned the workflow overlay to the graph orchestrator after answering or skipping a `ctx.ui` prompt node, and preserved the prompt's question footprint for read-only prompt-node views.
- Removed biasing stage-output and iteration-count context from Ralph reviewer prompts while making the comparison base branch explicit ([#1037](https://github.com/bastani-inc/atomic/issues/1037)).
- Ordered snapshot transcript fallback entries chronologically before applying `tail`/`limit`, preserving terminal result/error entries after tools for missing or tied timestamps ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Reloaded workflow resources directly for `workflow({ action: "reload" })` instead of queuing a literal `/workflow reload` follow-up ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Kept pending prompts unresolved when `workflow({ action: "send" })` omits `text`, `response`, and `message`, while preserving explicit empty-string answers ([#1023](https://github.com/bastani-inc/atomic/issues/1023)).
- Included `deep-research-codebase` discovery-stage handoff files in the persisted run manifest.
- Persisted `deep-research-codebase` final reports as dated Markdown research docs while retaining file-only handoffs for bounded aggregation.
- Prevented `deep-research-codebase` aggregation from inlining large specialist transcripts by using file-only handoff artifacts ([#1016](https://github.com/bastani-inc/atomic/issues/1016)).
- Removed model metadata from workflow node cards while retaining fallback dependency metadata ([#1011](https://github.com/bastani-inc/atomic/issues/1011)).
- Preserve the selected workflow switcher row highlight through truncation ellipses on long stage names.

## [0.0.1] — 2026-05-15

### Added

- Initial release of `@bastani/workflows`, a raw TypeScript pi package for multi-stage workflow authoring and execution.
- pi extension entry point at `src/extension/index.ts` registered through the package `pi` manifest.
- Public authoring API with `defineWorkflow`, `createRegistry`, workflow identity helpers, and programmatic workflow runners.
- `workflow` LLM tool and `/workflow` slash command surface for listing, inspecting, running, interrupting, and resuming workflows.
- Background workflow execution with persisted run/stage state, status rendering, cancellation, pause/resume support, and HIL prompt routing.
- TUI surfaces for live workflow progress, graph overlays, run details, stage chat, input collection, and status widgets.
- Workflow discovery from bundled workflows, project-local `.atomic/workflows/`, user-global `~/.atomic/agent/workflows/`, and configured workflow directories.
- Built-in workflows: `deep-research-codebase`, `open-claude-design`, and `ralph`.
- Optional runtime integrations with companion pi packages including `pi-subagents`, `pi-mcp-adapter`, `pi-intercom`, and `pi-web-access`.
- Bundled skills, agents, themes, examples, and documentation for authoring and operating workflows.
