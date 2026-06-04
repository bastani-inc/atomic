## Partition 29: Builtin workflows and reusable orchestration semantics

### Locator
## 1. Must-read paths

- `packages/workflows/builtin/`
  - Why: this is the actual built-in workflow catalog; best source for reusable orchestration semantics.
- `packages/workflows/builtin/deep-research-codebase.ts`
  - Why: likely the closest match to “orchestration as a reusable pattern” and a strong migration reference for workflow structure.
- `packages/workflows/builtin/goal.ts`
  - Why: usually the simplest canonical workflow; good for understanding core step semantics.
- `packages/workflows/builtin/ralph.ts`
  - Why: another bundled workflow with likely custom sequencing/retry/interaction logic.
- `packages/workflows/builtin/open-claude-design.ts`
  - Why: useful for understanding higher-level multi-stage orchestration and agent handoff patterns.
- `packages/workflows/src/workflows/define-workflow.ts`
  - Why: defines the workflow DSL; this is the core abstraction Rust would need to preserve or replace.
- `packages/workflows/src/runs/`
  - Why: runtime execution semantics for workflows (foreground/background, cancellation, resume, state).
- `packages/workflows/src/runs/foreground/`
  - Why: synchronous execution path; important for step ordering and control flow.
- `packages/workflows/src/runs/background/`
  - Why: persistence/resume semantics; important if Rust needs durable orchestration.
- `packages/workflows/src/extension/workflow-module-loader.ts`
  - Why: dynamic loading of workflow modules; major compatibility boundary for a Rust migration.
- `packages/workflows/src/shared/`
  - Why: shared workflow primitives and types that encode reusable orchestration concepts.

## 2. Supporting paths

- `packages/workflows/package.json`
  - Why: shows package shape, entrypoints, and how workflows are bundled into Atomic.
- `packages/workflows/src/index.ts`
  - Why: package export surface; helps identify what is considered public/stable.
- `packages/workflows/src/shared/types.ts`
  - Why: workflow-related type contracts.
- `packages/workflows/src/workflows/`
  - Why: all DSL/authorship helpers; useful to map reusable workflow semantics.
- `packages/workflows/src/runs/shared/`
  - Why: cross-mode execution helpers, likely includes state, validation, and orchestration utilities.
- `packages/workflows/src/tui/`
  - Why: workflow visualization/control surface; relevant if Rust needs parity with interactive workflow UX.
- `packages/workflows/src/intercom/`
  - Why: cross-session orchestration hooks.
- `packages/workflows/docs/` if present
  - Why: may contain workflow-specific authoring notes or invariants.
- `docs/ci.md`
  - Why: explains how builtin packages are bundled; relevant to how workflows are shipped today.
- `packages/coding-agent/src/core/extensions/types.ts`
  - Why: workflow integration often depends on extension ABI.
- `packages/coding-agent/src/core/resource-loader.ts`
  - Why: discovery/bundling may affect workflow availability.

## 3. Entry points / symbols

- `defineWorkflow(...)` in `packages/workflows/src/workflows/define-workflow.ts`
- Builtin workflow modules:
  - `deep-research-codebase`
  - `goal`
  - `ralph`
  - `open-claude-design`
- Workflow module loader:
  - `loadWorkflowModule(...)` / loader utilities in `packages/workflows/src/extension/workflow-module-loader.ts`
- Runtime entry surfaces:
  - foreground runner under `packages/workflows/src/runs/foreground/*`
  - background runner under `packages/workflows/src/runs/background/*`
- Shared orchestration primitives:
  - state/store/persistence helpers under `packages/workflows/src/shared/*`
- TUI orchestration UI:
  - components under `packages/workflows/src/tui/*`

## 4. Gaps or uncertainty

- I could verify the workflow package exists, but I haven’t yet confirmed the exact file list inside `packages/workflows/builtin/` from the tree here.
- The scout confirms the loader and runtime areas are relevant, but the precise reusable semantics encoded by each builtin workflow still need file-by-file inspection.
- I can’t yet say which builtin workflows are purely examples vs. intended as migration-critical reference implementations.
- The most migration-sensitive question remains whether workflow semantics are intended to stay TS-native or be re-expressed as a Rust DSL/runtime.

