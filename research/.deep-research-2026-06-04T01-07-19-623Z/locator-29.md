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