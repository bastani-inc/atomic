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