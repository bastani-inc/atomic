## Partition 23: Workflow authoring DSL, TypeBox schemas, and type inference migration

### Locator
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

### Pattern Finder
## 1. Established patterns

- **DSL is a chained, immutable builder.**  
  `defineWorkflow(name)` returns a new builder on every `.description()`, `.input()`, `.output()`, `.worktreeFromInputs()`, and `.run()` call; tests explicitly verify previous builders are unchanged.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `test/unit/define-workflow-extended.test.ts` (`"description does not mutate previous builder"`, `"input does not mutate previous builder"`, `"run does not mutate previous builder"`)

- **Type inference is driven by TypeBox schemas + conditional types.**  
  Input/output types are accumulated via `DeclaredEntry`, `AccumulateWorkflowOutput`, `Simplify`, and `NoExtraOutputs`, so `.run()` sees inferred `ctx.inputs` and compile-time output checks.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `packages/workflows/src/shared/authoring-contract.ts`

- **Runtime schema and type-level contract are intentionally split.**  
  - `authoring-contract.ts` holds the dependency-light shared contract.
  - `authoring.ts` is type-only public surface for standalone packages.
  - `define-workflow.ts` is the runtime builder implementation.
  This is a recurring “type-only facade over runtime implementation” pattern.  
  - `packages/workflows/src/shared/authoring-contract.ts`
  - `packages/workflows/src/authoring.ts`
  - `packages/workflows/src/sdk-surface.ts`

- **Workflow definitions are branded and sealed at compile time.**  
  `compile()` stamps a `WeakSet` brand and sets `__piWorkflow: true`; tests and loader code reject forged objects.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
  - `test/unit/discovery.test.ts` (`defineWorkflow(...).compile()` diagnostics)

- **Input/output metadata is derived from schemas, not duplicated.**  
  `schema-introspection.ts` converts TypeBox schemas into legacy descriptors (`type`, `required`, `default`, `choices`, `description`) for UI/validation.  
  - `packages/workflows/src/shared/schema-introspection.ts`

- **Defaults change “requiredness” semantics.**  
  A schema with `default` is still required at the type level but not required from the user in picker/validation terms. This is a stable repo convention.  
  - `packages/workflows/src/shared/schema-introspection.ts`
  - `test/unit/define-workflow.test.ts`

- **Compiled workflow definitions are frozen.**  
  `compile()` freezes the top-level definition and schema maps; tests assert immutability.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `test/unit/define-workflow.test.ts`
  - `test/unit/define-workflow-extended.test.ts`

## 2. Variations / exceptions

- **Optional vs defaulted inputs are treated differently.**  
  `Type.Optional(...)` becomes optional in the type, but `Type.Number({ default: 4 })` is type-required while runtime/UI treats it as user-optional.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `packages/workflows/src/shared/schema-introspection.ts`
  - `test/unit/define-workflow.test.ts`

- **Outputs allow stricter “serializable value” constraints.**  
  Output entries are intersected with `WorkflowSerializableValue`, making non-JSON-safe values a compile-time problem in the authoring surface.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `test/integration/workflow-package-typing.test.ts` (`nonSerializableOutputWorkflow`)

- **The authoring surface has a standalone typing package mode.**  
  `packages/workflows/src/authoring.ts` exports a type-only `Type` wrapper and workflow types so external packages can type-check without pulling in runtime dependencies.  
  - `packages/workflows/src/authoring.ts`
  - `test/integration/workflow-package-typing.test.ts`

- **`Type.Union` of string literals maps to select-like UI metadata.**  
  This is a special-case behavior, not a generic union treatment.  
  - `packages/workflows/src/shared/schema-introspection.ts`
  - `test/unit/define-workflow-extended.test.ts` (`"select schema accepted"`)

- **`Type.Unsafe` is used for SDK-bound/opaque option fields.**  
  In `workflow-schema.ts`, several session-option fields are intentionally untyped/opaque, so not all workflow-related schemas are strictly modeled.  
  - `packages/workflows/src/extension/workflow-schema.ts`

## 3. Anti-patterns or risks

- **The migration-critical logic is heavily TypeScript type-level machinery.**  
  The builder’s correctness depends on conditional types, intersections, `Static<>`, `TOptional`, and compile-time exclusions. A Rust port cannot preserve this 1:1 without a new typing strategy.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `packages/workflows/src/shared/authoring-contract.ts`

- **Behavior is encoded in both types and runtime heuristics.**  
  Example: requiredness depends on `IsOptional(schema)` plus `schema.default`, so a Rust rewrite must mirror both runtime schema inspection and compile-time inference rules.  
  - `packages/workflows/src/shared/schema-introspection.ts`

