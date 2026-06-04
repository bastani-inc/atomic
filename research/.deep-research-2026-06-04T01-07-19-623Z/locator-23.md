## 1. Must-read paths

- `packages/workflows/src/workflows/define-workflow.ts`  
  Core DSL builder (`defineWorkflow(...).input(...).output(...).run(...).compile()`) and the type-inference machinery you’d be replacing or reimplementing in Rust.

- `packages/workflows/src/shared/authoring-contract.ts`  
  Lowest-level authoring contract: workflow serializable values, `WorkflowInputValues` / `WorkflowOutputValues`, stage options, and the TypeBox-adjacent type surface.

- `packages/workflows/src/shared/types.ts`  
  Public workflow runtime types and the TypeBox re-export boundary; shows how the workflow package types are shaped for consumers.

- `packages/workflows/src/shared/schema-introspection.ts`  
  Bridge from TypeBox schemas to legacy “field descriptor” behavior (`schemaFieldKind`, `schemaIsRequired`, etc.). Important for migration because it shows how DSL schemas feed UI/validation.

- `packages/workflows/src/extension/workflow-module-loader.ts`  
  Dynamic workflow loading via `jiti`, plus the virtual `@bastani/workflows` module mapping. This is a major TS→Rust compatibility seam.

- `packages/workflows/src/workflows/registry.ts`  
  Runtime registry semantics for compiled workflows (`register`, `merge`, `get`, `names`, `all`).

- `packages/workflows/src/index.ts`  
  Public entrypoint surface; useful for understanding what the package exports to workflow authors.

- `packages/workflows/package.json`  
  Declares the package as raw TS, `main`/`exports`, and its dependency on `jiti` + `typebox`.

- `packages/workflows/README.md`  
  Canonical authoring docs for the DSL, TypeBox input/output contracts, `Static<>` inference, and runtime validation rules.

- `test/unit/define-workflow.test.ts`  
  High-signal tests for builder immutability, inferred types, frozen compiled definitions, and schema-derived metadata.

- `test/unit/builtin-workflows.test.ts`  
  Confirms how schemas are consumed by the rest of the workflow system and validates the TypeBox→descriptor adapter.

## 2. Supporting paths

- `packages/workflows/src/extension/discovery.ts`  
  Where workflow files are discovered and validated before registration.

- `packages/workflows/src/extension/config-loader.ts`  
  Likely relevant if Rust changes how workflow resources are loaded from config.

- `packages/workflows/src/extension/dispatcher.ts`  
  Connects the authored workflow definitions to actual execution.

- `packages/workflows/src/runs/foreground/executor.ts`  
  Foreground execution pipeline for compiled workflows.

- `packages/workflows/src/runs/background/runner.ts`  
  Background workflow execution behavior.

- `packages/workflows/src/shared/store.ts` and `packages/workflows/src/shared/persistence-*.ts`  
  On-disk workflow state and persistence contracts likely impacted by a runtime rewrite.

- `packages/workflows/src/tui/*`  
  Workflow UI layer; relevant if Rust is meant to replace the workflow runtime end-to-end.

- `packages/workflows/builtin/*`  
  Builtin workflow definitions; these are the best examples of real-world DSL usage.

- `test/integration/workflow-package-typing.test.ts`  
  Exercises package-level typing behavior around `defineWorkflow`, output contracts, and TypeBox inference.

- `test/unit/discovery.test.ts`  
  Validates module discovery and compiled workflow acceptance/rejection.

- `packages/workflows/CHANGELOG.md`  
  Shows the recent migration history: legacy descriptor schemas → TypeBox-native schemas and explicit outputs.

- `specs/2026-05-14-workflow-sdk-pi-subagents-api-parity.md`  
  Design rationale for using TypeBox-derived schemas and type exports.

## 3. Entry points / symbols

- `defineWorkflow(name)` in `packages/workflows/src/workflows/define-workflow.ts`
- `stampWorkflowDefinition(...)` / `isBrandedWorkflowDefinition(...)` in the same file
- `schemaFieldKind(...)`, `schemaIsRequired(...)`, `deriveInputField(...)` in `packages/workflows/src/shared/schema-introspection.ts`
- `createRegistry(...)` in `packages/workflows/src/workflows/registry.ts`
- `loadWorkflowModule(...)`, `collectWorkflowModuleCandidates(...)`, `validateWorkflowDefinitionShape(...)` in `packages/workflows/src/extension/workflow-module-loader.ts`
- `WorkflowParametersSchema` in `packages/workflows/src/extension/workflow-schema.ts`
- `WorkflowBuilder` / `CompletedWorkflowBuilder` in `define-workflow.ts`
- `WorkflowDefinition`, `WorkflowInputSchemaMap`, `WorkflowOutputSchemaMap` in `packages/workflows/src/shared/types.ts`

## 4. Gaps or uncertainty

- There is **no Rust codebase yet** here (no `Cargo.toml`, no `*.rs`), so there’s no existing Rust architecture to map onto.
- I could verify the DSL/type-inference boundary, but **not** a Rust target design—so the migration strategy (native Rust DSL vs. compatibility layer vs. embedded JS) is still undefined in-repo.
- The exact runtime consumers of these workflow types are spread across executor/TUI/extension code; I verified the authoring surface, but not every downstream call site.
- Some design/spec docs may be historical or partially stale relative to the current tree, so treat them as guidance, not source of truth.