1 RUNTIME DEFECT FOUND (FIXED)

## 1. Agent definitions load — PASS

Command: `bun /tmp/prompt-runtime-proof.ts` (full capture: `/tmp/prompt-runtime-proof-after-fix.log`). This directly called `loadAgentsFromDir` (`packages/subagents/src/agents/agent-loaders.ts:51-147`) and compared each returned `systemPrompt` byte-for-byte with the body returned by `parseFrontmatter` for its on-disk `filePath`. All nine bodies matched; the log also records each first/last 200 characters and complete fallback list.

| Agent | Model | Fallbacks | Result |
|---|---|---:|---|
| code-simplifier | openai-codex/gpt-5.6-sol:medium | 21 | PASS |
| codebase-analyzer | openai-codex/gpt-5.6-sol:medium | 21 | PASS |
| codebase-locator | openai-codex/gpt-5.6-terra:high | 18 | PASS |
| codebase-online-researcher | openai-codex/gpt-5.6-sol:medium | 21 | PASS |
| codebase-pattern-finder | openai-codex/gpt-5.6-terra:high | 18 | PASS |
| codebase-research-analyzer | openai-codex/gpt-5.6-sol:medium | 21 | PASS |
| codebase-research-locator | openai-codex/gpt-5.6-terra:high | 18 | PASS |
| debugger | openai-codex/gpt-5.6-sol:xhigh | 26 | PASS |
| worker | openai-codex/gpt-5.6-sol:medium | 21 | PASS |

## 2. Chain template substitution — PASS

The same script drove the production `resolveOutputReferences` path (`packages/subagents/src/runs/shared/chain-outputs.ts:70-78`) and then the `{task}`, `{previous}`, and `{chain_dir}` replacements used by `chain-execution-sequential-step.ts:68-71`. All seven templates passed: no `{previous}`, `{outputs.*}`, or `undefined` survived. `parallel-context-build.md` resolved `requestScope`, `codebasePatterns`, and `validationRisks`; `parallel-handoff-plan.md` resolved `externalReference`, `localContext`, and `implementationStrategy`. Complete rendered evidence is `/tmp/rendered/chain-parallel-context-build.md` and `/tmp/rendered/chain-parallel-handoff-plan.md`; the logged excerpts show `OUTPUT_REQUESTSCOPE`/`OUTPUT_EXTERNALREFERENCE` and `PREVIOUS_OUTPUT` in place.

## 3. Workflow render helpers — PASS AFTER FIX

Command: `bun /tmp/prompt-runtime-proof.ts`. It rendered 30 outputs: every requested Goal/Ralph/shared renderer and all renderers in the six pattern prompt modules. Exact outputs are under `/tmp/rendered/*.txt`. Inspection found no unresolved supported placeholder, `undefined`, `[object Object]`, `NaN`, empty XML/Markdown section, or run of more than two blank lines. Both reviewer outputs contain `stop_review_loop` plus distinctive composed text: `Literal objective contract:`, `Convergence flag (stop_review_loop):`, and `Code delta integrity:`. The only literal `null` strings are deliberate review-schema instructions (nullable priority and `reviewer_error`), not interpolation artifacts; no argument rendered as null.

The initial render exposed a real defect: `renderReviewerPrompt` accepted `args.objective` but never rendered it (`artifactStart=-1`). I fixed the smallest source location, `packages/workflows/builtin/goal-prompts.ts:153`, by adding `Run objective: ${args.objective}` to the receipts section. Re-rendered query-last offsets now prove ordering: Goal long artifact `26..3064`, final instruction `21300`; Ralph long artifact `78..3116`, final instruction `20637` (`/tmp/rendered/goal_reviewer.txt`, `/tmp/rendered/ralph_reviewer.txt`).

Validation after the fix: `bun run typecheck` passed; `bun test test/unit/builtin-workflows-goal-01.test.ts test/unit/builtin-workflows-goal-02.test.ts test/unit/builtin-workflows-goal-03.test.ts` passed 25/25. An earlier accidentally broad `bun test` invocation timed out after 120 seconds while its displayed tests were passing; it is not claimed as a completed suite.

## 4. Live agent execution — PASS

Source CLI command was launched in isolated tmux session `task-w-live-json` using `bun packages/coding-agent/src/cli.ts --approve --no-session --mode json ...`; capture: `/tmp/task-w-live-json-pane.txt`. The pane records `toolName:"subagent"`, run `e23c210c`, `agent:"codebase-locator"`, status `completed`, and output `/tmp/atomic-subagents-uid-501/artifacts/e23c210c_codebase-locator_0_output.md`. Captured report excerpt:

> `## File Locations for Goal Workflow Reviewer Stage`
> `### Implementation Files`
> `- packages/workflows/builtin/goal-runner.ts`
> `- packages/workflows/builtin/goal-prompts.ts`
> `### Test Files` … `### Configuration` … `### Type Definitions` … `### Documentation and Examples` … `### Entry Points`

This follows the rewritten agent Output contract and correctly locates the reviewer batch, prompts, review/reducer logic, tests, schemas/types, documentation, and entry points. Nothing else remains unverified within the requested runtime scope.
