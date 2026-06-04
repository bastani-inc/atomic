## 1. Relevant external facts

- **Rust `include_str!` / `include_bytes!` embed files at compile time** and resolve paths relative to the source file. That means Rust can bundle static assets into the binary, but only as compile-time data, not as a mutable runtime directory.  
  Source: Rust std docs for [`include_str!`](https://doc.rust-lang.org/stable/std/macro.include_str.html) and [`include_bytes!`](https://doc.rust-lang.org/stable/std/macro.include_bytes.html).

- **Cargo `build.rs` is the standard hook for code generation / packaging steps before compilation.** Cargo docs explicitly recommend build scripts for generating Rust modules and handling non-Rust artifacts, with outputs typically written to `OUT_DIR`.  
  Source: Cargo Book, **Build Scripts** and **Build Script Examples**.

- **Cargo build scripts should generally not mutate files outside `OUT_DIR`.** That matters if you want a Rust migration to preserve the current repo’s “copy into dist / release bundle” workflow; the Rust-native equivalent is usually “generate assets in build output or embed them,” not editing source trees during build.  
  Source: Cargo Book, **Build Scripts** / examples.

## 2. Local implications

- This repo’s current packaging model is **not just “build TS → run binary”**. It has a **two-layer bundle contract**:
  1. `@bastani/atomic` is the publishable artifact.
  2. Companion workspace packages (`@bastani/workflows`, `subagents`, `mcp`, `web-access`, `intercom`) are copied into `dist/builtin/` and then discovered at runtime.

- The runtime discovery path is explicit in `getBuiltinPackagePaths()`:
  - source checkout: `packages/<builtin>`
  - npm/dist layout: `packages/coding-agent/dist/builtin/<package>`
  - Bun binary layout: `process executable dir -> builtin/<package>`

- `copy-runtime-dependencies.ts` shows the packaging also **copies dependency `node_modules` trees into the release bundle**. That means a Rust migration cannot assume “just compile the CLI”; it must also decide:
  - which dependencies get statically embedded,
  - which remain as external runtime files,
  - and how plugin/builtin discovery works without JS module resolution.

- The `copy-builtin-packages.ts` logic is especially migration-relevant:
  - it filters workspace package contents,
  - emits special workflow declaration files,
  - injects ambient type references,
  - and prunes raw `.ts` authoring files to avoid TypeScript resolution pitfalls.
  
  In Rust terms, that suggests the current design depends heavily on **TypeScript-specific packaging/type resolution behavior**. A Rust rewrite would likely replace that with either:
  - embedded compiled plugin metadata,
  - generated registries,
  - or a filesystem bundle of Rust-managed resources.

- `scripts/build-binaries.sh` shows the current release artifact is a **platform-specific binary plus a companion directory tree** (`builtin/`, `node_modules/`, docs, examples, wasm, assets).  
  So the Rust target should likely preserve a similar archive layout unless you intentionally redesign the runtime.

## 3. Version/API assumptions

- I assumed the relevant Rust baseline is **stable Cargo + std macros**, not nightly features.
- I assumed the current JS runtime contract must remain compatible with:
  - plugin/resource discovery,
  - bundled workflows,
  - and optional runtime assets like wasm and theme files.
- I did **not** assume any specific Rust framework/crate yet (e.g. `tauri`, `clap`, `include_dir`, `rust-embed`), because the repo’s current architecture suggests the packaging strategy should be chosen after deciding whether builtins stay file-backed or become embedded data.

## 4. Unverified or unnecessary research

- I did **not** verify whether the companion packages are all pure TS or contain native/runtime-only behavior beyond what the local files show.
- I did **not** research Rust crates for asset embedding (`include_dir`, `rust-embed`, etc.) because the key architectural question here is still **bundle shape**, not the exact embedding library.
- I did **not** inspect every CI/release workflow file; local scripts already show enough to conclude that the migration must replace both **builtin package copying** and **runtime dependency staging**.