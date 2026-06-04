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