### Pattern Finder
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

### Analyzer
# 1. Behavioral model

This partition is the repo’s **workflow orchestration layer**: reusable, declarative workflows built with `defineWorkflow(...).input(...).run(...).compile()` and executed as multi-step task graphs.

Core semantics from `define-workflow.ts`:
- Builder is **immutable/chained**; every call returns a new builder.
- `compile()` freezes the definition and brands it as a workflow.
- `worktreeFromInputs(...)` lets a workflow bind git worktree settings from inputs.
- Input/output schemas use TypeBox and are part of the runtime contract.

The built-in workflows show three recurring orchestration patterns:

- **`deep-research-codebase`**: scout → history lookup → partitioning → parallel specialist waves → synthesis/manifest/report.
- **`goal`**: bounded worker turns → parallel reviewer quorum → deterministic reducer → final status/ledger.
- **`ralph`**: plan → orchestrate → simplify → parallel review loop → PR handoff.
- **`open-claude-design`**: onboarding/import → generate preview → user feedback loop → critique/audit → forced fix → export/handoff.

# 2. Key flows and invariants

## Deep research
- Computes a partition cap from repo size, then fans out work by partition.
- Writes per-run artifacts under `research/.deep-research-<runId>/`.
- Uses `ctx.parallel()` for specialist waves and `ctx.chain()` for dependent synthesis steps.
- Invariant: partitions are normalized and capped; if parsing fails, it falls back to `["core codebase architecture"]`.
- Invariant: final report is written to a public research doc path plus a hidden manifest/artifact tree.

## Goal
- Creates a persistent goal ledger and treats it as authoritative state.
- Each turn:
  1. worker produces a receipt,
  2. three reviewers run in parallel,
  3. structured JSON verdicts are parsed,
  4. reducer decides `complete | blocked | needs_human | active`.
- Invariant: reviewer quorum is required; worker “ready for review” is never enough by itself.
- Error handling is explicit: reviewer failure or invalid JSON becomes a non-approval path, not a silent success.

## Ralph
- Bounded iterative loop with planner/orchestrator/simplifier/review split.
- Supports git worktree integration through `worktreeFromInputs`.
- Has PR-prep behavior at the end, so orchestration is coupled to git/gh state.
- Invariant: review loop gates handoff; approval depends on structured reviewer outputs.

## Open Claude Design
- Generates a real HTML preview on disk, then iterates with user feedback and formal critique/audit.
- Uses browser-use opportunistically, but degrades to manual file paths if unavailable.
- Invariant: preview is the artifact; later steps must rewrite it in place, not patch it partially.
- Export step requires embedding/linking the approved preview into a rich HTML spec.

# 3. Tests / validation

From the evidence here, validation is mostly **workflow-level and contract-level**, not low-level unit coverage:
- `define-workflow.ts` encodes compile-time/runtime invariants via builder typing and freezing.
- Builtins hard-code output schemas and structured-output contracts, so malformed model output is treated as failure.
- Workflows validate by:
  - parsing structured JSON,
  - checking approval predicates,
  - persisting artifacts/ledgers,
  - using parallel reviewer consensus.

What remains unknown:
- Exact test files for these workflows weren’t inspected here.
- It’s unclear whether CI exercises all builtin workflows end-to-end or only some subset.

# 4. Risks, unknowns, and verification steps

## Migration risks for Rust
- **This layer is the hardest TS→Rust boundary** because the semantics are not just “business logic”; they include:
  - dynamic task composition,
  - TypeBox-driven schema contracts,
  - file-based artifact conventions,
  - parallelism and reducer behavior,
  - git worktree and PR handoff integration,
  - browser-use/manual fallback behavior.
