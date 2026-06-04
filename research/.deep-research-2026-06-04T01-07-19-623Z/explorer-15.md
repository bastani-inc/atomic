## Partition 15: Dynamic TypeScript/JavaScript extension loading via `jiti` and Rust plugin alternatives

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/core/extensions/loader.ts` — the main TS/JS extension loader; uses `jiti/static`, `virtualModules`, `alias`, and discovery/loading logic.
- `packages/coding-agent/src/core/extensions/types.ts` — the extension ABI (`ExtensionAPI`, `ExtensionRuntime`, tools, commands, UI hooks). This is the contract a Rust plugin system would have to preserve or replace.
- `packages/coding-agent/docs/extensions.md` — user-facing extension model, auto-discovery rules, hot reload, and supported imports.
- `packages/coding-agent/test/extensions-discovery.test.ts` — verifies discovery behavior for `.ts`, `.js`, `index.ts/js`, and `package.json` manifests.
- `packages/coding-agent/test/extensions-runner.test.ts` — verifies runtime behavior after load: conflicts, shortcuts, event handling, tool wrapping.
- `packages/coding-agent/test/extensions-input-event.test.ts` — verifies extension event semantics during input processing.
- `packages/workflows/src/extension/workflow-module-loader.ts` — second `jiti`-based loader, but for workflows; useful because it shows the same dynamic-module pattern in another subsystem.
- `packages/workflows/src/extension/index.ts` — workflow extension entrypoint; shows how extension APIs are consumed beyond core CLI.
- `packages/coding-agent/package.json` — declares `jiti`, extension-related runtime deps, and the shipped CLI/package surface.
- `packages/workflows/package.json` — raw TypeScript package with `jiti` dependency and `pi.extensions` manifest wiring.

## 2. Supporting paths

- `packages/coding-agent/docs/sdk.md` — `createAgentSession()` and `DefaultResourceLoader` notes; shows how extensions are loaded into sessions.
- `packages/coding-agent/docs/rpc.md` — extension commands/UI protocol in RPC mode; relevant if Rust needs a plugin protocol.
- `packages/coding-agent/src/core/resource-loader.ts` — where extension discovery is plugged into broader resource loading.
- `packages/coding-agent/src/core/package-manager.ts` — package manifest discovery; relevant because extensions can be shipped as packages.
- `packages/coding-agent/src/core/extensions/runner.ts` — post-load runtime wiring and event dispatch.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — contains jiti boundary comments and reload behavior.
- `packages/workflows/src/extension/discovery.ts` — workflow discovery rules around `.ts/.js/.mjs/.cjs`.
- `packages/workflows/src/extension/config-loader.ts` — workflow extension config resolution paths.
- `docs/ci.md` — packaging/bundling expectations that currently assume TS extensions are included in the build.
- `scripts/build-binaries.sh` / `packages/coding-agent/package.json#build:binary` — binary build path that bundles runtime + TS extension ecosystem.

## 3. Entry points / symbols

- `createJiti(...)` in:
  - `packages/coding-agent/src/core/extensions/loader.ts`
  - `packages/workflows/src/extension/workflow-module-loader.ts`
- `VIRTUAL_MODULES` in `packages/coding-agent/src/core/extensions/loader.ts` — bundled module map for binary mode.
- `getAliases()` in `packages/coding-agent/src/core/extensions/loader.ts` — dev-mode module resolution shim.
- `loadExtensionModule()` / `loadExtension()` / `loadExtensions()` / `discoverAndLoadExtensions()` in `packages/coding-agent/src/core/extensions/loader.ts`.
- `createExtensionRuntime()` in `packages/coding-agent/src/core/extensions/loader.ts` — runtime stubs and lifecycle invalidation.
- `ExtensionAPI.registerTool()` / `registerCommand()` / `registerShortcut()` / `registerFlag()` in `packages/coding-agent/src/core/extensions/types.ts`.
- `ExtensionUIContext.custom()` / `setWidget()` / `setFooter()` / `setEditorComponent()` in `packages/coding-agent/src/core/extensions/types.ts` — large part of the plugin surface.
- `validateWorkflowDefinitionShape()` / `loadWorkflowModule()` / `collectWorkflowModuleCandidates()` in `packages/workflows/src/extension/workflow-module-loader.ts`.
- `discoverExtensionsInDir()` / `resolveExtensionEntries()` in `packages/coding-agent/src/core/extensions/loader.ts` — exact discovery semantics.

## 4. Gaps or uncertainty

- No Rust crate/workspace is present here; I could not verify any existing Rust plugin ABI or host integration.
- No Rust-equivalent plugin loader is implemented yet, so “Rust alternatives” are still a design decision, not a codepath.
- The true replacement boundary is unclear: preserve JS plugins via an embedded JS engine, spawn plugin subprocesses, or redesign the extension API.
- I could not verify whether `packages/coding-agent/test/*` is fully covered by CI beyond the root test flow.
- `jiti` is also used in workflows, so replacing only core extensions would still leave another dynamic-loader dependency.

### Pattern Finder
## 1. Established patterns

