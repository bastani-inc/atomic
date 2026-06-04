## 1. Relevant external facts

- **`jiti` can load TS/ESM/CJS at runtime** and supports options like `moduleCache` and `tryNative` (`jiti` README / npm docs).
- **`jiti/static` exists specifically for bundled runtimes** and is meant to ensure `babel.cjs` is statically included (jiti PR #430).
- **Bun resolves `.js` imports to `.ts` files** in TS-friendly mode, and can execute raw TypeScript directly (`Bun Module Resolution`, `Bun TypeScript` docs).
- **Bun supports `"bun"` export conditions** for shipping untranspiled TS directly in npm packages (`Bun Module Resolution` docs).

## 2. Local implications

- Your workflow system currently depends on **runtime TS loading**, not just TS types. In `packages/workflows/src/extension/workflow-module-loader.ts`, user workflows are discovered by evaluating authored files through `jiti`, with `virtualModules` to fake `@bastani/workflows` and builtins.
- A Rust rewrite **cannot preserve this behavior implicitly**; it must choose one of:
  1. keep a JS/TS loader bridge,
  2. switch user workflows to another authoring format, or
  3. embed a JS runtime / transpiler path.
- The current setup also relies on **fresh re-evaluation on reload** (`moduleCache: false`) while keeping SDK aliases in-memory. That means Rust needs a matching invalidation model if it wants `/workflow reload` parity.
- `defineWorkflow(...).compile()` produces a **branded runtime object** with a sentinel (`__piWorkflow`) and `WeakSet` brand checks. Rust must preserve the authoring contract if you want old workflow files to remain valid.
- The extension loader in `packages/coding-agent/src/core/extensions/loader.ts` shows the same pattern at a broader level: **dynamic extension discovery, virtual aliases, and TS/JS interop** are core platform behavior, not just workflow behavior.

## 3. Version/API assumptions

- Assumed `jiti` behavior is from current docs for the `createJiti` API and `jiti/static`.
- Assumed Bun module resolution behavior matches current Bun docs for TS/JS interop and `"bun"` exports.
- No Rust-side API baseline exists in this repo yet, so the migration target is still undefined.

## 4. Unverified or unnecessary research

- I did **not** verify a Rust crate/runtime strategy yet (for example, whether you’d use a JS engine, WASM, or a native parser/loader), because the repo currently has no Rust baseline.
- I also did not research whether the workflow DSL itself should change; locally, the bigger constraint is **runtime compatibility of authored workflows**, not the DSL syntax alone.