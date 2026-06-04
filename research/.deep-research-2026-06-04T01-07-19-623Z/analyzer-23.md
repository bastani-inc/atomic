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