- **`jiti` is the standard dynamic loader for authored TS/JS.**
  - `packages/coding-agent/src/core/extensions/loader.ts` uses `createJiti(...)`.
  - `packages/workflows/src/extension/workflow-module-loader.ts` uses the same pattern for workflow files.
  - Docs explicitly say extensions/workflows “load via jiti, so TypeScript works without compilation.”

- **Loader semantics are intentionally “runtime-native,” not build-time transpiled.**
  - Both loaders set `moduleCache: false` so edits stay observable.
  - `workflow-module-loader.ts` sets `tryNative: false` so `jiti` owns `.ts/.js/.mjs/.cjs` resolution.
  - This means plugin authors can ship raw TypeScript.

- **Virtual modules are a core compatibility layer.**
  - `extensions/loader.ts` defines `VIRTUAL_MODULES` for:
    - `@bastani/atomic`
    - `@earendil-works/pi-*`
    - `@sinclair/typebox`
  - `workflow-module-loader.ts` exposes `@bastani/workflows` and builtin workflow modules in-memory.
  - Pattern: preserve author-facing import specifiers even when the runtime isn’t a normal `node_modules` tree.

- **There are two loader modes: dev alias resolution vs bundled-binary virtual modules.**
  - `extensions/loader.ts` has `getAliases()` for Node/dev, and `virtualModules` for Bun binary mode.
  - This split is a recurring portability convention.

- **Modules are normalized before discovery/validation.**
  - `workflow-module-loader.ts` materializes export descriptors and normalizes CJS/default interop.
  - It then validates branded workflow shape (`__piWorkflow`, `name`, `run`, etc.).
  - That shows the repo treats plugin loading as “discover then validate,” not “trust and execute blindly.”

- **Some non-TS plugin-ish paths already fall back to subprocess execution.**
  - `packages/subagents/src/runs/background/async-execution.ts` locates `jiti` and spawns `node process.execPath` + `jiti-cli`.
  - So even today, some “dynamic execution” is already an external process boundary.

## 2. Variations / exceptions

- **Extensions are broader than workflows.**
  - Extension loader bridges to agent core, TUI, AI, and TypeBox packages.
  - Workflow loader is narrower and focuses on `@bastani/workflows` SDK + builtin workflows.

- **Bundled binary vs source-tree behavior differs.**
  - In dev, loaders rely on filesystem/package resolution.
  - In compiled Bun binary mode, they rely on explicit virtual modules to keep imports working.

- **Subagents use `jiti` as a runtime toolchain dependency, not just a loader.**
  - `async-execution.ts` resolves the `jiti` CLI and spawns it for detached async runs.
  - That’s a separate dependency surface from extension/workflow loading.

- **The repo already preserves compatibility with upstream/legacy package names.**
  - `extensions/loader.ts` aliases both `@bastani/*` and `@mariozechner/*`.
  - That suggests migration must keep specifier compatibility, not just code behavior.

## 3. Anti-patterns or risks

- **Rust can’t directly replace this without a new plugin strategy.**
  - The current model depends on executing authored TS/JS at runtime.
  - A pure Rust binary would break that unless you:
    1. embed a JS runtime,
    2. keep a JS sidecar process,
    3. or define a new Rust-native plugin ABI.

- **`jiti` is doing more than “loading files.”**
  - It handles TS syntax, ESM/CJS interop, local imports, and in-memory SDK aliases.
  - A Rust port needs equivalent resolution semantics, not just file reading.

- **Virtual module behavior is part of the public contract.**
  - User workflows/extensions import `@bastani/atomic`, `@bastani/workflows`, and builtin subpaths.
  - Breaking these specifiers would be a migration-level breaking change.

- **There’s a cache/editability tension.**
  - `moduleCache: false` makes edits visible but can make discovery slower.
  - The code comments note real performance costs when aliasing to on-disk SDK graphs.

- **Cross-boundary runtime compatibility is already fragile.**
  - Comments mention jiti module cache boundaries, duck-typing, and stale contexts.
  - Rust migration would likely magnify these boundary issues if it adds FFI or subprocess layers.

## 4. Evidence index

- `packages/coding-agent/src/core/extensions/loader.ts`
  - `createJiti(...)`
  - `VIRTUAL_MODULES`
  - `getAliases()`
  - dev/binary split

- `packages/workflows/src/extension/workflow-module-loader.ts`
  - `createJiti(...)`
  - `moduleCache: false`
  - `tryNative: false`
  - `WORKFLOWS_VIRTUAL_MODULES`
  - `loadWorkflowModule()`, `collectWorkflowModuleCandidates()`

- `packages/coding-agent/docs/extensions.md`
  - “Extensions are loaded via jiti, so TypeScript works without compilation.”

- `packages/coding-agent/docs/workflows.md`
  - “Workflow files are loaded via jiti…”

- `packages/subagents/src/runs/background/async-execution.ts`
  - `resolveJitiCliPath()`
  - `spawn(process.execPath, [jitiCliPath, runner, cfgPath], ...)`

- `packages/coding-agent/docs/changelog.mdx`
  - packaged workflow discovery resolves through `jiti`

