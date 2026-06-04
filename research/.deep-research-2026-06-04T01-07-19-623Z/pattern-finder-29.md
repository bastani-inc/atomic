## 1. Established patterns

- **Builtin workflows are a small, curated set with a shared manifest.**  
  `packages/workflows/builtin/index.ts` re-exports exactly the builtin workflows: `deepResearchCodebase`, `goal`, `ralph`, `openClaudeDesign`.

- **Each builtin is authored with the same workflow DSL shape.**  
  All four use `defineWorkflow("...")` from `packages/workflows/src/workflows/define-workflow.ts`, then declare `.input(...)`, `.output(...)`, and `.run(...)`.

- **Orchestration is built from three reusable primitives: `ctx.task`, `ctx.parallel`, `ctx.chain`.**  
  - `deep-research-codebase` uses all three: scout + history parallel, then chained history analysis, then partitioning, then two parallel specialist waves, then aggregation.
  - `goal` uses `ctx.task` for worker turns and `ctx.parallel` for multiple reviewers.
  - `ralph` uses `ctx.task` for planner/orchestrator/simplifier and `ctx.parallel` for reviewer fan-out.
  - `open-claude-design` uses `ctx.task` for sequential stages and `ctx.parallel` for onboarding/import/validation/critique loops.

- **Bounded loop + review-gate orchestration is repeated.**  
  `goal.ts` and `ralph.ts` both implement iterative work/review cycles with explicit stop conditions, reviewer JSON schemas, and “continue vs approve” logic.

- **Artifacts are first-class outputs, not just logs.**  
  Builtins write reports/specs/ledgers/review JSON to disk and surface paths in outputs:
  - `goal`: `ledger_path`, `review_report_path`
  - `ralph`: `plan_path`, `implementation_notes_path`, `review_report_path`
  - `open-claude-design`: `preview_path`, `spec_path`, `artifact_dir`
  - `deep-research-codebase`: `research_doc_path`, `manifest_path`, `artifact_dir`

- **Shared prompt fragments and reviewer contracts are reused.**  
  `packages/workflows/builtin/shared-prompts.ts` defines `WORKER_PREFLIGHT_CONTRACT`, and both `goal.ts` and `ralph.ts` import it.

- **TypeBox schema-driven inputs/outputs are standard.**  
  The builtins use `Type.String`, `Type.Number`, `Type.Optional`, unions, etc., and the generated `.d.ts` files in `packages/workflows/builtin/*.d.ts` mirror the runtime contract.

## 2. Variations / exceptions

- **`deep-research-codebase` is the most “pipeline-like” workflow.**  
  It has a scout → history locator → history analyzer → partition → two specialist waves → aggregation shape, and is explicitly described as re-implementing Atomic SDK topology.

- **`goal` is the most ledger/stateful workflow.**  
  It persists a structured JSON ledger (`goal-ledger.json`), tracks lifecycle events, blocker observations, decisions, and reviewer quorum.

- **`ralph` is the most RFC/spec-driven workflow.**  
  It writes a technical design doc/spec first, then orchestrates implementation and simplification around that artifact.

- **`open-claude-design` is the most UI/artifact-oriented workflow.**  
  It treats a real HTML file as the primary artifact, then iterates with browser-use/manual review and exports a final HTML spec.

- **`goal` and `ralph` both have structured review tools, but with different semantics.**  
  They define `reviewDecisionTool` JSON schemas and terminate via structured output, but `goal` uses three reviewers and quorum logic, while `ralph` focuses on plan/orchestrate/simplify/review loops.

## 3. Anti-patterns or risks

- **High coupling to TS/JS runtime behavior.**  
  Builtins assume local filesystem access, `node:*` modules, and direct TypeScript execution/loading; this is a major migration risk for Rust.

- **Dynamic prompt orchestration is embedded in code, not config.**  
  The workflows hardcode stage prompts, tool names, reviewer schemas, and artifact conventions directly in `.ts` files.

- **`ctx.parallel` fan-out can become prompt-heavy and expensive.**  
  `deep-research-codebase` and `goal` both fan out to many agents; this increases complexity if ported to Rust without preserving scheduling semantics.

- **Structured review depends on model JSON discipline.**  
  Both `goal` and `ralph` parse model-emitted JSON and fall back on synthetic error decisions when parsing fails.

- **Artifact naming conventions are part of the contract.**  
  The workflows assume stable paths like `research/...`, `goal-ledger.json`, `review-round-*.json`, `preview.html`, and `spec.html`; changing them would break downstream tooling/tests.

- **Workflow behavior is validated indirectly through integration tests and discovery tests.**  
  The repo’s confidence comes from runtime tests, not a separate spec layer, so migration needs careful parity testing.

## 4. Evidence index

- `packages/workflows/builtin/index.ts` — builtin manifest exports
- `packages/workflows/builtin/shared-prompts.ts` — shared preflight contract
- `packages/workflows/builtin/deep-research-codebase.ts` — scout/history/partition/specialist/aggregate orchestration
- `packages/workflows/builtin/goal.ts` — ledger + bounded review quorum workflow
- `packages/workflows/builtin/ralph.ts` — planner/orchestrator/simplifier/reviewer loop
- `packages/workflows/builtin/open-claude-design.ts` — HTML preview/refinement/export loop
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL and immutable builder semantics
- `packages/workflows/builtin/index.d.ts` — generated builtin output/input contracts
- `test/unit/discovery.test.ts` — discovery/registry expectations for bundled workflows
- `test/integration/workflow-package-typing.test.ts` — builtin typing and import parity