- **Branded definition identity is non-structural.**  
  Consumers must use `compile()`; hand-rolled `__piWorkflow` objects are rejected. That’s a compatibility boundary to preserve or redesign explicitly.  
  - `packages/workflows/src/workflows/define-workflow.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`

- **The workflow schema layer mixes precise DSL fields with opaque runtime passthroughs.**  
  `workflow-schema.ts` has a lot of `Type.Unsafe`/SDK-forwarded fields, which suggests the DSL is partly a thin adapter over runtime session options.  
  - `packages/workflows/src/extension/workflow-schema.ts`

- **The public typing API is intentionally decoupled from runtime loading.**  
  That’s good for TS ergonomics, but it means a Rust migration must decide whether to keep a type-only authoring surface, replace it, or move authoring to another format.  
  - `packages/workflows/src/authoring.ts`
  - `test/integration/workflow-package-typing.test.ts`

## 4. Evidence index

- `packages/workflows/src/workflows/define-workflow.ts`
  - immutable builder
  - `DeclaredEntry`, `AccumulateWorkflowOutput`, `NoExtraOutputs`
  - `compile()` branding/freezing
- `packages/workflows/src/shared/authoring-contract.ts`
  - shared workflow contracts
  - input/output typing rules
  - `WorkflowDefinition`, `WorkflowBuilder`, `CompletedWorkflowBuilder`
- `packages/workflows/src/shared/schema-introspection.ts`
  - TypeBox → legacy descriptor mapping
  - required/default/choices logic
- `packages/workflows/src/authoring.ts`
  - type-only standalone authoring surface
  - `Type` re-export facade
- `packages/workflows/src/extension/workflow-schema.ts`
  - workflow parameter schema
  - `Type.Unsafe` runtime-forwarded fields
- `packages/workflows/src/extension/workflow-module-loader.ts`
  - rejects non-compiled/forged workflow objects
- `test/unit/define-workflow.test.ts`
  - compile, freeze, required/default behavior
- `test/unit/define-workflow-extended.test.ts`
  - immutability, select union behavior, normalized names
- `test/integration/workflow-package-typing.test.ts`
  - standalone typing contract, optional/default/record/tuple inference, non-serializable output rejection

### Analyzer
## 1. Behavioral model

This partition is the **workflow authoring layer**.

- `defineWorkflow(name)` creates an **immutable builder** for a workflow definition.
- Authors chain:
  - `.description(...)`
  - `.input(key, TypeBoxSchema)`
  - `.output(key, TypeBoxSchema)`
  - `.worktreeFromInputs(...)`
  - `.run(fn)`
  - `.compile()`
- `.compile()` emits a frozen runtime `WorkflowDefinition` with:
  - `__piWorkflow: true`
  - `name` + `normalizedName`
  - `description`
  - `inputs` / optional `outputs`
  - optional `inputBindings`
  - executable `run`

The important data flow is:

**TypeBox schema → builder type inference → runtime schema map → schema introspection → UI/validation/dispatch**

So the DSL is doing two jobs at once:
1. **compile-time typing** via `Static<>` and conditional types
2. **runtime metadata** via schema objects consumed by legacy descriptor code

## 2. Key flows and invariants

### Builder/type inference
- Each `.input()` extends `TInputs` with a key mapped to `Static<S>`.
- Optional inputs stay optional in the type system.
- Defaulted inputs are **required at type level** but treated as **not-required in UI/validation**.
- `.output()` accumulates output shape and enforces serializable output values.
- `.run()` is the sealing step; `.compile()` is only available after `.run()`.

### Runtime invariants
- Workflow definitions are **frozen** before export.
- Input/output schema maps are also frozen shallowly.
- `name` must be a non-empty string.
- `compile()` throws if `.run()` was never called.
- Outputs are only included in the compiled definition if any were declared.
- `worktreeFromInputs()` stores a mapping used later by execution/runtime code.

### Schema bridging
- `schema-introspection.ts` converts TypeBox schemas into legacy field descriptors:
  - `schemaFieldKind`
  - `schemaDefault`
  - `schemaDescription`
  - `schemaChoices`
  - `schemaIsRequired`
  - `deriveInputField(s)`
- This is a key compatibility layer: Rust would need either the same schema metadata model or a replacement UI/validation contract.

### Coupling to other partitions
This DSL is tightly coupled to:
- workflow runtime/executor
- workflow discovery/loading
- UI forms / input picker
- compiled workflow registry
- background/foreground workflow execution
- built-in workflows authored with `ctx.task`, `ctx.chain`, `ctx.parallel`

## 3. Tests / validation

