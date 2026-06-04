## 1. Relevant external facts

- **`jiti` is a TS/ESM runtime loader for Node.js** and supports both async `import()`-style loading and sync `require()`-style loading; it also supports **custom resolve aliases** and a **`jiti/native`** path for transition to runtime-native loading. Source: *unjs/jiti README*.
- **`jiti/static` exists** and was added to make bundler/binary packaging easier by **statically importing** the transformer/runtime instead of lazy-loading via `createRequire(import.meta.url)`. Source: *unjs/jiti PR #430 / README export notes*.
- **`napi-rs` / Node-API add-ons** let Rust produce `.node` native modules for Node. That still means your host is Node/JS, not a pure Rust runtime. Source: *napi-rs README / docs*.
- **Wasmtime component model** is a serious Rust-native plugin path: plugins are **WebAssembly components**, host APIs are defined via **WIT**, and the host uses a **Linker** to instantiate components and provide imports. Source: *docs.rs `wasmtime::component`* and *Wasmtime “An Application with Plugins”*.
- **QuickJS-in-Rust crates** (`rquickjs`, `quickjs_runtime`) can embed JS in Rust, preserving JS plugin compatibility while moving the host to Rust. Source: *rquickjs docs* and *quickjs_runtime docs*.

## 2. Local implications

- Your repo currently depends on **dynamic TS/JS extension loading via `jiti`** in both:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
- That means a direct “rewrite to Rust” has **two separate migration axes**:
  1. **Host/runtime migration** (CLI, session, resource loading, extension lifecycle)
  2. **Plugin ABI migration** (how extensions are discovered, loaded, and registered)

Practical paths:

- **Keep JS plugins, move host to Rust**: embed QuickJS or use a Rust JS runtime. Lowest ecosystem breakage; preserves existing `.ts/.js` extension surface.
- **Move plugins to Rust native add-ons** (`napi-rs`): good for performance, but still Node-bound and not a full Rust host.
- **Move to Wasm components**: best long-term “Rust-first plugin ABI” if you want cross-language plugins and host/plugin isolation.
- **Go all-in on Rust plugins + manifest-based discovery**: simplest runtime model, but highest compatibility cost; you’d need to redesign the current `ExtensionAPI` / `ExtensionRuntime` contract.

For this repo specifically, the biggest compatibility risks are:
- discovery rules for `.ts/.js/index.*` and package manifests,
- runtime hooks (`registerTool`, commands, shortcuts, UI hooks),
- and hot reload / invalidation behavior.

## 3. Version/API assumptions

- Assumed **current `jiti` behavior** includes `createJiti`, custom aliases, and `jiti/static` as documented in upstream README/PR #430.
- Assumed **Node-API / napi-rs** remains the Rust-native-add-on path for Node plugins.
- Assumed **Wasmtime component model** is the relevant modern Rust plugin alternative, not legacy raw dynamic libraries.
- I did **not** verify exact versions used in your repo beyond the local artifact; this is architecture-level guidance.

## 4. Unverified or unnecessary research

- I did **not** verify a specific Rust migration plan for your codebase because no Rust host/plugin implementation exists yet in the local repo.
- I did **not** research every possible Rust plugin framework (e.g. raw `libloading`, custom FFI, IPC daemons) because the three options above cover the main viable migration shapes.
- If you want, next I can turn this into a **concrete migration roadmap** for this repo: `TS extensions -> Rust host with JS compat`, `TS extensions -> Wasm plugins`, or `TS host -> Rust-native extension ABI`.