- `packages/coding-agent/CHANGELOG.md`
  - prior fixes around `jiti` aliasing, virtual modules, and extension loading in compiled binary

If you want, I can turn this into a **Rust migration decision matrix** next: “keep JS plugins,” “embed JS runtime,” or “replace with Rust-native plugins.”

### Analyzer
## 1. Behavioral model

This partition is the **dynamic plugin boundary** for the repo.

- `packages/coding-agent/src/core/extensions/loader.ts` loads extension entrypoints with **`jiti`**, not native import.
- It supports two runtime modes:
  - **Bun binary**: uses in-memory `virtualModules` so bundled deps resolve without filesystem packages.
  - **Dev/Node-like mode**: uses `alias` mappings to point extension imports at local workspace/package paths.
- Extension modules are expected to export a **factory function**; non-function exports are rejected.
- The factory receives an `ExtensionAPI` that lets it register:
  - tools, commands, shortcuts, flags
  - event handlers
  - message renderers and UI behaviors
  - provider registrations
- The runtime object starts with **throwing stubs** for action methods, then gets bound later by the runner; some registrations are allowed during load, but stateful actions are intentionally blocked until initialization completes.

The workflow subsystem uses the same pattern:

- `packages/workflows/src/extension/workflow-module-loader.ts` loads workflow files via `jiti`.
- It disables native import fallback and uses in-memory virtual modules for the `@bastani/workflows` SDK and builtins.
- It normalizes module shapes carefully because `jiti` can return proxy-like namespace objects.
- Workflow exports must pass a branded sentinel check (`__piWorkflow === true`) and structural validation.

## 2. Key flows and invariants

### Extension loading flow
1. Resolve candidate path relative to CWD.
2. `createJiti(...)` with mode-specific resolution strategy.
3. `jiti.import(..., { default: true })`
4. Verify default export is a function.
5. Create extension record and API.
6. Execute factory.
7. Return loaded extension or an error string.

### Discovery flow
`discoverAndLoadExtensions(...)` collects paths from:
1. local `.atomic/extensions`
2. global `~/.atomic/extensions`
3. explicit configured paths

Discovery rules:
- direct `*.ts` / `*.js` files are loadable
- directories can expose `index.ts` / `index.js`
- directories with `package.json` may declare `atomic.extensions` or legacy `pi.extensions`
- no recursion beyond one level unless declared in manifest

### Invariants
- **Factory must be callable**; plain objects are rejected.
- **Discovery is deterministic** and de-duplicates by resolved path.
- **Loaded extension state is isolated per extension record**, but runtime actions share one runtime object.
- **Load-time side effects are expected**; this is trusted code execution, not sandboxing.
- **Workflow exports are stricter than extension exports** because they must be branded, not hand-rolled.

### Coupling to migration
This is the main place where TS-to-Rust migration becomes a product decision:
- keep JS/TS plugin support via embedded JS engine or loader bridge
- replace with a new Rust plugin ABI
- or move plugins to subprocess/message-based plugins

A pure Rust rewrite breaks the current assumption that user-authored `.ts/.js` files are directly executable.

## 3. Tests / validation

Good coverage exists for extension behavior:

- `packages/coding-agent/test/extensions-discovery.test.ts`
  - `.ts` and `.js` discovery
  - `index.ts` / `index.js`
  - `package.json` manifest discovery
  - legacy `pi` manifest compatibility
  - precedence rules
  - no recursion beyond one level
  - explicit path loading vs discovery
- `packages/coding-agent/test/extensions-runner.test.ts`
  - shortcut conflict resolution
  - built-in shortcut reservation behavior
  - duplicate shortcut handling
  - runtime/tool wrapping behavior
  - event/input semantics indirectly through runner behavior
- `packages/coding-agent/test/extensions-input-event.test.ts`
  - input event propagation semantics

Workflow loader validation is present in code, but I did not verify a dedicated test file for `workflow-module-loader.ts` in the provided evidence.

## 4. Risks, unknowns, and verification steps

### Risks
- **Highest risk:** preserving the extension/workflow author experience after Rust migration.
- `jiti` is used in **two subsystems**, so replacing only core extensions still leaves another dynamic loader.
- Current extension API surface is broad and UI-heavy; a Rust plugin API would need equivalents for:
  - tool registration
  - commands/shortcuts
  - interactive UI widgets/overlays
  - provider hooks
  - event bus integration
- Binary mode depends on `virtualModules`; Rust will need an alternative dependency packaging story.

### Unknowns
- Whether you want:
  1. Rust core with embedded JS plugin support
  2. Rust core with subprocess plugins
  3. full Rust-native plugin rewrite
- Whether workflow files and extensions must remain authorable in TS/JS.
- Whether compatibility with legacy `pi` manifests must be preserved.

### Verify next
- Audit all consumers of `ExtensionAPI` and `ExtensionRuntime`.
- Trace workflow loading consumers alongside extension loading.
- Decide the plugin boundary before rewriting core runtime.
- Confirm which parts must remain user-scripted vs compiled-native.

### Online Researcher
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