Current tests verify:
- valid workflow compiles
- undeclared outputs are rejected at type level
- missing `.run()` causes runtime failure
- empty workflow name is rejected
- compiled definition is frozen
- multiple inputs infer correct types
- `worktreeFromInputs()` persists bindings
- schema introspection correctly maps:
  - required vs defaulted
  - description
  - output field kind
  - frozen maps

Builtin workflow smoke tests also validate that real workflows rely on this DSL and on the schema adapter.

## 4. Risks, unknowns, and verification steps

### Biggest Rust-migration risk
This layer relies heavily on **TypeScript type inference**:
- `Static<>`
- conditional/mapped types
- output accumulation
- compile-time “no extra outputs” enforcement

Rust cannot replicate this natively in the same way. You’ll need one of:
1. a new Rust DSL with weaker type guarantees,
2. a codegen/IDL layer,
3. or keep TypeScript authoring and move only runtime/execution to Rust.

### Unknowns
- How much of workflow authoring must remain source-compatible?
- Will workflows still be authored in TS, or rewritten to Rust?
- Will TypeBox schemas remain as the canonical declaration format?

### Verify next
- Inspect downstream workflow executor / loader usage of `WorkflowDefinition`
- Identify every place that consumes `deriveInputField(s)` or schema metadata
- Decide whether Rust should preserve:
  - schema-driven UI/input picker behavior
  - workflow file loading (`jiti` today)
  - compile-time output contracts, or replace them with runtime checks

If you want, I can turn this into a **Rust migration impact matrix** for this partition: what must be reimplemented, what can be bridged, and what can be dropped.

### Online Researcher
## 1. Relevant external facts

- **TypeScript types are erased at runtime**. The TypeScript compiler removes interfaces/type aliases/assertions, so runtime code cannot “see” TS types. This is why your current workflow DSL needs **runtime schemas** (TypeBox) to validate inputs/outputs and drive UI metadata.
- **`@sinclair/typebox`** builds **JSON Schema objects** that also support **static TS inference** via `Static<typeof Schema>`. That duality is the core of your current authoring model: one object serves both runtime validation and compile-time typing.
- **`jiti`** is a **runtime TS/ESM loader**. In this repo it enables loading `.ts` workflow modules directly, which is a major compatibility seam if you move execution to Rust.
- Your repo’s workflows package currently depends on:
  - `typebox: ^1.1.24`
  - `jiti: ^2.7.0`
  - Bun `>=1.3.14`

## 2. Local implications

- The workflow DSL in `packages/workflows/src/workflows/define-workflow.ts` is **built around TS generics + TypeBox**. A Rust rewrite cannot preserve the same “inferred from TypeScript source” behavior unless you keep a TS layer or replace it with a different schema/IDL flow.
- The current builder’s type safety is mostly **author-time only**:
  - `.input(...)` / `.output(...)` accumulate generic types
  - `.run(...)` checks that returned keys match declared outputs
  - `.compile()` freezes a runtime definition
- If you migrate to Rust, the cleanest path is likely:
  1. **Keep TypeBox/TS at the authoring boundary** for workflow definitions, or
  2. **Replace the DSL with a Rust-native schema format** (e.g. JSON Schema/serde-based) and accept loss of TS inference, or
  3. **Use a compatibility layer** where Rust executes workflows but TS still authoring-compiles to an intermediate manifest.
- `jiti` means current workflow files are loaded dynamically as TS modules. A Rust runtime will need a replacement loader strategy (file-based manifest, WASM/plugin bridge, or embedded JS/TS runtime).
- The existing package exports are TS-first (`main: ./src/index.ts`, `types: ./src/authoring.ts`), so a Rust migration is not just implementation work; it changes the **public package contract**.

## 3. Version/API assumptions

- Assumed current package versions from `packages/workflows/package.json`:
  - `@sinclair/typebox` `^1.1.24`
  - `jiti` `^2.7.0`
- Assumed workflow authoring API shape from local docs/tests:
  - `defineWorkflow(name).input(...).output(...).run(...).compile()`
  - `Type.*` schemas are the canonical contract surface
- Assumed your target “Rust” means **replacing the workflow runtime/loader**, not just adding Rust alongside the existing TS authoring API.

## 4. Unverified or unnecessary research

- I did **not** verify any Rust-specific workflow framework or serialization choice, because the repo currently has **no Rust codebase** to map onto.
- I also did not research full downstream consumers yet (executor/TUI/discovery), which will matter if you want an end-to-end Rust replacement.
- If you want, the next useful step is to map this repo into one of three migration strategies:
  - **TS authoring + Rust execution**
  - **Rust-native workflow DSL**
  - **Hybrid manifest/IDL bridge**