- A Rust rewrite must decide whether to:
  1. reimplement these workflows natively,
  2. keep workflow authoring in TS and call into Rust,
  3. define a new DSL/runtime with compatibility shims.

## Unknowns
- The exact public workflow API surface beyond `defineWorkflow` and the builtins wasn’t fully traced.
- The depth of dependency on `ctx.task / ctx.parallel / ctx.chain` implementation details is still not fully known.
- Which parts are meant as reusable patterns vs. product-specific examples is partly inferred from comments.

## Verify next
1. Inspect `packages/workflows/src/runs/*` to confirm execution semantics.
2. Inspect `packages/workflows/src/shared/types.ts` for the full orchestration ABI.
3. Inspect tests for:
   - reducer correctness,
   - review quorum behavior,
   - artifact persistence,
   - worktree binding,
   - browser fallback handling.
4. For Rust migration, decide whether workflows remain authorable in TS or become a Rust-native DSL first.

### Online Researcher
## 1. Relevant external facts

- `@bastani/workflows` is currently **raw TypeScript** and loaded directly (`package.json` points `main`/`exports` at `./src/*.ts` and `./builtin/*.ts`).
- Workflow discovery uses **`jiti/static`** with `tryNative: false` and `virtualModules` for `@bastani/workflows` / `@bastani/workflows/builtin`.
- Workflow definitions are authored through **`defineWorkflow(...).description().input().output().run().compile()`** and branded with a private sentinel (`__piWorkflow`) plus a `WeakSet` brand check.
- Inputs/outputs are modeled with **TypeBox** schemas, and runtime validation/type inference depend on that schema shape.
- Builtin workflows (`goal`, `ralph`, `deep-research-codebase`, `open-claude-design`) are not just examples; they encode reusable orchestration patterns using `ctx.task()`, `ctx.parallel()`, `ctx.chain()`, stage prompts, and structured outputs.
- Execution semantics are split across **foreground** and **background** runners, with supporting pieces for cancellation, status, concurrency limiting, and worktree setup.

## 2. Local implications

- A Rust migration cannot just translate the builtin workflow files; it must replace the **workflow authoring/runtime contract** exposed by `defineWorkflow`, `WorkflowRunContext`, and the task primitives.
- The biggest compatibility boundary is **dynamic workflow loading**:
  - today: JS/TS modules loaded through `jiti`
  - in Rust: you’ll need a new discovery/registration mechanism or a JS compatibility layer.
- If you want to keep existing workflow files usable, Rust would need to preserve:
  - module shape (`default` export + named exports),
  - the `__piWorkflow`/brand validation concept,
  - schema-driven inputs/outputs,
  - task composition semantics (`task`, `parallel`, `chain`),
  - background resume/cancellation behavior.
- The builtin workflows show the repo’s “orchestration semantics” are not a thin wrapper; they are a **mini DSL + runtime**. So migration is likely a **runtime rewrite**, not a file-by-file port.
- Since `@bastani/workflows` is bundled into Atomic and consumed via extension loading, Rust migration also has to address the **extension ABI** in the host package.

## 3. Version/API assumptions

- Assumed current package: `@bastani/workflows@0.8.24-alpha.3`.
- Assumed runtime target: **Bun >= 1.3.14** today; Rust replacement would need to decide whether Bun remains as a host for JS glue or is removed entirely.
- Assumed key APIs that matter for parity:
  - `defineWorkflow()`
  - `ctx.task()`
  - `ctx.parallel()`
  - `ctx.chain()`
  - workflow module loader / discovery
  - foreground/background runner APIs
  - TypeBox schema validation

## 4. Unverified or unnecessary research

- I did **not** need external web research to reach the main conclusion; the local code already shows the migration surface.
- I did **not** verify any Rust ecosystem library choices yet (e.g. workflow engines, serde schema tooling, plugin loading). That would be the next step if you want an implementation plan.
- I also haven’t confirmed whether you want:
  - a full Rust rewrite,
  - a Rust core with JS compatibility shims,
  - or just the builtin workflows moved first.